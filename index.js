https://raw.githubusercontent.com/abmagal1818-bit/agente-mensagens1/main/index.js
→ https://raw.githubusercontent.com/abmagal1818-bit/agente-mensagens1/main/index.js
Content-Type: text/plain; charset=utf-8

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const path = require("path");
const nodeCrypto = require("crypto");
const multer = require("multer");
const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const { createClient } = require("@supabase/supabase-js");
const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    // Guarda o body raw (bytes originais) para validação HMAC do webhook.
    // O HMAC é calculado sobre o payload exato que a Meta enviou, não sobre
    // o objeto JS parseado — JSON.stringify(req.body) pode diferir do original
    // em ordenação de chaves ou espaços, fazendo a assinatura não bater.
    req.rawBody = buf;
  }
}));
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
    return res.status(503).send("Acesso bloqueado: configure a variável de ambiente PAINEL_TOKEN no Render para habilitar o painel.");
  }
  const tokenQuery = req.query.token;
  const tokenCookie = (req.headers.cookie || "").split(";").map(c => c.trim()).find(c => c.startsWith(COOKIE_NOME_TOKEN + "="))?.split("=")[1];
  function tokenValido(t) {
    if (!t || t.length !== PAINEL_TOKEN.length) return false;
    try { return nodeCrypto.timingSafeEqual(Buffer.from(t), Buffer.from(PAINEL_TOKEN)); } catch { return false; }
  }
  if (tokenValido(tokenQuery) || tokenValido(tokenCookie)) {
    if (tokenValido(tokenQuery)) {
      res.setHeader("Set-Cookie", `${COOKIE_NOME_TOKEN}=${PAINEL_TOKEN}; Max-Age=${30 * 24 * 60 * 60}; Path=/; HttpOnly; Secure; SameSite=Lax`);
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

// ─────────────────────────────────────────────
// FUNÇÃO CENTRALIZADA DE ENVIO WHATSAPP (#12)
// ─────────────────────────────────────────────
// Antes, o padrão axios.post("https://graph.facebook.com/...") se repetia
// 15+ vezes com a mesma estrutura. Centralizar aqui garante logging,
// captura de wamid e tratamento de erro consistentes em todo o sistema.
async function enviarWhatsApp(telefone, corpo) {
  const resp = await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: telefone, ...corpo },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
  return resp.data;
}

async function enviarTexto(telefone, texto) {
  const data = await enviarWhatsApp(telefone, { text: { body: texto } });
  return data?.messages?.[0]?.id || null;
}

async function testarSupabase() {
  try {
    const { error } = await supabase.from("mensagens").select("count").limit(1);
    if (error) console.error("[Supabase] ❌ Erro:", error.message);
    else console.log("[Supabase] ✅ Conexão OK!");
  } catch (e) { console.error("[Supabase] ❌ Exceção:", e.message); }
}
testarSupabase();

// Migração única: preenche ultima_mensagem_cliente para clientes que já
// existiam antes desse campo ser adicionado, usando ultima_interacao como
// proxy. Sem isso, clientes antigos nunca entram no radar do followup
// mesmo que tenham sumido recentemente. Roda só uma vez na inicialização.
(async () => {
  try {
    const { data } = await supabase.from("clientes")
      .select("telefone, ultima_interacao")
      .is("ultima_mensagem_cliente", null)
      .not("ultima_interacao", "is", null)
      .limit(500);
    if (data?.length) {
      for (const cli of data) {
        await supabase.from("clientes").update({ ultima_mensagem_cliente: cli.ultima_interacao }).eq("telefone", cli.telefone);
      }
      console.log(`[Migração] ✅ ultima_mensagem_cliente preenchida para ${data.length} clientes`);
    }
  } catch (e) { console.error("[Migração] Erro:", e.message); }
})();

let estoqueAtual = [];
let ultimaAtualizacao = null;
const conversas = {};
const mensagensProcessadas = new Set();
const fipeCache = {};
let cacheMarcasFipe = null;
const filaFotos = {};
const ultimaNotificacao = {};
const conversasVisualizadas = {};
// Cache de contexto extraído por conversa — evita chamar Haiku toda mensagem.
// Invalidado quando o cliente menciona um veículo diferente ou carro de troca novo.
const cacheContextoConversa = {};
const ultimaMensagemCliente = {};

// Estado de coleta de dados para simulação de crédito
// Persistido no Supabase (tabela coleta_credito_pendente) desde que o
// risco de perda em reinício foi resolvido — igual já era feito para o
// desconto pendente. O objeto em memória continua existindo como cache
// rápido; a tabela é a fonte de verdade que sobrevive a reinícios.
const coletaCredito = {};

async function salvarColetaCreditoPendente(telefone, estado) {
  try {
    await supabase.from("coleta_credito_pendente").upsert({
      telefone, estado: JSON.stringify(estado), atualizado_em: new Date().toISOString()
    }, { onConflict: "telefone" });
  } catch (e) {
    console.error("[ColetaCredito] Erro ao persistir (tabela pode não existir ainda):", e.message);
  }
}

async function limparColetaCreditoPendente(telefone) {
  try {
    await supabase.from("coleta_credito_pendente").delete().eq("telefone", telefone);
  } catch (e) {
    console.error("[ColetaCredito] Erro ao limpar persistência:", e.message);
  }
}

// Carrega o estado da coleta do Supabase pra memória, se ainda não
// estiver lá — chamado no início do processamento de cada mensagem do
// cliente, pra sobreviver a reinícios do servidor no meio da coleta.
async function carregarColetaCreditoPendente(telefone) {
  if (coletaCredito[telefone]) return coletaCredito[telefone];
  try {
    const { data } = await supabase.from("coleta_credito_pendente").select("*").eq("telefone", telefone).limit(1);
    if (data && data.length > 0) {
      coletaCredito[telefone] = typeof data[0].estado === "string" ? JSON.parse(data[0].estado) : data[0].estado;
      console.log(`[ColetaCredito] Recuperado da persistência: ${telefone}`);
    }
  } catch (e) {
    // Tabela pode não existir ainda — não é crítico
  }
  return coletaCredito[telefone];
}

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
    const MAX_TENTATIVAS = 5;
    const { data: pendentes } = await supabase.from("mensagens_pendentes").select("*").order("criado_em", { ascending: true }).limit(20);
    if (!pendentes?.length) return;
    console.log(`[Retry] ${pendentes.length} mensagem(ns) pendente(s) para reprocessar`);
    for (const p of pendentes) {
      // Descarta mensagens que excederam o limite de tentativas — evita
      // loop infinito consumindo recursos indefinidamente para mensagens
      // que nunca vão conseguir ser processadas (ex: cliente bloqueou).
      if ((p.tentativas || 0) >= MAX_TENTATIVAS) {
        console.log(`[Retry] Descartando mensagem de ${p.telefone} após ${p.tentativas} tentativas`);
        await supabase.from("mensagens_pendentes").delete().eq("id", p.id);
        continue;
      }
      try {
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

// Limpa qualquer resposta da IA antes de enviar ao cliente — remove tags
// internas que porventura vazem ([Sistema:...], [instrução:...]) e headers
// Markdown (#, ##...), que o WhatsApp não renderiza e apareceriam como
// texto cru pro cliente (ex: "# Sarah - Premium Automarcas"). Usada em
// TODOS os pontos que mandam resposta gerada pela IA direto ao cliente —
// resposta principal, SIMULACAO, CONTRAPROPOSTA e AUTORIZO/NEGO — para
// que nenhum desses fluxos fique sem essa proteção.
function limparRespostaIA(texto) {
  return String(texto)
    .replace(/\[SOLICITAR_FOTOS:[^\]]*\]/gi, "")
    .replace(/\[Sistema:[^\]]*\]/gi, "")
    .replace(/\[instrução:[^\]]*\]/gi, "")
    .replace(/\[instruction:[^\]]*\]/gi, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    // WhatsApp usa *negrito* com UM asterisco, não **negrito** (Markdown
    // padrão). Com dois, o cliente vê os asteriscos literalmente na tela
    // em vez do texto em negrito. A IA usa **duplo** por hábito de
    // Markdown mesmo sem instrução — converte para o formato correto.
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .trim();
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

async function extrairContextoConversa(textos, ehSimples = false, from = null) {
  if (ehSimples) return { marcaTroca: null, modeloTroca: null, anoTroca: null, modeloBuscado: null, anoBuscado: null };
  // Cache por conversa: só rechama Haiku se o texto recente sugere novo veículo mencionado
  const textoRecente = textos.slice(-3).join(" ").toLowerCase();
  const cache = from ? cacheContextoConversa[from] : null;
  if (cache && !textoRecente.match(/\b(troca|trocar|vender|meu carro|minha|modelo|ano|[12][09]\d{2})\b/i)) {
    return cache;
  }
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
    const resultado = {
      marcaTroca: json.troca?.marca || null,
      modeloTroca: json.troca?.modelo || null,
      anoTroca: json.troca?.ano || null,
      modeloBuscado: json.busca?.modelo || null,
      anoBuscado: json.busca?.ano || null
    };
    if (from) cacheContextoConversa[from] = resultado;
    return resultado;
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
    // "sara_fotos" e "client_foto" guardam um JSON estruturado (modelo +
    // array de URLs de foto), não texto solto. Truncar em 500 chars corta
    // o JSON no meio de uma URL — o JSON.parse no painel falha e as
    // miniaturas somem, mostrando só um texto genérico no lugar, sem dar
    // pra confirmar visualmente se as fotos foram realmente enviadas.
    const tiposSemTruncamento = ["sara_fotos", "client_foto"];
    const textoFinal = tiposSemTruncamento.includes(tipo) ? String(texto) : String(texto).substring(0, 500);
    const { data, error } = await supabase.from("mensagens").insert({
      telefone, tipo, texto: textoFinal, wamid, status_entrega: wamid ? "enviado" : null
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
    // Trunca para evitar que uma extração malformada (ex: Claude/Haiku
    // "vazando" um trecho longo de texto em vez do nome do veículo) grave
    // uma string gigante nessa coluna — isso já quebrou o envio do template
    // de followup (erro 132005 "Translated text too long" na Meta, corpo
    // final passando de 1024 caracteres).
    if (veiculo) update.veiculo_interesse = String(veiculo).slice(0, 100);
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
    const vm = historico.match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid|cerato|cobalt|palio|asx|yaris|mobi|virtus|captur|tcross|t-cross|strada|s10|duster|kicks|spin|ecosport|fox|up|saveiro|montana|tiguan|bmw|mercedes|audi|honda|toyota|hyundai|kia|nissan|fiat|chevrolet|volkswagen|ford|renault|peugeot|citroen|mitsubishi|land rover|jeep|byd|dolphin|dolphin mini|haval|caoa chery|chery|jac|great wall|volvo|porsche|lexus|jaguar|ram|dodge/i);
    await agendarFollowUp(from, motivo, vm ? vm[0] : null, dias);
  } catch (e) { console.error("[FollowUp] Erro:", e.message); }
}

async function verificarClientesSumidos() {
  try {
    const agora = Date.now();
    // Verifica clientes em memória (mensagens recentes nesse ciclo de vida)
    for (const [telefone, ultima] of Object.entries(ultimaMensagemCliente)) {
      if (agora - ultima > 24 * 60 * 60 * 1000) {
        const { data } = await supabase.from("followups").select("id").eq("telefone", telefone).eq("enviado", false).limit(1);
        if (!data?.length) {
          const hist = (conversas[telefone] || []).map(m => m.content || "").join(" ").toLowerCase();
          const vm = hist.match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid|cerato|cobalt|palio|asx|yaris|mobi|virtus|captur|tcross|t-cross|strada|s10|duster|kicks|spin|ecosport|fox|up|saveiro|montana|tiguan|bmw|mercedes|audi|honda|toyota|hyundai|kia|nissan|fiat|chevrolet|volkswagen|ford|renault|peugeot|citroen|mitsubishi|land rover|jeep|byd|dolphin|dolphin mini|haval|caoa chery|chery|jac|great wall|volvo|porsche|lexus|jaguar|ram|dodge/i);
          let veiculoInteresse = vm ? vm[0] : null;
          // Se não achou no histórico, tenta pegar do campo veiculo_interesse da tabela clientes
          if (!veiculoInteresse) {
            const { data: cli } = await supabase.from("clientes").select("veiculo_interesse").eq("telefone", telefone).limit(1);
            veiculoInteresse = cli?.[0]?.veiculo_interesse || null;
          }
          await agendarFollowUp(telefone, "sumiu", veiculoInteresse, 5);
          await atualizarEstagio(telefone, "frio");
        }
        // Persiste o timestamp no banco para sobreviver reinícios
        try { await supabase.from("clientes").upsert({ telefone, ultima_mensagem_cliente: new Date(ultima).toISOString() }, { onConflict: "telefone" }); } catch (e) {}
        delete ultimaMensagemCliente[telefone];
      }
    }
    // Recupera do banco clientes que sumiram mas o servidor reiniciou antes de detectar
    const limite24h = new Date(agora - 24 * 60 * 60 * 1000).toISOString();
    const { data: clientesSumidosBanco } = await supabase
      .from("clientes")
      .select("telefone, ultima_mensagem_cliente, veiculo_interesse, estagio")
      .lt("ultima_mensagem_cliente", limite24h)
      .not("estagio", "in", '("fechado","frio")')
      .limit(20);
    if (clientesSumidosBanco?.length) {
      for (const cli of clientesSumidosBanco) {
        const { data: jaTemFollowup } = await supabase.from("followups").select("id").eq("telefone", cli.telefone).eq("enviado", false).limit(1);
        if (!jaTemFollowup?.length) {
          await agendarFollowUp(cli.telefone, "sumiu", cli.veiculo_interesse, 5);
          await atualizarEstagio(cli.telefone, "frio");
          console.log(`[FollowUp] Agendado (recuperado do banco): ${cli.telefone}`);
        }
        // Zera o campo para não reprocessar
        try { await supabase.from("clientes").update({ ultima_mensagem_cliente: null }).eq("telefone", cli.telefone); } catch (e) {}
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
    // Trunca cada parâmetro — a Meta rejeita o envio (erro 132005,
    // "Translated text too long") se o corpo final do template, já com os
    // parâmetros substituídos, passar de 1024 caracteres. Isso já aconteceu
    // com veiculo_interesse vindo grande demais do banco. 100 chars é bem
    // acima do necessário pra um nome de veículo e mantém margem segura.
    const components = parametros.length > 0 ? [{
      type: "body",
      parameters: parametros.map(p => ({ type: "text", text: String(p).slice(0, 100) }))
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
        // Não dispara followup fora do horário comercial — mensagem chegando
        // às 3h da manhã ou domingo cria má impressão e expectativa errada.
        if (!estaNoHorarioComercial()) {
          console.log(`[FollowUp] Adiado (fora do horário comercial): ${followup.telefone}`);
          continue;
        }
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
// HORÁRIO COMERCIAL (#7)
// ─────────────────────────────────────────────
// Fora do horário (seg-sáb 8h-18h, domingo fechado), a Sarah pode
// qualificar o cliente até CPF/fotos de avaliação, mas avisa que o
// consultor responde no próximo dia útil e não dispara followup automático.
function estaNoHorarioComercial() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const d = new Date(agora);
  const dia = d.getDay(); // 0=dom, 1=seg...6=sab
  const hora = d.getHours();
  if (dia === 0) return false; // domingo fechado
  if (dia === 6) return hora >= 8 && hora < 12; // sábado 8h-12h
  return hora >= 8 && hora < 18; // seg-sex 8h-18h
}

function avisoForaDoHorario() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const d = new Date(agora);
  const dia = d.getDay();
  if (dia === 0) return "nosso consultor retorna amanhã (segunda-feira) a partir das 8h";
  if (dia === 6) return "nosso consultor retorna na segunda-feira a partir das 8h";
  return "nosso consultor retorna amanhã a partir das 8h";
}



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
  } catch (e) {
    console.error(`[Notificação] Erro:`, e.message);
    const codigoMeta = e.response?.data?.error?.code;
    // Código 131047 = a janela de 24h desde a última mensagem do PRÓPRIO
    // consultor pro número da Sarah já fechou. Isso é diferente da janela
    // do cliente — é sobre o consultor não ter escrito pro número da Sarah
    // recentemente. Sem fallback, a notificação se perde silenciosamente
    // (o log mostrava erro, mas nada ficava visível pro consultor saber
    // que perdeu um alerta). Agora, em vez de tentar um template (que
    // exigiria aprovação nova na Meta), salva como alerta pendente que
    // fica visível no painel até ser conferido.
    if (codigoMeta === 131047) {
      try {
        await supabase.from("alertas_pendentes").insert({ texto: mensagem });
        console.log(`[Notificação] ⚠️ Alerta salvo como pendente (janela 24h fechada): ${formatado}`);
      } catch (e2) { console.error("[Notificação] Erro ao salvar alerta pendente:", e2.message); }
    }
  }
}

async function notificarCarroNaoDisponivel(from, modeloBuscado, infoCliente) {
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
  const linkWhatsApp = `https://wa.me/${numero}`;
  const mensagem = `🔍 *Solicitação de veículo não disponível*\nCliente: ${formatado}\nProcura: *${modeloBuscado}*\n${infoCliente ? `Mensagem: "${infoCliente.substring(0, 150)}"` : ""}\n\nFalar com cliente: ${linkWhatsApp}`;
  try {
    await enviarTexto(NUMERO_AUGUSTO, mensagem);
    console.log(`[Notificação] ✅ Carro não disponível notificado: ${modeloBuscado} de ${formatado}`);
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
    // Busca do Supabase (fotos permanentes do Storage, mesma fonte do site)
    const { data: veiculosSupabase, error } = await supabase
      .from("veiculos")
      .select("id, marca, modelo, versao, ano_fabricacao, ano_modelo, km, preco, descricao, fotos, cambio, combustivel, cor")
      .eq("status", "disponivel")
      .order("criado_em", { ascending: false });

    if (!error && veiculosSupabase?.length > 0) {
      estoqueAtual = veiculosSupabase.map(v => ({
        id: v.id,
        modelo: `${v.marca || ""} ${v.modelo || ""} ${v.versao || ""}`.trim(),
        ano: v.ano_modelo || v.ano_fabricacao,
        km: v.km,
        preco: v.preco,
        descricao: v.descricao || "",
        fotos: Array.isArray(v.fotos) ? v.fotos : [],
        cambio: v.cambio,
        combustivel: v.combustivel,
        cor: v.cor
      })).filter(v => v.modelo && v.preco);

      ultimaAtualizacao = new Date().toLocaleString("pt-BR");
      console.log(`[Estoque] ✅ ${estoqueAtual.length} veículos do Supabase | ${ultimaAtualizacao}`);
      return;
    }
    if (error) console.error("[Estoque] Erro Supabase:", error.message);
  } catch (e) {
    console.error("[Estoque] Exceção Supabase:", e.message);
  }

  // Fallback: Instagram
  try {
    const veiculos = await buscarEstoqueInstagram();
    if (veiculos.length > 0) {
      estoqueAtual = veiculos;
      ultimaAtualizacao = new Date().toLocaleString("pt-BR");
      console.log(`[Estoque] ✅ ${veiculos.length} veículos do Instagram (fallback) | ${ultimaAtualizacao}`);
    }
  } catch (e) { console.error("[Estoque] Erro Instagram:", e.message); }
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
  // Antes exigia frase EXATAMENTE igual a uma dessas ("quero sim"), então
  // "Bom dia ótimo quero sim" não era reconhecida como confirmação — a
  // Sarah nunca detectava o pedido, mas mesmo assim "confirmava" o envio
  // de fotos que nunca aconteceu. Agora aceita a confirmação em qualquer
  // mensagem curta que contenha uma dessas palavras (limite de tamanho
  // evita falso positivo em mensagens longas não relacionadas).
  const ehConfirmacaoCurta = t.length <= 30 && confirmacoesSimples.some(p => t === p || t.includes(p));
  if (ehConfirmacaoCurta && ultimaResposta.toLowerCase().includes("foto")) return true;
  const naoEPedido = ["te mando", "vou mandar", "vou te mandar", "ja mando", "já mando", "mando agora", "mandando foto", "vou enviar", "to mandando", "tô mandando"];
  if (naoEPedido.some(p => t.includes(p))) return false;
  const ePedido = [
    "tem foto", "tem fotos", "manda foto", "manda as foto", "pode mandar foto",
    "me manda foto", "me passa foto", "quero ver foto", "quero ver as foto",
    "me mostra", "posso ver", "foto dele", "fotos dele", "vai mandar as fotos",
    "as fotos", "quero foto", "quero as foto", "manda as fotos", "me manda as foto",
    "quero ver", "me mostra as foto", "me mostra as fotos", "ver as fotos",
    "ver as foto", "pode mandar as foto", "pode mandar as fotos",
    // Variações com erros de digitação comuns (ex: "queto" por "quero")
    "queto foto", "queto as foto", "queto ver", "quer foto", "quer as foto",
    "manda imagem", "me manda imagem", "tem imagem", "ver imagem",
    // Pedidos de fotos específicas (internas, externas, detalhes)
    "tem interna", "tem internas", "foto interna", "fotos interna",
    "foto do interior", "interior", "foto do painel", "foto dos bancos",
    "foto da frente", "foto de tras", "foto de trás", "mais foto", "mais fotos",
    "outras foto", "outras fotos", "ver mais"
  ];
  // Pedidos de fotos adicionais/específicas ignoram o bloqueio de jaEnviouFotos
  const ePedidoAdicional = ["tem interna", "tem internas", "mais foto", "mais fotos", "outras foto", "outras fotos", "ver mais", "interior", "foto do painel", "foto dos bancos"];
  if (ePedidoAdicional.some(p => t.includes(p))) return "adicional";
  return ePedido.some(p => t.includes(p));
}

function encontrarVeiculoNoContexto(texto, historicoConversa, estoque) {
  const mensagensRecentes = [
    { role: "user", content: texto },
    ...(historicoConversa || []).slice().reverse()
  ];

  function pontuarVeiculo(v, textoAlvo) {
    const modelo = limparTexto(v.modelo || "").toLowerCase();
    const palavrasModelo = modelo.split(/\s+/).filter(p => p.length >= 3 && !/^\d+([.,]\d+)?$/.test(p));
    if (!palavrasModelo.length) return 0;
    let score = palavrasModelo.filter(p => textoAlvo.includes(p)).length;
    if (v.ano && textoAlvo.includes(String(v.ano))) score += 1;
    return score;
  }

  // Passo 1: procura nas mensagens mais recentes (match forte, >= 2 palavras)
  for (const msg of mensagensRecentes.slice(0, 12)) {
    const textoMsg = (msg.content || "").toLowerCase();
    if (!textoMsg.trim()) continue;
    let melhorMatch = null, melhorScore = 0;
    for (const v of estoque) {
      const score = pontuarVeiculo(v, textoMsg);
      if (score > melhorScore) { melhorScore = score; melhorMatch = v; }
    }
    if (melhorMatch && melhorScore >= 2) return melhorMatch;
  }

  // Passo 2: fallback — só usa se encontrar match forte (>=2) em qualquer
  // mensagem do histórico. Removemos o fallback de score=1 que causava
  // falsos positivos (ex: cliente pede "mais fotos" sem mencionar o carro
  // e o sistema pega um veículo aleatório que tem uma palavra em comum).
  // Se não encontrar match forte, retorna null para a Sarah perguntar
  // qual veículo o cliente quer ver, em vez de mandar fotos erradas.
  const todosTextos = mensagensRecentes.map(m => (m.content || "").toLowerCase()).join(" ");
  let melhorMatchGeral = null, melhorScoreGeral = 0;
  for (const v of estoque) {
    const score = pontuarVeiculo(v, todosTextos);
    if (score > melhorScoreGeral) { melhorScoreGeral = score; melhorMatchGeral = v; }
  }
  if (melhorMatchGeral && melhorScoreGeral >= 2) return melhorMatchGeral;

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
  const fotos = (veiculo.fotos || []).slice(0, 10);
  if (!fotos.length) return false;
  let sucessos = 0;
  const fotosEnviadas = [];
  for (const url of fotos) {
    try {
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to, type: "image", image: { link: url } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      sucessos++;
      fotosEnviadas.push(url);
      await new Promise(r => setTimeout(r, 600));
    } catch (e) { console.error(`Erro foto: ${e.message}`); }
  }
  console.log(`[Fotos] Enviadas: ${sucessos}/${fotos.length}`);
  // Salva as URLs no Supabase para exibir no painel de chat
  if (fotosEnviadas.length > 0) {
    await salvarMensagem(to, "sara_fotos", JSON.stringify({
      modelo: limparTexto(veiculo.modelo || ""),
      fotos: fotosEnviadas
    }));
  }
  return sucessos > 0;
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

function formatarEstoque(modeloFiltro = null) {
  if (!estoqueAtual.length) return "Estoque sendo carregado.";
  // Se há um modelo específico mencionado, filtra só os veículos relevantes
  // e inclui a descrição completa — reduz tokens em ~80% nas mensagens
  // genéricas e garante dados completos quando o cliente menciona um carro.
  if (modeloFiltro) {
    const termos = modeloFiltro.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    const relevantes = estoqueAtual.filter(v => {
      const modelo = limparTexto(v.modelo || "").toLowerCase();
      return termos.some(t => modelo.includes(t));
    });
    const lista = relevantes.length > 0 ? relevantes : estoqueAtual;
    return lista.map(v => {
      const cabecalho = `${limparTexto(v.modelo || "")} ${v.ano || ""} - ${Number(v.km || 0).toLocaleString("pt-BR")} km - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`;
      const descricaoCompleta = limparTexto(v.descricao || "").substring(0, 500);
      return descricaoCompleta ? `${cabecalho}\n  Detalhes do anúncio: ${descricaoCompleta}` : cabecalho;
    }).join("\n\n");
  }
  // Sem filtro: lista compacta sem descrição (economiza ~15k tokens por mensagem)
  return estoqueAtual.map(v =>
    `${limparTexto(v.modelo || "")} ${v.ano || ""} - ${Number(v.km || 0).toLocaleString("pt-BR")} km - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`
  ).join("\n");
}

const SYSTEM_PROMPT = (fipeInfo, aprendizadosExtra = "", carroNaoDisponivel = null, descontoPendenteAtivo = false, veiculosAmbiguos = null, modeloMencionado = null) => {
  const agora = new Date();
  const dataHoraAtual = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return `Você é Sarah, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

DATA E HORA ATUAL: ${dataHoraAtual} (horário de Porto Alegre/RS)
- Use essa informação para saber se é manhã, tarde, noite, ou outro dia.
- Se um compromisso combinado anteriormente (ex: "vir de manhã") já passou do horário, NÃO repita a mesma combinação como se ainda fosse válida — pergunte se ainda está de pé ou se precisa reagendar.
- Nunca presuma que "hoje" na conversa atual é o mesmo dia de mensagens antigas do histórico sem checar a data.

EMPRESA: Av. Aparício Borges, 931 | Seg-Sex 8h-18h, Sáb 8h-12h | Consultor: (51) 99364-2476
FINANCEIRAS: Trabalhamos com BV, Santander, Itaú, Bradesco, C6, Daycoval e Pan. Quando o cliente perguntar sobre bancos ou financeiras, informe essas opções diretamente — mesmo que esteja no meio da coleta de dados de crédito. Responda a pergunta e depois continue a coleta naturalmente.

${!estaNoHorarioComercial() ? `⚠️ FORA DO HORÁRIO COMERCIAL: Você pode continuar atendendo e qualificando o cliente normalmente (perguntar sobre veículo, coletar dados para simulação, pedir fotos do carro de troca), mas ao final de cada resposta avise de forma natural que "${avisoForaDoHorario()}" para dar a resposta definitiva. Se o cliente fornecer dados de CPF para simulação, diga que os dados foram recebidos e que o consultor vai processar a simulação e retornar no próximo horário comercial. Não prometa coisas que dependem do consultor (preço especial, autorização de desconto, simulação aprovada) para entregar agora.` : ""}

HISTÓRICO DO VEÍCULO: Quando o cliente perguntar sobre batidas, sinistros, histórico ou procedência, responda que o veículo não consta com histórico de batidas ou sinistros — A MENOS que isso esteja explicitamente descrito na descrição do anúncio. Nunca invente problemas que não estão no anúncio, mas também nunca afirme garantias que não pode dar (como "nunca bateu" — use "não consta histórico de sinistros"). Para mais detalhes, ofereça vistoria presencial ou consulta ao histórico via Detran/Fipe.

PERFIL: Simpática, descontraída e profissional. Máximo 4 linhas por resposta — exceto quando precisar listar opções ou responder perguntas que exijam mais detalhes. NUNCA repita a saudação após a primeira mensagem. SEMPRE mantenha o contexto da conversa. NUNCA faça a mesma pergunta duas vezes — se você já perguntou algo (ex: "vai dar carro na troca?", "vai financiar ou à vista?") e o cliente não respondeu ainda, NÃO repita essa pergunta na próxima mensagem. Avance a conversa com outra informação ou pergunta diferente. Se o cliente demonstrar irritação, impaciência ou desistência durante qualquer processo (incluindo coleta de dados), reconheça e adapte — nunca insista mecanicamente no próximo passo.

REGRA CRÍTICA — NUNCA MENCIONAR NOMES: Nunca cite "Augusto" ou qualquer nome pessoal. Use sempre "nosso consultor" ou "nossa equipe".

REGRA CRÍTICA — NÃO ATENDE LIGAÇÕES: Este é um número de WhatsApp Business (API), não uma linha telefônica normal — NÃO recebe chamadas de voz nem chamadas de WhatsApp. NUNCA diga "pode me ligar", "pode ligar sim", "sem problema" ou qualquer frase que sugira que você atende ligações. Se o cliente disser que ligou e não conseguiu, ou perguntar se pode ligar, explique com naturalidade que esse número só atende por mensagem de texto/áudio aqui pelo WhatsApp, e que para falar direto por voz ele pode ligar para o consultor: (51) 99364-2476. Isso vale mesmo se a mensagem parecer ser de alguém que não é um cliente comum (ex: outro vendedor, prestador de serviço, ou mensagem endereçada a outro nome) — nunca ofereça ou confirme uma ligação de voz com você.

ESTOQUE ATUAL (${ultimaAtualizacao || "carregando..."}):
${formatarEstoque(modeloMencionado)}

🚨 REGRA CRÍTICA DE PREÇOS — ABSOLUTA, SEM EXCEÇÕES:
- Use EXATAMENTE os preços do estoque acima, caractere por caractere. NUNCA invente, estime, arredonde ou "lembre de cabeça" um valor.
- Antes de escrever qualquer preço na resposta, releia a linha exata do estoque correspondente ao veículo. Copie o valor dali.
- Se o veículo mencionado pelo cliente NÃO aparecer claramente no estoque acima, NÃO cite nenhum valor — diga que vai confirmar com a equipe.
- Se você não tiver 100% de certeza de qual linha do estoque corresponde ao veículo, pergunte para o cliente confirmar o modelo/ano em vez de chutar um preço aproximado.
- JAMAIS informe um preço diferente do que está listado acima, mesmo que pareça "razoável" ou "parecido" com outros veículos.

🚨 REGRA CRÍTICA — NUNCA INVENTE VEÍCULOS QUE NÃO ESTÃO NO ESTOQUE:
- O estoque listado acima é COMPLETO e DEFINITIVO. Se uma marca ou modelo não aparece nessa lista, NÃO EXISTE na loja neste momento.
- Quando o cliente perguntar por uma marca/modelo que NÃO está no estoque, NUNCA invente modelos, preços ou disponibilidade. Em vez disso, diga que vai verificar com a equipe e que o consultor vai entrar em contato — o sistema vai notificar o consultor automaticamente.
- VARIAÇÕES DE NOMES: clientes frequentemente usam nomes abreviados ou alternativos. "BYD mini", "Dolphin", "BYD Dolphin" e "Dolphin Mini" são o mesmo veículo. "Onix" pode ser "Onix Sedan" ou "Onix Plus". Antes de dizer que não tem, procure no estoque por variações do nome.
- Exemplo correto: Cliente pergunta "tem BMW?" → "No momento não estou vendo BMW no nosso estoque, mas vou verificar com nossa equipe se temos alguma chegando! Nosso consultor vai te contatar em breve. Posso te mostrar outras opções enquanto isso?"
- Exemplo ERRADO: Inventar "BMW 320i 2019 por R$ 89.990" que não existe no estoque.

🚨 REGRA CRÍTICA — NUNCA INVENTE O MODELO DO VEÍCULO DO CLIENTE:
- Quando o cliente estiver descrevendo o carro QUE ELE QUER DAR NA TROCA, NUNCA atribua um nome de modelo que ele não disse explicitamente.
- Se o cliente disser algo ambíguo como "minha 2006" ou só o ano/motorização sem nome do modelo, NÃO adivinhe nem complete com um modelo do seu conhecimento geral (ex: não vá dizer "Meriva", "Gol", etc. por palpite).
- Nesse caso, pergunte diretamente: "qual é o modelo do seu carro?" antes de continuar a avaliação.
- Só repita/confirme o nome de um modelo se o cliente já tiver escrito esse nome em uma mensagem anterior da própria conversa.

🚨 REGRA CRÍTICA — NUNCA INVENTE CARACTERÍSTICAS TÉCNICAS DO VEÍCULO:
- Cada veículo no estoque acima tem uma linha "Detalhes do anúncio" com as informações REAIS daquele carro específico (opcionais, condição, etc.).
- Transmissão (manual/automático), opcionais (ar-condicionado, vidro elétrico, etc.), e qualquer outra caracte