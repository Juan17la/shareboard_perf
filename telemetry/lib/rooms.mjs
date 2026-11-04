// Planificador de salas. Cada sala (una persona sola, un equipo, una clase) se abre, sus miembros llegan
// escalonados y se cierra a su hora. El horario no depende de lo que tarde el servidor: un usuario que no
// logra entrar sigue ocupando su lugar hasta su hora de salida. Así, si el servidor se atasca, la carga
// ofrecida no baja y el problema se ve en la latencia y en los errores (modelo abierto).
//
// Cuando una sala termina se abre otra para mantener los usuarios objetivo. Las llegadas resultantes
// cumplen la ley de Little: llegadas/s = usuarios ÷ duración media de la sesión.

const expo = (mean, min, max, r) => Math.min(max, Math.max(min, -Math.log(1 - r()) * mean));
const between = ([a, b], r) => a + r() * (b - a);

export function weightedPick(table, r) {
  const entries = Object.entries(table);
  let left = r() * entries.reduce((t, [, w]) => t + w, 0);
  for (const [k, w] of entries) if ((left -= w) <= 0) return k;
  return entries.at(-1)[0];
}

export function createScheduler({ flow, boards, accounts, rampEndAt, send, random = Math.random }) {
  const rooms = new Set();
  const free = boards.map((_, i) => i);
  let nextMember = 0;
  let nextAcc = 0;
  let nextRoom = 0;
  let occupied = 0;

  function takeBoard() {
    if (!free.length) return null; // más salas que tableros: la sala reutiliza uno al azar
    const k = Math.floor(random() * free.length);
    const [b] = free.splice(k, 1);
    return b;
  }
  function openRoom(now, target) {
    const warm = now < rampEndAt;
    // Una sala no debe pasarse mucho del objetivo: con 100 usuarios una clase de 30 movería toda la carga.
    let def = null;
    let size = 0;
    for (let tries = 0; tries < 10 && !def; tries++) {
      // Una foto de salas ya abiertas tiene más salas largas que las que se abren: cuanto más dura, más probable es verla.
      // Sin este ajuste, la mezcla inicial sería más liviana que la estable y el trabajo subiría durante la medición.
      const type = weightedPick(Object.fromEntries(flow.rooms.map((x) => [x.type, warm ? x.weight * x.minutes : x.weight])), random);
      const candidate = flow.rooms.find((x) => x.type === type);
      const n = Math.round(between(candidate.size, random));
      if (occupied + n <= Math.max(target * 1.02, target + 1)) [def, size] = [candidate, n];
    }
    if (!def) [def, size] = [flow.rooms[0], 1];

    const startsAt = warm ? rampEndAt : now;
    const mean = def.minutes * 60_000;
    // Una sala que ya estaba abierta al empezar puede cerrar en cualquier momento (la exponencial no tiene memoria):
    // con un mínimo de 3 min nadie saldría al inicio de la ventana medida y el ritmo de llegadas no sería el estable.
    const endAt = startsAt + expo(mean, warm ? 10_000 : 180_000, mean * 3, random);
    const creates = !warm && def.createRatio && random() < def.createRatio;
    const boardIdx = creates ? null : (takeBoard() ?? Math.floor(random() * boards.length));
    const room = { id: nextRoom++, type: def.type, boardIdx, members: [], ownsBoard: !creates };
    const journeys = flow.journeys[def.type === 'solo' ? 'solo' : 'group'];

    for (let m = 0; m < size; m++) {
      const lead = m === 0;
      // Durante la llegada inicial nadie hace login (no se mide): así la rampa no es una tormenta de scrypt.
      let journey = warm ? (random() < 0.3 && !lead && def.type !== 'solo' ? 'guest' : 'resume') : weightedPick(journeys, random);
      if (lead && journey === 'guest') journey = 'resume';
      const arriveAt = warm ? now + random() * Math.max(0, rampEndAt - now) : lead ? now : now + random() * def.joinWindowSec * 1000;
      const early = random() < flow.earlyLeaveRatio;
      const leaveAt = early ? arriveAt + 60_000 + random() * Math.max(0, endAt - arriveAt - 60_000) : endAt + random() * 60_000;
      const member = {
        i: nextMember++,
        room: room.id,
        roomType: def.type,
        boardIdx,
        creates: lead && creates,
        role: lead ? def.roles.lead : def.roles.rest,
        journey,
        acc: journey === 'guest' ? null : nextAcc++ % accounts,
        arriveAt,
        leaveAt,
      };
      room.members.push(member);
      send(member);
      occupied++;
    }
    rooms.add(room);
  }

  return {
    tick(now, target) {
      for (const room of rooms) {
        room.members = room.members.filter((m) => {
          if (m.leaveAt > now) return true;
          occupied--;
          return false;
        });
        if (!room.members.length) {
          rooms.delete(room);
          if (room.ownsBoard && room.boardIdx != null) free.push(room.boardIdx);
        }
      }
      let guard = 0;
      while (occupied < target && guard++ < target + 1) openRoom(now, target);
    },
    stats() {
      const byType = {};
      for (const room of rooms) {
        const t = (byType[room.type] ??= { rooms: 0, users: 0 });
        t.rooms++;
        t.users += room.members.length;
      }
      return { occupied, rooms: rooms.size, byType };
    },
  };
}

// Comprobación: node telemetry/lib/rooms.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const flow = JSON.parse(readFileSync(new URL('../profiles/flujo.json', import.meta.url), 'utf8'));
  for (const target of [100, 600]) {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; // repetible
    const members = [];
    const start = 0;
    const rampEndAt = 120_000;
    const s = createScheduler({ flow, boards: Array(2000).fill(0), accounts: 1500, rampEndAt, random, send: (m) => members.push(m) });
    const seen = [];
    const HOURS = 12;
    for (let now = start; now < HOURS * 3_600_000; now += 1000) {
      s.tick(now, target);
      if (now > rampEndAt) seen.push(s.stats().occupied);
    }
    const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
    const after = members.filter((m) => m.arriveAt > rampEndAt);
    const perMin = after.length / (HOURS * 60 - 2);
    const WMin = target / perMin;
    const share = (j) => after.filter((m) => m.journey === j).length / after.length;
    console.assert(Math.abs(mean - target) / target < 0.03, `usuarios ${mean} lejos de ${target}`);
    console.assert(Math.min(...seen) >= target * 0.9, `mínimo ${Math.min(...seen)}`);
    console.assert(WMin > 15 && WMin < 45, `sesión media ${WMin}`);
    console.assert(after.every((m) => m.leaveAt > m.arriveAt), 'nadie sale antes de llegar');
    console.log(`L=${target} promedio=${mean.toFixed(1)} min=${Math.min(...seen)} máx=${Math.max(...seen)} llegadas/min=${perMin.toFixed(2)} W=${WMin.toFixed(1)} min`,
      `login=${(share('login') * 100).toFixed(1)}% registro=${(share('register') * 100).toFixed(1)}% invitado=${(share('guest') * 100).toFixed(1)}% con sesión=${(share('resume') * 100).toFixed(1)}%`);
  }
}
