// Hilo generador de carga. lib/runner.mjs crea varios para repartir los usuarios entre núcleos.
//
// Cada usuario virtual imita al cliente web real (web/src/lib/config.ts):
//   login -> lista sus tableros -> se une a su tablero -> sesión de ~40 min alternando estados:
//     mirando   : no envía nada (solo ping cada 20 s)
//     cursor    : cursor cada 45 ms (~22/s)
//     dibujando : cursor + preview del trazo cada 33 ms (~30/s, el trazo crece) + 1 op al soltar
//     moviendo  : select + cursor + preview de movimiento cada 33 ms + 1 op al soltar
// El tiempo en cada estado depende del rol (colaborador, presentador, espectador).
// Cada segundo envía al hilo principal histogramas de latencia y contadores.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';

import { add as histAdd } from './lib/hist.mjs';
import { buildLayout } from './lib/layout.mjs';

const { workerId, workers, target, profile, accounts, boards, password, serverPkg } = workerData;
const F = profile.flow;
const slots = buildLayout(profile, accounts.length);

// Node 22 trae WebSocket; en versiones anteriores se usa el paquete ws que ya instaló el servidor.
const WS = globalThis.WebSocket ?? createRequire(serverPkg)('ws');
// Reloj de alta resolución compartido por todos los hilos (Date.now() solo da milisegundos enteros).
const clock = () => performance.timeOrigin + performance.now();

const running = new Map();
let sessionSec = profile.flow.sessionMeanSec; // lo actualiza el hilo principal
// Nombres únicos para los registros: marca de esta corrida + hilo + contador (máx. 24 caracteres).
const tag = Math.round(performance.timeOrigin).toString(36);
let newUsers = 0;

// ---------- estadísticas del segundo en curso ----------
let st = fresh();
function fresh() {
  return { h: {}, err: {}, left: 0, http: 0, wsOut: 0, wsIn: 0, bytesIn: 0, bytesOut: 0, cursorsIn: 0, previewsIn: 0, states: { watch: 0, cursor: 0, draw: 0, move: 0 } };
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
  for (const v of running.values()) {
    if (v.ws?.readyState === 1) sockets++;
    if (v.state) st.states[v.state]++;
  }
  parentPort.postMessage({ type: 'stats', workerId, active: running.size, sockets, elu: Math.round(e * 1000) / 1000, st });
  st = fresh();
}, 1000).unref();

parentPort.on('message', (m) => {
  if (m.type !== 'users') return;
  if (m.sessionSec) sessionSec = m.sessionSec;
  const wanted = Math.min(m.users, slots.length);
  // Los usuarios de este hilo son los índices i con i % workers === workerId.
  for (let i = workerId; i < slots.length; i += workers) {
    if (i < wanted && !running.has(i)) start(i);
    else if (i >= wanted && running.has(i)) running.get(i).stop();
  }
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

async function http(kind, method, path, body, token) {
  const t0 = performance.now();
  st.http++;
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
    fail(kind, err.name === 'TimeoutError' ? 'TIMEOUT' : (err.cause?.code ?? err.name));
    return null;
  }
}

// ---------- un usuario virtual ----------
function start(i) {
  const ctl = new AbortController();
  const vu = { ws: null, state: null, stop: () => ctl.abort() };
  running.set(i, vu);
  run(i, vu, ctl.signal)
    .catch((err) => fail('vu', err.message.slice(0, 40)))
    .finally(() => running.delete(i));
}

async function run(i, vu, signal) {
  const acc = accounts[i];
  const slot = slots[i];
  const boardId = boards[slot.board % boards.length];
  while (!signal.aborted) {
    // Una parte de las llegadas son personas nuevas: se registran (scrypt + escritura en Mongo) en vez de hacer login.
    let auth;
    if (Math.random() < (F.registerRatio ?? 0)) {
      const username = `n${tag}_${workerId}_${(newUsers++).toString(36)}`;
      auth = await http('register', 'POST', '/auth/register', { username, email: `${username}@carga.test`, password, nickname: `vu${i}` });
    } else auth = await http('login', 'POST', '/auth/login', { login: acc.username, password });
    if (!auth) {
      await sleep(expo(3000, 1000), signal);
      continue;
    }
    const s = { token: auth.token, userId: auth.account.id, boardId, role: slot.role };
    await http('list', 'GET', '/me/boards', null, s.token);
    if (Math.random() < F.createRatio) {
      await http('create', 'POST', '/boards', { name: `carga ${i}`, access: 'public', editPolicy: 'everyone', creatorId: s.userId }, s.token);
    }
    const joined = await http('join', 'POST', `/boards/${boardId}/join`, { userId: s.userId, nickname: `vu${i}` }, s.token);
    if (!joined) {
      await sleep(expo(3000, 1000), signal);
      continue;
    }
    s.boardToken = joined.boardToken;
    await session(i, vu, signal, s);
    // Fin de la sesión: sale y "otra persona" ocupa este puesto enseguida (login de nuevo).
    // ponytail: modelo cerrado (puestos fijos); si el servidor se atasca, las llegadas también bajan.
    if (!signal.aborted) st.left++;
  }
}

function session(i, vu, signal, s) {
  return new Promise((resolve) => {
    const ws = new WS(`${target.replace(/^http/, 'ws')}/ws?boardId=${encodeURIComponent(s.boardId)}&token=${encodeURIComponent(s.boardToken)}`);
    vu.ws = ws;
    const timers = new Set();
    const mine = []; // trazos propios (los más viejos se borran: el tablero no crece sin límite)
    const pos = { x: Math.random() * 1600, y: Math.random() * 900 };
    let done = false;
    let joinSentAt = 0;
    let previewSeen = 0;

    const later = (ms, fn) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!done) fn();
      }, ms);
      timers.add(t);
    };
    const send = (obj) => {
      if (ws.readyState !== 1) return;
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
      if (ws.readyState <= 1) ws.close(1000);
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

    // ---------- máquina de estados ----------
    const role = F.roles[s.role];
    // Probabilidad de entrar a cada estado = fracción de tiempo / duración media (así se cumplen las fracciones).
    const weights = Object.entries(role).map(([k, frac]) => [k, frac / F.meanSec[k]]);
    const totalW = weights.reduce((t, [, w]) => t + w, 0);
    const pick = () => {
      let r = Math.random() * totalW;
      for (const [k, w] of weights) if ((r -= w) <= 0) return k;
      return 'watch';
    };

    function enter(state) {
      vu.state = state;
      const dur = expo(F.meanSec[state] * 1000, 300, F.meanSec[state] * 5000);
      const end = clock() + dur;
      const next = () => enter(pick());
      if (state === 'watch') return later(dur, next);

      if (state === 'cursor') {
        const tick = () => {
          if (clock() >= end) return next();
          send({ type: 'cursor', boardId: s.boardId, at: step() });
          later(F.cursorMs, tick);
        };
        return tick();
      }

      if (state === 'draw') {
        const now = clock();
        const el = { id: `lt_${s.userId.slice(-6)}_${Math.round(now)}_${Math.floor(Math.random() * 1e6)}`, kind: 'stroke', createdBy: s.userId, createdAt: now, updatedAt: now, z: 0, points: [], color: '#1e88e5', width: 3 };
        let lastCursor = 0;
        const tick = () => {
          const at = step();
          el.points.push(at.x, at.y, at.x + 3, at.y + 2);
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
          // Al soltar: el trazo final como op (y se borra el más viejo si hay demasiados), luego fin de la preview.
          const sentAt = clock();
          const ops = [{ t: 'add', el: { ...el, createdAt: sentAt, updatedAt: sentAt } }];
          mine.push(el.id);
          if (mine.length > F.keepElements) ops.push({ t: 'delete', id: mine.shift() });
          send({ type: 'op', boardId: s.boardId, ops, seq: 0 });
          send({ type: 'preview', boardId: s.boardId, preview: null });
          next();
        };
        return tick();
      }

      if (state === 'move') {
        const id = mine.at(-1);
        if (!id) return enter('draw'); // nada propio que mover: dibuja
        const start = { ...pos };
        send({ type: 'select', boardId: s.boardId, ids: [id] });
        const tick = () => {
          const at = step();
          const t = clock();
          send({ type: 'cursor', boardId: s.boardId, at });
          if (t < end) {
            send({ type: 'preview', boardId: s.boardId, preview: { edit: { ids: [id], mode: 'move', handle: 0, start, dx: at.x - start.x, dy: at.y - start.y, patch: null } } });
            return later(F.previewMs, tick);
          }
          send({ type: 'op', boardId: s.boardId, ops: [{ t: 'update', id, patch: { z: Math.round(t % 1e6) }, updatedAt: t }], seq: 0 });
          send({ type: 'preview', boardId: s.boardId, preview: null });
          send({ type: 'select', boardId: s.boardId, ids: [] });
          next();
        };
        return tick();
      }
    }

    ws.onopen = () => {
      joinSentAt = performance.now();
      send({ type: 'join', boardId: s.boardId, userId: s.userId, nickname: `vu${i}`, tab: `w${workerId}` });
    };
    ws.onmessage = (ev) => {
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
        const m = JSON.parse(data);
        const el = m.ops?.[0]?.el;
        if (el?.createdAt && el.id?.startsWith('lt_')) ok(m.from === s.userId ? 'op' : 'fanout', clock() - el.createdAt);
      } else if (data.startsWith('{"type":"pong"')) ok('ping', clock() - JSON.parse(data).t);
      else if (data.startsWith('{"type":"joined"')) {
        ok('wsJoin', performance.now() - joinSentAt);
        const ping = () => {
          send({ type: 'ping', t: clock() });
          later(F.pingMs, ping);
        };
        later(Math.random() * F.pingMs, ping);
        const list = () => {
          http('list', 'GET', '/me/boards', null, s.token);
          later(expo(F.listSec * 1000, 30_000), list);
        };
        later(expo(F.listSec * 1000, 30_000), list);
        later(expo(sessionSec * 1000, 5_000, sessionSec * 4000), finish);
        enter('watch');
      } else if (data.startsWith('{"type":"error"')) fail('ws', JSON.parse(data).code ?? 'ERROR');
    };
    ws.onerror = () => fail('ws', 'SOCKET_ERROR');
    ws.onclose = (ev) => {
      if (done) return;
      if (ev.code !== 1000) fail('ws', `CLOSE_${ev.code}`);
      // Cierre inesperado: espera un poco y la sesión vuelve a empezar desde el login.
      vu.state = null;
      sleep(expo(2000, 500), signal).then(finish);
    };
  });
}
