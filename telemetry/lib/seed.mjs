// Datos de prueba: cuentas con su sesión ya emitida y tableros con contenido de tamaño realista.
// El registro es caro (scrypt) y por eso se hace una vez, fuera de la medición. Los tableros se escriben
// directo en Mongo; una copia base permite dejar la base igual antes de cada corrida (restoreBase).
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const VERSION = 2;
const PASSWORD = 'carga-shareboard-2026';
const BOARDS = 2000; // suficiente para Server killer: ~1.700 salas a la vez
const DAY = 86_400_000;

async function call(target, method, path, body, token) {
  const res = await fetch(target + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  // Los errores del servidor vienen como { error: { code, message } }.
  return { status: res.status, json, code: json.error?.code, message: json.error?.message };
}

/** ¿La semilla guardada sigue sirviendo en esta base de datos? La sesión emitida dura 30 días. */
export async function seedIsValid(target, file, users) {
  if (!existsSync(file)) return null;
  const seed = JSON.parse(readFileSync(file, 'utf8'));
  if (seed.version !== VERSION || seed.accounts.length < users) return null;
  if (Date.now() - Date.parse(seed.createdAt) > 25 * DAY) return null;
  const me = await call(target, 'GET', '/me', null, seed.accounts[0].token);
  const board = await call(target, 'GET', `/boards/${seed.boards.at(-1).id}`);
  return me.status === 200 && board.status === 200 ? seed : null;
}

// ---------- contenido de los tableros ----------
// ponytail: distribución supuesta (mediana 80, p90 ~500, p99 ~2.200 elementos); calibrar con tableros reales si los hay.
const boardSize = () => Math.min(5000, Math.round(80 * Math.exp(1.43 * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()))));
const IMAGE_URI = `data:image/png;base64,${'A'.repeat(30_000)}`; // ~22 KB de imagen pegada

function element(id, z, creator, now) {
  const base = { id, createdBy: creator, createdAt: now, updatedAt: now, z };
  const r = Math.random();
  const x = Math.round(Math.random() * 3000);
  const y = Math.round(Math.random() * 2000);
  if (r < 0.7) {
    const points = [];
    let [px, py] = [x, y];
    for (let k = 0, n = 10 + Math.floor(Math.random() * 90); k < n; k++) points.push((px += Math.round(Math.random() * 12 - 6)), (py += Math.round(Math.random() * 12 - 6)));
    return { ...base, kind: 'stroke', points, color: '#1e88e5', width: 3 };
  }
  if (r < 0.9) return { ...base, kind: 'shape', shape: 'rectangle', from: { x, y }, to: { x: x + 180, y: y + 110 }, stroke: '#30a46c', strokeWidth: 2 };
  if (r < 0.997) return { ...base, kind: 'text', at: { x, y }, text: 'Nota de la reunión con algunas palabras', color: '#111111', fontSize: 18 };
  return { ...base, kind: 'image', at: { x, y }, width: 320, height: 200, uri: IMAGE_URI };
}

function hashPin(pin) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

function shortCode(i) {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let k = 0, n = i + 1; k < 6; k++, n = Math.floor(n / a.length)) s += a[n % a.length];
  return `Z${s}`;
}

export async function makeSeed({ target, file, users, log, db, flow }) {
  log('Vaciando la base de pruebas (solo shareboard_carga)…');
  await Promise.all([db.collection('boards').deleteMany({}), db.collection('users').deleteMany({}), db.collection('boards_base').deleteMany({}), db.collection('users_base').deleteMany({})]);

  log(`Creando ${users} cuentas…`);
  const accounts = new Array(users);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < users) {
        const i = next++;
        const username = `lt${String(i).padStart(4, '0')}`;
        const r = await call(target, 'POST', '/auth/register', { username, email: `${username}@carga.test`, password: PASSWORD, nickname: `vu${i}` });
        if (!r.json.token) throw new Error(`${username}: ${r.status} ${r.code ?? ''} ${r.message ?? ''}`);
        accounts[i] = { username, id: r.json.account.id, token: r.json.token };
        if (++done % 250 === 0 || done === users) log(`  ${done}/${users}`);
      }
    }),
  );

  // El servidor valida un elemento de cada tipo: lo que se escribe directo en Mongo tiene su misma forma.
  const now = Date.now() - 1000;
  const samples = [];
  while (new Set(samples.map((e) => e.kind)).size < 4) samples.push(element(`m${samples.length}`, samples.length + 1, accounts[0].id, now));
  const probe = await call(target, 'POST', '/boards/import', { snapshot: { format: 'live-whiteboard', version: 1, meta: { name: 'muestra' }, elements: samples, exportedAt: now }, creatorId: accounts[0].id }, accounts[0].token);
  if (probe.status !== 201) throw new Error(`El servidor rechazó los elementos de muestra: ${probe.code} ${probe.message}`);

  log(`Creando ${BOARDS} tableros con contenido…`);
  const pinHash = hashPin(flow.pin);
  const boards = [];
  const sizes = [];
  const col = db.collection('boards');
  let batch = [];
  for (let b = 0; b < BOARDS; b++) {
    const creator = accounts[b % users];
    const n = boardSize();
    sizes.push(n);
    const hasPin = Math.random() < flow.pinBoardRatio;
    const elements = Array.from({ length: n }, (_, k) => element(`s${b}_${k}`, k + 1, creator.id, now));
    const members = Array.from({ length: Math.floor(Math.random() * 5) }, () => accounts[Math.floor(Math.random() * users)].id).filter((id) => id !== creator.id);
    const id = `brd_seed${String(b).padStart(5, '0')}`;
    batch.push({ _id: id, shortCode: shortCode(b), name: `Tablero ${b}`, access: 'public', editPolicy: 'everyone', editors: [], creatorId: creator.id, createdAt: now, updatedAt: now, pinHash: hasPin ? pinHash : null, members: [...new Set(members)], elements });
    boards.push({ id, n, pin: hasPin, creator: b % users });
    if (batch.length === 50) {
      await col.insertMany(batch);
      batch = [];
      if ((b + 1) % 500 === 0) log(`  ${b + 1}/${BOARDS}`);
    }
  }
  if (batch.length) await col.insertMany(batch);

  const baseTs = Date.now();
  await col.aggregate([{ $out: 'boards_base' }]).toArray();
  await db.collection('users').aggregate([{ $out: 'users_base' }]).toArray();
  sizes.sort((a, b) => a - b);
  log(`Tamaño de los tableros: mediana ${sizes[BOARDS >> 1]}, p90 ${sizes[Math.floor(BOARDS * 0.9)]}, p99 ${sizes[Math.floor(BOARDS * 0.99)]} elementos`);

  const seed = { version: VERSION, target, createdAt: new Date().toISOString(), baseTs, password: PASSWORD, pin: flow.pin, accounts, boards };
  writeFileSync(file, JSON.stringify(seed));
  return seed;
}

/** Deja la base como quedó al crear la semilla: lo que cambió la corrida anterior vuelve a su copia. Con el servidor apagado. */
export async function restoreBase(db, baseTs) {
  const boards = db.collection('boards');
  const touched = await boards.find({ updatedAt: { $gt: baseTs } }, { projection: { _id: 1 } }).map((d) => d._id).toArray();
  await boards.deleteMany({ createdAt: { $gt: baseTs } });
  if (touched.length) await db.collection('boards_base').aggregate([{ $match: { _id: { $in: touched } } }, { $merge: { into: 'boards', whenMatched: 'replace', whenNotMatched: 'discard' } }]).toArray();
  await db.collection('users').deleteMany({ createdAt: { $gt: baseTs } });
  return touched.length;
}
