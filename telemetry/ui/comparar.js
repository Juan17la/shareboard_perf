// Página Comparar: barras, pasteles y líneas de los cuatro entornos, por carga o a través de todas.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const num = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
  const auto = (v) => num(v, Math.abs(v) < 10 ? 1 : 0);
  const ms = (v) => (v == null ? '–' : v >= 1000 ? `${num(v / 1000, 1)} s` : `${auto(v)} ms`);
  const pct = (v) => (v == null ? '–' : `${auto(v)} %`);
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const median = (v) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const finite = (v) => v.filter((x) => typeof x === 'number' && Number.isFinite(x));

  // El color sigue al entorno en toda la página, aunque se oculten los demás.
  const ENVS = [
    { id: 'pc', name: 'PC nativo', color: '--s1' },
    { id: 'docker-1cpu', name: 'Docker 1 CPU', color: '--s2' },
    { id: 'docker-2cpu', name: 'Docker 2 CPU', color: '--s3' },
    { id: 'aws', name: 'AWS', color: '--s4', dash: true },
  ];
  const TESTS = [
    { id: 'baja', name: 'Baja', users: 100 },
    { id: 'media', name: 'Media', users: 300 },
    { id: 'alta', name: 'Alta', users: 600 },
    { id: 'capacidad-1000', name: '1.000', users: 1000 },
    { id: 'capacidad-2000', name: '2.000', users: 2000 },
    { id: 'capacidad-3000', name: '3.000', users: 3000 },
    { id: 'server-killer', name: 'Killer', users: 6000 },
  ];
  const ALL = 'todas';

  let RUNS = [];
  const hidden = new Set();
  let view = TESTS.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) : ALL;
  let plots = [];
  // Se dibuja cuando ya están todas las tarjetas: antes, la rejilla aún no decide el ancho de cada una.
  const pending = [];
  const sync = uPlot.sync('comparar');

  const runsOf = (env, test) => RUNS.filter((r) => r.env === env && r.test === test);
  const shown = (test) => ENVS.filter((e) => !hidden.has(e.id) && (test ? runsOf(e.id, test).length : RUNS.some((r) => r.env === e.id)));

  // Mediana y rango de las repeticiones con el servidor vivo.
  function agg(env, test, fn) {
    const runs = runsOf(env, test);
    if (!runs.length) return { none: true };
    const alive = runs.filter((r) => !r.crashed);
    if (!alive.length) return { down: true, runs };
    const v = finite(alive.map(fn));
    return v.length ? { v: median(v), lo: Math.min(...v), hi: Math.max(...v), n: v.length } : {};
  }

  const lat = (src, op, p) => (r) => r[src]?.[op]?.[p];
  const res = (k, s = 'avg') => (r) => r.res?.[k]?.[s];
  const EP = { login: 'Login', register: 'Registro', list: 'Listar', create: 'Crear', join: 'Unirse' };
  const THR = () => RUNS[0]?.thresholds ?? {};

  // ==================== Barras: la ventana medida de una carga ====================
  const BARS = [
    { title: 'REST dentro del servidor', unit: 'ms', fmt: ms, hint: 'Listar, unirse y crear, medido por el propio servidor, sin la red.', read: 'Es la comparación justa entre máquinas: sale igual se mida en local o en la nube. Si aquí están parejos y en el usuario no, la diferencia es fila o red. Con poca carga, la p95 salta entre 7 y 30 ms por azar: mira «Antes de sacar conclusiones».', cats: [['p50', lat('srv', 'rest', 'p50')], ['p95', lat('srv', 'rest', 'p95')], ['p99', lat('srv', 'rest', 'p99')]] },
    { title: 'REST visto por el usuario', unit: 'ms', fmt: ms, thr: () => ({ v: THR().restP95, label: 'límite de p95' }), hint: 'El viaje completo: red, fila y trabajo del servidor.', read: 'Una barra muy por encima de su par «dentro del servidor» significa que la petición esperó antes de que Node la atendiera.', cats: [['p50', lat('lat', 'rest', 'p50')], ['p95', lat('lat', 'rest', 'p95')], ['p99', lat('lat', 'rest', 'p99')]] },
    { title: 'p95 de los 5 endpoints', unit: 'ms', fmt: ms, hint: 'El 5 % más lento de cada endpoint, visto por el usuario.', read: 'Login y registro son lentos a propósito por scrypt: su diferencia entre máquinas mide la velocidad de la CPU. Con pocas muestras (registro, crear) el valor salta mucho.', cats: Object.entries(EP).map(([k, n]) => [n, lat('lat', k, 'p95')]) },
    { title: 'Tiempo real', unit: 'ms', fmt: ms, thr: () => ({ v: THR().pingP99, label: 'límite de ping p99' }), hint: 'Trazos y ping: sin base de datos ni disco, solo el hilo de JavaScript.', read: 'Si estos suben, el hilo está ocupado o el contenedor está frenado.', cats: [['Trazo p95', lat('lat', 'fanout', 'p95')], ['Preview p95', lat('lat', 'preview', 'p95')], ['Ping p99', lat('lat', 'ping', 'p99')]] },
    { title: 'Usuarios conectados', unit: 'promedio de la ventana', fmt: auto, thr: () => ({ v: TESTS.find((t) => t.id === view)?.users, label: 'objetivo' }), hint: 'Cuántos lograron estar en un tablero.', read: 'Un entorno por debajo de los demás deja gente afuera, aunque su latencia se vea bien.', cats: [['Conectados', (r) => r.users]] },
    { title: 'Trabajo atendido', unit: 'mensajes/s', fmt: auto, hint: 'Mensajes que enviaron los clientes al servidor.', read: 'Debe salir parejo: misma carga. Si un entorno procesa menos, es porque tiene menos gente conectada.', cats: [['Mensajes/s', (r) => r.msgsOut]] },
    { title: 'Hilo de JavaScript', unit: '% de un núcleo', fmt: pct, thr: () => ({ v: 100, label: 'tope del hilo' }), hint: 'El hilo único de Node. Su tope es 100 %; un pico apenas por encima viene del muestreo.', read: 'Cerca de 100 %, nada más se atiende aunque haya otros núcleos libres.', cats: [['Promedio', res('serverMainThread')], ['Pico', res('serverMainThread', 'max')]] },
    { title: 'CPU usada por la aplicación', unit: '% de un núcleo, promedio', fmt: pct, hint: 'Servidor y base de datos, sin contar al generador.', read: 'Es la forma justa de comparar CPU: 100 % es un núcleo entero en cualquier máquina.', cats: [['Servidor', res('serverCpu')], ['mongod', res('mongoCpu')]] },
    { title: 'Memoria residente (RES)', unit: 'MB', fmt: auto, hint: 'RAM física de cada proceso. El límite del contenedor es 512 MB.', read: 'El pico más un margen define la memoria mínima de la máquina.', cats: [['Servidor prom.', res('serverRssMB')], ['Servidor pico', res('serverRssMB', 'max')], ['mongod pico', res('mongoRssMB', 'max')]] },
    { title: 'Disco: operaciones', unit: 'IOPS', fmt: auto, hint: 'Lecturas y escrituras por segundo.', read: 'Compáralo con la ficha técnica del disco (EBS gp3: 3.000 IOPS).', cats: [['Promedio', res('diskIops')], ['Pico', res('diskIops', 'max')]] },
    { title: 'Disco: caudal', unit: 'MB/s', fmt: auto, hint: 'Megabytes por segundo.', read: 'Si caudal y %util son bajos, nadie espera al disco.', cats: [['Promedio', res('diskMBs')], ['Pico', res('diskMBs', 'max')]] },
    { title: 'Disco: utilización', unit: '%util', fmt: pct, thr: () => ({ v: 100, label: 'saturado' }), hint: 'Tiempo con E/S en curso en el disco más ocupado.', read: 'Cerca de 100 % hay fila. En NVMe puede tocarlo antes del límite real: confírmalo con la espera de disco (wa) del pastel.', cats: [['Promedio', res('diskUtil')], ['Pico', res('diskUtil', 'max')]] },
    { title: 'Red', unit: 'MB/s', fmt: auto, hint: 'Interfaz más usada, promedio y pico de salida.', read: 'En el PC y Docker es tráfico local. En AWS compáralo con el ancho de banda base de la instancia.', cats: [['Entrada prom.', res('netRxMBs')], ['Salida prom.', res('netTxMBs')], ['Salida pico', res('netTxMBs', 'max')]] },
    { title: 'Errores por endpoint', unit: '% de intentos', fmt: pct, hint: 'Intentos fallidos, incluidos los que agotaron los 15 s.', read: 'Debe ser 0. Separa qué se rompe primero.', cats: Object.entries(EP).map(([k, n]) => [n, (r) => r.byOp?.[k]?.errorPct]) },
    { title: 'Contenedor frenado', unit: 'ms por segundo', fmt: auto, hint: 'Tiempo que el kernel congeló al contenedor por agotar su cuota de CPU.', read: 'Mayor que 0: el límite de CPU es el cuello aunque el host esté libre.', cats: [['Promedio', res('throttledMs')], ['Pico', res('throttledMs', 'max')]] },
  ];

  // ==================== Pasteles: de qué está hecho cada total ====================
  const avgRes = (k) => (r) => r.res?.[k]?.avg;
  const PIES = [
    { title: '¿En qué gasta CPU la aplicación?', hint: 'Reparto del tiempo de CPU del servidor y la base de datos.', read: 'Una tajada de JavaScript dominante confirma que el cuello es el hilo único. libuv sube con los logins (scrypt).', parts: [
      ['Hilo JavaScript', '--s1', avgRes('serverMainThread')],
      ['libuv (scrypt)', '--s2', avgRes('serverLibuv')],
      ['V8 y otros', '--s3', (r) => Math.max(0, (r.res?.serverCpu?.avg ?? 0) - (r.res?.serverMainThread?.avg ?? 0) - (r.res?.serverLibuv?.avg ?? 0))],
      ['mongod', '--s4', avgRes('mongoCpu')],
    ] },
    { title: 'CPU de la máquina, como top', hint: 'us, sy, wa, st e id de toda la máquina.', read: 'En el PC y Docker también cuenta al generador. Sirve para ver si queda CPU libre y si alguien espera al disco (wa), no para decir quién es más rápido.', parts: [
      ['us', '--s1', avgRes('cpuUser')],
      ['sy', '--s2', avgRes('cpuSystem')],
      ['wa', '--s3', avgRes('iowait')],
      ['st', '--s4', avgRes('steal')],
      ['id', '--muted', avgRes('cpuIdle')],
    ] },
    { title: 'Peticiones por endpoint', hint: 'Cómo se reparte el tráfico REST en la ventana medida.', read: 'Debe verse igual en todos: es la misma carga. Si cambia, el entorno no alcanzó a atender a todos y la carga real fue otra.', parts: Object.entries({ list: '--s1', join: '--p99', login: '--s2', register: '--s4', create: '--s3' }).map(([k, c]) => [EP[k], c, (r) => r.byOp?.[k]?.attempts]) },
    { title: 'Peticiones respondidas y con error', hint: 'Todos los intentos a los 5 endpoints.', read: 'Cualquier tajada de error es gente a la que el servidor no atendió.', parts: [
      ['✓ Respondidas', '--good', (r) => Object.values(r.byOp ?? {}).reduce((t, o) => t + o.attempts - o.failed, 0)],
      ['✕ Con error', '--critical', (r) => Object.values(r.byOp ?? {}).reduce((t, o) => t + o.failed, 0)],
    ] },
    { title: 'Usuarios: dentro y afuera', hint: 'Del objetivo de la prueba, cuántos estaban conectados en promedio.', read: 'Siempre falta un poco: unos están entrando o saliendo. Una tajada grande de «afuera» significa que el servidor ya no deja entrar.', parts: [
      ['Conectados', '--s1', (r) => r.users],
      ['Afuera', '--muted', (r) => Math.max(0, r.target - r.users)],
    ] },
  ];

  // ==================== Líneas: la prueba segundo a segundo, un entorno encima de otro ====================
  const TIME = [
    { key: 'users', title: 'Usuarios conectados', unit: 'usuarios', fmt: auto, read: 'Debe subir en la llegada y quedarse plana. Si se corta de golpe, ahí murió el servidor.', thr: () => TESTS.find((t) => t.id === view)?.users },
    { key: 'js', title: 'Hilo de JavaScript', unit: '% de un núcleo', fmt: pct, read: 'Cerca de 100 %, el servidor ya no da abasto.', thr: () => 100 },
    { key: 'pingP95', title: 'Ping p95', unit: 'ms', fmt: ms, log: true, read: 'Mide la fila del hilo de JavaScript. Escala logarítmica: cada marca multiplica por 10.' },
    { key: 'restP95', title: 'REST p95', unit: 'ms', fmt: ms, log: true, read: 'Lo que espera el usuario para listar, unirse y crear. Escala logarítmica.', thr: () => THR().restP95 },
    { key: 'rss', title: 'Memoria residente del servidor', unit: 'MB', fmt: auto, read: 'Si sube sin parar con usuarios constantes, hay una fuga o estado que crece.' },
    { key: 'serverCpu', title: 'CPU del servidor', unit: '% de un núcleo', fmt: pct, read: 'Puede pasar de 100 %: suma el hilo principal, libuv y V8.' },
    { key: 'throttled', title: 'Contenedor frenado', unit: 'ms/s', fmt: auto, read: 'Mayor que 0: el contenedor agotó su cuota de CPU.' },
    { key: 'tx', title: 'Red: salida', unit: 'MB/s', fmt: auto, read: 'Sube en la llegada y debe quedarse plana. Si cae, el servidor dejó de reenviar.' },
    { key: 'iops', title: 'Disco: IOPS', unit: 'operaciones/s', fmt: auto, read: 'Compáralo con la ficha técnica del disco (EBS gp3: 3.000 IOPS).' },
    { key: 'errors', title: 'Errores', unit: 'por segundo', fmt: auto, read: 'Debe ser 0.' },
  ];

  // ==================== Líneas a través de todas las cargas ====================
  const ACROSS = [
    { title: 'REST p95 dentro del servidor', unit: 'ms · escala logarítmica', fmt: ms, log: true, get: lat('srv', 'rest', 'p95'), read: 'La curva de cada máquina sin contar la red. Hasta 1.000 usuarios, los saltos entre 7 y 30 ms son azar, no diferencias. Donde se dobla hacia arriba empieza a no dar abasto.' },
    { title: 'REST p95 visto por el usuario', unit: 'ms · escala logarítmica', fmt: ms, log: true, thr: () => THR().restP95, get: lat('lat', 'rest', 'p95'), read: 'La línea roja es el límite de la prueba. El tope de 15,1 s es el corte del generador, no una medida.' },
    { title: 'Ping p99', unit: 'ms · escala logarítmica', fmt: ms, log: true, thr: () => THR().pingP99, get: lat('lat', 'ping', 'p99'), read: 'Mide la fila del hilo de JavaScript. Es lo primero que se degrada en el contenedor de 1 CPU.' },
    { title: 'Trazo a los demás p95', unit: 'ms · escala logarítmica', fmt: ms, log: true, thr: () => THR().fanoutP95, get: lat('lat', 'fanout', 'p95'), read: 'Lo que tarda en verse un trazo en la pantalla de los demás.' },
    { title: 'Hilo de JavaScript', unit: '% de un núcleo', fmt: pct, thr: () => 100, get: res('serverMainThread'), read: 'Si crece en línea recta con los usuarios, el costo por usuario es constante y permite proyectar cuándo llega a 100 %.' },
    { title: 'Usuarios conectados frente al objetivo', unit: '% del objetivo', fmt: pct, thr: () => 100, get: (r) => (r.users / r.target) * 100, read: 'Cuando se separa del 100 %, el entorno ya deja gente afuera.' },
    { title: 'Memoria residente del servidor', unit: 'MB, pico', fmt: auto, thr: () => 512, thrLabel: 'límite del contenedor', get: res('serverRssMB', 'max'), read: 'La línea roja es el límite de memoria de los contenedores. Mueren antes de tocarla: V8 limita su montículo cerca de la mitad de ese valor.' },
    { title: 'Login p50 dentro del servidor', unit: 'ms', fmt: ms, get: lat('srv', 'login', 'p50'), read: 'Con baja carga mide la velocidad de la CPU: scrypt siempre hace el mismo cálculo. Es el mejor número para comparar hardware.' },
    { title: 'Costo de JavaScript por mensaje', unit: 'µs de CPU por mensaje', fmt: auto, get: (r) => (r.msgsOut > 0 && r.res?.serverMainThread ? (r.res.serverMainThread.avg / 100) * 1e6 / r.msgsOut : null), read: 'Tiempo del hilo por cada mensaje de los clientes. Incluye el reenvío a los demás, así que depende del tamaño de las salas: compara entornos a la misma carga.' },
    { title: 'Errores totales', unit: '% de intentos a los 5 endpoints', fmt: pct, get: (r) => { const o = Object.values(r.byOp ?? {}); const n = o.reduce((t, x) => t + x.attempts, 0); return n ? (o.reduce((t, x) => t + x.failed, 0) / n) * 100 : null; }, read: 'Debe ser 0.' },
    { title: 'Red: salida', unit: 'MB/s, promedio', fmt: auto, get: res('netTxMBs'), read: 'Crece con los usuarios. En el PC y Docker es tráfico local; en AWS compáralo con el ancho de banda de la instancia.' },
    { title: 'Disco: IOPS', unit: 'promedio', fmt: auto, get: res('diskIops'), read: 'Si crece poco y el %util sigue bajo, el disco no es el cuello.' },
  ];

  // ==================== Piezas ====================
  const legendOf = (envs, extra = '') => `<div class="lg">${envs.map((e) => `<span><i style="background:var(${e.color})"></i>${e.name}</span>`).join('')}${extra}</div>`;
  // Tinta legible sobre cada tajada: algunos colores cambian de claro a oscuro con el tema.
  const inkOn = (color) => {
    const h = css(color);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#0b0b0b' : '#fff';
  };
  const noteDown = (envs, test) => {
    const down = envs.filter((e) => agg(e.id, test, () => 0).down);
    if (!down.length) return '';
    return `<div class="hint">✕ ${down.map((e) => e.name).join(', ')}: el servidor cayó en todas las repeticiones, sin latencia que mostrar.</div>`;
  };

  function section(title, text, grid = true) {
    const head = document.createElement('div');
    head.className = 'section-title';
    head.innerHTML = `<h2>${title}</h2>${text ? `<p>${text}</p>` : ''}`;
    $('view').appendChild(head);
    const box = document.createElement('div');
    if (grid) box.className = 'grid';
    $('view').appendChild(box);
    return box;
  }
  function card(parent, def) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="card-h"><h3>${def.title} <span class="unit">${def.unit ?? ''}</span></h3></div>${def.hint ? `<div class="hint">${def.hint}</div>` : ''}<div class="chart"></div>${def.read ? `<div class="hint read"><b>Cómo leerla:</b> ${def.read}</div>` : ''}`;
    parent.appendChild(el);
    return el.querySelector('.chart');
  }

  // Escala con marcas redondas: 1, 2 o 5 por potencia de 10.
  function niceScale(max) {
    if (!(max > 0)) return { top: 1, ticks: [0, 1] };
    const raw = max / 4;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let i = 0; i <= Math.round(top / step); i++) ticks.push(i * step);
    return { top, ticks };
  }

  function bar(x, y, w, base) {
    const r = Math.min(4, w / 2, base - y);
    return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
  }

  function barChart(parent, def, test, envs, cellOf = (e, fn) => agg(e.id, test, fn)) {
    const cats = def.cats.map(([label, fn]) => ({ label, cells: envs.map((e) => ({ e, ...cellOf(e, fn) })) }));
    if (!cats.some((c) => c.cells.some((x) => x.v != null))) return;
    const box = card(parent, def);
    pending.push(() => drawBars(box, def, cats, envs));
  }

  function drawBars(box, def, cats, envs) {
    const W = box.clientWidth || 500;
    const H = 220;
    const [L, R, T, B] = [52, 8, 20, 24];
    const thr = def.thr?.();
    const peak = Math.max(thr?.v ?? 0, ...cats.flatMap((c) => c.cells.map((x) => x.hi ?? x.v ?? 0)));
    const { top, ticks } = niceScale(peak);
    const base = H - B;
    const yOf = (v) => base - (v / top) * (base - T);
    const band = (W - L - R) / cats.length;
    const GAP = 2;
    const barW = Math.min(64, (band - 16 - GAP * (envs.length - 1)) / envs.length);
    let s = '';
    for (const t of ticks) {
      s += `<line x1="${L}" x2="${W - R}" y1="${yOf(t)}" y2="${yOf(t)}" style="stroke:var(--grid)"/><text x="${L - 6}" y="${yOf(t) + 4}" text-anchor="end" style="fill:var(--muted)">${esc(def.fmt(t))}</text>`;
    }
    cats.forEach((c, ci) => {
      const groupW = barW * envs.length + GAP * (envs.length - 1);
      const start = L + band * ci + (band - groupW) / 2;
      c.cells.forEach((x, i) => {
        const bx = start + i * (barW + GAP);
        const cx = bx + barW / 2;
        const name = `${x.e.name} · ${c.label}`;
        if (x.down) {
          const died = finite(x.runs.map((r) => r.diedAtSec));
          const when = died.length ? `\nMurió a los ${num(Math.min(...died))}–${num(Math.max(...died))} s` : '';
          s += `<g data-tip="${esc(`${name}\n✕ El servidor cayó en las ${x.runs.length} repeticiones${when}`)}"><rect x="${bx}" y="${T}" width="${barW}" height="${base - T}" fill="transparent"/><text x="${cx}" y="${base - 6}" text-anchor="middle" style="fill:var(--critical);font-weight:600">${barW >= 44 ? '✕ cayó' : '✕'}</text></g>`;
          return;
        }
        if (x.v == null) return;
        const y = yOf(x.v);
        const range = x.n > 1 ? `\n${x.n} repeticiones: ${def.fmt(x.lo)} a ${def.fmt(x.hi)}` : '';
        s += `<g data-tip="${esc(`${name}\n${def.fmt(x.v)}${range}`)}"><rect x="${bx}" y="${T}" width="${barW}" height="${base - T}" fill="transparent"/><path d="${bar(bx, y, barW, base)}" style="fill:var(${x.e.color})"/>`;
        if (x.n > 1 && yOf(x.lo) - yOf(x.hi) >= 2) s += `<line x1="${cx}" x2="${cx}" y1="${yOf(x.lo)}" y2="${yOf(x.hi)}" style="stroke:var(--text-2);stroke-width:1.5"/>`;
        const label = def.fmt(x.v);
        if (label.length * 6 <= barW + GAP + 6) s += `<text x="${cx}" y="${yOf(x.hi ?? x.v) - 5}" text-anchor="middle" style="fill:var(--text-2)">${esc(label)}</text>`;
        s += '</g>';
      });
      s += `<text x="${L + band * ci + band / 2}" y="${H - 7}" text-anchor="middle" style="fill:var(--text-2)">${esc(c.label)}</text>`;
    });
    s += `<line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" style="stroke:var(--muted)"/>`;
    if (thr?.v != null) s += `<line x1="${L}" x2="${W - R}" y1="${yOf(thr.v)}" y2="${yOf(thr.v)}" stroke-dasharray="6 4" style="stroke:var(--critical)"/>`;
    const thrLegend = thr?.v != null ? `<span style="color:var(--critical)">- - ${esc(thr.label)}: ${esc(def.fmt(thr.v))}</span>` : '';
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(`${def.title}, barras por entorno`)}">${s}</svg>${legendOf(envs, thrLegend)}`;
  }

  function pieSvg(parts) {
    const total = parts.reduce((t, p) => t + p.v, 0);
    const S = 140;
    const c = S / 2;
    const r = c - 2;
    let angle = -Math.PI / 2;
    let s = '';
    let labels = '';
    for (const p of parts) {
      if (!(p.v > 0)) continue;
      const share = p.v / total;
      const tip = `${p.name}\n${num(share * 100, 1)} % · ${auto(p.v)}`;
      if (share > 0.9999) s += `<circle cx="${c}" cy="${c}" r="${r}" data-tip="${esc(tip)}" style="fill:var(${p.color})"/>`;
      else {
        const end = angle + share * 2 * Math.PI;
        const large = share > 0.5 ? 1 : 0;
        const pt = (a) => `${c + r * Math.cos(a)},${c + r * Math.sin(a)}`;
        s += `<path d="M${c},${c}L${pt(angle)}A${r},${r} 0 ${large} 1 ${pt(end)}Z" data-tip="${esc(tip)}" style="fill:var(${p.color});stroke:var(--surface);stroke-width:2"/>`;
      }
      if (share >= 0.09) {
        const mid = angle + share * Math.PI;
        const lx = share > 0.9999 ? c : c + r * 0.62 * Math.cos(mid);
        const ly = share > 0.9999 ? c : c + r * 0.62 * Math.sin(mid);
        labels += `<text x="${lx}" y="${ly + 4}" text-anchor="middle" pointer-events="none" style="fill:${inkOn(p.color)};font-weight:600">${num(share * 100)} %</text>`;
      }
      angle += share * 2 * Math.PI;
    }
    return `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(parts.filter((p) => p.v > 0).map((p) => `${p.name} ${num((p.v / total) * 100)} %`).join(', '))}">${s}${labels}</svg>`;
  }

  function pieCard(parent, def, test, envs) {
    const box = card(parent, def);
    const pies = envs.map((e) => {
      const probe = agg(e.id, test, () => 0);
      if (probe.down) return `<div class="pie"><div class="pie-down">✕ cayó</div>${e.name}</div>`;
      const parts = def.parts.map(([name, color, fn]) => ({ name, color, v: agg(e.id, test, fn).v ?? 0 }));
      return `<div class="pie">${parts.some((p) => p.v > 0) ? pieSvg(parts) : '<div class="pie-down">sin datos</div>'}${e.name}</div>`;
    });
    box.innerHTML = `<div class="pies">${pies.join('')}</div><div class="lg">${def.parts.map(([n, c]) => `<span><i style="background:var(${c})"></i>${n}</span>`).join('')}</div>`;
  }

  // uPlot para líneas: ya está en el laboratorio y trae cursor sincronizado y leyenda con valores.
  const linePlot = (box, options) => pending.push(() => drawLine(box, options));
  function drawLine(box, { x, series, fmt, log, thr, xRange, xValues, xSplits, xLabel, vline, marks }) {
    const threshold = thr ?? null;
    const opts = {
      width: box.clientWidth || 500,
      height: 210,
      cursor: { sync: { key: sync.key }, drag: { x: false, y: false } },
      scales: {
        x: { time: false, range: () => xRange },
        y: log
          ? { distr: 3, log: 10, range: (u, min, max) => uPlot.rangeLog(Math.max(0.01, Math.min(min ?? 1, threshold ?? Infinity)), Math.max(max ?? 10, threshold ?? 0), 10, true) }
          : { range: (u, min, max) => [0, Math.max((max ?? 0) * 1.1, (threshold ?? 0) * 1.12, 1)] },
      },
      axes: [
        { stroke: css('--muted'), grid: { stroke: css('--grid') }, ticks: { show: false }, values: (u, v) => v.map(xValues), splits: xSplits, font: '11px system-ui' },
        { stroke: css('--muted'), grid: { stroke: css('--grid') }, ticks: { show: false }, size: 58, values: (u, v) => v.map((n) => (n == null ? '' : fmt(n))), font: '11px system-ui' },
      ],
      series: [
        { label: xLabel, value: (u, v) => (v == null ? '–' : xValues(v)) },
        ...series.map((s) => ({ label: s.label, stroke: css(s.color), width: 2, dash: s.dash ? [6, 4] : undefined, points: { show: x.length < 20, size: 7 }, value: (u, v) => (v == null ? '–' : fmt(v)) })),
      ],
      hooks: {
        draw: [(u) => {
          const { ctx, bbox } = u;
          ctx.save();
          const hline = (v) => {
            const y = u.valToPos(v, 'y', true);
            if (y < bbox.top || y > bbox.top + bbox.height) return;
            ctx.strokeStyle = css('--critical');
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(bbox.left, y);
            ctx.lineTo(bbox.left + bbox.width, y);
            ctx.stroke();
          };
          if (threshold != null) hline(threshold);
          if (vline != null) {
            const px = u.valToPos(vline, 'x', true);
            ctx.strokeStyle = css('--muted');
            ctx.setLineDash([2, 4]);
            ctx.lineWidth = devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(px, bbox.top);
            ctx.lineTo(px, bbox.top + bbox.height);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.textAlign = 'center';
          ctx.font = `600 ${12 * devicePixelRatio}px system-ui`;
          (marks ?? []).forEach((m) => {
            ctx.fillStyle = css(m.color);
            ctx.fillText('✕', u.valToPos(m.x, 'x', true), bbox.top + bbox.height - (6 + m.row * 14) * devicePixelRatio);
          });
          ctx.restore();
        }],
      },
    };
    plots.push(new uPlot(opts, [x, ...series.map((s) => s.data)], box));
  }

  // ==================== Vistas ====================
  function capacityOf(env) {
    let best = null;
    for (const t of TESTS) {
      const runs = runsOf(env, t.id);
      if (!runs.length || !runs.every((r) => r.pass)) break;
      best = t;
    }
    return best;
  }

  function renderAcross() {
    const envs = shown();
    if (!envs.length) { $('view').innerHTML = '<div class="empty">Elige al menos un entorno.</div>'; return; }
    const top = section('Barras: capacidad', 'Lo más alto que sostiene cada entorno antes del primer fallo.');
    barChart(top, {
      title: 'Capacidad sostenida',
      unit: 'usuarios a la vez',
      fmt: auto,
      hint: 'La carga más alta tal que ella y todas las menores pasan en todas sus repeticiones.',
      read: 'Es la conclusión en un solo número. Las cargas de 1.000 a 3.000 tienen una sola repetición.',
      cats: [['Usuarios', (e) => capacityOf(e.id)?.users ?? 0]],
    }, null, envs, (e, fn) => ({ v: fn(e) }));

    const lines = section('Líneas: cada entorno a través de todas las cargas', 'De izquierda a derecha sube la carga. Cada punto es la mediana de sus repeticiones, y las marcas no están a escala: se pasa de 100 a 6.000 usuarios. Un ✕ al pie indica que ahí el servidor cayó en todas las repeticiones.');
    for (const def of ACROSS) {
      const box = card(lines, def);
      const marks = [];
      const series = envs.map((e, row) => ({
        label: e.name,
        color: e.color,
        dash: e.dash,
        data: TESTS.map((t, i) => {
          const a = agg(e.id, t.id, def.get);
          if (a.down) marks.push({ x: i, row, color: e.color });
          return a.v == null || (def.log && a.v <= 0) ? null : a.v;
        }),
      }));
      linePlot(box, {
        x: TESTS.map((t, i) => i),
        series,
        fmt: def.fmt,
        log: def.log,
        thr: def.thr?.(),
        marks,
        xLabel: 'Carga',
        xRange: [-0.4, TESTS.length - 0.6],
        xValues: (i) => TESTS[Math.round(i)]?.name ?? '',
        xSplits: () => TESTS.map((t, i) => i),
      });
    }

    const table = section('Tabla: los mismos datos', '', false);
    const head = TESTS.map((t) => `<th>${t.name}</th>`).join('');
    const rows = ACROSS.flatMap((def) => envs.map((e, i) => `<tr>${i === 0 ? `<td rowspan="${envs.length}"><b>${def.title}</b></td>` : ''}<td>${e.name}</td>${TESTS.map((t) => {
      const a = agg(e.id, t.id, def.get);
      return `<td class="num">${a.down ? '✕ cayó' : a.v == null ? '–' : esc(def.fmt(a.v))}</td>`;
    }).join('')}</tr>`));
    table.innerHTML = `<div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>Métrica</th><th style="text-align:left">Entorno</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
  }

  function renderLevel(test) {
    const envs = shown(test);
    const info = TESTS.find((t) => t.id === test);
    if (!envs.length) { $('view').innerHTML = '<div class="empty">Elige al menos un entorno con resultados para esta carga.</div>'; return; }

    const bars = section(`Barras: ${info.name}, ${num(info.users)} usuarios`, 'Ventana medida de 600 s. Cada barra es la mediana de las repeticiones; la línea fina, de la menor a la mayor.');
    bars.insertAdjacentHTML('beforebegin', noteDown(envs, test));
    for (const def of BARS) barChart(bars, def, test, envs);

    const pies = section('Pasteles: de qué está hecho cada total', 'Un pastel por entorno. Pasa el cursor por una tajada para ver su valor.');
    for (const def of PIES) pieCard(pies, def, test, envs);

    const lines = section('Líneas: telemetría durante la prueba', 'Mediana de las repeticiones, cada 10 s. Cuenta desde que inicia la prueba: la línea punteada marca dónde empieza la ventana medida.');
    const runs = RUNS.filter((r) => r.test === test);
    const len = Math.max(0, ...runs.map((r) => r.series.users?.length ?? 0));
    const x = Array.from({ length: len }, (_, i) => i * 10);
    const windowAt = runs[0]?.windowFromSec;
    for (const def of TIME) {
      const series = envs.map((e) => ({
        label: e.name,
        color: e.color,
        dash: e.dash,
        data: x.map((_, i) => {
          const v = finite(runsOf(e.id, test).map((r) => r.series[def.key]?.[i]));
          const m = v.length ? median(v) : null;
          return m == null || (def.log && m <= 0) ? null : m;
        }),
      })).filter((s) => s.data.some((v) => v != null));
      if (!series.length) continue;
      linePlot(card(lines, def), {
        x,
        series,
        fmt: def.fmt,
        log: def.log,
        thr: def.thr?.(),
        vline: windowAt,
        xLabel: 'Tiempo',
        xRange: [0, Math.max(10, x.at(-1) ?? 10)],
        xValues: mmss,
      });
    }

    const rows = [
      ['Resultado', null],
      ['Usuarios conectados', (r) => r.users, auto],
      ['Mensajes/s', (r) => r.msgsOut, auto],
      ...['p50', 'p95', 'p99'].map((p) => [`REST ${p}, usuario`, lat('lat', 'rest', p), ms]),
      ...['p50', 'p95', 'p99'].map((p) => [`REST ${p}, servidor`, lat('srv', 'rest', p), ms]),
      ['Login p50, servidor', lat('srv', 'login', 'p50'), ms],
      ['Login p95, usuario', lat('lat', 'login', 'p95'), ms],
      ['Trazo p95', lat('lat', 'fanout', 'p95'), ms],
      ['Ping p99', lat('lat', 'ping', 'p99'), ms],
      ['Hilo JS promedio', res('serverMainThread'), pct],
      ['Hilo JS pico', res('serverMainThread', 'max'), pct],
      ['Servidor, CPU promedio', res('serverCpu'), pct],
      ['mongod, CPU promedio', res('mongoCpu'), pct],
      ['Máquina, CPU promedio', res('cpuTotal'), pct],
      ['Núcleo más ocupado, promedio', res('cpuHottestCore'), pct],
      ['us', res('cpuUser'), pct],
      ['sy', res('cpuSystem'), pct],
      ['wa', res('iowait'), pct],
      ['id', res('cpuIdle'), pct],
      ['st', res('steal'), pct],
      ['RES servidor pico', res('serverRssMB', 'max'), (v) => `${auto(v)} MB`],
      ['RES mongod pico', res('mongoRssMB', 'max'), (v) => `${auto(v)} MB`],
      ['Disco IOPS promedio', res('diskIops'), auto],
      ['Disco MB/s promedio', res('diskMBs'), auto],
      ['Disco %util promedio', res('diskUtil'), pct],
      ['Red entrada MB/s', res('netRxMBs'), auto],
      ['Red salida MB/s', res('netTxMBs'), auto],
      ['Frenado ms/s promedio', res('throttledMs'), auto],
    ];
    const body = rows.map(([label, fn, f]) => `<tr><td>${label}</td>${envs.map((e) => {
      if (!fn) return `<td class="num">${verdict(e.id, test, false)}</td>`;
      const a = agg(e.id, test, fn);
      if (a.down) return '<td class="num">✕ cayó</td>';
      if (a.v == null) return '<td class="num">–</td>';
      return `<td class="num">${esc(f(a.v))}${a.n > 1 ? `<small>${esc(f(a.lo))} a ${esc(f(a.hi))}</small>` : ''}</td>`;
    }).join('')}</tr>`);
    section('Tabla: todas las cifras', 'Mediana y, en gris, el rango de las repeticiones.', false).innerHTML = `<div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>Métrica</th>${envs.map((e) => `<th>${e.name}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div></div>`;
  }

  function verdict(env, test, detail = true) {
    const runs = runsOf(env, test);
    if (!runs.length) return '–';
    const passed = runs.filter((r) => r.pass).length;
    const crashed = runs.filter((r) => r.crashed);
    const died = finite(crashed.map((r) => r.diedAtSec));
    const when = died.length ? `, a los ${num(Math.min(...died))}${died.length > 1 ? `–${num(Math.max(...died))}` : ''} s` : '';
    const note = crashed.length ? `<small>cayó ${crashed.length}/${runs.length}${when}</small>` : '';
    const tag = `<span class="tag ${passed === runs.length ? 'pass' : 'fail'}">${passed === runs.length ? '✓' : '✕'} ${passed}/${runs.length}</span>`;
    return detail ? tag + note : tag;
  }

  function renderMatrix() {
    const machine = (e) => {
      const r = RUNS.find((x) => x.env === e.id);
      if (!r) return 'Sin resultados todavía';
      const cpu = r.machine ? `${r.machine.cpuModel.replace(/\(R\)|\(TM\)|Intel|CPU|@.*$/g, '').trim().replace(/\s+/g, ' ')}, ${r.machine.logicalCpus} hilos` : '';
      return r.limits ? `Cuota ${r.limits.cpu} CPU, ${num(r.limits.memMB)} MB` : cpu;
    };
    const now = (t) => (t.id === view ? ' class="now"' : '');
    const head = `<thead><tr><th>Entorno</th>${TESTS.map((t) => `<th${now(t)}>${t.name}<small>${num(t.users)} usuarios</small></th>`).join('')}</tr></thead>`;
    const body = ENVS.map((e) => `<tr><td><b>${e.name}</b><small>${esc(machine(e))}</small></td>${TESTS.map((t) => {
      const runs = runsOf(e.id, t.id);
      if (e.id !== 'aws') return `<td${now(t)}>${verdict(e.id, t.id)}</td>`;
      const remove = runs.map((r, i) => `<button class="mini remove" data-remove="${esc(r.file)}" title="Quitar ${esc(r.file)}" aria-label="Quitar la corrida ${i + 1} de ${t.name}">quitar ${runs.length > 1 ? i + 1 : ''}</button>`).join('');
      return `<td${now(t)}>${verdict(e.id, t.id).replace(/^–$/, '')}<div>${remove}<button class="mini" data-add="${t.id}" aria-label="Añadir resultado de AWS para ${t.name}">+ Añadir</button></div></td>`;
    }).join('')}</tr>`).join('');
    $('matrix').innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function renderControls() {
    $('tests').innerHTML = `<span class="label">Carga</span><div class="seg">${[{ id: ALL, name: 'Todas' }, ...TESTS].map((t) => `<button data-view="${t.id}" aria-pressed="${t.id === view}">${t.name}</button>`).join('')}</div>`;
    $('envs').innerHTML = `<span class="label">Entornos</span><div class="seg">${ENVS.map((e) => `<button class="env-toggle" data-env="${e.id}" aria-pressed="${!hidden.has(e.id)}"><i style="background:var(${e.color})"></i>${e.name}</button>`).join('')}</div>`;
  }

  function render() {
    for (const p of plots) p.destroy();
    plots = [];
    $('view').innerHTML = '';
    renderControls();
    renderMatrix();
    if (view === ALL) renderAcross();
    else renderLevel(view);
    for (const draw of pending.splice(0)) draw();
  }

  // ==================== Eventos ====================
  $('tests').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    view = b.dataset.view;
    history.replaceState(null, '', view === ALL ? location.pathname : `#${view}`);
    render();
  });
  $('envs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-env]');
    if (!b) return;
    const id = b.dataset.env;
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    render();
  });

  const say = (text, error = false) => {
    $('aws-msg').textContent = text;
    $('aws-msg').classList.toggle('error', error);
  };
  async function load() {
    const r = await fetch('api/comparar');
    if (!r.ok) throw new Error(`Error ${r.status}`);
    RUNS = (await r.json()).runs;
  }

  // El archivo manda: un botón de carga solo confirma que el archivo sea de esa carga.
  let forTest = null;
  async function upload(files) {
    const lines = [];
    let failed = false;
    for (const f of files) {
      const r = await fetch(`api/comparar/aws${forTest ? `?test=${encodeURIComponent(forTest)}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (r.ok) lines.push(`✓ ${f.name}: añadido a ${TESTS.find((t) => t.id === j.test)?.name}`);
      else {
        failed = true;
        lines.push(`✕ ${f.name}: ${j.error ?? `error ${r.status}`}`);
      }
    }
    say(lines.join('\n'), failed);
    await load();
    render();
  }
  const pick = (test) => {
    forTest = test;
    $('aws-file').click();
  };
  $('aws-add').addEventListener('click', () => pick(null));
  $('aws-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await upload(files);
  });
  $('matrix').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return pick(add.dataset.add);
    const rm = e.target.closest('[data-remove]');
    if (rm && confirm(`¿Quitar ${rm.dataset.remove} de la comparación? El archivo se borra de resultados/.`)) {
      const r = await fetch(`api/comparar/aws/${encodeURIComponent(rm.dataset.remove)}`, { method: 'DELETE' });
      if (r.ok) say('Resultado quitado.');
      else say((await r.json().catch(() => ({}))).error ?? `Error ${r.status}`, true);
      await load();
      render();
    }
  });

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    $('tip').hidden = !el;
    if (el) $('tip').textContent = el.dataset.tip;
  });
  document.addEventListener('mousemove', (e) => {
    if ($('tip').hidden) return;
    const r = $('tip').getBoundingClientRect();
    $('tip').style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
    $('tip').style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
  });

  let resizeTimer;
  let lastWidth = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth === lastWidth) return;
    lastWidth = innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  $('view').innerHTML = '<div class="empty">Leyendo las corridas…</div>';
  load().then(render).catch((err) => {
    $('view').innerHTML = `<div class="empty">No se pudieron leer los resultados (${esc(err.message)}). Si el laboratorio ya estaba abierto, reinícialo para que cargue esta página.</div>`;
  });
})();
