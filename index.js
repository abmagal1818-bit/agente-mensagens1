const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Agente funcionando!");
});

const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
console.log("TOKEN PRIMEIROS 20:", WHATSAPP_TOKEN ? WHATSAPP_TOKEN.substring(0,20) : "AUSENTE");
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {console.log("WEBHOOK RECEBIDO:", JSON.stringify(body));
  const body = req.body;
  if (body.object === "whatsapp_business_account") {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && msg.type === "text") {
      const from = msg.from;
      console.log("Número do remetente:", from);
      const text = msg.text.body;
      try {
        const claude = await axios.post(
          "https://api.anthropic.com/v1/messages",
          { model: "claude-sonnet-4-5", max_tokens: 500,
            messages: [{ role: "user", content: text }] },
          { headers: { "x-api-key": CLAUDE_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json" } }
        );
        const reply = claude.data.content[0].text;
        await axios.post(
          `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from,
            text: { body: reply } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json" } }
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
        text: { body: "Teste do agente Claude! 🤖" }
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
