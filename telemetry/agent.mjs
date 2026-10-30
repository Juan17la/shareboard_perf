#!/usr/bin/env node
// Agente de telemetría. Corre en la máquina del servidor, NO dentro del servidor:
// solo lee archivos del kernel (/proc, /sys, cgroups), la cola del log de Fastify y
// serverStatus de Mongo. No modifica ni instrumenta Shareboard.
//
// Cada segundo produce una muestra JSON que:
//   1. se agrega a un NDJSON local (respaldo, por si se cae la conexión con el controlador)
//   2. se envía por SSE a quien esté conectado en GET /stream (el controlador run.mjs)
//
// Uso: sudo node agent.mjs --token SECRETO [--port 7071] [--log ruta/server.log]
//        [--server node:dist/index.js] [--mongo mongod:] [--mongo-url mongodb://127.0.0.1:27017]
//        [--out ../data/agent]
// sudo es opcional: sin él no se leen la energía (RAPL) ni el disco por proceso de Mongo.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, readlinkSync, existsSync, mkdirSync, openSync, readSync, fstatSync, closeSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname, cpus, totalmem, release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { add as histAdd, summary } from './lib/hist.mjs';
import { SERVER } from './lib/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7071' },
    host: { type: 'string', default: '0.0.0.0' },
    token: { type: 'string' },
    log: { type: 'string' },
    server: { type: 'string', default: 'node:dist/index.js' },
    mongo: { type: 'string', default: 'mongod:' },
    'mongo-url': { type: 'string', default: 'mongodb://127.0.0.1:27017' },
    out: { type: 'string', default: resolve(here, '../data/agent') },
  },
});
if (!args.token) {
  console.error('Falta --token (el controlador debe enviar el mismo).');
  process.exit(1);
}

const HZ = 100; // USER_HZ de Linux: /proc mide CPU en "jiffies" de 10 ms
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const num = (p) => {
  const v = read(p);
  return v == null ? null : Number(v.trim());
};
const r1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);

// ---------- Información fija de la máquina (va en la cabecera de la corrida) ----------
function machineInfo() {
  const os = /PRETTY_NAME="([^"]+)"/.exec(read('/etc/os-release') ?? '')?.[1] ?? null;
  const disks = blockDevices().map((d) => ({
    name: d,
    model: read(`/sys/block/${d}/device/model`)?.trim() ?? null,
    rotational: num(`/sys/block/${d}/queue/rotational`) === 1,
    sizeGB: r1(((num(`/sys/block/${d}/size`) ?? 0) * 512) / 1e9),
  }));
  const topo = cpus().map((_, i) => ({
    cpu: i,
    core: num(`/sys/devices/system/cpu/cpu${i}/topology/core_id`),
    maxMHz: r1((num(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`) ?? 0) / 1000),
  }));
  return {
    hostname: hostname(),
    os,
    kernel: release(),
    cpuModel: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    topology: topo,
    memTotalMB: Math.round(totalmem() / 2 ** 20),
    disks,
    node: process.version,
    // En EC2 este archivo dice el tipo de instancia sin necesidad de red.
    dmi: read('/sys/devices/virtual/dmi/id/product_name')?.trim() ?? null,
  };
}

function blockDevices() {
  try {
    return readdirSync('/sys/block').filter((d) => !/^(loop|ram|zram|sr|fd)/.test(d));
  } catch {
    return [];
  }
}

// ---------- Búsqueda de procesos ----------
// "comm:texto" = nombre del ejecutable y un texto que debe aparecer en la línea de comando.
function findPid(spec) {
  const [comm, text = ''] = spec.split(':');
  const found = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    // Nombre del ejecutable (Node 24 renombra su hilo principal a "MainThread", así que comm no sirve).
    let exe;
    try {
      exe = basename(readlinkSync(`/proc/${d}/exe`));
    } catch {
      exe = read(`/proc/${d}/comm`)?.trim(); // procesos de otro usuario (p. ej. mongod en Docker)
    }
    if (exe !== comm) continue;
    const cmd = read(`/proc/${d}/cmdline`)?.replaceAll('\0', ' ') ?? '';
    if (cmd.includes(text)) found.push(Number(d));
  }
  // Si hay varios (p. ej. un "sh -c" no cuenta porque su comm es sh), el más antiguo.
  return found.sort((a, b) => a - b)[0] ?? null;
}

// ---------- Lectores con estado (las tasas se calculan contra la lectura anterior) ----------
let prev = null;

function readStat() {
  const text = read('/proc/stat');
  const cores = [];
  let total = null;
  let running = 0;
  let blocked = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('cpu')) {
      const [name, ...v] = line.split(/\s+/);
      const [user, nice, system, idle, iowait, irq, softirq, steal] = v.map(Number);
      const row = { user: user + nice, system: system + irq + softirq, idle, iowait, steal };
      if (name === 'cpu') total = row;
      else cores.push(row);
    } else if (line.startsWith('procs_running')) running = Number(line.split(' ')[1]);
    else if (line.startsWith('procs_blocked')) blocked = Number(line.split(' ')[1]);
  }
  return { total, cores, running, blocked };
}

function cpuPct(a, b) {
  const sum = (r) => r.user + r.system + r.idle + r.iowait + r.steal;
  const dt = sum(b) - sum(a) || 1;
  const p = (k) => r1(((b[k] - a[k]) / dt) * 100);
  return { busy: r1(100 - ((b.idle - a.idle + b.iowait - a.iowait) / dt) * 100), user: p('user'), system: p('system'), iowait: p('iowait'), steal: p('steal') };
}

function readProc(pid, perThread = true) {
  if (!pid) return null;
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return null;
  // El nombre va entre paréntesis y puede tener espacios: se corta después del último ")".
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const status = read(`/proc/${pid}/status`) ?? '';
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
  const io = read(`/proc/${pid}/io`);
  const ioNum = (k) => (io ? Number(new RegExp(`${k}: (\\d+)`).exec(io)?.[1] ?? 0) : null);
  let fds = null;
  try {
    fds = readdirSync(`/proc/${pid}/fd`).length;
  } catch {}
  // CPU por hilo, agrupada por nombre: separa el hilo principal de JavaScript
  // del threadpool de libuv (scrypt, DNS, archivos) y de los hilos de V8 (GC, JIT).
  const threads = {};
  if (perThread) try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const ts = read(`/proc/${pid}/task/${tid}/stat`);
      if (!ts) continue;
      const tf = ts.slice(ts.lastIndexOf(')') + 2).split(' ');
      const name = Number(tid) === pid ? 'main' : ts.slice(ts.indexOf('(') + 1, ts.lastIndexOf(')'));
      // (libuv llama a sus hilos "libuv-worker"; V8 usa varios nombres según la versión)
      threads[name] = (threads[name] ?? 0) + Number(tf[11]) + Number(tf[12]);
    }
  } catch {}
  return {
    pid,
    ticks: Number(f[11]) + Number(f[12]),
    threads,
    nThreads: kb('Threads'),
    rssMB: r1(kb('VmRSS') / 1024),
    readBytes: ioNum('read_bytes'),
    writeBytes: ioNum('write_bytes'),
    fds,
    cgroup: read(`/proc/${pid}/cgroup`)?.match(/^0::(.*)$/m)?.[1] ?? null,
  };
}

function procRates(a, b, dt) {
  if (!b) return null;
  const same = a && a.pid === b.pid;
  const rate = (k) => (same && b[k] != null && a[k] != null ? r1((b[k] - a[k]) / dt) : null);
  const threads = {};
  for (const [k, v] of Object.entries(b.threads)) {
    if (same && a.threads[k] != null) threads[k] = r1((((v - a.threads[k]) / HZ) / dt) * 100);
  }
  return {
    pid: b.pid,
    cpu: same ? r1((((b.ticks - a.ticks) / HZ) / dt) * 100) : null, // 100 = un núcleo completo
    threads,
    nThreads: b.nThreads,
    rssMB: b.rssMB,
    diskReadKBs: rate('readBytes') == null ? null : r1(rate('readBytes') / 1024),
    diskWriteKBs: rate('writeBytes') == null ? null : r1(rate('writeBytes') / 1024),
    fds: b.fds,
  };
}

// cgroup v2 del proceso: en Docker aquí están los límites de CPU y memoria del contenedor.
function readCgroup(path) {
  if (!path) return null;
  const base = join('/sys/fs/cgroup', path);
  const cpuStat = read(`${base}/cpu.stat`);
  if (!cpuStat) return null;
  const k = (t, key) => Number(new RegExp(`^${key} (\\d+)`, 'm').exec(t)?.[1] ?? 0);
  const memMax = read(`${base}/memory.max`)?.trim();
  const cpuMax = read(`${base}/cpu.max`)?.trim().split(' ');
  // Sin límites (proceso nativo dentro de la sesión del usuario) el cgroup no dice nada útil.
  if ((!memMax || memMax === 'max') && (!cpuMax || cpuMax[0] === 'max')) return null;
  return {
    usageUsec: k(cpuStat, 'usage_usec'),
    throttledUsec: k(cpuStat, 'throttled_usec'),
    nrThrottled: k(cpuStat, 'nr_throttled'),
    cpuLimit: cpuMax && cpuMax[0] !== 'max' ? Number(cpuMax[0]) / Number(cpuMax[1]) : null,
    memMB: r1((num(`${base}/memory.current`) ?? 0) / 2 ** 20),
    memLimitMB: memMax && memMax !== 'max' ? r1(Number(memMax) / 2 ** 20) : null,
    oomKills: k(read(`${base}/memory.events`) ?? '', 'oom_kill'),
  };
}

function cgroupRates(a, b, dt) {
  if (!b) return null;
  const d = (k) => (a ? b[k] - a[k] : 0);
  return {
    cpu: a ? r1((d('usageUsec') / 1e6 / dt) * 100) : null,
    throttledMs: a ? r1(d('throttledUsec') / 1000 / dt) : null, // ms por segundo en que el kernel lo frenó
    throttledPeriods: a ? d('nrThrottled') : null,
    cpuLimit: b.cpuLimit,
    memMB: b.memMB,
    memLimitMB: b.memLimitMB,
    oomKills: b.oomKills,
  };
}

function readDisks() {
  const devs = new Set(blockDevices());
  const out = {};
  for (const line of (read('/proc/diskstats') ?? '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (!devs.has(f[2])) continue;
    out[f[2]] = { r: +f[3], rs: +f[5], rt: +f[6], w: +f[7], ws: +f[9], wt: +f[10], busy: +f[12] };
  }
  return out;
}

function diskRates(a, b, dt) {
  const out = {};
  for (const [dev, v] of Object.entries(b)) {
    const p = a?.[dev];
    if (!p) continue;
    const ios = v.r - p.r + (v.w - p.w);
    out[dev] = {
      readIops: r1((v.r - p.r) / dt),
      writeIops: r1((v.w - p.w) / dt),
      readMBs: r1(((v.rs - p.rs) * 512) / 2 ** 20 / dt),
      writeMBs: r1(((v.ws - p.ws) * 512) / 2 ** 20 / dt),
      util: r1(((v.busy - p.busy) / (dt * 1000)) * 100), // % del tiempo con E/S en curso
      awaitMs: ios ? r1((v.rt - p.rt + (v.wt - p.wt)) / ios) : 0,
    };
  }
  return out;
}

function readNet() {
  const out = {};
  for (const line of (read('/proc/net/dev') ?? '').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    out[name.trim()] = { rx: f[0], rxp: f[1], tx: f[8], txp: f[9] };
  }
  const snmp = (read('/proc/net/snmp') ?? '').split('\n').filter((l) => l.startsWith('Tcp:'));
  const tcp = {};
  if (snmp.length === 2) {
    const keys = snmp[0].split(/\s+/);
    const vals = snmp[1].split(/\s+/);
    keys.forEach((k, i) => (tcp[k] = Number(vals[i])));
  }
  return { ifaces: out, retrans: tcp.RetransSegs ?? 0, outSegs: tcp.OutSegs ?? 0, estab: tcp.CurrEstab ?? 0 };
}

function netRates(a, b, dt) {
  const ifaces = {};
  for (const [name, v] of Object.entries(b.ifaces)) {
    const p = a?.ifaces[name];
    if (!p) continue;
    // Las interfaces veth de Docker cambian con cada contenedor: se agrupan.
    const key = name.startsWith('veth') ? 'veth*' : name;
    const cur = (ifaces[key] ??= { rxMBs: 0, txMBs: 0, rxPps: 0, txPps: 0 });
    cur.rxMBs = r1(cur.rxMBs + (v.rx - p.rx) / 2 ** 20 / dt);
    cur.txMBs = r1(cur.txMBs + (v.tx - p.tx) / 2 ** 20 / dt);
    cur.rxPps = Math.round(cur.rxPps + (v.rxp - p.rxp) / dt);
    cur.txPps = Math.round(cur.txPps + (v.txp - p.txp) / dt);
  }
  return {
    ifaces,
    retransPs: a ? r1((b.retrans - a.retrans) / dt) : null,
    tcpEstab: b.estab,
  };
}

function readMem() {
  const t = read('/proc/meminfo') ?? '';
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t)?.[1] ?? 0) / 1024;
  return {
    totalMB: Math.round(kb('MemTotal')),
    availableMB: Math.round(kb('MemAvailable')),
    cachedMB: Math.round(kb('Cached')),
    dirtyMB: r1(kb('Dirty')),
    swapUsedMB: Math.round(kb('SwapTotal') - kb('SwapFree')),
  };
}

function readFreqMHz() {
  const out = [];
  for (let i = 0; i < cpus().length; i++) {
    const v = num(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
    out.push(v == null ? null : Math.round(v / 1000));
  }
  return out;
}

const thermalZone = (() => {
  try {
    const zones = readdirSync('/sys/class/thermal').filter((z) => z.startsWith('thermal_zone'));
    return zones.find((z) => read(`/sys/class/thermal/${z}/type`)?.trim() === 'x86_pkg_temp') ?? zones[0] ?? null;
  } catch {
    return null;
  }
})();

const RAPL = '/sys/class/powercap/intel-rapl:0';
const raplMax = num(`${RAPL}/max_energy_range_uj`);

// ---------- Log de Fastify: latencia medida por el propio servidor (sin la red) ----------
// Fastify escribe dos líneas por petición: "incoming request" (método y URL) y
// "request completed" (status y responseTime). Se emparejan por reqId.
// Se usan expresiones regulares en lugar de JSON.parse para gastar menos CPU.
const reIn = /"reqId":"([^"]+)".*?"method":"(\w+)","url":"([^"?]+)/;
const reOut = /"reqId":"([^"]+)".*?"statusCode":(\d+).*?"responseTime":([\d.]+)/;
function routeOf(method, url) {
  if (url === '/auth/login') return 'login';
  if (url === '/auth/register') return 'register';
  if (url === '/me/boards') return 'list';
  if (method === 'POST' && url === '/boards') return 'create';
  if (/^\/boards\/[^/]+\/join$/.test(url)) return 'join';
  if (url === '/ws') return null; // el WebSocket queda abierto: su "duración" no es latencia
  if (url === '/health') return 'health';
  return 'other';
}
let logFd = null;
let logPos = 0;
let logRest = '';
const pending = new Map();
let srvHist = {};
let srvErrors = 0;

function tailLog() {
  if (!args.log) return;
  try {
    if (logFd == null) {
      logFd = openSync(args.log, 'r');
      logPos = fstatSync(logFd).size; // empieza en el final: solo cuenta lo nuevo
    }
    const size = fstatSync(logFd).size;
    if (size < logPos) logPos = 0; // el archivo se truncó (servidor reiniciado)
    if (size === logPos) return;
    const len = Math.min(size - logPos, 32 * 2 ** 20);
    const buf = Buffer.alloc(len);
    readSync(logFd, buf, 0, len, logPos);
    logPos += len;
    const lines = (logRest + buf.toString('utf8')).split('\n');
    logRest = lines.pop();
    for (const line of lines) {
      if (line.includes('"incoming request"')) {
        const m = reIn.exec(line);
        if (m) pending.set(m[1], routeOf(m[2], m[3]));
      } else if (line.includes('"responseTime"')) {
        const m = reOut.exec(line);
        if (!m) continue;
        const route = pending.get(m[1]);
        pending.delete(m[1]);
        if (!route) continue;
        histAdd((srvHist[route] ??= {}), Number(m[3]));
        if (Number(m[2]) >= 500) srvErrors++;
      }
    }
    if (pending.size > 100_000) pending.clear();
  } catch (err) {
    if (logFd != null) closeSync(logFd);
    logFd = null;
    if (err.code !== 'ENOENT') console.error('log:', err.message);
  }
}

// ---------- Mongo (opcional: usa el driver instalado en server/node_modules) ----------
let mongo = null;
let mongoPrev = null;
async function connectMongo() {
  const pkg = resolve(SERVER, 'package.json');
  if (!existsSync(pkg)) return;
  try {
    const { MongoClient } = createRequire(pkg)('mongodb');
    mongo = new MongoClient(args['mongo-url'], { maxPoolSize: 1, serverSelectionTimeoutMS: 2000 });
    await mongo.connect();
  } catch (err) {
    console.error('Mongo no disponible para métricas:', err.message);
    mongo = null;
  }
}
async function readMongo(dt) {
  if (!mongo) return null;
  try {
    const s = await mongo.db('admin').command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 });
    const ops = s.opcounters;
    const cache = s.wiredTiger?.cache ?? {};
    const out = { connections: s.connections?.current ?? null, cacheMB: r1((cache['bytes currently in the cache'] ?? 0) / 2 ** 20), dirtyMB: r1((cache['tracked dirty bytes in the cache'] ?? 0) / 2 ** 20), ops: null };
    if (mongoPrev) {
      out.ops = {};
      for (const k of ['insert', 'query', 'update', 'delete', 'getmore', 'command']) out.ops[k] = r1((ops[k] - mongoPrev[k]) / dt);
    }
    mongoPrev = { ...ops };
    return out;
  } catch {
    return null;
  }
}

// ---------- Bucle de muestreo ----------
let serverPid = null;
let mongoPid = null;
let lastFind = 0;
const subscribers = new Set();
mkdirSync(args.out, { recursive: true });
const backup = join(args.out, `agent-${hostname()}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const info = machineInfo();
appendFileSync(backup, JSON.stringify({ t: 'agent-info', ts: Date.now(), info }) + '\n');
let selfPrev = process.cpuUsage();

async function sample() {
  const now = Date.now();
  if (now - lastFind > 5000 || !serverPid || !existsSync(`/proc/${serverPid}`)) {
    serverPid = findPid(args.server);
    mongoPid = findPid(args.mongo);
    lastFind = now;
  }
  const cur = {
    at: now,
    stat: readStat(),
    server: readProc(serverPid),
    mongo: readProc(mongoPid, false),
    disks: readDisks(),
    net: readNet(),
    energy: num(`${RAPL}/energy_uj`),
  };
  cur.cg = readCgroup(cur.server?.cgroup);
  cur.mcg = readCgroup(cur.mongo?.cgroup);
  tailLog();

  if (!prev) {
    prev = cur;
    return null;
  }
  const dt = (cur.at - prev.at) / 1000;
  let energyW = null;
  if (cur.energy != null && prev.energy != null) {
    let d = cur.energy - prev.energy;
    if (d < 0 && raplMax) d += raplMax; // el contador da la vuelta
    energyW = r1(d / 1e6 / dt);
  }
  const srv = {};
  for (const [route, h] of Object.entries(srvHist)) srv[route] = { ...summary(h), h };
  const self = process.cpuUsage(selfPrev);
  selfPrev = process.cpuUsage();

  const s = {
    cpu: cpuPct(prev.stat.total, cur.stat.total),
    cores: cur.stat.cores.map((c, i) => cpuPct(prev.stat.cores[i], c).busy),
    coresIowait: cur.stat.cores.map((c, i) => cpuPct(prev.stat.cores[i], c).iowait),
    run: { running: cur.stat.running, blocked: cur.stat.blocked, load1: Number((read('/proc/loadavg') ?? '0').split(' ')[0]) },
    mem: readMem(),
    server: procRates(prev.server, cur.server, dt),
    mongo: procRates(prev.mongo, cur.mongo, dt),
    cgroup: cgroupRates(prev.cg, cur.cg, dt),
    mongoCgroup: cgroupRates(prev.mcg, cur.mcg, dt),
    disks: diskRates(prev.disks, cur.disks, dt),
    net: netRates(prev.net, cur.net, dt),
    freqMHz: readFreqMHz(),
    tempC: thermalZone ? r1((num(`/sys/class/thermal/${thermalZone}/temp`) ?? 0) / 1000) : null,
    powerW: energyW,
    srv, // latencia según el log del servidor, por ruta, de este segundo
    srvErrors,
    db: await readMongo(dt),
    agent: { cpu: r1(((self.user + self.system) / 1e6 / dt) * 100), rssMB: r1(process.memoryUsage.rss() / 2 ** 20) },
  };
  srvHist = {};
  srvErrors = 0;
  prev = cur;
  return s;
}

await connectMongo();
// setTimeout encadenado (no setInterval): si una muestra tarda, no se acumulan.
async function loop() {
  const started = Date.now();
  try {
    const s = await sample();
    if (s) {
      const rec = { t: 'agent', ats: started, s };
      const line = JSON.stringify(rec);
      appendFileSync(backup, line + '\n');
      for (const res of subscribers) res.write(`data: ${line}\n\n`);
    }
  } catch (err) {
    console.error('muestra:', err.message);
  }
  setTimeout(loop, Math.max(0, 1000 - (Date.now() - started)));
}
loop();

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== args.token) {
    res.writeHead(401).end('token');
    return;
  }
  if (url.pathname === '/info') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ info, serverPid, mongoPid, log: args.log ?? null, backup }));
  } else if (url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(`data: ${JSON.stringify({ t: 'agent-info', ts: Date.now(), info })}\n\n`);
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
  } else res.writeHead(404).end();
}).listen(Number(args.port), args.host, () => {
  console.log(`Agente en :${args.port}. Servidor pid=${findPid(args.server) ?? 'no encontrado'}, mongod pid=${findPid(args.mongo) ?? 'no encontrado'}`);
  console.log(`Respaldo local: ${backup}`);
});
