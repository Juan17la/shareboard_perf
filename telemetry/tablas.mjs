#!/usr/bin/env node
// Tablas de docs/MEDICIONES.md a partir de las corridas crudas (resultados/<entorno>/*.ndjson).
// Cada número sale de la ventana medida (los 600 s después de la llegada y la estabilización),
// o de lo que alcanzó a medir la prueba si el laboratorio la cortó.
//
// Uso: node telemetry/tablas.mjs [carpeta de resultados] > tablas.md
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? new URL('../resultados', import.meta.url).pathname);
const ENVS = [['pc', 'PC nativo'], ['docker-1cpu', 'Contenedor 1 CPU'], ['docker-2cpu', 'Contenedor 2 CPU'], ['aws', 'AWS t3.small']];
const TESTS = [['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta'], ['server-killer', 'Server killer']];

const f = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const pm = (o, d = 0) => (o ? `${f(o.avg, d)} / ${f(o.max, d)}` : '–');
const ms = (v) => f(v, v < 10 ? 1 : 0);
const pct = (o) => (o ? `${ms(o.p50)} / ${ms(o.p95)} / ${ms(o.p99)}` : '–');

function load(env, test) {
  let files = [];
  try {
    files = readdirSync(join(dir, env)).filter((x) => x.endsWith(`_${test}.ndjson`)).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const recs = readFileSync(join(dir, env, files.at(-1)), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const step = recs.find((r) => r.t === 'step');
  if (!step) return null;
  const from = step.end - step.measuredSec * 1000;
  const loads = recs.filter((r) => r.t === 'load' && r.ts >= from && r.ts <= step.end);
  const agents = recs.filter((r) => r.t === 'agent' && r.ts >= from && r.ts <= step.end).map((r) => r.s);
  const stat = (fn) => {
    const v = agents.map(fn).filter((x) => typeof x === 'number' && Number.isFinite(x));
    return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) } : null;
  };
  const n = loads.length || 1;
  return {
    file: files.at(-1),
    step,
    users: loads.reduce((t, r) => t + r.users.sockets, 0) / n,
    wsIn: loads.reduce((t, r) => t + r.ws.in, 0) / n,
    libuv: stat((s) => s.server?.threads?.['libuv-worker']),
    mongoCpu: stat((s) => s.mongo?.cpu),
  };
}

const runs = {};
for (const [e] of ENVS) for (const [t] of TESTS) runs[`${e}/${t}`] = load(e, t);
const out = [];
const each = (title, head, row) => {
  out.push(`### ${title}`, '', `| Entorno | Prueba | ${head.join(' | ')} |`, `|---|---|${head.map(() => '---').join('|')}|`);
  for (const [e, en] of ENVS)
    for (const [t, tn] of TESTS) {
      const r = runs[`${e}/${t}`];
      if (r) out.push(`| ${en} | ${tn} | ${row(r).join(' | ')} |`);
    }
  out.push('');
};

each('Resultado', ['Resultado', 'Segundos medidos', 'Usuarios conectados', 'Entradas/s', 'Errores', 'Motivo'], ({ step: s, users }) => [
  s.invalid ? 'no válido' : s.pass ? '✓ pasa' : '✕ no pasa',
  f(s.measuredSec),
  f(users),
  f(s.res.churnIn, 2),
  `${f(s.errorRate, 2)} %`,
  s.reasons.join('; ') || '–',
]);
each('CPU (promedio / pico)', ['Máquina %', 'Núcleo más ocupado %', 'us %', 'sy %', 'wa %', 'id %', 'st %', 'Hilo JS %', 'libuv %', 'Frenado ms/s'], ({ step: { res: x }, libuv }) => [
  pm(x.cpuTotal), pm(x.cpuHottestCore), pm(x.cpuUser, 1), pm(x.cpuSystem, 1), pm(x.iowait, 1), pm(x.cpuIdle), pm(x.steal, 1), pm(x.serverMainThread), pm(libuv), pm(x.throttledMs),
]);
each('Memoria residente (promedio / pico, MB)', ['RES servidor', 'RES mongod'], ({ step: { res: x } }) => [pm(x.serverRssMB), pm(x.mongoRssMB)]);
each('Disco y red (promedio / pico)', ['IOPS', 'MB/s', '%util', 'Red entrada MB/s', 'Red salida MB/s'], ({ step: { res: x } }) => [
  pm(x.diskIops), pm(x.diskMBs, 1), pm(x.diskUtil, 1), pm(x.netRxMBs, 1), pm(x.netTxMBs, 1),
]);
each('Latencia vista por el usuario: p50 / p95 / p99 (ms)', ['REST', 'Login', 'Registro', 'Trazo a los demás', 'Ping WebSocket'], ({ step: s }) => [
  pct(s.lat.rest), pct(s.lat.login), pct(s.lat.register), pct(s.lat.fanout), pct(s.lat.ping),
]);
each('Latencia dentro del servidor (log de Fastify, sin red): p50 / p95 / p99 (ms)', ['REST', 'Login'], ({ step: s }) => [pct(s.srv?.rest), pct(s.srv?.login)]);
out.push('Archivos usados:', '');
for (const [k, r] of Object.entries(runs)) if (r) out.push(`- \`resultados/${k.split('/')[0]}/${r.file}\``);
console.log(out.join('\n'));
