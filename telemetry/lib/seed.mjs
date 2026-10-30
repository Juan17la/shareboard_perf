// Datos de prueba: cuentas lt0000… y un tablero público por cuenta.
// El registro es caro (scrypt) y tiene límite por hora: por eso se hace una vez, fuera de la medición.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const PASSWORD = 'carga-shareboard-2026';

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

/** ¿La semilla guardada sigue existiendo en esta base de datos? */
export async function seedIsValid(target, file, users) {
  if (!existsSync(file)) return null;
  const seed = JSON.parse(readFileSync(file, 'utf8'));
  if (seed.accounts.length < users) return null;
  const login = await call(target, 'POST', '/auth/login', { login: seed.accounts[0].username, password: seed.password });
  if (!login.json.token) return null;
  const board = await call(target, 'GET', `/boards/${seed.boards.at(-1)}`);
  return board.status === 200 ? seed : null;
}

export async function makeSeed(target, file, users, log) {
  const pool = async (n, fn) => {
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < n) {
          await fn(next++);
          if (++done % 250 === 0 || done === n) log(`  ${done}/${n}`);
        }
      }),
    );
  };
  const accounts = new Array(users);
  log(`Creando ${users} cuentas de prueba…`);
  await pool(users, async (i) => {
    const username = `lt${String(i).padStart(4, '0')}`;
    let r = await call(target, 'POST', '/auth/register', { username, email: `${username}@carga.test`, password: PASSWORD, nickname: `vu${i}` });
    if (r.code === 'USERNAME_TAKEN' || r.code === 'EMAIL_TAKEN') r = await call(target, 'POST', '/auth/login', { login: username, password: PASSWORD });
    if (!r.json.token) throw new Error(`${username}: ${r.status} ${r.code ?? ''} ${r.message ?? ''}`);
    accounts[i] = { username, id: r.json.account.id, token: r.json.token };
  });
  const boards = new Array(users);
  log(`Creando ${users} tableros…`);
  await pool(users, async (j) => {
    const acc = accounts[j];
    const r = await call(target, 'POST', '/boards', { name: `carga ${j}`, access: 'public', editPolicy: 'everyone', creatorId: acc.id }, acc.token);
    if (!r.json.id) throw new Error(`tablero ${j}: ${r.status} ${r.code ?? ''}`);
    boards[j] = r.json.id;
  });
  const seed = { target, createdAt: new Date().toISOString(), password: PASSWORD, accounts: accounts.map(({ username, id }) => ({ username, id })), boards };
  writeFileSync(file, JSON.stringify(seed));
  return seed;
}
