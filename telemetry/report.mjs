#!/usr/bin/env node
// Convierte corridas (data/raw/*.ndjson) en tablas Markdown con las métricas que pide el enunciado:
// CPU promedio y pico (núcleo más ocupado y columnas us/sy/wa/id de top), memoria residente, disco (IOPS, MB/s y %util de iostat),
// red (entrada y salida) y latencia p50/p95/p99, escalón por escalón.
//
// Uso: node analitics/telemetry/report.mjs data/raw/A.ndjson data/raw/B.ndjson > RESULTADOS.md
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const f = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
const pm = (o, d = 1) => (o ? `${f(o.avg, d)} / ${f(o.max, d)}` : '–');
const lat = (o) => (o ? `${f(o.p50)} / ${f(o.p95)} / ${f(o.p99)}` : '–');

const runs = process.argv.slice(2).map((file) => {
  const recs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return {
    file: basename(file),
    meta: recs.find((r) => r.t === 'meta'),
    machine: recs.find((r) => r.t === 'machine')?.info,
    steps: recs.filter((r) => r.t === 'step'),
  };
});
if (!runs.length) {
  console.error('Uso: node report.mjs <corrida.ndjson> [otra.ndjson ...]');
  process.exit(1);
}

const out = [];
for (const r of runs) {
  const m = r.machine;
  out.push(`## ${r.meta?.profile?.name ?? r.file} · ${r.meta?.env}`, '');
  out.push(`Archivo \`${r.file}\` · ${m ? `${m.cpuModel} · ${m.logicalCpus} hilos · ${f(m.memTotalMB / 1024, 0)} GB` : ''} · RTT base ${f(r.meta?.baseRttMs, 2)} ms`, '');

  out.push('### Rendimiento', '');
  out.push('| Usuarios | Tableros | Resultado | REST p50 / p95 / p99 (ms) | Trazo a otros p95 (ms) | Preview p95 (ms) | Login p95 (ms) | Ping p99 (ms) | Errores | Motivo |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of r.steps) {
    out.push(`| ${s.users} | ${s.layout?.boards ?? '–'} | ${s.invalid ? 'no válido' : s.pass ? '✓ pasa' : '✕ no pasa'} | ${lat(s.lat.rest)} | ${f(s.lat.fanout?.p95)} | ${f(s.lat.preview?.p95)} | ${f(s.lat.login?.p95)} | ${f(s.lat.ping?.p99)} | ${f(s.errorRate, 2)} % | ${s.reasons.join('; ') || '–'} |`);
  }
  out.push('');

  out.push('### Recursos (promedio / pico)', '');
  out.push('| Usuarios | Llegadas/s | CPU máquina % | Núcleo más ocupado % | us % | sy % | wa % | id % | Hilo JS % | Servidor total % de un núcleo | RES servidor MB | RES mongod MB | Disco IOPS | Disco MB/s | Disco %util | Red entrada MB/s | Red salida MB/s | Contenedor frenado ms/s |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of r.steps) {
    const x = s.res;
    out.push(`| ${s.users} | ${f(s.arrivalPerSec, 2)} | ${pm(x.cpuTotal)} | ${pm(x.cpuHottestCore, 0)} | ${pm(x.cpuUser)} | ${pm(x.cpuSystem)} | ${pm(x.iowait)} | ${pm(x.cpuIdle)} | ${pm(x.serverMainThread, 0)} | ${pm(x.serverCpu, 0)} | ${pm(x.serverRssMB, 0)} | ${pm(x.mongoRssMB, 0)} | ${pm(x.diskIops, 0)} | ${pm(x.diskMBs, 2)} | ${pm(x.diskUtil)} | ${pm(x.netRxMBs, 1)} | ${pm(x.netTxMBs, 1)} | ${pm(x.throttledMs, 0)} |`);
  }
  out.push('');

  out.push('### Latencia dentro del servidor (log de Fastify, sin red), p50 / p95 / p99 ms', '');
  out.push('| Usuarios | Listar | Unirse | Login |');
  out.push('|---|---|---|---|');
  for (const s of r.steps) out.push(`| ${s.users} | ${lat(s.srv?.list)} | ${lat(s.srv?.join)} | ${lat(s.srv?.login)} |`);
  out.push('');
}
console.log(out.join('\n'));
