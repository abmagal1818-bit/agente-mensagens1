function gerarPngGrupo(grupo) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const MARGEM_X = Math.round(VIDEO_WIDTH * 0.08); // ~8% da largura

  grupo.textos.forEach((overlay) => {
    const fontSize = overlay.fontSize || 40;
    ctx.font = `bold ${fontSize}px Poppins`;

    let yPos;
    if (typeof overlay.y === 'string' && overlay.y.trim().endsWith('%')) {
      yPos = VIDEO_HEIGHT * (parseFloat(overlay.y) / 100);
    } else {
      yPos = Number(overlay.y) || VIDEO_HEIGHT / 2;
    }

    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.05));
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(overlay.text, MARGEM_X, yPos);
    ctx.fillStyle = overlay.color || '#E63946';
    ctx.fillText(overlay.text, MARGEM_X, yPos);
  });

  return canvas.toBuffer('image/png');
}function gerarPngGrupo(grupo) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const MARGEM_X = Math.round(VIDEO_WIDTH * 0.08); // ~8% da largura

  grupo.textos.forEach((overlay) => {
    const fontSize = overlay.fontSize || 40;
    ctx.font = `bold ${fontSize}px Poppins`;

    let yPos;
    if (typeof overlay.y === 'string' && overlay.y.trim().endsWith('%')) {
      yPos = VIDEO_HEIGHT * (parseFloat(overlay.y) / 100);
    } else {
      yPos = Number(overlay.y) || VIDEO_HEIGHT / 2;
    }

    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.05));
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(overlay.text, MARGEM_X, yPos);
    ctx.fillStyle = overlay.color || '#E63946';
    ctx.fillText(overlay.text, MARGEM_X, yPos);
  });

  return canvas.toBuffer('image/png');
}
