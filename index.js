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
const cacheContextoConversa = {};
const ultimaMensagemCliente = {};

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

async function carregarColetaCreditoPendente(telefone) {
  if (coletaCredito[telefone]) return coletaCredito[telefone];
  try {
    const { data } = await supabase.from("coleta_credito_pendente").select("*").eq("telefone", telefone).limit(1);
    if (data && data.length > 0) {
      coletaCredito[telefone] = typeof data[0].estado === "string" ? JSON.parse(data[0].estado) : data[0].estado;
      console.log(`[ColetaCredito] Recuperado da persistência: ${telefone}`);
    }
  } catch (e) {
  }
  return coletaCredito[telefone];
}

let descontoPendente = null;

const filaProcessamento = {};

async function processarMensagemNaFila(from, text, tentativasAnteriores = 0) {
  const anterior = filaProcessamento[from] || Promise.resolve();
  const atual = anterior
    .catch(() => {})
    .then(() => processarMensagem(from, text, tentativasAnteriores));
  filaProcessamento[from] = atual;
  return atual;
}

let ultimoAlertaApiFalha = 0;
const COOLDOWN_ALERTA_API = 15 * 60 * 1000;

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

const MAX_TENTATIVAS_PENDENTE = 6;

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

setInterval(processarMensagensPendentes, 5 * 60 * 1000);

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

function limparRespostaIA(texto) {
  return String(texto)
    .replace(/\[SOLICITAR_FOTOS:[^\]]*\]/gi, "")
    .replace(/\[Sistema:[^\]]*\]/gi, "")
    .replace(/\[instrução:[^\]]*\]/gi, "")
    .replace(/\[instruction:[^\]]*\]/gi, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .trim();
}

function detectarInteresseFinanciamento(texto, historicoConversa) {
  const t = texto.toLowerCase();
  const frases = [
    "preciso financiar", "quero financiar", "consigo financiar",
    "tenho crédito", "tenho credito", "será que consigo crédito",
    "será que consigo credito", "consigo parcelar", "vai dar pra financiar",
    "tem como financiar", "tem credito", "tem crédito",
    "fazer financiamento", "simular financiamento", "simular crédito",
    "simular credito", "ver se aprova", "ver se passa", "análise de crédito",
    "analise de credito", "consultar meu nome", "consultar meu cpf",
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
  if (/^(\d)\1{10}$/.test(cpf)) return null;
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
  const temPropostaDireta = /\d{2,}\s*(mil|k)?\s*(a|à)\s*vista/i.test(t);
  const temOferta = /ofereci\s+\d|ofereço\s+\d|proponho\s+\d/.test(t);
  return (temFrase && temValor) || temPropostaDireta || temOferta || /em [5-9]\d/.test(t);
}

let avaliacaoPendente = null;

async function salvarAvaliacaoPendente(telefone, info) {
  avaliacaoPendente = { telefone, info, timestamp: Date.now() };
  try {
    await supabase.from("avaliacoes_pendentes").delete().neq("telefone", "");
    await supabase.from("avaliacoes_pendentes").insert({ telefone, info: JSON.stringify(info) });
  } catch (e) {
    console.error("[Avaliação] Erro ao persistir (tabela pode não existir ainda):", e.message);
  }
}

async function limparAvaliacaoPendente() {
  avaliacaoPendente = null;
  try {
    await supabase.from("avaliacoes_pendentes").delete().neq("telefone", "");
  } catch (e) {
    console.error("[Avaliação] Erro ao limpar persistência:", e.message);
  }
}

async function carregarAvaliacaoPendente() {
  if (avaliacaoPendente) return avaliacaoPendente;
  try {
    const { data } = await supabase.from("avaliacoes_pendentes").select("*").limit(1);
    if (data && data.length > 0) {
      avaliacaoPendente = {
        telefone: data[0].telefone,
        info: typeof data[0].info === "string" ? JSON.parse(data[0].info) : data[0].info,
        timestamp: new Date(data[0].criado_em || Date.now()).getTime()
      };
    }
  } catch (e) {
    console.error("[Avaliação] Erro ao carregar persistência:", e.message);
  }
  return avaliacaoPendente;
}

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
  }
  return descontoPendente;
}

async function processarDesconto(from, texto, historicoConversa) {
  await carregarDescontoPendente();
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

    await salvarDescontoPendente(from, info);

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

async function extrairContextoConversa(textos, ehSimples = false, from = null) {
  if (ehSimples) return { marcaTroca: null, modeloTroca: null, anoTroca: null, modeloBuscado: null, anoBuscado: null };
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

async function salvarMensagem(telefone, tipo, texto, wamid = null) {
  try {
    console.log(`[Supabase] Salvando: ${telefone} | ${tipo}`);
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

async function atualizarEstagio(telefone, estagio, veiculo = null) {
  try {
    const update = { telefone, estagio, ultima_interacao: new Date().toISOString() };
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
      await agendarFollowUpHoras(from, "visita_nao_confirmada", veiculo, 2);
    }
    return;
  }
  if (hist.includes("parcela") || hist.includes("simulação") || hist.includes("financiar") || hist.includes("na troca") || hist.includes("fotos")) { await atualizarEstagio(from, "negociacao"); return; }
  if (t.includes("não tenho interesse") || t.includes("desisti") || t.includes("esquece")) { await atualizarEstagio(from, "frio"); return; }
  if (t.includes("vou pensar") || t.includes("vou falar") || t.includes("vou consultar") || t.includes("retorno")) { await atualizarEstagio(from, "aguardando"); return; }
  const { data } = await supabase.from("clientes").select("estagio").eq("telefone", from).limit(1);
  const estagioAtual = data?.[0]?.estagio;
  // Antes só marcava "quente" se o cliente nunca tivesse tido estágio salvo.
  // Isso deixava um lead "frio" (por reativação/sumiço) preso nesse estágio
  // pra sempre, mesmo depois de voltar a responder com algo comum ("oi",
  // "bom dia") — e também impedia a régua de reativação de cancelar
  // corretamente, já que ela depende desse estágio. Agora, se o cliente
  // estava "frio" e mandou algo que não caiu em nenhuma regra de recusa
  // acima, ele volta pra "quente".
  if (!estagioAtual || estagioAtual === "frio") await atualizarEstagio(from, "quente");
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

// Parâmetro "nivel" (default 1) suporta a régua de reativação em múltiplos
// toques (D+2 / D+4 / D+7) para leads que pararam de responder (motivo
// "sumiu"). Os demais motivos continuam com disparo único, como antes.
// O update de "enviado" agora filtra por motivo também — sem isso, agendar
// o nível 2 de "sumiu" cancelaria por engano um follow-up pendente de outro
// motivo (ex: "achou_caro") para o mesmo cliente.
async function agendarFollowUp(telefone, motivo, veiculoInteresse, diasAguardar, nivel = 1) {
  try {
    const agendadoPara = new Date();
    agendadoPara.setDate(agendadoPara.getDate() + diasAguardar);
    await supabase.from("followups").update({ enviado: true }).eq("telefone", telefone).eq("enviado", false).eq("motivo", motivo);
    const { error } = await supabase.from("followups").insert({
      telefone, motivo, veiculo_interesse: veiculoInteresse,
      agendado_para: agendadoPara.toISOString(), enviado: false, nivel
    });
    if (!error) console.log(`[FollowUp] Agendado: ${telefone} em ${diasAguardar}d — ${motivo} (nível ${nivel})`);
    else console.error(`[FollowUp] Erro ao agendar (coluna "nivel" existe na tabela followups?):`, error.message);
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
    for (const [telefone, ultima] of Object.entries(ultimaMensagemCliente)) {
      if (agora - ultima > 24 * 60 * 60 * 1000) {
        const { data } = await supabase.from("followups").select("id").eq("telefone", telefone).eq("enviado", false).limit(1);
        if (!data?.length) {
          const hist = (conversas[telefone] || []).map(m => m.content || "").join(" ").toLowerCase();
          const vm = hist.match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid|cerato|cobalt|palio|asx|yaris|mobi|virtus|captur|tcross|t-cross|strada|s10|duster|kicks|spin|ecosport|fox|up|saveiro|montana|tiguan|bmw|mercedes|audi|honda|toyota|hyundai|kia|nissan|fiat|chevrolet|volkswagen|ford|renault|peugeot|citroen|mitsubishi|land rover|jeep|byd|dolphin|dolphin mini|haval|caoa chery|chery|jac|great wall|volvo|porsche|lexus|jaguar|ram|dodge/i);
          let veiculoInteresse = vm ? vm[0] : null;
          if (!veiculoInteresse) {
            const { data: cli } = await supabase.from("clientes").select("veiculo_interesse").eq("telefone", telefone).limit(1);
            veiculoInteresse = cli?.[0]?.veiculo_interesse || null;
          }
          // Régua de reativação: nível 1 dispara em D+2. Se o cliente não
          // responder, processarFollowUpsPendentes encadeia os próximos
          // níveis (D+4 e D+7) automaticamente.
          await agendarFollowUp(telefone, "sumiu", veiculoInteresse, 2, 1);
          await atualizarEstagio(telefone, "frio");
        }
        try { await supabase.from("clientes").upsert({ telefone, ultima_mensagem_cliente: new Date(ultima).toISOString() }, { onConflict: "telefone" }); } catch (e) {}
        delete ultimaMensagemCliente[telefone];
      }
    }
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
          await agendarFollowUp(cli.telefone, "sumiu", cli.veiculo_interesse, 2, 1);
          await atualizarEstagio(cli.telefone, "frio");
          console.log(`[FollowUp] Agendado (recuperado do banco): ${cli.telefone}`);
        }
        try { await supabase.from("clientes").update({ ultima_mensagem_cliente: null }).eq("telefone", cli.telefone); } catch (e) {}
      }
    }
  } catch (e) { console.error("[FollowUp] Erro sumidos:", e.message); }
}

setInterval(verificarClientesSumidos, 60 * 60 * 1000);

const TEMPLATE_FOLLOWUP = process.env.TEMPLATE_FOLLOWUP_NAME || "followup_generico";

// Dias de espera até o PRÓXIMO nível da régua de reativação, contados a
// partir do envio do nível atual. Nível 1 (D+2) é agendado em
// verificarClientesSumidos(); daqui pra frente: nível 1→2 espera mais 2
// dias (chegando a D+4 total), nível 2→3 espera mais 3 dias (D+7 total).
// Depois do nível 3, a régua para — o lead fica "frio" sem novo disparo.
const DIAS_PROXIMO_NIVEL = { 1: 2, 2: 3 };
const NIVEL_MAXIMO_REATIVACAO = 3;

async function enviarMensagemTemplate(telefone, nomeTemplate, parametros = []) {
  try {
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
    const nivel = followup.nivel || 1;
    // Mensagens de "sumiu" variam de tom conforme o nível da régua — nível
    // 1 (D+2) é leve, nível 2 (D+4) traz um gatilho de valor/disponibilidade,
    // nível 3 (D+7) é a última tentativa antes de encerrar a régua.
    const promptsSumiu = {
      1: `Você é Sarah, vendedora da Premium Automarcas. Cliente parou de responder sobre ${veiculo} há poucos dias. Mensagem curta e leve para retomar, sem cobrar. Máximo 2 linhas.`,
      2: `Você é Sarah, vendedora da Premium Automarcas. Cliente sumiu depois de demonstrar interesse no ${veiculo}. Mencione que o carro ainda está disponível e pergunte se ainda tem interesse. Máximo 3 linhas.`,
      3: `Você é Sarah, vendedora da Premium Automarcas. Última tentativa de retomar contato sobre o ${veiculo} — cliente sumiu há mais de uma semana. Pergunte de forma direta e educada se ainda tem interesse, para não insistir mais se não tiver. Máximo 2 linhas.`
    };
    const prompts = {
      vai_pensar: `Você é Sarah, vendedora da Premium Automarcas. Cliente interessado em ${veiculo} disse que ia pensar. Mensagem curta e calorosa, sem pressionar. Máximo 3 linhas.`,
      achou_caro: `Você é Sarah, vendedora da Premium Automarcas. Cliente achou ${veiculo} caro. Pergunte qual parcela cabe no orçamento. Máximo 3 linhas.`,
      avaliacao_baixa: `Você é Sarah, vendedora da Premium Automarcas. Cliente insatisfeito com avaliação na troca. Reforce que avaliação presencial pode surpreender. Máximo 3 linhas.`,
      sem_interesse: `Você é Sarah, vendedora da Premium Automarcas. Cliente sem interesse. Mensagem muito leve. Máximo 2 linhas.`,
      sumiu: promptsSumiu[nivel] || promptsSumiu[1],
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
      if (followup.motivo === "visita_nao_confirmada") {
        const { data: clienteAtual } = await supabase.from("clientes").select("estagio").eq("telefone", followup.telefone).limit(1);
        if (clienteAtual?.[0]?.estagio !== "visita_agendada") {
          await supabase.from("followups").update({ enviado: true }).eq("id", followup.id);
          console.log(`[FollowUp] Cancelado (estágio mudou): ${followup.telefone}`);
          continue;
        }
      }
      // Para a régua de reativação (motivo "sumiu"): cancela se o cliente já
      // respondeu depois que este nível foi agendado. Usa
      // ultima_mensagem_cliente (mais confiável que "estagio", que só sai de
      // "frio" em certas frases específicas) comparado com a criação deste
      // follow-up.
      if (followup.motivo === "sumiu") {
        const { data: clienteAtualSumiu } = await supabase.from("clientes").select("estagio, ultima_mensagem_cliente").eq("telefone", followup.telefone).limit(1);
        const cliSumiu = clienteAtualSumiu?.[0];
        const respondeuDepois = cliSumiu?.ultima_mensagem_cliente && followup.criado_em &&
          new Date(cliSumiu.ultima_mensagem_cliente).getTime() > new Date(followup.criado_em).getTime();
        if (cliSumiu?.estagio !== "frio" || respondeuDepois) {
          await supabase.from("followups").update({ enviado: true }).eq("id", followup.id);
          console.log(`[FollowUp] Cancelado (cliente respondeu): ${followup.telefone}`);
          continue;
        }
      }
      const mensagem = await gerarMensagemFollowUp(followup);
      if (!mensagem) continue;
      try {
        if (!estaNoHorarioComercial()) {
          console.log(`[FollowUp] Adiado (fora do horário comercial): ${followup.telefone}`);
          continue;
        }
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

        // Encadeia o próximo nível da régua de reativação (D+2 → D+4 → D+7),
        // se ainda não chegou no nível máximo.
        if (followup.motivo === "sumiu") {
          const nivelAtual = followup.nivel || 1;
          const proximoNivel = nivelAtual + 1;
          if (proximoNivel <= NIVEL_MAXIMO_REATIVACAO) {
            const diasEspera = DIAS_PROXIMO_NIVEL[nivelAtual] || 3;
            await agendarFollowUp(followup.telefone, "sumiu", followup.veiculo_interesse, diasEspera, proximoNivel);
          } else {
            console.log(`[FollowUp] Régua de reativação encerrada (nível máximo) para ${followup.telefone}`);
          }
        }
      } catch (e) { console.error(`[FollowUp] Erro envio:`, e.message); }
    }
  } catch (e) { console.error("[FollowUp] Erro:", e.message); }
}

setInterval(processarFollowUpsPendentes, 30 * 60 * 1000);
processarFollowUpsPendentes();

function estaNoHorarioComercial() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const d = new Date(agora);
  const dia = d.getDay();
  const hora = d.getHours();
  if (dia === 0) return false;
  if (dia === 6) return hora >= 8 && hora < 12;
  return hora >= 8 && hora < 18;
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

async function notificarFotoComAnalise(from, imageBuffer, mimeType, analise, caption = "") {
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
  const legenda = `📸 *Foto recebida de ${formatado}*${caption ? `\nLegenda do cliente: "${caption}"` : ""}\n\n*Análise da Sarah:*\n${analise}`;
  try {
    const formData = new FormData();
    formData.append("file", Buffer.from(imageBuffer), { filename: "foto.jpg", contentType: mimeType });
    formData.append("messaging_product", "whatsapp");
    const uploadRes = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/media`, formData,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...formData.getHeaders() } }
    );
    const novoMediaId = uploadRes.data.id;

    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, type: "image", image: { id: novoMediaId, caption: legenda.substring(0, 1024) } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Foto→Consultor] ✅ Repassada foto de ${from}`);
  } catch (e) {
    console.error(`[Foto→Consultor] Erro ao reenviar imagem (tentando só texto):`, e.response?.data ? JSON.stringify(e.response.data) : e.message);
    try {
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: legenda + "\n\n⚠️ (não foi possível reenviar a imagem original)" } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
    } catch (e2) { console.error(`[Foto→Consultor] Erro também no fallback de texto:`, e2.message); }
  }
}

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
    const palavrasModelo = modelo.toLowerCase().split(" ").filter(p => p.length > 1);
    let candidatos = modelosRes.data.modelos.filter(m => palavrasModelo.every(p => m.nome.toLowerCase().includes(p)));
    let _fipeIncerto = false;
    if (!candidatos.length) {
      candidatos = modelosRes.data.modelos.filter(m => m.nome.toLowerCase().includes(palavrasModelo[0]));
      _fipeIncerto = true;
    }
    if (candidatos.length > 1) _fipeIncerto = true;
    if (!candidatos.length) return null;
    for (const c of candidatos) {
      const anosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${c.codigo}/anos`);
      const anoFipe = anosRes.data.find(a => a.nome.includes(ano.toString()) && !a.nome.includes("32000"));
      if (anoFipe) {
        const valorRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${c.codigo}/anos/${anoFipe.codigo}`);
        valorRes.data._incerto = _fipeIncerto;
    valorRes.data._candidatos = candidatos.map(x => x.nome).slice(0, 5);
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

    if (from) notificarFotoComAnalise(from, imageRes.data, mediaRes.data.mime_type || "image/jpeg", analise, caption).catch(() => {});

    return analise;
  } catch (e) {
    if (e.response) await notificarFalhaApiClaude(e, `Análise de imagem (${from || "desconhecido"})`);
    return null;
  }
}

function clienteEstaPedindoFotosDoEstoque(texto, historicoConversa) {
  const t = texto.toLowerCase().trim();
  if (clienteEstaEmFluxoTroca(historicoConversa)) return false;
  const ultimaResposta = (historicoConversa || []).filter(m => m.role === "assistant").slice(-1)[0]?.content || "";
  const confirmacoesSimples = ["sim", "quero", "pode", "manda", "claro", "ok", "vai", "manda sim", "quero sim"];
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
    "queto foto", "queto as foto", "queto ver", "quer foto", "quer as foto",
    "manda imagem", "me manda imagem", "tem imagem", "ver imagem",
    "tem interna", "tem internas", "foto interna", "fotos interna",
    "foto do interior", "interior", "foto do painel", "foto dos bancos",
    "foto da frente", "foto de tras", "foto de trás", "mais foto", "mais fotos",
    "outras foto", "outras fotos", "ver mais"
  ];
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

  const todosTextos = mensagensRecentes.map(m => (m.content || "").toLowerCase()).join(" ");
  let melhorMatchGeral = null, melhorScoreGeral = 0;
  for (const v of estoque) {
    const score = pontuarVeiculo(v, todosTextos);
    if (score > melhorScoreGeral) { melhorScoreGeral = score; melhorMatchGeral = v; }
  }
  if (melhorMatchGeral && melhorScoreGeral >= 2) return melhorMatchGeral;

  return null;
}

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
  if (fotosEnviadas.length > 0) {
    await salvarMensagem(to, "sara_fotos", JSON.stringify({
      modelo: limparTexto(veiculo.modelo || ""),
      fotos: fotosEnviadas
    }));
  }
  return sucessos > 0;
}

function formatarEstoque(modeloFiltro = null) {
  if (!estoqueAtual.length) return "Estoque sendo carregado.";
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
  return estoqueAtual.map(v =>
    `${limparTexto(v.modelo || "")} ${v.ano || ""} - ${Number(v.km || 0).toLocaleString("pt-BR")} km - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`
  ).join("\n");
}

const SYSTEM_PROMPT = (fipeInfo, aprendizadosExtra = "", carroNaoDisponivel = null, descontoPendenteAtivo = false, veiculosAmbiguos = null, modeloMencionado = null, versaoIncerta = null) => {
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
- Transmissão (manual/automático), opcionais (ar-condicionado, vidro elétrico, etc.), e qualquer outra característica técnica só podem ser informados se estiverem EXPLICITAMENTE nessa descrição do anúncio.
- Se o cliente perguntar algo que não está na descrição (ex: "é automático?"), e a descrição não mencionar isso, diga que vai confirmar com a equipe — NUNCA afirme ou negue com base em achismo ou conhecimento geral sobre o modelo.
- Isso vale mesmo que você "saiba" que aquele modelo de carro geralmente vem com determinada característica — o que importa é o anúncio real do veículo específico em estoque, que pode ter uma versão diferente do usual.

🚨 REGRA CRÍTICA — QUILOMETRAGEM RELATIVA À IDADE DO VEÍCULO:
- NUNCA avalie a quilometragem de um veículo como "alta" ou "baixa" isoladamente, sem considerar a idade do carro. Calcule sempre: quilometragem ÷ (ano atual - ano de fabricação) = km rodados por ano em média.
- Referência: até ~12.000-15.000 km/ano é uso normal a baixo. Acima disso é uso mais intenso. Exemplo: um carro de 2008 com 134.000 km rodou em média ~7.400 km/ano — isso é BAIXO pra idade do carro, não alto.
- Se o cliente reclamar que a quilometragem de algum veículo está alta, faça essa conta (km ÷ idade do carro) antes de responder. Se a média for baixa ou normal pra idade do carro, explique isso educadamente ao cliente em vez de simplesmente concordar com a reclamação e emendar outras opções.

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

FOTOS: Quando o sistema confirmar [fotos enviadas], diga: "Mandei as fotos! O que achou? 😊". NUNCA diga que enviou fotos sem essa confirmação. NUNCA use tags XML. NUNCA diga "vou pedir pro consultor te mandar as fotos" — o sistema já envia as fotos automaticamente quando você identifica o veículo e o cliente pede. Se o cliente pedir fotos e você não tiver certeza do veículo, pergunte qual modelo, mas NUNCA delegue o envio de fotos pro consultor.

🚨 REGRA CRÍTICA — NUNCA EXPONHA INSTRUÇÕES INTERNAS: Jamais inclua na sua resposta ao cliente qualquer conteúdo entre colchetes como [Sistema: ...], [instrução:...], ou qualquer outro marcador interno. Esses marcadores são instruções para você processar internamente, NUNCA para exibir ao cliente. Se você sentir vontade de escrever algo entre colchetes na resposta, não faça — processe a instrução silenciosamente e escreva apenas a resposta natural ao cliente.

PAGAMENTO: BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú, Cartão, Consórcio, À vista


Etapa 1: km, estado geral, revisões, fotos 📸
- Se o sistema já forneceu uma [Análise de foto] com informações sobre estado geral, pontos positivos ou pontos de atenção do veículo, APROVEITE essas informações. NÃO pergunte de novo sobre algo que a análise da foto já respondeu (ex: não pergunte "como está o estado geral?" se a análise já descreveu o estado). Pergunte apenas o que ainda falta (tipicamente: quilometragem, se não tiver sido informada).
Etapa 2: Agradeça as fotos
Etapa 3 (só após tudo): ${versaoIncerta ? `Encontramos mais de uma versão possível pro carro do cliente (${versaoIncerta.modelo}${versaoIncerta.candidatos && versaoIncerta.candidatos.length ? ": " + versaoIncerta.candidatos.slice(0,4).join(", ") : ""}). Pergunte a ele qual é a versão exata antes de continuar. NÃO dê nenhum valor de troca ainda.` : fipeInfo ? `Já temos os dados pra avaliação. Diga que vai confirmar uma coisa rapidinho e já retorna (algo como "Deixa eu confirmar uma coisa aqui rapidinho e já te retorno!"). NÃO dê nenhum valor de troca nessa mensagem — o consultor confirma antes.` : "NUNCA invente valores de troca."}

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

function ehConsultor(from) {
  const digitos = (n) => String(n).replace(/\D/g, "").slice(-10);
  return digitos(from) === digitos(NUMERO_AUGUSTO);
}

async function processarComandoConsultor(from, text) {
  if (!ehConsultor(from)) return false;
  const t = text.trim().toUpperCase();

  const ehComando = t === "PENDENCIAS" || t === "AUTORIZO" || t === "NEGO" ||
    t.startsWith("AUTORIZO ") || t.startsWith("NEGO ") || /^SIMULA[CÇ][AÃ]O\s/i.test(text) ||
    /^CONTRAPROPOSTA\s/i.test(text) || t.startsWith("TROCA ") || t === "DEVOLVER";
  if (!ehComando) return false;

  await carregarDescontoPendente();

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

      const replySim = limparRespostaIA(claudeSim.data.content[0].text);
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

  const matchTroca = text.match(/^TROCA\s+([\s\S]+)/i);
  if (matchTroca) {
    const valorTroca = matchTroca[1].trim();
    await carregarAvaliacaoPendente();
    if (!avaliacaoPendente) {
      await enviarTexto(NUMERO_AUGUSTO, "⚠️ Nenhuma avaliação de troca pendente no momento.");
      return true;
    }
    const telefoneAv = avaliacaoPendente.telefone;
    await limparAvaliacaoPendente();
    const registroTroca = `[Sistema: o consultor confirmou a avaliação de troca em R$ ${valorTroca}. Informe esse valor ao cliente de forma natural, como o valor que conseguimos na troca do carro dele. NÃO mencione FIPE.]`;
    await salvarMensagem(telefoneAv, "sistema", registroTroca);
    if (!conversas[telefoneAv]) {
      const msgsAv = await buscarMensagens(telefoneAv);
      conversas[telefoneAv] = msgsAv.slice(-20).map(m => ({
        role: (m.tipo === "client" || m.tipo === "sistema") ? "user" : "assistant",
        content: m.texto || ""
      }));
    }
    conversas[telefoneAv].push({ role: "user", content: registroTroca });
    try {
      const aprendizadosExtraTr = await obterAprendizados();
      const claudeTr = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-5",
          max_tokens: 500,
          system: SYSTEM_PROMPT(null, aprendizadosExtraTr, null, false),
          messages: conversas[telefoneAv]
        },
        { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
      );
      const replyTr = limparRespostaIA(claudeTr.data.content[0].text);
      conversas[telefoneAv].push({ role: "assistant", content: replyTr });
      await enviarTexto(telefoneAv, replyTr);
      await salvarMensagem(telefoneAv, "sara", replyTr);
    } catch (e) {
      console.error("[Troca] Erro ao gerar/enviar resposta de troca:", e.message);
      if (e.response) await notificarFalhaApiClaude(e, `Resposta de troca (${telefoneAv})`);
    }
    return true;
  }

  if (t === "DEVOLVER") {
    await carregarAvaliacaoPendente();
    if (!avaliacaoPendente) {
      await enviarTexto(NUMERO_AUGUSTO, "⚠️ Nenhuma avaliação de troca pendente no momento.");
      return true;
    }
    const telefoneDv = avaliacaoPendente.telefone;
    await limparAvaliacaoPendente();
    const registroDevolver = `[Sistema: o consultor prefere não confirmar um valor de troca agora. Pergunte ao cliente quanto ele gostaria de receber de volta pelo carro dele, de forma natural.]`;
    await salvarMensagem(telefoneDv, "sistema", registroDevolver);
    if (!conversas[telefoneDv]) {
      const msgsDv = await buscarMensagens(telefoneDv);
      conversas[telefoneDv] = msgsDv.slice(-20).map(m => ({
        role: (m.tipo === "client" || m.tipo === "sistema") ? "user" : "assistant",
        content: m.texto || ""
      }));
    }
    conversas[telefoneDv].push({ role: "user", content: registroDevolver });
    try {
      const aprendizadosExtraDv = await obterAprendizados();
      const claudeDv = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-5",
          max_tokens: 500,
          system: SYSTEM_PROMPT(null, aprendizadosExtraDv, null, false),
          messages: conversas[telefoneDv]
        },
        { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
      );
      const replyDv = limparRespostaIA(claudeDv.data.content[0].text);
      conversas[telefoneDv].push({ role: "assistant", content: replyDv });
      await enviarTexto(telefoneDv, replyDv);
      await salvarMensagem(telefoneDv, "sara", replyDv);
    } catch (e) {
      console.error("[Devolver] Erro ao gerar/enviar resposta:", e.message);
      if (e.response) await notificarFalhaApiClaude(e, `Resposta devolver (${telefoneDv})`);
    }
    return true;
  }

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

    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: `✅ Contraproposta de *${valorContraproposta}* enviada para ${telefoneClienteCP}` } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );

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

      const replyCP = limparRespostaIA(claudeCP.data.content[0].text);
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

  const telefoneCliente = descontoPendente.telefone; const valorSolicitado = descontoPendente.info && descontoPendente.info.preco_solicitado; const matchNego = negado ? text.match(/^NEGO\s+([\s\S]+)/i) : null; const valorMinimo = matchNego ? matchNego[1].trim() : null;

  await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: `✅ ${autorizado ? "Desconto autorizado" : "Desconto negado"} para ${telefoneCliente}` } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );

  await limparDescontoPendente();

  const registroDesconto = autorizado
    ? `[Sistema: desconto AUTORIZADO pelo consultor em ${new Date().toLocaleString("pt-BR")}. Sarah já confirmou ao cliente que conseguimos a condição especial${valorSolicitado ? ` de R$ ${valorSolicitado}` : " combinada"}. NUNCA negar que o desconto foi aprovado. Se o cliente perguntar, confirmar que sim, o desconto foi aprovado.]`
    : `[Sistema: desconto NEGADO pelo consultor em ${new Date().toLocaleString("pt-BR")}. Sarah já informou ao cliente que o preço está firme${valorMinimo ? `, mas que o valor mínimo possível para esse veículo é R$ ${valorMinimo}` : ""}.]`;
  await salvarMensagem(telefoneCliente, "sistema", registroDesconto);

  const msgSistema = autorizado
    ? `[Sistema: nosso consultor autorizou o desconto. Informe ao cliente que conseguimos fazer uma condição especial e tente fechar o negócio. Seja entusiasta mas natural!]`
    : `[Sistema: nosso consultor não autorizou o desconto.${valorMinimo ? ` O valor mínimo que conseguimos fazer para esse veículo é R$ ${valorMinimo} — informe esse valor ao cliente como nossa melhor oferta.` : " Informe ao cliente que infelizmente o preço está firme, mas tente manter o interesse com outras vantagens como IPVA pago, facilidade de financiamento, etc."} Não mencione nomes.]`;

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

    const reply = limparRespostaIA(claude.data.content[0].text);
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

async function processarMensagem(from, text, tentativasAnteriores = 0) {
  if (!text || typeof text !== "string") return;

  if (await processarComandoConsultor(from, text)) return;

  if (ehConsultor(from)) {
    console.log(`[Consultor] Mensagem ignorada (não é comando): "${text.substring(0, 50)}"`);
    return;
  }

  ultimaMensagemCliente[from] = Date.now();
  supabase.from("clientes").upsert({ telefone: from, ultima_mensagem_cliente: new Date().toISOString() }, { onConflict: "telefone" }).then(() => {}, () => {});
  const primeiraVez = !ultimaNotificacao[from];
  const ehRetry = tentativasAnteriores > 0;

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

  const ultimaDoHistorico = conversas[from][conversas[from].length - 1];
  const jaEstaNoHistorico = ultimaDoHistorico && ultimaDoHistorico.role === "user" && ultimaDoHistorico.content === text;
  if (!jaEstaNoHistorico) {
    conversas[from].push({ role: "user", content: text });
  }

  if (!ehRetry) {
    await salvarMensagem(from, "client", text);
  }
  notificarAugusto(from, text, primeiraVez).catch(() => {});
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  detectarLeadFrio(from, text, conversas[from]).catch(() => {});
  detectarEstagio(from, text, conversas[from]).catch(() => {});

  await carregarColetaCreditoPendente(from);
  if (coletaCredito[from]) {
    const estado = coletaCredito[from];

    const cpfNaMensagem = validarCPF(text);
    const dataNaMensagem = extrairDataNascimento(text);
    const nomeNaMensagem = text.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "").replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, "").replace(/CEP[:\s]*/gi, "").trim();
    const palavrasNome = nomeNaMensagem.split(/\s+/).filter(p => p.length > 1);
    if (cpfNaMensagem && dataNaMensagem && palavrasNome.length >= 2) {
      estado.nome = palavrasNome.join(" ");
      estado.cpf = cpfNaMensagem;
      estado.nascimento = dataNaMensagem;
      estado.etapa = "entrada";
      await salvarColetaCreditoPendente(from, estado);
      const msg = `Obrigada, ${estado.nome.split(" ")[0]}! 😊 Recebi seus dados. Você tem algum valor de entrada para dar?`;
      conversas[from].push({ role: "assistant", content: msg });
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: from, text: { body: msg } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await salvarMensagem(from, "sara", msg);
      return;
    }

        if (estado.etapa === "aguardando_veiculo") {
                const veiculoConfirmado = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
                if (veiculoConfirmado) {
                          estado.etapa = "nome";
                          estado.veiculo = `${limparTexto(veiculoConfirmado.modelo)} ${veiculoConfirmado.ano || ""}`.trim();
                          await salvarColetaCreditoPendente(from, estado);
                          const msg = "Perfeito! Pra fazer a simulação preciso de alguns dados rapidinho. Primeiro, qual seu nome completo?";
                          conversas[from].push({ role: "assistant", content: msg });
                          await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
                                           { messaging_product: "whatsapp", to: from, text: { body: msg } },
                                           { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
                                                   );
                          await salvarMensagem(from, "sara", msg);
                          return;
                }
                const msg = "Sem problema! Me confirma qual carro do nosso estoque você quer financiar, que eu já sigo com a simulação. 😊";
                conversas[from].push({ role: "assistant", content: msg });
                await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
                                 { messaging_product: "whatsapp", to: from, text: { body: msg } },
                                 { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
                                       );
                await salvarMensagem(from, "sara", msg);
                return;
        }
    
    if (estado.etapa === "nome") {
      const nomeDigitado = text.trim();
      const palavrasNaoNome = ["entrada", "parcela", "financi", "desconto", "preço", "preco", "valor", "restante", "seria", "quero", "queria", "gostaria", "consegue", "consigo", "aguardo", "aguardando", "imagens", "espero", "esperando", "então", "entao", "beleza", "obrigado", "obrigada", "posso", "preciso", "foto", "fotos"];
      const temDigito = /\d/.test(nomeDigitado);
      const contemPalavraNaoNome = palavrasNaoNome.some(p => nomeDigitado.toLowerCase().includes(p));
      const parecePergunta = text.includes("?") || text.toLowerCase().startsWith("qual") || text.toLowerCase().startsWith("como") || text.toLowerCase().startsWith("quando") || text.toLowerCase().startsWith("quanto") || text.toLowerCase().startsWith("onde") || text.toLowerCase().startsWith("tem") || text.toLowerCase().startsWith("voc") || temDigito || contemPalavraNaoNome;
      if (nomeDigitado.split(/\s+/).length >= 2 && nomeDigitado.length >= 5 && !parecePergunta) {
        estado.nome = nomeDigitado;
        estado.etapa = "cpf";
        await salvarColetaCreditoPendente(from, estado);
        const msg = "Perfeito! Agora me passa seu CPF, por favor (só os números) 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      } else if (parecePergunta) {
        conversas[from].push({ role: "user", content: text + "\n[Sistema: o cliente mandou algo que não é um nome completo válido (pode ser uma pergunta, um emoji, ou uma confirmação vaga). Se for uma pergunta de verdade, responda brevemente. Em QUALQUER caso, termine a mensagem pedindo o nome completo de novo — não mude de assunto. A ÚNICA coisa pendente aqui é o nome.]" });
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
        await salvarColetaCreditoPendente(from, estado);
        const msg = "Show! Agora sua data de nascimento (dia/mês/ano) 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      } else if (text.replace(/\D/g, "").length >= 9) {
        const msg = "Esse CPF não parece válido. Pode conferir e mandar de novo? (só os números, 11 dígitos) 😊";
        conversas[from].push({ role: "assistant", content: msg });
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: msg } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        await salvarMensagem(from, "sara", msg);
        return;
      } else {
        conversas[from].push({ role: "user", content: text + "\n[Sistema: o cliente mandou algo que não é um CPF válido (pode ser uma pergunta, um emoji, ou uma confirmação vaga). Se for uma pergunta de verdade, responda brevemente. Em QUALQUER caso, termine a mensagem pedindo o CPF de novo — não mude de assunto, não pergunte sobre financiamento, parcela ou orçamento. A ÚNICA coisa pendente aqui é o CPF.]" });
      }
    }

    if (estado.etapa === "nascimento") {
      const dataNasc = extrairDataNascimento(text);
      if (dataNasc) {
        estado.nascimento = dataNasc;
        estado.etapa = "entrada";
        await salvarColetaCreditoPendente(from, estado);

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
          estado.entradaSugerida = valorDetectado.trim();
          await salvarColetaCreditoPendente(from, estado);
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

      let nomeVeiculo = null;
      const veiculoDoEstoque = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
      if (veiculoDoEstoque) {
        nomeVeiculo = `${limparTexto(veiculoDoEstoque.modelo)} ${veiculoDoEstoque.ano || ""}`.trim();
      }
      if (!nomeVeiculo) {
        try {
          const { data: clienteData } = await supabase.from("clientes").select("veiculo_interesse").eq("telefone", from).limit(1);
          const vi = clienteData?.[0]?.veiculo_interesse;
          if (vi && estoqueAtual.some(v => limparTexto(v.modelo || "").toLowerCase().includes(vi.toLowerCase()))) {
            nomeVeiculo = vi;
          }
        } catch (e) { /* segue sem veículo */ }
      }

      const dadosFinais = {
        nome: estado.nome, cpf: estado.cpf, nascimento: estado.nascimento,
        entrada: estado.entrada, veiculo: nomeVeiculo
      };
      delete coletaCredito[from];
      limparColetaCreditoPendente(from).catch(() => {});

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

  const ehTextoNormal = !text.startsWith("[Cliente enviou foto") && !text.startsWith("[Áudio]") && !text.startsWith("[Sistema:");
  const jaEnviouFotos = conversas[from].slice(-6).map(m => m.content || "").join(" ").includes("[Sistema: fotos enviadas");
  const resultadoFotos = ehTextoNormal && clienteEstaPedindoFotosDoEstoque(text, conversas[from]);
  const clientePedindoFotos = resultadoFotos && (!jaEnviouFotos || resultadoFotos === "adicional");
  if (clientePedindoFotos) {
    const veiculo = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
    let msgFotos;
    if (veiculo?.fotos?.length > 0) {
      console.log(`[Fotos] Enviando ${veiculo.fotos.length} fotos do ${veiculo.modelo}`);
      const enviouComSucesso = await enviarFotosVeiculo(from, veiculo);
      const modeloAno = `${limparTexto(veiculo.modelo)} ${veiculo.ano || ""}`.trim();
      if (enviouComSucesso) {
        msgFotos = `Mandei as fotos do ${modeloAno}! O que achou? 😊`;
        atualizarEstagio(from, "negociacao", limparTexto(veiculo.modelo)).catch(() => {});
      } else {
        msgFotos = `Opa, tive uma instabilidade agora tentando mandar as fotos do ${modeloAno}. Pode me pedir de novo daqui a pouco? 😅`;
      }
    } else if (resultadoFotos === "adicional") {
      msgFotos = "As fotos disponíveis desse anúncio já foram todas enviadas! Se quiser, posso pedir pro nosso consultor tirar fotos específicas e te enviar depois, ou você pode vir pessoalmente conferir o interior. 😊";
    } else {
      msgFotos = "Qual veículo exatamente você quer ver as fotos? Me confirma o modelo pra eu te mandar certinho! 😊";
    }
    conversas[from].push({ role: "assistant", content: msgFotos });
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: msgFotos } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    await salvarMensagem(from, "sara", msgFotos);

    const temOutroAssunto = detectarInteresseFinanciamento(text, conversas[from]) || /\btroca\b|\btrocar\b/i.test(text) || text.includes("?");
    if (!temOutroAssunto) return;
    conversas[from].push({ role: "user", content: `[Sistema: a confirmação de envio de fotos já foi feita automaticamente na mensagem anterior. NÃO mencione fotos de novo nem repita essa confirmação. Responda apenas a outra parte da mensagem do cliente (financiamento, troca, preço, ou o que mais ele perguntou).]` });
  }

  if (!coletaCredito[from] && !clientePedindoFotos && detectarInteresseFinanciamento(text, conversas[from])) {
        const veiculoParaFinanciar = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
        coletaCredito[from] = veiculoParaFinanciar
                ? { etapa: "nome", veiculo: `${limparTexto(veiculoParaFinanciar.modelo)} ${veiculoParaFinanciar.ano || ""}`.trim() }
                : { etapa: "aguardando_veiculo" };
        await salvarColetaCreditoPendente(from, coletaCredito[from]);
        const msg = veiculoParaFinanciar
                ? "Posso fazer uma simulação de crédito pra você! 😊 Pra isso preciso de alguns dados rapidinho. Primeiro, qual seu nome completo?"
                : "Posso fazer uma simulação de crédito sim! 😊 Só me confirma antes: qual carro do nosso estoque você quer financiar?";
    conversas[from].push({ role: "assistant", content: msg });
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: msg } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    await salvarMensagem(from, "sara", msg);
    return;
  }

  await carregarDescontoPendente();
  const clienteTemDescontoPendente = descontoPendente && descontoPendente.telefone === from;
  if (!clienteTemDescontoPendente) {
    const ehDesconto = await processarDesconto(from, text, conversas[from]);
    if (ehDesconto) {
      conversas[from].push({ role: "user", content: `[Sistema: cliente pediu desconto. Já notificamos nosso consultor. Informe que está verificando e continue a conversa normalmente.]` });
    }
  }

  const isSimples = ehMensagemSimples(text);
  const todosTextos = conversas[from].filter(m => m.role === "user").map(m => m.content);
  const { marcaTroca, modeloTroca, anoTroca, modeloBuscado, anoBuscado } = await extrairContextoConversa(todosTextos, isSimples, from);

  let carroNaoDisponivel = null;
  if (modeloBuscado) {
    const normalizarPalavras = (str) => limparTexto(str || "").toLowerCase().split(/\s+/).filter(p => p.length >= 3 && !/^\d+([.,]\d+)?$/.test(p));
    const palavrasBuscadas = normalizarPalavras(modeloBuscado);
    const encontrado = estoqueAtual.some(v => {
      const modeloEstoque = limparTexto(v.modelo || "").toLowerCase();
      const palavrasEstoque = normalizarPalavras(v.modelo);
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

  let veiculosAmbiguos = null;
  if (modeloBuscado) {
    const candidatos = contarVeiculosAmbiguos(modeloBuscado, estoqueAtual);
    if (candidatos.length > 1) veiculosAmbiguos = candidatos;
  }

  let fipeInfo = null;
  let versaoIncerta = null;
  if (marcaTroca && modeloTroca && anoTroca) {
    fipeInfo = await consultarFipe(marcaTroca, modeloTroca, anoTroca);
    if (fipeInfo && fipeInfo._incerto) {
      versaoIncerta = { modelo: modeloTroca, candidatos: fipeInfo._candidatos || [] };
      fipeInfo = null;
    }
  }

  await carregarAvaliacaoPendente();

  if (fipeInfo && !versaoIncerta) {
    const jaTemPendenteMesmoCliente = avaliacaoPendente && avaliacaoPendente.telefone === from;
    const jaAvisouConsultor = conversas[from] && conversas[from].some(m => m.content && m.content.includes("[Sistema: avaliação de troca enviada ao consultor"));
    if (!jaTemPendenteMesmoCliente && !jaAvisouConsultor) {
      const vTroca = calcularValoresTroca(fipeInfo.Valor);
      await salvarAvaliacaoPendente(from, {
        marca: marcaTroca, modelo: modeloTroca, ano: anoTroca,
        modeloFipe: fipeInfo.Modelo, valorFipe: fipeInfo.Valor,
        minimo: vTroca.minimoFormatado, maximo: vTroca.maximoFormatado
      });
      const msgConsultor = `🚗 *Avaliação de troca pendente*\nCliente: ${from}\nCarro do cliente: ${marcaTroca} ${modeloTroca} (${anoTroca})\nModelo usado na FIPE: ${fipeInfo.Modelo}\nValor FIPE: ${fipeInfo.Valor}\nFaixa sugerida (80-85%): R$ ${vTroca.minimoFormatado} a R$ ${vTroca.maximoFormatado}\n\nResponda:\nTROCA [valor] — pra usar esse valor na troca\nDEVOLVER — pra eu perguntar ao cliente quanto ele quer de volta`;
      await enviarTexto(NUMERO_AUGUSTO, msgConsultor);
      const msgEspera = "Deixa eu confirmar uma coisa aqui rapidinho e já te retorno! 😊";
      await enviarTexto(from, msgEspera);
      await salvarMensagem(from, "sara", msgEspera);
      conversas[from].push({ role: "assistant", content: msgEspera });
      conversas[from].push({ role: "user", content: "[Sistema: avaliação de troca enviada ao consultor, aguardando confirmação dele. Não dê nenhum valor de troca até ele responder.]" });
      return;
    }
  }

  fipeInfo = null;

  const aprendizadosExtra = await obterAprendizados();
  const clienteAindaTemPendente = descontoPendente && descontoPendente.telefone === from;

  try {
    const claude = await axios.post("https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: SYSTEM_PROMPT(fipeInfo, aprendizadosExtra, carroNaoDisponivel, clienteAindaTemPendente, veiculosAmbiguos, modeloBuscado, versaoIncerta),
        messages: conversas[from].slice(-30)
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );

    const replyRaw = claude.data.content[0].text;
    const reply = limparRespostaIA(replyRaw);
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
    const tentativas = (tentativasAnteriores || 0) + 1;
    if (tentativas <= MAX_TENTATIVAS_PENDENTE) {
      try {
        await supabase.from("mensagens_pendentes").insert({ telefone: from, texto: text, tentativas });
        console.log(`[Retry] Mensagem de ${from} re-agendada para retry (tentativa ${tentativas}/${MAX_TENTATIVAS_PENDENTE})`);
      } catch (e2) {
        console.error("[Retry] Erro ao salvar pendente:", e2.message);
      }
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
  res.setHeader("Cache-Control", "no-store");
  try {
    const { data: followups } = await supabase.from("followups").select("*").order("criado_em", { ascending: false }).limit(100);
    const lista = followups || [];

    const motivoLabel = { sumiu: "😶 Sumiu", achou_caro: "💰 Achou caro", vai_pensar: "🤔 Vai pensar", sem_interesse: "❌ Sem interesse", visita_nao_confirmada: "📅 Visita não confirmada" };
    const motivoCor = { sumiu: "#64b5f6", achou_caro: "#f0a500", vai_pensar: "#81c784", sem_interesse: "#ef5350", visita_nao_confirmada: "#ce93d8" };

    const agora = new Date();
    const itensHtml = lista.map(f => {
      const numero = String(f.telefone || "").replace(/\D/g, "");
      const formatado = numero.length >= 12 ? `(${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : f.telefone;
      const agendado = f.agendado_para ? new Date(f.agendado_para) : null;
      const venceu = agendado && agendado <= agora;
      const cor = motivoCor[f.motivo] || "#888";
      const labelBase = motivoLabel[f.motivo] || f.motivo;
      // Régua de reativação pode repetir (D+2/D+4/D+7) para o mesmo
      // cliente — mostra em qual nível esse registro está.
      const label = (f.motivo === "sumiu" && f.nivel) ? `${labelBase} (nível ${f.nivel})` : labelBase;
      const statusBadge = f.enviado
        ? '<span style="background:#1e3a1e;color:#81c784;padding:2px 8px;border-radius:10px;font-size:10px">✅ Enviado</span>'
        : venceu
          ? '<span style="background:#3a1a1a;color:#ef5350;padding:2px 8px;border-radius:10px;font-size:10px">⚠️ Vencido</span>'
          : '<span style="background:#1a1a2e;color:#64b5f6;padding:2px 8px;border-radius:10px;font-size:10px">⏳ Pendente</span>';

      return `<div style="background:#161616;border:1px solid #222;border-left:3px solid ${cor};border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div>
            <a href="/painel/chat/${f.telefone}" style="color:#fff;font-weight:600;font-size:13px;text-decoration:none">${formatado}</a>
            ${f.veiculo_interesse ? `<span style="color:#f0a500;font-size:11px;margin-left:8px">🚗 ${f.veiculo_interesse}</span>` : ""}
          </div>
          ${statusBadge}
        </div>
        <div style="font-size:11px;color:${cor};margin-bottom:4px">${label}</div>
        <div style="font-size:10px;color:#555">
          Agendado: ${agendado ? agendado.toLocaleString("pt-BR") : "—"} | 
          Criado: ${new Date(f.criado_em).toLocaleString("pt-BR")}
        </div>
        ${!f.enviado ? `
        <form action="/followups/disparar" method="POST" style="margin-top:8px;display:flex;gap:6px">
          <input type="hidden" name="id" value="${f.id}">
          <input type="hidden" name="telefone" value="${f.telefone}">
          <input type="hidden" name="veiculo" value="${f.veiculo_interesse || ""}">
          <button type="submit" style="background:#f0a500;color:#000;border:none;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer">📤 Disparar agora</button>
        </form>` : ""}
      </div>`;
    }).join("");

    const veiculosOpts = estoqueAtual.map(v => `<option value="${limparTexto(v.modelo || "")} ${v.ano || ""}">${limparTexto(v.modelo || "")} ${v.ano || ""}</option>`).join("");

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Follow-ups — Sarah CRM</title>
<style>body{margin:0;font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0}
header{background:#111;border-bottom:1px solid #222;padding:12px 16px;position:sticky;top:0;display:flex;align-items:center;gap:10px;z-index:10}
</style></head><body>
<header>
  <a href="/painel" style="color:#f0a500;text-decoration:none;font-size:20px">←</a>
  <h1 style="font-size:16px;color:#fff;font-weight:700;margin:0">📅 Follow-ups</h1>
  <button onclick="document.getElementById('form-novo').style.display=document.getElementById('form-novo').style.display==='none'?'block':'none'" style="margin-left:auto;background:#f0a500;color:#000;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">+ Novo</button>
</header>

<div id="form-novo" style="display:none;padding:12px 16px;background:#1a1500;border-bottom:1px solid #f0a500">
  <form action="/followups/criar" method="POST" style="display:flex;flex-direction:column;gap:8px">
    <input type="text" name="telefone" placeholder="Telefone (ex: 5551999999999)" required style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;padding:8px;font-size:13px">
    <select name="motivo" style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;padding:8px;font-size:13px">
      <option value="sumiu">😶 Sumiu</option>
      <option value="achou_caro">💰 Achou caro</option>
      <option value="vai_pensar">🤔 Vai pensar</option>
      <option value="sem_interesse">❌ Sem interesse</option>
    </select>
    <select name="veiculo" style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;padding:8px;font-size:13px">
      <option value="">-- Veículo (opcional) --</option>
      ${veiculosOpts}
    </select>
    <input type="number" name="dias" value="3" min="1" max="30" placeholder="Dias para disparar" style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;padding:8px;font-size:13px">
    <button type="submit" style="background:#f0a500;color:#000;border:none;border-radius:6px;padding:8px;font-size:13px;font-weight:700;cursor:pointer">Agendar follow-up</button>
  </form>
</div>

<div style="padding:14px">
  <div style="font-size:11px;color:#555;margin-bottom:10px">${lista.length} follow-up(s) | ${lista.filter(f=>f.enviado).length} enviados | ${lista.filter(f=>!f.enviado).length} pendentes</div>
  ${itensHtml || '<p style="color:#555;text-align:center;padding:20px">Nenhum follow-up cadastrado ainda</p>'}
</div>
</body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch(e) {
    res.send(`<html><body style="background:#000;color:#f44;padding:20px">Erro: ${e.message}</body></html>`);
  }
});

app.post("/followups/disparar", async (req, res) => {
  const { id, telefone, veiculo } = req.body;
  try {
    const veiculoTexto = veiculo || "nossos veículos";
    const enviou = await enviarMensagemTemplate(telefone, TEMPLATE_FOLLOWUP, [veiculoTexto]);
    if (enviou) {
      await supabase.from("followups").update({ enviado: true }).eq("id", id);
      console.log(`[FollowUp] ✅ Disparado manualmente: ${telefone}`);
    }
  } catch(e) { console.error("[FollowUp] Erro disparo manual:", e.message); }
  res.redirect("/followups");
});

app.post("/followups/criar", async (req, res) => {
  const { telefone, motivo, veiculo, dias } = req.body;
  if (!telefone || !motivo) return res.redirect("/followups");
  try {
    await agendarFollowUp(telefone, motivo, veiculo || null, parseInt(dias) || 3);
    console.log(`[FollowUp] ✅ Criado manualmente: ${telefone} — ${motivo}`);
  } catch(e) { console.error("[FollowUp] Erro criação manual:", e.message); }
  res.redirect("/followups");
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
  try {
    const erroFake = { response: { status: 400, data: { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } } } };
    ultimoAlertaApiFalha = 0;
    await notificarFalhaApiClaude(erroFake, "Teste manual via /testar-alerta-api");
    res.json({ ok: true, mensagem: "Alerta de teste enviado ao WhatsApp do consultor" });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});
app.get("/painel/pendentes", async (req, res) => {
  try {
    const { data } = await supabase.from("mensagens_pendentes").select("*").order("criado_em", { ascending: false }).limit(50);
    res.json({ pendentes: data || [] });
  } catch (e) { res.json({ pendentes: [], erro: e.message }); }
});
app.get("/testar-retry", async (req, res) => {
  try {
    await processarMensagensPendentes();
    res.json({ ok: true, mensagem: "Job de retry executado manualmente" });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

const webhookRateLimit = {};
const webhookRateLimitTel = {};
const WEBHOOK_LIMITE_POR_MINUTO = 60;
const WEBHOOK_LIMITE_TEL_POR_MINUTO = 20;

app.post("/webhook", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const agora = Date.now();
  if (!webhookRateLimit[ip]) webhookRateLimit[ip] = { count: 0, reset: agora + 60000 };
  if (agora > webhookRateLimit[ip].reset) webhookRateLimit[ip] = { count: 0, reset: agora + 60000 };
  webhookRateLimit[ip].count++;
  if (webhookRateLimit[ip].count > WEBHOOK_LIMITE_POR_MINUTO) {
    console.error(`[Webhook] Rate limit IP excedido: ${ip}`);
    return res.sendStatus(429);
  }

  const telMsg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
  if (telMsg) {
    if (!webhookRateLimitTel[telMsg]) webhookRateLimitTel[telMsg] = { count: 0, reset: agora + 60000 };
    if (agora > webhookRateLimitTel[telMsg].reset) webhookRateLimitTel[telMsg] = { count: 0, reset: agora + 60000 };
    webhookRateLimitTel[telMsg].count++;
    if (webhookRateLimitTel[telMsg].count > WEBHOOK_LIMITE_TEL_POR_MINUTO) {
      console.error(`[Webhook] Rate limit telefone excedido: ${telMsg}`);
      return res.sendStatus(429);
    }
  }

  const appSecret = process.env.META_APP_SECRET;
  if (appSecret) {
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      console.error("[Webhook] Requisição sem assinatura rejeitada");
      return res.sendStatus(403);
    }
    try {
      const rawBody = req.rawBody;
      if (!rawBody) {
        console.error("[Webhook] rawBody não disponível — verificar configuração do express.json verify");
        return res.sendStatus(500);
      }
      const expected = "sha256=" + nodeCrypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
      if (signature.length !== expected.length) {
        console.error("[Webhook] Tamanho de assinatura diferente — rejeitado");
        return res.sendStatus(403);
      }
      if (!nodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        console.error("[Webhook] Assinatura HMAC inválida — possível requisição forjada");
        return res.sendStatus(403);
      }
      console.log("[Webhook] ✅ HMAC válido");
    } catch (e) {
      console.error("[Webhook] Erro na validação HMAC:", e.message);
      return res.sendStatus(403);
    }
  }

  const body = req.body;
  res.sendStatus(200);
  if (body.object === "whatsapp_business_account") {
    const statusEvent = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    if (statusEvent) {
      const wamid = statusEvent.id;
      const status = statusEvent.status;
      let motivoErro = null;
      if (status === "failed" && statusEvent.errors?.length) {
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
    let from = msg.from;
    if (from && from.startsWith("55") && from.length === 12) {
      from = "55" + from.slice(2, 4) + "9" + from.slice(4);
    }
    const referral = msg.referral;
    let textoReferral = null;
    if (referral) {
      const headline = referral.headline || "";
      const body = referral.body || "";
      const fonte = referral.source_type === "ad" ? "anúncio patrocinado" : "publicação";
      const resumoReferral = `${fonte}${headline ? `: "${headline}"` : ""}${body ? ` — ${body}` : ""}`;
      textoReferral = `[Sistema: este cliente chegou via ${fonte} do Instagram/Facebook. ` +
        (headline ? `Título do anúncio: "${headline}". ` : "") +
        (body ? `Descrição: "${body}". ` : "") +
        `Use essas informações para identificar qual veículo do estoque corresponde a esse anúncio e já mencione ele na sua resposta, sem precisar perguntar qual carro o cliente viu.]`;
      console.log(`[Referral] Anúncio detectado de ${from}: ${headline || body || "sem título"}`);
      try {
        await supabase.from("clientes").upsert({ telefone: from, anuncio_referral: resumoReferral }, { onConflict: "telefone" });
      } catch (e) { console.error("[Referral] Erro ao salvar:", e.message); }
    }
    try {
      if (msg.type === "text") {
        const text = msg.text?.body;
        if (!text) return;
        console.log(`Texto de ${from}: ${text}`);
        if (textoReferral && !conversas[from]?.length) {
          if (!conversas[from]) conversas[from] = [];
          conversas[from].push({ role: "user", content: textoReferral });
          await salvarMensagem(from, "sistema", textoReferral);
        }
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
        const mediaId = msg.image.id;
        const mimeType = msg.image.mime_type || "image/jpeg";
        try {
          const mediaRes = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
          const urlTemporaria = mediaRes.data?.url || null;
          await salvarMensagem(from, "client_foto", JSON.stringify({ mediaId, url: urlTemporaria, caption, mimeType }));
        } catch (e) {
          await salvarMensagem(from, "client_foto", JSON.stringify({ mediaId, url: null, caption, mimeType }));
        }
        const analise = await analisarImagem(mediaId, caption, from);
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

app.get("/painel", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const kanban = await buscarLeadsCRM();
    const pendente = descontoPendente;
    let alertasPendentesCount = 0;
    try {
      const { count } = await supabase.from("alertas_pendentes").select("id", { count: "exact" }).eq("visualizado", false);
      alertasPendentesCount = count || 0;
    } catch (e) { }
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
      (pendente ? '<span class="badge">💰 1 desconto</span>' : '') +
      (alertasPendentesCount > 0 ? '<span class="badge" style="background:#f44336">⚠️ ' + alertasPendentesCount + ' alerta(s)</span>' : '') + '</h1>' +
      '<div style="font-size:12px;color:#888"><span class="dot"></span>' + totalLeads + ' leads</div>' +
      '</header>' +
      '<div style="padding:10px 16px;background:#0f0f0f;border-bottom:1px solid #1a1a1a;display:flex;gap:10px;align-items:center">' +
      '<a href="/painel" style="color:#f0a500;font-size:12px;font-weight:600;text-decoration:none">📋 Pipeline</a>' +
      '<a href="/painel/lista" style="color:#888;font-size:12px;text-decoration:none">💬 Conversas</a>' +
      '<a href="/followups" style="color:#888;font-size:12px;text-decoration:none">📅 Follow-ups</a>' +
      (alertasPendentesCount > 0 ? '<a href="/painel/alertas" style="color:#f44336;font-size:12px;font-weight:600;text-decoration:none">⚠️ Alertas (' + alertasPendentesCount + ')</a>' : '') +
      '<button onclick="document.getElementById(\'form-novo-contato\').style.display=document.getElementById(\'form-novo-contato\').style.display===\'none\'?\'flex\':\'none\'" style="margin-left:auto;background:#f0a500;color:#000;border:none;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer">➕ Novo contato</button>' +
      '</div>' +
      '<div id="form-novo-contato" style="display:none;padding:10px 16px;background:#1a1500;border-bottom:1px solid #f0a500;gap:8px;flex-direction:column">' +
      '<div style="font-size:11px;color:#f0a500;font-weight:700">Iniciar conversa manualmente</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<input type="text" id="novo-tel" placeholder="Telefone (ex: 5551999999999)" style="flex:1;min-width:160px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;padding:8px;font-size:13px">' +
      '<select id="novo-template" style="flex:1;min-width:140px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;padding:8px;font-size:13px">' +
      estoqueAtual.map(v => `<option value="${limparTexto(v.modelo||'')} ${v.ano||''}">${limparTexto(v.modelo||'')} ${v.ano||''}</option>`).join('') +
      '</select>' +
      '<button onclick="iniciarContato()" style="background:#f0a500;color:#000;border:none;border-radius:6px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer">Enviar template</button>' +
      '</div>' +
      '</div>' +
      '<div style="padding:10px 16px;background:#0f0f0f;border-bottom:1px solid #1a1a1a">' +
      '<input type="text" id="busca-crm" placeholder="🔎 Buscar por telefone, veículo ou mensagem (ex: foto, argo, 9355...)" ' +
      'oninput="filtrarLeads(this.value)" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;color:#fff;padding:8px 10px;font-size:13px">' +
      '</div>' +
      '<div class="board">' + colunasHtml + '</div>' +
      '<script>' +
      'function iniciarContato() {' +
      '  const tel = document.getElementById("novo-tel").value.replace(/\\D/g,"");' +
      '  const veiculo = document.getElementById("novo-template").value;' +
      '  if (!tel || tel.length < 10) { alert("Digite um telefone válido"); return; }' +
      '  fetch("/painel/iniciar-contato", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefone: tel, veiculo }) })' +
      '    .then(r => r.json())' +
      '    .then(d => { if (d.ok) { alert("Template enviado com sucesso!"); document.getElementById("novo-tel").value = ""; } else alert("Erro: " + (d.erro||"falha no envio")); })' +
      '    .catch(() => alert("Erro de conexão"));' +
      '}' +
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


app.get("/painel/alertas", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { data } = await supabase.from("alertas_pendentes").select("*").order("criado_em", { ascending: false }).limit(100);
    const alertas = data || [];
    let itensHtml = alertas.map(a => {
      const texto = String(a.texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      const hora = a.criado_em ? new Date(a.criado_em).toLocaleString('pt-BR') : '';
      return '<div style="background:' + (a.visualizado ? '#161616' : '#2a1a00') + ';border:1px solid ' + (a.visualizado ? '#222' : '#f0a500') + ';border-radius:8px;padding:12px;margin-bottom:10px">' +
        '<div style="font-size:13px;color:#ddd;line-height:1.5">' + texto + '</div>' +
        '<div style="font-size:10px;color:#666;margin-top:6px">' + hora + '</div>' +
        (!a.visualizado ? '<button onclick="marcarVisto(' + a.id + ', this)" style="margin-top:8px;background:#f0a500;color:#000;border:none;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer">✓ Marcar como visto</button>' : '<span style="font-size:11px;color:#4caf50">✓ Visto</span>') +
        '</div>';
    }).join('');

    const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alertas pendentes — Sarah CRM</title>' +
      '<style>body{margin:0;font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0}a{color:inherit}' +
      'header{background:#111;border-bottom:1px solid #222;padding:12px 16px;position:sticky;top:0;display:flex;align-items:center;gap:10px}</style></head><body>' +
      '<header><a href="/painel" style="color:#f0a500;text-decoration:none;font-size:20px">←</a><h1 style="font-size:16px;color:#fff;font-weight:700;margin:0">⚠️ Alertas pendentes</h1></header>' +
      '<div style="padding:14px">' +
      '<p style="font-size:12px;color:#888;margin-top:0">Notificações que não puderam ser enviadas ao seu WhatsApp porque fazia mais de 24h que você não escrevia para o número da Sarah. Mande qualquer mensagem para o número da Sarah para reabrir a janela.</p>' +
      (itensHtml || '<p style="color:#555;text-align:center;padding:20px">Nenhum alerta pendente 🎉</p>') +
      '</div>' +
      '<script>' +
      'function marcarVisto(id, btn) {' +
      '  fetch("/painel/alertas/visto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })' +
      '    .then(r => r.json()).then(d => { if (d.ok) location.reload(); });' +
      '}' +
      '</script>' +
      '</body></html>';

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch(e) {
    res.send('<html><body style="background:#000;color:#f44;padding:20px">Erro: ' + e.message + '</body></html>');
  }
});
app.post("/registrar-mensagem", async (req, res) => {
try {
const { telefone, tipo, texto, wamid, status_entrega, motivo_erro } = req.body || {};
if (!telefone || !texto) {
return res.status(400).json({ ok: false, erro: "telefone e texto sao obrigatorios" });
}
const numero = String(telefone).replace(/\D/g, "");
const { error } = await supabase.from("mensagens").insert({ telefone: numero, tipo: tipo || "sara", texto, wamid: wamid || null, status_entrega: status_entrega || "enviado", motivo_erro: motivo_erro || null });
if (error) {
console.error("[Mensagem] ERRO ao gravar mensagem:", error.message);
return res.status(500).json({ ok: false, erro: error.message });
}
console.log(`[Mensagem] OK gravada: ${numero} (${tipo || "sara"})`);
res.json({ ok: true });
} catch (e) {
console.error("[Mensagem] EXCECAO:", e.message);
res.status(500).json({ ok: false, erro: e.message });
}
});
app.post("/notificar-lead", async (req, res) => {
  try {
    const bodyNormalizado = {};
    for (const [chave, valor] of Object.entries(req.body || {})) {
      bodyNormalizado[String(chave).trim()] = valor;
    }
    const { nome, telefone, veiculo, portal, mensagem } = bodyNormalizado;
    if (!telefone) {
      console.error("[Lead] ❌ Telefone ausente. Body recebido:", JSON.stringify(req.body));
      return res.status(400).json({ erro: "Telefone obrigatório" });
    }
    const numero = String(telefone).replace(/\D/g, "");
    const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : telefone;
    const linkWhatsApp = `https://wa.me/${numero}`;
    const msg = `🔔 *Novo lead — ${portal || "Portal"}*\nNome: *${nome || "Não informado"}*\nFone: ${formatado}\nVeículo: *${veiculo || "Não informado"}*${mensagem ? `\nMensagem: "${mensagem.substring(0, 150)}"` : ""}\n\nFalar com lead: ${linkWhatsApp}\nhttps://agente-mensagens1.onrender.com/painel`;
    await enviarTexto(NUMERO_AUGUSTO, msg);
    console.log(`[Lead] ✅ Notificação enviada: ${formatado} — ${veiculo}`);
    try { const { data: existenteCRM } = await supabase.from("clientes").select("id").eq("telefone", numero).limit(1); const payloadCRM = { telefone: numero, nome: nome || undefined, veiculo_interesse: veiculo || undefined, ultima_interacao: new Date().toISOString() }; if (!existenteCRM || !existenteCRM.length) payloadCRM.estagio = "quente"; const { error: erroCRM } = await supabase.from("clientes").upsert(payloadCRM, { onConflict: "telefone" }); if (erroCRM) console.error("[Lead] ERRO ao gravar no CRM (Supabase):", erroCRM.message); else console.log("[Lead] OK gravado no CRM/painel:", numero); } catch (erroCRM) { console.error("[Lead] EXCECAO ao gravar no CRM (Supabase):", erroCRM.message); } res.json({ ok: true });
  } catch(e) {
    console.error("[Lead] Erro notificação:", e.message);
    res.status(500).json({ erro: e.message });
  }
});
app.post("/notificar-post-publicado", async (req, res) => {
  try {
    const { veiculo, instagram_ok, facebook_ok } = req.body;
    const igOk = instagram_ok === true || instagram_ok === "true";
    const fbOk = facebook_ok === true || facebook_ok === "true";
    const msg = `🎬 *Reels publicado!*\nVeículo: *${veiculo || "não informado"}*\nInstagram: ${igOk ? "✅" : "❌"}\nFacebook: ${fbOk ? "✅" : "❌"}`;
    await enviarTexto(NUMERO_AUGUSTO, msg);
    console.log(`[Reels] ✅ Notificação de publicação enviada: ${veiculo}`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[Reels] Erro notificação:", e.message);
    res.status(500).json({ erro: e.message });
  }
});
const TEMPLATES_STORY = ["golf_fipe", "gol_completo", "ford_ka_negocio", "aircross_grid"];
const DIAS_SEM_REPETIR = 5;
function embaralhar(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
app.get("/painel/stories/sortear-veiculos", async (req, res) => {
  try {
    const limiteData = new Date(Date.now() - DIAS_SEM_REPETIR * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentes, error: erroRecentes } = await supabase
      .from("stories_publicados")
      .select("veiculo_id")
      .gte("publicado_em", limiteData);
    if (erroRecentes) throw erroRecentes;
    const idsExcluidos = (recentes || []).map(r => r.veiculo_id).filter(Boolean);
    let query = supabase
      .from("veiculos")
      .select("*")
      .eq("status", "disponivel")
      .eq("publicado", true);
    if (idsExcluidos.length > 0) {
      query = query.not("id", "in", `(${idsExcluidos.join(",")})`);
    }
    const { data: veiculos, error: erroVeiculos } = await query;
    if (erroVeiculos) throw erroVeiculos;
    let pool = veiculos || [];
    if (pool.length < 4) {
      const { data: todosDisponiveis } = await supabase
        .from("veiculos")
        .select("*")
        .eq("status", "disponivel")
        .eq("publicado", true);
      const idsJaNoPool = new Set(pool.map(v => v.id));
      const extras = (todosDisponiveis || []).filter(v => !idsJaNoPool.has(v.id));
      pool = [...pool, ...embaralhar(extras)];
    }
    const sorteados = embaralhar(pool).slice(0, 4);
    const modelosSorteados = embaralhar(TEMPLATES_STORY);
    const resultado = sorteados.map((v, i) => ({
      veiculo: v,
      template: modelosSorteados[i % modelosSorteados.length],
    }));
    res.json({ ok: true, total: resultado.length, itens: resultado });
  } catch (e) {
    console.error("[Stories] Erro ao sortear veiculos:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});
app.post("/painel/stories/registrar", async (req, res) => {
  try {
    const { veiculo_id, modelo_usado, instagram_ok, facebook_ok, veiculo_titulo } = req.body;
    if (!veiculo_id) return res.status(400).json({ ok: false, erro: "veiculo_id e obrigatorio" });
    const igOk = instagram_ok === true || instagram_ok === "true";
    const fbOk = facebook_ok === true || facebook_ok === "true";
    const { error } = await supabase.from("stories_publicados").insert({
      veiculo_id,
      modelo_usado: modelo_usado || null,
      instagram_ok: igOk,
      facebook_ok: fbOk,
    });
    if (error) throw error;
    const msg = `📸 *Story publicado!*\nVeiculo: *${veiculo_titulo || veiculo_id}*\nModelo: ${modelo_usado || "?"}\nInstagram: ${igOk ? "✅" : "❌"}\nFacebook: ${fbOk ? "✅" : "❌"}`;
    await enviarTexto(NUMERO_AUGUSTO, msg);
    res.json({ ok: true });
  } catch (e) {
    console.error("[Stories] Erro ao registrar publicacao:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});
app.post("/painel/alertas/visto", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ erro: "ID inválido" });
  try {
    await supabase.from("alertas_pendentes").update({ visualizado: true }).eq("id", id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
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

    let referralCliente = null;
    try {
      const { data: dataCliente } = await supabase.from("clientes").select("anuncio_referral").eq("telefone", tel).limit(1);
      referralCliente = dataCliente?.[0]?.anuncio_referral || null;
    } catch (e) { }

    let avisoErro = '';
    if (erro === 'janela24h') {
      avisoErro = '<div style="background:#3a1a00;color:#f0a500;padding:10px 14px;font-size:12px;border-bottom:1px solid #f0a500">⚠️ Não enviado: faz mais de 24h que o cliente não escreve. Use um template aprovado ou espere ele mandar mensagem.</div>';
    } else if (erro === '1') {
      avisoErro = '<div style="background:#3a0a0a;color:#f44336;padding:10px 14px;font-size:12px;border-bottom:1px solid #f44336">⚠️ Erro ao enviar a mensagem. Tente de novo.</div>';
    }

    let msgsHtml = mensagens.map(m => {
      const tipo = m.tipo || 'client';
      const hora = m.criado_em ? new Date(m.criado_em).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '';
      const alinha = tipo === 'client' || tipo === 'client_foto' ? 'flex-start' : 'flex-end';
      const bg = (tipo === 'client' || tipo === 'client_foto') ? '#1e1e1e' : tipo === 'sara' || tipo === 'sara_fotos' ? '#1a3a1a' : tipo === 'sistema' ? '#1a1a2e' : '#2a1a00';
      const cor = (tipo === 'client' || tipo === 'client_foto') ? '#ddd' : tipo === 'sara' || tipo === 'sara_fotos' ? '#b8e6b8' : tipo === 'sistema' ? '#555' : '#f0c060';
      const label = (tipo === 'client' || tipo === 'client_foto') ? '👤 Cliente' : tipo === 'sara' || tipo === 'sara_fotos' ? '🤖 Sarah' : tipo === 'sistema' ? '⚙️ Sistema' : '⚡ Você';

      let conteudo = '';
      if (tipo === 'sara_fotos') {
        try {
          const dados = JSON.parse(m.texto || '{}');
          const modelo = dados.modelo || 'Veículo';
          const urlsFotos = dados.fotos || [];
          conteudo = '<div style="padding:8px 0">' +
            '<div style="font-size:11px;color:#81c784;margin-bottom:6px">📸 ' + urlsFotos.length + ' foto(s) do ' + String(modelo).replace(/</g,'&lt;') + ' enviadas</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:4px">' +
            urlsFotos.map(url =>
              '<a href="' + url + '" target="_blank">' +
              '<img src="' + url + '" style="width:80px;height:60px;object-fit:cover;border-radius:4px" onerror="this.style.display=\'none\'">' +
              '</a>'
            ).join('') +
            '</div></div>';
        } catch(e) {
          conteudo = '<div style="color:#81c784;font-size:12px">📸 Fotos enviadas</div>';
        }
      } else if (tipo === 'client_foto') {
        try {
          const dados = JSON.parse(m.texto || '{}');
          const caption = dados.caption ? '<div style="font-size:11px;color:#aaa;margin-top:4px">' + String(dados.caption).replace(/</g,'&lt;') + '</div>' : '';
          if (dados.url) {
            conteudo = '<img src="' + dados.url + '" style="max-width:100%;border-radius:6px;display:block" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'block\'">' +
              '<div style="display:none;color:#888;font-size:12px">📷 Foto (URL expirada)</div>' + caption;
          } else {
            conteudo = '<div style="color:#888;font-size:12px">📷 Foto recebida' + (dados.caption ? ': ' + dados.caption : '') + '</div>';
          }
        } catch(e) {
          conteudo = '<div style="color:#888;font-size:12px">📷 Foto recebida</div>';
        }
      } else if (tipo === 'sistema') {
        conteudo = '<div style="font-size:10px;color:#555;font-style:italic">' + String(m.texto || '').replace(/</g,'&lt;').substring(0, 100) + '...</div>';
      } else {
        conteudo = '<div style="background:' + bg + ';color:' + cor + ';padding:8px 11px;border-radius:10px;font-size:13px;line-height:1.5">' + String(m.texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>') + '</div>';
      }

      let statusIcone = '';
      if (tipo !== 'client' && tipo !== 'client_foto' && tipo !== 'sistema' && m.wamid) {
        const statusMap = {
          enviado: { icone: '✓', cor: '#888' },
          sent: { icone: '✓', cor: '#888' },
          delivered: { icone: '✓✓', cor: '#888' },
          read: { icone: '✓✓', cor: '#53bdeb' },
          failed: { icone: '❌', cor: '#f44336' }
        };
        const s = statusMap[m.status_entrega] || statusMap.enviado;
        statusIcone = ' <span style="color:' + s.cor + '">' + s.icone + '</span>';
        if (m.status_entrega === 'failed' && m.motivo_erro) {
          statusIcone += '<div style="font-size:10px;color:#f44336;margin-top:2px">⚠️ ' + String(m.motivo_erro).replace(/</g,'&lt;') + '</div>';
        }
      }

      if (tipo === 'sistema') return '';

      return '<div style="display:flex;justify-content:' + alinha + ';margin-bottom:8px">' +
        '<div style="max-width:82%">' +
        '<div style="font-size:9px;color:#555;margin-bottom:2px;text-align:' + (alinha==='flex-start'?'left':'right') + '">' + label + '</div>' +
        (tipo === 'client_foto' ? conteudo : conteudo) +
        '<div style="font-size:9px;color:#444;margin-top:2px;text-align:' + (alinha==='flex-start'?'left':'right') + '">' + hora + statusIcone + '</div>' +
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
      '<div style="flex:1"><div style="font-size:14px;font-weight:600">' + formatado + '</div></div>' +
      '<button onclick="document.getElementById(\'form-template\').style.display=\'flex\'" style="background:#1a1a1a;color:#f0a500;border:1px solid #f0a500;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer">📋 Template</button>' +
      '<button onclick="document.getElementById(\'form-fotos\').style.display=\'flex\'" style="background:#1a1a1a;color:#81c784;border:1px solid #81c784;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer">📸 Fotos</button>' +
      '<button onclick="document.getElementById(\'form-video\').style.display=\'flex\'" style="background:#1a1a1a;color:#64b5f6;border:1px solid #64b5f6;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer">🎥 Vídeo</button>' +
      '</header>' +
      (referralCliente ? '<div style="background:#0d1f2d;color:#64b5f6;padding:8px 14px;font-size:11px;border-bottom:1px solid #1a3a52">📢 Veio de anúncio: ' + String(referralCliente).replace(/</g,'&lt;') + '</div>' : '') +
      '<form id="form-fotos" action="/painel/enviar-fotos" method="POST" style="display:none;padding:10px 14px;background:#1a2a1a;border-bottom:1px solid #81c784;gap:8px;flex-direction:column">' +
      '<input type="hidden" name="tel" value="' + tel + '">' +
      '<label style="font-size:11px;color:#81c784">Selecione o veículo para enviar as fotos:</label>' +
      '<select name="modelo_id" required style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;color:#fff;padding:8px;font-size:13px">' +
      '<option value="">-- Selecione --</option>' +
      estoqueAtual.filter(v => v.fotos?.length > 0).map(v =>
        '<option value="' + (v.id || limparTexto(v.modelo || '') + '_' + (v.ano || '')) + '">' +
        limparTexto(v.modelo || '') + ' ' + (v.ano || '') + ' — ' + Number(v.km || 0).toLocaleString('pt-BR') + ' km — R$ ' + Number(v.preco || 0).toLocaleString('pt-BR') +
        '</option>'
      ).join('') +
      '</select>' +
      '<button type="submit" style="background:#81c784;color:#000;border:none;border-radius:6px;padding:8px;font-size:13px;font-weight:700;cursor:pointer">Enviar fotos pelo WhatsApp</button>' +
      '</form>' +
      '<form id="form-template" action="/painel/template" method="POST" style="display:none;padding:10px 14px;background:#1a1500;border-bottom:1px solid #f0a500;gap:8px;flex-direction:column">' +
      '<input type="hidden" name="tel" value="' + tel + '">' +
      '<label style="font-size:11px;color:#f0a500">Veículo de interesse (para preencher o template):</label>' +
      '<input type="text" name="veiculo" placeholder="ex: Polo 1.0 MPI" value="' + (referralCliente ? String(referralCliente).replace(/"/g,'&quot;') : '') + '" required style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;color:#fff;padding:8px;font-size:13px">' +
      '<button type="submit" style="background:#f0a500;color:#000;border:none;border-radius:6px;padding:8px;font-size:13px;font-weight:700;cursor:pointer">Enviar template de retomada</button>' +
      '</form>' +
      '<form id="form-video" action="/painel/enviar-video" method="POST" enctype="multipart/form-data" style="display:none;padding:10px 14px;background:#0d1f2d;border-bottom:1px solid #64b5f6;gap:8px;flex-direction:column">' +
      '<input type="hidden" name="tel" value="' + tel + '">' +
      '<label style="font-size:11px;color:#64b5f6">Selecione o vídeo (MP4, máx. 16MB):</label>' +
      '<input type="file" name="video" accept="video/mp4,video/3gpp" required style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;color:#fff;padding:8px;font-size:13px">' +
      '<input type="text" name="legenda" placeholder="Legenda (opcional)" style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;color:#fff;padding:8px;font-size:13px">' +
      '<button type="submit" style="background:#64b5f6;color:#000;border:none;border-radius:6px;padding:8px;font-size:13px;font-weight:700;cursor:pointer">Enviar vídeo pelo WhatsApp</button>' +
      '</form>' +
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

app.post("/painel/enviar-fotos", async (req, res) => {
  const { tel, modelo_id } = req.body;
  if (!tel || !modelo_id) return res.redirect("/painel/lista");

  const veiculo = estoqueAtual.find(v => {
    const idGerado = (v.id || limparTexto(v.modelo || '') + '_' + (v.ano || ''));
    return String(idGerado) === String(modelo_id);
  });

  if (!veiculo) {
    console.log(`[Painel Fotos] Veículo ID "${modelo_id}" não encontrado`);
    return res.redirect("/painel/chat/" + tel + "?erro=1");
  }
  if (!veiculo.fotos?.length) {
    console.log(`[Painel Fotos] Veículo (${veiculo.modelo}) sem fotos`);
    return res.redirect("/painel/chat/" + tel + "?erro=1");
  }
  try {
    console.log(`[Painel Fotos] Enviando ${veiculo.fotos.length} fotos do ${veiculo.modelo} para ${tel}`);
    await enviarFotosVeiculo(tel, veiculo);
    if (!conversas[tel]) conversas[tel] = [];
    conversas[tel].push({ role: "user", content: `[Sistema: fotos enviadas do ${limparTexto(veiculo.modelo)} pelo consultor via painel]` });
    res.redirect("/painel/chat/" + tel);
  } catch (e) {
    console.error("[Painel Fotos] Erro:", e.message);
    res.redirect("/painel/chat/" + tel + "?erro=1");
  }
});

app.post("/painel/enviar-video", uploadMiddleware.single("video"), async (req, res) => {
  const { tel, legenda } = req.body;
  if (!tel || !req.file) return res.redirect("/painel/lista");
  try {
    const nomeArquivo = `videos/${Date.now()}_${tel}.mp4`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("veiculos")
      .upload(nomeArquivo, req.file.buffer, {
        contentType: req.file.mimetype || "video/mp4",
        upsert: false
      });
    if (uploadError) throw new Error("Erro no upload: " + uploadError.message);

    const { data: urlData } = supabase.storage.from("veiculos").getPublicUrl(nomeArquivo);
    const videoUrl = urlData.publicUrl;
    console.log(`[Vídeo] Upload concluído: ${videoUrl}`);

    const corpo = {
      messaging_product: "whatsapp",
      to: tel,
      type: "video",
      video: { link: videoUrl }
    };
    if (legenda) corpo.video.caption = legenda;
    await enviarWhatsApp(tel, corpo);

    await salvarMensagem(tel, "intervencao", `[Vídeo enviado: ${legenda || videoUrl}]`);
    if (!conversas[tel]) conversas[tel] = [];
    conversas[tel].push({ role: "assistant", content: `[Sistema: vídeo enviado pelo consultor via painel]` });
    console.log(`[Vídeo] ✅ Enviado para ${tel}`);
    res.redirect("/painel/chat/" + tel);
  } catch(e) {
    console.error("[Vídeo] Erro:", e.message);
    res.redirect("/painel/chat/" + tel + "?erro=1");
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

app.post("/painel/iniciar-contato", async (req, res) => {
  const { telefone, veiculo } = req.body;
  if (!telefone) return res.status(400).json({ erro: "Telefone obrigatório" });
  try {
    const veiculoTexto = veiculo || "nossos veículos";
    let enviou = await enviarMensagemTemplate(telefone, "boas_vindas_lead", [veiculoTexto]);
    if (!enviou) {
      enviou = await enviarMensagemTemplate(telefone, TEMPLATE_FOLLOWUP, [veiculoTexto]);
    }
    if (enviou) {
      console.log(`[Contato Manual] ✅ Template enviado para ${telefone} — ${veiculoTexto}`);
      const textoRegistro = `[Template de contato manual enviado: ${veiculoTexto}]`;
      await salvarMensagem(telefone, "intervencao", textoRegistro);
      await atualizarEstagio(telefone, "quente", veiculoTexto);
      if (!conversas[telefone]) conversas[telefone] = [];
      conversas[telefone].push({ role: "assistant", content: textoRegistro });
      res.json({ ok: true });
    } else {
      console.error(`[Contato Manual] ❌ Falha ao enviar para ${telefone}`);
      res.status(500).json({ erro: "Falha ao enviar template — verifique se o número tem WhatsApp" });
    }
  } catch(e) {
    console.error("[Contato Manual] Erro:", e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.post("/painel/template", async (req, res) => {
  const { tel, veiculo } = req.body;
  if (!tel || !veiculo) return res.redirect("/painel/chat/" + (tel || ""));
  try {
    const enviou = await enviarMensagemTemplate(tel, TEMPLATE_FOLLOWUP, [veiculo]);
    if (enviou) {
      const textoRegistro = `[Template ${TEMPLATE_FOLLOWUP} enviado manualmente: ${veiculo}]`;
      if (!conversas[tel]) conversas[tel] = [];
      conversas[tel].push({ role: "assistant", content: textoRegistro });
      await salvarMensagem(tel, "intervencao", textoRegistro);
      return res.redirect("/painel/chat/" + tel);
    } else {
      return res.redirect("/painel/chat/" + tel + "?erro=1");
    }
  } catch (e) {
    console.error("[Painel] Erro ao enviar template manual:", e.message);
    return res.redirect("/painel/chat/" + tel + "?erro=1");
  }
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
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);

    const { data: msgsCliente, count } = await supabase
      .from("mensagens")
      .select("id", { count: "exact" })
      .eq("tipo", "client")
      .gte("criado_em", inicioMes.toISOString());

    const totalMensagensCliente = count || 0;

    const SONNET_INPUT_TOKENS = 2000;
    const SONNET_OUTPUT_TOKENS = 150;
    const HAIKU_INPUT_TOKENS = 300;
    const HAIKU_OUTPUT_TOKENS = 50;

    const SONNET_INPUT_PRICE = 3.00;
    const SONNET_OUTPUT_PRICE = 15.00;
    const HAIKU_INPUT_PRICE = 0.80;
    const HAIKU_OUTPUT_PRICE = 4.00;

    const custoSonnetInput = (totalMensagensCliente * SONNET_INPUT_TOKENS / 1_000_000) * SONNET_INPUT_PRICE;
    const custoSonnetOutput = (totalMensagensCliente * SONNET_OUTPUT_TOKENS / 1_000_000) * SONNET_OUTPUT_PRICE;
    const custoHaikuInput = (totalMensagensCliente * HAIKU_INPUT_TOKENS / 1_000_000) * HAIKU_INPUT_PRICE;
    const custoHaikuOutput = (totalMensagensCliente * HAIKU_OUTPUT_TOKENS / 1_000_000) * HAIKU_OUTPUT_PRICE;

    const custoTotalUSD = custoSonnetInput + custoSonnetOutput + custoHaikuInput + custoHaikuOutput;
    const cotacaoUSDBRL = 5.50;

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
