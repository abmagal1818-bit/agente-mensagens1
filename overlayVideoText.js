/**
 * overlayVideoText.js (v2 — usa canvas + overlay, não drawtext)
 * ---------------------------------------------------------
 * O binário do pacote ffmpeg-static não inclui suporte ao filtro
 * "drawtext" (depende de libfreetype, que fica de fora desses builds
 * por licença). Por isso, em vez de desenhar o texto direto no ffmpeg,
 * geramos cada texto como uma imagem PNG transparente (usando a
 * biblioteca "canvas", com controle total de fonte/cor/tamanho) e
 * usamos o filtro "overlay" do ffmpeg (básico, sempre disponível) para
 * colar essas imagens por cima do vídeo, no tempo certo.
 *
 * Requisitos (rodar no projeto do Sarah, no Render):
 *   npm install fluent-ffmpeg ffmpeg-static node-fetch @supabase/supabase-js canvas
 *
 * Precisa do arquivo de fonte já enviado ao repositório:
 *   Poppins-Bold.ttf (na raiz do projeto)
 * ---------------------------------------------------------
 */

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvas, registerFont } = require('canvas');
const { createClient } = require('@supabase/supabase-js');

ffmpeg.setFfmpegPath(ffmpegPath);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const FONT_PATH = path.join(__dirname, 'Poppins-Bold.ttf');
registerFont(FONT_PATH, { family: 'Poppins' });

// Dimensões padrão do vídeo (formato "instagram-story" usado no JSON2Video)
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;

async function downloadToTemp(url, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: ${res.status}`);
  const tempPath = path.join(os.tmpdir(), `overlay-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  const buffer = await res.buffer();
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

/**
 * Gera um PNG transparente do tamanho do vídeo, com o texto desenhado
 * na posição vertical indicada (centralizado horizontalmente).
 *
 * overlay: { text, color, fontSize, y }
 *   y pode ser "78%" (porcentagem da altura) ou um número em pixels.
 */
function gerarPngTexto(overlay) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  const fontSize = overlay.fontSize || 40;
  ctx.font = `bold ${fontSize}px Poppins`;
  ctx.fillStyle = overlay.color || '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let yPos;
  if (typeof overlay.y === 'string' && overlay.y.trim().endsWith('%')) {
    yPos = VIDEO_HEIGHT * (parseFloat(overlay.y) / 100);
  } else {
    yPos = Number(overlay.y) || VIDEO_HEIGHT / 2;
  }

  // Contorno preto leve, ajuda a legibilidade sobre fotos claras
  ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.06));
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeText(overlay.text, VIDEO_WIDTH / 2, yPos);
  ctx.fillText(overlay.text, VIDEO_WIDTH / 2, yPos);

  return canvas.toBuffer('image/png');
}

/**
 * Função principal: baixa o vídeo simples, gera um PNG por texto,
 * compõe tudo com ffmpeg (overlay, não drawtext), sobe o resultado
 * final no Supabase Storage, e retorna a URL pública.
 *
 * @param {string} videoUrl - URL do vídeo pronto (sem texto) vindo do JSON2Video
 * @param {Array}  overlays - lista de textos: { text, color, fontSize, y, start, end }
 * @param {string} outputFileName - nome do arquivo final, ex: "onix-2021-1234.mp4"
 * @returns {Promise<string>} URL pública do vídeo final no Supabase
 */
async function applyTextOverlay(videoUrl, overlays, outputFileName) {
  const inputPath = await downloadToTemp(videoUrl, '.mp4');
  const outputPath = path.join(os.tmpdir(), outputFileName);

  // Gera um arquivo PNG temporário para cada texto
  const pngPaths = overlays.map((overlay) => {
    const buffer = gerarPngTexto(overlay);
    const pngPath = path.join(os.tmpdir(), `text-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(pngPath, buffer);
    return pngPath;
  });

  // Monta a cadeia de filtros overlay, um por cima do outro, cada um
  // aparecendo só na janela de tempo [start, end] definida no overlay.
  let filterChain = '';
  let lastLabel = '0:v';
  overlays.forEach((overlay, i) => {
    const inputIndex = i + 1; // input 0 é o vídeo, 1+ são os PNGs
    const outLabel = i === overlays.length - 1 ? 'vout' : `v${i}`;
    const enableExpr = `between(t\\,${overlay.start}\\,${overlay.end})`;
    filterChain += `[${lastLabel}][${inputIndex}:v]overlay=enable='${enableExpr}'[${outLabel}];`;
    lastLabel = outLabel;
  });
  filterChain = filterChain.replace(/;$/, '');

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    pngPaths.forEach((p) => cmd.input(p));
    cmd
      .complexFilter(filterChain, 'vout')
      .outputOptions(['-map', '0:a?', '-c:a', 'copy'])
      .on('start', (c) => console.log('[ffmpeg] comando:', c))
      .on('stderr', (line) => console.log('[ffmpeg]', line))
      .on('error', (err) => reject(err))
      .on('end', () => resolve())
      .save(outputPath);
  });

  const fileBuffer = fs.readFileSync(outputPath);

  const { error: uploadError } = await supabase.storage
    .from('veiculos')
    .upload(`Reels/${outputFileName}`, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true,
    });

  // limpeza dos arquivos temporários
  fs.unlinkSync(inputPath);
  fs.unlinkSync(outputPath);
  pngPaths.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage
    .from('veiculos')
    .getPublicUrl(`Reels/${outputFileName}`);

  return publicUrlData.publicUrl;
}

module.exports = { applyTextOverlay };
