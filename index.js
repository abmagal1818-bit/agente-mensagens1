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
const conversas = {};
const mensagensProcessadas = new Set();

function formatarEstoque() {
  if (estoqueAtual.length === 0) return "Estoque sendo carregado.";
  return estoqueAtual.map(v =>
    `${v.marca} ${v.modelo} ${v.versao} ${v.ano} - ${v.km.toLocaleString("pt-BR")} km - R$ ${v.preco.toLocaleString("pt-BR")} - ${v.cor} - ${v.cambio}`
  ).join("\n");
}

async function consultarFipe(marca, modelo, ano) {
  try {
    const marcasRes = await axios.get("https://parallelum.com.br/fipe/api/v1/carros/marcas");
    const marcaEncontrada = marcasRes.data.find(m =>
      m.nome.toLowerCase().includes(marca.toLowerCase())
    );
    if (!marcaEncontrada) return null;

    const modelosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaEncontrada.codigo}/modelos`);
    const modeloEncontrado = modelosRes.data.modelos.find(m =>
      m.nome.toLowerCase().includes(modelo.toLowerCase())
    );
    if (!modeloEncontrado) return null;

    const anosRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaEncontrada.codigo}/modelos/${modeloEncontrado.codigo}/anos`);
    const anoEncontrado = anosRes.data.find(a => a.nome.includes(ano.toString()));
    if (!anoEncontrado) return null;

    const valorRes = await axios.get(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaEncontrada.codigo}/modelos/${modeloEncontrado.codigo}/anos/${anoEncontrado.codigo}`);
    return valorRes.data;
  } catch (e) {
    console.error("Erro FIPE:", e.message);
    return null;
  }
}

function calcularValorTroca(valorFipeStr) {
  const valor = parseFloat(valorFipeStr.replace("R$ ", "").replace(/\./g, "").replace(",", "."));
  const troca = Math.round(valor * 0.8);
  return { fipe: valor, troca, trocaFormatado: troca.toLocaleString("pt-BR"), fipeFormatado: valor.toLocaleString("pt-BR") };
}

const SYSTEM_PROMPT = (fipeInfo) => `Você é Sara, vendedora da Premium Automarcas, revendedora de veículos usados em Porto Alegre/RS.

EMPRESA:
- Endereço: Av. Aparício Borges, 931 - Porto Alegre/RS
- Horário: Seg-Sex 8h-18h, Sáb 8h-12h
- Consultor humano: (51) 99364-2476

PERFIL:
- Simpática, descontraída e profissional
- Especialista em veículos usados e tabela FIPE
- Respostas CURTAS e DIRETAS — máximo 4 linhas
- NUNCA repita a saudação depois da primeira mensagem
- SEMPRE mantenha o contexto da conversa anterior

ESTOQUE ATUAL (${ultimaAtualizacao || "carregando..."}):
${formatarEstoque()}

PAGAMENTO: Financiamento (BV, Santander, PAN, Daycoval, Bradesco, C6, Itaú), Cartão, Consórcio, À vista

AVALIAÇÃO DE TROCA:
${fipeInfo ?
  `FIPE OFICIAL CONSULTADA AGORA: ${fipeInfo.Modelo} ${fipeInfo.AnoModelo} = ${fipeInfo.Valor} (${fipeInfo.MesReferencia}).
  Valor de troca = 20% abaixo da FIPE = R$ ${calcularValorTroca(fipeInfo.Valor).trocaFormatado}.
  USE EXATAMENTE ESSES VALORES. Não use outros valores.` :
  `Quando cliente mencionar marca+ano do veículo para troca, informe que está consultando a FIPE.
  IMPORTANTE: Nunca invente valores de FIPE. Sempre diga que vai consultar.`}
Desconto de 20% é padrão de mercado RS. Avaliação final é presencial.

SIMULAÇÃO DE FINANCIAMENTO:
Pergunte valor, entrada e prazo. Taxa 1,8%/mês.
Fórmula: PMT = PV × (i×(1+i)^n)/((1+i)^n-1)

REGRAS:
- Primeira mensagem: cumprimente com "Oi! 😊 Aqui é a Sara da Premium Automarcas!"
- Demais mensagens: vá direto ao assunto, sem repetir saudação
- Máximo 4 linhas por resposta
- Emojis com moderação 🚗
- Se quiser falar com humano: (51) 99364-2476
- Nunca invente valores de FIPE`;

app.get("/", (req, res) => res.send("Agente funcionando!"));

app.get("/estoque", (req, res) => {
  res.json({ total: estoqueAtual.length, ultimaAtualizacao, veiculos: estoqueAtual });
});

app.get("/fipe-teste", async (req, res) => {
  const resultado = await consultarFipe("jeep", "renegade", 2016);
  res.json(resultado || { erro: "Não encontrado" });
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
  if (body.object === "whatsapp_business_account") {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && msg.type === "text") {

      // Evita processar a mesma mensagem duas vezes
      const msgId = msg.id;
      if (mensagensProcessadas.has(msgId)) {
        console.log("Mensagem duplicada ignorada:", msgId);
        return res.sendStatus(200);
      }
      mensagensProcessadas.add(msgId);
      setTimeout(() => mensagensProcessadas.delete(msgId), 60000);

      const from = msg.from;
      const text = msg.text.body;
      console.log(`Mensagem de ${from}: ${text}`);

      if (!conversas[from]) conversas[from] = [];
      conversas[from].push({ role: "user", content: text });

      if (conversas[from].length > 20) {
        conversas[from] = conversas[from].slice(-20);
      }

      // Consulta FIPE quando detecta marca + ano
      let fipeInfo = null;
      const textLower = text.toLowerCase();
      const marcasComuns = ["jeep", "volkswagen", "vw", "honda", "toyota", "chevrolet", "ford", "hyundai", "fiat", "renault", "nissan", "mitsubishi", "kia", "bmw", "mercedes", "audi", "peugeot", "citroen"];
      const marcaDetectada = marcasComuns.find(m => textLower.includes(m));
      const anoMatch = text.match(/\b(19|20)\d{2}\b/);

      if (marcaDetectada && anoMatch) {
        console.log(`Consultando FIPE: ${marcaDetectada} ${anoMatch[0]}`);
        fipeInfo = await consultarFipe(marcaDetectada, text, anoMatch[0]);
        if (fipeInfo) console.log("FIPE encontrada:", fipeInfo.Valor);
      }

      try {
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
        console.log(`Resposta enviada para ${from}: ${reply}`);
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
