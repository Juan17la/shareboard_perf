// Ejecuta una prueba: hilos generadores + escalones + grabación segundo a segundo.
// Todo lo que pasa se entrega a `write(rec)`; lab.mjs lo guarda en data/raw y lo envía a la interfaz.
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { merge, summary, round } from './hist.mjs';
import { SERVER } from './paths.mjs';
import { createScheduler } from './rooms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ARRIVE_SEC = 120;
const sleep = (ms, signal) =>
  new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

// Muestra mínima para juzgar un percentil: con 30 muestras, el p95 es el segundo peor valor (ruido, no medida).
const MIN_N = { p50: 20, p95: 100, p99: 1000 };

/**
 * opts: { profile, env, target, agentUrl, token, seed, workers, signal, onProgress }
 * Devuelve cuántos escalones pasaron.
 */
export async function runTest(opts, write) {
  const { profile, seed, signal } = opts;
  const plan = profile.plan;
  const thr = profile.thresholds ?? {};
  const t0 = Date.now();
  const event = (kind, extra = {}) => write({ t: 'event', ts: Date.now(), kind, ...extra });
  const progress = (p) => opts.onProgress?.(p);

  // RTT base: latencia sin carga, para restarla en los criterios (en la nube incluye internet).
  const rtts = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    try {
      await fetch(opts.target + '/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.text());
      rtts.push(performance.now() - s);
    } catch {}
  }
  if (!rtts.length) throw new Error(`El servidor no responde en ${opts.target}`);
  rtts.sort((x, y) => x - y);
  const baseMs = round(rtts[Math.floor(rtts.length / 2)]);

  write({
    t: 'meta',
    ts: t0,
    env: opts.env,
    target: opts.target,
    profile,
    workers: opts.workers,
    seed: { users: seed.accounts.length, boards: seed.boards.length },
    baseRttMs: baseMs,
    loadMachine: { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version },
  });

  // ---------- agente ----------
  let done = false;
  let lastAgent = null;
  const agents = [];
  const agentCtl = new AbortController();
  if (opts.agentUrl) connectAgent();
  async function connectAgent() {
    let sentInfo = false;
    while (!done) {
      try {
        const res = await fetch(`${opts.agentUrl}/stream?token=${encodeURIComponent(opts.token)}`, { signal: agentCtl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        event('agent-connected');
        let buf = '';
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const rec = JSON.parse(buf.slice(0, i).replace(/^data: /, ''));
            buf = buf.slice(i + 2);
            if (rec.t === 'agent-info') {
              if (!sentInfo) write({ t: 'machine', ts: Date.now(), info: rec.info });
              sentInfo = true;
            } else {
              rec.ts = Date.now(); // eje de tiempo común: el reloj de la máquina de carga
              lastAgent = rec.s;
              agents.push(rec);
              write(rec);
            }
          }
        }
      } catch (err) {
        if (done) break;
        event('agent-lost', { error: err.message });
        await sleep(2000);
      }
    }
  }

  // ---------- hilos generadores ----------
  const W = opts.workers;
  const workers = [];
  const pending = new Map();
  for (let w = 0; w < W; w++) {
    const worker = new Worker(join(here, '../vu-worker.mjs'), {
      workerData: {
        workerId: w,
        workers: W,
        target: opts.target,
        profile,
        accounts: seed.accounts,
        boards: seed.boards,
        password: seed.password,
        serverPkg: resolve(SERVER, 'package.json'),
      },
    });
    worker.on('message', (m) => pending.set(m.workerId, m));
    worker.on('error', (err) => event('worker-error', { error: err.message }));
    workers.push(worker);
  }

  // ---------- reloj de 1 s ----------
  let users = 0;
  let scheduler = null;
  let stepStart = 0;
  let abortStep = null;
  const loads = [];
  let cpuPrev = process.cpuUsage();

  const tick = setInterval(() => {
    scheduler?.tick(Date.now(), users);

    const parts = [...pending.values()];
    pending.clear();
    const h = {};
    const err = {};
    const att = {};
    const journeys = {};
    let entered = 0;
    let gaveUp = 0;
    let reconnects = 0;
    let http = 0;
    let active = 0;
    let sockets = 0;
    let left = 0;
    const ws = { out: 0, in: 0, bytesIn: 0, bytesOut: 0, cursorsIn: 0, previewsIn: 0 };
    const states = {};
    const elu = [];
    for (const p of parts) {
      active += p.active;
      sockets += p.sockets;
      left += p.st.left;
      entered += p.st.entered;
      gaveUp += p.st.gaveUp;
      reconnects += p.st.reconnects;
      for (const [k, v] of Object.entries(p.st.att)) att[k] = (att[k] ?? 0) + v;
      for (const [k, v] of Object.entries(p.st.journeys)) journeys[k] = (journeys[k] ?? 0) + v;
      elu.push(p.elu);
      http += p.st.http;
      ws.out += p.st.wsOut;
      ws.in += p.st.wsIn;
      ws.bytesIn += p.st.bytesIn;
      ws.bytesOut += p.st.bytesOut;
      ws.cursorsIn += p.st.cursorsIn;
      ws.previewsIn += p.st.previewsIn;
      for (const [k, v] of Object.entries(p.st.states)) states[k] = (states[k] ?? 0) + v;
      for (const [kind, hh] of Object.entries(p.st.h)) merge((h[kind] ??= {}), hh);
      for (const [code, c] of Object.entries(p.st.err)) err[code] = (err[code] ?? 0) + c;
    }
    const ops = {};
    for (const [kind, hh] of Object.entries(h)) ops[kind] = { ...summary(hh), h: hh };
    // REST junto (listar, unirse, crear; el login va aparte, como en el resumen del escalón).
    const restH = ['list', 'join', 'create'].reduce((acc, k) => merge(acc, h[k] ?? {}), {});
    const rest = summary(restH);
    if (rest) ops.rest = rest;
    const cpu = process.cpuUsage(cpuPrev);
    cpuPrev = process.cpuUsage();
    const rec = {
      t: 'load',
      ts: Date.now(),
      users: { target: users, active, sockets },
      // Rotación: entradas = usuarios que llegaron al tablero en este segundo, salidas = sesiones terminadas.
      churn: { in: entered, out: left },
      gaveUp,
      reconnects,
      journeys,
      rooms: scheduler?.stats().byType,
      att,
      states,
      rps: http,
      ops,
      err,
      errors: Object.values(err).reduce((s, v) => s + v, 0),
      ws,
      gen: { cpu: round(((cpu.user + cpu.system) / 1e6) * 100), elu, rssMB: round(process.memoryUsage.rss() / 2 ** 20) },
    };
    write(rec);
    loads.push(rec);

    // Corte de seguridad: un contenedor por matar por memoria ya no mide nada. Los errores no cortan la prueba:
    // aunque falle, debe durar lo mismo y mostrar cómo se comporta el servidor saturado.
    const cg = lastAgent?.cgroup;
    if (abortStep && Date.now() - stepStart > 15_000 && cg?.memLimitMB && cg.memMB / cg.memLimitMB > 0.95) abortStep(`memoria del contenedor al ${Math.round((cg.memMB / cg.memLimitMB) * 100)} %`);
  }, 1000);

  // ---------- un escalón ----------
  const results = [];
  async function step(n, sec, kind = 'step', o = {}) {
    if (signal?.aborted) return null;
    stepStart = Date.now();
    // Con measureSec: llegada en ARRIVE_SEC (igual en todas las pruebas, así todas duran lo mismo),
    // 30 s de estabilización y measureSec medidos.
    const measureSec = o.measureSec ?? plan.measureSec;
    const rampSec = o.rampSec ?? (measureSec ? ARRIVE_SEC : plan.rampSec ?? 60);
    const warmSec = o.warmSec ?? (measureSec ? Math.ceil(rampSec) + 30 : plan.warmSec ?? 60);
    if (measureSec) sec = warmSec + measureSec;
    users = n;
    scheduler = createScheduler({
      flow: profile.flow,
      boards: seed.boards,
      accounts: seed.accounts.length,
      rampEndAt: stepStart + rampSec * 1000,
      send: (member) => workers[member.i % W].postMessage({ type: 'member', member }),
    });
    event('step-start', { users: n, sec, stepKind: kind });
    progress({ step: results.length + 1, users: n, kind, startedAt: stepStart, sec });
    const cut = await new Promise((res) => {
      const t = setTimeout(() => res(null), sec * 1000);
      const stop = () => (clearTimeout(t), res('detenida por el usuario'));
      signal?.addEventListener('abort', stop, { once: true });
      abortStep = (why) => (clearTimeout(t), signal?.removeEventListener('abort', stop), res(why));
    });
    abortStep = null;
    const end = Date.now();
    // Si se cortó antes de terminar el calentamiento, se resume lo que hubo.
    const from = end - stepStart > warmSec * 1000 + 10_000 ? stepStart + warmSec * 1000 : stepStart;
    const s = summarize(n, kind, from, end);
    Object.assign(s, { start: stepStart, end, measureFrom: from });
    if (cut) {
      s.pass = false;
      s.aborted = true;
      s.reasons.unshift(cut);
    }
    write({ t: 'step', ts: end, ...s });
    results.push(s);
    return s;
  }

  function summarize(n, kind, from, to) {
    const win = loads.filter((r) => r.ts >= from && r.ts <= to);
    const h = {};
    const errByCode = {};
    const attempts = {};
    const journeys = {};
    let err = 0;
    for (const r of win) {
      for (const [k, o] of Object.entries(r.ops)) if (o.h) merge((h[k] ??= {}), o.h);
      for (const [c, v] of Object.entries(r.err)) errByCode[c] = (errByCode[c] ?? 0) + v;
      for (const [k, v] of Object.entries(r.att ?? {})) attempts[k] = (attempts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.journeys ?? {})) journeys[k] = (journeys[k] ?? 0) + v;
      err += r.errors;
    }
    const lat = {};
    for (const [k, hh] of Object.entries(h)) lat[k] = summary(hh);
    lat.rest = summary(['list', 'join', 'create'].reduce((acc, k) => merge(acc, h[k] ?? {}), {}));
    lat.auth = summary(['login', 'register'].reduce((acc, k) => merge(acc, h[k] ?? {}), {}));

    // Errores por operación: cada endpoint contra sus propios intentos. Nada de diluirlos entre mensajes de WebSocket.
    const secs = Math.max(1, Math.round((to - from) / 1000));
    const byOp = {};
    for (const k of ['login', 'register', 'list', 'create', 'join']) {
      const tried = attempts[k] ?? 0;
      const failed = Object.entries(errByCode).filter(([c]) => c.startsWith(`${k}:`)).reduce((t, [, v]) => t + v, 0);
      byOp[k] = { attempts: tried, failed, errorPct: tried ? round((failed / tried) * 100, 2) : 0, perSec: round(tried / secs, 3) };
    }
    const restTried = Object.values(byOp).reduce((t, o) => t + o.attempts, 0);
    const restFailed = Object.values(byOp).reduce((t, o) => t + o.failed, 0);
    const wsErrors = Object.entries(errByCode).filter(([c]) => c.startsWith('ws:')).reduce((t, [, v]) => t + v, 0);
    const entered = win.reduce((t, r) => t + (r.churn?.in ?? 0), 0);
    const gaveUp = win.reduce((t, r) => t + (r.gaveUp ?? 0), 0);

    const aw = agents.filter((r) => r.ts >= from && r.ts <= to).map((r) => r.s);
    const srvH = {};
    for (const s of aw) for (const [route, o] of Object.entries(s.srv ?? {})) merge((srvH[route] ??= {}), o.h);
    const srv = {};
    for (const [route, hh] of Object.entries(srvH)) srv[route] = summary(hh);
    srv.rest = summary(['list', 'join', 'create'].reduce((acc, k) => merge(acc, srvH[k] ?? {}), {}));
    const stat = (f) => {
      const v = aw.map(f).filter((x) => typeof x === 'number' && Number.isFinite(x));
      return v.length ? { avg: round(v.reduce((s, x) => s + x, 0) / v.length), max: round(Math.max(...v)) } : null;
    };
    const sumDisk = (s, k) => Object.values(s.disks ?? {}).reduce((x, d) => x + d[k], 0);
    const busiest = (s) => Object.values(s.net?.ifaces ?? {}).reduce((best, d) => (d.txMBs > best.txMBs ? d : best), { txMBs: 0, rxMBs: 0 });
    const diskUtil = (s) => Math.max(0, ...Object.values(s.disks ?? {}).map((d) => d.util ?? 0));
    const res = {
      cpuTotal: stat((s) => s.cpu?.busy),
      // Columnas de top: us, sy, wa, id (% del total de la máquina).
      cpuUser: stat((s) => s.cpu?.user),
      cpuSystem: stat((s) => s.cpu?.system),
      cpuIdle: stat((s) => s.cpu && 100 - s.cpu.busy - s.cpu.iowait),
      diskUtil: stat(diskUtil),
      churnIn: win.length ? round(win.reduce((t, r) => t + (r.churn?.in ?? 0), 0) / win.length, 2) : null,
      churnOut: win.length ? round(win.reduce((t, r) => t + (r.churn?.out ?? 0), 0) / win.length, 2) : null,
      cpuHottestCore: stat((s) => Math.max(...(s.cores ?? [0]))),
      iowait: stat((s) => s.cpu?.iowait),
      steal: stat((s) => s.cpu?.steal),
      serverCpu: stat((s) => s.server?.cpu),
      serverMainThread: stat((s) => s.server?.threads?.main),
      serverLibuv: stat((s) => s.server?.threads?.['libuv-worker']),
      serverRssMB: stat((s) => s.server?.rssMB),
      mongoCpu: stat((s) => s.mongo?.cpu),
      mongoRssMB: stat((s) => s.mongo?.rssMB),
      diskIops: stat((s) => sumDisk(s, 'readIops') + sumDisk(s, 'writeIops')),
      diskMBs: stat((s) => sumDisk(s, 'readMBs') + sumDisk(s, 'writeMBs')),
      netTxMBs: stat((s) => busiest(s).txMBs),
      netRxMBs: stat((s) => busiest(s).rxMBs),
      throttledMs: stat((s) => s.cgroup?.throttledMs),
      powerW: stat((s) => s.powerW),
      tempC: stat((s) => s.tempC),
    };
    // El hilo generador más ocupado, percentil 95 de sus segundos: el promedio escondía los picos.
    const genSorted = win.map((r) => Math.max(0, ...r.gen.elu)).sort((x, y) => x - y);
    const genElu = genSorted.length ? round(genSorted[Math.floor(genSorted.length * 0.95)], 2) : null;

    const reasons = [];
    const notes = [];
    const check = (name, s, p, limit) => {
      if (!s || limit == null) return;
      if (s.n < MIN_N[p]) return notes.push(`${name}: solo ${s.n} muestras, no se juzga`);
      const v = s[p] - baseMs;
      if (v > limit) reasons.push(`${name} ${round(v, 0)} ms > ${limit}`);
    };
    check('p95 REST', lat.rest, 'p95', thr.restP95);
    check('p95 autenticación', lat.auth, 'p95', thr.loginP95);
    check('p95 difusión', lat.fanout, 'p95', thr.fanoutP95);
    check('p95 preview', lat.preview, 'p95', thr.previewP95);
    check('p99 ping', lat.ping, 'p99', thr.pingP99);
    const errorRate = restTried ? restFailed / restTried : 0;
    if (thr.errorRate != null && errorRate > thr.errorRate) reasons.push(`errores ${round(errorRate * 100, 1)} % (${topError(win)})`);
    if (!restTried && !lat.ping && n > 0) reasons.push('ninguna operación completada');
    const invalid = genElu != null && genElu > 0.85;
    if (invalid) reasons.push('generador saturado: no válido');
    // Con el servidor caído, los percentiles son conexiones rechazadas al instante: no son latencia.
    const serverDownPct = aw.length ? round((aw.filter((s) => !s.server).length / aw.length) * 100, 0) : 0;
    if (serverDownPct > 5) reasons.unshift(`servidor caído ${serverDownPct} % de la ventana`);

    // ¿El trabajo fue constante? Primer tercio de la ventana contra el último.
    const thirds = [0, 1, 2].map((i) => {
      const part = win.slice(Math.floor((win.length * i) / 3), Math.floor((win.length * (i + 1)) / 3));
      const pa = aw.slice(Math.floor((aw.length * i) / 3), Math.floor((aw.length * (i + 1)) / 3));
      const mean = (v) => (v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null);
      const hp = {};
      for (const k of ['list', 'join', 'create']) for (const r of part) if (r.ops[k]?.h) merge(hp, r.ops[k].h);
      const pi = {};
      for (const r of part) if (r.ops.ping?.h) merge(pi, r.ops.ping.h);
      return {
        users: mean(part.map((r) => r.users.sockets)),
        msgsOut: mean(part.map((r) => r.ws.out)),
        restPerSec: mean(part.map((r) => r.rps)),
        js: mean(pa.map((s) => s.server?.threads?.main).filter((x) => x != null)),
        rssMB: mean(pa.map((s) => s.server?.rssMB).filter((x) => x != null)),
        mongoCpu: mean(pa.map((s) => s.mongo?.cpu).filter((x) => x != null)),
        rest: summary(hp),
        ping: summary(pi),
      };
    });
    const drift = (k) => (thirds[0][k] ? round(((thirds[2][k] - thirds[0][k]) / thirds[0][k]) * 100, 1) : null);
    const stability = { thirds, workDriftPct: drift('msgsOut'), usersDriftPct: drift('users') };
    if (Math.abs(stability.usersDriftPct ?? 0) > 10) notes.push(`usuarios variaron ${stability.usersDriftPct} % dentro de la ventana`);

    return { users: n, kind, measuredSec: secs, pass: reasons.length === 0, invalid, reasons, notes, lat, srv, errorRate: round(errorRate * 100, 2), serverDownPct, wsErrors, byOp, journeys, entered, gaveUp, errors: errByCode, stability, throughput: win.length ? round(win.reduce((s, r) => s + r.rps, 0) / win.length) : 0, res, genElu };
  }

  // ---------- plan ----------
  let outcome = {};
  try {
    for (const item of plan.users) {
      if (signal?.aborted) break;
      const { users: n, ...o } = typeof item === 'number' ? { users: item } : item;
      await step(n, o.sec ?? plan.stepSec ?? 360, 'step', o);
    }
    outcome = { passed: results.filter((s) => s.pass).length, steps: results.length };
  } finally {
    users = 0;
    scheduler = null;
    for (const w of workers) w.postMessage({ type: 'stop' });
    await sleep(3000);
    write({ t: 'end', ts: Date.now(), outcome, steps: results.length, stopped: !!signal?.aborted });
    done = true;
    agentCtl.abort();
    clearInterval(tick);
    for (const w of workers) await w.terminate();
  }
  return outcome;
}

function topError(recs) {
  const c = {};
  for (const r of recs) for (const [k, v] of Object.entries(r.err)) c[k] = (c[k] ?? 0) + v;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[0]} x${top[1]}` : 'sin código';
}
