/**
 * sincronizar-estoque.js — Premium Automarcas
 * 
 * Faz login no Mobigestor, extrai estoque completo com fotos
 * e salva em estoque.json para a Sara consultar.
 * 
 * Roda automaticamente todo dia via cron job no Render.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

// ─── CONFIGURAÇÃO ──────────────────────────────────────────────
const CONFIG = {
  email:        process.env.MOBIAUTO_EMAIL || 'premium@premiumautomarcas.com.br',
  senha:        process.env.MOBIAUTO_SENHA || 'f;I~5N=@@M',
  lojaId:       '31402',
  arquivoSaida: process.env.ESTOQUE_PATH   || './estoque.json',
};
// ───────────────────────────────────────────────────────────────

function request(urlOrOptions, body = null) {
  return new Promise((resolve, reject) => {
    const isString = typeof urlOrOptions === 'string';
    const lib = (isString ? urlOrOptions : (urlOrOptions.protocol || 'https:')).startsWith('http:') ? http : https;

    const options = isString ? new URL(urlOrOptions) : urlOrOptions;
    const req = lib.request(options, (res) => {
      // Segue redirecionamentos
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return request(res.headers.location, body).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function extrairCookies(header) {
  if (!header) return '';
  return (Array.isArray(header) ? header : [header]).map(c => c.split(';')[0]).join('; ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Tenta múltiplos endpoints de login conhecidos do Mobigestor/Mobiauto
async function fazerLogin() {
  const body = JSON.stringify({ email: CONFIG.email, password: CONFIG.senha });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Origin': 'https://www.mobigestor.com.br',
    'Referer': 'https://www.mobigestor.com.br/',
  };

  const endpoints = [
    { hostname: 'www.mobigestor.com.br',  path: '/api/auth/login' },
    { hostname: 'www.mobigestor.com.br',  path: '/auth/login' },
    { hostname: 'api.mobiauto.com.br',     path: '/auth/v1/login' },
    { hostname: 'api.mobiauto.com.br',     path: '/v1/auth/login' },
    { hostname: 'open-api.mobiauto.com.br',path: '/auth/login' },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`   Tentando ${ep.hostname}${ep.path}...`);
      const res = await request({ ...ep, method: 'POST', headers }, body);
      console.log(`   Status: ${res.status}`);

      if (res.status === 200) {
        let token = null;
        const cookies = extrairCookies(res.headers['set-cookie']);
        try {
          const data = JSON.parse(res.body);
          token = data.token || data.access_token || data.accessToken
               || data.jwt   || data.idToken
               || (data.data && (data.data.token || data.data.access_token));
        } catch(e) {}
        return { token, cookies, loginBody: res.body };
      }

      // Alguns endpoints retornam 201
      if (res.status === 201) {
        const cookies = extrairCookies(res.headers['set-cookie']);
        let token = null;
        try { const d = JSON.parse(res.body); token = d.token || d.access_token; } catch(e) {}
        return { token, cookies, loginBody: res.body };
      }

      console.log(`   Resposta: ${res.body.substring(0, 100)}`);
    } catch(e) {
      console.log(`   Erro: ${e.message}`);
    }
  }
  return null;
}

// Busca lista de veículos tentando vários endpoints
async function buscarVeiculos(auth) {
  const authHeaders = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Origin': 'https://www.mobigestor.com.br',
    ...(auth.token  && { 'Authorization': `Bearer ${auth.token}` }),
    ...(auth.cookies && { 'Cookie': auth.cookies }),
  };

  const endpoints = [
    `/api/loja/${CONFIG.lojaId}/anuncios?status=ATIVO&size=100&page=0`,
    `/api/loja/${CONFIG.lojaId}/anuncios?size=100`,
    `/api/${CONFIG.lojaId}/anuncios?status=ATIVO&size=100`,
    `/mobigestor/${CONFIG.lojaId}/estoque/api?size=100`,
    `/api/anuncios?lojaId=${CONFIG.lojaId}&status=ATIVO&size=100`,
  ];

  for (const path of endpoints) {
    try {
      console.log(`   Tentando //${path}...`);
      const res = await request({
        hostname: 'www.mobigestor.com.br',
        path, method: 'GET', headers: authHeaders,
      });
      console.log(`   Status: ${res.status}`);

      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const lista = data.content || data.items || data.data
                   || data.anuncios || data.veiculos || data;
        if (Array.isArray(lista) && lista.length > 0) {
          console.log(`   ✅ ${lista.length} veículos encontrados`);
          return { lista, authHeaders };
        }
      }
      console.log(`   Resposta: ${res.body.substring(0, 150)}`);
    } catch(e) {
      console.log(`   Erro: ${e.message}`);
    }
  }
  return null;
}

// Busca fotos de um veículo específico
async function buscarFotos(id, authHeaders) {
  const endpoints = [
    `/api/loja/${CONFIG.lojaId}/anuncios/${id}`,
    `/api/loja/${CONFIG.lojaId}/anuncios/${id}/fotos`,
    `/api/anuncios/${id}/fotos`,
    `/api/anuncios/${id}`,
  ];

  for (const path of endpoints) {
    try {
      const res = await request({
        hostname: 'www.mobigestor.com.br',
        path, method: 'GET', headers: authHeaders,
      });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        // Tenta extrair fotos de vários formatos possíveis
        const arr = data.fotos || data.images || data.imagens
                 || data.photos || data.midias || data;
        if (Array.isArray(arr)) {
          const urls = arr
            .map(f => typeof f === 'string' ? f : (f.url || f.imageUrl || f.urlImagem || f.path || f.src))
            .filter(u => u && typeof u === 'string' && u.startsWith('http'));
          if (urls.length > 0) return urls;
        }
      }
    } catch(e) {}
  }
  return [];
}

async function main() {
  console.log('🚗 Premium Automarcas — Sincronizador de Estoque');
  console.log('================================================');
  console.log(`📅 ${new Date().toLocaleString('pt-BR')}`);

  // ── PASSO 1: Login ──────────────────────────────────────────
  console.log('\n📧 Fazendo login no Mobigestor...');
  const auth = await fazerLogin();

  if (!auth) {
    console.error('\n❌ Falha no login em todos os endpoints.');
    console.error('   Verifique as credenciais ou se o Mobigestor mudou sua API.');

    // Salva estoque vazio para não quebrar a Sara
    fs.writeFileSync(CONFIG.arquivoSaida, JSON.stringify({
      erro: 'Falha no login',
      atualizadoEm: new Date().toISOString(),
      veiculos: [],
    }, null, 2));
    process.exit(1);
  }

  console.log('   ✅ Login OK!');
  if (auth.token) console.log('   Token obtido via JSON');
  if (auth.cookies) console.log('   Cookies obtidos');

  // ── PASSO 2: Buscar veículos ────────────────────────────────
  console.log('\n📋 Buscando lista de veículos...');
  const resultado = await buscarVeiculos(auth);

  if (!resultado) {
    console.error('\n❌ Não foi possível buscar os veículos.');
    process.exit(1);
  }

  const { lista, authHeaders } = resultado;

  // ── PASSO 3: Buscar fotos de cada veículo ───────────────────
  console.log('\n📸 Buscando fotos...');
  const estoqueCompleto = [];

  for (let i = 0; i < lista.length; i++) {
    const v = lista[i];
    const id = v.id || v.anuncioId || v.codigoAnuncio || v.codigo;
    const nome = [v.marca || v.brand, v.modelo || v.model, v.versao || v.version]
      .filter(Boolean).join(' ') || `Veículo ${id}`;

    process.stdout.write(`   [${i+1}/${lista.length}] ${nome}...`);

    const fotos = await buscarFotos(id, authHeaders);
    process.stdout.write(` ${fotos.length} foto(s) ✓\n`);

    estoqueCompleto.push({
      id,
      marca:         v.marca         || v.brand        || '',
      modelo:        v.modelo        || v.model        || '',
      versao:        v.versao        || v.version      || '',
      ano:           v.anoModelo     || v.ano          || v.year || '',
      anoFabricacao: v.anoFabricacao || '',
      km:            v.quilometragem || v.km           || v.mileage || 0,
      preco:         v.preco         || v.price        || 0,
      cambio:        v.cambio        || v.transmission || '',
      combustivel:   v.combustivel   || v.fuel         || '',
      cor:           v.cor           || v.color        || '',
      opcionais:     v.opcionais     || v.features     || [],
      descricao:     v.descricao     || v.description  || '',
      fotos,
      atualizadoEm:  new Date().toISOString(),
    });

    await sleep(200);
  }

  // ── PASSO 4: Salvar JSON ────────────────────────────────────
  const saida = {
    loja:          'Premium Automarcas',
    lojaId:        CONFIG.lojaId,
    totalVeiculos: estoqueCompleto.length,
    atualizadoEm:  new Date().toISOString(),
    veiculos:      estoqueCompleto,
  };

  fs.writeFileSync(CONFIG.arquivoSaida, JSON.stringify(saida, null, 2));

  console.log('\n================================================');
  console.log(`✅ ${estoqueCompleto.length} veículos salvos em ${CONFIG.arquivoSaida}`);
  const comFotos = estoqueCompleto.filter(v => v.fotos.length > 0).length;
  console.log(`📸 ${comFotos} veículos com fotos`);
  console.log('================================================\n');
}

main().catch(err => {
  console.error('❌ Erro fatal:', err.message);
  process.exit(1);
});
