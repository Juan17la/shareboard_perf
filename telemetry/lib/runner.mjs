// Ejecuta una prueba: hilos generadores + escalones + grabación segundo a segundo.
// Todo lo que pasa se entrega a `write(rec)`; lab.mjs lo guarda en data/raw y lo envía a la interfaz.
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { merge, summary, round } from './hist.mjs';
import { buildLayout, describe } from './layout.mjs';
import { SERVER } from './paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms, signal) =>
  new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

/**
 * opts: { profile, env, target, agentUrl, token, seed, workers, signal, onProgress }
 * Devuelve el resultado ({ maxGoodUsers, ... } en la escalera).
 */
export async function runTest(opts, write) {
  const { profile, seed, signal } = opts;
  const plan = profile.plan;
  const thr = profile.thresholds ?? {};
  const slots = buildLayout(profile, seed.accounts.length);
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
  let rampFrom = 0;
  let rampTo = 0;
  let rampStart = 0;
  let rampMs = (plan.rampSec ?? 30) * 1000;
  let stepStart = 0;
  let abortStep = null;
  const loads = [];
  let cpuPrev = process.cpuUsage();
  const setUsers = (n, ramp = plan.rampSec ?? 30) => {
    rampFrom = users;
    rampTo = n;
    rampStart = Date.now();
    rampMs = ramp * 1000;
  };

  const tick = setInterval(() => {
    const k = rampMs ? Math.min(1, (Date.now() - rampStart) / rampMs) : 1;
    users = Math.round(rampFrom + (rampTo - rampFrom) * k);
    for (const w of workers) w.postMessage({ type: 'users', users });

    const parts = [...pending.values()];
    pending.clear();
    const h = {};
    const err = {};
    let http = 0;
    let active = 0;
    let sockets = 0;
    const ws = { out: 0, in: 0, bytesIn: 0, bytesOut: 0, cursorsIn: 0, previewsIn: 0 };
    const states = { watch: 0, cursor: 0, draw: 0, move: 0 };
    const elu = [];
    for (const p of parts) {
      active += p.active;
      sockets += p.sockets;
      elu.push(p.elu);
      http += p.st.http;
      ws.out += p.st.wsOut;
      ws.in += p.st.wsIn;
      ws.bytesIn += p.st.bytesIn;
      ws.bytesOut += p.st.bytesOut;
      ws.cursorsIn += p.st.cursorsIn;
      ws.previewsIn += p.st.previewsIn;
      for (const k in states) states[k] += p.st.states[k];
      for (const [kind, hh] of Object.entries(p.st.h)) merge((h[kind] ??= {}), hh);
      for (const [code, c] of Object.entries(p.st.err)) err[code] = (err[code] ?? 0) + c;
    }
    const ops = {};
    for (const [kind, hh] of Object.entries(h)) ops[kind] = { ...summary(hh), h: hh };
    const cpu = process.cpuUsage(cpuPrev);
    cpuPrev = process.cpuUsage();
    const rec = {
      t: 'load',
      ts: Date.now(),
      users: { target: users, active, sockets },
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

    // Corte de seguridad: solo con datos de ESTE escalón (al menos 15 s), para no arrastrar errores del anterior.
    if (!abortStep) return;
    const last = loads.filter((r) => r.ts >= stepStart).slice(-10);
    if (Date.now() - stepStart < 15_000 || last.length < 10) return;
    const okN = last.reduce((s, r) => s + Object.values(r.ops).reduce((x, o) => x + (o.n ?? 0), 0), 0);
    const errN = last.reduce((s, r) => s + r.errors, 0);
    const cg = lastAgent?.cgroup;
    if (errN > 50 && errN / (okN + errN) > 0.2) abortStep(`errores ${Math.round((errN / (okN + errN)) * 100)} % (${topError(last)})`);
    else if (cg?.memLimitMB && cg.memMB / cg.memLimitMB > 0.95) abortStep(`memoria del contenedor al ${Math.round((cg.memMB / cg.memLimitMB) * 100)} %`);
  }, 1000);

  // ---------- un escalón ----------
  const results = [];
  async function step(n, sec, kind = 'step', o = {}) {
    if (signal?.aborted) return null;
    stepStart = Date.now();
    const warmSec = o.warmSec ?? plan.warmSec ?? 60;
    const layout = describe(slots, n);
    setUsers(n, o.rampSec ?? plan.rampSec ?? 60);
    event('step-start', { users: n, sec, stepKind: kind, layout });
    progress({ step: results.length + 1, users: n, layout, kind, startedAt: stepStart, sec });
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
    Object.assign(s, { start: stepStart, end, layout });
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
    let err = 0;
    let okN = 0;
    for (const r of win) {
      for (const [k, o] of Object.entries(r.ops)) merge((h[k] ??= {}), o.h);
      for (const [c, v] of Object.entries(r.err)) errByCode[c] = (errByCode[c] ?? 0) + v;
      err += r.errors;
      okN += Object.values(r.ops).reduce((x, o) => x + (o.n ?? 0), 0);
    }
    const lat = {};
    for (const [k, hh] of Object.entries(h)) lat[k] = summary(hh);
    lat.rest = summary(['list', 'join', 'create'].reduce((acc, k) => merge(acc, h[k] ?? {}), {}));

    const aw = agents.filter((r) => r.ts >= from && r.ts <= to).map((r) => r.s);
    const srvH = {};
    for (const s of aw) for (const [route, o] of Object.entries(s.srv ?? {})) merge((srvH[route] ??= {}), o.h);
    const srv = {};
    for (const [route, hh] of Object.entries(srvH)) srv[route] = summary(hh);
    const stat = (f) => {
      const v = aw.map(f).filter((x) => typeof x === 'number' && Number.isFinite(x));
      return v.length ? { avg: round(v.reduce((s, x) => s + x, 0) / v.length), max: round(Math.max(...v)) } : null;
    };
    const sumDisk = (s, k) => Object.values(s.disks ?? {}).reduce((x, d) => x + d[k], 0);
    const busiest = (s) => Object.values(s.net?.ifaces ?? {}).reduce((best, d) => (d.txMBs > best.txMBs ? d : best), { txMBs: 0, rxMBs: 0 });
    const res = {
      cpuTotal: stat((s) => s.cpu?.busy),
      cpuHottestCore: stat((s) => Math.max(...(s.cores ?? [0]))),
      iowait: stat((s) => s.cpu?.iowait),
      steal: stat((s) => s.cpu?.steal),
      serverCpu: stat((s) => s.server?.cpu),
      serverMainThread: stat((s) => s.server?.threads?.main),
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
    const genElu = win.length ? round(win.reduce((s, r) => s + Math.max(0, ...r.gen.elu), 0) / win.length, 2) : null;

    const reasons = [];
    const check = (name, v, limit) => {
      if (v != null && limit != null && v > limit) reasons.push(`${name} ${round(v, 0)} ms > ${limit}`);
    };
    check('p95 REST', lat.rest && lat.rest.p95 - baseMs, thr.restP95);
    check('p95 login', lat.login && lat.login.p95 - baseMs, thr.loginP95);
    check('p95 difusión', lat.fanout && lat.fanout.p95 - baseMs, thr.fanoutP95);
    check('p95 preview', lat.preview && lat.preview.p95 - baseMs, thr.previewP95);
    check('p99 ping', lat.ping && lat.ping.p99 - baseMs, thr.pingP99);
    const errorRate = okN + err ? err / (okN + err) : 0;
    if (thr.errorRate != null && errorRate > thr.errorRate) reasons.push(`errores ${round(errorRate * 100, 1)} % (${topError(win)})`);
    if (!okN && n > 0) reasons.push('ninguna operación completada');
    const invalid = genElu != null && genElu > 0.85;
    if (invalid) reasons.push('generador saturado: no válido');
    return { users: n, kind, measuredSec: Math.round((to - from) / 1000), pass: reasons.length === 0, invalid, reasons, lat, srv, errorRate: round(errorRate * 100, 2), errors: errByCode, throughput: win.length ? round(win.reduce((s, r) => s + r.rps, 0) / win.length) : 0, res, genElu };
  }

  // ---------- plan ----------
  let outcome = {};
  try {
    if (plan.mode === 'steps') {
      for (const [i, item] of plan.users.entries()) {
        if (signal?.aborted) break;
        // Un escalón puede traer su propia duración, llegada y calentamiento (p. ej. "Inicio de clase").
        const { users: n, ...o } = typeof item === 'number' ? { users: item } : item;
        // restSec: todos salen entre escalones; cada escalón arranca "en frío".
        if (i > 0 && plan.restSec) {
          setUsers(0, 5);
          event('rest', { sec: plan.restSec });
          progress({ rest: true, sec: plan.restSec, startedAt: Date.now() });
          await sleep(plan.restSec * 1000, signal);
        }
        await step(n, o.sec ?? plan.stepSec ?? 360, 'step', o);
      }
      outcome = { passed: results.filter((s) => s.pass).length, steps: results.length };
    } else {
      let u = plan.start ?? 20;
      let good = 0;
      let bad = null;
      while (u <= (plan.max ?? 3000) && !signal?.aborted) {
        const s = await step(u, plan.stepSec ?? 360);
        if (!s) break;
        if (s.pass) {
          good = u;
          u = Math.ceil(u * (plan.factor ?? 1.5));
        } else {
          bad = u;
          break;
        }
      }
      for (let r = 0; bad && r < (plan.refine ?? 3) && (bad - good) / bad > 0.1 && !signal?.aborted; r++) {
        const mid = Math.round((good + bad) / 2);
        if (mid === good || mid === bad) break;
        // Baja (o sube) directo al punto medio: los que sobran salen, como en la vida real.
        const s = await step(mid, plan.refineStepSec ?? plan.stepSec ?? 360, 'refine');
        if (!s) break;
        if (s.pass) good = mid;
        else bad = mid;
      }
      let confirm = null;
      if (good > 0 && plan.confirmSec && !signal?.aborted) {
        setUsers(0, 5);
        await sleep(20_000, signal);
        confirm = await step(Math.max(1, Math.floor(good * (plan.confirmPct ?? 0.8))), plan.confirmSec, 'confirm');
      }
      outcome = { maxGoodUsers: good, firstBadUsers: bad, confirmUsers: confirm?.users ?? null, confirmPass: confirm?.pass ?? null };
    }
  } finally {
    setUsers(0, 2);
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
