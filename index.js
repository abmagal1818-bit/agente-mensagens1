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
const filaFotos = {};
const ultimaNotificacao = {};

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

async function notificarAugusto(from, texto) {
  const agora = Date.now();
  const ultima = ultimaNotificacao[from] || 0;
  const trintaMinutos = 30 * 60 * 1000;

  // Notifica se for primeira vez ou se passaram 30 minutos
  if (agora - ultima < trintaMinutos) return;
  ultimaNotificacao[from] = agora;

  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12
    ? `+${numero.slice(0, 2)} (${numero.slice(2, 4)}) ${numero.slice(4, 9)}-${numero.slice(9)}`
    : from;

  const mensagem = `📩 *Mensagem na Sarah*\nNúmero: ${formatado}\nMensagem: "${texto.substring(0, 100)}"\n\nAcesse o painel: https://agente-mensagens1.onrender.com/painel`;

  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Notificação] Augusto notificado — ${formatado}`);
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
// FOTOS DO ESTOQUE
// ─────────────────────────────────────────────

function clienteEstaPedindoFotosDoEstoque(texto, historicoConversa) {
  const t = texto.toLowerCase();

  const naoEPedido = [
    "te mando", "vou mandar", "vou te mandar", "ja mando", "já mando",
    "mando agora", "mando foto", "mandando foto", "vou enviar",
    "to mandando", "tô mandando", "estou mandando", "to enviando"
  ];
  if (naoEPedido.some(p => t.includes(p))) return false;

  const ePedido = [
    "tem foto", "tem fotos", "manda foto", "manda as foto",
    "pode mandar foto", "me manda foto", "me passa foto",
    "quero ver foto", "quero ver as foto", "tem imagem",
    "me mostra", "como tá o carro", "como está o carro",
    "posso ver", "ver o interior", "ver o exterior",
    "ver por dentro", "ver por fora", "foto dele", "fotos dele"
  ];
  if (ePedido.some(p => t.includes(p))) return true;

  if (t.includes("foto")) {
    const historico = (historicoConversa || []).slice(-6).map(m => m.content || "").join(" ").toLowerCase();
    const clienteAvaliadoCarroDele = historico.includes("meu carro") || historico.includes("tenho um") ||
      historico.includes("quero vender") || historico.includes("na troca");
    if (clienteAvaliadoCarroDele && (t.includes("vou") || t.includes("ja") || t.includes("já") || t.includes("mando"))) return false;
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
    const modelo = limparTexto(v.modelo || "").toLowerCase();
    const palavras = modelo.split(/\s+/).filter(p => p.length > 2);
    let score = 0;
    for (const p of palavras) {
      if (contexto.includes(p)) score++;
    }
    if (v.ano && contexto.includes(String(v.ano))) score += 2;
    if (score > melhorScore) {
      melhorScore = score;
      melhorMatch = v;
    }
  }

  return melhorScore >= 1 ? melhorMatch : null;
}

async function enviarFotosVeiculo(to, veiculo) {
  const fotos = (veiculo.fotos || []).slice(0, 5);
  if (fotos.length === 0) return false;
  for (const url of fotos) {
    try {
      await axios.post(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to, type: "image", image: { link: url } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error(`Erro ao enviar foto: ${e.message}`);
    }
  }
  return true;
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque sendo carregado.";
  return estoqueAtual.map(v => {
    const modelo = limparTexto(v.modelo || "");
    const km = Number(v.km || 0).toLocaleString("pt-BR");
    const preco = Number(v.preco || 0).toLocaleString("pt-BR");
    return `${modelo} ${v.ano || ""} - ${km} km - R$ ${preco}`;
  }).join("\n");
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

REGRAS DE PREÇO:
- Use EXATAMENTE os preços do estoque acima
- NUNCA altere, arredonde ou invente preços

FOTOS DOS VEÍCULOS:
- Quando o sistema confirmar que fotos foram enviadas, diga naturalmente: "Mandei as fotos pra você! O que achou?" 
- NUNCA diga que enviou fotos se o sistema não confirmou
- Se não tiver fotos disponíveis: "Entre em contato pelo (51) 99364-2476 ou venha visitar!"

PAGAMENTO: Financiamento (BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú), Cartão, Consórcio, À vista

FLUXO DE AVALIAÇÃO DE TROCA:
Quando cliente mencionar veículo para troca, NUNCA passe valor imediatamente.

ETAPA 1 — Conhecer o carro (pergunte de forma natural):
- Quilometragem atual?
- Estado geral (pintura, mecânica, pneus)?
- Revisões em dia?
- Já tem avaliação prévia?
- Pode mandar fotos? 📸

ETAPA 2 — Quando cliente mandar fotos do carro DELE:
- Agradeça e comente positivamente sobre o estado
- Continue coletando informações se necessário
- NUNCA ignore fotos recebidas do cliente

ETAPA 3 — Só após ter km, estado e fotos:
${fipeInfo ? (() => {
    const v = calcularValoresTroca(fipeInfo.Valor);
    return `✅ FIPE consultada: ${fipeInfo.Modelo} ${fipeInfo.AnoModelo} = ${fipeInfo.Valor}
Faixa de avaliação: R$ ${v.minimoFormatado} a R$ ${v.maximoFormatado}
Diga: "Com base no que você me passou, conseguimos trabalhar entre R$ ${v.minimoFormatado} e R$ ${v.maximoFormatado} na troca. Avaliação final é presencial!"
NÃO mencione FIPE, percentuais ou descontos.`;
  })() : `⚠️ FIPE não consultada — NUNCA invente valores. Colete informações primeiro.`}

SIMULAÇÃO DE FINANCIAMENTO:
Taxa 1,8%/mês. Fórmula: PMT = PV × (i×(1+i)^n)/((1+i)^n-1)
Apresente apenas o valor da parcela, sem mencionar a fórmula.

FINANCIAMENTO ACIMA DO PREÇO (TROCO):
Carros do estoque podem estar abaixo da FIPE. Banco financia até o valor FIPE.
É possível financiar valor maior que o preço para devolver dinheiro ao cliente.
Calcule: saldo troca = avaliação - dívida. Valor financiado = preço carro + troco desejado - saldo troca.

REGRAS:
- Primeira mensagem: "Oi! 😊 Aqui é a Sarah da Premium Automarcas!"
- Demais mensagens: direto ao assunto, máximo 4 linhas
- Emojis com moderação 🚗
- Humano: (51) 99364-2476
- NUNCA invente links ou URLs
- NUNCA invente informações de estoque${aprendizadosExtra}`;

// ─────────────────────────────────────────────
// PROCESSAMENTO DE MENSAGENS
// ─────────────────────────────────────────────

async function processarMensagem(from, text) {
  if (!conversas[from]) conversas[from] = [];
  conversas[from].push({ role: "user", content: text });
  salvarMensagemSheets(from, "client", text).catch(() => {});

  // Notifica Augusto a cada 30 minutos por cliente
  notificarAugusto(from, text).catch(() => {});

  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  // Detecta pedido de fotos DO ESTOQUE (não foto do carro do cliente)
  const ehTextoNormal = !text.startsWith("[Cliente enviou foto") && !text.startsWith("[Áudio]") && !text.startsWith("[Sistema:");
  const ultimasMensagens = conversas[from].slice(-6).map(m => m.content || "").join(" ");
  const jaEnviouFotos = ultimasMensagens.includes("[Sistema: fotos enviadas");

  if (ehTextoNormal && !jaEnviouFotos && clienteEstaPedindoFotosDoEstoque(text, conversas[from])) {
    const veiculo = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
    if (veiculo && veiculo.fotos && veiculo.fotos.length > 0) {
      console.log(`[Fotos] Enviando ${veiculo.fotos.length} fotos do ${veiculo.modelo}`);
      await enviarFotosVeiculo(from, veiculo);
      conversas[from].push({
        role: "user",
        content: `[Sistema: fotos enviadas automaticamente do ${limparTexto(veiculo.modelo)}. Confirme o envio de forma natural e pergunte o que o cliente achou.]`
      });
    }
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
      system: SYSTEM_PROMPT(fipeInfo, await formatarAprendizados().catch(() => "")),
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
  salvarMensagemSheets(from, "sara", reply).catch(() => {});
}

async function processarFotosAgrupadas(from, analises) {
  const textoAgrupado = analises.length === 1
    ? `[Cliente enviou foto do veículo. Análise: ${analises[0]}]`
    : `[Cliente enviou ${analises.length} fotos do veículo. Análises:\n${analises.map((a, i) => `Foto ${i + 1}: ${a}`).join("\n")}]`;
  await processarMensagem(from, textoAgrupado);
}

// ─────────────────────────────────────────────
// ROTAS PRINCIPAIS
// ─────────────────────────────────────────────

app.get("/", (req, res) => res.send("Agente funcionando!"));
app.get("/estoque", (req, res) => res.json({ total: estoqueAtual.length, ultimaAtualizacao, veiculos: estoqueAtual }));
app.get("/sincronizar", async (req, res) => { res.send("Iniciado!"); await sincronizarEstoque(); });

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
          console.log(`Áudio transcrito de ${from}: ${texto}`);
          await processarMensagem(from, `[Áudio]: ${texto}`);
        } else {
          await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to: from, text: { body: "Não consegui entender o áudio. Pode digitar?" } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
          );
        }

      } else if (msg.type === "image") {
        console.log(`Imagem recebida de ${from}`);
        const caption = msg.image.caption || "";

        if (!filaFotos[from]) {
          filaFotos[from] = { analises: [], timer: null };
        }

        if (filaFotos[from].timer) {
          clearTimeout(filaFotos[from].timer);
        }

        const analise = await analisarImagem(msg.image.id, caption);
        if (analise) filaFotos[from].analises.push(analise);

        // Aguarda 3 segundos para agrupar múltiplas fotos
        filaFotos[from].timer = setTimeout(async () => {
          const analises = [...filaFotos[from].analises];
          delete filaFotos[from];
          if (analises.length > 0) {
            await processarFotosAgrupadas(from, analises);
          } else {
            await processarMensagem(from, `[Cliente enviou foto${caption ? `: ${caption}` : ""}]`);
          }
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
// PAINEL
// ─────────────────────────────────────────────

app.get("/painel", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sarah - Painel Premium Automarcas</title>
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
  .sidebar { width: 280px; background: #161616; border-right: 1px solid #2a2a2a; display: flex; flex-direction: column; }
  .sidebar-header { padding: 12px 16px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #2a2a2a; }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #1f1f1f; transition: background 0.15s; }
  .conv-item:hover { background: #1e1e1e; }
  .conv-item.active { background: #1e2a1e; border-left: 3px solid #f0a500; }
  .conv-phone { font-size: 13px; font-weight: 600; color: #fff; }
  .conv-preview { font-size: 12px; color: #666; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-time { font-size: 11px; color: #555; margin-top: 2px; }
  .conv-badge { display: inline-block; background: #f44336; color: #fff; font-size: 10px; padding: 1px 5px; border-radius: 10px; margin-left: 4px; }
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
  .msg.sara, .msg.intervencao { align-self: flex-end; }
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
  .intervention { background: #1a1a1a; border-top: 1px solid #2a2a2a; padding: 12px 16px; }
  .intervention-header { font-size: 11px; color: #f0a500; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .intervention-input { display: flex; gap: 8px; }
  .intervention-input textarea { flex: 1; background: #252525; border: 1px solid #333; border-radius: 8px; color: #fff; padding: 10px 12px; font-size: 14px; resize: none; height: 60px; font-family: inherit; }
  .intervention-input textarea:focus { outline: none; border-color: #f0a500; }
  .learning-panel { width: 260px; background: #161616; border-left: 1px solid #2a2a2a; display: flex; flex-direction: column; }
  .learning-header { padding: 12px 16px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #2a2a2a; }
  .learning-list { flex: 1; overflow-y: auto; padding: 8px; }
  .learning-item { background: #1e1e1e; border-radius: 8px; padding: 10px; margin-bottom: 8px; font-size: 12px; border-left: 3px solid #f0a500; }
  .learning-item .situation { color: #888; margin-bottom: 4px; }
  .learning-item .correction { color: #b8e6b8; }
  .learning-count { padding: 8px 16px; font-size: 12px; color: #555; border-top: 1px solid #2a2a2a; }
  .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: #444; }
  .loading { text-align: center; padding: 20px; color: #555; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>Sarah <span>Premium Automarcas</span></h1>
  <div class="status"><div class="dot"></div><span id="statusText">Conectando...</span></div>
</header>
<div class="main">
  <div class="sidebar">
    <div class="sidebar-header">Conversas Ativas</div>
    <div class="conv-list" id="convList"><div class="loading">Carregando...</div></div>
  </div>
  <div class="chat-area">
    <div class="chat-header">
      <div class="chat-phone" id="chatPhone">Selecione uma conversa</div>
      <div class="chat-actions" id="chatActions" style="display:none">
        <button class="btn btn-secondary" onclick="marcarResolvido()">✓ Resolvido</button>
        <button class="btn btn-danger" onclick="salvarAprendizado()">💡 Aprendizado</button>
      </div>
    </div>
    <div class="messages" id="messages">
      <div class="empty-state"><span>Selecione uma conversa</span></div>
    </div>
    <div class="intervention" id="interventionArea" style="display:none">
      <div class="intervention-header">⚡ Intervenção — enviado como Sarah</div>
      <div class="intervention-input">
        <textarea id="interventionText" placeholder="Digite e pressione Enter para enviar como Sarah..."></textarea>
        <button class="btn btn-primary" onclick="enviarIntervencao()">Enviar</button>
      </div>
    </div>
  </div>
  <div class="learning-panel">
    <div class="learning-header">💡 Base de Aprendizado</div>
    <div class="learning-list" id="learningList"><div class="loading">Carregando...</div></div>
    <div class="learning-count" id="learningCount"></div>
  </div>
</div>
<script>
const API = window.location.origin;
let conversaAtiva = null;

function formatarTelefone(num) {
  const n = String(num).replace(/\\D/g, '');
  if (n.length >= 12) return '+' + n.slice(0,2) + ' (' + n.slice(2,4) + ') ' + n.slice(4,9) + '-' + n.slice(9);
  return num;
}

function formatarHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
}

async function carregarConversas() {
  try {
    const res = await fetch(API + '/painel/conversas');
    const data = await res.json();
    const list = document.getElementById('convList');
    if (!data.conversas || data.conversas.length === 0) {
      list.innerHTML = '<div class="loading">Nenhuma conversa ainda</div>';
      document.getElementById('statusText').textContent = 'Nenhuma conversa ativa';
      return;
    }
    list.innerHTML = data.conversas.map(c =>
      '<div class="conv-item ' + (c.from === conversaAtiva ? 'active' : '') + '" onclick="abrirConversa(\\'' + c.from + '\\')">' +
      '<div class="conv-phone">' + formatarTelefone(c.from) + (c.naoLida ? '<span class="conv-badge">' + c.naoLida + '</span>' : '') + '</div>' +
      '<div class="conv-preview">' + (c.ultimaMensagem || '') + '</div>' +
      '<div class="conv-time">' + formatarHora(c.ultimaAtividade) + '</div></div>'
    ).join('');
    document.getElementById('statusText').textContent = data.conversas.length + ' conversa(s) ativa(s)';
  } catch(e) {
    document.getElementById('statusText').textContent = 'Erro de conexão';
  }
}

async function abrirConversa(from) {
  conversaAtiva = from;
  document.getElementById('chatPhone').textContent = formatarTelefone(from);
  document.getElementById('chatActions').style.display = 'flex';
  document.getElementById('interventionArea').style.display = 'block';
  await carregarMensagens(from);
  await carregarConversas();
}

async function carregarMensagens(from) {
  try {
    const res = await fetch(API + '/painel/mensagens/' + from);
    const data = await res.json();
    const msgs = document.getElementById('messages');
    if (!data.mensagens || data.mensagens.length === 0) {
      msgs.innerHTML = '<div class="loading">Nenhuma mensagem</div>';
      return;
    }
    msgs.innerHTML = data.mensagens.map(m =>
      '<div class="msg ' + m.tipo + '">' +
      '<div class="msg-label">' + (m.tipo === 'client' ? '👤 Cliente' : m.tipo === 'sara' ? '🤖 Sarah' : '⚡ Você') + '</div>' +
      '<div class="msg-bubble">' + m.texto.replace(/\\n/g, '<br>') + '</div>' +
      '<div class="msg-meta">' + formatarHora(m.timestamp) + '</div></div>'
    ).join('');
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) {}
}

async function enviarIntervencao() {
  if (!conversaAtiva) return;
  const texto = document.getElementById('interventionText').value.trim();
  if (!texto) return;
  const res = await fetch(API + '/painel/intervencao', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ from: conversaAtiva, texto })
  });
  if (res.ok) {
    document.getElementById('interventionText').value = '';
    await carregarMensagens(conversaAtiva);
  }
}

async function salvarAprendizado() {
  if (!conversaAtiva) return;
  const situacao = prompt('Descreva a situação:');
  if (!situacao) return;
  const correcao = prompt('Como a Sarah deveria responder?');
  if (!correcao) return;
  await fetch(API + '/painel/aprendizado', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ situacao, correcao })
  });
  await carregarAprendizados();
  alert('Aprendizado salvo!');
}

async function marcarResolvido() {
  if (!conversaAtiva) return;
  await fetch(API + '/painel/resolver', {
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

async function carregarAprendizados() {
  try {
    const res = await fetch(API + '/painel/aprendizados');
    const data = await res.json();
    const list = document.getElementById('learningList');
    if (!data.aprendizados || data.aprendizados.length === 0) {
      list.innerHTML = '<div class="loading" style="color:#555">Nenhum aprendizado ainda</div>';
      return;
    }
    list.innerHTML = data.aprendizados.slice(-20).reverse().map(a =>
      '<div class="learning-item"><div class="situation">📌 ' + a.situacao + '</div><div class="correction">✓ ' + a.correcao.substring(0,100) + '</div></div>'
    ).join('');
    document.getElementById('learningCount').textContent = data.aprendizados.length + ' aprendizado(s)';
  } catch(e) {}
}

document.getElementById('interventionText').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarIntervencao(); }
});

async function atualizar() {
  await carregarConversas();
  if (conversaAtiva) await carregarMensagens(conversaAtiva);
}

carregarConversas();
carregarAprendizados();
setInterval(atualizar, 5000);
</script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/painel/conversas", async (req, res) => {
  try { res.json({ conversas: await listarConversasSheets() }); }
  catch (e) { res.json({ conversas: [] }); }
});

app.get("/painel/mensagens/:from", async (req, res) => {
  try { res.json({ mensagens: await buscarMensagensSheets(req.params.from) }); }
  catch (e) { res.json({ mensagens: [] }); }
});

app.post("/painel/intervencao", async (req, res) => {
  const { from, texto } = req.body;
  if (!from || !texto) return res.status(400).json({ erro: "Dados inválidos" });
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: texto } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    if (!conversas[from]) conversas[from] = [];
    conversas[from].push({ role: "assistant", content: texto });
    await salvarMensagemSheets(from, "intervencao", texto);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post("/painel/aprendizado", async (req, res) => {
  const { situacao, correcao } = req.body;
  if (!situacao || !correcao) return res.status(400).json({ erro: "Dados inválidos" });
  try {
    await sheetsAppend("Aprendizados!A:C", [[new Date().toISOString(), situacao, correcao]]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get("/painel/aprendizados", async (req, res) => {
  try { res.json({ aprendizados: await buscarAprendizadosSheets() }); }
  catch (e) { res.json({ aprendizados: [] }); }
});

app.post("/painel/resolver", async (req, res) => {
  const { from } = req.body;
  if (conversas[from]) delete conversas[from];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
