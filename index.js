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
let cacheMarcasFipe = null;

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
    console.log(`Veículo para troca: marca=${json.marca} modelo=${json.modelo} ano=${json.ano}`);
    return json;
  } catch (e) {
    console.error("Erro ao extrair veículo:", e.message);
    return { marca: null, modelo: null, ano: null };
  }
}

async function consultarFipe(marca, modelo, ano) {
  if (!marca || !modelo || !ano) return null;

  const chave = `${marca}-${modelo}-${ano}`.toLowerCase();
  if (fipeCache[chave]) {
    console.log(`FIPE do cache: ${fipeCache[chave].Valor}`);
    return fipeCache[chave];
  }

  try {
    const marcas = await getMarcasFipe();

    const marcaFipe = marcas.find(m =>
      m.nome.toLowerCase().includes(marca.toLowerCase()) ||
      marca.toLowerCase().includes(m.nome.toLowerCase().split(" ")[0])
    );

    if (!marcaFipe) {
      console.log(`Marca não encontrada na FIPE: ${marca}`);
      return null;
    }
    console.log(`Marca FIPE: ${marcaFipe.nome} (${marcaFipe.codigo})`);

    const modelosRes = await axios.get(
      `https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos`
    );

    const primeirapalavra = modelo.toLowerCase().split(" ")[0];
    const modelosCandidatos = modelosRes.data.modelos.filter(m =>
      m.nome.toLowerCase().includes(primeirapalavra)
    );

    if (modelosCandidatos.length === 0) {
      console.log(`Modelo não encontrado: ${modelo}`);
      return null;
    }

    for (const candidato of modelosCandidatos) {
      const anosRes = await axios.get(
        `https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${candidato.codigo}/anos`
      );

      const anoFipe = anosRes.data.find(a =>
        a.nome.includes(ano.toString()) && !a.nome.includes("32000")
      );

      if (anoFipe) {
        console.log(`Modelo: ${candidato.nome} | Ano: ${anoFipe.nome}`);
        const valorRes = await axios.get(
          `https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFipe.codigo}/modelos/${candidato.codigo}/anos/${anoFipe.codigo}`
        );
        fipeCache[chave] = valorRes.data;
        console.log(`✅ FIPE: ${valorRes.data.Modelo} = ${valorRes.data.Valor}`);
        return valorRes.data;
      }
    }

    console.log(`Ano ${ano} não encontrado para ${marca} ${modelo}`);
    return null;
  } catch (e) {
    console.error("Erro FIPE:", e.message);
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
${fipeInfo ? (() => {
  const v = calcularValoresTroca(fipeInfo.Valor);
  return `✅ FIPE CONSULTADA (${fipeInfo.MesReferencia}):
Veículo: ${fipeInfo.Modelo} ${fipeInfo.AnoModelo} = ${fipeInfo.Valor}
Faixa de avaliação na troca: R$ ${v.minimoFormatado} a R$ ${v.maximoFormatado}
(varia conforme estado de conservação, revisões e documentação)

REGRAS DE APRESENTAÇÃO:
- Apresente DIRETAMENTE a faixa de valor: "Conseguimos trabalhar entre R$ ${v.minimoFormatado} e R$ ${v.maximoFormatado} na troca"
- NÃO mencione percentuais, FIPE ou desconto
- Diga que a avaliação final é presencial
- Se o carro estiver em ótimo estado → valor mais próximo de R$ ${v.maximoFormatado}
- Se tiver alta quilometragem ou problemas → valor mais próximo de R$ ${v.minimoFormatado}`;
})() :
    `⚠️ FIPE ainda não consultada.
PROIBIDO inventar ou estimar valores.
Se cliente mencionar veículo para troca sem ter os dados completos, pergunte marca, modelo e ano.
Se não conseguir consultar, diga: "Não consegui consultar agora. Ligue (51) 99364-2476 ou venha à loja!"`
  }

SIMULAÇÃO DE FINANCIAMENTO:
Pergunte valor, entrada e prazo. Taxa 1,8%/mês.
Fórmula: PMT = PV × (i×(1+i)^n)/((1+i)^n-1)
Apresente o valor da parcela diretamente, sem mencionar a fórmula.

REGRAS:
- Primeira mensagem: "Oi! 😊 Aqui é a Sarah da Premium Automarcas!"
- Demais mensagens: direto ao assunto
- Máximo 4 linhas
- Emojis com moderação 🚗
- Humano: (51) 99364-2476
- NUNCA invente links, URLs ou endereços de site
- Quando pedirem fotos, diga: "Para ver as fotos, entre em contato com nosso consultor pelo (51) 99364-2476 ou venha visitar na Av. Aparício Borges, 931!"
- NUNCA invente informações sobre estoque que não estejam na lista acima

async function processarMensagem(from, text) {
  if (!conversas[from]) conversas[from] = [];
  conversas[from].push({ role: "user", content: text });
  if (conversas[from].length > 20) conversas[from] = conversas[from].slice(-20);

  const todosTextos = conversas[from]
    .filter(m => m.role === "user")
    .map(m => m.content);

  const { marca, modelo, ano } = await extrairVeiculoParaTroca(todosTextos);
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
app.get("/estoque", (req, res) => res.json({
  total: estoqueAtual.length,
  ultimaAtualizacao,
  veiculos: estoqueAtual
}));

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
        console.log(`Áudio de ${from} — transcrevendo...`);
        const texto = await transcreverAudio(msg.audio.id);
        if (texto) {
          console.log(`Transcrição: ${texto}`);
          await processarMensagem(from, `[Áudio]: ${texto}`);
        } else {
          await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: from,
              text: { body: "Não consegui entender o áudio. Pode digitar?" }
            },
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
