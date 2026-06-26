const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/manifest.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "meu_token_verificacao";
// Token de acesso para proteger rotas administrativas (/painel, /crm, etc).
// IMPORTANTE: defina PAINEL_TOKEN no Render com um valor forte e secreto.
const PAINEL_TOKEN = process.env.PAINEL_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const INSTAGRAM_ACCOUNT_ID = "17841407009898490";
const NUMERO_AUGUSTO = process.env.NUMERO_AUGUSTO || "5551993716729";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ─────────────────────────────────────────────
// AUTENTICAÇÃO DAS ROTAS ADMINISTRATIVAS
// ─────────────────────────────────────────────
// Sem isso, qualquer pessoa na internet que descobrisse a URL do painel
// conseguia ver CPF, nome, telefone e conversas de todos os clientes, ou
// mandar mensagens fingindo ser a Sarah. O token precisa ser passado uma
// vez via query string (?token=...) — depois disso, fica salvo num cookie
// por 30 dias, então não precisa repetir o token em cada clique.
const COOKIE_NOME_TOKEN = "sarah_painel_auth";

function exigirToken(req, res, next) {
  if (!PAINEL_TOKEN) {
    // Se o consultor ainda não configurou a variável de ambiente, bloqueia
    // por segurança em vez de deixar a rota aberta sem querer.
    return res.status(503).send("Acesso bloqueado: configure a variável de ambiente PAINEL_TOKEN no Render para habilitar o painel.");
  }
  const tokenQuery = req.query.token;
  const tokenCookie = (req.headers.cookie || "").split(";").map(c => c.trim()).find(c => c.startsWith(COOKIE_NOME_TOKEN + "="))?.split("=")[1];
  if (tokenQuery === PAINEL_TOKEN || tokenCookie === PAINEL_TOKEN) {
    if (tokenQuery === PAINEL_TOKEN) {
      res.setHeader("Set-Cookie", `${COOKIE_NOME_TOKEN}=${PAINEL_TOKEN}; Max-Age=${30 * 24 * 60 * 60}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return next();
  }
  return res.status(401).send("Acesso negado. Use o link com ?token=SEU_TOKEN para entrar.");
}

// Protege todas as rotas administrativas. O /webhook fica de fora
// (precisa ser público para a Meta poder chamá-lo) e a raiz "/" também
// (usada só como health-check simples, sem dados sensíveis).
app.use("/painel", exigirToken);
app.use("/crm", exigirToken);
app.use("/followups", exigirToken);
app.use("/estoque", exigirToken);
app.use("/sincronizar", exigirToken);
app.use("/testar-supabase", exigirToken);
app.use("/diagnostico", exigirToken);
app.use("/testar-notificacao", exigirToken);
app.use("/testar-alerta-api", exigirToken);
app.use("/testar-retry", exigirToken);
app.use("/registrar", exigirToken);

console.log("SUPABASE_URL:", SUPABASE_URL ? "OK" : "VAZIA");
console.log("SUPABASE_KEY:", SUPABASE_KEY ? "OK" : "VAZIA");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testarSupabase() {
  try {
    const { error } = await supabase.from("mensagens").select("count").limit(1);
    if (error) console.error("[Supabase] ❌ Erro:", error.message);
    else console.log("[Supabase] ✅ Conexão OK!");
  } catch (e) { console.error("[Supabase] ❌ Exceção:", e.message); }
}
testarSupabase();

let estoqueAtual = [];
let ultimaAtualizacao = null;
const conversas = {};
const mensagensProcessadas = new Set();
const fipeCache = {};
let cacheMarcasFipe = null;
const filaFotos = {};
const ultimaNotificacao = {};
const conversasVisualizadas = {};
const ultimaMensagemCliente = {};

// Estado de coleta de dados para simulação de crédito
// ATENÇÃO — risco conhecido: como visitasAgendadas, este objeto também só
// existe em memória RAM. Se o servidor reiniciar no meio de uma coleta de
// dados (nome → CPF → nascimento → entrada), o cliente fica com a coleta
// "presa" sem conseguir prosseguir, silenciosamente. O impacto é menor
// porque a janela é de minutos (não horas), mas é um ponto de melhoria
// futura: persistir o progresso da coleta no Supabase para sobreviver a
// reinícios, igual já foi feito para o desconto pendente.
const coletaCredito = {};

// Visitas agendadas aguardando confirmação: { telefone: timestamp_agendamento }
// REMOVIDO: "visitasAgendadas" era um objeto só em memória (não persistido
// no Supabase) que duplicava o controle de follow-up de "visita não
// confirmada" — esse controle já existe de forma resiliente na tabela
// "followups" via agendarFollowUpHoras() + processarFollowUpsPendentes().
// Como vivia só em RAM, todo reinício do servidor apagava esse controle
// silenciosamente, fazendo o follow-up de 2h nunca disparar para visitas
// agendadas antes do reinício mais recente.

// Desconto pendente: { telefone, info, timestamp }
// Guarda apenas UM por vez (o mais recente)
let descontoPendente = null;

// Fila de processamento por telefone — evita race condition quando
// o cliente manda 2+ mensagens em sequência rápida
const filaProcessamento = {};

async function processarMensagemNaFila(from, text, tentativasAnteriores = 0) {
  // Se já existe processamento em andamento para esse número, encadeia
  const anterior = filaProcessamento[from] || Promise.resolve();
  const atual = anterior
    .catch(() => {}) // não deixa erro anterior travar a fila
    .then(() => processarMensagem(from, text, tentativasAnteriores));
  filaProcessamento[from] = atual;
  return atual;
}

// ─────────────────────────────────────────────
// ALERTA DE FALHA DA API DA ANTHROPIC
// ─────────────────────────────────────────────
// Quando a chamada à API do Claude falha (ex: crédito esgotado, erro de
// autenticação, rate limit), o cliente fica sem resposta e isso só era
// percebido quando alguém notava a conversa parada. Esta função avisa
// o consultor no WhatsApp pessoal assim que isso acontecer, com um
// cooldown para não inundar de mensagens repetidas no mesmo problema.

let ultimoAlertaApiFalha = 0;
const COOLDOWN_ALERTA_API = 15 * 60 * 1000; // 15 minutos entre alertas repetidos

async function notificarFalhaApiClaude(erro, contexto = "") {
  const agora = Date.now();
  if (agora - ultimoAlertaApiFalha < COOLDOWN_ALERTA_API) return;
  ultimoAlertaApiFalha = agora;

  const status = erro.response?.status;
  const mensagemErro = erro.response?.data?.error?.message || erro.message;
  const tipoErro = erro.response?.data?.error?.type || "desconhecido";

  let motivoAmigavel = "Erro desconhecido na API da Anthropic.";
  if (mensagemErro?.toLowerCase().includes("credit balance is too low")) {
    motivoAmigavel = "🚨 *SEM CRÉDITO NA API DA ANTHROPIC!*\nA Sarah PAROU de responder aos clientes. Adicione fundos em console.anthropic.com > Billing.";
  } else if (status === 401) {
    motivoAmigavel = "🚨 *Chave de API inválida/expirada!*\nA Sarah parou de funcionar. Verifique a CLAUDE_API_KEY no Render.";
  } else if (status === 429) {
    motivoAmigavel = "⚠️ *Limite de requisições (rate limit) atingido.*\nAlgumas respostas podem estar atrasando.";
  } else if (status >= 500) {
    motivoAmigavel = "⚠️ *Instabilidade na API da Anthropic* (erro do lado deles). Deve se normalizar sozinho.";
  }

  const msg = `${motivoAmigavel}\n\n${contexto ? `Contexto: ${contexto}\n` : ""}Status: ${status || "N/A"} | Tipo: ${tipoErro}\nDetalhe: ${String(mensagemErro).substring(0, 200)}`;

  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: msg } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("[Alerta API] ✅ Consultor notificado sobre falha da API");
  } catch (e) {
    console.error("[Alerta API] Erro ao notificar (e a API principal já está fora!):", e.message);
  }
}

// ─────────────────────────────────────────────
// RETRY AUTOMÁTICO DE MENSAGENS QUE FALHARAM
// ─────────────────────────────────────────────
// Quando a resposta principal (Sonnet) falha por erro de API (ex: crédito
// esgotado), a mensagem do cliente fica sem resposta e antes ninguém
// reprocessava automaticamente depois que o problema fosse resolvido.
// Esta fila salva a mensagem como pendente e um job periódico tenta de
// novo, sem precisar que o cliente escreva outra vez.

const MAX_TENTATIVAS_PENDENTE = 6; // depois disso, desiste e só fica registrado

async function salvarMensagemPendente(telefone, texto) {
  try {
    await supabase.from("mensagens_pendentes").insert({ telefone, texto, tentativas: 0 });
    console.log(`[Retry] Mensagem de ${telefone} salva como pendente para reprocessar depois`);
  } catch (e) {
    console.error("[Retry] Erro ao salvar mensagem pendente (tabela pode não existir):", e.message);
  }
}

async function processarMensagensPendentes() {
  try {
    const { data: pendentes } = await supabase.from("mensagens_pendentes").select("*").order("criado_em", { ascending: true }).limit(20);
    if (!pendentes?.length) return;
    console.log(`[Retry] ${pendentes.length} mensagem(ns) pendente(s) para reprocessar`);
    for (const p of pendentes) {
      try {
        // Remove da fila ANTES de tentar — se processarMensagem funcionar,
        // ótimo; se falhar de novo, ela mesma vai re-salvar como pendente
        // (com tentativas incrementadas) dentro do catch da resposta principal.
        await supabase.from("mensagens_pendentes").delete().eq("id", p.id);
        await processarMensagemNaFila(p.telefone, p.texto, p.tentativas || 0);
      } catch (e) {
        console.error(`[Retry] Erro ao reprocessar pendente de ${p.telefone}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[Retry] Erro ao buscar pendentes:", e.message);
  }
}

setInterval(processarMensagensPendentes, 5 * 60 * 1000); // tenta a cada 5 minutos

// ─────────────────────────────────────────────
// CACHE DE APRENDIZADOS
// ─────────────────────────────────────────────
let cacheAprendizados = "";
let ultimoCarregamentoAprendizados = 0;

async function obterAprendizados() {
  const agora = Date.now();
  if (agora - ultimoCarregamentoAprendizados < 30 * 60 * 1000) return cacheAprendizados;
  try {
    const { data } = await supabase.from("aprendizados").select("*").order("criado_em", { ascending: false }).limit(10);
    if (data && data.length > 0) {
      cacheAprendizados = "\n\nEXEMPLOS DE COMO RESPONDER:\n" +
        data.map(a => `Situação: ${a.situacao}\nResposta correta: ${a.correcao}`).join("\n---\n");
    } else {
      cacheAprendizados = "";
    }
    ultimoCarregamentoAprendizados = agora;
  } catch (e) { console.error("[Cache] Erro:", e.message); }
  return cacheAprendizados;
}

// ─────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────

function limparTexto(str) {
  if (!str) return "";
  return String(str)
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{FE00}-\u{FEFF}]/gu, "")
    .trim();
}

function clienteEstaEmFluxoTroca(historicoConversa) {
  const historico = (historicoConversa || []).slice(-10).map(m => m.content || "").join(" ").toLowerCase();
  return historico.includes("tenho um") || historico.includes("meu carro") ||
    historico.includes("na troca") || historico.includes("pra troca") ||
    historico.includes("dar na troca") || historico.includes("mandar umas fotos") ||
    historico.includes("manda umas fotos");
}

function ehMensagemSimples(texto) {
  const t = texto.toLowerCase().trim();
  const simples = ["sim", "não", "nao", "ok", "obrigado", "obrigada", "valeu", "certo",
    "tá", "ta", "tá bom", "ta bom", "pode ser", "claro", "perfeito", "ótimo", "otimo",
    "entendi", "entendido", "combinado", "até", "ate", "tchau", "abraço", "abs"];
  return simples.includes(t) || t.length < 8;
}

// ─────────────────────────────────────────────
// SIMULAÇÃO DE CRÉDITO — COLETA DE DADOS
// ─────────────────────────────────────────────

function detectarInteresseFinanciamento(texto, historicoConversa) {
  const t = texto.toLowerCase();
  // Não dispara se já está no meio de uma coleta
  const frases = [
    "preciso financiar", "quero financiar", "consigo financiar",
    "tenho crédito", "tenho credito", "será que consigo crédito",
    "será que consigo credito", "consigo parcelar", "vai dar pra financiar",
    "tem como financiar", "tem credito", "tem crédito",
    "fazer financiamento", "simular financiamento", "simular crédito",
    "simular credito", "ver se aprova", "ver se passa", "análise de crédito",
    "analise de credito", "consultar meu nome", "consultar meu cpf",
    // Variações mais naturais de pergunta sobre parcela/financiamento —
    // adicionadas porque a Sarah estava calculando e informando valor de
    // parcela sem coletar CPF quando o cliente perguntava de forma livre,
    // em vez de usar uma das frases fixas acima.
    "quanto fica a parcela", "quanto fica parcelado", "quanto ficaria a parcela",
    "qual valor da parcela", "qual o valor da parcela", "valor da parcela",
    "quanto seria por mês", "quanto seria por mes", "quanto fica por mês",
    "quanto fica por mes", "em quantas vezes", "quantas parcelas",
    "dá pra parcelar", "da pra parcelar", "dá pra financiar", "da pra financiar",
    "como funciona o financiamento", "quero saber sobre financiamento",
    "informações sobre financiamento", "informacoes sobre financiamento",
    "quero parcelar", "pode parcelar", "financia", "financiamento"
  ];
  return frases.some(f => t.includes(f));
}

function validarCPF(cpfTexto) {
  const cpf = String(cpfTexto).replace(/\D/g, "");
  if (cpf.length !== 11) return null;
  if (/^(\d)\1{10}$/.test(cpf)) return null; // todos dígitos iguais
  // Validação dos dígitos verificadores
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(cpf[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[9])) return null;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(cpf[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[10])) return null;
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

function extrairDataNascimento(texto) {
  const t = texto.trim();

  // Formato com separador: 01/01/1990, 01-01-1990, 01 01 1990
  const matchSeparado = t.match(/(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{2,4})/);
  if (matchSeparado) {
    let [, dia, mes, ano] = matchSeparado;
    if (ano.length === 2) ano = (parseInt(ano) > 30 ? "19" : "20") + ano;
    dia = dia.padStart(2, "0");
    mes = mes.padStart(2, "0");
    const diaN = parseInt(dia), mesN = parseInt(mes), anoN = parseInt(ano);
    if (diaN >= 1 && diaN <= 31 && mesN >= 1 && mesN <= 12 && anoN >= 1900 && anoN <= new Date().getFullYear()) {
      return `${dia}/${mes}/${ano}`;
    }
  }

  // Formato colado sem separador: DDMMYYYY (8 dígitos) ou DDMMAA (6 dígitos)
  const apenasDigitos = t.replace(/\D/g, "");
  if (apenasDigitos.length === 8) {
    const dia = apenasDigitos.slice(0, 2);
    const mes = apenasDigitos.slice(2, 4);
    const ano = apenasDigitos.slice(4, 8);
    const diaN = parseInt(dia), mesN = parseInt(mes), anoN = parseInt(ano);
    if (diaN >= 1 && diaN <= 31 && mesN >= 1 && mesN <= 12 && anoN >= 1900 && anoN <= new Date().getFullYear()) {
      return `${dia}/${mes}/${ano}`;
    }
  }
  if (apenasDigitos.length === 6) {
    const dia = apenasDigitos.slice(0, 2);
    const mes = apenasDigitos.slice(2, 4);
    let ano = apenasDigitos.slice(4, 6);
    ano = (parseInt(ano) > 30 ? "19" : "20") + ano;
    const diaN = parseInt(dia), mesN = parseInt(mes), anoN = parseInt(ano);
    if (diaN >= 1 && diaN <= 31 && mesN >= 1 && mesN <= 12) {
      return `${dia}/${mes}/${ano}`;
    }
  }

  return null;
}

// Mascara o CPF para exibição, mantendo só os 3 primeiros e 2 últimos
// dígitos visíveis (ex: 123.***.***-00). O CPF completo continua
// disponível no Supabase para quando for de fato necessário confirmar
// a identidade do cliente nas financeiras, mas não fica exposto em
// mensagens de WhatsApp que podem ser vistas por terceiros (ex: se o
// celular for compartilhado ou perdido).
function mascararCPF(cpfFormatado) {
  if (!cpfFormatado) return cpfFormatado;
  const digitos = cpfFormatado.replace(/\D/g, "");
  if (digitos.length !== 11) return cpfFormatado;
  return `${digitos.slice(0, 3)}.***.***-${digitos.slice(9)}`;
}

async function notificarDadosCredito(telefone, dados) {
  const numero = telefone.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : telefone;
  const linkSeguro = PAINEL_TOKEN
    ? `https://agente-mensagens1.onrender.com/painel/simulacoes?token=${PAINEL_TOKEN}`
    : null;
  const msg = `📋 *Simulação de crédito solicitada*
Cliente: ${formatado}
Nome: *${dados.nome}*
CPF: *${dados.cpf}*
Nascimento: *${dados.nascimento}*
${dados.veiculo ? `Veículo de interesse: *${dados.veiculo}*` : "Veículo de interesse: não identificado"}
${dados.entrada ? `Valor de entrada: *${dados.entrada}*` : "Entrada: à combinar"}
${linkSeguro ? `\nVer todas as simulações: ${linkSeguro}` : ""}

Faça a simulação nas financeiras e responda:
✅ *SIMULACAO ${telefone} [resultado]* — ex: SIMULACAO ${telefone} Aprovado BV, parcela R$ 1.250 em 48x`;
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: msg } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Crédito] ✅ Consultor notificado sobre dados de ${telefone}`);
  } catch (e) { console.error("[Crédito] Erro notificação:", e.message); }
}

async function salvarSimulacaoCredito(telefone, dados) {
  try {
    await supabase.from("simulacoes_credito").insert({
      telefone, nome: dados.nome, cpf: dados.cpf, nascimento: dados.nascimento,
      veiculo: dados.veiculo || null, entrada: dados.entrada || null, status: "pendente"
    });
    console.log(`[Crédito] ✅ Salvo no Supabase: ${telefone}`);
  } catch (e) {
    console.error("[Crédito] Erro ao salvar (tabela pode não existir ainda):", e.message);
  }
}

async function atualizarStatusSimulacao(telefone, resultado) {
  try {
    await supabase.from("simulacoes_credito")
      .update({ status: "respondido", resultado })
      .eq("telefone", telefone)
      .eq("status", "pendente");
  } catch (e) {
    console.error("[Crédito] Erro ao atualizar status:", e.message);
  }
}

// ─────────────────────────────────────────────
// DETECÇÃO DE PEDIDO DE DESCONTO
// ─────────────────────────────────────────────

function detectarPedidoDesconto(texto) {
  const t = texto.toLowerCase().trim();
  const frases = [
    "consegue baixar", "pode baixar", "tem desconto", "da desconto",
    "aceita menos", "fecha por menos", "consegue por", "fecha por",
    "sai por", "toparia",
    "pago a vista", "pago em dinheiro", "pago no pix",
    "chegar em", "consegue em", "fecha em", "vai em", "sai em",
    "por menos", "aceita por", "topas por", "consegue chegar",
    "chega em", "voce consegue", "vc consegue",
    "tem como chegar", "tem como baixar", "consegue fazer",
    "daria pra fazer", "daria pra baixar", "da pra fazer", "da pra baixar",
    "ofereci", "ofereço", "minha proposta", "proponho",
    "topam", "topas", "topa", "bora fechar", "fecho por"
  ];
  const temValor = /r\$\s*[\d.,]+|[\d.,]+\s*mil|\d{4,}/.test(t);
  const temFrase = frases.some(f => t.includes(f));
  // Detecta proposta direta: "69 a vista", "70 mil à vista", "ofereci 69"
  const temPropostaDireta = /\d{2,}\s*(mil|k)?\s*(a|à)\s*vista/i.test(t);
  const temOferta = /ofereci\s+\d|ofereço\s+\d|proponho\s+\d/.test(t);
  return (temFrase && temValor) || temPropostaDireta || temOferta || /em [5-9]\d/.test(t);
}

// ─────────────────────────────────────────────
// PERSISTÊNCIA DO DESCONTO PENDENTE (sobrevive a reinícios)
// ─────────────────────────────────────────────

async function salvarDescontoPendente(telefone, info) {
  descontoPendente = { telefone, info, timestamp: Date.now() };
  try {
    await supabase.from("descontos_pendentes").delete().neq("telefone", "");
    await supabase.from("descontos_pendentes").insert({ telefone, info: JSON.stringify(info) });
  } catch (e) {
    console.error("[Desconto] Erro ao persistir (tabela pode não existir ainda):", e.message);
  }
}

async function limparDescontoPendente() {
  descontoPendente = null;
  try {
    await supabase.from("descontos_pendentes").delete().neq("telefone", "");
  } catch (e) {
    console.error("[Desconto] Erro ao limpar persistência:", e.message);
  }
}

async function carregarDescontoPendente() {
  if (descontoPendente) return descontoPendente;
  try {
    const { data } = await supabase.from("descontos_pendentes").select("*").limit(1);
    if (data && data.length > 0) {
      descontoPendente = {
        telefone: data[0].telefone,
        info: typeof data[0].info === "string" ? JSON.parse(data[0].info) : data[0].info,
        timestamp: new Date(data[0].criado_em || Date.now()).getTime()
      };
      console.log(`[Desconto] Recuperado da persistência: ${descontoPendente.telefone}`);
    }
  } catch (e) {
    // Tabela pode não existir ainda — não é crítico
  }
  return descontoPendente;
}

async function processarDesconto(from, texto, historicoConversa) {
  await carregarDescontoPendente();
  // Se já tem desconto pendente para ESTE cliente, não dispara novamente
  if (descontoPendente && descontoPendente.telefone === from) return false;
  if (!detectarPedidoDesconto(texto)) return false;

  console.log(`[Desconto] Detectado pedido de ${from}: "${texto}"`);

  try {
    const historico = (historicoConversa || []).slice(-10).map(m => m.content || "").join(" | ");
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Extraia do texto: veículo, preço original, preço solicitado e forma de pagamento.
Responda APENAS JSON: {"veiculo": "...", "preco_original": "...", "preco_solicitado": "...", "pagamento": "..."}
Use null para campos não encontrados.
Contexto: ${historico}
Texto atual: "${texto}"`
        }]
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const jsonMatch = res.data.content[0].text.trim().match(/\{[\s\S]+\}/);
    const info = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    // Guarda o desconto pendente — agora persistido no Supabase também
    await salvarDescontoPendente(from, info);

    // Notifica consultor
    const numero = from.replace(/\D/g, "");
    const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
    const msgConsultor = `💰 *Pedido de desconto*
Cliente: ${formatado}
${info.veiculo ? `Veículo: *${info.veiculo}*` : ""}
${info.preco_original ? `Preço original: ${info.preco_original}` : ""}
${info.preco_solicitado ? `Cliente pede: *${info.preco_solicitado}*` : ""}
${info.pagamento ? `Pagamento: ${info.pagamento}` : ""}

Responda:
✅ *AUTORIZO* — para autorizar
❌ *NEGO* — para negar`;

    const respostaMeta = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: msgConsultor } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Desconto] ✅ Consultor notificado. Resposta Meta:`, JSON.stringify(respostaMeta.data));
    return true;
  } catch (e) {
    console.error("[Desconto] Erro:", e.message);
    if (e.response) await notificarFalhaApiClaude(e, `Extração de pedido de desconto (${from})`);
    return false;
  }
}

// ─────────────────────────────────────────────
// EXTRAÇÃO UNIFICADA — 1 chamada Haiku
// ─────────────────────────────────────────────

async function extrairContextoConversa(textos, ehSimples = false) {
  if (ehSimples) return { marcaTroca: null, modeloTroca: null, anoTroca: null, modeloBuscado: null, anoBuscado: null };
  try {
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Analise essa conversa e extraia DUAS informações em JSON:
1. Veículo que cliente quer VENDER/TROCAR
2. Veículo que cliente quer COMPRAR/PROCURAR

Responda APENAS JSON:
{"troca": {"marca": null, "modelo": null, "ano": null}, "busca": {"modelo": null, "ano": null}}

Texto: "${textos.slice(-5).join(" | ")}"`
        }]
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const jsonMatch = res.data.content[0].text.trim().match(/\{[\s\S]+\}/);
    if (!jsonMatch) return { marcaTroca: null, modeloTroca: null, anoTroca: null, modeloBuscado: null, anoBuscado: null };
    const json = JSON.parse(jsonMatch[0]);
    return {
      marcaTroca: json.troca?.marca || null,
      modeloTroca: json.troca?.modelo || null,
      anoTroca: json.troca?.ano || null,
      modeloBuscado: json.busca?.modelo || null,
      anoBuscado: json.busca?.ano || null
    };
  } catch (e) {
    if (e.response) await notificarFalhaApiClaude(e, "Extração de contexto da conversa");
    return { marcaTroca: null, modeloTroca: null, anoTroca: null, modeloBuscado: null, anoBuscado: null };
  }
}

// ─────────────────────────────────────────────
// SUPABASE — MENSAGENS
// ─────────────────────────────────────────────

async function salvarMensagem(telefone, tipo, texto, wamid = null) {
  try {
    console.log(`[Supabase] Salvando: ${telefone} | ${tipo}`);
    const { data, error } = await supabase.from("mensagens").insert({
      telefone, tipo, texto: String(texto).substring(0, 500), wamid, status_entrega: wamid ? "enviado" : null
    }).select("id").single();
    if (error) console.error("[Supabase] ❌ Erro insert:", error.message);
    else console.log(`[Supabase] ✅ Salvo: ${telefone} | ${tipo}`);
    const { error: e2 } = await supabase.from("clientes").upsert({
      telefone, ultima_interacao: new Date().toISOString()
    }, { onConflict: "telefone" });
    if (e2) console.error("[Supabase] ❌ Erro upsert:", e2.message);
    return data?.id || null;
  } catch (e) { console.error("[Supabase] ❌ Exceção:", e.message); return null; }
}

// Atualiza o status de entrega de uma mensagem já salva, a partir do
// wamid recebido nos eventos de status que a Meta envia ao webhook
// (sent, delivered, read, failed).
async function atualizarStatusEntrega(wamid, novoStatus, motivoErro = null) {
  try {
    const update = { status_entrega: novoStatus };
    if (motivoErro) update.motivo_erro = motivoErro;
    const { error } = await supabase.from("mensagens").update(update).eq("wamid", wamid);
    if (error) console.error("[StatusEntrega] Erro ao atualizar:", error.message);
    else console.log(`[StatusEntrega] ✅ ${wamid} → ${novoStatus}`);
  } catch (e) { console.error("[StatusEntrega] Exceção:", e.message); }
}

async function buscarMensagens(telefone) {
  try {
    // Busca os 100 mais RECENTES (ordem decrescente + limit), depois
    // reordena cronologicamente para exibição. Antes, o limit(100) vinha
    // junto com ordem crescente, o que pegava sempre as 100 mensagens MAIS
    // ANTIGAS de cada cliente — em conversas longas (100+ mensagens no
    // total), as mensagens recentes nunca apareciam no painel, mesmo
    // estando salvas corretamente no banco.
    const { data } = await supabase.from("mensagens").select("*").eq("telefone", telefone).order("criado_em", { ascending: false }).limit(100);
    return (data || []).reverse();
  } catch (e) { return []; }
}

async function listarConversas() {
  try {
    const { data } = await supabase.from("mensagens").select("telefone, texto, tipo, criado_em").order("criado_em", { ascending: false });
    if (!data) return [];
    const mapa = {};
    data.forEach(m => {
      if (!mapa[m.telefone]) {
        mapa[m.telefone] = { from: m.telefone, ultimaMensagem: m.texto?.substring(0, 50) || "", ultimaAtividade: m.criado_em, naoLida: 0 };
      }
      if (m.tipo === "client") {
        const visualizadoEm = conversasVisualizadas[m.telefone] || 0;
        if (new Date(m.criado_em).getTime() > visualizadoEm) mapa[m.telefone].naoLida++;
      }
    });
    return Object.values(mapa).sort((a, b) => new Date(b.ultimaAtividade) - new Date(a.ultimaAtividade));
  } catch (e) { return []; }
}

// ─────────────────────────────────────────────
// CRM — ESTÁGIOS
// ─────────────────────────────────────────────

async function atualizarEstagio(telefone, estagio, veiculo = null) {
  try {
    const update = { telefone, estagio, ultima_interacao: new Date().toISOString() };
    if (veiculo) update.veiculo_interesse = veiculo;
    const { error } = await supabase.from("clientes").upsert(update, { onConflict: "telefone" });
    if (!error) console.log(`[CRM] ${telefone} → ${estagio}`);
  } catch (e) { console.error("[CRM] Erro:", e.message); }
}

async function detectarEstagio(from, text, historico) {
  const t = text.toLowerCase();
  const hist = (historico || []).map(m => m.content || "").join(" ").toLowerCase();
  if (t.includes("fechei") || t.includes("comprei") || t.includes("vou comprar")) { await atualizarEstagio(from, "fechado"); return; }
  if (t.includes("vou aí") || t.includes("vou até") || t.includes("passo aí") || t.includes("apareço") || t.includes("vou na loja") || t.includes("vou ir") || t.includes("vou visitar") || t.includes("amanhã às") || t.includes("amanha as") || t.includes("pode ser às") || t.includes("pode ser as")) {
    const { data: clienteAtual } = await supabase.from("clientes").select("estagio").eq("telefone", from).limit(1);
    const jaEraVisita = clienteAtual?.[0]?.estagio === "visita_agendada";
    await atualizarEstagio(from, "visita_agendada");
    // Notifica consultor apenas na primeira vez que agenda visita
    if (!jaEraVisita) {
      const numero = from.replace(/\D/g, "");
      const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
      const veiculo = hist.match(/asx|corolla|compass|tracker|renegade|hilux|jetta|civic|hb20|polo|onix|creta|tucson|evoque|ranger|s10|pajero|outlander|cobalt|voyage/i)?.[0] || "veículo";
      const msg = `📅 *Visita agendada!*\nCliente: ${formatado}\nVeículo de interesse: *${veiculo.toUpperCase()}*\n\nO cliente confirmou que vai vir à loja. Fique de olho! 😊`;
      try {
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log(`[Visita] ✅ Notificado sobre visita de ${from}`);
      } catch(e) { console.error("[Visita] Erro notificação:", e.message); }
      // Agenda follow-up automático em 2h — só dispara se ninguém mudar o estágio antes
      await agendarFollowUpHoras(from, "visita_nao_confirmada", veiculo, 2);
    }
    return;
  }
  if (hist.includes("parcela") || hist.includes("simulação") || hist.includes("financiar") || hist.includes("na troca") || hist.includes("fotos")) { await atualizarEstagio(from, "negociacao"); return; }
  if (t.includes("não tenho interesse") || t.includes("desisti") || t.includes("esquece")) { await atualizarEstagio(from, "frio"); return; }
  if (t.includes("vou pensar") || t.includes("vou falar") || t.includes("vou consultar") || t.includes("retorno")) { await atualizarEstagio(from, "aguardando"); return; }
  const { data } = await supabase.from("clientes").select("estagio").eq("telefone", from).limit(1);
  if (!data?.[0]?.estagio) await atualizarEstagio(from, "quente");
}

async function buscarLeadsCRM() {
  try {
    const { data: clientes } = await supabase.from("clientes").select("*").order("ultima_interacao", { ascending: false });
    const { data: mensagens } = await supabase.from("mensagens").select("telefone, texto, tipo, criado_em").order("criado_em", { ascending: false });
    if (!clientes) return {};
    const ultimaMsg = {};
    if (mensagens) mensagens.forEach(m => { if (!ultimaMsg[m.telefone]) ultimaMsg[m.telefone] = m; });
    const kanban = { quente: [], negociacao: [], aguardando: [], visita_agendada: [], frio: [], fechado: [] };
    clientes.forEach(c => {
      const estagio = c.estagio || "quente";
      const agora = Date.now();
      const ultimaAtividade = c.ultima_interacao ? new Date(c.ultima_interacao).getTime() : agora;
      const minutosAtras = Math.floor((agora - ultimaAtividade) / 60000);
      const horasAtras = Math.floor(minutosAtras / 60);
      const diasAtras = Math.floor(horasAtras / 24);
      const tempoLabel = diasAtras > 0 ? `${diasAtras}d atrás` : horasAtras > 0 ? `${horasAtras}h atrás` : `${minutosAtras}min atrás`;
      const numero = c.telefone.replace(/\D/g, "");
      const formatado = numero.length >= 12 ? `(${numero.slice(2, 4)}) ${numero.slice(4, 9)}-${numero.slice(9)}` : c.telefone;
      const card = { telefone: c.telefone, formatado, estagio, veiculo: c.veiculo_interesse || "", ultimaMensagem: ultimaMsg[c.telefone]?.texto?.substring(0, 60) || "", tempoLabel, ultimaAtividade: c.ultima_interacao };
      if (kanban[estagio]) kanban[estagio].push(card);
      else kanban.quente.push(card);
    });
    return kanban;
  } catch (e) { console.error("[CRM] Erro:", e.message); return {}; }
}

// ─────────────────────────────────────────────
// SUPABASE — APRENDIZADOS
// ─────────────────────────────────────────────

async function salvarAprendizado(situacao, correcao) {
  try {
    await supabase.from("aprendizados").insert({ situacao, correcao });
    ultimoCarregamentoAprendizados = 0;
  } catch (e) { console.error("[Supabase] Erro aprendizado:", e.message); }
}

async function buscarAprendizados() {
  try {
    const { data } = await supabase.from("aprendizados").select("*").order("criado_em", { ascending: false }).limit(20);
    return data || [];
  } catch (e) { return []; }
}

// ─────────────────────────────────────────────
// FOLLOW-UPS
// ─────────────────────────────────────────────

async function agendarFollowUp(telefone, motivo, veiculoInteresse, diasAguardar) {
  try {
    const agendadoPara = new Date();
    agendadoPara.setDate(agendadoPara.getDate() + diasAguardar);
    await supabase.from("followups").update({ enviado: true }).eq("telefone", telefone).eq("enviado", false);
    const { error } = await supabase.from("followups").insert({
      telefone, motivo, veiculo_interesse: veiculoInteresse,
      agendado_para: agendadoPara.toISOString(), enviado: false
    });
    if (!error) console.log(`[FollowUp] Agendado: ${telefone} em ${diasAguardar}d — ${motivo}`);
  } catch (e) { console.error("[FollowUp] Erro:", e.message); }
}

async function agendarFollowUpHoras(telefone, motivo, veiculoInteresse, horasAguardar) {
  try {
    const agendadoPara = new Date();
    agendadoPara.setHours(agendadoPara.getHours() + horasAguardar);
    await supabase.from("followups").update({ enviado: true }).eq("telefone", telefone).eq("enviado", false).eq("motivo", motivo);
    const { error } = await supabase.from("followups").insert({
      telefone, motivo, veiculo_interesse: veiculoInteresse,
      agendado_para: agendadoPara.toISOString(), enviado: false
    });
    if (!error) console.log(`[FollowUp] Agendado: ${telefone} em ${horasAguardar}h — ${motivo}`);
  } catch (e) { console.error("[FollowUp] Erro:", e.message); }
}

async function detectarLeadFrio(from, text, historicoConversa) {
  try {
    const t = text.toLowerCase();
    const historico = (historicoConversa || []).slice(-10).map(m => m.content || "").join(" ").toLowerCase();
    let motivo = null, dias = 1;
    const frasesPensar = ["vou pensar", "preciso pensar", "deixa eu pensar", "vou ver", "vou decidir", "vou falar com minha esposa", "vou falar com meu marido", "vou consultar", "vou falar com a família", "retorno em breve", "depois te aviso", "vou dar um retorno", "vou retornar", "depois eu volto", "vou conversar com"];
    if (frasesPensar.some(f => t.includes(f))) { motivo = "vai_pensar"; dias = 1; }
    const frasesCaro = ["tá caro", "está caro", "muito caro", "caro demais", "não tenho condição", "não tenho dinheiro", "sem condição", "tá pesado", "fora do meu orçamento", "não cabe no bolso", "não tenho esse valor", "não consigo", "não tenho como"];
    if (!motivo && frasesCaro.some(f => t.includes(f))) { motivo = "achou_caro"; dias = 3; }
    const frasesAvaliacao = ["avaliação baixa", "pouco pelo meu", "esperava mais", "vale mais", "não compensa", "achei pouco", "muito pouco"];
    if (!motivo && frasesAvaliacao.some(f => t.includes(f))) { motivo = "avaliacao_baixa"; dias = 5; }
    const frasesSemInteresse = ["não tenho interesse", "desisti", "não quero mais", "mudei de ideia", "cancelar", "esquece", "deixa pra lá"];
    if (!motivo && frasesSemInteresse.some(f => t.includes(f))) { motivo = "sem_interesse"; dias = 7; }
    if (!motivo) return;
    const vm = historico.match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid/i);
    await agendarFollowUp(from, motivo, vm ? vm[0] : null, dias);
  } catch (e) { console.error("[FollowUp] Erro:", e.message); }
}

async function verificarClientesSumidos() {
  try {
    const agora = Date.now();
    for (const [telefone, ultima] of Object.entries(ultimaMensagemCliente)) {
      if (agora - ultima > 24 * 60 * 60 * 1000) {
        const { data } = await supabase.from("followups").select("id").eq("telefone", telefone).eq("enviado", false).limit(1);
        if (!data?.length) {
          const hist = (conversas[telefone] || []).map(m => m.content || "").join(" ").toLowerCase();
          const vm = hist.match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid/i);
          await agendarFollowUp(telefone, "sumiu", vm ? vm[0] : null, 5);
          await atualizarEstagio(telefone, "frio");
        }
        delete ultimaMensagemCliente[telefone];
      }
    }
  } catch (e) { console.error("[FollowUp] Erro sumidos:", e.message); }
}

setInterval(verificarClientesSumidos, 60 * 60 * 1000);

// A verificação de "visita não confirmada após 2h" foi removida deste ponto
// porque era um sistema paralelo e redundante baseado em memória RAM
// (visitasAgendadas), que se perdia a cada reinício do servidor. O mesmo
// controle já é feito de forma resiliente pela tabela "followups" no
// Supabase, através de agendarFollowUpHoras() (chamado em detectarEstagio,
// quando o cliente confirma a visita) e processarFollowUpsPendentes()
// (que já lida com o motivo "visita_nao_confirmada" e cancela
// automaticamente se o estágio do cliente mudar antes do prazo).


// Nome do template aprovado na Meta (configurável via variável de ambiente)
// Precisa ser criado e aprovado no WhatsApp Manager antes de funcionar.
const TEMPLATE_FOLLOWUP = process.env.TEMPLATE_FOLLOWUP_NAME || "followup_generico";

async function enviarMensagemTemplate(telefone, nomeTemplate, parametros = []) {
  try {
    const components = parametros.length > 0 ? [{
      type: "body",
      parameters: parametros.map(p => ({ type: "text", text: String(p) }))
    }] : [];
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefone,
        type: "template",
        template: {
          name: nomeTemplate,
          language: { code: "pt_BR" },
          components
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    return true;
  } catch (e) {
    console.error(`[Template] Erro ao enviar "${nomeTemplate}":`, e.response?.data ? JSON.stringify(e.response.data) : e.message);
    return false;
  }
}

async function gerarMensagemFollowUp(followup) {
  try {
    const veiculo = followup.veiculo_interesse || "nossos veículos";
    const prompts = {
      vai_pensar: `Você é Sarah, vendedora da Premium Automarcas. Cliente interessado em ${veiculo} disse que ia pensar. Mensagem curta e calorosa, sem pressionar. Máximo 3 linhas.`,
      achou_caro: `Você é Sarah, vendedora da Premium Automarcas. Cliente achou ${veiculo} caro. Pergunte qual parcela cabe no orçamento. Máximo 3 linhas.`,
      avaliacao_baixa: `Você é Sarah, vendedora da Premium Automarcas. Cliente insatisfeito com avaliação na troca. Reforce que avaliação presencial pode surpreender. Máximo 3 linhas.`,
      sem_interesse: `Você é Sarah, vendedora da Premium Automarcas. Cliente sem interesse. Mensagem muito leve. Máximo 2 linhas.`,
      sumiu: `Você é Sarah, vendedora da Premium Automarcas. Cliente parou de responder sobre ${veiculo}. Mensagem curta para retomar. Máximo 2 linhas.`,
      visita_nao_confirmada: `Você é Sarah, vendedora da Premium Automarcas. O cliente tinha agendado uma visita pra loja sobre o ${veiculo} mas não temos confirmação de que ele veio. Mensagem tipo "Verifiquei que não conseguiu comparecer no horário agendado. Gostaria de reagendar?" — natural, sem cobrar, sugerindo reagendar pra mais tarde ou outro dia. Máximo 3 linhas.`
    };
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5", max_tokens: 150, messages: [{ role: "user", content: prompts[followup.motivo] || prompts.vai_pensar }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    return res.data.content[0].text;
  } catch (e) {
    if (e.response) await notificarFalhaApiClaude(e, `Geração de mensagem de follow-up (${followup.telefone})`);
    return null;
  }
}

async function processarFollowUpsPendentes() {
  try {
    const { data: followups } = await supabase.from("followups").select("*").eq("enviado", false).lte("agendado_para", new Date().toISOString());
    if (!followups?.length) return;
    for (const followup of followups) {
      // Para visita não confirmada: só dispara se o lead AINDA estiver em visita_agendada
      // (se já foi movido manualmente pra fechado/negociacao/etc, cancela o follow-up)
      if (followup.motivo === "visita_nao_confirmada") {
        const { data: clienteAtual } = await supabase.from("clientes").select("estagio").eq("telefone", followup.telefone).limit(1);
        if (clienteAtual?.[0]?.estagio !== "visita_agendada") {
          await supabase.from("followups").update({ enviado: true }).eq("id", followup.id);
          console.log(`[FollowUp] Cancelado (estágio mudou): ${followup.telefone}`);
          continue;
        }
      }
      const mensagem = await gerarMensagemFollowUp(followup);
      if (!mensagem) continue;
      try {
        // Follow-ups disparam depois de tempo (1-7 dias ou 2h), então é provável
        // que a janela de 24h já tenha fechado. Usa template aprovado pela Meta
        // para garantir entrega. Se falhar (template não existe/aprovado ainda),
        // tenta texto livre como fallback (funciona se a janela ainda estiver aberta).
        const veiculo = followup.veiculo_interesse || "nossos veículos";
        const enviouTemplate = await enviarMensagemTemplate(followup.telefone, TEMPLATE_FOLLOWUP, [veiculo]);

        if (!enviouTemplate) {
          console.log(`[FollowUp] Template falhou, tentando texto livre para ${followup.telefone}`);
          await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to: followup.telefone, text: { body: mensagem } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
          );
        }

        await supabase.from("followups").update({ enviado: true }).eq("id", followup.id);
        await salvarMensagem(followup.telefone, "sara", mensagem);
        if (!conversas[followup.telefone]) conversas[followup.telefone] = [];
        conversas[followup.telefone].push({ role: "assistant", content: mensagem });
        await notificarAugusto(followup.telefone, `[FollowUp]: ${mensagem}`, false);
      } catch (e) { console.error(`[FollowUp] Erro envio:`, e.message); }
    }
  } catch (e) { console.error("[FollowUp] Erro:", e.message); }
}

setInterval(processarFollowUpsPendentes, 30 * 60 * 1000);
processarFollowUpsPendentes();

// ─────────────────────────────────────────────
// NOTIFICAÇÕES
// ─────────────────────────────────────────────

async function notificarAugusto(from, texto, primeiraVez = false) {
  const agora = Date.now();
  const ultima = ultimaNotificacao[from] || 0;
  if (!primeiraVez && agora - ultima < 30 * 60 * 1000) return;
  ultimaNotificacao[from] = agora;
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
  const mensagem = `${primeiraVez ? "🆕 *Novo cliente*" : "📩 *Mensagem*"}\nNúmero: ${formatado}\n"${String(texto).substring(0, 100)}"\n\nhttps://agente-mensagens1.onrender.com/painel`;
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Notificação] ✅ ${primeiraVez ? "Novo" : "Update"} — ${formatado}`);
  } catch (e) { console.error(`[Notificação] Erro:`, e.message); }
}

async function notificarCarroNaoDisponivel(from, modeloBuscado, infoCliente) {
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
  const mensagem = `🔍 *Carro não disponível*\nCliente: ${formatado}\nProcura: *${modeloBuscado}*\n${infoCliente ? `Info: ${infoCliente}` : ""}`;
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) { console.error(`[Notificação] Erro carro:`, e.message); }
}

// Reenvia ao consultor a foto enviada pelo cliente, junto com a análise
// gerada pela Sarah. Resolve a falta de visibilidade visual: antes, só o
// texto da análise ficava salvo, a imagem em si nunca era vista por ninguém.
//
// IMPORTANTE: recebe os bytes da imagem (buffer) já baixados, não uma URL.
// A API do WhatsApp tem duas formas de mandar imagem: por "link" (URL
// pública, sem autenticação) ou por upload direto (media_id). A URL da
// Meta para baixar mídia recebida é privada e exige header Authorization,
// que o campo "link" não suporta — por isso o reenvio por link sempre
// falhava silenciosamente. A correção é fazer upload dos bytes para obter
// um media_id novo, e então enviar usando esse media_id.
async function notificarFotoComAnalise(from, imageBuffer, mimeType, analise, caption = "") {
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
  const legenda = `📸 *Foto recebida de ${formatado}*${caption ? `\nLegenda do cliente: "${caption}"` : ""}\n\n*Análise da Sarah:*\n${analise}`;
  try {
    // Passo 1: upload da imagem para obter um media_id válido para envio
    const formData = new FormData();
    formData.append("file", Buffer.from(imageBuffer), { filename: "foto.jpg", contentType: mimeType });
    formData.append("messaging_product", "whatsapp");
    const uploadRes = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/media`, formData,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...formData.getHeaders() } }
    );
    const novoMediaId = uploadRes.data.id;

    // Passo 2: envia a imagem usando o media_id obtido
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, type: "image", image: { id: novoMediaId, caption: legenda.substring(0, 1024) } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Foto→Consultor] ✅ Repassada foto de ${from}`);
  } catch (e) {
    console.error(`[Foto→Consultor] Erro ao reenviar imagem (tentando só texto):`, e.response?.data ? JSON.stringify(e.response.data) : e.message);
    // Fallback: se o upload/reenvio da imagem falhar, ao menos manda a
    // análise em texto para não perder a informação completamente.
    try {
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: legenda + "\n\n⚠️ (não foi possível reenviar a imagem original)" } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
    } catch (e2) { console.error(`[Foto→Consultor] Erro também no fallback de texto:`, e2.message); }
  }
}

// ─────────────────────────────────────────────
// INSTAGRAM — COM PAGINAÇÃO COMPLETA
// ─────────────────────────────────────────────

async function buscarEstoqueInstagram() {
  try {
    console.log("[Instagram] Buscando posts...");
    const veiculos = [];
    let url = `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media?fields=id,caption,media_type,media_url,children{media_url}&limit=50&access_token=${INSTAGRAM_TOKEN}`;
    let paginas = 0;
    const maxPaginas = 10;

    while (url && paginas < maxPaginas) {
      const res = await axios.get(url);
      const posts = res.data.data || [];
      paginas++;

      for (const post of posts) {
        const caption = limparTexto(post.caption || "");
        if (!caption.includes("R$")) continue;
        let fotos = [];
        if (post.media_type === "CAROUSEL_ALBUM" && post.children) fotos = post.children.data.map(c => c.media_url).filter(Boolean);
        else if (post.media_url) fotos = [post.media_url];
        const precoMatch = caption.match(/R\$\s*([\d.,]+)/);
        const kmMatch = caption.match(/([\d.,]+)\s*km/i);
        const anoMatch = caption.match(/(\d{4})\/\d{4}|(\d{4})/);
        const linhas = caption.split("\n").filter(l => l.trim());
        const preco = precoMatch ? parseFloat(precoMatch[1].replace(/\./g, "").replace(",", ".")) : 0;
        if (preco === 0) continue;
        veiculos.push({
          id: post.id,
          modelo: limparTexto(linhas[0] || "").replace(/[🚗🚙🏎️]/g, "").trim(),
          ano: anoMatch ? (anoMatch[1] || anoMatch[2]) : "",
          km: kmMatch ? parseFloat(kmMatch[1].replace(/\./g, "").replace(",", ".")) : 0,
          preco,
          descricao: caption, fotos, atualizadoEm: new Date().toISOString()
        });
      }

      const nextCursor = res.data.paging?.cursors?.after;
      const hasNext = res.data.paging?.next;
      if (hasNext && nextCursor && posts.length > 0) {
        url = `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media?fields=id,caption,media_type,media_url,children{media_url}&limit=50&after=${nextCursor}&access_token=${INSTAGRAM_TOKEN}`;
        console.log(`[Instagram] Buscando página ${paginas + 1}... (${veiculos.length} veículos até agora)`);
      } else {
        url = null;
      }
    }

    console.log(`[Instagram] ✅ ${veiculos.length} veículos extraídos (${paginas} página(s))`);
    return veiculos;
  } catch (e) { console.error("[Instagram] Erro:", e.message); return []; }
}

async function sincronizarEstoque() {
  try {
    const veiculos = await buscarEstoqueInstagram();
    if (veiculos.length > 0) {
      estoqueAtual = veiculos;
      ultimaAtualizacao = new Date().toLocaleString("pt-BR");
      console.log(`[Estoque] ✅ ${veiculos.length} veículos | ${ultimaAtualizacao}`);
    }
  } catch (e) { console.error("[Estoque] Erro:", e.message); }
}

sincronizarEstoque();
setInterval(sincronizarEstoque, 30 * 60 * 1000);

setInterval(async () => {
  try {
    await axios.get("https://agente-mensagens1.onrender.com");
    console.log("[KeepAlive] ✅ Ativo");
  } catch (e) { console.error("[KeepAlive] Erro:", e.message); }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────
// FIPE
// ─────────────────────────────────────────────

async function getMarcasFipe() {
  if (cacheMarcasFipe) return cacheMarcasFipe;
  const res = await axios.get("https://parallelum.com.br/fipe/api/v1/carros/marcas");
  cacheMarcasFipe = res.data;
  return cacheMarcasFipe;
}

async function consultarFipe(marca, modelo, ano) {
  if (!marca || !modelo || !ano) return null;
  const chave = `${marca}-${modelo}-${ano}`.toLowerCase();
  if (fipeCache[chave]) return fipeCache[chave];
  try {
    const marcas = await getMarcasFipe();
    const marcaFipe = marcas.find(m => m.nome.toLowerCase().includes(marca.toLowerCase()) || marca.toLowerCase().includes(m.nome.toLowerCase().split(" ")[0]));
    if (!marcaFipe) return null;
    const modelosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos`);
    const candidatos = modelosRes.data.modelos.filter(m => m.nome.toLowerCase().includes(modelo.toLowerCase().split(" ")[0]));
    if (!candidatos.length) return null;
    for (const c of candidatos) {
      const anosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${c.codigo}/anos`);
      const anoFipe = anosRes.data.find(a => a.nome.includes(ano.toString()) && !a.nome.includes("32000"));
      if (anoFipe) {
        const valorRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${c.codigo}/anos/${anoFipe.codigo}`);
        fipeCache[chave] = valorRes.data;
        console.log(`✅ FIPE: ${valorRes.data.Modelo} = ${valorRes.data.Valor}`);
        return valorRes.data;
      }
    }
    return null;
  } catch (e) { return null; }
}

function calcularValoresTroca(valorFipeStr) {
  const valor = parseFloat(valorFipeStr.replace("R$ ", "").replace(/\./g, "").replace(",", "."));
  return {
    minimoFormatado: Math.round(valor * 0.80).toLocaleString("pt-BR"),
    maximoFormatado: Math.round(valor * 0.85).toLocaleString("pt-BR")
  };
}

// ─────────────────────────────────────────────
// ÁUDIO E IMAGEM
// ─────────────────────────────────────────────

async function transcreverAudio(mediaId) {
  try {
    const mediaRes = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const audioRes = await axios.get(mediaRes.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer" });
    const formData = new FormData();
    formData.append("file", Buffer.from(audioRes.data), { filename: "audio.ogg", contentType: "audio/ogg" });
    formData.append("model", "whisper-large-v3");
    formData.append("language", "pt");
    const res = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", formData, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...formData.getHeaders() } });
    return res.data.text;
  } catch (e) { return null; }
}

// Analisa a imagem enviada pelo cliente E repassa (foto + análise) ao
// consultor no WhatsApp pessoal, para que ele tenha visibilidade visual
// do veículo sendo avaliado na troca — algo que antes não existia.
async function analisarImagem(mediaId, caption, from) {
  try {
    const mediaRes = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const imageRes = await axios.get(mediaRes.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer" });
    const base64Image = Buffer.from(imageRes.data).toString("base64");
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5", max_tokens: 200, messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaRes.data.mime_type || "image/jpeg", data: base64Image } },
        { type: "text", text: `Avaliador de veículos. Descreva em 2 linhas: estado geral, pontos positivos e de atenção. ${caption ? `Contexto: ${caption}` : ""}` }
      ]}] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const analise = res.data.content[0].text;

    // Repassa foto + análise ao consultor. Reenvia os BYTES já baixados
    // (não a URL privada da Meta — essa URL exige o header Authorization
    // para funcionar, e o campo "image.link" do WhatsApp não suporta
    // headers customizados, então o reenvio por link sempre falhava
    // silenciosamente e o consultor nunca recebia a foto).
    if (from) notificarFotoComAnalise(from, imageRes.data, mediaRes.data.mime_type || "image/jpeg", analise, caption).catch(() => {});

    return analise;
  } catch (e) {
    if (e.response) await notificarFalhaApiClaude(e, `Análise de imagem (${from || "desconhecido"})`);
    return null;
  }
}

// ─────────────────────────────────────────────
// FOTOS DO ESTOQUE
// ─────────────────────────────────────────────

function clienteEstaPedindoFotosDoEstoque(texto, historicoConversa) {
  const t = texto.toLowerCase().trim();
  if (clienteEstaEmFluxoTroca(historicoConversa)) return false;
  const ultimaResposta = (historicoConversa || []).filter(m => m.role === "assistant").slice(-1)[0]?.content || "";
  const confirmacoesSimples = ["sim", "quero", "pode", "manda", "claro", "ok", "vai", "manda sim", "quero sim"];
  if (confirmacoesSimples.includes(t) && ultimaResposta.toLowerCase().includes("foto")) return true;
  const naoEPedido = ["te mando", "vou mandar", "vou te mandar", "ja mando", "já mando", "mando agora", "mandando foto", "vou enviar", "to mandando", "tô mandando"];
  if (naoEPedido.some(p => t.includes(p))) return false;
  const ePedido = ["tem foto", "tem fotos", "manda foto", "manda as foto", "pode mandar foto", "me manda foto", "me passa foto", "quero ver foto", "quero ver as foto", "me mostra", "posso ver", "foto dele", "fotos dele", "vai mandar as fotos", "as fotos"];
  return ePedido.some(p => t.includes(p));
}

function encontrarVeiculoNoContexto(texto, historicoConversa, estoque) {
  // Estratégia corrigida: procura o veículo mais RECENTEMENTE mencionado,
  // olhando as mensagens de trás pra frente (mais novas primeiro).
  // Isso evita que um carro citado há muitas mensagens atrás "vença" por
  // coincidência de palavras genéricas (ex: "flex", "automático", "4x4").

  const mensagensRecentes = [
    { role: "user", content: texto },
    ...(historicoConversa || []).slice().reverse()
  ];

  function pontuarVeiculo(v, textoAlvo) {
    const modelo = limparTexto(v.modelo || "").toLowerCase();
    // Só considera palavras significativas do modelo (>=3 letras, ignora números soltos de versão tipo "1.0")
    const palavrasModelo = modelo.split(/\s+/).filter(p => p.length >= 3 && !/^\d+([.,]\d+)?$/.test(p));
    if (!palavrasModelo.length) return 0;
    let score = palavrasModelo.filter(p => textoAlvo.includes(p)).length;
    if (v.ano && textoAlvo.includes(String(v.ano))) score += 1;
    return score;
  }

  // Passo 1: procura nas mensagens mais recentes primeiro (até 12 mensagens pra trás)
  for (const msg of mensagensRecentes.slice(0, 12)) {
    const textoMsg = (msg.content || "").toLowerCase();
    if (!textoMsg.trim()) continue;
    let melhorMatch = null, melhorScore = 0;
    for (const v of estoque) {
      const score = pontuarVeiculo(v, textoMsg);
      if (score > melhorScore) { melhorScore = score; melhorMatch = v; }
    }
    // Exige pelo menos 2 palavras do modelo batendo, para evitar falso positivo
    // com modelos de nome curto (ex: "Ka", "Up")
    if (melhorMatch && melhorScore >= 2) return melhorMatch;
  }

  // Passo 2: fallback — match de pelo menos 1 palavra forte, ainda na mensagem mais recente que mencionar algo
  for (const msg of mensagensRecentes.slice(0, 12)) {
    const textoMsg = (msg.content || "").toLowerCase();
    if (!textoMsg.trim()) continue;
    let melhorMatch = null, melhorScore = 0;
    for (const v of estoque) {
      const score = pontuarVeiculo(v, textoMsg);
      if (score > melhorScore) { melhorScore = score; melhorMatch = v; }
    }
    if (melhorMatch && melhorScore >= 1) return melhorMatch;
  }

  return null;
}

// Conta quantos veículos do estoque "batem" com o texto mencionado pelo
// cliente (ex: "Argo" pode bater com 3 anúncios diferentes). Usado para
// detectar ambiguidade e instruir a Sarah a perguntar qual deles, em vez
// de responder com um preço/veículo escolhido arbitrariamente.
function contarVeiculosAmbiguos(texto, estoque) {
  const t = texto.toLowerCase();
  function pontuar(v) {
    const modelo = limparTexto(v.modelo || "").toLowerCase();
    const palavras = modelo.split(/\s+/).filter(p => p.length >= 3 && !/^\d+([.,]\d+)?$/.test(p));
    if (!palavras.length) return 0;
    return palavras.filter(p => t.includes(p)).length;
  }
  const candidatos = estoque.filter(v => pontuar(v) >= 1);
  return candidatos;
}

async function enviarFotosVeiculo(to, veiculo) {
  const fotos = (veiculo.fotos || []).slice(0, 5);
  if (!fotos.length) return false;
  let sucessos = 0;
  for (const url of fotos) {
    try {
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to, type: "image", image: { link: url } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      sucessos++;
      await new Promise(r => setTimeout(r, 600));
    } catch (e) { console.error(`Erro foto: ${e.message}`); }
  }
  console.log(`[Fotos] Enviadas: ${sucessos}/${fotos.length}`);
  return sucessos > 0;
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

function formatarEstoque() {
  if (!estoqueAtual.length) return "Estoque sendo carregado.";
  // Inclui a descrição completa (legenda original do Instagram) de cada
  // veículo, não só modelo/ano/km/preço. Antes, a Sarah só recebia esses
  // 4 campos e, quando o cliente perguntava sobre opcionais, transmissão
  // (manual/automático), ou outras características, ela não tinha o dado
  // real disponível e acabava inventando uma resposta plausível — por
  // exemplo, afirmar que um carro é "automático" sem isso constar em
  // lugar nenhum do anúncio real.
  return estoqueAtual.map(v => {
    const cabecalho = `${limparTexto(v.modelo || "")} ${v.ano || ""} - ${Number(v.km || 0).toLocaleString("pt-BR")} km - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`;
    const descricaoCompleta = limparTexto(v.descricao || "").substring(0, 500);
    return descricaoCompleta ? `${cabecalho}\n  Detalhes do anúncio: ${descricaoCompleta}` : cabecalho;
  }).join("\n\n");
}

const SYSTEM_PROMPT = (fipeInfo, aprendizadosExtra = "", carroNaoDisponivel = null, descontoPendenteAtivo = false, veiculosAmbiguos = null) => {
  const agora = new Date();
  const dataHoraAtual = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return `Você é Sarah, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

DATA E HORA ATUAL: ${dataHoraAtual} (horário de Porto Alegre/RS)
- Use essa informação para saber se é manhã, tarde, noite, ou outro dia.
- Se um compromisso combinado anteriormente (ex: "vir de manhã") já passou do horário, NÃO repita a mesma combinação como se ainda fosse válida — pergunte se ainda está de pé ou se precisa reagendar.
- Nunca presuma que "hoje" na conversa atual é o mesmo dia de mensagens antigas do histórico sem checar a data.

EMPRESA: Av. Aparício Borges, 931 | Seg-Sex 8h-18h, Sáb 8h-12h | Consultor: (51) 99364-2476

PERFIL: Simpática, descontraída e profissional. Máximo 4 linhas por resposta. NUNCA repita a saudação após a primeira mensagem. SEMPRE mantenha o contexto da conversa.

REGRA CRÍTICA — NUNCA MENCIONAR NOMES: Nunca cite "Augusto" ou qualquer nome pessoal. Use sempre "nosso consultor" ou "nossa equipe".

ESTOQUE ATUAL (${ultimaAtualizacao || "carregando..."}):
${formatarEstoque()}

🚨 REGRA CRÍTICA DE PREÇOS — ABSOLUTA, SEM EXCEÇÕES:
- Use EXATAMENTE os preços do estoque acima, caractere por caractere. NUNCA invente, estime, arredonde ou "lembre de cabeça" um valor.
- Antes de escrever qualquer preço na resposta, releia a linha exata do estoque correspondente ao veículo. Copie o valor dali.
- Se o veículo mencionado pelo cliente NÃO aparecer claramente no estoque acima, NÃO cite nenhum valor — diga que vai confirmar com a equipe.
- Se você não tiver 100% de certeza de qual linha do estoque corresponde ao veículo, pergunte para o cliente confirmar o modelo/ano em vez de chutar um preço aproximado.
- JAMAIS informe um preço diferente do que está listado acima, mesmo que pareça "razoável" ou "parecido" com outros veículos.

🚨 REGRA CRÍTICA — NUNCA INVENTE O MODELO DO VEÍCULO DO CLIENTE:
- Quando o cliente estiver descrevendo o carro QUE ELE QUER DAR NA TROCA, NUNCA atribua um nome de modelo que ele não disse explicitamente.
- Se o cliente disser algo ambíguo como "minha 2006" ou só o ano/motorização sem nome do modelo, NÃO adivinhe nem complete com um modelo do seu conhecimento geral (ex: não vá dizer "Meriva", "Gol", etc. por palpite).
- Nesse caso, pergunte diretamente: "qual é o modelo do seu carro?" antes de continuar a avaliação.
- Só repita/confirme o nome de um modelo se o cliente já tiver escrito esse nome em uma mensagem anterior da própria conversa.

🚨 REGRA CRÍTICA — NUNCA INVENTE CARACTERÍSTICAS TÉCNICAS DO VEÍCULO:
- Cada veículo no estoque acima tem uma linha "Detalhes do anúncio" com as informações REAIS daquele carro específico (opcionais, condição, etc.).
- Transmissão (manual/automático), opcionais (ar-condicionado, vidro elétrico, etc.), e qualquer outra característica técnica só podem ser informados se estiverem EXPLICITAMENTE nessa descrição do anúncio.
- Se o cliente perguntar algo que não está na descrição (ex: "é automático?"), e a descrição não mencionar isso, diga que vai confirmar com a equipe — NUNCA afirme ou negue com base em achismo ou conhecimento geral sobre o modelo.
- Isso vale mesmo que você "saiba" que aquele modelo de carro geralmente vem com determinada característica — o que importa é o anúncio real do veículo específico em estoque, que pode ter uma versão diferente do usual.

${veiculosAmbiguos && veiculosAmbiguos.length > 1 ? `🚨 AMBIGUIDADE DETECTADA — MAIS DE UM VEÍCULO NO ESTOQUE BATE COM O QUE O CLIENTE MENCIONOU:
${veiculosAmbiguos.map(v => `- ${limparTexto(v.modelo || "")} ${v.ano || ""} - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`).join("\n")}
NÃO escolha um desses sozinha nem responda com um preço genérico. Liste rapidamente as opções disponíveis (ano/versão) e pergunte qual delas o cliente quer, ANTES de informar qualquer preço.` : ""}

${carroNaoDisponivel ? `⚠️ CARRO NÃO DISPONÍVEL: Cliente procura ${carroNaoDisponivel}.
1. Informe que não está disponível no momento
2. Pergunte: ano procurado, faixa de preço/parcela, tem troca?
3. Diga: "Posso te avisar quando chegar um ${carroNaoDisponivel} aqui! 😊"
4. Só ofereça alternativas se tiver algo REALMENTE similar` : ""}

${descontoPendenteAtivo ? `🚨 DESCONTO PENDENTE — REGRA CRÍTICA E ABSOLUTA:
Há um pedido de desconto aguardando retorno do nosso consultor. Ele AINDA NÃO RESPONDEU.
- NÃO mencione o desconto por conta própria em saudações ou mensagens neutras (ex: "boa tarde", "oi", "tudo bem?"). Nesses casos, responda normalmente ao que o cliente disse, sem puxar o assunto do desconto.
- Só fale sobre o desconto se o CLIENTE perguntar especificamente sobre isso. Nesse caso: "Ainda não tive retorno do nosso consultor, mas assim que confirmar te aviso! 😊"
- Continue atendendo normalmente sobre outros assuntos (fotos, financiamento, visita, etc.)
- JAMAIS invente, afirme ou sugira que o desconto foi aprovado, negado ou que chegou a um valor específico. Isso só pode vir de uma instrução explícita do sistema confirmando a decisão real.
- Você NÃO TEM autoridade para fechar nenhum valor diferente do preço de tabela enquanto este aviso estiver ativo.` : `
🚨 REGRA CRÍTICA DE DESCONTOS: Você NUNCA pode confirmar, inventar ou sugerir que um desconto foi aprovado por conta própria. Qualquer valor abaixo do preço de tabela só pode ser comunicado se vier explicitamente de uma instrução do sistema dizendo "nosso consultor autorizou". Sem essa instrução explícita, sempre cite o preço cheio do estoque.`}

FOTOS: Quando o sistema confirmar [fotos enviadas], diga: "Mandei as fotos! O que achou? 😊". NUNCA diga que enviou fotos sem essa confirmação. NUNCA use tags XML.

PAGAMENTO: BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú, Cartão, Consórcio, À vista

AVALIAÇÃO DE TROCA:
Etapa 1: km, estado geral, revisões, fotos 📸
- Se o sistema já forneceu uma [Análise de foto] com informações sobre estado geral, pontos positivos ou pontos de atenção do veículo, APROVEITE essas informações. NÃO pergunte de novo sobre algo que a análise da foto já respondeu (ex: não pergunte "como está o estado geral?" se a análise já descreveu o estado). Pergunte apenas o que ainda falta (tipicamente: quilometragem, se não tiver sido informada).
Etapa 2: Agradeça as fotos
Etapa 3 (só após tudo): ${fipeInfo ? (() => { const v = calcularValoresTroca(fipeInfo.Valor); return `"Conseguimos trabalhar entre R$ ${v.minimoFormatado} e R$ ${v.maximoFormatado} na troca. Avaliação final é presencial!" NÃO mencione FIPE.`; })() : "NUNCA invente valores de troca."}

QUANDO ACHAR CARO: Pergunte qual parcela cabe no orçamento e tente adaptar.
QUANDO DISSER "VOU PENSAR": Pergunte o que ficou na dúvida antes de encerrar.

🚨 FINANCIAMENTO — REGRA CRÍTICA E ABSOLUTA: Você NUNCA deve calcular, estimar ou informar nenhum valor de parcela diretamente na conversa, mesmo que o cliente peça, insista ou pareça impaciente. Isso vale mesmo que você "saiba" a fórmula ou a taxa — o cálculo só pode ser feito depois de coletar nome, CPF e data de nascimento, porque o valor real depende da aprovação na financeira, não de uma conta simples. Se o cliente perguntar sobre parcela, financiamento, ou quanto ficaria por mês, diga algo como "Posso fazer uma simulação certinha pra você! Só preciso de alguns dados rapidinho" e deixe o sistema iniciar a coleta. NUNCA mencione números de parcela, taxa de juros, ou fórmulas de cálculo na sua resposta.

REGRAS ABSOLUTAS:
- Primeira msg: "Oi! 😊 Aqui é a Sarah da Premium Automarcas!"
- Máximo 4 linhas
- NUNCA pergunte sobre financiamento sem o cliente mencionar
- NUNCA invente links ou use tags XML
- NUNCA cite nomes de pessoas da equipe
- NUNCA escreva texto entre colchetes [ ] nas suas respostas — isso é apenas para instruções internas
- NUNCA copie ou repita instruções do sistema na sua resposta${aprendizadosExtra}`;
};

// ─────────────────────────────────────────────
// COMANDOS DO CONSULTOR (AUTORIZO / NEGO)
// ─────────────────────────────────────────────

function ehConsultor(from) {
  // Compara últimos 10 dígitos para evitar problemas de formatação
  const digitos = (n) => String(n).replace(/\D/g, "").slice(-10);
  return digitos(from) === digitos(NUMERO_AUGUSTO);
}

async function processarComandoConsultor(from, text) {
  if (!ehConsultor(from)) return false;
  const t = text.trim().toUpperCase();

  // Ignora mensagens que não são comandos conhecidos do consultor
  const ehComando = t === "PENDENCIAS" || t === "AUTORIZO" || t === "NEGO" ||
    t.startsWith("AUTORIZO ") || t.startsWith("NEGO ") || /^SIMULA[CÇ][AÃ]O\s/i.test(text) ||
    /^CONTRAPROPOSTA\s/i.test(text);
  if (!ehComando) return false;

  await carregarDescontoPendente();

  // Comando PENDENCIAS
  if (t === "PENDENCIAS") {
    const msg = descontoPendente
      ? `💰 Desconto pendente:\nCliente: ${descontoPendente.telefone}\n${JSON.stringify(descontoPendente.info)}`
      : "✅ Nenhum desconto pendente.";
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: msg } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    return true;
  }

  // Comando SIMULACAO [telefone] [resultado] — responde resultado de crédito ao cliente
  const matchSimulacao = text.match(/^SIMULA[CÇ][AÃ]O\s+(\d{10,13})\s+([\s\S]+)/i);
  if (matchSimulacao) {
    const telefoneCliente = matchSimulacao[1];
    const resultado = matchSimulacao[2].trim();

    await atualizarStatusSimulacao(telefoneCliente, resultado);

    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: `✅ Resultado enviado para ${telefoneCliente}` } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );

    if (!conversas[telefoneCliente]) {
      const msgs = await buscarMensagens(telefoneCliente);
      conversas[telefoneCliente] = msgs.slice(-20).map(m => ({
        role: (m.tipo === "client" || m.tipo === "sistema") ? "user" : "assistant",
        content: m.texto || ""
      }));
    }

    const msgSistema = `[Sistema: resultado da simulação de crédito chegou: "${resultado}". Informe ao cliente de forma natural e entusiasta (se aprovado) ou acolhedora (se negado), sem citar nomes da equipe. Convide para vir à loja fechar o negócio se aprovado.]`;
    conversas[telefoneCliente].push({ role: "user", content: msgSistema });

    try {
      const aprendizadosExtraSim = await obterAprendizados();
      const claudeSim = await axios.post("https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-5",
          max_tokens: 500,
          system: SYSTEM_PROMPT(null, aprendizadosExtraSim, null, false),
          messages: conversas[telefoneCliente]
        },
        { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
      );

      const replySim = claudeSim.data.content[0].text;
      conversas[telefoneCliente].push({ role: "assistant", content: replySim });

      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: telefoneCliente, text: { body: replySim } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await salvarMensagem(telefoneCliente, "sara", replySim);
      console.log(`[Crédito] ✅ Resultado enviado para ${telefoneCliente}`);
    } catch (e) {
      console.error("[Crédito] Erro ao gerar/enviar resposta de simulação:", e.message);
      if (e.response) await notificarFalhaApiClaude(e, `Resposta de simulação de crédito (${telefoneCliente})`);
    }
    return true;
  }

  // Comando CONTRAPROPOSTA [valor] — em vez de aceitar ou negar o pedido
  // original, oferece um valor intermediário ao cliente. Usa o desconto
  // pendente atual para saber para qual cliente enviar.
  const matchContraproposta = text.match(/^CONTRAPROPOSTA\s+([\s\S]+)/i);
  if (matchContraproposta) {
    const valorContraproposta = matchContraproposta[1].trim();

    if (!descontoPendente) {
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: "⚠️ Nenhum desconto pendente no momento para fazer contraproposta." } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      return true;
    }

    const telefoneClienteCP = descontoPendente.telefone;

    // Confirma para o consultor
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: `✅ Contraproposta de *${valorContraproposta}* enviada para ${telefoneClienteCP}` } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );

    // Limpa o desconto pendente original — a contraproposta substitui o
    // pedido inicial; se o cliente recusar ou pedir outro valor, isso vai
    // gerar um novo ciclo de detecção de pedido de desconto normalmente.
    await limparDescontoPendente();

    const registroContraproposta = `[Sistema: nosso consultor NÃO aceitou o valor pedido pelo cliente, mas fez uma CONTRAPROPOSTA de ${valorContraproposta} em ${new Date().toLocaleString("pt-BR")}. Informe esse valor ao cliente de forma natural, como uma condição especial que conseguimos negociar (não diga que é "contraproposta", apenas comunique o valor como a melhor condição possível). Pergunte se ele topa fechar nessas condições.]`;
    await salvarMensagem(telefoneClienteCP, "sistema", registroContraproposta);

    if (!conversas[telefoneClienteCP]) {
      const msgsCP = await buscarMensagens(telefoneClienteCP);
      conversas[telefoneClienteCP] = msgsCP.slice(-20).map(m => ({
        role: (m.tipo === "client" || m.tipo === "sistema") ? "user" : "assistant",
        content: m.texto || ""
      }));
    }
    conversas[telefoneClienteCP].push({ role: "user", content: registroContraproposta });

    try {
      const aprendizadosExtraCP = await obterAprendizados();
      const claudeCP = await axios.post("https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-5",
          max_tokens: 500,
          system: SYSTEM_PROMPT(null, aprendizadosExtraCP, null, false),
          messages: conversas[telefoneClienteCP]
        },
        { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
      );

      const replyCP = claudeCP.data.content[0].text;
      conversas[telefoneClienteCP].push({ role: "assistant", content: replyCP });

      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: telefoneClienteCP, text: { body: replyCP } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await salvarMensagem(telefoneClienteCP, "sara", replyCP);
      console.log(`[Contraproposta] ✅ Valor ${valorContraproposta} enviado para ${telefoneClienteCP}`);
    } catch (e) {
      console.error("[Contraproposta] Erro ao gerar/enviar resposta:", e.message);
      if (e.response) await notificarFalhaApiClaude(e, `Envio de contraproposta (${telefoneClienteCP})`);
    }
    return true;
  }

  // AUTORIZO ou NEGO (sem número — usa o desconto pendente)
  const autorizado = t === "AUTORIZO" || t.startsWith("AUTORIZO ");
  const negado = t === "NEGO" || t.startsWith("NEGO ");

  if (!autorizado && !negado) return false;
  if (!descontoPendente) {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: "⚠️ Nenhum desconto pendente no momento." } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    return true;
  }

  const telefoneCliente = descontoPendente.telefone;

  // Confirma para o consultor
  await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: `✅ ${autorizado ? "Desconto autorizado" : "Desconto negado"} para ${telefoneCliente}` } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );

  // Limpa desconto pendente (memória + persistência)
  await limparDescontoPendente();

  // Salva registro permanente no Supabase como instrução de sistema
  // para Sarah nunca negar após reinício do servidor
  const registroDesconto = autorizado
    ? `[Sistema: desconto AUTORIZADO pelo consultor em ${new Date().toLocaleString("pt-BR")}. Sarah já confirmou ao cliente que conseguimos a condição especial de R$ 70 mil. NUNCA negar que o desconto foi aprovado. Se o cliente perguntar, confirmar que sim, o desconto foi aprovado.]`
    : `[Sistema: desconto NEGADO pelo consultor em ${new Date().toLocaleString("pt-BR")}. Sarah já informou ao cliente que o preço está firme.]`;
  await salvarMensagem(telefoneCliente, "sistema", registroDesconto);

  // Retoma conversa com o cliente
  const msgSistema = autorizado
    ? `[Sistema: nosso consultor autorizou o desconto. Informe ao cliente que conseguimos fazer uma condição especial e tente fechar o negócio. Seja entusiasta mas natural!]`
    : `[Sistema: nosso consultor não autorizou o desconto. Informe ao cliente que infelizmente o preço está firme, mas tente manter o interesse com outras vantagens como IPVA pago, facilidade de financiamento, etc. Não mencione nomes.]`;

  if (!conversas[telefoneCliente]) {
    const msgsAN = await buscarMensagens(telefoneCliente);
    conversas[telefoneCliente] = msgsAN.slice(-20).map(m => ({
      role: (m.tipo === "client" || m.tipo === "sistema") ? "user" : "assistant",
      content: m.texto || ""
    }));
  }
  conversas[telefoneCliente].push({ role: "user", content: msgSistema });

  try {
    const aprendizadosExtra = await obterAprendizados();
    const claude = await axios.post("https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: SYSTEM_PROMPT(null, aprendizadosExtra, null, false),
        messages: conversas[telefoneCliente]
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );

    const reply = claude.data.content[0].text;
    conversas[telefoneCliente].push({ role: "assistant", content: reply });

    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: telefoneCliente, text: { body: reply } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );

    await salvarMensagem(telefoneCliente, "sara", reply);
    console.log(`[Desconto] ${autorizado ? "✅ Autorizado" : "❌ Negado"} para ${telefoneCliente}`);
  } catch (e) {
    console.error("[Desconto] Erro ao gerar/enviar resposta:", e.message);
    if (e.response) await notificarFalhaApiClaude(e, `Resposta após autorizar/negar desconto (${telefoneCliente})`);
  }
  return true;
}

// ─────────────────────────────────────────────
// PROCESSAMENTO PRINCIPAL
// ─────────────────────────────────────────────

async function processarMensagem(from, text, tentativasAnteriores = 0) {
  if (!text || typeof text !== "string") return;

  // Verifica se é comando do consultor
  if (await processarComandoConsultor(from, text)) return;

  ultimaMensagemCliente[from] = Date.now();
  const primeiraVez = !ultimaNotificacao[from];
  const ehRetry = tentativasAnteriores > 0;

  // Carregar histórico do Supabase se não tem em memória (após reinício/deploy)
  if (!conversas[from]) {
    try {
      const msgs = await buscarMensagens(from);
      if (msgs.length > 0) {
        conversas[from] = msgs.slice(-20).map(m => ({
          role: (m.tipo === "client" || m.tipo === "sistema") ? "user" : "assistant",
          content: m.texto || ""
        }));
        console.log(`[Histórico] Recuperado: ${conversas[from].length} msgs de ${from}`);
      } else {
        conversas[from] = [];
      }
    } catch (e) {
      conversas[from] = [];
    }
  }

  // Em retry, a mensagem já está salva no Supabase e, na maioria dos casos,
  // já recuperada no histórico acima — então só adiciona ao array em
  // memória se ela ainda não for a última entrada (evita duplicar).
  const ultimaDoHistorico = conversas[from][conversas[from].length - 1];
  const jaEstaNoHistorico = ultimaDoHistorico && ultimaDoHistorico.role === "user" && ultimaDoHistorico.content === text;
  if (!jaEstaNoHistorico) {
    conversas[from].push({ role: "user", content: text });
  }

  if (!ehRetry) {
    await salvarMensagem(from, "client", text);
  }
  // A notificação deve disparar sempre, mesmo em retry — só o SALVAMENTO no
  // Supabase é que precisa ser evitado para não duplicar. Antes, ambos
  // ficavam dentro do mesmo "if (!ehRetry)", o que significava que qualquer
  // mensagem reprocessada pelo mecanismo de retry NUNCA notificava o
  // consultor, mesmo sendo um cliente novo ou uma mensagem importante.
  notificarAugusto(from, text, primeiraVez).catch(() => {});
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  detectarLeadFrio(from, text, conversas[from]).catch(() => {});
  detectarEstagio(from, text, conversas[from]).catch(() => {});

  // ───── COLETA DE DADOS PARA SIMULAÇÃO DE CRÉDITO ─────
  // Se já está no meio de uma coleta, processa a etapa atual
  if (coletaCredito[from]) {
    const estado = coletaCredito[from];

    if (estado.etapa === "nome") {
      const nomeDigitado = text.trim();
      if (nomeDigitado.split(/\s+/).length >= 2 && nomeDigitado.length >= 5) {
        estado.nome = nomeDigitado;
        estado.etapa = "cpf";
        const msg = "Perfeito! Agora me passa seu CPF, por favor (só os números) 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      } else {
        const msg = "Pode me mandar seu nome completo, por favor? 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      }
    }

    if (estado.etapa === "cpf") {
      const cpfValido = validarCPF(text);
      if (cpfValido) {
        estado.cpf = cpfValido;
        estado.etapa = "nascimento";
        const msg = "Show! Agora sua data de nascimento (dia/mês/ano) 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      } else {
        const msg = "Esse CPF não parece válido. Pode conferir e mandar de novo? (só os números, 11 dígitos) 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      }
    }

    if (estado.etapa === "nascimento") {
      const dataNasc = extrairDataNascimento(text);
      if (dataNasc) {
        estado.nascimento = dataNasc;
        estado.etapa = "entrada";

        // Verifica se um valor de entrada já foi mencionado antes na conversa
        const historicoTexto = (conversas[from] || []).map(m => m.content || "").join(" \n ");
        const matchEntradaPrevia = historicoTexto.match(/entrada[^\d]{0,15}(r\$\s*)?([\d.,]+\s*(mil|k)?)/i)
          || historicoTexto.match(/([\d.,]+\s*(mil|k)?)\s*(de\s*)?entrada/i);

        if (matchEntradaPrevia) {
          const valorDetectado = matchEntradaPrevia[2] || matchEntradaPrevia[1];
          const msg = `Combinado! Você já tinha mencionado uma entrada de *${valorDetectado.trim()}* aqui na nossa conversa — é esse mesmo o valor? Pode confirmar ou me dizer o valor certo 😊`;
          conversas[from].push({ role: "assistant", content: msg });
          await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to: from, text: { body: msg } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
          );
          await salvarMensagem(from, "sara", msg);
          // Guarda o valor detectado como sugestão — se cliente só confirmar ("sim", "isso"), usamos ele
          estado.entradaSugerida = valorDetectado.trim();
          return;
        }

        const msg = "Combinado! Última coisa: você pretende dar algum valor de entrada? Se sim, me diz quanto 😊 (se não tiver entrada, é só dizer)";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      } else {
        const msg = "Não consegui entender a data. Pode mandar no formato dia/mês/ano? Ex: 15/03/1990 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      }
    }

    if (estado.etapa === "entrada") {
      // Aceita valor em texto livre — "sem entrada", "não", "5 mil", "R$ 10.000", etc.
      const tEntrada = text.toLowerCase().trim();
      const semEntrada = ["não", "nao", "sem entrada", "n", "0", "nenhuma", "não tenho", "nao tenho"];
      const confirmacoes = ["sim", "isso", "é esse", "e esse", "esse mesmo", "confirmo", "exato", "isso mesmo", "correto"];

      let entradaValor;
      if (estado.entradaSugerida && confirmacoes.some(p => tEntrada === p || tEntrada.includes(p))) {
        entradaValor = estado.entradaSugerida;
      } else if (semEntrada.some(p => tEntrada === p || tEntrada.includes(p))) {
        entradaValor = "Sem entrada";
      } else {
        entradaValor = text.trim();
      }

      estado.entrada = entradaValor;

      // Prioriza o veículo já registrado no CRM (mais confiável — reflete
      // o histórico real de interesse, ex: quando fotos foram enviadas).
      // Só cai pra busca textual no histórico recente como fallback.
      let nomeVeiculo = null;
      try {
        const { data: clienteData } = await supabase.from("clientes").select("veiculo_interesse").eq("telefone", from).limit(1);
        if (clienteData?.[0]?.veiculo_interesse) nomeVeiculo = clienteData[0].veiculo_interesse;
      } catch (e) {
        // segue pro fallback
      }
      if (!nomeVeiculo) {
        const veiculoInteresse = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
        nomeVeiculo = veiculoInteresse ? `${limparTexto(veiculoInteresse.modelo)} ${veiculoInteresse.ano || ""}`.trim() : null;
      }

      // Coleta completa — notifica e salva
      const dadosFinais = {
        nome: estado.nome, cpf: estado.cpf, nascimento: estado.nascimento,
        entrada: estado.entrada, veiculo: nomeVeiculo
      };
      delete coletaCredito[from];

      await notificarDadosCredito(from, dadosFinais);
      await salvarSimulacaoCredito(from, dadosFinais);
      await atualizarEstagio(from, "negociacao", nomeVeiculo);

      const primeiroNome = dadosFinais.nome.split(" ")[0];
      const primeiroNomeCapitalizado = primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1).toLowerCase();
      const msg = `Perfeito, ${primeiroNomeCapitalizado}! Já encaminhei seus dados pra nossa equipe fazer a simulação nas financeiras. Assim que tiver o resultado, te aviso aqui! 😊`;
      conversas[from].push({ role: "assistant", content: msg });
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: from, text: { body: msg } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await salvarMensagem(from, "sara", msg);
      return;
    }
  }

  // Detecta início de interesse em financiamento — inicia coleta
  if (!coletaCredito[from] && detectarInteresseFinanciamento(text, conversas[from])) {
    coletaCredito[from] = { etapa: "nome" };
    const msg = "Posso fazer uma simulação de crédito pra você! 😊 Pra isso preciso de alguns dados rapidinho. Primeiro, qual seu nome completo?";
    conversas[from].push({ role: "assistant", content: msg });
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: msg } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    await salvarMensagem(from, "sara", msg);
    return;
  }

  // Verifica pedido de desconto — só dispara se não há pendente para este cliente
  await carregarDescontoPendente();
  const clienteTemDescontoPendente = descontoPendente && descontoPendente.telefone === from;
  if (!clienteTemDescontoPendente) {
    const ehDesconto = await processarDesconto(from, text, conversas[from]);
    if (ehDesconto) {
      // Sarah informa que vai verificar e CONTINUA atendendo normalmente
      // (não retorna — deixa seguir para a resposta normal com flag de pendente ativo)
      conversas[from].push({ role: "user", content: `[Sistema: cliente pediu desconto. Já notificamos nosso consultor. Informe que está verificando e continue a conversa normalmente.]` });
    }
  }

  // Extração unificada
  const isSimples = ehMensagemSimples(text);
  const todosTextos = conversas[from].filter(m => m.role === "user").map(m => m.content);
  const { marcaTroca, modeloTroca, anoTroca, modeloBuscado, anoBuscado } = await extrairContextoConversa(todosTextos, isSimples);

  // Carro não disponível
  let carroNaoDisponivel = null;
  if (modeloBuscado) {
    // Comparação por palavras-chave em ambas as direções — antes, usava só
    // v.modelo.includes(modeloBuscado), que falhava sempre que o termo
    // extraído pelo Haiku era mais longo/elaborado que o nome cadastrado
    // no estoque (ex: cliente manda "Polo 1.0 MPI flex" copiado de um
    // anúncio externo, mas o estoque só tem "Polo" — "polo".includes("polo
    // 1.0 mpi flex") é falso, mesmo o carro existindo). Agora verifica se
    // pelo menos uma palavra significativa do termo buscado aparece no
    // nome do estoque, ou vice-versa.
    const normalizarPalavras = (str) => limparTexto(str || "").toLowerCase().split(/\s+/).filter(p => p.length >= 3 && !/^\d+([.,]\d+)?$/.test(p));
    const palavrasBuscadas = normalizarPalavras(modeloBuscado);
    const encontrado = estoqueAtual.some(v => {
      const modeloEstoque = limparTexto(v.modelo || "").toLowerCase();
      const palavrasEstoque = normalizarPalavras(v.modelo);
      // Bate se há intersecção de pelo menos uma palavra significativa,
      // ou se uma string contém a outra diretamente (caso mais simples)
      return modeloEstoque.includes(modeloBuscado.toLowerCase()) ||
        modeloBuscado.toLowerCase().includes(modeloEstoque) ||
        palavrasBuscadas.some(p => palavrasEstoque.includes(p));
    });
    if (!encontrado) {
      const descricao = `${modeloBuscado}${anoBuscado ? ` ${anoBuscado}` : ""}`;
      carroNaoDisponivel = descricao;
      const jaNotificou = conversas[from].some(m => m.content?.includes("[Sistema: cliente buscou"));
      if (!jaNotificou) {
        notificarCarroNaoDisponivel(from, descricao, todosTextos.slice(-3).join(" | ")).catch(() => {});
        conversas[from].push({ role: "user", content: `[Sistema: cliente buscou ${descricao} que não está no estoque. Consultor foi notificado. Qualifique o cliente.]` });
        atualizarEstagio(from, "quente", descricao).catch(() => {});
      }
    }
  }

  // Detecta ambiguidade: mais de um veículo do estoque bate com o texto do
  // cliente (ex: 3 "Argo" diferentes). Nesse caso, a Sarah deve perguntar
  // qual deles, em vez de responder de forma vaga ou escolher um sozinha.
  let veiculosAmbiguos = null;
  if (modeloBuscado) {
    const candidatos = contarVeiculosAmbiguos(modeloBuscado, estoqueAtual);
    if (candidatos.length > 1) veiculosAmbiguos = candidatos;
  }

  // Fotos do estoque
  const ehTextoNormal = !text.startsWith("[Cliente enviou foto") && !text.startsWith("[Áudio]") && !text.startsWith("[Sistema:");
  const jaEnviouFotos = conversas[from].slice(-6).map(m => m.content || "").join(" ").includes("[Sistema: fotos enviadas");
  if (ehTextoNormal && !jaEnviouFotos && clienteEstaPedindoFotosDoEstoque(text, conversas[from])) {
    const veiculo = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
    if (veiculo?.fotos?.length > 0) {
      console.log(`[Fotos] Enviando ${veiculo.fotos.length} fotos do ${veiculo.modelo}`);
      const enviouComSucesso = await enviarFotosVeiculo(from, veiculo);
      if (enviouComSucesso) {
        conversas[from].push({ role: "user", content: `[Sistema: fotos enviadas do ${limparTexto(veiculo.modelo)}. Confirme o envio e pergunte o que achou.]` });
        atualizarEstagio(from, "negociacao", limparTexto(veiculo.modelo)).catch(() => {});
      } else {
        conversas[from].push({ role: "user", content: `[Sistema: tentativa de envio de fotos do ${limparTexto(veiculo.modelo)} falhou. NÃO diga que enviou fotos. Informe que está com instabilidade e peça para tentar novamente.]` });
      }
    }
  }

  // FIPE
  let fipeInfo = null;
  if (marcaTroca && modeloTroca && anoTroca) {
    fipeInfo = await consultarFipe(marcaTroca, modeloTroca, anoTroca);
  }

  const aprendizadosExtra = await obterAprendizados();
  const clienteAindaTemPendente = descontoPendente && descontoPendente.telefone === from;

  // Resposta principal — Sonnet
  try {
    const claude = await axios.post("https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: SYSTEM_PROMPT(fipeInfo, aprendizadosExtra, carroNaoDisponivel, clienteAindaTemPendente, veiculosAmbiguos),
        messages: conversas[from]
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );

    const reply = claude.data.content[0].text;
    conversas[from].push({ role: "assistant", content: reply });

    const respMeta = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: reply } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    const wamidReply = respMeta.data?.messages?.[0]?.id || null;

    console.log(`Resposta para ${from}: ${reply}`);
    await salvarMensagem(from, "sara", reply, wamidReply);
  } catch (e) {
    console.error(`[Resposta principal] Erro ao gerar/enviar resposta para ${from}:`, e.message);
    if (e.response) {
      console.error("Detalhe:", JSON.stringify(e.response.data));
      await notificarFalhaApiClaude(e, `Resposta principal ao cliente (${from})`);
    }
    // Em vez de simplesmente desistir, salva a mensagem como pendente para
    // o job de retry tentar de novo automaticamente em alguns minutos —
    // assim, quando o crédito da API for reposto, a Sarah retoma sozinha
    // sem precisar que o cliente escreva de novo.
    const tentativas = (tentativasAnteriores || 0) + 1;
    if (tentativas <= MAX_TENTATIVAS_PENDENTE) {
      try {
        await supabase.from("mensagens_pendentes").insert({ telefone: from, texto: text, tentativas });
        console.log(`[Retry] Mensagem de ${from} re-agendada para retry (tentativa ${tentativas}/${MAX_TENTATIVAS_PENDENTE})`);
      } catch (e2) {
        console.error("[Retry] Erro ao salvar pendente:", e2.message);
      }
      // Remove a mensagem que tinha sido empurrada no histórico em memória,
      // para não duplicar o contexto quando o retry rodar de novo.
      if (conversas[from]?.length) conversas[from].pop();
    } else {
      console.error(`[Retry] Desistindo após ${tentativas} tentativas para ${from}`);
    }
  }
}

async function processarFotosAgrupadas(from, analises) {
  const texto = analises.length === 1
    ? `[Cliente enviou foto. Análise: ${analises[0]}]`
    : `[Cliente enviou ${analises.length} fotos. Análises:\n${analises.map((a, i) => `Foto ${i+1}: ${a}`).join("\n")}]`;
  await processarMensagemNaFila(from, texto);
}

// ─────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────

app.get("/", (req, res) => res.send("Sarah CRM funcionando! ✅"));
app.get("/estoque", (req, res) => res.json({ total: estoqueAtual.length, ultimaAtualizacao, veiculos: estoqueAtual }));
app.get("/sincronizar", async (req, res) => { res.send("Iniciado!"); await sincronizarEstoque(); });
app.get("/testar-supabase", async (req, res) => {
  try {
    const { error } = await supabase.from("mensagens").select("count").limit(1);
    if (error) return res.json({ ok: false, erro: error.message });
    res.json({ ok: true, mensagem: "Supabase conectado!" });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});
app.get("/diagnostico", async (req, res) => {
  try {
    const { data } = await supabase.from("clientes").select("count").limit(1);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#000;color:#fff;font-family:monospace;padding:20px">
<h2 style="color:#f0a500">Diagnóstico Sarah CRM</h2>
<p>Supabase: ✅ OK</p>
<p id="r">Testando fetch...</p>
<script>
fetch('https://agente-mensagens1.onrender.com/crm')
  .then(r => { document.getElementById('r').textContent = 'Fetch /crm: ✅ HTTP ' + r.status; return r.json(); })
  .then(d => {
    const total = Object.values(d).reduce((a,b) => a + b.length, 0);
    document.getElementById('r').textContent += ' — ' + total + ' leads carregados ✅';
  })
  .catch(e => { document.getElementById('r').textContent = 'Fetch ERRO: ' + e.message; });
</script>
</body></html>`);
  } catch(e) { res.send('Erro Supabase: ' + e.message); }
});
app.get("/crm", async (req, res) => {
  try { res.json(await buscarLeadsCRM()); } catch (e) { res.json({}); }
});
app.post("/crm/mover", async (req, res) => {
  const { telefone, estagio } = req.body;
  if (!telefone || !estagio) return res.status(400).json({ erro: "Dados inválidos" });
  try { await atualizarEstagio(telefone, estagio); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get("/followups", async (req, res) => {
  try {
    const { data } = await supabase.from("followups").select("*").order("criado_em", { ascending: false }).limit(50);
    res.json({ followups: data || [] });
  } catch (e) { res.json({ followups: [] }); }
});
app.get("/testar-notificacao", async (req, res) => {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: "✅ Sarah funcionando!" } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});
app.get("/testar-alerta-api", async (req, res) => {
  // Rota de teste manual: simula um erro de crédito esgotado para
  // verificar se a notificação chega corretamente no WhatsApp.
  try {
    const erroFake = { response: { status: 400, data: { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } } } };
    ultimoAlertaApiFalha = 0; // força o envio ignorando o cooldown, só para este teste
    await notificarFalhaApiClaude(erroFake, "Teste manual via /testar-alerta-api");
    res.json({ ok: true, mensagem: "Alerta de teste enviado ao WhatsApp do consultor" });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});
app.get("/painel/pendentes", async (req, res) => {
  // Lista mensagens aguardando retry automático — útil para acompanhar
  // se ainda há clientes sem resposta por falha temporária da API.
  try {
    const { data } = await supabase.from("mensagens_pendentes").select("*").order("criado_em", { ascending: false }).limit(50);
    res.json({ pendentes: data || [] });
  } catch (e) { res.json({ pendentes: [], erro: e.message }); }
});
app.get("/testar-retry", async (req, res) => {
  // Força o job de retry a rodar agora, sem esperar os 5 minutos do timer.
  try {
    await processarMensagensPendentes();
    res.json({ ok: true, mensagem: "Job de retry executado manualmente" });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (body.object === "whatsapp_business_account") {
    // Eventos de STATUS de entrega (sent/delivered/read/failed) chegam num
    // campo diferente de "messages" — são notificações sobre mensagens que
    // NÓS enviamos, não mensagens novas de clientes. Processa isso para
    // permitir checar no painel se uma intervenção manual ou resposta da
    // Sarah foi de fato entregue/lida pelo cliente.
    const statusEvent = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    if (statusEvent) {
      const wamid = statusEvent.id;
      const status = statusEvent.status; // sent | delivered | read | failed
      let motivoErro = null;
      if (status === "failed" && statusEvent.errors?.length) {
        // A Meta inclui detalhes do motivo da falha (código + título) só
        // quando o status é "failed" — logamos isso explicitamente porque
        // sem essa informação, "failed" sozinho não diz se foi número
        // inválido, bloqueio do destinatário, janela de 24h fechada, etc.
        motivoErro = statusEvent.errors.map(e => `${e.code}: ${e.title}`).join(" | ");
        console.error(`[StatusEntrega] ❌ Falha em ${wamid}:`, motivoErro);
      }
      atualizarStatusEntrega(wamid, status, motivoErro).catch(() => {});
      return;
    }
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const msgId = msg.id;
    if (mensagensProcessadas.has(msgId)) return;
    mensagensProcessadas.add(msgId);
    setTimeout(() => mensagensProcessadas.delete(msgId), 60000);
    const from = msg.from;
    try {
      if (msg.type === "text") {
        const text = msg.text?.body;
        if (!text) return;
        console.log(`Texto de ${from}: ${text}`);
        await processarMensagemNaFila(from, text);
      } else if (msg.type === "audio") {
        const texto = await transcreverAudio(msg.audio.id);
        if (texto) await processarMensagemNaFila(from, `[Áudio]: ${texto}`);
        else await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: "Não consegui entender o áudio. Pode digitar?" } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
      } else if (msg.type === "image") {
        const caption = msg.image?.caption || "";
        if (!filaFotos[from]) filaFotos[from] = { analises: [], timer: null };
        if (filaFotos[from].timer) clearTimeout(filaFotos[from].timer);
        const analise = await analisarImagem(msg.image.id, caption, from);
        if (!filaFotos[from]) filaFotos[from] = { analises: [], timer: null };
        if (analise) filaFotos[from].analises.push(analise);
        filaFotos[from].timer = setTimeout(async () => {
          if (!filaFotos[from]) return;
          const analises = [...filaFotos[from].analises];
          delete filaFotos[from];
          if (analises.length > 0) await processarFotosAgrupadas(from, analises);
          else await processarMensagemNaFila(from, `[Cliente enviou foto${caption ? `: ${caption}` : ""}]`);
        }, 3000);
      }
    } catch (e) {
      console.error("Erro:", e.message);
      if (e.response) console.error("Detalhe:", JSON.stringify(e.response.data));
    }
  }
});

app.get("/registrar", async (req, res) => {
  try {
    const result = await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/register`,
      { messaging_product: "whatsapp", pin: process.env.WHATSAPP_REGISTER_PIN || "123456" },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.send("Registrado! " + JSON.stringify(result.data));
  } catch (e) { res.send("Erro: " + JSON.stringify(e.response?.data)); }
});

// ─────────────────────────────────────────────
// PAINEL CRM — PWA
// ─────────────────────────────────────────────

app.get("/painel", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const kanban = await buscarLeadsCRM();
    const pendente = descontoPendente;
    const estagios = [
      {id:'quente', label:'🔥 Quente', cor:'#ff6b35'},
      {id:'negociacao', label:'💬 Negociação', cor:'#f0a500'},
      {id:'aguardando', label:'⏳ Aguardando', cor:'#64b5f6'},
      {id:'visita_agendada', label:'📅 Visita', cor:'#81c784'},
      {id:'frio', label:'❄️ Frio', cor:'#90a4ae'},
      {id:'fechado', label:'✅ Fechado', cor:'#ce93d8'}
    ];
    let totalLeads = 0;
    estagios.forEach(e => { if (kanban[e.id]) totalLeads += kanban[e.id].length; });

    let colunasHtml = '';
    estagios.forEach(est => {
      const cards = kanban[est.id] || [];
      let cardsHtml = cards.length === 0
        ? '<p style="color:#444;font-size:11px;text-align:center;padding:10px">Vazio</p>'
        : cards.map(c => {
            const tel = String(c.telefone || '');
            const msg = String(c.ultimaMensagem || '').substring(0, 60);
            const vei = String(c.veiculo || '');
            const opcoesEstagio = estagios.map(e2 =>
              '<option value="' + e2.id + '"' + (e2.id === est.id ? ' selected' : '') + '>' + e2.label + '</option>'
            ).join('');
            // texto de busca: telefone, veículo e última mensagem, tudo em
            // minúsculas, sem acentuação especial, para o filtro de busca
            // no topo do painel encontrar o cliente por qualquer um desses
            // campos (ex: buscar "foto" acha quem mandou fotos recentemente)
            const textoBusca = (tel + ' ' + vei + ' ' + msg).toLowerCase().replace(/"/g, '');
            return '<div class="lead-card" data-busca="' + textoBusca + '" style="background:#161616;border:1px solid #222;border-radius:8px;padding:10px;margin-bottom:8px">' +
              '<div style="font-size:13px;font-weight:600;color:#fff">' + (c.formatado || tel) + '</div>' +
              (vei ? '<div style="font-size:11px;color:#f0a500;margin-top:3px">🚗 ' + vei + '</div>' : '') +
              '<div style="font-size:11px;color:#555;margin-top:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' + msg + '</div>' +
              '<div style="font-size:10px;color:#444;margin-top:3px">' + (c.tempoLabel || '') + '</div>' +
              '<div style="margin-top:8px;display:flex;gap:6px;align-items:center">' +
              '<a href="/painel/chat/' + tel + '" style="background:#1e2a1e;color:#81c784;padding:4px 10px;border-radius:5px;font-size:11px;text-decoration:none">💬 Chat</a>' +
              '<select onchange="moverLead(\'' + tel + '\', this.value)" style="background:#1a1a1a;color:#ccc;border:1px solid #2a2a2a;border-radius:5px;font-size:11px;padding:3px 4px;flex:1">' + opcoesEstagio + '</select>' +
              '</div></div>';
          }).join('');

      colunasHtml += '<div class="lead-coluna" style="min-width:220px;max-width:220px;background:#111;border-radius:10px;border-top:2px solid ' + est.cor + ';flex-shrink:0">' +
        '<div style="padding:10px 12px;border-bottom:1px solid #1a1a1a;display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-size:11px;font-weight:700;text-transform:uppercase;color:' + est.cor + '">' + est.label + '</span>' +
        '<span class="lead-contagem" style="font-size:11px;background:#1e1e1e;padding:1px 7px;border-radius:8px;color:#888">' + cards.length + '</span>' +
        '</div>' +
        '<div style="padding:8px;max-height:65vh;overflow-y:auto">' + cardsHtml + '</div>' +
        '</div>';
    });

    const html = '<!DOCTYPE html><html lang="pt-BR"><head>' +
      '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Sarah CRM</title>' +
      '<style>body{margin:0;font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0}' +
      'a{color:inherit}header{background:#111;border-bottom:1px solid #222;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0}' +
      '.dot{width:8px;height:8px;background:#4caf50;border-radius:50%;display:inline-block;margin-right:6px;animation:p 2s infinite}' +
      '@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}' +
      '.badge{background:#f0a500;color:#000;font-size:10px;padding:2px 7px;border-radius:8px;margin-left:6px;font-weight:700}' +
      '.board{display:flex;gap:12px;padding:14px;overflow-x:auto;-webkit-overflow-scrolling:touch}' +
      '</style></head><body>' +
      '<header>' +
      '<h1 style="font-size:16px;color:#fff;font-weight:700;margin:0">Sarah <span style="color:#f0a500">CRM</span>' +
      (pendente ? '<span class="badge">💰 1 desconto</span>' : '') + '</h1>' +
      '<div style="font-size:12px;color:#888"><span class="dot"></span>' + totalLeads + ' leads</div>' +
      '</header>' +
      '<div style="padding:10px 16px;background:#0f0f0f;border-bottom:1px solid #1a1a1a;display:flex;gap:10px">' +
      '<a href="/painel" style="color:#f0a500;font-size:12px;font-weight:600;text-decoration:none">📋 Pipeline</a>' +
      '<a href="/painel/lista" style="color:#888;font-size:12px;text-decoration:none">💬 Conversas</a>' +
      '</div>' +
      '<div style="padding:10px 16px;background:#0f0f0f;border-bottom:1px solid #1a1a1a">' +
      '<input type="text" id="busca-crm" placeholder="🔎 Buscar por telefone, veículo ou mensagem (ex: foto, argo, 9355...)" ' +
      'oninput="filtrarLeads(this.value)" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;color:#fff;padding:8px 10px;font-size:13px">' +
      '</div>' +
      '<div class="board">' + colunasHtml + '</div>' +
      '<script>' +
      'function moverLead(tel, novoEstagio) {' +
      '  fetch("/crm/mover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefone: tel, estagio: novoEstagio }) })' +
      '    .then(r => r.json())' +
      '    .then(d => { if (d.ok) location.reload(); else alert("Erro ao mover lead"); })' +
      '    .catch(() => alert("Erro de conexão ao mover lead"));' +
      '}' +
      'function filtrarLeads(termo) {' +
      '  var t = termo.toLowerCase().trim();' +
      '  var cards = document.querySelectorAll(".lead-card");' +
      '  cards.forEach(function(card) {' +
      '    var bate = !t || (card.getAttribute("data-busca") || "").indexOf(t) !== -1;' +
      '    card.style.display = bate ? "" : "none";' +
      '  });' +
      '  var colunas = document.querySelectorAll(".lead-coluna");' +
      '  colunas.forEach(function(col) {' +
      '    var visiveis = col.querySelectorAll(".lead-card:not([style*=\\"display: none\\"])").length;' +
      '    var contagem = col.querySelector(".lead-contagem");' +
      '    if (contagem) contagem.textContent = t ? visiveis : col.querySelectorAll(".lead-card").length;' +
      '  });' +
      '}' +
      '</script>' +
      '</body></html>';

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch(e) {
    res.send('<html><body style="background:#000;color:#f44;padding:20px;font-family:monospace">Erro: ' + e.message + '</body></html>');
  }
});


app.get("/painel/lista", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const conversas = await listarConversas();
    let itens = conversas.map(c => {
      const tel = String(c.from || '');
      const msg = String(c.ultimaMensagem || '').substring(0, 60);
      const hora = c.ultimaAtividade ? new Date(c.ultimaAtividade).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '';
      return '<a href="/painel/chat/' + tel + '" style="display:block;padding:12px 16px;border-bottom:1px solid #141414;text-decoration:none;' + (c.naoLida > 0 ? 'border-left:3px solid #f44336' : '') + '">' +
        '<div style="font-size:13px;font-weight:600;color:#fff">' + (c.formatado || tel) + (c.naoLida > 0 ? ' <span style="background:#f44336;color:#fff;font-size:10px;padding:1px 5px;border-radius:8px">' + c.naoLida + '</span>' : '') + '</div>' +
        '<div style="font-size:11px;color:#555;margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' + msg + '</div>' +
        '<div style="font-size:10px;color:#444;margin-top:2px">' + hora + '</div>' +
        '</a>';
    }).join('');

    const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversas — Sarah CRM</title>' +
      '<style>body{margin:0;font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0}a{color:inherit}' +
      'header{background:#111;border-bottom:1px solid #222;padding:12px 16px;position:sticky;top:0}' +
      '.tabs{padding:10px 16px;background:#0f0f0f;border-bottom:1px solid #1a1a1a;display:flex;gap:10px}</style></head><body>' +
      '<header><h1 style="font-size:16px;color:#fff;font-weight:700;margin:0">Sarah <span style="color:#f0a500">CRM</span></h1></header>' +
      '<div class="tabs"><a href="/painel" style="color:#888;font-size:12px;text-decoration:none">📋 Pipeline</a>' +
      '<a href="/painel/lista" style="color:#f0a500;font-size:12px;font-weight:600;text-decoration:none">💬 Conversas</a></div>' +
      (itens || '<p style="padding:20px;color:#555">Nenhuma conversa</p>') +
      '</body></html>';

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch(e) {
    res.send('<html><body style="background:#000;color:#f44;padding:20px">Erro: ' + e.message + '</body></html>');
  }
});

app.get("/painel/chat/:tel", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const tel = req.params.tel;
  const erro = req.query.erro;
  try {
    const mensagens = await buscarMensagens(tel);
    const numero = tel.replace(/\D/g, '');
    const formatado = numero.length >= 12 ? '(' + numero.slice(2,4) + ') ' + numero.slice(4,9) + '-' + numero.slice(9) : tel;

    let avisoErro = '';
    if (erro === 'janela24h') {
      avisoErro = '<div style="background:#3a1a00;color:#f0a500;padding:10px 14px;font-size:12px;border-bottom:1px solid #f0a500">⚠️ Não enviado: faz mais de 24h que o cliente não escreve. Use um template aprovado ou espere ele mandar mensagem.</div>';
    } else if (erro === '1') {
      avisoErro = '<div style="background:#3a0a0a;color:#f44336;padding:10px 14px;font-size:12px;border-bottom:1px solid #f44336">⚠️ Erro ao enviar a mensagem. Tente de novo.</div>';
    }

    let msgsHtml = mensagens.map(m => {
      const tipo = m.tipo || 'client';
      const texto = String(m.texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      const hora = m.criado_em ? new Date(m.criado_em).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '';
      const alinha = tipo === 'client' ? 'flex-start' : 'flex-end';
      const bg = tipo === 'client' ? '#1e1e1e' : tipo === 'sara' ? '#1a3a1a' : '#2a1a00';
      const cor = tipo === 'client' ? '#ddd' : tipo === 'sara' ? '#b8e6b8' : '#f0c060';
      const label = tipo === 'client' ? '👤 Cliente' : tipo === 'sara' ? '🤖 Sarah' : '⚡ Você';
      // Indicador de status só faz sentido para mensagens que NÓS enviamos
      // (sara/intervencao), não para mensagens do cliente.
      let statusIcone = '';
      if (tipo !== 'client' && m.wamid) {
        const statusMap = {
          enviado: { icone: '✓', cor: '#888', titulo: 'Enviado' },
          sent: { icone: '✓', cor: '#888', titulo: 'Enviado' },
          delivered: { icone: '✓✓', cor: '#888', titulo: 'Entregue' },
          read: { icone: '✓✓', cor: '#53bdeb', titulo: 'Lido' },
          failed: { icone: '❌', cor: '#f44336', titulo: 'Falhou' }
        };
        const s = statusMap[m.status_entrega] || statusMap.enviado;
        statusIcone = ' <span style="color:' + s.cor + '">' + s.icone + '</span>';
        if (m.status_entrega === 'failed' && m.motivo_erro) {
          // Mostra o motivo do erro como texto visível abaixo da mensagem
          // (tooltips via "title" não funcionam bem em navegadores móveis,
          // onde a maioria dos acessos ao painel acontece).
          statusIcone += '<div style="font-size:10px;color:#f44336;margin-top:2px">⚠️ ' + String(m.motivo_erro).replace(/</g,'&lt;') + '</div>';
        }
      }
      return '<div style="display:flex;justify-content:' + alinha + ';margin-bottom:8px">' +
        '<div style="max-width:82%">' +
        '<div style="font-size:9px;color:#555;margin-bottom:2px;text-align:' + (tipo==='client'?'left':'right') + '">' + label + '</div>' +
        '<div style="background:' + bg + ';color:' + cor + ';padding:8px 11px;border-radius:10px;font-size:13px;line-height:1.5">' + texto + '</div>' +
        '<div style="font-size:9px;color:#444;margin-top:2px;text-align:' + (tipo==='client'?'left':'right') + '">' + hora + statusIcone + '</div>' +
        '</div></div>';
    }).join('');

    const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + formatado + '</title>' +
      '<style>body{margin:0;font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0}' +
      'header{background:#111;border-bottom:1px solid #222;padding:10px 14px;display:flex;align-items:center;gap:10px;position:sticky;top:0}' +
      '.msgs{padding:12px;min-height:70vh}' +
      'form{position:sticky;bottom:0;background:#111;border-top:1px solid #1e1e1e;padding:10px 12px;display:flex;gap:8px}' +
      'textarea{flex:1;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;color:#fff;padding:8px;font-size:13px;height:44px;font-family:inherit;resize:none}' +
      'button{background:#f0a500;color:#000;border:none;border-radius:7px;padding:0 16px;font-size:13px;font-weight:700;cursor:pointer}</style></head><body>' +
      '<header>' +
      '<a href="/painel/lista" style="color:#f0a500;text-decoration:none;font-size:20px">←</a>' +
      '<div><div style="font-size:14px;font-weight:600">' + formatado + '</div></div>' +
      '</header>' +
      avisoErro +
      '<div class="msgs">' + (msgsHtml || '<p style="color:#555;text-align:center;padding:20px">Sem mensagens</p>') + '</div>' +
      '<form action="/painel/enviar" method="POST">' +
      '<input type="hidden" name="tel" value="' + tel + '">' +
      '<textarea name="texto" placeholder="Enviar como Sarah..."></textarea>' +
      '<button type="submit">→</button>' +
      '</form>' +
      '</body></html>';

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch(e) {
    res.send('<html><body style="background:#000;color:#f44;padding:20px">Erro: ' + e.message + '</body></html>');
  }
});

app.post("/painel/enviar", async (req, res) => {
  const { tel, texto } = req.body;
  console.log(`[Painel] Tentando enviar pra ${tel}: "${texto}"`);
  if (tel && texto) {
    try {
      const resp = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: tel, text: { body: texto } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`[Painel] ✅ Enviado! Resposta Meta:`, JSON.stringify(resp.data));
      const wamid = resp.data?.messages?.[0]?.id || null;
      if (!conversas[tel]) conversas[tel] = [];
      conversas[tel].push({ role: "assistant", content: texto });
      await salvarMensagem(tel, "intervencao", texto, wamid);
    } catch(e) {
      console.error("[Painel] ❌ Erro enviar:", e.message);
      if (e.response) console.error("[Painel] Detalhe Meta:", JSON.stringify(e.response.data));
      const codigoMeta = e.response?.data?.error?.code;
      // Código 131047 = fora da janela de 24h, precisa de template
      if (codigoMeta === 131047) {
        return res.redirect("/painel/chat/" + tel + "?erro=janela24h");
      }
      return res.redirect("/painel/chat/" + tel + "?erro=1");
    }
  } else {
    console.log(`[Painel] ⚠️ Dados faltando — tel: ${tel}, texto: ${texto}`);
  }
  res.redirect("/painel/chat/" + tel);
});


app.get("/painel/mensagens/:from", async (req, res) => {
  try { res.json({ mensagens: await buscarMensagens(req.params.from) }); } catch (e) { res.json({ mensagens: [] }); }
});
app.post("/painel/visualizar", (req, res) => {
  const { from } = req.body;
  if (from) conversasVisualizadas[from] = Date.now();
  res.json({ ok: true });
});
app.post("/painel/intervencao", async (req, res) => {
  const { from, texto } = req.body;
  if (!from || !texto) return res.status(400).json({ erro: "Dados inválidos" });
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: texto } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    if (!conversas[from]) conversas[from] = [];
    conversas[from].push({ role: "assistant", content: texto });
    await salvarMensagem(from, "intervencao", texto);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
app.post("/painel/aprendizado", async (req, res) => {
  const { situacao, correcao } = req.body;
  if (!situacao || !correcao) return res.status(400).json({ erro: "Dados inválidos" });
  try { await salvarAprendizado(situacao, correcao); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get("/painel/aprendizados", async (req, res) => {
  try { res.json({ aprendizados: await buscarAprendizados() }); } catch (e) { res.json({ aprendizados: [] }); }
});
app.get("/painel/simulacoes", async (req, res) => {
  try {
    const { data } = await supabase.from("simulacoes_credito").select("*").order("criado_em", { ascending: false }).limit(50);
    res.json({ simulacoes: data || [] });
  } catch (e) { res.json({ simulacoes: [] }); }
});
app.get("/painel/custo", async (req, res) => {
  try {
    // Janela: mês atual (do dia 1 até agora)
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);

    const { data: msgsCliente, count } = await supabase
      .from("mensagens")
      .select("id", { count: "exact" })
      .eq("tipo", "client")
      .gte("criado_em", inicioMes.toISOString());

    const totalMensagensCliente = count || 0;

    // Premissas de tokens médios por chamada (Sonnet resposta + Haiku extração)
    const SONNET_INPUT_TOKENS = 2000;  // system prompt + histórico
    const SONNET_OUTPUT_TOKENS = 150;
    const HAIKU_INPUT_TOKENS = 300;
    const HAIKU_OUTPUT_TOKENS = 50;

    const SONNET_INPUT_PRICE = 3.00;   // USD por milhão de tokens
    const SONNET_OUTPUT_PRICE = 15.00;
    const HAIKU_INPUT_PRICE = 0.80;
    const HAIKU_OUTPUT_PRICE = 4.00;

    const custoSonnetInput = (totalMensagensCliente * SONNET_INPUT_TOKENS / 1_000_000) * SONNET_INPUT_PRICE;
    const custoSonnetOutput = (totalMensagensCliente * SONNET_OUTPUT_TOKENS / 1_000_000) * SONNET_OUTPUT_PRICE;
    const custoHaikuInput = (totalMensagensCliente * HAIKU_INPUT_TOKENS / 1_000_000) * HAIKU_INPUT_PRICE;
    const custoHaikuOutput = (totalMensagensCliente * HAIKU_OUTPUT_TOKENS / 1_000_000) * HAIKU_OUTPUT_PRICE;

    const custoTotalUSD = custoSonnetInput + custoSonnetOutput + custoHaikuInput + custoHaikuOutput;
    const cotacaoUSDBRL = 5.50; // aproximada, atualizar conforme necessário

    res.json({
      periodo: `${inicioMes.toLocaleDateString("pt-BR")} até hoje`,
      mensagensClienteMes: totalMensagensCliente,
      custoEstimadoUSD: Number(custoTotalUSD.toFixed(2)),
      custoEstimadoBRL: Number((custoTotalUSD * cotacaoUSDBRL).toFixed(2)),
      observacao: "Estimativa baseada em tokens médios por mensagem. Valor real pode variar conforme tamanho do histórico e estoque."
    });
  } catch (e) {
    res.json({ erro: e.message, mensagensClienteMes: 0, custoEstimadoUSD: 0, custoEstimadoBRL: 0 });
  }
});
app.post("/painel/followup", async (req, res) => {
  const { from, motivo, dias } = req.body;
  if (!from || !motivo || !dias) return res.status(400).json({ erro: "Dados inválidos" });
  try { await agendarFollowUp(from, motivo, null, dias); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.post("/painel/resolver", async (req, res) => {
  const { from } = req.body;
  if (conversas[from]) delete conversas[from];
  if (from) conversasVisualizadas[from] = Date.now();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
