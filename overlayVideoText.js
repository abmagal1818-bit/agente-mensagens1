/**
 * overlayVideoText.js (v4 — memória reduzida para caber em 512MB)
 * ---------------------------------------------------------
 * Histórico:
 * v1: usava drawtext do ffmpeg — falhou, o binário do ffmpeg-static
 *     não inclui libfreetype (sem suporte a drawtext).
 * v2: passou a desenhar cada texto como PNG (via canvas) + filtro
 *     "overlay" do ffmpeg — funcionou, mas usava 5 camadas de overlay
 *     full-frame, consumindo memória demais.
 * v3: agrupou os textos por janela de tempo, reduzindo de 5 para 2
 *     camadas de overlay — ainda estourou 512MB de RAM no Render.
 * v4: a causa real do estouro de memória era o encoder de vídeo
 *     (libx264) usando "rc_lookahead=40" no preset "veryfast" — isso
 *     mantém até 40 frames inteiros (1080x1920) na memória de uma vez,
 *     facilmente 200-300MB sozinho. Trocado para preset "ultrafast"
 *     (lookahead mínimo) e limitado a poucas threads — reduz o
 *     consumo de memória do encoder drasticamente, ao custo de um
 *     arquivo de vídeo final um pouco maior (sem perda perceptível
 *     de qualidade para conteúdo de Reels/Stories).
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

function agruparPorJanela(overlays) {
  const grupos = {};
  overlays.forEach((o) => {
    const chave = `${o.start}-${o.end}`;
    if (!grupos[chave]) grupos[chave] = { start: o.start, end: o.end, textos: [] };
    grupos[chave].textos.push(o);
  });
  return Object.values(grupos);
}

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
 * @param {string} videoUrl
 * @param {Array}  overlays - { text, color, fontSize, y, start, end }
 * @param {string} outputFileName
 * @returns {Promise<string>} URL pública do vídeo final
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
      .outputOptions([
        '-map', '0:a?',
        '-c:a', 'copy',
        '-preset', 'ultrafast', // lookahead mínimo — principal economia de memória
        '-threads', '2',
        '-x264opts', 'rc-lookahead=10:ref=1', // limita ainda mais o buffer de frames em memória
      ])
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
