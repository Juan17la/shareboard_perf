#!/usr/bin/env node
// Laboratorio de carga. Un solo comando:
//
//   node analitics/telemetry/lab.mjs            -> abre http://localhost:7070
//
// Desde la interfaz se prepara el entorno (Mongo + servidor + agente + datos), se corren
// las pruebas y se ven en vivo o se reproducen después.
//
// En la nube (EC2) se corre así, y luego el PC lo usa como entorno "Nube":
//   node analitics/telemetry/lab.mjs --target-only [--mode native]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadBeforeAfter, loadRuns, removeAws, saveAws } from './lib/comparar.mjs';
import { ARRIVE_SEC, runTest } from './lib/runner.mjs';
import { CORES, DATA, MODES, coreLayout, freePort, localTarget, SERVER_PORT, AGENT_PORT } from './lib/target.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7070' },
    'target-only': { type: 'boolean', default: false },
    mode: { type: 'string', default: 'native' },
    workers: { type: 'string', default: '1' }, // con --target-only: procesos de Node del servidor
    token: { type: 'string' },
  },
});
const targetOnly = args['target-only'];

// ---------- arranque: Node reciente, límite de archivos abiertos y núcleos del generador ----------
// Se relanza a sí mismo una vez con todo eso resuelto (así no depende de cómo esté tu terminal).
if (!process.env.LAB_CHILD) {
  let node = process.execPath;
  // Node 24.7 trae Argon2id, el hash que usa el servidor para las contraseñas. Con Node 22 corre, pero usa scrypt.
  const parts = (v) => v.replace(/^v/, '').split('.').map(Number);
  const recent = (v) => parts(v)[0] > 24 || (parts(v)[0] === 24 && parts(v)[1] >= 7);
  if (!recent(process.version)) {
    const dir = join(homedir(), '.nvm/versions/node');
    const found = existsSync(dir) ? readdirSync(dir).filter(recent).sort((a, b) => parts(b)[0] - parts(a)[0] || parts(b)[1] - parts(a)[1]) : [];
    if (found[0]) {
      node = join(dir, found[0], 'bin/node');
      console.log(`Usando ${node} (tu terminal tenía ${process.version})`);
    } else if (parts(process.version)[0] < 22) {
      console.error(`Se necesita Node 22 o más nuevo (tienes ${process.version}). Instálalo con: nvm install 24`);
      process.exit(1);
    } else {
      console.log(`Node ${process.version}: los logins usarán scrypt. Para medir Argon2id, instala Node 24: nvm install 24`);
    }
  }
  const cores = coreLayout();
  const pin = cores && !targetOnly ? ['taskset', '-c', cores.gen.join(',')] : [];
  const r = spawnSync('sh', ['-c', 'ulimit -n $(ulimit -Hn) 2>/dev/null; exec "$@"', 'sh', ...pin, node, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, LAB_CHILD: '1' },
  });
  process.exit(r.status ?? 1);
}

// ---------- estado ----------
const token = args.token ?? randomBytes(9).toString('hex');
const RAW = join(DATA, 'raw');
mkdirSync(RAW, { recursive: true });
const clients = new Set();
const logLines = [];
const send = (msg) => {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
};
const log = (text) => {
  const line = `${new Date().toTimeString().slice(0, 8)}  ${text}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  console.log(line);
  send({ kind: 'log', line });
};

const local = localTarget({ token, log, bind: targetOnly ? '0.0.0.0' : '127.0.0.1' });
const state = { mode: null, remote: null, busy: null, ready: false, error: null, status: {}, test: null, cores: CORES };
const pushState = () => send({ kind: 'state', state });
let remoteSeed = null;
let testRecs = [];
let testCtl = null;

// Las pruebas (profiles/N-*.json) comparten el flujo de usuario de profiles/flujo.json.
const FLOW = JSON.parse(readFileSync(join(here, 'profiles/flujo.json'), 'utf8'));
const PROFILES = Object.fromEntries(
  readdirSync(join(here, 'profiles'))
    .filter((f) => /^\d.*\.json$/.test(f))
    .map((f) => ({ flow: FLOW, ...JSON.parse(readFileSync(join(here, 'profiles', f), 'utf8')) }))
    .sort((a, b) => a.order - b.order)
    .map((p) => [p.id, p]),
);

function duration(p, quick) {
  const plan = { ...p.plan, ...(quick ? p.quick : {}) };
  // Con measureSec: llegada fija + 30 s de estabilización + medición (todas las pruebas duran lo mismo).
  const sec = plan.users.reduce((t, u) => t + (plan.measureSec ? ARRIVE_SEC + 30 + plan.measureSec : typeof u === 'number' ? plan.stepSec : u.sec), 0);
  return `${Math.round(sec / 60)} min`;
}

// ---------- objetivo activo: este PC o un lab remoto (--target-only) ----------
function remoteCall(path, opts = {}) {
  // "ip" o "ip:puerto" (el puerto del laboratorio remoto; por defecto el mismo de este).
  const [h, p = args.port] = state.remote.host.split(':');
  return fetch(`http://${h}:${p}${path}`, { ...opts, headers: { 'x-token': state.remote.token, 'content-type': 'application/json' }, signal: AbortSignal.timeout(opts.timeout ?? 10_000) }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  });
}
function active() {
  if (state.mode === 'remote') {
    const h = state.remote.host.split(':')[0];
    return { env: `nube-${h}`, serverUrl: `http://${h}:${SERVER_PORT}`, agentUrl: `http://${h}:${AGENT_PORT}`, token: state.remote.token, seed: () => remoteSeed, restart: () => remoteCall('/api/target/restart', { method: 'POST', timeout: 120_000 }) };
  }
  // Las corridas con varios procesos no deben confundirse con las de uno solo.
  const suffix = local.workers > 1 ? `-${local.workers}w` : '';
  return { env: MODES[state.mode].env + suffix, serverUrl: local.serverUrl, agentUrl: local.agentUrl, token, seed: local.seed, restart: local.restartServer };
}

async function refreshStatus() {
  try {
    if (state.mode === 'remote') state.status = (await remoteCall('/api/target/status')).status;
    else if (state.mode) state.status = await local.status();
  } catch (err) {
    state.status = { error: err.message };
  }
  pushState();
}
setInterval(() => !state.busy && refreshStatus(), 4000).unref();

async function prepare(mode, remote, workers = local.workers) {
  state.busy = 'preparing';
  state.ready = false;
  state.error = null;
  state.mode = mode;
  state.remote = mode === 'remote' ? remote : null;
  pushState();
  try {
    if (mode === 'remote') {
      log(`▸ Conectando con el laboratorio remoto ${remote.host}`);
      const st = await remoteCall('/api/target/status');
      if (!st.ready) throw new Error(`El remoto no está listo: ${st.error ?? 'todavía preparando, espera y reintenta'}`);
      remoteSeed = await remoteCall('/api/target/seed', { timeout: 60_000 });
      log(`Remoto listo: ${st.label}, ${remoteSeed.accounts.length} cuentas de prueba`);
    } else {
      await local.prepare(mode, workers);
    }
    state.ready = true;
  } catch (err) {
    state.error = err.message;
    log(`ERROR: ${err.message}`);
  } finally {
    state.busy = null;
    await refreshStatus();
  }
}

async function startTest(id, quick) {
  const base = PROFILES[id];
  if (!base) throw new Error('Prueba desconocida');
  const profile = structuredClone(base);
  if (quick) Object.assign(profile.plan, profile.quick);
  const t = active();
  const seed = t.seed();
  if (!seed) throw new Error('Faltan los datos de prueba: prepara el entorno primero');

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const file = `${stamp}_${t.env}_${id}${quick ? '-rapida' : ''}.ndjson`;
  testCtl = new AbortController();
  state.busy = 'test';
  state.test = { id, name: profile.name, quick, file, startedAt: Date.now(), progress: null };
  testRecs = [];
  pushState();
  send({ kind: 'test-begin' });
  const out = createWriteStream(join(RAW, file));
  const write = (rec) => {
    const line = JSON.stringify(rec);
    out.write(line + '\n');
    testRecs.push(line);
    send({ kind: 'rec', rec });
  };
  // Un hilo generador por núcleo disponible (menos uno para el hilo principal): 1.000 usuarios reciben ~70.000 mensajes/s.
  const workers = CORES ? Math.max(1, Math.min(8, CORES.gen.length - 1)) : 2;

  (async () => {
    try {
      log(`▸ ${profile.name}${quick ? ' (rápida)' : ''} en ${t.env}`);
      log('Reiniciando el servidor para empezar con la memoria limpia…');
      await t.restart();
      const outcome = await runTest(
        {
          profile,
          env: t.env,
          target: t.serverUrl,
          agentUrl: t.agentUrl,
          token: t.token,
          seed,
          workers,
          signal: testCtl.signal,
          onProgress: (p) => {
            state.test.progress = p;
            pushState();
          },
        },
        write,
      );
      log(`Terminó: ${outcome.passed}/${outcome.steps} pasan`);
    } catch (err) {
      log(`ERROR en la prueba: ${err.message}`);
    } finally {
      out.end();
      state.busy = null;
      state.test = null;
      testCtl = null;
      pushState();
      send({ kind: 'runs-changed' });
    }
  })();
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const MAX_UPLOAD = 64 * 2 ** 20;
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const body = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => {
    try {
      r(JSON.parse(s || '{}'));
    } catch {
      r({});
    }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  // API que usa un PC remoto cuando este lab corre en la nube con --target-only.
  if (p.startsWith('/api/target/')) {
    if (req.headers['x-token'] !== token) return json(res, 401, { error: 'token incorrecto' });
    if (p === '/api/target/status') return json(res, 200, { ready: state.ready, error: state.error, label: MODES[state.mode]?.label, status: await local.status() });
    if (p === '/api/target/seed') return json(res, 200, local.seed());
    if (p === '/api/target/restart' && req.method === 'POST') {
      await local.restartServer();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'no existe' });
  }
  if (targetOnly) return json(res, 404, { error: 'este laboratorio corre en modo --target-only' });

  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(`data: ${JSON.stringify({ kind: 'state', state })}\n\n`);
    res.write(`data: ${JSON.stringify({ kind: 'logs', lines: logLines })}\n\n`);
    if (state.test) {
      res.write(`data: ${JSON.stringify({ kind: 'test-begin' })}\n\n`);
      for (const line of testRecs) res.write(`data: {"kind":"rec","rec":${line}}\n\n`);
    }
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/config') {
    return json(res, 200, {
      modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])),
      tests: Object.values(PROFILES).map((t) => ({ id: t.id, name: t.name, question: t.question, normal: duration(t, false), quick: duration(t, true) })),
    });
  }
  if (p === '/api/prepare' && req.method === 'POST') {
    if (state.busy) return json(res, 409, { error: 'Hay una tarea en curso' });
    const b = await body(req);
    if (b.mode === 'remote' && (!b.host || !b.token)) return json(res, 400, { error: 'Falta la IP y el token del remoto' });
    if (b.mode !== 'remote' && !MODES[b.mode]) return json(res, 400, { error: 'Modo desconocido' });
    const workers = Math.min(16, Math.max(1, Math.floor(Number(b.workers)) || 1));
    prepare(b.mode, b.mode === 'remote' ? { host: b.host.trim(), token: b.token.trim() } : null, workers);
    return json(res, 202, { ok: true });
  }
  if (p === '/api/reset' && req.method === 'POST') {
    if (state.busy) return json(res, 409, { error: 'Hay una tarea en curso' });
    if (!state.mode || state.mode === 'remote') return json(res, 400, { error: 'Solo para entornos locales' });
    const mode = state.mode;
    state.busy = 'reset';
    pushState();
    local
      .resetData()
      .catch((err) => log(`ERROR: ${err.message}`))
      .finally(() => {
        state.busy = null;
        prepare(mode);
      });
    return json(res, 202, { ok: true });
  }
  if (p === '/api/test' && req.method === 'POST') {
    if (state.busy) return json(res, 409, { error: 'Hay una tarea en curso' });
    if (!state.ready) return json(res, 400, { error: 'Prepara el entorno primero' });
    const b = await body(req);
    try {
      await startTest(b.id, !!b.quick);
      return json(res, 202, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  if (p === '/api/stop' && req.method === 'POST') {
    testCtl?.abort();
    log('Deteniendo la prueba…');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/runs') {
    const runs = readdirSync(RAW)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => {
        const st = statSync(join(RAW, f));
        let outcome = null;
        try {
          const last = JSON.parse(readFileSync(join(RAW, f), 'utf8').trim().split('\n').at(-1));
          if (last.t === 'end') outcome = last.outcome;
        } catch {}
        return { file: f, bytes: st.size, mtime: st.mtimeMs, outcome };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return json(res, 200, { runs });
  }
  if (p.startsWith('/api/runs/')) {
    const file = join(RAW, basename(p));
    if (!existsSync(file)) return json(res, 404, { error: 'no existe' });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    return createReadStream(file).pipe(res);
  }
  if (p === '/api/antes-despues') return json(res, 200, await loadBeforeAfter());
  if (p === '/api/comparar') return json(res, 200, { runs: await loadRuns() });
  if (p === '/api/comparar/aws' && req.method === 'POST') {
    // Este tipo obliga al navegador a preguntar antes: otra página abierta no puede escribir aquí.
    if (req.headers['content-type'] !== 'application/x-ndjson') return json(res, 415, { error: 'Se espera un archivo .ndjson' });
    let text = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      text += chunk;
      if (text.length > MAX_UPLOAD) return json(res, 413, { error: 'El archivo es demasiado grande' });
    }
    try {
      return json(res, 201, saveAws(text, url.searchParams.get('test'), url.searchParams.get('env')));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  if (p.startsWith('/api/comparar/aws/') && req.method === 'DELETE') {
    try {
      removeAws(basename(p), url.searchParams.get('env'));
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  const file = resolve(here, 'ui', '.' + (p === '/' ? '/index.html' : p));
  if (!file.startsWith(resolve(here, 'ui')) || !existsSync(file) || statSync(file).isDirectory()) return json(res, 404, { error: 'no existe' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) =>
  handle(req, res).catch((err) => {
    log(`ERROR: ${err.message}`);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }),
);
const host = targetOnly ? '0.0.0.0' : '127.0.0.1';
let retried = 0;
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE' && retried++ < 2) {
    await freePort(Number(args.port), log).catch((e) => log(e.message));
    server.listen(Number(args.port), host);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});
server.listen(Number(args.port), host, async () => {
  if (targetOnly) {
    writeFileSync(join(DATA, 'token.txt'), token + '\n');
    log(`Laboratorio remoto en :${args.port}. Token: ${token}  (guardado en data/token.txt)`);
    log('El generador debe alcanzar los puertos 3000, 7070 y 7071 de esta máquina (mismo security group).');
    await prepare(args.mode, null, Math.max(1, Math.floor(Number(args.workers)) || 1));
    if (state.ready) log(`Listo. En el PC elige "Nube", pon esta IP y el token ${token}`);
  } else {
    log(`Laboratorio listo: http://localhost:${args.port}/`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    testCtl?.abort();
    await local.shutdown();
    process.exit(0);
  });
}
