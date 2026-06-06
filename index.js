const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MOBIAUTO_EMAIL = process.env.MOBIAUTO_EMAIL;
const MOBIAUTO_SENHA = process.env.MOBIAUTO_SENHA;

let estoqueAtual = [];
let ultimaAtualizacao = null;
let mobigestor_token = null;

async function loginMobigestor() {
  const urls = [
    "https://api.mobigestor.com.br/api/v1/auth/login",
    "https://api.mobigestor.com.br/auth/login",
    "https://mobigestor.com.br/api/auth/login",
    "https://api.mobigestor.com.br/v1/login",
  ];
  for (const url of urls) {
    try {
      const r = await axios.post(url,
        { email: MOBIAUTO_EMAIL, password: MOBIAUTO_SENHA },
        { headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      mobigestor_token = r.data.token || r.data.access_token;
      console.log("Login MobiGestor OK! URL:", url);
      return true;
    } catch (e) {
      console.log("Falhou:", url, e.response?.status);
    }
  }
  return false;
}

async function atualizarEstoque() {
  try {
    if (!mobigestor_token) await loginMobigestor();
    const response = await axios.get(
      "https://api.mobigestor.com.br/api/v1/vehicles?size=100",
      { headers: { Authorization: `Bearer ${mobigestor_token}`, "User-Agent": "Mozilla/5.0" } }
    );
    if (response.data && response.data.content) {
      estoqueAtual = response.data.content.map(v => ({
        marca: v.brand?.name || "",
        modelo: v.model?.name || "",
        versao: v.version?.name || "",
        ano: v.modelYear || "",
        km: v.mileage || 0,
        preco: v.price || 0,
        cor: v.color?.name || "",
        cambio: v.transmission?.name || "",
        combustivel: v.fuel?.name || ""
      }));
      ultimaAtualizacao = new Date().toLocaleString("pt-BR");
      console.log(`Estoque: ${estoqueAtual.length} veículos em ${ultimaAtualizacao}`);
    }
  } catch (e) {
    console.error("Erro estoque:", e.message);
    mobigestor_token = null;
  }
}

atualizarEstoque();
setInterval(atualizarEstoque, 30 * 60 * 1000);

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque sendo carregado, aguarde.";
  return estoqueAtual.map(v =>
    `${v.marca} ${v.modelo} ${v.versao} ${v.ano} - ${v.km.toLocaleString("pt-BR")} km - R$ ${v.preco.toLocaleString("pt-BR")} - ${v.cor} - ${v.cambio}`
  ).join("\n");
}

const SYSTEM_PROMPT = () => `Você é Sara, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

EMPRESA:
- Endereço: Av. Aparício Borges, 931 - Porto Alegre/RS
- Horário: Seg-Sex 8h-18h, Sáb 8h-12h
- Consultor humano: (51) 99364-2476

PERFIL:
- Simpática, descontraída e profissional
- Especialista em veículos usados e tabela FIPE
- Respostas CURTAS e DIRETAS — máximo 5 linhas

ESTOQUE ATUAL (${ultimaAtualizacao || "carregando..."}):
${formatarEstoque()}

PAGAMENTO: Financiamento (BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú), Cartão, Consórcio, À vista

SIMULAÇÃO: Pergunte valor, entrada e prazo. Taxa 1,8%/mês. PMT = PV × (i×(1+i)^n)/((1+i)^n-1)

REGRAS:
- Respostas curtas e diretas
- Emojis com moderação 🚗
- Humano: (51) 99364-2476
- Nunca invente informações
- Saudação: "Oi! 😊 Aqui é a Sara da Premium Automarcas! Como posso te ajudar?"`;

app.get("/", (req, res) => res.send("Agente funcionando!"));

app.get("/estoque", (req, res) => {
  res.json({ total: estoqueAtual.length, ultimaAtualizacao, veiculos: estoqueAtual });
});

app.get("/login-mobigestor", async (req, res) => {
  const urls = [
    "https://api.mobigestor.com.br/api/v1/auth/login",
    "https://api.mobigestor.com.br/auth/login",
    "https://mobigestor.com.br/api/auth/login",
    "https://api.mobigestor.com.br/v1/login",
  ];
  const resultados = {};
  for (const url of urls) {
    try {
      const r = await axios.post(url,
        { email: MOBIAUTO_EMAIL, password: MOBIAUTO_SENHA },
        { headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      resultados[url] = { status: r.status, dados: JSON.stringify(r.data).substring(0, 300) };
    } catch (e) {
      resultados[url] = { erro: e.message, status: e.response?.status };
    }
  }
  res.json(resultados);
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
  console.log("WEBHOOK RECEBIDO:", JSON.stringify(body));
  if (body.object === "whatsapp_business_account") {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && msg.type === "text") {
      const from = msg.from;
      const text = msg.text.body;
      try {
        const claude = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-sonnet-4-5",
            max_tokens: 500,
            system: SYSTEM_PROMPT(),
            messages: [{ role: "user", content: text }]
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
        await axios.post(
          `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from, text: { body: reply } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log("Resposta enviada para:", from);
      } catch (e) {
        console.error("Erro:", e.message);
        if (e.response) console.error("Detalhe:", JSON.stringify(e.response.data));
      }
    }
  }
  res.sendStatus(200);
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
