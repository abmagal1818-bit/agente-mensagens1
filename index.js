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

async function sincronizarEstoque() {
  console.log("[Estoque] Iniciando sincronização...");
  try {
    const auth = await fazerLoginMobigestor();
    if (!auth) {
      console.log("[Estoque] ❌ Falha no login");
      return;
    }

    const resultado = await buscarVeiculosMobigestor(auth);
    if (!resultado) {
      console.log("[Estoque] ❌ Não foi possível buscar veículos");
      return;
    }

    const { lista, authHeaders } = resultado;
    const estoqueNovo = [];

    for (const v of lista) {
      const id = v.id || v.anuncioId || v.codigoAnuncio || v.codigo;
      const fotos = await buscarFotosVeiculo(id, authHeaders);
      estoqueNovo.push({
        id,
        marca:         v.marca         || v.brand        || "",
        modelo:        v.modelo        || v.model        || "",
        versao:        v.versao        || v.version      || "",
        ano:           v.anoModelo     || v.ano          || v.year || "",
        anoFabricacao: v.anoFabricacao || "",
        km:            v.quilometragem || v.km           || v.mileage || 0,
        preco:         v.preco         || v.price        || 0,
        cambio:        v.cambio        || v.transmission || "",
        combustivel:   v.combustivel   || v.fuel         || "",
        cor:           v.cor           || v.color        || "",
        opcionais:     v.opcionais     || v.features     || [],
        descricao:     v.descricao     || v.description  || "",
        fotos,
      });
      await new Promise(r => setTimeout(r, 200));
    }

    estoqueAtual = estoqueNovo;
    ultimaAtualizacao = new Date().toLocaleString("pt-BR");
    const comFotos = estoqueNovo.filter(v => v.fotos.length > 0).length;
    console.log(`[Estoque] ✅ ${estoqueNovo.length} veículos | ${comFotos} com fotos | ${ultimaAtualizacao}`);

  } catch(e) {
    console.error("[Estoque] Erro:", e.message);
  }
}

// Roda ao iniciar e depois a cada 6 horas
sincronizarEstoque();
setInterval(sincronizarEstoque, 6 * 60 * 60 * 1000);

// ─────────────────────────────────────────────
// FUNÇÕES DA SARA (sem alteração)
// ─────────────────────────────────────────────

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque sendo carregado.";
  return estoqueAtual.map(v =>
    `${v.marca} ${v.modelo} ${v.versao} ${v.ano} - ${v.km.toLocaleString("pt-BR")} km - R$ ${v.preco.toLocaleString("pt-BR")} - ${v.cor} - ${v.cambio}`
  ).join("\n");
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

const SYSTEM_PROMPT = (fipeInfo) => `Você é Sarah, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

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

SIMULAÇÃO DE FINANCIAMENTO:
Pergunte valor, entrada e prazo. Taxa 1,8%/mês.
Fórmula: PMT = PV × (i×(1+i)^n)/((1+i)^n-1)
Apresente apenas o valor da parcela, sem mencionar a fórmula.

REGRAS:
- Primeira mensagem: "Oi! 😊 Aqui é a Sarah da Premium Automarcas!"
- Demais mensagens: direto ao assunto
- Máximo 4 linhas
- Emojis com moderação 🚗
- Humano: (51) 99364-2476
- NUNCA invente links, URLs ou endereços de site
- NUNCA invente informações de estoque`;

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
function detectarPedidoDeFotos(texto, estoque) {
  const t = texto.toLowerCase();
  const pedindoFotos = t.includes("foto") || t.includes("imagem") || t.includes("ver o carro") || t.includes("como está") || t.includes("como esta");
  if (!pedindoFotos) return null;

  for (const v of estoque) {
    const nome = `${v.marca} ${v.modelo} ${v.versao}`.toLowerCase();
    const palavras = nome.split(" ").filter(p => p.length > 3);
    if (palavras.some(p => t.includes(p))) return v;
  }
  return null;
}

async function processarMensagem(from, text) {
  if (!conversas[from]) conversas[from] = [];
  conversas[from].push({ role: "user", content: text });
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  // Verifica se cliente pediu fotos
  const veiculoComFotos = detectarPedidoDeFotos(text, estoqueAtual);
  if (veiculoComFotos && veiculoComFotos.fotos.length > 0) {
    console.log(`[Fotos] Enviando fotos do ${veiculoComFotos.marca} ${veiculoComFotos.modelo}`);
    await enviarFotosVeiculo(from, veiculoComFotos);
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
      system: SYSTEM_PROMPT(fipeInfo),
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
