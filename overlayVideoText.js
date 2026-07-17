/**
 * ---------------------------------------------------------
 * overlayVideoText.js (versão simplificada)
 * ---------------------------------------------------------
 * O vídeo que chega aqui já sai CHEIO do JSON2Video (foto
 * preenchendo o quadro 1080x1920 inteiro, graças ao
 * "resize":"cover" no payload). Este arquivo NÃO mexe mais
 * no tamanho/corte da foto — só desenha o texto por cima,
 * numa ÚNICA camada de overlay (mais simples, menos chance
 * de falhar silenciosamente).
 *
 * Conteúdo:
 *   - Título do veículo na diagonal (30°), com negrito
 *     reforçado e tamanho de fonte que se auto-ajusta pra
 *     nunca cortar, na parte superior da tela, com sombra
 *     escura pra contraste sobre a foto.
 *   - "Whats ..." centralizado no rodapé.
 *   - Site centralizado, abaixo do Whats.
 *
 * (O efeito de piscar no Whats foi removido nesta versão
 * pra simplificar e garantir que o texto aparece. Depois de
 * confirmado, adicionamos o piscar de volta.)
 *
 * Requisitos (já instalados no projeto):
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

const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;
const VERMELHO = '#E63946';

const TITULO_MARGEM_SUPERIOR = 40;
const TITULO_MARGEM_LATERAL = 30;
const TITULO_ALTURA_MAXIMA = 420; // quanto da parte de cima o título pode ocupar
const TITULO_ANGULO_GRAUS = 30;

async function downloadToTemp(url, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: ${res.status}`);
  const tempPath = path.join(os.tmpdir(), `overlay-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  const buffer = await res.buffer();
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

function criarCanvasTextoBold(text, fontSizePx, corHex, fontFamily = 'Poppins') {
  const padding = Math.max(10, Math.round(fontSizePx * 0.15));

  const medidor = createCanvas(10, 10).getContext('2d');
  medidor.font = `bold ${fontSizePx}px ${fontFamily}`;
  const m = medidor.measureText(text);
  const width = m.width;
  const ascent = m.actualBoundingBoxAscent || fontSizePx * 0.8;
  const descent = m.actualBoundingBoxDescent || fontSizePx * 0.25;
  const height = ascent + descent;

  const canvas = createCanvas(Math.ceil(width) + padding * 2, Math.ceil(height) + padding * 2);
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontSizePx}px ${fontFamily}`;
  ctx.textBaseline = 'alphabetic';

  const x = padding;
  const y = padding + ascent;

  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillText(text, x + 3, y + 3);

  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]];
  ctx.fillStyle = corHex;
  offsets.forEach(([ox, oy]) => ctx.fillText(text, x + ox, y + oy));
  ctx.fillText(text, x, y);

  return canvas;
}

function rotacionarCanvas(canvasOrig, anguloGraus) {
  const angulo = (anguloGraus * Math.PI) / 180;
  const w = canvasOrig.width;
  const h = canvasOrig.height;
  const rw = Math.ceil(Math.abs(w * Math.cos(angulo)) + Math.abs(h * Math.sin(angulo)));
  const rh = Math.ceil(Math.abs(w * Math.sin(angulo)) + Math.abs(h * Math.cos(angulo)));

  const canvas = createCanvas(rw, rh);
  const ctx = canvas.getContext('2d');
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate(angulo);
  ctx.drawImage(canvasOrig, -w / 2, -h / 2);
  return canvas;
}

function ajustarEGerarTituloDiagonal(text, corHex, maxWidth, maxHeight, anguloGraus, tamanhoInicial = 140, tamanhoMin = 20) {
  let tamanho = tamanhoInicial;
  while (tamanho > tamanhoMin) {
    const textoCanvas = criarCanvasTextoBold(text, tamanho, corHex);
    const rotated = rotacionarCanvas(textoCanvas, anguloGraus);
    if (rotated.width <= maxWidth && rotated.height <= maxHeight) {
      return rotated;
    }
    tamanho -= 2;
  }
  const textoCanvas = criarCanvasTextoBold(text, tamanhoMin, corHex);
  return rotacionarCanvas(textoCanvas, anguloGraus);
}

/**
 * Gera UM ÚNICO PNG (tamanho do vídeo) já com todo o texto
 * desenhado: título diagonal em cima, whats e site no rodapé.
 * Uma camada só = menos chance de falha no ffmpeg.
 */
function gerarOverlayCompleto(titulo, whatsSarah, site) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  // --- título diagonal, no topo, sobre a foto ---
  const maxWidth = VIDEO_WIDTH - 2 * TITULO_MARGEM_LATERAL;
  const maxHeight = TITULO_ALTURA_MAXIMA;
  const rotated = ajustarEGerarTituloDiagonal(titulo || '', VERMELHO, maxWidth, maxHeight, TITULO_ANGULO_GRAUS);
  const px = Math.round((VIDEO_WIDTH - rotated.width) / 2);
  const py = TITULO_MARGEM_SUPERIOR;
  ctx.drawImage(rotated, px, py);

  // --- whats, centralizado, rodapé ---
  const whatsCanvas = criarCanvasTextoBold(`Whats ${whatsSarah || ''}`, 62, VERMELHO);
  ctx.drawImage(
    whatsCanvas,
    Math.round((VIDEO_WIDTH - whatsCanvas.width) / 2),
    Math.round(VIDEO_HEIGHT * 0.84 - whatsCanvas.height / 2)
  );

  // --- site, centralizado, abaixo do whats ---
  const siteCanvas = criarCanvasTextoBold(site || 'premiumautomarcas.net.br', 58, VERMELHO);
  ctx.drawImage(
    siteCanvas,
    Math.round((VIDEO_WIDTH - siteCanvas.width) / 2),
    Math.round(VIDEO_HEIGHT * 0.91 - siteCanvas.height / 2)
  );

  return canvas.toBuffer('image/png');
}

/**
 * Baixa o vídeo (já cheio, vindo do JSON2Video), cola UMA camada
 * de overlay com todo o texto, sobe pro Supabase.
 */
async function applyTextOverlay(videoUrl, dados, outputFileName) {
  const { titulo, whatsSarah, site } = dados;

  const inputPath = await downloadToTemp(videoUrl, '.mp4');
  const outputPath = path.join(os.tmpdir(), outputFileName);

  const pngOverlay = gerarOverlayCompleto(titulo, whatsSarah, site);
  const pathOverlay = path.join(os.tmpdir(), `overlay-texto-${Date.now()}.png`);
  fs.writeFileSync(pathOverlay, pngOverlay);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .input(pathOverlay)
      .complexFilter(`[0:v][1:v]overlay=0:0[vout]`, 'vout')
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

  [inputPath, outputPath, pathOverlay].forEach((p) => {
    try { fs.unlinkSync(p); } catch (e) {}
  });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage
    .from('veiculos')
    .getPublicUrl(`Reels/${outputFileName}`);

  return publicUrlData.publicUrl;
}

module.exports = { applyTextOverlay };
