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
- Conhece tabela FIPE e preços pratic
