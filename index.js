const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const https = require("https");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MOBIAUTO_EMAIL = process.env.MOBIAUTO_EMAIL || "premium@premiumautomarcas.com.br";
const MOBIAUTO_SENHA = process.env.MOBIAUTO_SENHA || "f;I~5N=@@M";
const LOJA_ID = "31402";
const fs = require("fs");
const path = require("path");
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN || "EAAV9RujOhN8BRhGxYHPBovlpzTJZCnZBnHC2tjau2j0IzXOg44wahILb8ZCSkacvLFI7FHFI5d7ZCVt1MXE68eTqH9reAcw6fNvFVGU222b4uYoeqjnWBpxLzP2sWTkbSsOCoDzJdZAPk02rWnCfBd4S7TcQY9VdVZCh5vmyd9FCiwp3lZBLxVMxtntrNDXZBTKmrjcZD";
const INSTAGRAM_ACCOUNT_ID = "17841407009898490";
const SHEETS_ID = process.env.SHEETS_ID || "1zhOUFmzlwHsyCh3OuYAdZzMYN3EfKLxkVgODJxgxdYo";
const SHEETS_CREDENTIALS = process.env.GOOGLE_CREDENTIALS ? JSON.parse(process.env.GOOGLE_CREDENTIALS) : null;

let estoqueAtual = [];
let ultimaAtualizacao = null;
const conversas = {};
const mensagensProcessadas = new Set();
const fipeCache = {};
let cacheMarcasFipe = null;

// ─────────────────────────────────────────────
// SINCRONIZADOR DE ESTOQUE — MOBIGESTOR
// ─────────────────────────────────────────────

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return httpsRequest(res.headers.location, body).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

function extrairCookies(header) {
  if (!header) return "";
  return (Array.isArray(header) ? header : [header]).map(c => c.split(";")[0]).join("; ");
}

async function fazerLoginMobigestor() {
  const body = JSON.stringify({ email: MOBIAUTO_EMAIL, password: MOBIAUTO_SENHA });
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://www.mobigestor.com.br",
    "Referer": "https://www.mobigestor.com.br/",
  };

  const endpoints = [
    { hostname: "auth.mobiauto.com.br",  path: "/auth/login" },
    { hostname: "auth.mobiauto.com.br",  path: "/v1/auth/login" },
    { hostname: "auth.mobiauto.com.br",  path: "/api/auth/login" },
    { hostname: "auth.mobiauto.com.br",  path: "/login" },
    { hostname: "api.mobiauto.com.br",   path: "/auth/login" },
    { hostname: "api.mobiauto.com.br",   path: "/auth/v1/login" },
    { hostname: "www.mobigestor.com.br", path: "/api/auth/login" },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[Estoque] Login: ${ep.hostname}${ep.path}`);
      const res = await httpsRequest({ ...ep, method: "POST", headers }, body);
      if (res.status === 200 || res.status === 201) {
        const cookies = extrairCookies(res.headers["set-cookie"]);
        let token = null;
        try {
          const d = JSON.parse(res.body);
          token = d.token || d.access_token || d.accessToken || d.jwt
               || (d.data && (d.data.token || d.data.access_token));
        } catch(e) {}
        console.log(`[Estoque] Login OK (${ep.hostname}${ep.path})`);
        console.log(`[Estoque] Resposta: ${res.body.substring(0, 500)}`);
        console.log(`[Estoque] Token: ${token ? token.substring(0,80) : "NÃO ENCONTRADO"}`);
        return { token, cookies };
      }
    } catch(e) {
      console.log(`[Estoque] Erro login ${ep.path}: ${e.message}`);
    }
  }
  return null;
}

async function buscarVeiculosMobigestor(auth) {
  const authHeaders = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
    "Accept": "application/json",
    ...(auth.token   && { "Authorization": `Bearer ${auth.token}` }),
    ...(auth.cookies && { "Cookie": auth.cookies }),
  };

  const paths = [
    { host: "api.mobiauto.com.br",   path: `/revendas/${LOJA_ID}/anuncios?status=ATIVO&size=100` },
    { host: "api.mobiauto.com.br",   path: `/revendas/${LOJA_ID}/anuncios?size=100` },
    { host: "api.mobiauto.com.br",   path: `/revendas/${LOJA_ID}/veiculos?size=100` },
    { host: "api.mobiauto.com.br",   path: `/v1/revendas/${LOJA_ID}/anuncios?size=100` },
    { host: "api.mobiauto.com.br",   path: `/v2/revendas/${LOJA_ID}/anuncios?size=100` },
    { host: "api.mobiauto.com.br",   path: `/lojas/${LOJA_ID}/anuncios?size=100` },
    { host: "api.mobiauto.com.br",   path: `/v1/lojas/${LOJA_ID}/anuncios?size=100` },
    { host: "api.mobiauto.com.br",   path: `/anuncios?revendaId=${LOJA_ID}&size=100` },
    { host: "api.mobiauto.com.br",   path: `/v1/anuncios?revendaId=${LOJA_ID}&size=100` },
    { host: "api.mobiauto.com.br",   path: `/estoque?lojaId=${LOJA_ID}&size=100` },
    { host: "www.mobigestor.com.br", path: `/api/loja/${LOJA_ID}/anuncios?status=ATIVO&size=100` },
  ];

  for (const ep of paths) {
    try {
      console.log(`[Estoque] Tentando: ${ep.host}${ep.path}`);
      const res = await httpsRequest({ hostname: ep.host, path: ep.path, method: "GET", headers: authHeaders });
      console.log(`[Estoque] Status: ${res.status} | ${ep.host}${ep.path.substring(0,50)} | ${res.body.substring(0, 150)}`);
      if (res.status === 200) {
        let data;
        try { data = JSON.parse(res.body); } catch(e) { continue; }
        const lista = data.content || data.items || data.data || data.anuncios || data.veiculos || data;
        if (Array.isArray(lista) && lista.length > 0) {
          console.log(`[Estoque] ✅ ${lista.length} veículos encontrados!`);
          return { lista, authHeaders };
        }
      }
    } catch(e) {
      console.log(`[Estoque] Erro ${ep.host}${ep.path}: ${e.message}`);
    }
  }
  return null;
}

async function buscarFotosVeiculo(id, authHeaders) {
  const paths = [
    `/api/loja/${LOJA_ID}/anuncios/${id}`,
    `/api/loja/${LOJA_ID}/anuncios/${id}/fotos`,
    `/api/anuncios/${id}/fotos`,
    `/api/anuncios/${id}`,
  ];

  for (const path of paths) {
    try {
      const res = await httpsRequest({ hostname: "www.mobigestor.com.br", path, method: "GET", headers: authHeaders });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const arr = data.fotos || data.images || data.imagens || data.photos || data.midias || data;
        if (Array.isArray(arr)) {
          const urls = arr
            .map(f => typeof f === "string" ? f : (f.url || f.imageUrl || f.urlImagem || f.path || f.src))
            .filter(u => u && typeof u === "string" && u.startsWith("http"));
          if (urls.length > 0) return urls;
        }
      }
    } catch(e) {}
  }
  return [];
}


// ─────────────────────────────────────────────
// GOOGLE SHEETS — PAINEL E APRENDIZADO
// ─────────────────────────────────────────────

async function obterTokenSheets() {
  if (!SHEETS_CREDENTIALS) return null;
  try {
    const jwt = require("crypto");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT"})).toString("base64url");
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
      { headers: {"Content-Type": "application/x-www-form-urlencoded"} }
    );
    return res.data.access_token;
  } catch(e) {
    console.error("[Sheets] Erro ao obter token:", e.message);
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
  } catch(e) {
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
  } catch(e) {
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
  } catch(e) {
    console.error("[Sheets] Erro update:", e.message);
  }
}

// Inicializa abas da planilha
async function inicializarSheets() {
  if (!SHEETS_CREDENTIALS) { console.log("[Sheets] Sem credenciais — painel desativado"); return; }
  try {
    const token = await obterTokenSheets();
    if (!token) return;
    
    // Cria abas se não existirem
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}:batchUpdate`,
      { requests: [
        { addSheet: { properties: { title: "Mensagens" } } },
        { addSheet: { properties: { title: "Aprendizados" } } }
      ]},
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    ).catch(() => {}); // Ignora erro se já existir
    
    // Cabeçalhos
    await sheetsUpdate("Mensagens!A1:F1", [["Timestamp","De","Tipo","Texto","Resolvido","Intervenção"]]);
    await sheetsUpdate("Aprendizados!A1:C1", [["Timestamp","Situação","Correção"]]);
    console.log("[Sheets] ✅ Planilha inicializada");
  } catch(e) {
    console.error("[Sheets] Erro init:", e.message);
  }
}

// Salva mensagem na planilha
async function salvarMensagemSheets(from, tipo, texto) {
  await sheetsAppend("Mensagens!A:F", [[
    new Date().toISOString(), from, tipo, 
    String(texto).substring(0, 500), "não", ""
  ]]);
}

// Busca mensagens de uma conversa
async function buscarMensagensSheets(from) {
  const rows = await sheetsGet("Mensagens!A:F");
  if (!rows) return [];
  return rows.slice(1)
    .filter(r => r[1] === from)
    .map(r => ({ timestamp: r[0], from: r[1], tipo: r[2], texto: r[3] || "" }));
}

// Lista conversas ativas
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
  
  return Object.values(mapa).sort((a,b) => b.ultimaAtividade.localeCompare(a.ultimaAtividade));
}

// Busca aprendizados
async function buscarAprendizadosSheets() {
  const rows = await sheetsGet("Aprendizados!A:C");
  if (!rows) return [];
  return rows.slice(1).map(r => ({ timestamp: r[0], situacao: r[1] || "", correcao: r[2] || "" }));
}

// Formata aprendizados para o system prompt
async function formatarAprendizados() {
  const aprendizados = await buscarAprendizadosSheets();
  if (aprendizados.length === 0) return "";
  return "\n\nEXEMPLOS DE COMO RESPONDER (aprenda com esses casos):\n" +
    aprendizados.slice(-10).map(a => `Situação: ${a.situacao}\nResposta correta: ${a.correcao}`).join("\n---\n");
}

// ─────────────────────────────────────────────
// SINCRONIZADOR VIA INSTAGRAM
// ─────────────────────────────────────────────

function limparTexto(str) {
  if (!str) return "";
  return str.replace(/[\uD800-\uDFFF]/g, "").replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim();
}

async function buscarEstoqueInstagram() {
  try {
    console.log("[Instagram] Buscando posts do estoque...");
    const url = `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media?fields=id,caption,media_type,media_url,children{media_url}&limit=50&access_token=${INSTAGRAM_TOKEN}`;
    const res = await axios.get(url);
    const posts = res.data.data || [];
    console.log(`[Instagram] ${posts.length} posts encontrados`);

    const veiculos = [];

    for (const post of posts) {
      const caption = limparTexto(post.caption || "");

      // Filtra posts que parecem ser anúncios de veículos (têm preço)
      if (!caption.includes("R$")) continue;

      // Extrai fotos
      let fotos = [];
      if (post.media_type === "CAROUSEL_ALBUM" && post.children) {
        fotos = post.children.data.map(c => c.media_url).filter(Boolean);
      } else if (post.media_url) {
        fotos = [post.media_url];
      }

      // Extrai dados do caption
      const precoMatch = caption.match(/R\$\s*([\d.,]+)/);
      const kmMatch = caption.match(/([\d.,]+)\s*km/i);
      const anoMatch = caption.match(/(\d{4})\/\d{4}|(\d{4})/);

      // Extrai modelo da primeira linha
      const linhas = caption.split("\n").filter(l => l.trim());
      const primeiraLinha = linhas[0] || "";

      const preco = precoMatch ? parseFloat(precoMatch[1].replace(/\./g, "").replace(",", ".")) : 0;
      const km = kmMatch ? parseFloat(kmMatch[1].replace(/\./g, "").replace(",", ".")) : 0;
      const ano = anoMatch ? (anoMatch[1] || anoMatch[2]) : "";

      console.log(`[Instagram] Extraindo: "${primeiraLinha.substring(0,40)}" | preco=${preco} | km=${km} | ano=${ano}`);

      veiculos.push({
        id: post.id,
        modelo: limparTexto(primeiraLinha).replace(/[🚗🚙🏎️]/g, "").trim(),
        marca: "",
        versao: "",
        ano,
        km,
        preco,
        cambio: "",
        combustivel: "",
        cor: "",
        descricao: caption,
        fotos,
        atualizadoEm: new Date().toISOString(),
      });
    }

    console.log(`[Instagram] ✅ ${veiculos.length} veículos extraídos`);
    return veiculos;
  } catch(e) {
    console.error("[Instagram] Erro:", e.message);
    if (e.response) console.error("[Instagram] Detalhe:", JSON.stringify(e.response.data));
    return [];
  }
}

async function sincronizarEstoque() {
  console.log("[Estoque] Iniciando sincronização via Instagram...");
  try {
    const veiculos = await buscarEstoqueInstagram();
    if (veiculos.length > 0) {
      estoqueAtual = veiculos;
      ultimaAtualizacao = new Date().toLocaleString("pt-BR");
      const comFotos = veiculos.filter(v => v.fotos.length > 0).length;
      console.log(`[Estoque] ✅ ${veiculos.length} veículos | ${comFotos} com fotos | ${ultimaAtualizacao}`);
    } else {
      console.log("[Estoque] ⚠️ Nenhum veículo encontrado no Instagram");
    }
  } catch(e) {
    console.error("[Estoque] Erro:", e.message);
  }
}

// Roda ao iniciar e depois a cada 6 horas
sincronizarEstoque();
setInterval(sincronizarEstoque, 6 * 60 * 60 * 1000);
inicializarSheets();

// ─────────────────────────────────────────────
// FUNÇÕES DA SARA (sem alteração)
// ─────────────────────────────────────────────

function limparTexto(str) {
  if (!str) return "";
  // Remove surrogate pairs e emojis que quebram JSON
  return String(str)
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{FE00}-\u{FEFF}]/gu, "")
    .trim();
}

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque sendo carregado.";
  return estoqueAtual.map(v => {
    const modelo = limparTexto(v.modelo || "");
    const ano = v.ano || "";
    const km = Number(v.km || 0).toLocaleString("pt-BR");
    const preco = Number(v.preco || 0).toLocaleString("pt-BR");
    return `${modelo} ${ano} - ${km} km - R$ ${preco}`;
  }).join("\n");
}

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
Use nomes simples em minúsculo: "volkswagen", "hyundai", "toyota", etc.
Se não tiver informação suficiente, coloque null.

Exemplos:
- "tenho um gol 2012" → {"marca": "volkswagen", "modelo": "gol", "ano": "2012"}
- "santa fé 2012" → {"marca": "hyundai", "modelo": "santa fe", "ano": "2012"}
- "meu yaris 2019" → {"marca": "toyota", "modelo": "yaris", "ano": "2019"}
- "quero comprar um jetta" → {"marca": null, "modelo": null, "ano": null}

Texto: "${texto}"`
        }]
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );
    const resposta = res.data.content[0].text.trim();
    const jsonMatch = resposta.match(/\{[^}]+\}/);
    if (!jsonMatch) return { marca: null, modelo: null, ano: null };
    const json = JSON.parse(jsonMatch[0]);
    return json;
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
  const minimo = Math.round(valor * 0.80);
  const maximo = Math.round(valor * 0.85);
  return {
    fipe: valor,
    fipeFormatado: valor.toLocaleString("pt-BR"),
    minimoFormatado: minimo.toLocaleString("pt-BR"),
    maximoFormatado: maximo.toLocaleString("pt-BR")
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
    const transcricaoRes = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", formData, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...formData.getHeaders() } });
    return transcricaoRes.data.text;
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
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: `Você é um avaliador de veículos experiente. Analise essa foto do carro e descreva brevemente:\n1. Estado geral visível (pintura, lataria, pneus se aparecer)\n2. Pontos positivos\n3. Pontos de atenção (se houver)\nSeja objetivo e use no máximo 3 linhas. ${caption ? `Contexto: ${caption}` : ""}` }
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

const SYSTEM_PROMPT = (fipeInfo, aprendizadosExtra = "") => `Você é Sarah, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

EMPRESA:
- Endereço: Av. Aparício Borges, 931 - Porto Alegre/RS
- Horário: Seg-Sex 8h-18h, Sáb 8h-12h
- Consultor humano: (51) 99364-2476

PERFIL:
- Simpática, descontraída e profissional
- Respostas CURTAS e DIRETAS — máximo 4 linhas
- NUNCA repita a saudação depois da primeira mensagem
- SEMPRE mantenha o contexto da conversa anterior

ESTOQUE ATUAL (${ultimaAtualizacao || "carregando..."}):
${formatarEstoque()}

REGRA CRITICA DE PRECOS:
- Os precos acima sao EXATOS e DEFINITIVOS
- NUNCA altere, arredonde ou invente precos
- Se o preco do estoque diz R$ 15.990, voce responde R$ 15.990
- Nao some, nao subtraia, nao estime — use EXATAMENTE o valor do estoque

FOTOS DOS VEÍCULOS:
Quando o cliente pedir fotos de um veículo específico, envie as fotos disponíveis.
Se não tiver fotos: "Entre em contato pelo (51) 99364-2476 ou venha visitar!"

PAGAMENTO: Financiamento (BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú), Cartão, Consórcio, À vista

FLUXO DE AVALIAÇÃO DE TROCA:
Quando o cliente mencionar um veículo para troca, NUNCA passe o valor imediatamente.
Siga esse fluxo obrigatório:

ETAPA 1 — Conhecer o carro:
Pergunte de forma natural e amigável:
- Qual a quilometragem atual?
- Como está o estado geral? (pintura, mecânica, pneus)
- Tem revisões em dia? Histórico de manutenção?
- Já tem alguma avaliação prévia do carro?
- Pode mandar algumas fotos pra gente ter uma ideia melhor? 📸

ETAPA 2 — Quando o cliente mandar fotos:
Agradeça as fotos, comente algo positivo sobre o carro e continue coletando informações se necessário.
Nunca ignore uma foto enviada — sempre acuse o recebimento e comente.

ETAPA 3 — Só após ter km, estado geral e ao menos uma foto:
${fipeInfo ? (() => {
    const v = calcularValoresTroca(fipeInfo.Valor);
    return `✅ FIPE consultada (referência interna):
Veículo base: ${fipeInfo.Modelo} ${fipeInfo.AnoModelo} = ${fipeInfo.Valor}
Faixa de avaliação: R$ ${v.minimoFormatado} a R$ ${v.maximoFormatado}

Apresente assim: "Com base no que você me passou, conseguimos trabalhar entre R$ ${v.minimoFormatado} e R$ ${v.maximoFormatado} na troca. Mas a avaliação final é sempre presencial!"
- NÃO mencione FIPE, percentuais ou descontos
- Carro em ótimo estado → valor próximo de R$ ${v.maximoFormatado}
- Alta km ou problemas → valor próximo de R$ ${v.minimoFormatado}`;
  })() :
    `⚠️ FIPE ainda não consultada — não invente valores.
Colete as informações do carro (km, estado, revisões, fotos) antes de qualquer estimativa.`
  }

SIMULACAO DE FINANCIAMENTO COM TROCA:

Passo 1 — Calcular saldo liquido da troca:
Saldo = Valor avaliado do carro do cliente - Divida restante
Exemplo: Ka avaliado R$ 22.000, deve R$ 18.000 → saldo = R$ 4.000

Passo 2 — Calcular valor a financiar:
Valor financiado = Preco do carro + Valor que cliente quer receber de volta - Saldo da troca
Exemplo: 207 R$ 15.990 + cliente quer R$ 5.000 - saldo R$ 4.000 = financia R$ 16.990

Passo 3 — Como funciona o troco:
E POSSIVEL financiar um valor MAIOR que o preco do carro para devolver dinheiro ao cliente.
Nesse caso: loja recebe o saldo da troca + valor financiado, paga a divida do carro do cliente, fica com o preco do carro e devolve o restante ao cliente.
Exemplo: loja recebe R$ 4.000 (troca) + R$ 16.990 (financiamento) = R$ 20.990
         paga divida Ka R$ 18.000 + fica com 207 R$ 15.990... 
         Aguarda: cliente leva o 207 + recebe R$ 5.000 = correto

Quando cliente pedir troco: calcule quanto precisa financiar e simule as parcelas normalmente.

FINANCIAMENTO ABAIXO DA FIPE:
Muitos carros do estoque estao precificados ABAIXO da tabela FIPE.
Os bancos financiam com base no valor FIPE, nao no preco de venda.
Isso significa que e possivel financiar ate o valor FIPE mesmo que o carro custe menos.
Exemplo: 207 vale R$ 21.500 na FIPE mas custa R$ 15.990.
O banco pode financiar ate R$ 21.500, gerando margem para troco ao cliente.
Quando o cliente pedir troco, verifique se o valor a financiar cabe dentro da FIPE do veiculo.
Se couber, confirme que e possivel e simule as parcelas.
Se ultrapassar a FIPE, informe o limite maximo disponivel.

Passo 4 — Simulacao de parcelas:
Taxa 1,8%/mes. Formula: PMT = PV x (i x (1+i)^n) / ((1+i)^n - 1)
PV = valor a financiar
Apresente apenas o valor da parcela, sem mencionar formula.

REGRAS:
- Primeira mensagem: "Oi! 😊 Aqui é a Sarah da Premium Automarcas!"
- Demais mensagens: direto ao assunto
- Máximo 4 linhas
- Emojis com moderação 🚗
- Humano: (51) 99364-2476
- NUNCA invente links, URLs ou endereços de site
- NUNCA invente informações de estoque${aprendizadosExtra}`;

// Envia fotos de um veículo pelo WhatsApp
async function enviarFotosVeiculo(to, veiculo) {
  const fotos = veiculo.fotos || [];
  if (fotos.length === 0) return false;
  // Envia até 5 fotos
  const fotosParaEnviar = fotos.slice(0, 5);
  for (const url of fotosParaEnviar) {
    try {
      await axios.post(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to,
          type: "image",
          image: { link: url }
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error(`Erro ao enviar foto: ${e.message}`);
    }
  }
  return true;
}

// Detecta se cliente pediu fotos e de qual veículo
function detectarPedidoDeFotos(texto, estoque, historicoConversa) {
  const t = texto.toLowerCase();
  const pedindoFotos = t.includes("foto") || t.includes("imagem") || t.includes("ver o carro") || t.includes("tem foto") || t.includes("manda foto") || t.includes("mandar foto");
  if (!pedindoFotos) return null;

  // Junta texto atual + últimas mensagens para contexto
  const contexto = [texto, ...(historicoConversa || [])
    .filter(m => m.role === "user")
    .slice(-5)
    .map(m => m.content)
  ].join(" ").toLowerCase();

  // Tenta achar o veículo mencionado no contexto da conversa
  let melhorMatch = null;
  let melhorScore = 0;

  for (const v of estoque) {
    const modelo = limparTexto(v.modelo || "").toLowerCase();
    const palavras = modelo.split(" ").filter(p => p.length > 2);
    let score = 0;

    for (const p of palavras) {
      if (contexto.includes(p)) score++;
    }

    // Bonus se o ano também bate
    if (v.ano && contexto.includes(String(v.ano))) score += 2;

    if (score > melhorScore) {
      melhorScore = score;
      melhorMatch = v;
    }
  }

  // Só retorna se encontrou pelo menos 1 palavra matching
  return melhorScore > 0 ? melhorMatch : null;
}

async function processarMensagem(from, text) {
  if (!conversas[from]) conversas[from] = [];
  conversas[from].push({ role: "user", content: text });
  salvarMensagemSheets(from, "client", text).catch(()=>{});
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  // Verifica se cliente pediu fotos
  // Só detecta pedido de fotos se for mensagem de texto (não quando cliente manda imagem)
  const ehMensagemTexto = !text.startsWith("[Cliente enviou foto");
  
  // Verifica se já enviou fotos nos últimos 3 turnos para evitar duplicatas
  const ultimasMensagens = (conversas[from] || []).slice(-6).map(m => m.content || "").join(" ");
  const jaEnviouFotos = ultimasMensagens.includes("[Sistema: fotos do");

  const veiculoComFotos = ehMensagemTexto && !jaEnviouFotos 
    ? detectarPedidoDeFotos(text, estoqueAtual, conversas[from]) 
    : null;
    
  let fotosEnviadas = false;
  if (veiculoComFotos && veiculoComFotos.fotos.length > 0) {
    console.log(`[Fotos] Enviando fotos do ${veiculoComFotos.modelo}`);
    await enviarFotosVeiculo(from, veiculoComFotos);
    fotosEnviadas = true;
    conversas[from].push({ role: "user", content: `[Sistema: fotos do ${limparTexto(veiculoComFotos.modelo)} ja foram enviadas automaticamente pelo WhatsApp. Confirme que as fotos foram enviadas e pergunte se precisa de mais informacoes.]` });
  }

  const todosTextos = conversas[from].filter(m => m.role === "user").map(m => m.content);
  const { marca, modelo, ano } = await extrairVeiculoParaTroca(todosTextos);
  let fipeInfo = null;
  if (marca && modelo && ano) fipeInfo = await consultarFipe(marca, modelo, ano);

  const claude = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT(fipeInfo, await formatarAprendizados().catch(()=>"")),
      messages: conversas[from]
    },
    { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
  );

  const reply = claude.data.content[0].text;
  conversas[from].push({ role: "assistant", content: reply });

  await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: from, text: { body: reply } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );

  console.log(`Resposta para ${from}: ${reply}`);
  salvarMensagemSheets(from, "sara", reply).catch(()=>{});
}

app.get("/", (req, res) => res.send("Agente funcionando!"));

app.get("/estoque", (req, res) => res.json({
  total: estoqueAtual.length,
  ultimaAtualizacao,
  veiculos: estoqueAtual
}));

app.get("/sincronizar", async (req, res) => {
  res.send("Sincronização iniciada! Acompanhe nos logs.");
  await sincronizarEstoque();
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
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
        console.log(`Texto de ${from}: ${msg.text.body}`);
        await processarMensagem(from, msg.text.body);
      } else if (msg.type === "audio") {
        const texto = await transcreverAudio(msg.audio.id);
        if (texto) {
          await processarMensagem(from, `[Áudio]: ${texto}`);
        } else {
          await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to: from, text: { body: "Não consegui entender o áudio. Pode digitar?" } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
          );
        }
      } else if (msg.type === "image") {
        const caption = msg.image.caption || "";
        const analise = await analisarImagem(msg.image.id, caption);
        if (analise) {
          await processarMensagem(from, `[Cliente enviou foto do veículo. Análise automática: ${analise}]`);
        } else {
          await processarMensagem(from, `[Cliente enviou uma foto do veículo${caption ? `: ${caption}` : ""}]`);
        }
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
  } catch (e) {
    res.send("Erro: " + JSON.stringify(e.response?.data));
  }
});

app.get("/assinar-webhook", async (req, res) => {
  try {
    const result = await axios.post(`https://graph.facebook.com/v18.0/2609687206092266/subscribed_apps`, {},
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    res.send("Assinado! " + JSON.stringify(result.data));
  } catch (e) {
    res.send("Erro: " + JSON.stringify(e.response?.data));
  }
});

// ─────────────────────────────────────────────
// ROTAS DO PAINEL
// ─────────────────────────────────────────────

app.get("/painel", (req, res) => {
  const painelHTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sara - Painel de Monitoramento</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  
  header { background: #1a1a1a; border-bottom: 1px solid #333; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; color: #fff; }
  header h1 span { color: #f0a500; }
  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #888; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .main { display: flex; flex: 1; overflow: hidden; }

  /* Lista de conversas */
  .sidebar { width: 280px; background: #161616; border-right: 1px solid #2a2a2a; display: flex; flex-direction: column; }
  .sidebar-header { padding: 12px 16px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #2a2a2a; }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #1f1f1f; transition: background 0.15s; }
  .conv-item:hover { background: #1e1e1e; }
  .conv-item.active { background: #1e2a1e; border-left: 3px solid #f0a500; }
  .conv-item.unread { border-left: 3px solid #f44336; }
  .conv-phone { font-size: 13px; font-weight: 600; color: #fff; }
  .conv-preview { font-size: 12px; color: #666; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-time { font-size: 11px; color: #555; margin-top: 2px; }
  .conv-badge { display: inline-block; background: #f44336; color: #fff; font-size: 10px; padding: 1px 5px; border-radius: 10px; margin-left: 4px; }

  /* Área de chat */
  .chat-area { flex: 1; display: flex; flex-direction: column; }
  .chat-header { padding: 12px 20px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; justify-content: space-between; }
  .chat-phone { font-size: 15px; font-weight: 600; }
  .chat-actions { display: flex; gap: 8px; }
  .btn { padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: #f0a500; color: #000; }
  .btn-danger { background: #f44336; color: #fff; }
  .btn-secondary { background: #333; color: #fff; }

  .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 75%; }
  .msg.client { align-self: flex-start; }
  .msg.sara { align-self: flex-end; }
  .msg.intervencao { align-self: flex-end; }
  .msg-bubble { padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
  .msg.client .msg-bubble { background: #2a2a2a; color: #e0e0e0; border-bottom-left-radius: 3px; }
  .msg.sara .msg-bubble { background: #1a3a1a; color: #b8e6b8; border-bottom-right-radius: 3px; }
  .msg.intervencao .msg-bubble { background: #2a1a00; color: #f0c060; border-bottom-right-radius: 3px; border: 1px solid #f0a500; }
  .msg-meta { font-size: 11px; color: #555; margin-top: 3px; }
  .msg.sara .msg-meta, .msg.intervencao .msg-meta { text-align: right; }
  .msg-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .msg.client .msg-label { color: #666; }
  .msg.sara .msg-label { color: #4a8; text-align: right; }
  .msg.intervencao .msg-label { color: #f0a500; text-align: right; }

  /* Área de intervenção */
  .intervention { background: #1a1a1a; border-top: 1px solid #2a2a2a; padding: 12px 16px; }
  .intervention-header { font-size: 11px; color: #f0a500; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .intervention-input { display: flex; gap: 8px; }
  .intervention-input textarea { flex: 1; background: #252525; border: 1px solid #333; border-radius: 8px; color: #fff; padding: 10px 12px; font-size: 14px; resize: none; height: 60px; font-family: inherit; }
  .intervention-input textarea:focus { outline: none; border-color: #f0a500; }

  /* Painel de aprendizado */
  .learning-panel { width: 260px; background: #161616; border-left: 1px solid #2a2a2a; display: flex; flex-direction: column; }
  .learning-header { padding: 12px 16px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #2a2a2a; }
  .learning-list { flex: 1; overflow-y: auto; padding: 8px; }
  .learning-item { background: #1e1e1e; border-radius: 8px; padding: 10px; margin-bottom: 8px; font-size: 12px; border-left: 3px solid #f0a500; }
  .learning-item .situation { color: #888; margin-bottom: 4px; }
  .learning-item .correction { color: #b8e6b8; }
  .learning-count { padding: 8px 16px; font-size: 12px; color: #555; border-top: 1px solid #2a2a2a; }

  .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: #444; }
  .empty-state svg { opacity: 0.3; }

  /* Loading */
  .loading { text-align: center; padding: 20px; color: #555; font-size: 13px; }
</style>
</head>
<body>

<header>
  <h1>Sara <span>Premium Automarcas</span></h1>
  <div class="status">
    <div class="dot"></div>
    <span id="statusText">Conectando...</span>
  </div>
</header>

<div class="main">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-header">Conversas Ativas</div>
    <div class="conv-list" id="convList">
      <div class="loading">Carregando...</div>
    </div>
  </div>

  <!-- Chat -->
  <div class="chat-area">
    <div class="chat-header" id="chatHeader">
      <div class="chat-phone" id="chatPhone">Selecione uma conversa</div>
      <div class="chat-actions" id="chatActions" style="display:none">
        <button class="btn btn-secondary" onclick="marcarResolvido()">✓ Resolvido</button>
        <button class="btn btn-danger" onclick="salvarAprendizado()">💡 Salvar como aprendizado</button>
      </div>
    </div>
    <div class="messages" id="messages">
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span>Selecione uma conversa</span>
      </div>
    </div>
    <div class="intervention" id="interventionArea" style="display:none">
      <div class="intervention-header">⚡ Intervenção — mensagem enviada como Sara</div>
      <div class="intervention-input">
        <textarea id="interventionText" placeholder="Digite a resposta correta e pressione Enter para enviar como Sara..."></textarea>
        <button class="btn btn-primary" onclick="enviarIntervencao()">Enviar</button>
      </div>
    </div>
  </div>

  <!-- Painel de aprendizado -->
  <div class="learning-panel">
    <div class="learning-header">💡 Base de Aprendizado</div>
    <div class="learning-list" id="learningList">
      <div class="loading">Carregando...</div>
    </div>
    <div class="learning-count" id="learningCount"></div>
  </div>
</div>

<script>
const API = window.location.origin;
let conversaAtiva = null;
let intervalo = null;

// Formata número de telefone
function formatarTelefone(num) {
  const n = String(num).replace(/\\D/g, '');
  if (n.length >= 12) return \`+\${n.slice(0,2)} (\${n.slice(2,4)}) \${n.slice(4,9)}-\${n.slice(9)}\`;
  return num;
}

// Formata hora
function formatarHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
}

// Carrega lista de conversas
async function carregarConversas() {
  try {
    const res = await fetch(\`\${API}/painel/conversas\`);
    const data = await res.json();
    const list = document.getElementById('convList');
    
    if (!data.conversas || data.conversas.length === 0) {
      list.innerHTML = '<div class="loading">Nenhuma conversa ainda</div>';
      return;
    }

    list.innerHTML = data.conversas.map(c => \`
      <div class="conv-item \${c.from === conversaAtiva ? 'active' : ''} \${c.naoLida ? 'unread' : ''}" 
           onclick="abrirConversa('\${c.from}')">
        <div class="conv-phone">
          \${formatarTelefone(c.from)}
          \${c.naoLida ? \`<span class="conv-badge">\${c.naoLida}</span>\` : ''}
        </div>
        <div class="conv-preview">\${c.ultimaMensagem || ''}</div>
        <div class="conv-time">\${formatarHora(c.ultimaAtividade)}</div>
      </div>
    \`).join('');

    document.getElementById('statusText').textContent = \`\${data.conversas.length} conversa(s) ativa(s)\`;
  } catch(e) {
    document.getElementById('statusText').textContent = 'Erro de conexão';
  }
}

// Abre conversa
async function abrirConversa(from) {
  conversaAtiva = from;
  document.getElementById('chatPhone').textContent = formatarTelefone(from);
  document.getElementById('chatActions').style.display = 'flex';
  document.getElementById('interventionArea').style.display = 'block';
  
  await carregarMensagens(from);
  await carregarConversas();
}

// Carrega mensagens de uma conversa
async function carregarMensagens(from) {
  try {
    const res = await fetch(\`\${API}/painel/mensagens/\${from}\`);
    const data = await res.json();
    const msgs = document.getElementById('messages');
    
    if (!data.mensagens || data.mensagens.length === 0) {
      msgs.innerHTML = '<div class="loading">Nenhuma mensagem</div>';
      return;
    }

    msgs.innerHTML = data.mensagens.map(m => \`
      <div class="msg \${m.tipo}">
        <div class="msg-label">\${m.tipo === 'client' ? '👤 Cliente' : m.tipo === 'sara' ? '🤖 Sara' : '⚡ Você'}</div>
        <div class="msg-bubble">\${m.texto.replace(/\\n/g, '<br>').replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')}</div>
        <div class="msg-meta">\${formatarHora(m.timestamp)}</div>
      </div>
    \`).join('');
    
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) {
    console.error('Erro ao carregar mensagens:', e);
  }
}

// Envia intervenção
async function enviarIntervencao() {
  if (!conversaAtiva) return;
  const texto = document.getElementById('interventionText').value.trim();
  if (!texto) return;

  try {
    const res = await fetch(\`\${API}/painel/intervencao\`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ from: conversaAtiva, texto })
    });
    
    if (res.ok) {
      document.getElementById('interventionText').value = '';
      await carregarMensagens(conversaAtiva);
    }
  } catch(e) {
    alert('Erro ao enviar mensagem');
  }
}

// Salvar como aprendizado
async function salvarAprendizado() {
  if (!conversaAtiva) return;
  const situacao = prompt('Descreva brevemente a situação (ex: "cliente perguntou sobre troco"):');
  if (!situacao) return;
  const correcao = prompt('Como a Sara deveria ter respondido?');
  if (!correcao) return;

  try {
    await fetch(\`\${API}/painel/aprendizado\`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ situacao, correcao, from: conversaAtiva })
    });
    await carregarAprendizados();
    alert('Aprendizado salvo! Sara vai usar isso nas próximas conversas.');
  } catch(e) {
    alert('Erro ao salvar aprendizado');
  }
}

// Marca conversa como resolvida
async function marcarResolvido() {
  if (!conversaAtiva) return;
  await fetch(\`\${API}/painel/resolver\`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ from: conversaAtiva })
  });
  conversaAtiva = null;
  document.getElementById('chatPhone').textContent = 'Selecione uma conversa';
  document.getElementById('chatActions').style.display = 'none';
  document.getElementById('interventionArea').style.display = 'none';
  document.getElementById('messages').innerHTML = '<div class="empty-state"><span>Selecione uma conversa</span></div>';
  await carregarConversas();
}

// Carrega aprendizados
async function carregarAprendizados() {
  try {
    const res = await fetch(\`\${API}/painel/aprendizados\`);
    const data = await res.json();
    const list = document.getElementById('learningList');
    
    if (!data.aprendizados || data.aprendizados.length === 0) {
      list.innerHTML = '<div class="loading" style="color:#555">Nenhum aprendizado ainda</div>';
      document.getElementById('learningCount').textContent = '';
      return;
    }

    list.innerHTML = data.aprendizados.slice(-20).reverse().map(a => \`
      <div class="learning-item">
        <div class="situation">📌 \${a.situacao}</div>
        <div class="correction">✓ \${a.correcao.substring(0, 100)}\${a.correcao.length > 100 ? '...' : ''}</div>
      </div>
    \`).join('');
    
    document.getElementById('learningCount').textContent = \`\${data.aprendizados.length} aprendizado(s) registrado(s)\`;
  } catch(e) {}
}

// Enter para enviar intervenção
document.getElementById('interventionText').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    enviarIntervencao();
  }
});

// Atualização automática
async function atualizar() {
  await carregarConversas();
  if (conversaAtiva) await carregarMensagens(conversaAtiva);
}

carregarConversas();
carregarAprendizados();
setInterval(atualizar, 5000); // Atualiza a cada 5 segundos
</script>
</body>
</html>
`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(painelHTML);
});

app.get("/painel/conversas", async (req, res) => {
  try {
    const conversas = await listarConversasSheets();
    res.json({ conversas });
  } catch(e) {
    res.json({ conversas: [] });
  }
});

app.get("/painel/mensagens/:from", async (req, res) => {
  try {
    const mensagens = await buscarMensagensSheets(req.params.from);
    res.json({ mensagens });
  } catch(e) {
    res.json({ mensagens: [] });
  }
});

app.post("/painel/intervencao", async (req, res) => {
  const { from, texto } = req.body;
  if (!from || !texto) return res.status(400).json({ erro: "Dados inválidos" });
  
  try {
    // Envia mensagem pelo WhatsApp como Sara
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: texto } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    
    // Salva no histórico e no Sheets
    if (!conversas[from]) conversas[from] = [];
    conversas[from].push({ role: "assistant", content: texto });
    await salvarMensagemSheets(from, "intervencao", texto);
    
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post("/painel/aprendizado", async (req, res) => {
  const { situacao, correcao } = req.body;
  if (!situacao || !correcao) return res.status(400).json({ erro: "Dados inválidos" });
  
  try {
    await sheetsAppend("Aprendizados!A:C", [[
      new Date().toISOString(), situacao, correcao
    ]]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get("/painel/aprendizados", async (req, res) => {
  try {
    const aprendizados = await buscarAprendizadosSheets();
    res.json({ aprendizados });
  } catch(e) {
    res.json({ aprendizados: [] });
  }
});

app.post("/painel/resolver", async (req, res) => {
  const { from } = req.body;
  // Marca todas as mensagens desse contato como resolvidas
  // Por simplicidade, apenas limpa do histórico em memória
  if (conversas[from]) delete conversas[from];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
