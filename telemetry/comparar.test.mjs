// node --test telemetry/comparar.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkUpload, removeAws, saveAws, summarizeRun } from './lib/comparar.mjs';

const START = 1_000_000;
const step = (over = {}) => ({ t: 'step', users: 600, pass: true, reasons: [], measuredSec: 20, start: START, end: START + 30_000, lat: {}, srv: {}, res: {}, byOp: {}, ...over });
const meta = (over = {}) => ({ t: 'meta', ts: START, profile: { id: 'alta', plan: { measureSec: 600 }, ...over } });
const load = (sec) => ({ t: 'load', ts: START + sec * 1000, users: { sockets: 500 }, errors: 0, rooms: {}, ws: { out: 100 }, ops: { ping: { h: { 50: 1 } } } });
const agent = (sec, up) => ({ t: 'agent', ts: START + sec * 1000, s: { server: up ? { cpu: 10, rssMB: 100, threads: { main: 8 } } : null, mongo: { cpu: 2 } } });
const ndjson = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('una corrida con el servidor vivo no cuenta como caída', () => {
  const run = summarizeRun(ndjson(meta(), load(15), agent(15, true), agent(29, true), step()), 'aws', '20261105-000000_aws_alta.ndjson');
  assert.equal(run.test, 'alta');
  assert.equal(run.crashed, false);
  assert.equal(run.diedAtSec, null);
  assert.equal(run.users, 500);
  assert.equal(run.series.js[1], 8);
});

test('un OOM que se lleva al agente cuenta como caída, y un hueco suelto no', () => {
  const big = { measuredSec: 100, end: START + 110_000 };
  const died = summarizeRun(ndjson(meta(), agent(10, true), agent(50, true), step(big)), 'aws', 'x_aws_alta.ndjson');
  assert.equal(died.crashed, true);
  assert.equal(died.diedAtSec, 50);
  const lagged = summarizeRun(ndjson(meta(), agent(10, true), agent(50, true), agent(109, true), step(big)), 'aws', 'x_aws_alta.ndjson');
  assert.equal(lagged.crashed, false);
});

test('los errores nunca pasan del 100 %', () => {
  const byOp = { list: { attempts: 90, failed: 100, errorPct: 111 } };
  assert.deepEqual(summarizeRun(ndjson(meta(), step({ byOp })), 'aws', 'x_aws_alta.ndjson').byOp.list, { attempts: 90, failed: 90, errorPct: 100 });
});

test('sin servidor en la ventana cuenta como caída y guarda cuándo murió', () => {
  const run = summarizeRun(ndjson(meta(), agent(5, true), agent(15, false), agent(25, false), step({ pass: false })), 'aws', 'x_aws_alta.ndjson');
  assert.equal(run.crashed, true);
  assert.equal(run.diedAtSec, 5);
});

test('un corte por memoria cuenta como caída aunque la ventana parezca viva', () => {
  const run = summarizeRun(ndjson(meta(), agent(15, true), step({ pass: false, reasons: ['memoria del contenedor al 100 %'] })), 'aws', 'x_aws_alta.ndjson');
  assert.equal(run.crashed, true);
});

test('los archivos que no se pueden comparar se rechazan', () => {
  const ok = ndjson(meta(), load(15), step());
  assert.deepEqual(checkUpload(ok, null, 'aws-limited'), { test: 'alta', file: '19700101-001640_aws-limited_alta.ndjson' });
  assert.throws(() => checkUpload('no es json'), /no es un archivo/);
  assert.throws(() => checkUpload(ndjson(meta(), load(15))), /no llegó a terminar/);
  assert.throws(() => checkUpload(ok, 'baja'), /no de «baja»/);
  assert.throws(() => checkUpload(ndjson(meta(), { ...load(15), rooms: undefined }, step())), /modelo de carga anterior/);
  assert.throws(() => checkUpload(ndjson(meta({ plan: { measureSec: 180 } }), load(15), step())), /prueba rápida/);
  assert.throws(() => checkUpload(ndjson(meta(), load(15), step({ users: 250 }))), /250 usuarios/);
});

test('hay que elegir uno de los dos modos de AWS, y las corridas de la campaña no se borran desde la página', () => {
  const ok = ndjson(meta(), load(15), step());
  assert.throws(() => saveAws(ok, null, 'pc'), /Unlimited o AWS Limited/);
  assert.throws(() => saveAws(ok, null, null), /Unlimited o AWS Limited/);
  assert.throws(() => removeAws('20261105-220013_nube-172.31.12.123_baja.ndjson', 'aws-unlimited'), /no válido/);
  assert.throws(() => removeAws('20261105-000000_aws-limited_baja.ndjson', 'aws-unlimited'), /no válido/);
  assert.throws(() => removeAws('../../x_aws-unlimited_baja.ndjson', 'aws-unlimited'), /no válido/);
});

test('una corrida añadida a mano se distingue de las de la campaña', () => {
  const run = (file) => summarizeRun(ndjson(meta(), load(15), agent(29, true), step()), 'aws-limited', file);
  assert.equal(run('x_aws-limited_alta.ndjson').uploaded, true);
  assert.equal(run('x_nube-172.31.12.123_alta.ndjson').uploaded, false);
});
