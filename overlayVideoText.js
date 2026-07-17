/**
 * overlayVideoText.js (v3 — camadas agrupadas por janela de tempo)
 * ---------------------------------------------------------
 * v1 usava drawtext do ffmpeg — falhou porque o binário do
 * ffmpeg-static não inclui libfreetype (sem suporte a drawtext).
 *
 * v2 passou a desenhar cada texto como PNG (via canvas) e usar o
 * filtro "overlay" do ffmpeg — funcionou, mas usava 5 camadas de
 * overlay full-frame (1080x1920) compostas em TODOS os frames do
 * vídeo inteiro, consumindo memória demais e derrubando o serviço
 * no Render (reinício por falta de memória).
 *
 * v3: agrupa todos os textos que aparecem na MESMA janela de tempo
 * numa única imagem PNG (ex: título+preço da abertura viram 1 PNG;
 * marca+contato do final viram outro PNG). Isso reduz de 5 camadas
 * de overlay para só 2, cortando bastante o consumo de memória.
 *
 * Requisitos (rodar no projeto do Sarah, no Render):
 *   npm install fluent-ffmpeg ffmpeg-static node-fetch @supabase/supabase-js canvas
 * Precisa do arquivo Poppins-Bold.ttf na raiz do projeto.
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
 * Agrupa textos com o mesmo [start, end] numa única "camada".
 * Recebe a lista original de overlays e devolve grupos:
 * [{ start, end, textos: [{text,color,fontSize,y}, ...] }, ...]
 */
function agruparPorJanela(overlays) {
  const grupos = {};
  overlays.forEach((o) => {
    const chave = `${o.start}-${o.end}`;
    if (!grupos[chave]) grupos[chave] = { start: o.start, end: o.end, textos: [] };
    grupos[chave].textos.push(o);
  });
  return Object.values(grupos);
}

/**
 * Gera um único PNG transparente contendo todos os textos de um grupo
 * (mesma janela de tempo), cada um na sua posição vertical.
 */
function gerarPngGrupo(grupo) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  grupo.textos.forEach((overlay) => {
    const fontSize = overlay.fontSize || 40;
    ctx.font = `bold ${fontSize}px Poppins`;

    let yPos;
    if (typeof overlay.y === 'string' && overlay.y.trim().endsWith('%')) {
      yPos = VIDEO_HEIGHT * (parseFloat(overlay.y) / 100);
    } else {
      yPos = Number(overlay.y) || VIDEO_HEIGHT / 2;
    }

    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.06));
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(overlay.text, VIDEO_WIDTH / 2, yPos);
    ctx.fillStyle = overlay.color || '#FFFFFF';
    ctx.fillText(overlay.text, VIDEO_WIDTH / 2, yPos);
  });

  return canvas.toBuffer('image/png');
}

/**
 * Função principal: baixa o vídeo simples, gera 1 PNG por janela de
 * tempo (agrupando textos), compõe com ffmpeg (overlay), sobe no
 * Supabase Storage, e retorna a URL pública.
 *
 * @param {string} videoUrl - URL do vídeo pronto (sem texto) vindo do JSON2Video
 * @param {Array}  overlays - lista de textos: { text, color, fontSize, y, start, end }
 * @param {string} outputFileName - nome do arquivo final, ex: "onix-2021-1234.mp4"
 * @returns {Promise<string>} URL pública do vídeo final no Supabase
 */
async function applyTextOverlay(videoUrl, overlays, outputFileName) {
  const inputPath = await downloadToTemp(videoUrl, '.mp4');
  const outputPath = path.join(os.tmpdir(), outputFileName);

  const grupos = agruparPorJanela(overlays);

  const pngPaths = grupos.map((grupo) => {
    const buffer = gerarPngGrupo(grupo);
    const pngPath = path.join(os.tmpdir(), `text-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(pngPath, buffer);
    return pngPath;
  });

  let filterChain = '';
  let lastLabel = '0:v';
  grupos.forEach((grupo, i) => {
    const inputIndex = i + 1;
    const outLabel = i === grupos.length - 1 ? 'vout' : `v${i}`;
    const enableExpr = `between(t\\,${grupo.start}\\,${grupo.end})`;
    filterChain += `[${lastLabel}][${inputIndex}:v]overlay=enable='${enableExpr}'[${outLabel}];`;
    lastLabel = outLabel;
  });
  filterChain = filterChain.replace(/;$/, '');

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    pngPaths.forEach((p) => cmd.input(p));
    cmd
      .complexFilter(filterChain, 'vout')
      .outputOptions(['-map', '0:a?', '-c:a', 'copy', '-preset', 'veryfast'])
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
