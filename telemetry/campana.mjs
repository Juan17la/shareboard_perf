#!/usr/bin/env node
// Corre las pruebas oficiales una tras otra usando la API del laboratorio (que debe estar abierto en :7070).
//
//   node telemetry/campana.mjs                                   # PC, contenedor 1 CPU y 2 CPU
//   node telemetry/campana.mjs --envs docker2                    # solo un entorno
//   node telemetry/campana.mjs --remote <ip privada> <token>     # desde el generador en EC2
//
// Entre entornos borra y vuelve a crear los datos de prueba (todos comparten el volumen de MongoDB),
// y entre pruebas espera 60 s para que baje la temperatura.
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    envs: { type: 'string', default: 'native,docker1,docker2' },
    tests: { type: 'string', default: 'baja,media,alta,server-killer' },
    workers: { type: 'string', default: '1' }, // procesos de Node del servidor (en EC2 se fija al preparar el servidor)
    reps: { type: 'string', default: '1' }, // repeticiones por prueba: 3 para separar diferencias reales de ruido
    remote: { type: 'boolean', default: false },
    lab: { type: 'string', default: 'http://localhost:7070/' },
  },
});
const TESTS = args.tests.split(',');
const ENVS = args.remote ? ['remote'] : args.envs.split(',');
const [host, token] = positionals;
if (args.remote && (!host || !token)) {
  console.error('Uso: node telemetry/campana.mjs --remote <ip privada del servidor> <token>');
  process.exit(1);
}

let st = {};
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(args.lab + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const idle = async () => {
  await sleep(3000);
  while (st.busy) await sleep(2000);
};

// Estado del laboratorio por su canal de eventos.
(async () => {
  const res = await fetch(args.lab + 'api/events');
  let buf = '';
  for await (const c of res.body.pipeThrough(new TextDecoderStream())) {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i).replace(/^data: /, ''));
      buf = buf.slice(i + 2);
      if (m.kind === 'state') st = m.state;
      else if (m.kind === 'log' && /Terminó|ERROR en la prueba|▸ .* en /.test(m.line)) log(`  ${m.line.slice(10)}`);
    }
  }
})().catch((err) => {
  console.error(`No hay laboratorio en ${args.lab} (${err.message}). Ábrelo con: node telemetry/lab.mjs`);
  process.exit(1);
});
await sleep(1500);

for (const [i, env] of ENVS.entries()) {
  if (env === 'remote') {
    // El servidor remoto crea sus datos al arrancar; se reintenta hasta que esté listo.
    for (let k = 0; !st.ready && k < 120; k++) {
      await post('api/prepare', { mode: 'remote', host, token });
      await idle();
      if (!st.ready) await sleep(30_000);
    }
  } else {
    if (i > 0) {
      log(`Reiniciando datos antes de ${env}`);
      await post('api/reset');
      await idle();
    }
    log(`Preparando ${env}`);
    // Con otra tarea en curso (un reset lanzado desde fuera) el lab responde 409 y seguiría en el entorno
    // anterior: así, el 7-nov, las pruebas de docker1 corrieron otra vez en el PC y las de docker2 en docker1.
    let r = await post('api/prepare', { mode: env, workers: Number(args.workers) });
    if (r.error) {
      await idle();
      r = await post('api/prepare', { mode: env, workers: Number(args.workers) });
    }
    if (r.error) {
      log(`${env} no se pudo preparar: ${r.error}`);
      continue;
    }
    await idle();
  }
  if (!st.ready) {
    log(`${env} no quedó listo: ${st.error ?? 'sin detalle'}`);
    continue;
  }
  for (let rep = 0; rep < Number(args.reps); rep++) {
    for (const t of TESTS) {
      const r = await post('api/test', { id: t });
      if (r.error) {
        log(`${env} / ${t}: ${r.error}`);
        continue;
      }
      await idle();
      await sleep(60_000);
    }
  }
}
log('Campaña terminada. Resultados en data/raw/ y en la pestaña Resultados.');
process.exit(0);
