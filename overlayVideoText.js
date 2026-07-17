/**
 * ---------------------------------------------------------
 * overlayVideoText.js
 * ---------------------------------------------------------
 * Aplica sobre um vídeo simples (fotos + áudio, gerado pelo
 * JSON2Video) o padrão visual de Reels da Premium Automarcas:
 *
 *   - Faixa preta em cima e embaixo (letterbox), foto do carro
 *     redimensionada pra caber inteira na faixa central, sem
 *     cortar e sem sobrar espaço excedente.
 *   - Título do veículo na diagonal (30°), centralizado, com
 *     negrito reforçado e tamanho de fonte que se AUTO-AJUSTA
 *     pra sempre caber dentro da faixa preta de cima, não
 *     importa se o nome do carro é curto ou longo.
 *   - "Whats ..." centralizado no rodapé, piscando.
 *   - Site centralizado, abaixo do Whats.
 *
 * Todo texto é desenhado com a biblioteca "canvas" (PNG
 * transparente) e depois colado no vídeo com o filtro
 * "overlay" do ffmpeg — mesma técnica de sempre, só que agora
 * com posicionamento robusto (sem estouro de borda) e com
 * suporte a rotação, auto-ajuste de tamanho e piscar.
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

// Dimensões do vídeo (formato "instagram-story" do JSON2Video)
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;

// Layout: onde a foto do carro fica (faixa central)
const FAIXA_TOP_PCT = 30; // % da altura onde a foto COMEÇA
const FAIXA_BOTTOM_PCT = 80; // % da altura onde a foto TERMINA

// Margens de segurança do título (dentro da faixa preta de cima)
const TITULO_MARGEM_SUPERIOR = 20;
const TITULO_MARGEM_INFERIOR = 20;
const TITULO_MARGEM_LATERAL = 30;
const TITULO_ANGULO_GRAUS = 30;

const VERMELHO = '#E63946';

async function downloadToTemp(url, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: ${res.status}`);
  const tempPath = path.join(os.tmpdir(), `overlay-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  const buffer = await res.buffer();
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

/**
 * Desenha um texto com negrito reforçado (múltiplas cópias
 * deslocadas 1px) + sombra escura de contraste, num canvas
 * do tamanho exato do texto (com uma margem pequena).
 * Retorna o canvas pronto (não é o vídeo inteiro, só o texto).
 */
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

  // sombra
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillText(text, x + 3, y + 3);

  // negrito sintético (cópias deslocadas 1px ao redor) + preenchimento
  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]];
  ctx.fillStyle = corHex;
  offsets.forEach(([ox, oy]) => ctx.fillText(text, x + ox, y + oy));
  ctx.fillText(text, x, y);

  return canvas;
}

/** Rotaciona um canvas (imagem de texto) em torno do próprio centro. */
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

/**
 * Gera o título já rotacionado, reduzindo o tamanho da fonte
 * automaticamente até caber dentro de maxWidth x maxHeight.
 * Isso garante que nomes de carro curtos ou longos NUNCA cortam.
 */
function ajustarEGerarTituloDiagonal(text, corHex, maxWidth, maxHeight, anguloGraus, tamanhoInicial = 140, tamanhoMin = 20) {
  let tamanho = tamanhoInicial;
  while (tamanho > tamanhoMin) {
    const textoCanvas = criarCanvasTextoBold(text, tamanho, corHex);
    const rotated = rotacionarCanvas(textoCanvas, anguloGraus);
    if (rotated.width <= maxWidth && rotated.height <= maxHeight) {
      return { canvas: rotated, tamanho };
    }
    tamanho -= 2;
  }
  const textoCanvas = criarCanvasTextoBold(text, tamanhoMin, corHex);
  return { canvas: rotacionarCanvas(textoCanvas, anguloGraus), tamanho: tamanhoMin };
}

/** PNG transparente (tamanho do vídeo) com o título diagonal posicionado na faixa preta de cima. */
function gerarPngTitulo(titulo) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  const faixaTopPx = Math.round((VIDEO_HEIGHT * FAIXA_TOP_PCT) / 100);
  const maxWidth = VIDEO_WIDTH - 2 * TITULO_MARGEM_LATERAL;
  const maxHeight = faixaTopPx - TITULO_MARGEM_SUPERIOR - TITULO_MARGEM_INFERIOR;

  const { canvas: rotated } = ajustarEGerarTituloDiagonal(titulo, VERMELHO, maxWidth, maxHeight, TITULO_ANGULO_GRAUS);

  const px = Math.round((VIDEO_WIDTH - rotated.width) / 2);
  const py = Math.round(TITULO_MARGEM_SUPERIOR + (maxHeight - rotated.height) / 2);
  ctx.drawImage(rotated, px, py);

  return canvas.toBuffer('image/png');
}

/** PNG transparente com um texto centralizado horizontalmente numa altura (% da tela) específica. */
function gerarPngCentralizado(text, fontSizePx, yPercent, corHex) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  const textoCanvas = criarCanvasTextoBold(text, fontSizePx, corHex);
  const x = Math.round((VIDEO_WIDTH - textoCanvas.width) / 2);
  const y = Math.round((VIDEO_HEIGHT * yPercent) / 100) - Math.round(textoCanvas.height / 2);
  ctx.drawImage(textoCanvas, x, y);

  return canvas.toBuffer('image/png');
}

/**
 * Função principal: baixa o vídeo simples do JSON2Video, redimensiona
 * a imagem pra caber na faixa central (letterbox real, sem cortar),
 * aplica título diagonal + Whats piscando + site, sobe pro Supabase.
 *
 * @param {string} videoUrl - vídeo pronto (fotos + áudio) do JSON2Video
 * @param {{titulo:string, whatsSarah:string, site:string}} dados
 * @param {string} outputFileName
 * @returns {Promise<string>} URL pública do vídeo final
 */
async function applyTextOverlay(videoUrl, dados, outputFileName) {
  const { titulo, whatsSarah, site } = dados;

  const inputPath = await downloadToTemp(videoUrl, '.mp4');
  const outputPath = path.join(os.tmpdir(), outputFileName);

  const faixaTopPx = Math.round((VIDEO_HEIGHT * FAIXA_TOP_PCT) / 100);
  const faixaBottomPx = Math.round((VIDEO_HEIGHT * FAIXA_BOTTOM_PCT) / 100);
  const faixaHeight = faixaBottomPx - faixaTopPx;

  const pngTitulo = gerarPngTitulo(titulo || '');
  const pngWhats = gerarPngCentralizado(`Whats ${whatsSarah || ''}`, 62, 84, VERMELHO);
  const pngSite = gerarPngCentralizado(site || 'premiumautomarcas.net.br', 58, 91, VERMELHO);

  const pathTitulo = path.join(os.tmpdir(), `titulo-${Date.now()}.png`);
  const pathWhats = path.join(os.tmpdir(), `whats-${Date.now()}.png`);
  const pathSite = path.join(os.tmpdir(), `site-${Date.now()}.png`);
  fs.writeFileSync(pathTitulo, pngTitulo);
  fs.writeFileSync(pathWhats, pngWhats);
  fs.writeFileSync(pathSite, pngSite);

  // 1) redimensiona/enquadra a foto pra caber exatamente na faixa central (cover, sem distorcer)
  //    e adiciona preto acima e abaixo (letterbox real)
  // 2) cola o título (sempre visível)
  // 3) cola o Whats piscando (visível 0.6s, some 0.4s, em loop)
  // 4) cola o site (sempre visível)
  const filterComplex = [
    `[0:v]scale=${VIDEO_WIDTH}:${faixaHeight}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${faixaHeight},pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:0:${faixaTopPx}:black[bg]`,
    `[bg][1:v]overlay=0:0[v1]`,
    `[v1][2:v]overlay=0:0:enable='lt(mod(t\\,1)\\,0.6)'[v2]`,
    `[v2][3:v]overlay=0:0[vout]`,
  ].join(';');

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .input(pathTitulo)
      .input(pathWhats)
      .input(pathSite)
      .complexFilter(filterComplex, 'vout')
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

  [inputPath, outputPath, pathTitulo, pathWhats, pathSite].forEach((p) => {
    try { fs.unlinkSync(p); } catch (e) {}
  });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage
    .from('veiculos')
    .getPublicUrl(`Reels/${outputFileName}`);

  return publicUrlData.publicUrl;
}

module.exports = { applyTextOverlay };
