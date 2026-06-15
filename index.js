const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
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

// Testa conexão com Supabase na inicialização
async function testarSupabase() {
  try {
    const { data, error } = await supabase.from("mensagens").select("count").limit(1);
    if (error) {
      console.error("[Supabase] ❌ Erro de conexão:", error.message, JSON.stringify(error));
    } else {
      console.log("[Supabase] ✅ Conexão OK!");
    }
  } catch (e) {
    console.error("[Supabase] ❌ Exceção na conexão:", e.message);
  }
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
  const historico = (historicoConversa || [])
    .slice(-10)
    .map(m => m.content || "")
    .join(" ")
    .toLowerCase();
  return historico.includes("tenho um") || historico.includes("meu carro") ||
    historico.includes("quero vender") || historico.includes("na troca") ||
    historico.includes("pra troca") || historico.includes("dar na troca") ||
    historico.includes("mandar umas fotos") || historico.includes("manda umas fotos") ||
    historico.includes("consegue mandar fotos");
}

// ─────────────────────────────────────────────
// SUPABASE — MENSAGENS
// ─────────────────────────────────────────────

async function salvarMensagem(telefone, tipo, texto) {
  try {
    console.log(`[Supabase] Salvando mensagem: ${telefone} | ${tipo}`);
    const { data, error } = await supabase.from("mensagens").insert({
      telefone,
      tipo,
      texto: String(texto).substring(0, 500)
    });
    if (error) {
      console.error("[Supabase] ❌ Erro insert:", error.message, JSON.stringify(error));
    } else {
      console.log(`[Supabase] ✅ Mensagem salva: ${telefone} | ${tipo}`);
    }

    const { error: error2 } = await supabase.from("clientes").upsert({
      telefone,
      ultima_interacao: new Date().toISOString()
    }, { onConflict: "telefone" });
    if (error2) {
      console.error("[Supabase] ❌ Erro upsert cliente:", error2.message);
    }
  } catch (e) {
    console.error("[Supabase] ❌ Exceção salvarMensagem:", e.message);
  }
}

async function buscarMensagens(telefone) {
  try {
    const { data, error } = await supabase
      .from("mensagens")
      .select("*")
      .eq("telefone", telefone)
      .order("criado_em", { ascending: true })
      .limit(100);
    if (error) console.error("[Supabase] Erro buscarMensagens:", error.message);
    return data || [];
  } catch (e) {
    console.error("[Supabase] Erro buscarMensagens:", e.message);
    return [];
  }
}

async function listarConversas() {
  try {
    const { data, error } = await supabase
      .from("mensagens")
      .select("telefone, texto, tipo, criado_em")
      .order("criado_em", { ascending: false });

    if (error) {
      console.error("[Supabase] Erro listarConversas:", error.message);
      return [];
    }
    if (!data) return [];

    const mapa = {};
    data.forEach(m => {
      if (!mapa[m.telefone]) {
        mapa[m.telefone] = {
          from: m.telefone,
          ultimaMensagem: m.texto?.substring(0, 50) || "",
          ultimaAtividade: m.criado_em,
          naoLida: 0
        };
      }
      if (m.tipo === "client") {
        const visualizadoEm = conversasVisualizadas[m.telefone] || 0;
        const chegouEm = new Date(m.criado_em).getTime();
        if (chegouEm > visualizadoEm) {
          mapa[m.telefone].naoLida++;
        }
      }
    });

    return Object.values(mapa).sort((a, b) =>
      new Date(b.ultimaAtividade) - new Date(a.ultimaAtividade)
    );
  } catch (e) {
    console.error("[Supabase] Erro listarConversas:", e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// SUPABASE — APRENDIZADOS
// ─────────────────────────────────────────────

async function salvarAprendizado(situacao, correcao) {
  try {
    const { error } = await supabase.from("aprendizados").insert({ situacao, correcao });
    if (error) console.error("[Supabase] Erro salvarAprendizado:", error.message);
  } catch (e) {
    console.error("[Supabase] Erro salvarAprendizado:", e.message);
  }
}

async function buscarAprendizados() {
  try {
    const { data } = await supabase
      .from("aprendizados")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(20);
    return data || [];
  } catch (e) {
    return [];
  }
}

async function formatarAprendizados() {
  const aprendizados = await buscarAprendizados();
  if (aprendizados.length === 0) return "";
  return "\n\nEXEMPLOS DE COMO RESPONDER (aprenda com esses casos):\n" +
    aprendizados.slice(0, 10).map(a => `Situação: ${a.situacao}\nResposta correta: ${a.correcao}`).join("\n---\n");
}

// ─────────────────────────────────────────────
// SUPABASE — FOLLOW-UPS
// ─────────────────────────────────────────────

async function agendarFollowUp(telefone, motivo, veiculoInteresse, diasAguardar) {
  try {
    const agendadoPara = new Date();
    agendadoPara.setDate(agendadoPara.getDate() + diasAguardar);

    await supabase.from("followups").update({ enviado: true }).eq("telefone", telefone).eq("enviado", false);

    const { error } = await supabase.from("followups").insert({
      telefone, motivo,
      veiculo_interesse: veiculoInteresse,
      agendado_para: agendadoPara.toISOString(),
      enviado: false
    });
    if (error) console.error("[Supabase] Erro agendarFollowUp:", error.message);
    else console.log(`[FollowUp] Agendado para ${telefone} em ${diasAguardar} dias — motivo: ${motivo}`);
  } catch (e) {
    console.error("[Supabase] Erro agendarFollowUp:", e.message);
  }
}

async function detectarLeadFrio(from, text, historicoConversa) {
  try {
    const t = text.toLowerCase();
    const historico = (historicoConversa || []).slice(-10).map(m => m.content || "").join(" ").toLowerCase();

    let motivo = null;
    let diasAguardar = 1;

    const frasesPensar = [
      "vou pensar", "preciso pensar", "deixa eu pensar",
      "vou ver", "deixa eu ver", "vou decidir",
      "vou falar com minha esposa", "vou falar com meu marido",
      "vou falar com a minha esposa", "vou falar com o meu marido",
      "vou consultar", "vou falar com a família", "vou falar com minha familia",
      "retorno em breve", "depois te aviso", "te aviso depois",
      "vou dar um retorno", "vou retornar", "depois eu volto",
      "vou conversar com", "deixa eu conversar"
    ];
    if (frasesPensar.some(f => t.includes(f))) { motivo = "vai_pensar"; diasAguardar = 1; }

    const frasesCaro = [
      "tá caro", "está caro", "muito caro", "caro demais",
      "não tenho condição", "não tenho dinheiro", "sem condição",
      "tá pesado", "está pesado", "pesado demais",
      "fora do meu orçamento", "acima do meu orçamento",
      "não cabe no bolso", "não tenho esse valor",
      "não consigo", "não tenho como", "excede meu orçamento"
    ];
    if (!motivo && frasesCaro.some(f => t.includes(f))) { motivo = "achou_caro"; diasAguardar = 3; }

    const frasesAvaliacao = [
      "avaliação baixa", "avaliacao baixa", "pouco pelo meu",
      "esperava mais", "vale mais", "não compensa",
      "abaixo do esperado", "achei pouco", "muito pouco"
    ];
    if (!motivo && frasesAvaliacao.some(f => t.includes(f))) { motivo = "avaliacao_baixa"; diasAguardar = 5; }

    const frasesSemInteresse = [
      "não tenho interesse", "nao tenho interesse",
      "desisti", "não quero mais", "nao quero mais",
      "mudei de ideia", "cancelar", "esquece", "deixa pra lá"
    ];
    if (!motivo && frasesSemInteresse.some(f => t.includes(f))) { motivo = "sem_interesse"; diasAguardar = 7; }

    if (!motivo) return;

    const veiculoMatch = historico.match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid/i);
    await agendarFollowUp(from, motivo, veiculoMatch ? veiculoMatch[0] : null, diasAguardar);
  } catch (e) {
    console.error("[FollowUp] Erro detectarLeadFrio:", e.message);
  }
}

async function verificarClientesSumidos() {
  try {
    const agora = Date.now();
    const vintequatroHoras = 24 * 60 * 60 * 1000;
    for (const [telefone, ultimaMensagem] of Object.entries(ultimaMensagemCliente)) {
      if (agora - ultimaMensagem > vintequatroHoras) {
        const { data } = await supabase.from("followups").select("id").eq("telefone", telefone).eq("enviado", false).limit(1);
        if (!data || data.length === 0) {
          const historico = conversas[telefone] || [];
          const veiculoMatch = historico.map(m => m.content || "").join(" ").toLowerCase()
            .match(/evoque|jetta|compass|corolla|civic|tracker|creta|tucson|renegade|hilux|ranger|voyage|gol|onix|polo|hb20|argo|sandero|kwid/i);
          await agendarFollowUp(telefone, "sumiu", veiculoMatch ? veiculoMatch[0] : null, 5);
        }
        delete ultimaMensagemCliente[telefone];
      }
    }
  } catch (e) {
    console.error("[FollowUp] Erro verificarClientesSumidos:", e.message);
  }
}

setInterval(verificarClientesSumidos, 60 * 60 * 1000);

async function gerarMensagemFollowUp(followup) {
  try {
    const veiculo = followup.veiculo_interesse || "nossos veículos";
    const prompts = {
      vai_pensar: `Você é Sarah, vendedora da Premium Automarcas em Porto Alegre. Um cliente estava interessado em ${veiculo} mas disse que ia pensar. Crie uma mensagem curta e calorosa de follow-up, sem pressionar. Máximo 3 linhas.`,
      achou_caro: `Você é Sarah, vendedora da Premium Automarcas. Um cliente achou o ${veiculo} caro. Crie uma mensagem curta perguntando qual seria o valor de parcela ideal. Máximo 3 linhas.`,
      avaliacao_baixa: `Você é Sarah, vendedora da Premium Automarcas. Um cliente ficou insatisfeito com a avaliação na troca. Reforce que a avaliação presencial pode surpreender. Máximo 3 linhas.`,
      sem_interesse: `Você é Sarah, vendedora da Premium Automarcas. Um cliente disse que não tinha interesse. Mensagem muito leve perguntando se posso ajudar. Máximo 2 linhas.`,
      sumiu: `Você é Sarah, vendedora da Premium Automarcas. Um cliente parou de responder sobre ${veiculo}. Mensagem curta para retomar contato. Máximo 2 linhas.`
    };
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 200, messages: [{ role: "user", content: prompts[followup.motivo] || prompts.vai_pensar }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    return res.data.content[0].text;
  } catch (e) {
    console.error("[FollowUp] Erro gerarMensagem:", e.message);
    return null;
  }
}

async function processarFollowUpsPendentes() {
  try {
    const { data: followups } = await supabase.from("followups").select("*").eq("enviado", false).lte("agendado_para", new Date().toISOString());
    if (!followups || followups.length === 0) return;
    console.log(`[FollowUp] ${followups.length} follow-up(s) para enviar`);
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
        console.log(`[FollowUp] ✅ Enviado para ${followup.telefone}`);
        await notificarAugusto(followup.telefone, `[FollowUp automático]: ${mensagem}`, false);
      } catch (e) {
        console.error(`[FollowUp] Erro ao enviar:`, e.message);
      }
    }
  } catch (e) {
    console.error("[FollowUp] Erro processarFollowUpsPendentes:", e.message);
  }
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
  const emoji = primeiraVez ? "🆕" : "📩";
  const titulo = primeiraVez ? "Novo cliente na Sarah" : "Mensagem na Sarah";
  const mensagem = `${emoji} *${titulo}*\nNúmero: ${formatado}\nMensagem: "${String(texto).substring(0, 100)}"\n\nAcesse o painel: https://agente-mensagens1.onrender.com/painel`;

  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Notificação] ✅ ${primeiraVez ? "Novo cliente" : "Atualização"} — ${formatado}`);
  } catch (e) {
    console.error(`[Notificação] ❌ Erro:`, e.message);
  }
}

async function notificarCarroNaoDisponivel(from, modeloBuscado, infoCliente) {
  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12 ? `+${numero.slice(0,2)} (${numero.slice(2,4)}) ${numero.slice(4,9)}-${numero.slice(9)}` : from;
  const mensagem = `🔍 *Cliente buscando carro não disponível*\n\nCliente: ${formatado}\nCarro de interesse: *${modeloBuscado}*\n${infoCliente ? `Detalhes: ${infoCliente}` : ""}\n\nConsidere buscar esse veículo!`;
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Notificação] ✅ Carro não disponível: ${modeloBuscado}`);
  } catch (e) {
    console.error(`[Notificação] Erro carro não disponível:`, e.message);
  }
}

// ─────────────────────────────────────────────
// INSTAGRAM
// ─────────────────────────────────────────────

async function buscarEstoqueInstagram() {
  try {
    console.log("[Instagram] Buscando posts...");
    const url = `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media?fields=id,caption,media_type,media_url,children{media_url}&limit=50&access_token=${INSTAGRAM_TOKEN}`;
    const res = await axios.get(url);
    const posts = res.data.data || [];
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
      veiculos.push({
        id: post.id,
        modelo: limparTexto(linhas[0] || "").replace(/[🚗🚙🏎️]/g, "").trim(),
        ano: anoMatch ? (anoMatch[1] || anoMatch[2]) : "",
        km: kmMatch ? parseFloat(kmMatch[1].replace(/\./g, "").replace(",", ".")) : 0,
        preco: precoMatch ? parseFloat(precoMatch[1].replace(/\./g, "").replace(",", ".")) : 0,
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
setInterval(sincronizarEstoque, 30 * 60 * 1000);

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
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 150, messages: [{ role: "user", content: `Analise esse texto e extraia o veículo que o cliente quer VENDER ou DAR NA TROCA.
Responda APENAS em JSON: {"marca": "...", "modelo": "...", "ano": "..."}
Use nomes simples em minúsculo. Se não encontrar, coloque null.
Exemplos: "tenho um gol 2012" → {"marca": "volkswagen", "modelo": "gol", "ano": "2012"}
Texto: "${textos.join(" ")}"` }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const jsonMatch = res.data.content[0].text.trim().match(/\{[^}]+\}/);
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
    const marcaFipe = marcas.find(m => m.nome.toLowerCase().includes(marca.toLowerCase()) || marca.toLowerCase().includes(m.nome.toLowerCase().split(" ")[0]));
    if (!marcaFipe) return null;
    const modelosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos`);
    const candidatos = modelosRes.data.modelos.filter(m => m.nome.toLowerCase().includes(modelo.toLowerCase().split(" ")[0]));
    if (!candidatos.length) return null;
    for (const candidato of candidatos) {
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
  } catch (e) { return null; }
}

async function analisarImagem(mediaId, caption) {
  try {
    const mediaRes = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const imageRes = await axios.get(mediaRes.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer" });
    const base64Image = Buffer.from(imageRes.data).toString("base64");
    const mimeType = mediaRes.data.mime_type || "image/jpeg";
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 200, messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
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

  const naoEPedido = ["te mando", "vou mandar", "vou te mandar", "ja mando", "já mando", "mando agora", "mando foto", "mandando foto", "vou enviar", "to mandando", "tô mandando", "estou mandando", "to enviando"];
  if (naoEPedido.some(p => t.includes(p))) return false;

  const ePedido = ["tem foto", "tem fotos", "manda foto", "manda as foto", "pode mandar foto", "me manda foto", "me passa foto", "quero ver foto", "quero ver as foto", "tem imagem", "me mostra", "posso ver", "ver o interior", "ver o exterior", "ver por dentro", "ver por fora", "foto dele", "fotos dele", "vai mandar as fotos", "vai mandar foto", "as fotos"];
  if (ePedido.some(p => t.includes(p))) return true;

  return false;
}

function encontrarVeiculoNoContexto(texto, historicoConversa, estoque) {
  const ultimaResposta = (historicoConversa || []).filter(m => m.role === "assistant").slice(-1)[0]?.content || "";
  const contextoCompleto = [texto, ...(historicoConversa || []).filter(m => m.role === "user").slice(-8).map(m => m.content)].join(" ").toLowerCase() + " " + ultimaResposta.toLowerCase();

  let melhorMatch = null;
  let melhorScore = 0;
  for (const v of estoque) {
    const modelo = limparTexto(v.modelo || "").toLowerCase();
    const palavras = modelo.split(/\s+/).filter(p => p.length > 2);
    let score = palavras.filter(p => contextoCompleto.includes(p)).length;
    if (v.ano && contextoCompleto.includes(String(v.ano))) score += 2;
    if (score > melhorScore) { melhorScore = score; melhorMatch = v; }
  }
  return melhorScore >= 1 ? melhorMatch : null;
}

async function enviarFotosVeiculo(to, veiculo) {
  const fotos = (veiculo.fotos || []).slice(0, 5);
  if (!fotos.length) return false;
  for (const url of fotos) {
    try {
      await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to, type: "image", image: { link: url } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
      );
      await new Promise(r => setTimeout(r, 600));
    } catch (e) { console.error(`Erro foto: ${e.message}`); }
  }
  return true;
}

// ─────────────────────────────────────────────
// DETECTA MODELO BUSCADO
// ─────────────────────────────────────────────

async function extrairModeloBuscado(textos) {
  try {
    const res = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: `Extraia o modelo de carro que o cliente quer COMPRAR.
Responda APENAS em JSON: {"modelo": "...", "ano": "..."}
Se não encontrar, coloque null.
Exemplos: "quero uma renegade 2020" → {"modelo": "renegade", "ano": "2020"}
"tenho um gol pra vender" → {"modelo": null, "ano": null}
Texto: "${textos.join(" ")}"` }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const jsonMatch = res.data.content[0].text.trim().match(/\{[^}]+\}/);
    if (!jsonMatch) return null;
    const json = JSON.parse(jsonMatch[0]);
    return json.modelo ? json : null;
  } catch (e) { return null; }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

function formatarEstoque() {
  if (!estoqueAtual.length) return "Estoque sendo carregado.";
  return estoqueAtual.map(v => `${limparTexto(v.modelo || "")} ${v.ano || ""} - ${Number(v.km || 0).toLocaleString("pt-BR")} km - R$ ${Number(v.preco || 0).toLocaleString("pt-BR")}`).join("\n");
}

const SYSTEM_PROMPT = (fipeInfo, aprendizadosExtra = "", carroNaoDisponivel = null) => `Você é Sarah, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

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

QUANDO CLIENTE PEDE CARRO QUE NÃO ESTÁ NO ESTOQUE:
${carroNaoDisponivel ?
    `⚠️ Cliente procura: ${carroNaoDisponivel} — NÃO disponível no momento.
NUNCA diga apenas "não temos". Siga este fluxo:
1. Informe que esse modelo não está disponível no momento
2. Pergunte detalhes para avisar quando chegar ou encontrar similar:
   - "Que ano você está procurando?"
   - "Qual sua faixa de preço ou valor de parcela?"
   - "Tem carro para dar na troca?"
3. Diga: "Posso te avisar quando chegar um ${carroNaoDisponivel} aqui! 😊"
4. Só ofereça alternativas do estoque se tiver algo REALMENTE similar` :
    `Se cliente pedir carro não disponível: qualifique (ano, orçamento, troca) antes de oferecer alternativas. Ofereça avisar quando chegar.`}

FOTOS DOS VEÍCULOS:
- Quando sistema confirmar envio, diga: "Mandei as fotos pra você! O que achou? 😊"
- NUNCA diga que enviou sem confirmação do sistema
- NUNCA use tags XML

PAGAMENTO: Financiamento (BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú), Cartão, Consórcio, À vista

FLUXO DE AVALIAÇÃO DE TROCA:
ETAPA 1 — Conhecer o carro: km, estado geral, revisões, fotos 📸
ETAPA 2 — Fotos recebidas: agradeça e comente positivamente
ETAPA 3 — Só após ter km, estado e fotos:
${fipeInfo ? (() => {
    const v = calcularValoresTroca(fipeInfo.Valor);
    return `✅ FIPE: ${fipeInfo.Modelo} ${fipeInfo.AnoModelo} = ${fipeInfo.Valor}
Faixa: R$ ${v.minimoFormatado} a R$ ${v.maximoFormatado}
Diga: "Conseguimos trabalhar entre R$ ${v.minimoFormatado} e R$ ${v.maximoFormatado} na troca. Avaliação final é presencial!"
NÃO mencione FIPE, percentuais ou descontos.`;
  })() : `⚠️ FIPE não consultada — NUNCA invente valores.`}

QUANDO CLIENTE ACHAR CARO: Pergunte qual parcela cabe no orçamento e tente adaptar.
QUANDO DISSER "VOU PENSAR": Pergunte o que ficou na dúvida antes de encerrar.

SIMULAÇÃO: Taxa 1,8%/mês. PMT = PV × (i×(1+i)^n)/((1+i)^n-1). Só simule se cliente pedir.
TROCO: Banco financia até FIPE. Valor financiado = preço + troco - saldo troca.

REGRAS:
- Primeira mensagem: "Oi! 😊 Aqui é a Sarah da Premium Automarcas!"
- Máximo 4 linhas, emojis com moderação 🚗
- Humano: (51) 99364-2476
- NUNCA invente links, informações ou use tags XML${aprendizadosExtra}`;

// ─────────────────────────────────────────────
// PROCESSAMENTO
// ─────────────────────────────────────────────

async function processarMensagem(from, text) {
  if (!text || typeof text !== "string") return;

  ultimaMensagemCliente[from] = Date.now();
  const primeiraVez = !ultimaNotificacao[from];
  if (!conversas[from]) conversas[from] = [];
  conversas[from].push({ role: "user", content: text });

  // Salva no Supabase
  await salvarMensagem(from, "client", text);
  notificarAugusto(from, text, primeiraVez).catch(() => {});
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  detectarLeadFrio(from, text, conversas[from]).catch(() => {});

  // Detecta carro não disponível
  let carroNaoDisponivel = null;
  const todosTextos = conversas[from].filter(m => m.role === "user").map(m => m.content);
  const modeloBuscado = await extrairModeloBuscado(todosTextos);

  if (modeloBuscado) {
    const modeloNome = modeloBuscado.modelo.toLowerCase();
    const anoNome = modeloBuscado.ano;
    const encontrado = estoqueAtual.some(v => {
      const modeloEstoque = limparTexto(v.modelo || "").toLowerCase();
      const anoOk = !anoNome || String(v.ano) === String(anoNome);
      return modeloEstoque.includes(modeloNome) && anoOk;
    });

    if (!encontrado) {
      const descricao = `${modeloBuscado.modelo}${anoNome ? ` ${anoNome}` : ""}`;
      carroNaoDisponivel = descricao;
      const jaNotificou = conversas[from].some(m => m.content?.includes("[Sistema: cliente buscou"));
      if (!jaNotificou) {
        notificarCarroNaoDisponivel(from, descricao, todosTextos.slice(-3).join(" | ")).catch(() => {});
        conversas[from].push({ role: "user", content: `[Sistema: cliente buscou ${descricao} que não está no estoque. Augusto foi notificado. Qualifique o cliente.]` });
      }
    }
  }

  // Fotos do estoque
  const ehTextoNormal = !text.startsWith("[Cliente enviou foto") && !text.startsWith("[Áudio]") && !text.startsWith("[Sistema:");
  const jaEnviouFotos = conversas[from].slice(-6).map(m => m.content || "").join(" ").includes("[Sistema: fotos enviadas");

  if (ehTextoNormal && !jaEnviouFotos && clienteEstaPedindoFotosDoEstoque(text, conversas[from])) {
    const veiculo = encontrarVeiculoNoContexto(text, conversas[from], estoqueAtual);
    if (veiculo && veiculo.fotos?.length > 0) {
      console.log(`[Fotos] Enviando ${veiculo.fotos.length} fotos do ${veiculo.modelo}`);
      await enviarFotosVeiculo(from, veiculo);
      conversas[from].push({ role: "user", content: `[Sistema: fotos enviadas automaticamente do ${limparTexto(veiculo.modelo)}. Confirme o envio e pergunte o que o cliente achou.]` });
    }
  }

  const { marca, modelo, ano } = await extrairVeiculoParaTroca(todosTextos);
  let fipeInfo = null;
  if (marca && modelo && ano) fipeInfo = await consultarFipe(marca, modelo, ano);

  const claude = await axios.post("https://api.anthropic.com/v1/messages",
    { model: "claude-sonnet-4-5", max_tokens: 500, system: SYSTEM_PROMPT(fipeInfo, await formatarAprendizados().catch(() => ""), carroNaoDisponivel), messages: conversas[from] },
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
  const textoAgrupado = analises.length === 1
    ? `[Cliente enviou foto do veículo. Análise: ${analises[0]}]`
    : `[Cliente enviou ${analises.length} fotos. Análises:\n${analises.map((a, i) => `Foto ${i+1}: ${a}`).join("\n")}]`;
  await processarMensagem(from, textoAgrupado);
}

// ─────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────

app.get("/", (req, res) => res.send("Agente funcionando!"));
app.get("/estoque", (req, res) => res.json({ total: estoqueAtual.length, ultimaAtualizacao, veiculos: estoqueAtual }));
app.get("/sincronizar", async (req, res) => { res.send("Iniciado!"); await sincronizarEstoque(); });

app.get("/testar-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("mensagens").select("count").limit(1);
    if (error) return res.json({ ok: false, erro: error.message, detalhe: JSON.stringify(error) });
    const { data: total } = await supabase.from("mensagens").select("*", { count: "exact", head: true });
    res.json({ ok: true, mensagem: "Supabase conectado!", total: total });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

app.get("/testar-notificacao", async (req, res) => {
  try {
    const resultado = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: "✅ Teste de notificação da Sarah funcionando!" } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true, numero: NUMERO_AUGUSTO, resultado: resultado.data });
  } catch (e) {
    res.json({ ok: false, erro: e.message, detalhe: e.response?.data });
  }
});

app.get("/followups", async (req, res) => {
  try {
    const { data } = await supabase.from("followups").select("*").order("criado_em", { ascending: false }).limit(50);
    res.json({ followups: data || [] });
  } catch (e) { res.json({ followups: [] }); }
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
        await processarMensagem(from, text);

      } else if (msg.type === "audio") {
        const texto = await transcreverAudio(msg.audio.id);
        if (texto) {
          console.log(`Áudio transcrito de ${from}: ${texto}`);
          await processarMensagem(from, `[Áudio]: ${texto}`);
        } else {
          await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to: from, text: { body: "Não consegui entender o áudio. Pode digitar?" } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
          );
        }

      } else if (msg.type === "image") {
        console.log(`Imagem recebida de ${from}`);
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
          else await processarMensagem(from, `[Cliente enviou foto${caption ? `: ${caption}` : ""}]`);
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

app.get("/assinar-webhook", async (req, res) => {
  try {
    const result = await axios.post(`https://graph.facebook.com/v18.0/2609687206092266/subscribed_apps`, {},
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    res.send("Assinado! " + JSON.stringify(result.data));
  } catch (e) { res.send("Erro: " + JSON.stringify(e.response?.data)); }
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
  header h1 { font-size: 18px; color: #fff; } header h1 span { color: #f0a500; }
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
  .conv-item.unread { border-left: 3px solid #f44336; }
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
  .btn-primary { background: #f0a500; color: #000; } .btn-danger { background: #f44336; color: #fff; }
  .btn-secondary { background: #333; color: #fff; } .btn-followup { background: #1565c0; color: #fff; }
  .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 75%; }
  .msg.client { align-self: flex-start; } .msg.sara, .msg.intervencao { align-self: flex-end; }
  .msg-bubble { padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
  .msg.client .msg-bubble { background: #2a2a2a; color: #e0e0e0; border-bottom-left-radius: 3px; }
  .msg.sara .msg-bubble { background: #1a3a1a; color: #b8e6b8; border-bottom-right-radius: 3px; }
  .msg.intervencao .msg-bubble { background: #2a1a00; color: #f0c060; border-bottom-right-radius: 3px; border: 1px solid #f0a500; }
  .msg-meta { font-size: 11px; color: #555; margin-top: 3px; }
  .msg.sara .msg-meta, .msg.intervencao .msg-meta { text-align: right; }
  .msg-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .msg.client .msg-label { color: #666; } .msg.sara .msg-label { color: #4a8; text-align: right; } .msg.intervencao .msg-label { color: #f0a500; text-align: right; }
  .intervention { background: #1a1a1a; border-top: 1px solid #2a2a2a; padding: 12px 16px; }
  .intervention-header { font-size: 11px; color: #f0a500; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .intervention-input { display: flex; gap: 8px; }
  .intervention-input textarea { flex: 1; background: #252525; border: 1px solid #333; border-radius: 8px; color: #fff; padding: 10px 12px; font-size: 14px; resize: none; height: 60px; font-family: inherit; }
  .intervention-input textarea:focus { outline: none; border-color: #f0a500; }
  .learning-panel { width: 260px; background: #161616; border-left: 1px solid #2a2a2a; display: flex; flex-direction: column; }
  .tabs { display: flex; border-bottom: 1px solid #2a2a2a; }
  .tab { flex: 1; padding: 8px 4px; font-size: 11px; color: #666; cursor: pointer; text-transform: uppercase; letter-spacing: 1px; text-align: center; }
  .tab.active { color: #f0a500; border-bottom: 2px solid #f0a500; }
  .learning-list { flex: 1; overflow-y: auto; padding: 8px; }
  .learning-item { background: #1e1e1e; border-radius: 8px; padding: 10px; margin-bottom: 8px; font-size: 12px; border-left: 3px solid #f0a500; }
  .learning-item .situation { color: #888; margin-bottom: 4px; } .learning-item .correction { color: #b8e6b8; }
  .followup-item { background: #1e1e1e; border-radius: 8px; padding: 10px; margin-bottom: 8px; font-size: 12px; border-left: 3px solid #1565c0; }
  .followup-item .fu-phone { color: #64b5f6; font-weight: 600; } .followup-item .fu-motivo { color: #888; margin-top: 2px; } .followup-item .fu-data { color: #555; margin-top: 2px; font-size: 11px; }
  .learning-count { padding: 8px 16px; font-size: 12px; color: #555; border-top: 1px solid #2a2a2a; }
  .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: #444; }
  .loading { text-align: center; padding: 20px; color: #555; font-size: 13px; }
  .aba-content { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
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
        <button class="btn btn-followup" onclick="agendarFollowUpManual()">⏰ Follow-up</button>
        <button class="btn btn-secondary" onclick="marcarResolvido()">✓ Resolvido</button>
        <button class="btn btn-danger" onclick="salvarAprendizado()">💡 Aprendizado</button>
      </div>
    </div>
    <div class="messages" id="messages"><div class="empty-state"><span>Selecione uma conversa</span></div></div>
    <div class="intervention" id="interventionArea" style="display:none">
      <div class="intervention-header">⚡ Intervenção — enviado como Sarah</div>
      <div class="intervention-input">
        <textarea id="interventionText" placeholder="Digite e pressione Enter para enviar como Sarah..."></textarea>
        <button class="btn btn-primary" onclick="enviarIntervencao()">Enviar</button>
      </div>
    </div>
  </div>
  <div class="learning-panel">
    <div class="tabs">
      <div class="tab active" id="tab-aprendizados" onclick="mostrarAba('aprendizados')">💡 Aprend.</div>
      <div class="tab" id="tab-followups" onclick="mostrarAba('followups')">⏰ Follow-ups</div>
    </div>
    <div class="aba-content" id="abaAprendizados">
      <div class="learning-list" id="learningList"><div class="loading">Carregando...</div></div>
      <div class="learning-count" id="learningCount"></div>
    </div>
    <div class="aba-content" id="abaFollowups" style="display:none">
      <div class="learning-list" id="followupList"><div class="loading">Carregando...</div></div>
      <div class="learning-count" id="followupCount"></div>
    </div>
  </div>
</div>
<script>
const API = window.location.origin;
let conversaAtiva = null;

function mostrarAba(aba) {
  document.getElementById('tab-aprendizados').classList.toggle('active', aba === 'aprendizados');
  document.getElementById('tab-followups').classList.toggle('active', aba === 'followups');
  document.getElementById('abaAprendizados').style.display = aba === 'aprendizados' ? 'flex' : 'none';
  document.getElementById('abaFollowups').style.display = aba === 'followups' ? 'flex' : 'none';
  if (aba === 'followups') carregarFollowups();
}

function formatarTelefone(num) {
  const n = String(num).replace(/\\D/g, '');
  if (n.length >= 12) return '+' + n.slice(0,2) + ' (' + n.slice(2,4) + ') ' + n.slice(4,9) + '-' + n.slice(9);
  return num;
}

function formatarHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
}

function formatarData(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
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
      '<div class="conv-item ' + (c.from === conversaAtiva ? 'active' : c.naoLida > 0 ? 'unread' : '') + '" onclick="abrirConversa(\\'' + c.from + '\\')">' +
      '<div class="conv-phone">' + formatarTelefone(c.from) + (c.naoLida > 0 ? '<span class="conv-badge">' + c.naoLida + '</span>' : '') + '</div>' +
      '<div class="conv-preview">' + (c.ultimaMensagem || '') + '</div>' +
      '<div class="conv-time">' + formatarHora(c.ultimaAtividade) + '</div></div>'
    ).join('');
    document.getElementById('statusText').textContent = data.conversas.length + ' conversa(s) ativa(s)';
  } catch(e) { document.getElementById('statusText').textContent = 'Erro de conexão'; }
}

async function abrirConversa(from) {
  conversaAtiva = from;
  document.getElementById('chatPhone').textContent = formatarTelefone(from);
  document.getElementById('chatActions').style.display = 'flex';
  document.getElementById('interventionArea').style.display = 'block';
  await fetch(API + '/painel/visualizar', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ from }) });
  await carregarMensagens(from);
  await carregarConversas();
}

async function carregarMensagens(from) {
  try {
    const res = await fetch(API + '/painel/mensagens/' + from);
    const data = await res.json();
    const msgs = document.getElementById('messages');
    if (!data.mensagens || data.mensagens.length === 0) { msgs.innerHTML = '<div class="loading">Nenhuma mensagem</div>'; return; }
    msgs.innerHTML = data.mensagens.map(m =>
      '<div class="msg ' + m.tipo + '">' +
      '<div class="msg-label">' + (m.tipo === 'client' ? '👤 Cliente' : m.tipo === 'sara' ? '🤖 Sarah' : '⚡ Você') + '</div>' +
      '<div class="msg-bubble">' + (m.texto || '').replace(/\\n/g, '<br>') + '</div>' +
      '<div class="msg-meta">' + formatarHora(m.criado_em) + '</div></div>'
    ).join('');
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) {}
}

async function enviarIntervencao() {
  if (!conversaAtiva) return;
  const texto = document.getElementById('interventionText').value.trim();
  if (!texto) return;
  const res = await fetch(API + '/painel/intervencao', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ from: conversaAtiva, texto }) });
  if (res.ok) { document.getElementById('interventionText').value = ''; await carregarMensagens(conversaAtiva); }
}

async function agendarFollowUpManual() {
  if (!conversaAtiva) return;
  const motivo = prompt('Motivo:\\n- vai_pensar (1 dia)\\n- achou_caro (3 dias)\\n- avaliacao_baixa (5 dias)\\n- sem_interesse (7 dias)\\n- sumiu (5 dias)');
  if (!motivo) return;
  const dias = prompt('Em quantos dias enviar?');
  if (!dias) return;
  const res = await fetch(API + '/painel/followup', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ from: conversaAtiva, motivo, dias: parseInt(dias) }) });
  if (res.ok) alert('✅ Follow-up agendado para ' + dias + ' dias!');
}

async function salvarAprendizado() {
  if (!conversaAtiva) return;
  const situacao = prompt('Descreva a situação:');
  if (!situacao) return;
  const correcao = prompt('Como a Sarah deveria responder?');
  if (!correcao) return;
  await fetch(API + '/painel/aprendizado', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ situacao, correcao }) });
  await carregarAprendizados();
  alert('✅ Aprendizado salvo!');
}

async function marcarResolvido() {
  if (!conversaAtiva) return;
  await fetch(API + '/painel/resolver', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ from: conversaAtiva }) });
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
    if (!data.aprendizados || data.aprendizados.length === 0) { list.innerHTML = '<div class="loading" style="color:#555">Nenhum aprendizado ainda</div>'; return; }
    list.innerHTML = data.aprendizados.map(a => '<div class="learning-item"><div class="situation">📌 ' + a.situacao + '</div><div class="correction">✓ ' + (a.correcao || '').substring(0,100) + '</div></div>').join('');
    document.getElementById('learningCount').textContent = data.aprendizados.length + ' aprendizado(s)';
  } catch(e) {}
}

async function carregarFollowups() {
  try {
    const res = await fetch(API + '/followups');
    const data = await res.json();
    const list = document.getElementById('followupList');
    if (!data.followups || data.followups.length === 0) { list.innerHTML = '<div class="loading" style="color:#555">Nenhum follow-up ainda</div>'; return; }
    const pendentes = data.followups.filter(f => !f.enviado);
    const enviados = data.followups.filter(f => f.enviado);
    list.innerHTML =
      (pendentes.length > 0 ? '<div style="padding:8px;font-size:11px;color:#f0a500;font-weight:600">PENDENTES (' + pendentes.length + ')</div>' : '') +
      pendentes.map(f => '<div class="followup-item"><div class="fu-phone">' + formatarTelefone(f.telefone) + '</div><div class="fu-motivo">📌 ' + f.motivo + (f.veiculo_interesse ? ' — ' + f.veiculo_interesse : '') + '</div><div class="fu-data">⏰ ' + formatarData(f.agendado_para) + '</div></div>').join('') +
      (enviados.length > 0 ? '<div style="padding:8px;font-size:11px;color:#555;font-weight:600">ENVIADOS (' + enviados.length + ')</div>' : '') +
      enviados.slice(0,5).map(f => '<div class="followup-item" style="opacity:0.4"><div class="fu-phone">' + formatarTelefone(f.telefone) + ' ✓</div><div class="fu-motivo">' + f.motivo + '</div></div>').join('');
    document.getElementById('followupCount').textContent = pendentes.length + ' pendente(s)';
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
  try { res.json({ conversas: await listarConversas() }); }
  catch (e) { res.json({ conversas: [] }); }
});

app.get("/painel/mensagens/:from", async (req, res) => {
  try { res.json({ mensagens: await buscarMensagens(req.params.from) }); }
  catch (e) { res.json({ mensagens: [] }); }
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
  try { res.json({ aprendizados: await buscarAprendizados() }); }
  catch (e) { res.json({ aprendizados: [] }); }
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
