/**
 * ---------------------------------------------------------
 * overlayVideoText.js
 * ---------------------------------------------------------
 * Aplica overlays de texto (título, contato, site) sobre um
 * vídeo já pronto (imagens + áudio) gerado pelo JSON2Video.
 *
 * Em vez de desenhar o texto direto no ffmpeg (drawtext, que
 * requer libfreetype e não está disponível no build padrão do
 * ffmpeg-static), geramos cada grupo de texto como uma imagem
 * PNG transparente (usando a biblioteca "canvas", com controle
 * total de fonte/cor/tamanho) e usamos o filtro "overlay" do
 * ffmpeg (básico, sempre disponível) para colar essas imagens
 * por cima do vídeo, no tempo certo.
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
 * (mesma janela de tempo), cada um na sua posição vertical, alinhados
 * à esquerda com uma margem fixa.
 */
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
      .outputOptions([
        '-map', '0:a?',
        '-c:a', 'copy',
        '-preset', 'ultrafast',
        '-threads', '2',
        '-x264opts', 'rc-lookahead=10:ref=1',
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
