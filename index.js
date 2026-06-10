const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

let estoqueAtual = [];
let ultimaAtualizacao = null;
const conversas = {};
const mensagensProcessadas = new Set();
const fipeCache = {};

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque sendo carregado.";
  return estoqueAtual.map(v =>
    `${v.marca} ${v.modelo} ${v.versao} ${v.ano} - ${v.km.toLocaleString("pt-BR")} km - R$ ${v.preco.toLocaleString("pt-BR")} - ${v.cor} - ${v.cambio}`
  ).join("\n");
}

async function extrairInfoVeiculoComClaude(textos) {
  try {
    const texto = textos.join(" ");
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: [{
          role: "user",
          content: `Do texto abaixo, extraia as informações do veículo que o cliente quer vender ou dar na troca.
Responda APENAS em JSON no formato: {"marca": "...", "modelo": "...", "ano": "..."}
Se não encontrar algum campo, coloque null.
Exemplos de resposta:
- {"marca": "hyundai", "modelo": "santa fe", "ano": "2012"}
- {"marca": "toyota", "modelo": "yaris", "ano": "2019"}
- {"marca": null, "modelo": null, "ano": null}

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
    const json = JSON.parse(resposta);
    console.log(`Extraído pelo Claude: marca=${json.marca} modelo=${json.modelo} ano=${json.ano}`);
    return json;
  } catch (e) {
    console.error("Erro ao extrair info veículo:", e.message);
    return { marca: null, modelo: null, ano: null };
  }
}

async function encontrarCodigoFipe(marcaCodigo, nomeModelo, ano) {
  try {
    const modelosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaCodigo}/modelos`);
    const todosModelos = modelosRes.data.modelos;
    const listaModelos = todosModelos.map(m => `${m.codigo}: ${m.nome}`).join("\n");

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 50,
        messages: [{
          role: "user",
          content: `Da lista abaixo, qual é o código do modelo mais parecido com "${nomeModelo} ${ano}"?
Responda APENAS com o número do código, sem mais nada.

${listaModelos}`
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

    const codigoModelo = claudeRes.data.content[0].text.trim().replace(/\D/g, "");
    console.log(`Claude selecionou código modelo: ${codigoModelo}`);

    const anosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaCodigo}/modelos/${codigoModelo}/anos`);
    let anoEncontrado = anosRes.data.find(a => a.nome.includes(ano.toString()));

    if (!anoEncontrado) {
      const anosValidos = anosRes.data.filter(a => !a.nome.includes("32000"));
      anoEncontrado = anosValidos[0];
      console.log(`Ano ${ano} não encontrado, usando: ${anoEncontrado?.nome}`);
    }

    if (!anoEncontrado) return null;

    const valorRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaCodigo}/modelos/${codigoModelo}/anos/${anoEncontrado.codigo}`);
    return valorRes.data;
  } catch (e) {
    console.error("Erro encontrarCodigoFipe:", e.message);
    return null;
  }
}

async function consultarFipe(marca, modelo, ano) {
  const chave = `${marca}-${modelo}-${ano}`.toLowerCase();
  if (fipeCache[chave]) {
    console.log(`FIPE do cache: ${fipeCache[chave].Valor}`);
    return fipeCache[chave];
  }

  try {
    const marcasRes = await axios.get("https://parallelum.com.br/fipe/api/v1/carros/marcas");

    // Claude escolhe a marca correta na lista da FIPE
    const listaMarcas = marcasRes.data.map(m => `${m.codigo}: ${m.nome}`).join("\n");
    const claudeMarcaRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 20,
        messages: [{
          role: "user",
          content: `Da lista abaixo, qual é o código da marca "${marca}"?
Responda APENAS com o número do código, sem mais nada.

${listaMarcas}`
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

    const codigoMarca = claudeMarcaRes.data.content[0].text.trim().replace(/\D/g, "");
    console.log(`Claude selecionou código marca: ${codigoMarca}`);

    const resultado = await encontrarCodigoFipe(codigoMarca, modelo, ano);
    if (resultado) {
      fipeCache[chave] = resultado;
      console.log(`✅ FIPE encontrada: ${resultado.Modelo} = ${resultado.Valor}`);
    }
    return resultado;
  } catch (e) {
    console.error("Erro FIPE:", e.message);
    return null;
  }
}

function calcularValorTroca(valorFipeStr) {
  const valor = parseFloat(valorFipeStr.replace("R$ ", "").replace(/\./g, "").replace(",", "."));
  const troca = Math.round(valor * 0.8);
  return { fipeFormatado: valor.toLocaleString("pt-BR"), trocaFormatado: troca.toLocaleString("pt-BR") };
}

async function transcreverAudio(mediaId) {
  try {
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const audioUrl = mediaRes.data.url;

    const audioRes = await axios.get(audioUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer"
    });

    const formData = new FormData();
    formData.append("file", Buffer.from(audioRes.data), {
      filename: "audio.ogg",
      contentType: "audio/ogg"
    });
    formData.append("model", "whisper-large-v3");
    formData.append("language", "pt");

    const transcricaoRes = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      formData,
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          ...formData.getHeaders()
        }
      }
    );
    return transcricaoRes.data.text;
  } catch (e) {
    console.error("Erro transcrição:", e.message);
    return null;
  }
}

const SYSTEM_PROMPT = (fipeInfo) => `Você é Sara, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

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

PAGAMENTO: Financiamento (BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú), Cartão, Consórcio, À vista

AVALIAÇÃO DE TROCA:
${fipeInfo ?
    `✅ FIPE OFICIAL CONSULTADA (${fipeInfo.MesReferencia}):
Modelo: ${fipeInfo.Modelo} ${fipeInfo.AnoModelo}
FIPE: ${fipeInfo.Valor}
Valor de troca (20% abaixo da FIPE): R$ ${calcularValorTroca(fipeInfo.Valor).trocaFormatado}
⚠️ USE EXATAMENTE ESSES VALORES. PROIBIDO usar outros valores.` :
    `⚠️ NUNCA invente valores de FIPE.
Se não tiver FIPE consultada, diga APENAS:
"Me informa a marca, modelo e ano do seu veículo para eu consultar a FIPE!"`
  }
Desconto de 20% é padrão de mercado RS. Avaliação final sempre presencial.

SIMULAÇÃO DE FINANCIAMENTO:
Pergunte valor, entrada e prazo. Taxa 1,8%/mês.
Fórmula: PMT = PV × (i×(1+i)^n)/((1+i)^n-1)

REGRAS:
- Primeira mensagem: "Oi! 😊 Aqui é a Sara da Premium Automarcas!"
- Demais mensagens: direto ao assunto
- Máximo 4 linhas
- Emojis com moderação 🚗
- Humano: (51) 99364-2476`;

async function processarMensagem(from, text) {
  if (!conversas[from]) conversas[from] = [];
  conversas[from].push({ role: "user", content: text });
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  const todosTextos = conversas[from].filter(m => m.role === "user").map(m => m.content);
  
  // Claude extrai marca/modelo/ano de qualquer texto
  const { marca, modelo, ano } = await extrairInfoVeiculoComClaude(todosTextos);
  let fipeInfo = null;

  if (marca && modelo && ano) {
    fipeInfo = await consultarFipe(marca, modelo, ano);
  }

  const claude = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT(fipeInfo),
      messages: conversas[from]
    },
    {
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    }
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
app.get("/estoque", (req, res) => res.json({ total: estoqueAtual.length, ultimaAtualizacao, veiculos: estoqueAtual }));

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
        const text = msg.text.body;
        console.log(`Texto de ${from}: ${text}`);
        await processarMensagem(from, text);
      } else if (msg.type === "audio") {
        console.log(`Áudio de ${from} — transcrevendo...`);
        const texto = await transcreverAudio(msg.audio.id);
        if (texto) {
          console.log(`Transcrição: ${texto}`);
          await processarMensagem(from, `[Áudio transcrito]: ${texto}`);
        } else {
          await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: "whatsapp", to: from, text: { body: "Oi! 😊 Não consegui entender o áudio. Pode digitar sua mensagem?" } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
          );
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
    const result = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/register`,
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
    const result = await axios.post(
      `https://graph.facebook.com/v18.0/2609687206092266/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    res.send("Assinado! " + JSON.stringify(result.data));
  } catch (e) {
    res.send("Erro: " + JSON.stringify(e.response?.data));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
