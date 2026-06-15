async function notificarAugusto(from, texto, primeiraVez = false) {
  const agora = Date.now();
  const ultima = ultimaNotificacao[from] || 0;
  const trintaMinutos = 30 * 60 * 1000;

  // Notifica imediatamente se for primeira mensagem, ou após 30 min
  if (!primeiraVez && agora - ultima < trintaMinutos) return;
  ultimaNotificacao[from] = agora;

  const numero = from.replace(/\D/g, "");
  const formatado = numero.length >= 12
    ? `+${numero.slice(0, 2)} (${numero.slice(2, 4)}) ${numero.slice(4, 9)}-${numero.slice(9)}`
    : from;

  const emoji = primeiraVez ? "🆕" : "📩";
  const titulo = primeiraVez ? "Novo cliente na Sarah" : "Mensagem na Sarah";
  const mensagem = `${emoji} *${titulo}*\nNúmero: ${formatado}\nMensagem: "${texto.substring(0, 100)}"\n\nAcesse o painel: https://agente-mensagens1.onrender.com/painel`;

  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: NUMERO_AUGUSTO, text: { body: mensagem } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[Notificação] ✅ ${primeiraVez ? "Novo cliente" : "Atualização"} — ${formatado}`);
  } catch (e) {
    console.error(`[Notificação] ❌ Erro:`, e.message);
  }
}
