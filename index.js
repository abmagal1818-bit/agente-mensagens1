const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log("Requisição recebida:", req.method, req.url);
  next();
});
app.get("/", (req, res) => {
  res.send("Agente funcionando!");
});
const VERIFY_TOKEN = "meu_token_verificacao";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});
app.post("/webhook", async (req, res) => {
  const body = req.body;console.log("Body recebido:", JSON.stringify(body));
  if (body.object === "whatsapp_business_account") {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && msg.type === "text") {
      const from = msg.from;
      const text = msg.text.body;
      try {
        console.log("Chamando Claude com texto:", text);
        const claude = await axios.post(
          "https://api.anthropic.com/v1/messages",
          { model: "claude-sonnet-4-20250514", max_tokens: 500,
            messages: [{ role: "user", content: text }] },
          { headers: { "x-api-key": CLAUDE_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json" } }
        );
        const reply = claude.data.content[0].text;
       console.log("Enviando para:", from, "via ID:", PHONE_NUMBER_ID);console.log("Token:", WHATSAPP_TOKEN ? "presente" : "ausente"); await axios.post(
          ``https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: "whatsapp", to: from,
            text: { body: reply } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json" } }
        );
      } catch (e) { console.error(e.message); }
    }
  }
  res.sendStatus(200);
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor na porta " + PORT));
