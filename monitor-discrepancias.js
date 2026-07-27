// -----------------------------------------------
// AGENTE DE MONITORAMENTO DE DISCREPANCIAS
// -----------------------------------------------
// Audita periodicamente as conversas ativas (nao fechadas/frias) em busca
// de erros de processo no atendimento da Sarah: tag de veiculo do lead
// inconsistente com o que o cliente escreveu na conversa, perguntas
// obrigatorias nao feitas antes de avancar (ex: cambio manual/automatico
// do carro de troca, se ja existe avaliacao de troca em andamento),
// perguntas repetidas, etc. Quando encontra algo, avisa o consultor no
// WhatsApp com um resumo -- mesmo padrao do alerta de falha de API.
//
// Uso (em index.js, perto dos outros setInterval de jobs periodicos):
//   require("./monitor-discrepancias")({ supabase, axios, CLAUDE_API_KEY, enviarTexto, NUMERO_AUGUSTO });

const INTERVALO_AUDITORIA = 3 * 60 * 60 * 1000; // a cada 3 horas
const MAX_LEADS_POR_RODADA = 25;
const MAX_MENSAGENS_POR_LEAD = 40;

function iniciarMonitorDiscrepancias({ supabase, axios, CLAUDE_API_KEY, enviarTexto, NUMERO_AUGUSTO }) {
  async function auditarConversa(lead) {
    try {
      const { data: msgs } = await supabase
        .from("mensagens")
        .select("tipo, texto, criado_em")
        .eq("telefone", lead.telefone)
        .order("criado_em", { ascending: true })
        .limit(MAX_MENSAGENS_POR_LEAD);

      if (!msgs || msgs.length === 0) return null;

      const historico = msgs
        .map(m => `${m.tipo === "recebida" ? "Cliente" : "Sarah"}: ${String(m.texto || "").slice(0, 500)}`)
        .join("\n")
        .slice(0, 6000);

      const prompt = `Voce e um auditor de qualidade de atendimento de uma revendedora de veiculos seminovos. Analise esta conversa entre um cliente e a assistente virtual "Sarah" e aponte SOMENTE problemas reais e objetivos de processo, entre eles:

1. A tag de veiculo deste lead no CRM e "${lead.veiculo_interesse || "(nenhuma)"}" -- verifique se ela realmente corresponde ao veiculo sobre o qual a conversa trata. Um erro comum: o cliente esta descrevendo o carro PROPRIO dele (pra dar de troca) e o sistema etiquetou como se fosse um carro do ESTOQUE da loja.
2. Se o cliente mencionou querer dar um carro na troca, Sarah perguntou o cambio (manual ou automatico) e se ja existe uma avaliacao de troca em andamento, ANTES de avancar para falar de condicao/preco/desconto?
3. Sarah repetiu uma pergunta que o cliente ja tinha respondido, ou ignorou uma pergunta direta do cliente?

Se nao encontrar nenhum problema real, responda exatamente: OK
Caso encontre, responda em no maximo 3 linhas, direto ao ponto, descrevendo o problema.

Conversa (mais recente por ultimo):
${historico}`;

      const resp = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-haiku-4-5",
            max_tokens: 300,
            messages: [{ role: "user", content: prompt }]
          },
          { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
        );

        const texto = ((resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text) || "").trim();
        if (!texto || texto.toUpperCase() === "OK") return null;
        return { telefone: lead.telefone, veiculo: lead.veiculo_interesse, achado: texto };
      } catch (e) {
        console.error(`[MonitorDiscrepancias] Erro ao auditar ${lead.telefone}:`, e.message);
        return null;
      }
    }

    async function rodarAuditoria() {
      try {
        const { data: leads, error } = await supabase
          .from("clientes")
          .select("telefone, estagio, veiculo_interesse")
          .not("estagio", "in", '("fechado","frio")')
          .order("ultima_interacao", { ascending: false })
          .limit(MAX_LEADS_POR_RODADA);

        if (error) { console.error("[MonitorDiscrepancias] Erro ao buscar leads:", error.message); return; }
        if (!leads || leads.length === 0) return;

        const achados = [];
        for (const lead of leads) {
          const resultado = await auditarConversa(lead);
          if (resultado) achados.push(resultado);
        }

        if (achados.length === 0) {
          console.log("[MonitorDiscrepancias] Rodada concluida, nenhuma discrepancia encontrada.");
          return;
        }

        const numero = (t) => {
          const d = t.replace(/\D/g, "");
          return d.length >= 12 ? `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}` : t;
        };

        const corpo = achados
          .map(a => `Lead ${numero(a.telefone)} - tag atual: "${a.veiculo || "nenhuma"}"\n${a.achado}`)
          .join("\n\n");

        const msg = `Monitor de discrepancias encontrou ${achados.length} possivel(is) problema(s) no atendimento:\n\n${corpo}`;
        await enviarTexto(NUMERO_AUGUSTO, msg.slice(0, 4000));
        console.log(`[MonitorDiscrepancias] ${achados.length} discrepancia(s) encontrada(s) e reportada(s).`);
      } catch (e) {
        console.error("[MonitorDiscrepancias] Erro geral:", e.message);
      }
    }

    setTimeout(rodarAuditoria, 5 * 60 * 1000);
    setInterval(rodarAuditoria, INTERVALO_AUDITORIA);

    console.log("[MonitorDiscrepancias] Monitor de discrepancias iniciado.");
  }

  module.exports = iniciarMonitorDiscrepancias;
  
