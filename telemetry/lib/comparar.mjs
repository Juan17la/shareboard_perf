// Datos de la página Comparar: resume cada corrida oficial y guarda los resultados de AWS que se añadan.
// Los añadidos quedan junto a las corridas de su modo, donde también los lee tablas.mjs.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { merge, summary } from './hist.mjs';

const RESULTS = fileURLToPath(new URL('../../resultados', import.meta.url));
const CAMPAIGN = join(RESULTS, '2026-11-04');
const ENV_DIRS = {
  pc: join(CAMPAIGN, 'pc'),
  'docker-1cpu': join(CAMPAIGN, 'docker-1cpu'),
  'docker-2cpu': join(CAMPAIGN, 'docker-2cpu'),
  'aws-unlimited': join(RESULTS, '2026-11-05/aws-unlimited'),
  'aws-limited': join(RESULTS, '2026-11-05/aws-limited'),
};
const AWS_ENVS = ['aws-unlimited', 'aws-limited'];
const awsDir = (env) => {
  if (!AWS_ENVS.includes(env)) throw new Error('elige AWS Unlimited o AWS Limited');
  return ENV_DIRS[env];
};
const TEST_USERS = { baja: 100, media: 300, alta: 600, 'capacidad-1000': 1000, 'capacidad-2000': 2000, 'capacidad-3000': 3000, 'server-killer': 6000 };
const MEASURE_SEC = 600;
const BUCKET_SEC = 10;
const REST = ['list', 'join', 'create'];

const parse = (text) => text.trim().split('\n').map((l) => JSON.parse(l));
const avg = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

// Sin proceso servidor en la ventana, los percentiles son conexiones rechazadas: no son latencia.
// Una corrida cortada por memoria también cuenta: el contenedor muere en el segundo siguiente.
// Un OOM de la máquina se lleva también al agente: su silencio final es tiempo caído. Los huecos sueltos no,
// porque con la CPU recortada el agente se atrasa aunque el servidor siga vivo.
export function crashState(step, agents, lastAgentTs = step.end) {
  const silentMs = step.end - lastAgentTs;
  const silentSec = silentMs > 10_000 ? silentMs / 1000 : 0;
  const downPct = ((agents.filter((s) => !s.server).length + silentSec) / step.measuredSec) * 100;
  return { downPct, crashed: downPct > 5 || step.reasons.some((x) => x.startsWith('memoria del contenedor')) };
}

// Un fallo en la ventana puede ser de un intento anterior a ella (agotó los 15 s adentro): nunca más del 100 %.
const capErrors = (byOp) => Object.fromEntries(Object.entries(byOp ?? {}).map(([k, o]) => [k, { ...o, failed: Math.min(o.failed, o.attempts), errorPct: Math.min(o.errorPct, 100) }]));

const busiestNet = (a) => Object.values(a.net?.ifaces ?? {}).reduce((b, d) => (d.txMBs + d.rxMBs > b.txMBs + b.rxMBs ? d : b), { txMBs: 0, rxMBs: 0 });
const diskValues = (a) => Object.values(a.disks ?? {});

// Telemetría de toda la prueba en cubetas de 10 s: alcanza para comparar formas y pesa poco.
function seriesOf(recs, step) {
  const buckets = [];
  const at = (ts) => {
    const i = Math.floor((ts - step.start) / 1000 / BUCKET_SEC);
    return i < 0 || ts > step.end ? null : (buckets[i] ??= { load: [], agent: [] });
  };
  for (const r of recs) {
    if (r.t === 'load') at(r.ts)?.load.push(r);
    else if (r.t === 'agent') at(r.ts)?.agent.push(r.s);
  }
  const latency = (b, ops) => {
    // Con el servidor muerto, la conexión se rechaza en ~1 ms: parecería la mejor latencia de la prueba.
    if (!b.agent.some((a) => a.server)) return null;
    const h = {};
    for (const r of b.load) for (const op of ops) if (r.ops?.[op]?.h) merge(h, r.ops[op].h);
    return summary(h)?.p95 ?? null;
  };
  const rows = Array.from(buckets, (b = { load: [], agent: [] }) => ({
    users: avg(b.load.map((r) => r.users.sockets)),
    errors: avg(b.load.map((r) => r.errors)),
    msgs: avg(b.load.map((r) => r.ws.out)),
    restP95: latency(b, REST),
    pingP95: latency(b, ['ping']),
    fanoutP95: latency(b, ['fanout']),
    js: avg(b.agent.map((a) => a.server?.threads?.main)),
    libuv: avg(b.agent.map((a) => a.server?.threads?.['libuv-worker'])),
    serverCpu: avg(b.agent.map((a) => a.server?.cpu)),
    mongoCpu: avg(b.agent.map((a) => a.mongo?.cpu)),
    rss: avg(b.agent.map((a) => a.server?.rssMB)),
    throttled: avg(b.agent.map((a) => a.cgroup?.throttledMs)),
    steal: avg(b.agent.map((a) => a.cpu?.steal)),
    tx: avg(b.agent.map((a) => busiestNet(a).txMBs)),
    iops: avg(b.agent.map((a) => diskValues(a).reduce((s, d) => s + d.readIops + d.writeIops, 0))),
    util: avg(b.agent.map((a) => Math.max(0, ...diskValues(a).map((d) => d.util ?? 0)))),
  }));
  return Object.fromEntries(Object.keys(rows[0] ?? {}).map((k) => [k, rows.map((r) => round(r[k]))]));
}

export const isUploaded = (file, env) => file.includes(`_${env}_`);

export function summarizeRun(text, env, file) {
  const recs = parse(text);
  const step = recs.find((r) => r.t === 'step');
  if (!step) return null;
  const from = step.end - step.measuredSec * 1000;
  const inWindow = (r) => r.ts >= from && r.ts <= step.end;
  const agentRecs = recs.filter((r) => r.t === 'agent');
  const agents = agentRecs.filter(inWindow).map((r) => r.s);
  const loads = recs.filter((r) => r.t === 'load' && inWindow(r));
  const { downPct, crashed } = crashState(step, agents, agentRecs.at(-1)?.ts);
  const machine = recs.find((r) => r.t === 'machine')?.info;
  const limits = agentRecs.find((r) => r.s.cgroup)?.s.cgroup;
  const lastAlive = agentRecs.findLast((r) => r.s.server);
  return {
    env,
    file,
    uploaded: isUploaded(file, env),
    test: file.match(/_([a-z0-9-]+)\.ndjson$/)?.[1],
    target: step.users,
    pass: step.pass,
    reasons: step.reasons,
    crashed,
    downPct,
    diedAtSec: crashed && lastAlive ? Math.round((lastAlive.ts - step.start) / 1000) : null,
    windowFromSec: (from - step.start) / 1000,
    users: avg(loads.map((r) => r.users.sockets)),
    msgsOut: avg(loads.map((r) => r.ws.out)),
    lat: step.lat,
    srv: step.srv,
    res: step.res,
    byOp: capErrors(step.byOp),
    thresholds: recs.find((r) => r.t === 'meta')?.profile?.thresholds,
    machine: machine && { cpuModel: machine.cpuModel, logicalCpus: machine.logicalCpus, memTotalMB: machine.memTotalMB },
    limits: limits && { cpu: limits.cpuLimit, memMB: limits.memLimitMB },
    series: seriesOf(recs, step),
  };
}

const cache = new Map();
export async function loadRuns(dirs = ENV_DIRS, accept = () => true) {
  const runs = [];
  for (const [env, dir] of Object.entries(dirs)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.ndjson') || !accept(file, env)) continue;
      const path = join(dir, file);
      const { mtimeMs } = statSync(path);
      if (cache.get(path)?.mtimeMs !== mtimeMs) {
        // Una por turno y sin bloquear: el laboratorio puede estar corriendo una prueba.
        cache.set(path, { mtimeMs, run: summarizeRun(await readFile(path, 'utf8'), env, file) });
      }
      const { run } = cache.get(path);
      if (run && TEST_USERS[run.test]) runs.push(run);
    }
  }
  return runs;
}

// Solo entra lo que se puede comparar: misma carga, misma duración y una prueba que terminó.
export function checkUpload(text, expectedTest, env = 'aws-unlimited') {
  let recs;
  try {
    recs = parse(text);
  } catch {
    throw new Error('no es un archivo .ndjson del laboratorio');
  }
  const meta = recs.find((r) => r.t === 'meta');
  const step = recs.find((r) => r.t === 'step');
  const test = meta?.profile?.id;
  if (!meta || !step) throw new Error('la corrida no tiene resultado: no llegó a terminar');
  if (!TEST_USERS[test]) throw new Error(`la prueba «${test}» no está en la comparación`);
  if (expectedTest && test !== expectedTest) throw new Error(`es de la prueba «${test}», no de «${expectedTest}»`);
  if (!recs.some((r) => r.t === 'load' && r.rooms)) throw new Error('es del modelo de carga anterior: no se puede comparar con esta campaña');
  if (step.users !== TEST_USERS[test]) throw new Error(`tiene ${step.users} usuarios y esta prueba usa ${TEST_USERS[test]}`);
  if (meta.profile.plan?.measureSec !== MEASURE_SEC) throw new Error('es una prueba rápida: la comparación usa ventanas de 600 s');
  const stamp = new Date(meta.ts).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return { test, file: `${stamp}_${env}_${test}.ndjson` };
}

export function saveAws(text, expectedTest, env) {
  const dir = awsDir(env);
  const { test, file } = checkUpload(text, expectedTest, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
  return { test, file, env };
}

// Solo lo que se añadió desde la página lleva este nombre: las corridas de la campaña no se pueden borrar desde aquí.
export function removeAws(file, env) {
  const dir = awsDir(env);
  if (!file.match(/^[\w-]+_[a-z0-9-]+\.ndjson$/) || !isUploaded(file, env)) throw new Error('nombre de archivo no válido');
  rmSync(join(dir, file), { force: true });
}

// Página Antes/Después: «antes» son las campañas ya guardadas; «después» la repetición con el servidor mejorado.
// Las locales se leen directo de data/raw (la campaña del 7-nov desde las 09:53, sin el driver de AWS en paralelo); las de AWS se copian a resultados/2026-11-07/
const AFTER_FROM = '20261107-145352';
const RAW = fileURLToPath(new URL('../../data/raw', import.meta.url));
const AFTER_DIR = join(RESULTS, '2026-11-07');
const LOCAL = { pc: 'pc', 'docker-1cpu': 'docker-1cpu', 'docker-2cpu': 'docker-2cpu' };
export async function loadBeforeAfter() {
  const before = await loadRuns();
  const local = await loadRuns(Object.fromEntries(Object.keys(LOCAL).map((e) => [e, RAW])), (f, env) => f.includes(`_${env}_`) && f >= AFTER_FROM);
  const aws = await loadRuns(Object.fromEntries(AWS_ENVS.map((e) => [e, join(AFTER_DIR, e)])));
  // Comparación justa: «después» lleva tantas repeticiones como «antes» (las primeras). Sin esto el PC sumaba
  // corridas de la fase de docker1 que en realidad corrieron otra vez en el PC (campana.mjs ya no lo permite).
  const seen = new Map();
  const after = [...local, ...aws].sort((x, y) => x.file.localeCompare(y.file)).filter((r) => {
    const k = `${r.env}|${r.test}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n <= before.filter((b) => b.env === r.env && b.test === r.test).length;
  });
  return { before, after };
}
