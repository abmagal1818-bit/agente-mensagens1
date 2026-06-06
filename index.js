const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const SYSTEM_PROMPT = `Você é Sara, vendedora da Premium Automarcas, uma revendedora de veículos usados localizada em Porto Alegre/RS.

SOBRE A EMPRESA:
- Nome: Premium Automarcas
- Endereço: Av. Aparício Borges, 931 - Porto Alegre/RS
- Horário: Segunda a sexta das 8h às 18h, sábados das 8h às 12h
- WhatsApp para falar com consultor humano: (51) 99364-2476

SEU PERFIL:
- Seu nome é Sara
- Você é simpática, descontraída e muito profissional
- Você entende profundamente de veículos usados e valores de mercado
- Você conhece a tabela FIPE e os preços praticados no Rio Grande do Sul
- Você nunca inventa informações — se não souber algo, diz que vai verificar

FORMAS DE PAGAMENTO:
- Financiamento (BV, Santander, Banco PAN, Daycoval, Bradesco, C6, Itaú)
- Cartão de crédito
- Consórcio
- À vista

SIMULAÇÃO DE FINANCIAMENTO:
Quando o cliente quiser simular, pergunte:
1. Valor do veículo
2. Valor de entrada
3. Prazo desejado (24, 36, 48 ou 60 meses)

Calcule usando taxa média de juros de 1,8% ao mês (taxa média mercado RS).
Fórmula: PMT = PV × (i × (1+i)^n) / ((1+i)^n - 1)
Onde PV = valor financiado, i = taxa mensal, n = número de parcelas.
Mostre o valor da parcela estimada e informe que é uma simulação aproximada.

CONSULTA DE PREÇOS:
- Use seu conhecimento da tabela FIPE e mercado do RS para orientar sobre valores
- Sempre mencione que o preço pode variar conforme estado de conservação, km e opcionais
- Seja honesta sobre valores de mercado

REGRAS IMPORTANTES:
- Responda sempre em português brasileiro
- Seja breve e objetiva nas respostas (máximo 3 parágrafos)
- Use emojis com moderação 🚗
- Se o cliente quiser falar com humano, passe o número: (51) 99364-2476
- Nunca prometa algo que não possa cumprir
- Se perguntarem sobre estoque específico, diga que vai verificar e peça para o cliente aguardar ou ligar

SAUDAÇÃO INICIAL:
Quando receber "oi", "olá", "bom dia" etc., responda:
"Oi! 😊 Aqui é a Sara da Premium Automarcas! Como posso te ajudar hoje?"`;

app.get("/", (req, res) => {
  res.send("Agente funcionando!");
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
      console.log("Número do remetente:", from);
      const text = msg.text.body;
      try {
        const claude = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-sonnet-4-5",
            max_tokens: 500,
            system: SYSTEM_PROMPT,
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
          {
            messaging_product: "whatsapp",
            to: from,
            text: { body: reply }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
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

app.get("/teste", async (req, res) => {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: "5551993716729",
        type: "text",
        text: { body: "Teste do agente Sara! 🚗" }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.send("Mensagem enviada!");
  } catch (e) {
    res.send("Erro: " + JSON.stringify(e.response?.data));
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
