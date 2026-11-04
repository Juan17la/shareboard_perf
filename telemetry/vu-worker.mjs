// Hilo generador de carga. lib/runner.mjs crea varios y lib/rooms.mjs les entrega los usuarios con su horario.
//
// Cada usuario sigue el recorrido del cliente web real (no un bucle fijo):
//   1. Llega por uno de estos caminos:
//        con sesión guardada : lista sus tableros -> elige -> se une
//        invitado con enlace : escribe su nombre -> se une (sin cuenta, con PIN si el tablero lo pide)
//        debe iniciar sesión : escribe -> login -> lista -> elige -> se une
//        cuenta nueva        : llena el formulario -> registro -> se une
//      Quien abre una sala propia a veces crea un tablero nuevo antes de unirse.
//   2. Trabaja: pasa de una actividad a otra según su rol y lo que acaba de hacer (cadena de Markov).
//   3. A veces se le cae la red y reconecta, a veces vuelve a abrir su lista de tableros.
//   4. Sale a su hora. Si el servidor no lo atiende reintenta un par de veces y se rinde (no insiste sin fin).
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';

import { add as histAdd } from './lib/hist.mjs';
import { weightedPick } from './lib/rooms.mjs';

const { workerId, target, profile, accounts, boards, password, serverPkg } = workerData;
const F = profile.flow;

// Node 22 trae WebSocket; en versiones anteriores se usa el paquete ws que ya instaló el servidor.
const WS = globalThis.WebSocket ?? createRequire(serverPkg)('ws');
// Reloj de alta resolución compartido por todos los hilos (Date.now() solo da milisegundos enteros).
const clock = () => performance.timeOrigin + performance.now();

const running = new Map();
// Nombres únicos para los registros: marca de esta corrida + hilo + contador (máx. 24 caracteres).
const tag = Date.now().toString(36);
let newUsers = 0;

// ---------- estadísticas del segundo en curso ----------
let st = fresh();
function fresh() {
  return { h: {}, err: {}, att: {}, left: 0, entered: 0, gaveUp: 0, reconnects: 0, http: 0, wsOut: 0, wsIn: 0, bytesIn: 0, bytesOut: 0, cursorsIn: 0, previewsIn: 0, journeys: {}, states: { watch: 0, cursor: 0, draw: 0, shape: 0, text: 0, move: 0, erase: 0, away: 0 } };
}
const ok = (kind, ms) => histAdd((st.h[kind] ??= {}), ms);
const fail = (kind, code) => {
  const k = `${kind}:${code}`;
  st.err[k] = (st.err[k] ?? 0) + 1;
};

let elu = performance.eventLoopUtilization();
setInterval(() => {
  const now = performance.eventLoopUtilization();
  const e = performance.eventLoopUtilization(now, elu).utilization;
  elu = now;
  let sockets = 0;
  let active = 0;
  for (const v of running.values()) {
    if (v.started) active++;
    if (v.ws?.readyState === 1) sockets++;
    if (v.state) st.states[v.state]++;
  }
  parentPort.postMessage({ type: 'stats', workerId, active, sockets, elu: Math.round(e * 1000) / 1000, st });
  st = fresh();
}, 1000).unref();

parentPort.on('message', (m) => {
  if (m.type === 'member') schedule(m.member);
  else if (m.type === 'stop') for (const v of running.values()) v.stop();
});

// ---------- utilidades ----------
const sleep = (ms, signal) =>
  new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });
// Duraciones exponenciales: así los usuarios nunca se sincronizan.
const expo = (mean, min = 0, max = Infinity) => Math.min(max, Math.max(min, -Math.log(1 - Math.random()) * mean));
const between = ([a, b]) => a + Math.random() * (b - a);
const think = (name, signal) => sleep(between(F.thinkSec[name]) * 1000, signal);

async function http(kind, method, path, body, token) {
  const t0 = performance.now();
  st.http++;
  st.att[kind] = (st.att[kind] ?? 0) + 1;
  try {
    const res = await fetch(target + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status >= 400) {
      let code = `HTTP_${res.status}`;
      try {
        code = JSON.parse(text).error?.code ?? code;
      } catch {}
      fail(kind, code);
      return null;
    }
    ok(kind, performance.now() - t0);
    return text ? JSON.parse(text) : {};
  } catch (err) {
    // La espera de quien no fue atendido también cuenta en los percentiles: si no, la latencia solo describe a los afortunados.
    ok(kind, performance.now() - t0);
    fail(kind, err.name === 'TimeoutError' ? 'TIMEOUT' : (err.cause?.code ?? err.name));
    return null;
  }
}

/** Un paso del recorrido: si falla reintenta unas veces, como una persona que recarga la página. */
async function attempt(signal, fn) {
  for (let i = 0; i <= F.retries && !signal.aborted; i++) {
    const r = await fn();
    if (r) return r;
    if (i < F.retries) await sleep(2000 + Math.random() * 3000, signal);
  }
  return null;
}

// ---------- un usuario virtual ----------
function schedule(m) {
  const ctl = new AbortController();
  const vu = { ws: null, state: null, started: false, stop: () => ctl.abort() };
  running.set(m.i, vu);
  const leave = setTimeout(() => ctl.abort(), Math.max(0, m.leaveAt - Date.now()));
  sleep(Math.max(0, m.arriveAt - Date.now()), ctl.signal)
    .then(() => {
      if (ctl.signal.aborted) return;
      vu.started = true;
      return visit(m, vu, ctl.signal);
    })
    .catch((err) => fail('vu', err.message.slice(0, 40)))
    .finally(() => {
      clearTimeout(leave);
      if (vu.started) st.left++;
      running.delete(m.i);
    });
}

async function visit(m, vu, signal) {
  const acc = m.acc == null ? null : accounts[m.acc];
  const nickname = `vu${m.i}`;
  st.journeys[m.journey] = (st.journeys[m.journey] ?? 0) + 1;
  let token = acc?.token ?? null;
  let userId = acc?.id ?? `g${tag}${workerId}x${m.i}`;

  if (m.journey === 'login') {
    await think('login', signal);
    const auth = await attempt(signal, () => http('login', 'POST', '/auth/login', { login: acc.username, password }));
    if (!auth) return gaveUp(signal);
    [token, userId] = [auth.token, auth.account.id];
  } else if (m.journey === 'register') {
    await think('register', signal);
    const username = `n${tag}${workerId}${(newUsers++).toString(36)}`;
    const auth = await attempt(signal, () => http('register', 'POST', '/auth/register', { username, email: `${username}@carga.test`, password, nickname }));
    if (!auth) return gaveUp(signal);
    [token, userId] = [auth.token, auth.account.id];
  } else if (m.journey === 'guest') {
    await think('name', signal);
  }

  if (m.journey !== 'guest' && m.journey !== 'register') {
    await attempt(signal, () => http('list', 'GET', '/me/boards', null, token));
    await think('pick', signal);
  }
  if (signal.aborted) return;

  let boardId;
  let pin;
  if (m.boardIdx == null) {
    const created = await attempt(signal, () => http('create', 'POST', '/boards', { name: `Reunión ${m.i}`, access: 'public', editPolicy: 'everyone', creatorId: userId }, token));
    if (!created) return gaveUp(signal);
    boardId = created.id;
  } else {
    const b = boards[m.boardIdx];
    boardId = b.id;
    // Un invitado siempre debe dar el PIN; una cuenta miembro del tablero no. Enviarlo no le cuesta nada al que no lo necesita.
    if (b.pin) pin = F.pin;
  }
  const joined = await attempt(signal, () => http('join', 'POST', `/boards/${boardId}/join`, { userId, nickname, ...(pin ? { pin } : {}) }, token));
  if (!joined) return gaveUp(signal);

  await session(m, vu, signal, { token, userId, boardId, nickname, boardToken: joined.boardToken, account: !!token });
}

function gaveUp(signal) {
  if (!signal.aborted) st.gaveUp++;
}

function session(m, vu, signal, s) {
  return new Promise((resolve) => {
    const timers = new Set();
    const mine = []; // elementos propios: quien ya dibujó mucho va borrando lo viejo, y el tablero no crece
    const pos = { x: Math.random() * 1600, y: Math.random() * 900 };
    let ws = null;
    let done = false;
    let joinSentAt = 0;
    let previewSeen = 0;
    let everJoined = false;
    let failures = 0;

    const later = (ms, fn) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!done) fn();
      }, ms);
      timers.add(t);
    };
    // Como el cliente real: mientras reconecta no envía nada hasta que el servidor confirme la entrada.
    let inBoard = false;
    const send = (obj) => {
      if (ws?.readyState !== 1 || (!inBoard && obj.type !== 'join')) return;
      const data = JSON.stringify(obj);
      ws.send(data);
      st.wsOut++;
      st.bytesOut += data.length;
    };
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      signal.removeEventListener('abort', finish);
      vu.ws = null;
      vu.state = null;
      if (ws && ws.readyState <= 1) {
        // El cliente web avisa que se va antes de cerrar.
        send({ type: 'leave', boardId: s.boardId });
        ws.close(1000);
      }
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });

    // El cursor camina como una mano: pasos cortos en una dirección que cambia poco a poco.
    let heading = Math.random() * Math.PI * 2;
    const step = () => {
      heading += (Math.random() - 0.5) * 0.8;
      pos.x = Math.max(0, Math.min(2400, pos.x + Math.cos(heading) * 9));
      pos.y = Math.max(0, Math.min(1400, pos.y + Math.sin(heading) * 9));
      return { x: Math.round(pos.x), y: Math.round(pos.y) };
    };

    // ---------- actividades: la siguiente depende de la actual y del rol ----------
    const roleWeights = F.roles[m.role];
    const pick = (from) => {
      const table = {};
      for (const [k, p] of Object.entries(F.next[from])) table[k] = p * (roleWeights[k] ?? 1);
      return weightedPick(table, Math.random);
    };
    const newId = () => `lt_${s.userId.slice(-6)}_${Math.round(clock())}_${Math.floor(Math.random() * 1e6)}`;
    const base = (t) => ({ id: newId(), createdBy: s.userId, createdAt: t, updatedAt: t, z: 0 });
    // Una adición lleva el elemento y, cuando ya hay suficientes propios, el borrado del más viejo.
    const commit = (el) => {
      const sentAt = clock();
      const ops = [{ t: 'add', el: { ...el, createdAt: sentAt, updatedAt: sentAt } }];
      mine.push(el);
      if (mine.length > F.keepOwnElements) ops.push({ t: 'delete', id: mine.shift().id });
      send({ type: 'op', boardId: s.boardId, ops, seq: 0 });
    };

    function enter(state) {
      vu.state = state;
      const dur = expo(F.meanSec[state] * 1000, 300, F.meanSec[state] * 5000);
      const end = clock() + dur;
      const next = () => enter(pick(state));

      if (state === 'watch' || state === 'away') return later(dur, next);

      if (state === 'cursor') {
        // El puntero se mueve a ratos: el cliente envía a lo sumo cada 45 ms, y nada si la mano está quieta.
        const burst = () => {
          const stop = Math.min(end, clock() + between(F.pointer.moveSec) * 1000);
          const tick = () => {
            const t = clock();
            if (t >= end) return next();
            if (t >= stop) return later(between(F.pointer.pauseSec) * 1000, burst);
            send({ type: 'cursor', boardId: s.boardId, at: step() });
            later(F.cursorMs, tick);
          };
          tick();
        };
        return burst();
      }

      if (state === 'draw') {
        const el = { ...base(clock()), kind: 'stroke', points: [], color: '#1e88e5', width: 3 };
        let lastCursor = 0;
        const tick = () => {
          const at = step();
          el.points.push(at.x, at.y);
          const t = clock();
          if (t - lastCursor >= F.cursorMs) {
            send({ type: 'cursor', boardId: s.boardId, at });
            lastCursor = t;
          }
          if (t < end && el.points.length < 3800) {
            // La preview lleva el trazo completo hasta ahora y la hora de envío (para medir la difusión).
            send({ type: 'preview', boardId: s.boardId, preview: { el: { ...el, createdAt: t, updatedAt: t } } });
            return later(F.previewMs, tick);
          }
          // Al soltar: el trazo final como op, luego fin de la preview.
          commit(el);
          send({ type: 'preview', boardId: s.boardId, preview: null });
          next();
        };
        return tick();
      }

      if (state === 'shape') {
        const from = step();
        const el = { ...base(clock()), kind: 'shape', shape: Math.random() < 0.7 ? 'rectangle' : 'arrow', from, to: from, stroke: '#30a46c', strokeWidth: 2 };
        const tick = () => {
          const at = step();
          const t = clock();
          el.to = at;
          if (t < end) {
            send({ type: 'cursor', boardId: s.boardId, at });
            send({ type: 'preview', boardId: s.boardId, preview: { el: { ...el, createdAt: t, updatedAt: t } } });
            return later(F.previewMs, tick);
          }
          commit(el);
          send({ type: 'preview', boardId: s.boardId, preview: null });
          next();
        };
        return tick();
      }

      if (state === 'text') {
        // Escribir no genera tráfico hasta confirmar. De vez en cuando lo que se pega es una imagen.
        return later(dur, () => {
          const at = step();
          if (Math.random() < F.elementMix.image) commit({ ...base(clock()), kind: 'image', at, width: 320, height: 200, uri: `data:image/png;base64,${'A'.repeat(30_000)}` });
          else commit({ ...base(clock()), kind: 'text', at, text: 'Idea que alguien escribió en la reunión', color: '#111111', fontSize: 18 });
          next();
        });
      }

      if (state === 'move') {
        const el = mine.at(-1);
        if (!el || el.kind === 'image') return enter('cursor'); // nada propio que mover
        const start = { ...pos };
        send({ type: 'select', boardId: s.boardId, ids: [el.id] });
        const tick = () => {
          const at = step();
          const t = clock();
          const dx = at.x - start.x;
          const dy = at.y - start.y;
          send({ type: 'cursor', boardId: s.boardId, at });
          if (t < end) {
            send({ type: 'preview', boardId: s.boardId, preview: { edit: { ids: [el.id], mode: 'move', handle: 0, start, dx, dy, patch: null } } });
            return later(F.previewMs, tick);
          }
          let patch;
          if (el.kind === 'stroke') {
            el.points = el.points.map((v, i) => Math.round(v + (i % 2 ? dy : dx)));
            patch = { points: el.points };
          } else if (el.kind === 'shape') {
            el.from = { x: Math.round(el.from.x + dx), y: Math.round(el.from.y + dy) };
            el.to = { x: Math.round(el.to.x + dx), y: Math.round(el.to.y + dy) };
            patch = { from: el.from, to: el.to };
          } else {
            el.at = { x: Math.round(el.at.x + dx), y: Math.round(el.at.y + dy) };
            patch = { at: el.at };
          }
          send({ type: 'op', boardId: s.boardId, ops: [{ t: 'update', id: el.id, patch, updatedAt: t }], seq: 0 });
          send({ type: 'preview', boardId: s.boardId, preview: null });
          send({ type: 'select', boardId: s.boardId, ids: [] });
          next();
        };
        return tick();
      }

      if (state === 'erase') {
        const el = mine.pop();
        if (el) send({ type: 'op', boardId: s.boardId, ops: [{ t: 'delete', id: el.id }], seq: 0 });
        return later(dur, next);
      }
    }

    // ---------- eventos de fondo de la sesión ----------
    function startBackground() {
      const ping = () => {
        send({ type: 'ping', t: clock() });
        later(F.pingMs, ping);
      };
      later(Math.random() * F.pingMs, ping);
      if (s.account) {
        const list = () => {
          http('list', 'GET', '/me/boards', null, s.token);
          later(expo(F.listEveryMin * 60_000, 60_000), list);
        };
        later(expo(F.listEveryMin * 60_000, 60_000), list);
      }
      // Se cae la red: el socket se corta y el cliente vuelve a entrar con el mismo token (sin login ni REST).
      const drop = () => {
        if (ws?.readyState === 1) {
          st.reconnects++;
          ws.close(4999);
        }
        later(expo(F.reconnectEveryMin * 60_000, 60_000), drop);
      };
      later(expo(F.reconnectEveryMin * 60_000, 60_000), drop);
    }

    function connect() {
      if (done) return;
      const socket = new WS(`${target.replace(/^http/, 'ws')}/ws?boardId=${encodeURIComponent(s.boardId)}&token=${encodeURIComponent(s.boardToken)}`);
      ws = socket;
      vu.ws = socket;
      socket.onopen = () => {
        inBoard = false;
        joinSentAt = performance.now();
        send({ type: 'join', boardId: s.boardId, userId: s.userId, nickname: s.nickname, tab: `w${workerId}` });
      };
      socket.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
        st.wsIn++;
        st.bytesIn += data.length;
        // Solo se decodifica lo que se mide; el resto solo se cuenta (decodificar todo saturaría el generador).
        if (data.startsWith('{"type":"cursor"')) st.cursorsIn++;
        else if (data.startsWith('{"type":"preview"')) {
          st.previewsIn++;
          // 1 de cada 10 previews de trazo se decodifica para medir su difusión.
          if (++previewSeen % 10 === 0 && data.includes('"createdAt"')) {
            const t = JSON.parse(data).preview?.el?.createdAt;
            if (t) ok('preview', clock() - t);
          }
        } else if (data.startsWith('{"type":"op"')) {
          const el = data.includes('"t":"add"') ? JSON.parse(data) : null;
          const added = el?.ops?.[0]?.el;
          if (added?.createdAt && added.id?.startsWith('lt_')) ok(el.from === s.userId ? 'op' : 'fanout', clock() - added.createdAt);
        } else if (data.startsWith('{"type":"pong"')) ok('ping', clock() - JSON.parse(data).t);
        else if (data.startsWith('{"type":"joined"')) {
          ok('wsJoin', performance.now() - joinSentAt);
          failures = 0;
          inBoard = true;
          if (!everJoined) {
            everJoined = true;
            st.entered++;
            startBackground();
            enter(pick('cursor'));
          }
        } else if (data.startsWith('{"type":"error"')) fail('ws', JSON.parse(data).code ?? 'ERROR');
      };
      socket.onerror = () => fail('ws', 'SOCKET_ERROR');
      socket.onclose = (ev) => {
        if (done || socket !== ws) return;
        if (ev.code !== 4999 && ev.code !== 1000) fail('ws', `CLOSE_${ev.code}`);
        // Reconexión con espera creciente (web/src/lib/config.ts: de 500 ms a 15 s). Tras varios fallos se rinde.
        if (++failures > 5) {
          st.gaveUp++;
          return finish();
        }
        later(Math.min(15_000, 500 * 2 ** (failures - 1)) * (0.5 + Math.random()), connect);
      };
    }
    connect();
  });
}
