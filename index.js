const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const app = express();
app.use(express.json());
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

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const INSTAGRAM_ACCOUNT_ID = "17841407009898490";
const NUMERO_AUGUSTO = process.env.NUMERO_AUGUSTO || "5551993716729";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log("SUPABASE_URL:", SUPABASE_URL);
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
// { telefone: { etapa: 'nome'|'cpf'|'nascimento'|'completo', nome, cpf, nascimento } }
const coletaCredito = {};

// Desconto pendente: { telefone, info, timestamp }
// Guarda apenas UM por vez (o mais recente)
let descontoPendente = null;

// Fila de processamento por telefone — evita race condition quando
// o cliente manda 2+ mensagens em sequência rápida
const filaProcessamento = {};

async function processarMensagemNaFila(from, text) {
  // Se já existe processamento em andamento para esse número, encadeia
  const anterior = filaProcessamento[from] || Promise.resolve();
  const atual = anterior
    .catch(() => {}) // não deixa erro anterior travar a fila
    .then(() => processarMensagem(from, text));
  filaProcessamento[from] = atual;
  return atual;
}

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
    "analise de credito", "consultar meu nome", "consultar meu cpf"
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
  // Aceita formatos: 01/01/1990, 01-01-1990, 1 de janeiro de 1990, etc.
  const matchBarra = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (matchBarra) {
    let [, dia, mes, ano] = matchBarra;
    if (ano.length === 2) ano = (parseInt(ano) > 30 ? "19" : "20") + ano;
    dia = dia.padStart(2, "0");
    mes = mes.padStart(2, "0");
    return `${dia}/${mes}/${ano}`;
  }
  return null;
}

async function notificarDadosCredito(telefone, dados) {
  const numero = telefone.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : telefone;
  const msg = `📋 *Simulação de crédito solicitada*
Cliente: ${formatado}
Nome: *${dados.nome}*
CPF: *${dados.cpf}*
Nascimento: *${dados.nascimento}*
${dados.veiculo ? `Veículo de interesse: *${dados.veiculo}*` : "Veículo de interesse: não identificado"}
${dados.entrada ? `Valor de entrada: *${dados.entrada}*` : "Entrada: à combinar"}

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

    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: msgConsultor } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Desconto] ✅ Consultor notificado`);
    return true;
  } catch (e) {
    console.error("[Desconto] Erro:", e.message);
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
    return { marcaTroca: null, modeloTroca: null, anoTroca: null, modeloBuscado: null, anoBuscado: null };
  }
}

// ─────────────────────────────────────────────
// SUPABASE — MENSAGENS
// ─────────────────────────────────────────────

async function salvarMensagem(telefone, tipo, texto) {
  try {
    console.log(`[Supabase] Salvando: ${telefone} | ${tipo}`);
    const { error } = await supabase.from("mensagens").insert({
      telefone, tipo, texto: String(texto).substring(0, 500)
    });
    if (error) console.error("[Supabase] ❌ Erro insert:", error.message);
    else console.log(`[Supabase] ✅ Salvo: ${telefone} | ${tipo}`);
    const { error: e2 } = await supabase.from("clientes").upsert({
      telefone, ultima_interacao: new Date().toISOString()
    }, { onConflict: "telefone" });
    if (e2) console.error("[Supabase] ❌ Erro upsert:", e2.message);
  } catch (e) { console.error("[Supabase] ❌ Exceção:", e.message); }
}

async function buscarMensagens(telefone) {
  try {
    const { data } = await supabase.from("mensagens").select("*").eq("telefone", telefone).order("criado_em", { ascending: true }).limit(100);
    return data || [];
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
  if (t.includes("vou aí") || t.includes("vou até") || t.includes("passo aí") || t.includes("apareço") || t.includes("vou na loja") || t.includes("vou ir") || t.includes("vou visitar")) { await atualizarEstagio(from, "visita_agendada"); return; }
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

async function gerarMensagemFollowUp(followup) {
  try {
    const veiculo = followup.veiculo_interesse || "nossos veículos";
    const prompts = {
      vai_pensar: `Você é Sarah, vendedora da Premium Automarcas. Cliente interessado em ${veiculo} disse que ia pensar. Mensagem curta e calorosa, sem pressionar. Máximo 3 linhas.`,
      achou_caro: `Você é Sarah, vendedora da Premium Automarcas. Cliente achou ${veiculo} caro. Pergunte qual parcela cabe no orçamento. Máximo 3 linhas.`,
      avaliacao_baixa: `Você é Sarah, vendedora da Premium Automarcas. Cliente insatisfeito com avaliação na troca. Reforce que avaliação presencial pode surpreender. Máximo 3 linhas.`,
      sem_interesse: `Você é Sarah, vendedora da Premium Automarcas. Cliente sem interesse. Mensagem muito leve. Máximo 2 linhas.`,
      sumiu: `Você é Sarah, vendedora da Premium Automarcas. Cliente parou de responder sobre ${veiculo}. Mensagem curta para retomar. Máximo 2 linhas.`
    };
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5", max_tokens: 150, messages: [{ role: "user", content: prompts[followup.motivo] || prompts.vai_pensar }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    return res.data.content[0].text;
  } catch (e) { return null; }
}

async function processarFollowUpsPendentes() {
  try {
    const { data: followups } = await supabase.from("followups").select("*").eq("enviado", false).lte("agendado_para", new Date().toISOString());
    if (!followups?.length) return;
    for (const followup of followups) {
      const mensagem = await gerarMensagemFollowUp(followup);
      if (!mensagem) continue;
      try {
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: followup.telefone, text: { body: mensagem } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
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

async function analisarImagem(mediaId, caption) {
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
    return res.data.content[0].text;
  } catch (e) { return null; }
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
  return estoqueAtual.map(v => `${limparTexto(v.modelo || "")} ${v.ano || ""} - ${Number(v.km || 0).toLocaleString("pt-BR")} km - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`).join("\n");
}

const SYSTEM_PROMPT = (fipeInfo, aprendizadosExtra = "", carroNaoDisponivel = null, descontoPendenteAtivo = false) => {
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

REGRA CRÍTICA DE PREÇOS:
- Use EXATAMENTE os preços do estoque acima. NUNCA invente, estime ou arredonde.
- Se o cliente perguntar o preço, copie o valor exato do estoque.
- JAMAIS informe um preço diferente do que está listado acima.

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
Etapa 2: Agradeça as fotos
Etapa 3 (só após tudo): ${fipeInfo ? (() => { const v = calcularValoresTroca(fipeInfo.Valor); return `"Conseguimos trabalhar entre R$ ${v.minimoFormatado} e R$ ${v.maximoFormatado} na troca. Avaliação final é presencial!" NÃO mencione FIPE.`; })() : "NUNCA invente valores de troca."}

QUANDO ACHAR CARO: Pergunte qual parcela cabe no orçamento e tente adaptar.
QUANDO DISSER "VOU PENSAR": Pergunte o que ficou na dúvida antes de encerrar.

FINANCIAMENTO: Taxa 1,8%/mês. PMT = PV × (i×(1+i)^n)/((1+i)^n-1). Só simule se cliente pedir.

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
        role: m.tipo === "client" ? "user" : "assistant",
        content: m.texto || ""
      }));
    }

    const msgSistema = `[Sistema: resultado da simulação de crédito chegou: "${resultado}". Informe ao cliente de forma natural e entusiasta (se aprovado) ou acolhedora (se negado), sem citar nomes da equipe. Convide para vir à loja fechar o negócio se aprovado.]`;
    conversas[telefoneCliente].push({ role: "user", content: msgSistema });

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

  // Retoma conversa com o cliente
  const msgSistema = autorizado
    ? `[Sistema: nosso consultor autorizou o desconto. Informe ao cliente que conseguimos fazer uma condição especial e tente fechar o negócio. Seja entusiasta mas natural!]`
    : `[Sistema: nosso consultor não autorizou o desconto. Informe ao cliente que infelizmente o preço está firme, mas tente manter o interesse com outras vantagens como IPVA pago, facilidade de financiamento, etc. Não mencione nomes.]`;

  if (!conversas[telefoneCliente]) conversas[telefoneCliente] = [];
  conversas[telefoneCliente].push({ role: "user", content: msgSistema });

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
  return true;
}

// ─────────────────────────────────────────────
// PROCESSAMENTO PRINCIPAL
// ─────────────────────────────────────────────

async function processarMensagem(from, text) {
  if (!text || typeof text !== "string") return;

  // Verifica se é comando do consultor
  if (await processarComandoConsultor(from, text)) return;

  ultimaMensagemCliente[from] = Date.now();
  const primeiraVez = !ultimaNotificacao[from];

  // Carregar histórico do Supabase se não tem em memória (após reinício/deploy)
  if (!conversas[from]) {
    try {
      const msgs = await buscarMensagens(from);
      if (msgs.length > 0) {
        conversas[from] = msgs.slice(-20).map(m => ({
          role: m.tipo === "client" ? "user" : "assistant",
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

  conversas[from].push({ role: "user", content: text });

  await salvarMensagem(from, "client", text);
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
      const entradaValor = semEntrada.some(p => tEntrada === p || tEntrada.includes(p)) ? "Sem entrada" : text.trim();

      estado.entrada = entradaValor;

      // Tenta identificar o veículo de interesse a partir de todo o histórico da conversa
      const veiculoInteresse = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
      const nomeVeiculo = veiculoInteresse ? `${limparTexto(veiculoInteresse.modelo)} ${veiculoInteresse.ano || ""}`.trim() : null;

      // Coleta completa — notifica e salva
      const dadosFinais = {
        nome: estado.nome, cpf: estado.cpf, nascimento: estado.nascimento,
        entrada: estado.entrada, veiculo: nomeVeiculo
      };
      delete coletaCredito[from];

      await notificarDadosCredito(from, dadosFinais);
      await salvarSimulacaoCredito(from, dadosFinais);
      await atualizarEstagio(from, "negociacao", nomeVeiculo);

      const msg = `Perfeito, ${dadosFinais.nome.split(" ")[0]}! Já encaminhei seus dados pra nossa equipe fazer a simulação nas financeiras. Assim que tiver o resultado, te aviso aqui! 😊`;
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
    const encontrado = estoqueAtual.some(v => limparTexto(v.modelo || "").toLowerCase().includes(modeloBuscado.toLowerCase()));
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
  const claude = await axios.post("https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT(fipeInfo, aprendizadosExtra, carroNaoDisponivel, clienteAindaTemPendente),
      messages: conversas[from]
    },
    { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
  );

  const reply = claude.data.content[0].text;
  conversas[from].push({ role: "assistant", content: reply });

  await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: from, text: { body: reply } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );

  console.log(`Resposta para ${from}: ${reply}`);
  await salvarMensagem(from, "sara", reply);
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

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (body.object === "whatsapp_business_account") {
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
        const analise = await analisarImagem(msg.image.id, caption);
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
      { messaging_product: "whatsapp", pin: "123456" },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.send("Registrado! " + JSON.stringify(result.data));
  } catch (e) { res.send("Erro: " + JSON.stringify(e.response?.data)); }
});

// ─────────────────────────────────────────────
// PAINEL CRM — PWA
// ─────────────────────────────────────────────

app.get("/painel", (req, res) => {
  const numPendencias = descontoPendente ? 1 : 0;
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#f0a500">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sarah CRM">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>Sarah CRM — Premium Automarcas</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0a0a0a; color:#e0e0e0; height:100vh; height:100dvh; display:flex; flex-direction:column; overflow:hidden; }
header { background:#111; border-bottom:1px solid #222; padding:10px 16px; padding-top:max(10px, env(safe-area-inset-top)); display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
header h1 { font-size:15px; color:#fff; font-weight:700; }
header h1 span { color:#f0a500; }
.header-right { display:flex; align-items:center; gap:10px; }
.status { display:flex; align-items:center; gap:5px; font-size:11px; color:#888; }
.dot { width:6px; height:6px; border-radius:50%; background:#4caf50; animation:pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
.nav-tabs { display:flex; gap:3px; }
.nav-tab { padding:5px 12px; border-radius:6px; font-size:11px; cursor:pointer; color:#888; border:1px solid transparent; transition:all 0.15s; }
.nav-tab.active { background:#1e1e1e; color:#f0a500; border-color:#333; }
.view { display:none; flex:1; overflow:hidden; flex-direction:column; }
.view.active { display:flex; }
.kanban { display:flex; gap:10px; padding:12px; overflow-x:auto; flex:1; -webkit-overflow-scrolling:touch; }
.kanban::-webkit-scrollbar { height:4px; }
.kanban::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
.coluna { min-width:200px; max-width:200px; background:#111; border-radius:10px; display:flex; flex-direction:column; border:1px solid #1e1e1e; flex-shrink:0; }
.coluna-header { padding:9px 11px 7px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #1a1a1a; }
.coluna-titulo { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; }
.coluna-count { font-size:10px; background:#1e1e1e; padding:1px 6px; border-radius:8px; color:#888; }
.coluna-quente { border-top:2px solid #ff6b35; } .coluna-quente .coluna-titulo { color:#ff6b35; }
.coluna-negociacao { border-top:2px solid #f0a500; } .coluna-negociacao .coluna-titulo { color:#f0a500; }
.coluna-aguardando { border-top:2px solid #64b5f6; } .coluna-aguardando .coluna-titulo { color:#64b5f6; }
.coluna-visita { border-top:2px solid #81c784; } .coluna-visita .coluna-titulo { color:#81c784; }
.coluna-frio { border-top:2px solid #90a4ae; } .coluna-frio .coluna-titulo { color:#90a4ae; }
.coluna-fechado { border-top:2px solid #ce93d8; } .coluna-fechado .coluna-titulo { color:#ce93d8; }
.coluna-cards { flex:1; overflow-y:auto; padding:7px; display:flex; flex-direction:column; gap:6px; -webkit-overflow-scrolling:touch; }
.card { background:#161616; border-radius:8px; padding:9px 10px; border:1px solid #1e1e1e; cursor:pointer; transition:all 0.15s; }
.card:active { background:#1e1e1e; transform:scale(0.98); }
.card-phone { font-size:12px; font-weight:600; color:#fff; margin-bottom:2px; }
.card-veiculo { font-size:10px; color:#f0a500; margin-bottom:2px; }
.card-preview { font-size:10px; color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:5px; }
.card-tempo { font-size:9px; color:#444; }
.card-acoes { display:flex; gap:4px; margin-top:6px; }
.card-btn { font-size:10px; padding:4px 7px; border-radius:5px; border:none; cursor:pointer; font-weight:500; }
.card-btn-chat { background:#1e2a1e; color:#81c784; }
.card-btn-followup { background:#1a1e2a; color:#64b5f6; }
.card-btn-mover { background:#1e1e1e; color:#888; }
.chat-view { flex:1; display:flex; overflow:hidden; }
.chat-sidebar { width:240px; background:#111; border-right:1px solid #1e1e1e; display:flex; flex-direction:column; flex-shrink:0; }
.chat-sidebar-header { padding:9px 13px; font-size:10px; color:#666; text-transform:uppercase; letter-spacing:1px; border-bottom:1px solid #1a1a1a; }
.conv-list { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
.conv-item { padding:9px 12px; cursor:pointer; border-bottom:1px solid #141414; transition:background 0.15s; }
.conv-item:active { background:#1a1a1a; }
.conv-item.active { background:#1a2a1a; border-left:3px solid #f0a500; }
.conv-item.unread { border-left:3px solid #f44336; }
.conv-phone { font-size:12px; font-weight:600; color:#fff; }
.conv-preview { font-size:10px; color:#555; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.conv-time { font-size:9px; color:#444; margin-top:1px; }
.conv-badge { display:inline-block; background:#f44336; color:#fff; font-size:9px; padding:1px 4px; border-radius:8px; margin-left:3px; }
.chat-main { flex:1; display:flex; flex-direction:column; min-width:0; }
.chat-header { padding:9px 14px; background:#111; border-bottom:1px solid #1e1e1e; display:flex; align-items:center; justify-content:space-between; }
.chat-phone { font-size:13px; font-weight:600; }
.chat-actions { display:flex; gap:4px; flex-wrap:wrap; }
.btn { padding:5px 10px; border-radius:6px; border:none; cursor:pointer; font-size:11px; font-weight:500; transition:opacity 0.15s; }
.btn:active { opacity:0.7; }
.btn-primary { background:#f0a500; color:#000; }
.btn-danger { background:#f44336; color:#fff; }
.btn-secondary { background:#222; color:#fff; }
.btn-blue { background:#1565c0; color:#fff; }
.messages { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:6px; -webkit-overflow-scrolling:touch; }
.msg { max-width:80%; }
.msg.client { align-self:flex-start; }
.msg.sara, .msg.intervencao { align-self:flex-end; }
.msg-bubble { padding:8px 11px; border-radius:10px; font-size:13px; line-height:1.5; word-break:break-word; }
.msg.client .msg-bubble { background:#1e1e1e; color:#ddd; border-bottom-left-radius:3px; }
.msg.sara .msg-bubble { background:#1a3a1a; color:#b8e6b8; border-bottom-right-radius:3px; }
.msg.intervencao .msg-bubble { background:#2a1a00; color:#f0c060; border-bottom-right-radius:3px; border:1px solid #f0a500; }
.msg-meta { font-size:9px; color:#444; margin-top:2px; }
.msg.sara .msg-meta, .msg.intervencao .msg-meta { text-align:right; }
.msg-label { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px; color:#555; }
.msg.sara .msg-label { color:#3a7; text-align:right; }
.msg.intervencao .msg-label { color:#f0a500; text-align:right; }
.intervention { background:#111; border-top:1px solid #1e1e1e; padding:8px 12px; padding-bottom:max(8px, env(safe-area-inset-bottom)); }
.intervention-header { font-size:10px; color:#f0a500; text-transform:uppercase; letter-spacing:1px; margin-bottom:5px; }
.intervention-input { display:flex; gap:6px; }
.intervention-input textarea { flex:1; background:#1a1a1a; border:1px solid #2a2a2a; border-radius:7px; color:#fff; padding:8px 10px; font-size:13px; resize:none; height:44px; font-family:inherit; }
.intervention-input textarea:focus { outline:none; border-color:#f0a500; }
.modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:100; align-items:flex-end; justify-content:center; }
.modal-overlay.open { display:flex; }
.modal { background:#161616; border:1px solid #2a2a2a; border-radius:16px 16px 0 0; padding:16px; width:100%; max-width:500px; padding-bottom:max(16px, env(safe-area-inset-bottom)); }
.modal h3 { font-size:13px; color:#fff; margin-bottom:12px; text-align:center; }
.modal-opcoes { display:flex; flex-direction:column; gap:6px; }
.modal-opcao { padding:12px 14px; border-radius:10px; border:1px solid #2a2a2a; cursor:pointer; font-size:13px; transition:all 0.15s; }
.modal-opcao:active { background:#1a1a14; border-color:#f0a500; }
.modal-cancel { margin-top:8px; width:100%; padding:12px; background:#1e1e1e; border:none; border-radius:10px; color:#888; cursor:pointer; font-size:13px; }
.estagio-tag { display:inline-block; font-size:10px; padding:2px 7px; border-radius:8px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-top:2px; }
.tag-quente { background:#3a1a0a; color:#ff6b35; }
.tag-negociacao { background:#3a2a00; color:#f0a500; }
.tag-aguardando { background:#0a1a2a; color:#64b5f6; }
.tag-visita_agendada { background:#0a2a0a; color:#81c784; }
.tag-frio { background:#1a1e22; color:#90a4ae; }
.tag-fechado { background:#1a0a2a; color:#ce93d8; }
.empty-state { flex:1; display:flex; align-items:center; justify-content:center; color:#333; font-size:12px; }
.loading-txt { text-align:center; padding:14px; color:#444; font-size:11px; }
.pendencia-badge { background:#f0a500; color:#000; font-size:9px; padding:1px 5px; border-radius:8px; margin-left:4px; font-weight:700; }
@media (max-width: 600px) {
  .chat-sidebar { width:100%; }
  .chat-sidebar.oculta { display:none; }
  .chat-main { width:100%; }
  .chat-main.oculta { display:none; }
  .btn-voltar { display:flex !important; }
}
.btn-voltar { display:none; }
</style>
</head>
<body>
<header>
  <h1>Sarah <span>CRM</span>${numPendencias > 0 ? ' <span class="pendencia-badge">💰 ' + numPendencias + ' desconto(s)</span>' : ''}</h1>
  <div class="header-right">
    <div class="nav-tabs">
      <div class="nav-tab active" onclick="mostrarView('kanban', this)">📋 Pipeline</div>
      <div class="nav-tab" onclick="mostrarView('chat', this)">💬 Chats</div>
    </div>
    <div class="status"><div class="dot"></div><span id="statusText">...</span></div>
  </div>
</header>

<div class="view active" id="view-kanban">
  <div class="kanban" id="kanbanBoard"><div class="loading-txt">Carregando...</div></div>
</div>

<div class="view" id="view-chat">
  <div class="chat-view">
    <div class="chat-sidebar" id="chatSidebar">
      <div class="chat-sidebar-header">Conversas</div>
      <div class="conv-list" id="convList"><div class="loading-txt">Carregando...</div></div>
    </div>
    <div class="chat-main oculta" id="chatMain">
      <div class="chat-header">
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn btn-secondary btn-voltar" onclick="voltarParaLista()">←</button>
          <div>
            <div class="chat-phone" id="chatPhone">Selecione</div>
            <div id="chatEstagio"></div>
          </div>
        </div>
        <div class="chat-actions" id="chatActions" style="display:none">
          <button class="btn btn-blue" onclick="abrirModalMover()">↕</button>
          <button class="btn btn-blue" onclick="agendarFollowUpManual()">⏰</button>
          <button class="btn btn-secondary" onclick="marcarResolvido()">✓</button>
          <button class="btn btn-danger" onclick="abrirAprendizado()">💡</button>
        </div>
      </div>
      <div class="messages" id="messages"><div class="empty-state">Selecione uma conversa</div></div>
      <div class="intervention" id="interventionArea" style="display:none">
        <div class="intervention-header">⚡ Enviar como Sarah</div>
        <div class="intervention-input">
          <textarea id="interventionText" placeholder="Digite aqui..."></textarea>
          <button class="btn btn-primary" onclick="enviarIntervencao()">→</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modalMover">
  <div class="modal">
    <h3>Mover lead para...</h3>
    <div class="modal-opcoes">
      <div class="modal-opcao" onclick="moverLead('quente')">🔥 Quente</div>
      <div class="modal-opcao" onclick="moverLead('negociacao')">💬 Em negociação</div>
      <div class="modal-opcao" onclick="moverLead('aguardando')">⏳ Aguardando</div>
      <div class="modal-opcao" onclick="moverLead('visita_agendada')">📅 Visita agendada</div>
      <div class="modal-opcao" onclick="moverLead('frio')">❄️ Lead frio</div>
      <div class="modal-opcao" onclick="moverLead('fechado')">✅ Fechado!</div>
    </div>
    <button class="modal-cancel" onclick="fecharModal()">Cancelar</button>
  </div>
</div>

<script>
const API = window.location.origin;
let conversaAtiva = null;
let viewAtiva = 'kanban';
const isMobile = window.innerWidth <= 600;
const ESTAGIOS = {
  quente:{label:'🔥 Quente',classe:'tag-quente'},
  negociacao:{label:'💬 Negociação',classe:'tag-negociacao'},
  aguardando:{label:'⏳ Aguardando',classe:'tag-aguardando'},
  visita_agendada:{label:'📅 Visita agendada',classe:'tag-visita_agendada'},
  frio:{label:'❄️ Frio',classe:'tag-frio'},
  fechado:{label:'✅ Fechado',classe:'tag-fechado'}
};
const COLUNAS = [
  {id:'quente',titulo:'🔥 Quente',classe:'coluna-quente'},
  {id:'negociacao',titulo:'💬 Negociação',classe:'coluna-negociacao'},
  {id:'aguardando',titulo:'⏳ Aguardando',classe:'coluna-aguardando'},
  {id:'visita_agendada',titulo:'📅 Visita',classe:'coluna-visita'},
  {id:'frio',titulo:'❄️ Frio',classe:'coluna-frio'},
  {id:'fechado',titulo:'✅ Fechado',classe:'coluna-fechado'}
];
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
function mostrarView(view,el){viewAtiva=view;document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));document.getElementById('view-'+view).classList.add('active');if(el)el.classList.add('active');if(view==='kanban')carregarKanban();if(view==='chat'){carregarConversas();if(isMobile)mostrarSidebar();}}
function mostrarSidebar(){document.getElementById('chatSidebar').classList.remove('oculta');document.getElementById('chatMain').classList.add('oculta');}
function mostrarChat(){document.getElementById('chatSidebar').classList.add('oculta');document.getElementById('chatMain').classList.remove('oculta');}
function voltarParaLista(){conversaAtiva=null;mostrarSidebar();}
function formatarTelefone(num){const n=String(num).replace(/\D/g,'');if(n.length>=12)return'('+n.slice(2,4)+') '+n.slice(4,9)+'-'+n.slice(9);return num;}
function formatarHora(iso){if(!iso)return'';return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
async function carregarKanban(){try{const res=await fetch(API+'/crm');const data=await res.json();const board=document.getElementById('kanbanBoard');let total=0;Object.values(data).forEach(c=>total+=c.length);document.getElementById('statusText').textContent=total+' leads';board.innerHTML=COLUNAS.map(col=>{const cards=data[col.id]||[];return \`<div class="coluna \${col.classe}"><div class="coluna-header"><span class="coluna-titulo">\${col.titulo}</span><span class="coluna-count">\${cards.length}</span></div><div class="coluna-cards">\${cards.length===0?'<div style="padding:8px;text-align:center;color:#333;font-size:10px">Vazio</div>':cards.map(c=>\`<div class="card"><div class="card-phone">\${c.formatado}</div>\${c.veiculo?\`<div class="card-veiculo">🚗 \${c.veiculo}</div>\`:''}<div class="card-preview">\${c.ultimaMensagem||'—'}</div><div class="card-tempo">\${c.tempoLabel}</div><div class="card-acoes"><button class="card-btn card-btn-chat" onclick="abrirChatDoCard('\${c.telefone}')">💬</button><button class="card-btn card-btn-followup" onclick="followUpRapido('\${c.telefone}')">⏰</button><button class="card-btn card-btn-mover" onclick="moverRapido('\${c.telefone}')">↕</button></div></div>\`).join('')}</div></div>\`;}).join('');}catch(e){document.getElementById('statusText').textContent='Erro';}}
async function abrirChatDoCard(telefone){viewAtiva='chat';document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));document.getElementById('view-chat').classList.add('active');document.querySelectorAll('.nav-tab')[1].classList.add('active');await carregarConversas();await abrirConversa(telefone);}
function moverRapido(telefone){conversaAtiva=telefone;abrirModalMover();}
async function followUpRapido(telefone){const motivo=prompt('Motivo:\n- vai_pensar\n- achou_caro\n- avaliacao_baixa\n- sem_interesse\n- sumiu');if(!motivo)return;const dias=prompt('Em quantos dias?');if(!dias)return;await fetch(API+'/painel/followup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:telefone,motivo,dias:parseInt(dias)})});alert('✅ Follow-up agendado!');}
async function carregarConversas(){try{const res=await fetch(API+'/painel/conversas');const data=await res.json();const list=document.getElementById('convList');if(!data.conversas?.length){list.innerHTML='<div class="loading-txt">Nenhuma conversa</div>';return;}list.innerHTML=data.conversas.map(c=>\`<div class="conv-item \${c.from===conversaAtiva?'active':c.naoLida>0?'unread':''}" onclick="abrirConversa('\${c.from}')"><div class="conv-phone">\${formatarTelefone(c.from)}\${c.naoLida>0?\`<span class="conv-badge">\${c.naoLida}</span>\`:''}</div><div class="conv-preview">\${c.ultimaMensagem||''}</div><div class="conv-time">\${formatarHora(c.ultimaAtividade)}</div></div>\`).join('');document.getElementById('statusText').textContent=data.conversas.length+' conv.';}catch(e){}}
async function abrirConversa(from){conversaAtiva=from;document.getElementById('chatPhone').textContent=formatarTelefone(from);document.getElementById('chatActions').style.display='flex';document.getElementById('interventionArea').style.display='block';if(isMobile)mostrarChat();await fetch(API+'/painel/visualizar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from})});try{const res=await fetch(API+'/crm');const data=await res.json();let estagio=null;Object.entries(data).forEach(([key,cards])=>{if(cards.some(c=>c.telefone===from))estagio=key;});if(estagio&&ESTAGIOS[estagio])document.getElementById('chatEstagio').innerHTML=\`<span class="estagio-tag \${ESTAGIOS[estagio].classe}">\${ESTAGIOS[estagio].label}</span>\`;}catch(e){}await carregarMensagens(from);await carregarConversas();}
async function carregarMensagens(from){try{const res=await fetch(API+'/painel/mensagens/'+from);const data=await res.json();const msgs=document.getElementById('messages');if(!data.mensagens?.length){msgs.innerHTML='<div class="empty-state">Nenhuma mensagem</div>';return;}msgs.innerHTML=data.mensagens.map(m=>\`<div class="msg \${m.tipo}"><div class="msg-label">\${m.tipo==='client'?'👤 Cliente':m.tipo==='sara'?'🤖 Sarah':'⚡ Você'}</div><div class="msg-bubble">\${(m.texto||'').replace(/\n/g,'<br>')}</div><div class="msg-meta">\${formatarHora(m.criado_em)}</div></div>\`).join('');msgs.scrollTop=msgs.scrollHeight;}catch(e){}}
async function enviarIntervencao(){if(!conversaAtiva)return;const texto=document.getElementById('interventionText').value.trim();if(!texto)return;const res=await fetch(API+'/painel/intervencao',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:conversaAtiva,texto})});if(res.ok){document.getElementById('interventionText').value='';await carregarMensagens(conversaAtiva);}}
function abrirModalMover(){if(!conversaAtiva)return;document.getElementById('modalMover').classList.add('open');}
function fecharModal(){document.getElementById('modalMover').classList.remove('open');}
async function moverLead(estagio){if(!conversaAtiva)return;await fetch(API+'/crm/mover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:conversaAtiva,estagio})});fecharModal();if(ESTAGIOS[estagio])document.getElementById('chatEstagio').innerHTML=\`<span class="estagio-tag \${ESTAGIOS[estagio].classe}">\${ESTAGIOS[estagio].label}</span>\`;carregarKanban();}
async function agendarFollowUpManual(){if(!conversaAtiva)return;const motivo=prompt('Motivo:\n- vai_pensar\n- achou_caro\n- avaliacao_baixa\n- sem_interesse\n- sumiu');if(!motivo)return;const dias=prompt('Em quantos dias?');if(!dias)return;await fetch(API+'/painel/followup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:conversaAtiva,motivo,dias:parseInt(dias)})});alert('✅ Follow-up agendado!');}
async function abrirAprendizado(){if(!conversaAtiva)return;const situacao=prompt('Descreva a situação:');if(!situacao)return;const correcao=prompt('Como a Sarah deveria responder?');if(!correcao)return;await fetch(API+'/painel/aprendizado',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({situacao,correcao})});alert('✅ Aprendizado salvo!');}
async function marcarResolvido(){if(!conversaAtiva)return;if(!confirm('Marcar como resolvido?'))return;await fetch(API+'/painel/resolver',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:conversaAtiva})});conversaAtiva=null;document.getElementById('chatPhone').textContent='Selecione';document.getElementById('chatEstagio').innerHTML='';document.getElementById('chatActions').style.display='none';document.getElementById('interventionArea').style.display='none';document.getElementById('messages').innerHTML='<div class="empty-state">Selecione uma conversa</div>';if(isMobile)mostrarSidebar();await carregarConversas();}
document.getElementById('interventionText').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();enviarIntervencao();}});
document.getElementById('modalMover').addEventListener('click',e=>{if(e.target===document.getElementById('modalMover'))fecharModal();});
async function atualizar(){if(viewAtiva==='kanban')await carregarKanban();if(viewAtiva==='chat'){await carregarConversas();if(conversaAtiva)await carregarMensagens(conversaAtiva);}}
carregarKanban();
setInterval(atualizar,8000);
</script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/painel/conversas", async (req, res) => {
  try { res.json({ conversas: await listarConversas() }); } catch (e) { res.json({ conversas: [] }); }
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
