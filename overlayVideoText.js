/**
 * overlayVideoText.js
 * ---------------------------------------------------------
 * Adiciona textos (título, preço, contato, marca) por cima de
 * um vídeo já pronto (o slideshow simples gerado pelo JSON2Video,
 * SEM texto, só fotos + áudio) usando ffmpeg localmente.
 *
 * Por que isso existe:
 * O JSON2Video estava estourando o tempo de render quando o JSON
 * combinava áudio + vários elementos de texto por cena. Fotos+áudio
 * sozinhos renderizam rápido e de forma confiável. Este script pega
 * esse vídeo simples já pronto e "queima" o texto por cima localmente,
 * eliminando a dependência do JSON2Video para a parte de texto.
 *
 * Requisitos (rodar no projeto do Sarah, no Render):
 *   npm install fluent-ffmpeg ffmpeg-static node-fetch @supabase/supabase-js
 *
 * Também é necessário um arquivo de fonte .ttf no repositório, por
 * exemplo em ./fonts/Montserrat-Bold.ttf (baixe em fonts.google.com,
 * procure "Montserrat", baixe o peso Bold/700, e suba o arquivo .ttf
 * pro seu repositório do GitHub).
 * ---------------------------------------------------------
 */

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

ffmpeg.setFfmpegPath(ffmpegPath);

// ----- Configuração do Supabase (mesmas credenciais que o Sarah já usa) -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Caminho da fonte usada nos textos (ajuste se o arquivo estiver em outro lugar)
const FONT_PATH = path.join(__dirname, 'Poppins-Bold.ttf');

/**
 * Escapa caracteres especiais para o filtro drawtext do ffmpeg.
 * Sem isso, dois-pontos, aspas simples e barras invertidas quebram o filtro.
 */
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019") // troca aspas simples por aspas tipográficas, evita quebrar o filtro
    .replace(/%/g, '\\%');
}

/**
 * Converte uma cor hex (#E63946) para o formato aceito pelo ffmpeg (0xE63946).
 */
function hexToFfmpegColor(hex) {
  return '0x' + hex.replace('#', '');
}

/**
 * Baixa um arquivo de uma URL para um caminho temporário local.
 */
async function downloadToTemp(url, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: ${res.status}`);
  const tempPath = path.join(os.tmpdir(), `overlay-${Date.now()}${suffix}`);
  const buffer = await res.buffer();
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

/**
 * Monta a string de filtros drawtext (um por overlay) para o ffmpeg.
 *
 * overlays: array de objetos:
 *   {
 *     text: "GM Onix Sedan 2021",
 *     color: "#E63946",          // hex
 *     fontSize: 48,
 *     y: "78%",                   // posição vertical, aceita "78%" ou número em px
 *     start: 0,                   // segundo em que o texto aparece
 *     end: 2                      // segundo em que o texto some
 *   }
 */
function buildDrawtextFilters(overlays) {
  return overlays.map((o) => {
    const escapedText = escapeDrawtext(o.text);
    const color = hexToFfmpegColor(o.color || '#FFFFFF');
    const fontSize = o.fontSize || 40;

    // Converte y em "%" para expressão ffmpeg baseada na altura do vídeo (h)
    let yExpr;
    if (typeof o.y === 'string' && o.y.trim().endsWith('%')) {
      const pct = parseFloat(o.y) / 100;
      yExpr = `h*${pct}`;
    } else {
      yExpr = o.y || '(h-text_h)/2';
    }

    const enableExpr = `between(t\\,${o.start}\\,${o.end})`;

    return (
      `drawtext=fontfile='${FONT_PATH}'` +
      `:text='${escapedText}'` +
      `:fontcolor=${color}` +
      `:fontsize=${fontSize}` +
      `:x=(w-text_w)/2` +
      `:y=${yExpr}` +
      `:enable='${enableExpr}'` +
      `:borderw=2:bordercolor=black@0.6` // leve contorno preto, ajuda a legibilidade sobre fotos claras
    );
  });
}

/**
 * Função principal: baixa o vídeo simples, aplica os textos por cima,
 * sobe o resultado final no Supabase Storage, e retorna a URL pública.
 *
 * @param {string} videoUrl - URL do vídeo pronto (sem texto) vindo do JSON2Video
 * @param {Array}  overlays - lista de textos a aplicar (ver formato acima)
 * @param {string} outputFileName - nome do arquivo final, ex: "onix-2021-1234.mp4"
 * @returns {Promise<string>} URL pública do vídeo final no Supabase
 */
async function applyTextOverlay(videoUrl, overlays, outputFileName) {
  const inputPath = await downloadToTemp(videoUrl, '.mp4');
  const outputPath = path.join(os.tmpdir(), outputFileName);

  const filters = buildDrawtextFilters(overlays);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(filters)
      .outputOptions(['-c:a copy']) // mantém o áudio original sem reprocessar
      .on('start', (cmd) => console.log('[ffmpeg] comando:', cmd))
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

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage
    .from('veiculos')
    .getPublicUrl(`Reels/${outputFileName}`);

  return publicUrlData.publicUrl;
}

module.exports = { applyTextOverlay };

/**
 * ---------------------------------------------------------
 * EXEMPLO DE USO (rota Express a adicionar no backend do Sarah)
 * ---------------------------------------------------------
 *
 * const { applyTextOverlay } = require('./overlayVideoText');
 *
 * app.post('/overlay-video', async (req, res) => {
 *   try {
 *     const { videoUrl, titulo, preco, km, site, whatsSarah, outputFileName } = req.body;
 *     const vermelho = '#E63946';
 *
 *     const overlays = [
 *       { text: site, color: vermelho, fontSize: 28, y: '5%', start: 0, end: 12 },
 *       { text: titulo, color: '#FFFFFF', fontSize: 48, y: '78%', start: 0, end: 2 },
 *       { text: `${km} • ${preco}`, color: vermelho, fontSize: 36, y: '88%', start: 0, end: 2 },
 *       { text: 'Premium Automarcas', color: vermelho, fontSize: 50, y: '45%', start: 10, end: 12 },
 *       { text: `Fale com a Sarah: ${whatsSarah}`, color: '#FFFFFF', fontSize: 32, y: '60%', start: 10, end: 12 },
 *     ];
 *
 *     const finalUrl = await applyTextOverlay(videoUrl, overlays, outputFileName);
 *     res.json({ success: true, url: finalUrl });
 *   } catch (err) {
 *     console.error(err);
 *     res.status(500).json({ success: false, error: err.message });
 *   }
 * });
 *
 * ---------------------------------------------------------
 * COMO ISSO SE ENCAIXA NO SEU WORKFLOW DO N8N
 * ---------------------------------------------------------
 * 1. Code node monta o JSON só com fotos + áudio (sem texto) -> JSON2Video
 * 2. Wait + HTTP Request1 + If (já configurado hoje) esperam o status "done"
 * 3. NOVO PASSO: HTTP Request para POST https://agente-mensagens1.onrender.com/overlay-video
 *    enviando { videoUrl: <url do json2video>, titulo, preco, km, site, whatsSarah, outputFileName }
 * 4. Esse endpoint devolve a URL final do vídeo já com o texto, hospedado no seu Supabase
 * ---------------------------------------------------------
 */
