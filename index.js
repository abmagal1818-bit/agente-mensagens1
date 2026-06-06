const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

let estoqueAtual = [];
let ultimaAtualizacao = null;

async function atualizarEstoque() {
  try {
    const response = await axios.get(
      "https://www.mobiauto.com.br/api/v1/stores/31402/vehicles?size=100",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json"
        }
      }
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
      console.log(`Estoque atualizado: ${estoqueAtual.length} veículos em ${ultimaAtualizacao}`);
    }
  } catch (e) {
    console.error("Erro ao atualizar estoque:", e.message);
  }
}

atualizarEstoque();
setInterval(atualizarEstoque, 30 * 60 * 1000);

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque não disponível no momento.";
  return estoqueAtual.map(v =>
    `${v.marca} ${v.modelo} ${v.versao} ${v.ano} - ${v.km.toLocaleString("pt-BR")} km - R$ ${v.preco.toLocaleString("pt-BR")} - ${v.cor} - ${v.cambio} - ${v.combustivel}`
  ).join("\n");
}

const SYSTEM_PROMPT = () => `Você é Sara, vendedora da Premium Automarcas, uma revendedora de veículos usados em Porto Alegre/RS.

SOBRE A EMPRESA:
- Endereço: Av. Aparício Borges, 931 - Porto Alegre/RS
- Horário: Segunda a sexta 8h às 18h, sábados 8h às 12h
- WhatsApp consultor humano: (51) 99364-2476

SEU PERFIL:
- Simpática, descontraída e profissional
- Especialista em veículos usados e valores de mercado
- Conhece tabela FIPE e preços praticados no RS
- Respostas CURTAS e DIRETAS — máximo 5 linhas por resposta

ESTOQUE ATUAL (atualizado em ${ultimaAtualizacao || "carregando..."}):
${formatarEstoque()}

FORMAS DE PAGAMENTO:
- Financiamento: BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú
- Cartão de crédito, Consórcio, À vista

SIMULAÇÃO DE FINANCIAMENTO:
Quando cliente quiser simular, pergunte valor do veículo, entrada e prazo (24/36/48/60 meses).
Taxa média: 1,8% ao mês. Fórmula: PMT = PV × (i × (1+i)^n) / ((1+i)^n - 1)
Mostre parcela estimada e informe que é simulação aproximada.

REGRAS:
- Respostas curtas e diretas
- Use emojis com moderação 🚗
- Se quiser falar com humano: (51) 99364-2476
- Nunca invente informações
- Saudação: "Oi! 😊 Aqui é a Sara da Premium Automarcas! Como posso te ajudar?"`;

app.get("/", (req, res) => {
  res.send("Agente funcionando!");
});

app.get("/estoque", (req, res) => {
  res.json({
    total: estoqueAtual.length,
    ultimaAtualizacao,
    veiculos: estoqueAtual
  });
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
app.get("/estoque-teste", async (req, res) => {
  const urls = [
    "https://www.mobiauto.com.br/api/v1/stores/31402/vehicles?size=10",
    "https://www.mobiauto.com.br/api/v2/stores/31402/vehicles?size=10",
    "https://www.mobiauto.com.br/api/v1/dealer/31402/vehicles?size=10",
    "https://www.mobiauto.com.br/api/v1/vehicles?dealerId=31402&size=10",
  ];
  const resultados = {};
  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      resultados[url] = { status: r.status, dados: JSON.stringify(r.data).substring(0, 200) };
    } catch (e) {
      resultados[url] = { erro: e.message, status: e.response?.status };
    }
  }
  res.json(resultados);
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
