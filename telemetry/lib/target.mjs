// Prepara la máquina objetivo: Mongo (Docker), servidor (nativo o contenedor), agente y datos de prueba.
// Si un puerto está ocupado, cierra lo que lo ocupa y reintenta.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSeed, restoreBase, seedIsValid } from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
import { ROOT, SERVER } from './paths.mjs';
export { ROOT, SERVER };
export const DATA = join(ROOT, 'data');
const ENVS = join(ROOT, 'envs');
const LOG = join(ENVS, 'logs/server.log');
const COMPOSE = ['compose', '-f', join(ENVS, 'compose.yml')];
const COMPOSE_C = [...COMPOSE, '-f', join(ENVS, 'compose.container.yml')];
const MONGO_CONTAINER = 'shareboard-carga-mongo-1';
const SERVER_CONTAINER = 'shareboard-carga-server-1';
export const SEED_USERS = 1500; // las sesiones ya emitidas se reparten en rotación entre las salas
export const SERVER_PORT = Number(process.env.LAB_SERVER_PORT ?? 3000);
export const AGENT_PORT = 7071;

export const MODES = {
  native: { label: 'PC (nativo)', env: 'pc' },
  docker1: { label: 'Contenedor 1 CPU · 512 MB', env: 'docker-1cpu', cpus: 1, mem: '512m' },
  docker2: { label: 'Contenedor 2 CPU · 512 MB', env: 'docker-2cpu', cpus: 2, mem: '512m' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeBin = dirname(process.execPath);

// ---------- reparto de núcleos ----------
// Agrupa los núcleos por frecuencia máxima: los más rápidos para el servidor, los siguientes
// para el generador y los más lentos para el agente. En máquinas uniformes se parte por mitades.
export function coreLayout() {
  const n = cpus().length;
  const freq = (i) => {
    try {
      return Number(readFileSync(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`));
    } catch {
      return 0;
    }
  };
  const groups = new Map();
  for (let i = 0; i < n; i++) groups.set(freq(i), [...(groups.get(freq(i)) ?? []), i]);
  const g = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
  if (g.length >= 3) return { server: g[0], gen: g[1], agent: g.slice(2).flat() };
  if (g.length === 2 && g[1].length > 1) return { server: g[0], gen: g[1].slice(0, -1), agent: g[1].slice(-1) };
  if (n >= 8) {
    const all = [...Array(n).keys()];
    return { server: all.slice(0, n / 2), gen: all.slice(n / 2, -1), agent: all.slice(-1) };
  }
  return null; // pocas CPU (p. ej. EC2 de 2 vCPU): sin fijar núcleos
}
export const CORES = coreLayout();
const list = (a) => a.join(',');

// ---------- utilidades de procesos ----------
function run(cmd, args, { cwd, env, log }) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, env: env ?? { ...process.env, PATH: `${nodeBin}:${process.env.PATH}` } });
    let tail = '';
    const onData = (d) => {
      const text = d.toString();
      tail = (tail + text).slice(-2000);
      for (const line of text.split('\n')) if (line.trim()) log?.(`  ${line.trim().slice(0, 160)}`);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} terminó con código ${code}: ${tail.split('\n').filter(Boolean).at(-1) ?? ''}`))));
  });
}

// sh con el máximo de archivos abiertos permitido: cada usuario virtual es un socket.
const withLimits = (argv) => ['sh', ['-c', 'ulimit -n $(ulimit -Hn) 2>/dev/null; exec "$@"', 'sh', ...argv]];

/** Libera un puerto: detiene el contenedor o el proceso que lo usa y reintenta. */
export async function freePort(port, log, keepContainer = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = spawnSync('ss', ['-ltnpH', `sport = :${port}`]).stdout?.toString() ?? '';
    if (!out.trim()) return;
    const containers = (spawnSync('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']).stdout?.toString() ?? '').split('\n').filter(Boolean);
    if (keepContainer && containers.includes(keepContainer)) return;
    const pids = [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))].filter((p) => p !== process.pid);
    if (containers.length) {
      log(`Puerto ${port} ocupado por el contenedor ${containers.join(', ')}: lo detengo`);
      spawnSync('docker', ['stop', ...containers]);
    } else if (pids.length) {
      log(`Puerto ${port} ocupado por el proceso ${pids.join(', ')}: lo cierro`);
      for (const pid of pids) {
        try {
          process.kill(pid, attempt < 2 ? 'SIGTERM' : 'SIGKILL');
        } catch {}
      }
    } else {
      throw new Error(`El puerto ${port} lo usa un proceso de otro usuario (probablemente root). Ciérralo con: sudo fuser -k ${port}/tcp`);
    }
    await sleep(1500);
  }
  throw new Error(`No se pudo liberar el puerto ${port}`);
}

async function waitFor(what, fn, seconds, log) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`${what} no respondió en ${seconds} s`);
}

const health = async (base) => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json())).db === true;

// ---------- el objetivo local ----------
export function localTarget({ token, log, bind = '127.0.0.1' }) {
  let mode = null;
  let workers = 1;
  let serverChild = null;
  let agentChild = null;
  let seed = null;
  const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;

  const composeEnv = () => ({
    ...process.env,
    MONGO_CPUSET: CORES ? list(CORES.server) : `0-${cpus().length - 1}`,
    SERVER_CPUSET: CORES ? list(CORES.server) : `0-${cpus().length - 1}`,
    SERVER_CPUS: String(MODES[mode]?.cpus ?? 1),
    SERVER_MEM: MODES[mode]?.mem ?? '512m',
    SERVER_WORKERS: String(workers),
    SERVER_DIR: SERVER,
    SERVER_PORT: String(SERVER_PORT),
  });

  async function build() {
    if (!existsSync(join(SERVER, 'node_modules/fastify'))) {
      log('Instalando dependencias del servidor (npm ci)…');
      await run(join(nodeBin, 'npm'), ['ci'], { cwd: SERVER, log });
    }
    const dist = join(SERVER, 'dist/index.js');
    const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
    if (!existsSync(dist) || newest(join(SERVER, 'src')) > statSync(dist).mtimeMs) {
      log('Compilando el servidor (npm run build)…');
      await run(join(nodeBin, 'npm'), ['run', 'build'], { cwd: SERVER, log });
    }
  }

  async function mongo() {
    await freePort(27017, log, MONGO_CONTAINER);
    log(mode === 'native' ? 'Levantando MongoDB (Docker, sin límites)…' : 'Levantando MongoDB (Docker, 1 CPU · 1 GB)…');
    await run('docker', [...(mode === 'native' ? COMPOSE : COMPOSE_C), 'up', '-d', 'mongo'], { env: composeEnv(), log });
    const { MongoClient } = createRequire(join(SERVER, 'package.json'))('mongodb');
    await waitFor('MongoDB', async () => {
      const c = new MongoClient('mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 1500 });
      try {
        await c.connect();
        return (await c.db('admin').command({ ping: 1 })).ok === 1;
      } finally {
        await c.close().catch(() => {});
      }
    }, 60);
    log('MongoDB listo');
  }

  function freshLog() {
    mkdirSync(dirname(LOG), { recursive: true });
    writeFileSync(LOG, '');
  }

  async function stopNative() {
    if (!serverChild) return;
    const child = serverChild;
    serverChild = null;
    child.kill('SIGTERM');
    // Con WORKERS, el primario espera a que cada proceso guarde sus tableros.
    for (let i = 0; i < 200 && child.exitCode == null && child.signalCode == null; i++) await sleep(100);
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }

  async function startServer() {
    freshLog();
    if (mode === 'native') {
      await stopNative();
      await freePort(SERVER_PORT, log);
      const fd = openSync(LOG, 'a');
      const argv = [...(CORES ? ['taskset', '-c', list(CORES.server)] : []), process.execPath, 'dist/index.js'];
      const [cmd, args] = withLimits(argv);
      serverChild = spawn(cmd, args, {
        cwd: SERVER,
        stdio: ['ignore', fd, fd],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'production',
          PORT: String(SERVER_PORT),
          MONGO_URL: 'mongodb://127.0.0.1:27017',
          MONGO_DB: 'shareboard_carga',
          TOKEN_SECRET: 'carga-local',
          REGISTER_PER_HOUR: '1000000',
          LOGIN_PER_MINUTE: '1000000',
          CREATE_BOARD_PER_HOUR: '1000000',
          PIN_PER_MINUTE: '1000000',
          WORKERS: String(workers),
          ...(process.env.BROADCAST_FLUSH_MS ? { BROADCAST_FLUSH_MS: process.env.BROADCAST_FLUSH_MS } : {}),
          ...(process.env.WRITE_DELAY_MS ? { WRITE_DELAY_MS: process.env.WRITE_DELAY_MS } : {}),
        },
      });
      closeSync(fd);
      const child = serverChild;
      child.on('exit', (code, sig) => {
        if (serverChild === child) {
          serverChild = null;
          log(`El servidor se detuvo (${sig ?? `código ${code}`}). Revisa analitics/envs/logs/server.log`);
        }
      });
    } else {
      await stopNative();
      await freePort(SERVER_PORT, log, SERVER_CONTAINER);
      await run('docker', [...COMPOSE_C, 'up', '-d', '--build', '--force-recreate', 'server'], { env: composeEnv(), log });
    }
    await waitFor('El servidor', () => health(serverUrl), 60);
    log(`Servidor listo en :${SERVER_PORT}`);
  }

  async function startAgent() {
    if (agentChild) {
      agentChild.kill('SIGTERM');
      agentChild = null;
      await sleep(500);
    }
    await freePort(AGENT_PORT, log);
    let out = join(DATA, 'agent');
    mkdirSync(out, { recursive: true });
    try {
      accessSync(out, constants.W_OK);
    } catch {
      out = join(DATA, 'agent-local'); // data/agent quedó de root por una corrida con sudo
      mkdirSync(out, { recursive: true });
    }
    const argv = [...(CORES ? ['taskset', '-c', list(CORES.agent)] : []), 'nice', '-n', '19', process.execPath, join(here, '../agent.mjs'), '--token', token, '--log', LOG, '--out', out, '--port', String(AGENT_PORT), '--host', bind];
    agentChild = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
    agentChild.stderr.on('data', (d) => log(`agente: ${d.toString().trim().slice(0, 200)}`));
    await waitFor('El agente', async () => (await fetch(`http://127.0.0.1:${AGENT_PORT}/info?token=${token}`)).ok, 15);
    log('Agente listo (1 muestra por segundo)');
  }

  async function ensureSeed() {
    const file = join(DATA, 'seed-local.json');
    seed = await seedIsValid(serverUrl, file, SEED_USERS);
    if (seed) return log(`Datos de prueba listos (${seed.accounts.length} cuentas)`);
    log('No hay datos de prueba válidos: se crean una sola vez (unos minutos)');
    const flow = JSON.parse(readFileSync(join(here, '../profiles/flujo.json'), 'utf8'));
    seed = await withDb((db) => makeSeed({ target: serverUrl, file, users: SEED_USERS, log, db, flow }));
    log('Datos de prueba listos');
  }

  async function withDb(fn) {
    const { MongoClient } = createRequire(join(SERVER, 'package.json'))('mongodb');
    const client = new MongoClient('mongodb://127.0.0.1:27017');
    try {
      await client.connect();
      return await fn(client.db('shareboard_carga'));
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Cada corrida arranca con los mismos tableros: se apaga el servidor, se restaura la copia base y se enciende.
  async function restartClean() {
    if (mode === 'native') await stopNative();
    else await run('docker', [...COMPOSE_C, 'stop', 'server'], { env: composeEnv(), log });
    if (seed) {
      const n = await withDb((db) => restoreBase(db, seed.baseTs));
      log(`Base restaurada (${n} tableros tocados por la corrida anterior)`);
    }
    await startServer();
  }

  return {
    get mode() {
      return mode;
    },
    serverUrl,
    agentUrl: `http://127.0.0.1:${AGENT_PORT}`,
    get workers() {
      return workers;
    },
    async prepare(m, nWorkers = 1) {
      if (!MODES[m]) throw new Error(`Modo desconocido: ${m}`);
      mode = m;
      workers = nWorkers;
      log(`▸ Preparando: ${MODES[m].label}${workers > 1 ? `, ${workers} procesos de Node` : ''}`);
      if (CORES) log(`Núcleos: servidor ${list(CORES.server)} · generador ${list(CORES.gen)} · agente ${list(CORES.agent)}`);
      await build();
      await mongo();
      await startServer();
      await startAgent();
      // Una vez por base de datos: los modos nativo y contenedor comparten el volumen de Mongo.
      await ensureSeed();
      log('Todo listo');
    },
    restartServer: restartClean,
    seed: () => seed,
    async status() {
      const ok = async (f) => {
        try {
          return await f();
        } catch {
          return false;
        }
      };
      return {
        mode,
        server: await ok(() => health(serverUrl)),
        agent: await ok(async () => (await fetch(`http://127.0.0.1:${AGENT_PORT}/info?token=${token}`, { signal: AbortSignal.timeout(1500) })).ok),
        mongo: await ok(() => health(serverUrl)), // /health responde db:true solo si Mongo contesta
        seed: seed ? seed.accounts.length : 0,
      };
    },
    async resetData() {
      log('Borrando la base de datos de pruebas…');
      if (mode !== 'native') await run('docker', [...COMPOSE_C, 'stop', 'server'], { log }).catch(() => {});
      await stopNative();
      await run('docker', [...COMPOSE_C, 'down', '-v'], { env: composeEnv(), log });
      seed = null;
    },
    async shutdown() {
      await stopNative();
      agentChild?.kill('SIGTERM');
    },
  };
}
