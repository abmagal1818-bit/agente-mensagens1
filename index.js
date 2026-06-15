const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const https = require("https");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const INSTAGRAM_ACCOUNT_ID = "17841407009898490";
const SHEETS_ID = process.env.SHEETS_ID || "1zhOUFmzlwHsyCh3OuYAdZzMYN3EfKLxkVgODJxgxdYo";
const SHEETS_CREDENTIALS = process.env.GOOGLE_CREDENTIALS ? JSON.parse(process.env.GOOGLE_CREDENTIALS) : null;
const NUMERO_AUGUSTO = process.env.NUMERO_AUGUSTO || "5551993716729";

let estoqueAtual = [];
let ultimaAtualizacao = null;
const conversas = {};
const mensagensProcessadas = new Set();
const fipeCache = {};
let cacheMarcasFipe = null;
const clientesNotificados = new Set();

// Fila de fotos recebidas por cliente (para agrupar)
const filaFotos = {};

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

// ─────────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────────

async function obterTokenSheets() {
  if (!SHEETS_CREDENTIALS) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: SHEETS_CREDENTIALS.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    })).toString("base64url");
    const sign = require("crypto").createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(SHEETS_CREDENTIALS.private_key, "base64url");
    const jwtToken = `${header}.${payload}.${signature}`;
    const res = await axios.post("https://oauth2.googleapis.com/token",
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtToken}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return res.data.access_token;
  } catch (e) {
    console.error("[Sheets] Erro token:", e.message);
    return null;
  }
}

async function sheetsGet(range) {
  const token = await obterTokenSheets();
  if (!token) return null;
  try {
    const res = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.values || [];
  } catch (e) {
    console.error("[Sheets] Erro get:", e.message);
    return null;
  }
}

async function sheetsAppend(range, values) {
  const token = await obterTokenSheets();
  if (!token) return;
  try {
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[Sheets] Erro append:", e.message);
  }
}

async function sheetsUpdate(range, values) {
  const token = await obterTokenSheets();
  if (!token) return;
  try {
    await axios.put(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { values },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[Sheets] Erro update:", e.message);
  }
}

async function inicializarSheets() {
  if (!SHEETS_CREDENTIALS) { console.log("[Sheets] Sem credenciais"); return; }
  try {
    const token = await obterTokenSheets();
    if (!token) return;
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}:batchUpdate`,
      { requests: [
        { addSheet: { properties: { title: "Mensagens" } } },
        { addSheet: { properties: { title: "Aprendizados" } } }
      ]},
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    ).catch(() => {});
    await sheetsUpdate("Mensagens!A1:F1", [["Timestamp", "De", "Tipo", "Texto", "Resolvido", "Intervencao"]]);
    await sheetsUpdate("Aprendizados!A1:C1", [["Timestamp", "Situacao", "Correcao"]]);
    console.log("[Sheets] ✅ Inicializada");
  } catch (e) {
    console.error("[Sheets] Erro init:", e.message);
  }
}

async function salvarMensagemSheets(from, tipo, texto) {
  await sheetsAppend("Mensagens!A:F", [[
    new Date().toISOString(), from, tipo,
    String(texto).substring(0, 500), "nao", ""
  ]]);
}

async function buscarMensagensSheets(from) {
  const rows = await sheetsGet("Mensagens!A:F");
  if (!rows) return [];
  return rows.slice(1)
    .filter(r => r[1] === from)
    .map(r => ({ timestamp: r[0], from: r[1], tipo: r[2], texto: r[3] || "" }));
}

async function listarConversasSheets() {
  const rows = await sheetsGet("Mensagens!A:F");
  if (!rows) return [];
  const mapa = {};
  rows.slice(1).forEach(r => {
    const from = r[1];
    const resolvido = r[4] === "sim";
    if (!from || resolvido) return;
    if (!mapa[from] || r[0] > mapa[from].ultimaAtividade) {
      mapa[from] = {
        from,
        ultimaMensagem: (r[3] || "").substring(0, 50),
        ultimaAtividade: r[0],
        naoLida: (mapa[from]?.naoLida || 0) + (r[2] === "client" ? 1 : 0)
      };
    }
  });
  return Object.values(mapa).sort((a, b) => b.ultimaAtividade.localeCompare(a.ultimaAtividade));
}

async function buscarAprendizadosSheets() {
  const rows = await sheetsGet("Aprendizados!A:C");
  if (!rows) return [];
  return rows.slice(1).map(r => ({ timestamp: r[0], situacao: r[1] || "", correcao: r[2] || "" }));
}

async function formatarAprendizados() {
  const aprendizados = await buscarAprendizadosSheets();
  if (aprendizados.length === 0) return "";
  return "\n\nEXEMPLOS DE COMO RESPONDER (aprenda com esses casos):\n" +
    aprendizados.slice(-10).map(a => `Situação: ${a.situacao}\nResposta correta: ${a.correcao}`).join("\n---\n");
}

// ─────────────────────────────────────────────
// NOTIFICAÇÃO PARA AUGUSTO
// ─────────────────────────────────────────────

async function notificarAugusto(from, primeiroTexto) {
  if (clientesNotificados.has(from)) return;
  clientesNotificados.add(from);
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12
    ? `+${numero.slice(0, 2)} (${numero.slice(2, 4)}) ${numero.slice(4, 9)}-${numero.slice(9)}`
    : from;
  const mensagem = `📩 *Novo cliente na Sarah*\nNúmero: ${formatado}\nMensagem: "${primeiroTexto.substring(0, 100)}"\n\nAcesse o painel: https://agente-mensagens1.onrender.com/painel`;
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[Notificação] Erro:", e.message);
  }
}

// ─────────────────────────────────────────────
// INSTAGRAM — SINCRONIZAÇÃO DE ESTOQUE
// ─────────────────────────────────────────────

async function buscarEstoqueInstagram() {
  try {
    console.log("[Instagram] Buscando posts...");
    const url = `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media?fields=id,caption,media_type,media_url,children{media_url}&limit=50&access_token=${INSTAGRAM_TOKEN}`;
    const res = await axios.get(url);
    const posts = res.data.data || [];
    console.log(`[Instagram] ${posts.length} posts encontrados`);

    const veiculos = [];
    for (const post of posts) {
      const caption = limparTexto(post.caption || "");
      if (!caption.includes("R$")) continue;

      let fotos = [];
      if (post.media_type === "CAROUSEL_ALBUM" && post.children) {
        fotos = post.children.data.map(c => c.media_url).filter(Boolean);
      } else if (post.media_url) {
        fotos = [post.media_url];
      }

      const precoMatch = caption.match(/R\$\s*([\d.,]+)/);
      const kmMatch = caption.match(/([\d.,]+)\s*km/i);
      const anoMatch = caption.match(/(\d{4})\/\d{4}|(\d{4})/);
      const linhas = caption.split("\n").filter(l => l.trim());
      const primeiraLinha = linhas[0] || "";
      const preco = precoMatch ? parseFloat(precoMatch[1].replace(/\./g, "").replace(",", ".")) : 0;
      const km = kmMatch ? parseFloat(kmMatch[1].replace(/\./g, "").replace(",", ".")) : 0;
      const ano = anoMatch ? (anoMatch[1] || anoMatch[2]) : "";

      veiculos.push({
        id: post.id,
        modelo: limparTexto(primeiraLinha).replace(/[🚗🚙🏎️]/g, "").trim(),
        marca: "", versao: "", ano, km, preco,
        cambio: "", combustivel: "", cor: "",
        descricao: caption, fotos,
        atualizadoEm: new Date().toISOString(),
      });
    }

    console.log(`[Instagram] ✅ ${veiculos.length} veículos extraídos`);
    return veiculos;
  } catch (e) {
    console.error("[Instagram] Erro:", e.message);
    return [];
  }
}

async function sincronizarEstoque() {
  console.log("[Estoque] Sincronizando via Instagram...");
  try {
    const veiculos = await buscarEstoqueInstagram();
    if (veiculos.length > 0) {
      estoqueAtual = veiculos;
      ultimaAtualizacao = new Date().toLocaleString("pt-BR");
      console.log(`[Estoque] ✅ ${veiculos.length} veículos | ${ultimaAtualizacao}`);
    }
  } catch (e) {
    console.error("[Estoque] Erro:", e.message);
  }
}

sincronizarEstoque();
setInterval(sincronizarEstoque, 6 * 60 * 60 * 1000);
inicializarSheets();

// ─────────────────────────────────────────────
// FIPE
// ─────────────────────────────────────────────

async function getMarcasFipe() {
  if (cacheMarcasFipe) return cacheMarcasFipe;
  const res = await axios.get("https://parallelum.com.br/fipe/api/v1/carros/marcas");
  cacheMarcasFipe = res.data;
  return cacheMarcasFipe;
}

async function extrairVeiculoParaTroca(textos) {
  try {
    const texto = textos.join(" ");
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 150,
        messages: [{
          role: "user",
          content: `Analise esse texto de conversa e extraia o veículo que o cliente quer VENDER ou DAR NA TROCA (não o que ele quer comprar).
Responda APENAS em JSON válido: {"marca": "...", "modelo": "...", "ano": "..."}
Use nomes simples em minúsculo. Se não tiver informação suficiente, coloque null.

Exemplos:
- "tenho um gol 2012" → {"marca": "volkswagen", "modelo": "gol", "ano": "2012"}
- "santa fé 2012" → {"marca": "hyundai", "modelo": "santa fe", "ano": "2012"}
- "quero comprar um jetta" → {"marca": null, "modelo": null, "ano": null}

Texto: "${texto}"`
        }]
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const resposta = res.data.content[0].text.trim();
    const jsonMatch = resposta.match(/\{[^}]+\}/);
    if (!jsonMatch) return { marca: null, modelo: null, ano: null };
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { marca: null, modelo: null, ano: null };
  }
}

async function consultarFipe(marca, modelo, ano) {
  if (!marca || !modelo || !ano) return null;
  const chave = `${marca}-${modelo}-${ano}`.toLowerCase();
  if (fipeCache[chave]) return fipeCache[chave];
  try {
    const marcas = await getMarcasFipe();
    const marcaFipe = marcas.find(m =>
      m.nome.toLowerCase().includes(marca.toLowerCase()) ||
      marca.toLowerCase().includes(m.nome.toLowerCase().split(" ")[0])
    );
    if (!marcaFipe) return null;
    const modelosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos`);
    const primeirapalavra = modelo.toLowerCase().split(" ")[0];
    const modelosCandidatos = modelosRes.data.modelos.filter(m => m.nome.toLowerCase().includes(primeirapalavra));
    if (modelosCandidatos.length === 0) return null;
    for (const candidato of modelosCandidatos) {
      const anosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${candidato.codigo}/anos`);
      const anoFipe = anosRes.data.find(a => a.nome.includes(ano.toString()) && !a.nome.includes("32000"));
      if (anoFipe) {
        const valorRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${candidato.codigo}/anos/${anoFipe.codigo}`);
        fipeCache[chave] = valorRes.data;
        console.log(`✅ FIPE: ${valorRes.data.Modelo} = ${valorRes.data.Valor}`);
        return valorRes.data;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function calcularValoresTroca(valorFipeStr) {
  const valor = parseFloat(valorFipeStr.replace("R$ ", "").replace(/\./g, "").replace(",", "."));
  return {
    fipe: valor,
    fipeFormatado: valor.toLocaleString("pt-BR"),
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
  } catch (e) {
    return null;
  }
}

async function analisarImagem(mediaId, caption) {
  try {
    const mediaRes = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const imageRes = await axios.get(mediaRes.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer" });
    const base64Image = Buffer.from(imageRes.data).toString("base64");
    const mimeType = mediaRes.data.mime_type || "image/jpeg";
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: `Você é um avaliador de veículos. Analise essa foto e descreva em 2 linhas: estado geral, pontos positivos e pontos de atenção. ${caption ? `Contexto: ${caption}` : ""}` }
          ]
        }]
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    return res.data.content[0].text;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// FOTOS DO ESTOQUE — DETECÇÃO CORRIGIDA
// ─────────────────────────────────────────────

function clienteEstaPedindoFotosDoEstoque(texto, historicoConversa) {
  const t = texto.toLowerCase();

  // FRASES QUE NÃO SÃO PEDIDO DE FOTOS DO ESTOQUE
  const naoEPedido = [
    "te mando", "vou mandar", "vou te mandar", "ja mando", "já mando",
    "mando agora", "mando foto", "mandando foto", "vou enviar",
    "to mandando", "tô mandando", "estou mandando"
  ];
  if (naoEPedido.some(p => t.includes(p))) return false;

  // FRASES QUE SÃO PEDIDO DE FOTOS DO ESTOQUE
  const ePedido = [
    "tem foto", "tem fotos", "manda foto", "manda as foto",
    "pode mandar foto", "me manda foto", "me passa foto",
    "quero ver foto", "quero ver as foto", "tem imagem",
    "me mostra", "como tá o carro", "como está o carro",
    "posso ver", "ver o interior", "ver o exterior",
    "ver por dentro", "ver por fora"
  ];
  if (ePedido.some(p => t.includes(p))) return true;

  // Se menciona "foto" mas sem contexto claro, analisa o histórico
  if (t.includes("foto")) {
    // Verifica se está no contexto de avaliação do carro DO CLIENTE
    const historico = (historicoConversa || []).slice(-6).map(m => m.content || "").join(" ").toLowerCase();
    const estaAvaliantoCarroCliente = historico.includes("meu carro") || historico.includes("tenho um") || 
      historico.includes("quero vender") || historico.includes("troca");
    
    // Se está no contexto de avaliação, provavelmente cliente vai mandar foto do carro dele
    if (estaAvaliantoCarroCliente && (t.includes("vou") || t.includes("ja") || t.includes("já"))) return false;
    
    return true;
  }

  return false;
}

function encontrarVeiculoNoContexto(texto, historicoConversa, estoque) {
  const contexto = [texto, ...(historicoConversa || [])
    .filter(m => m.role === "user")
    .slice(-8)
    .map(m => m.content)
  ].join(" ").toLowerCase();

  let melhorMatch = null;
  let melhorScore = 0;

  for (const v of estoque) {
    const mod
