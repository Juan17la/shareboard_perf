// Interfaz del laboratorio. Script clásico: también funciona abriendo index.html sin servidor
// (en ese caso solo sirve "Abrir archivo" para reproducir corridas).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
  const avg = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const sync = uPlot.sync('t');

  // ======================================================================
  // Tablero: el mismo para en vivo y para reproducir un archivo
  // ======================================================================
  const LAT_OPS = { fanout: 'Trazo terminado a los demás', preview: 'Trazo en curso (preview)', list: 'Listar tableros', join: 'Unirse a tablero', login: 'Login', ping: 'Ping', create: 'Crear tablero' };
  const SRV_ROUTES = { list: 'Listar tableros', join: 'Unirse', login: 'Login', create: 'Crear tablero' };
  const LAT_THR = { login: 'loginP95', list: 'restP95', join: 'restP95', create: 'restP95', fanout: 'fanoutP95', preview: 'previewP95', ping: 'pingP99' };
  const busiest = (a) => Object.values(a?.net?.ifaces ?? {}).reduce((b, d) => (d.txMBs + d.rxMBs > b.txMBs + b.rxMBs ? d : b), { txMBs: 0, rxMBs: 0 });
  const sumDisk = (a, k) => Object.values(a?.disks ?? {}).reduce((s, d) => s + (d[k] ?? 0), 0);

  function Dashboard(host, { live }) {
    const root = $('dash').content.firstElementChild.cloneNode(true);
    host.innerHTML = '';
    host.appendChild(root);
    const q = (c) => root.querySelector(c);
    if (live) q('.player').hidden = true;

    const S = { t0: null, meta: null, machine: null, rows: new Map(), steps: [], events: [], end: null, maxSec: 0, cores: 0, dirty: true };
    const view = { op: 'fanout', route: 'list' };
    let X = [];
    let R = [];
    let pos = 0;
    let playing = false;
    let built = false;
    let lastDrawn = -1;
    const plots = [];

    const secOf = (ts) => Math.max(0, Math.round((ts - S.t0) / 1000));
    const thr = () => S.meta?.profile?.thresholds ?? {};
    const base = () => S.meta?.baseRttMs ?? 0;

    function ingest(rec) {
      const ts = rec.ts ?? rec.ats;
      if (ts == null) return;
      if (S.t0 == null || rec.t === 'meta') S.t0 = S.t0 == null ? ts : Math.min(S.t0, ts);
      S.dirty = true;
      const row = (sec) => {
        let r = S.rows.get(sec);
        if (!r) S.rows.set(sec, (r = {}));
        if (sec > S.maxSec) S.maxSec = sec;
        return r;
      };
      if (rec.t === 'meta') S.meta = rec;
      else if (rec.t === 'machine' || rec.t === 'agent-info') S.machine = rec.info;
      else if (rec.t === 'load') row(secOf(ts)).load = rec;
      else if (rec.t === 'agent') {
        row(secOf(ts)).agent = rec.s;
        S.cores = Math.max(S.cores, rec.s.cores?.length ?? 0);
      } else if (rec.t === 'step') S.steps.push(rec);
      else if (rec.t === 'event') S.events.push(rec);
      else if (rec.t === 'end') S.end = rec;
    }

    // ---------- gráficas: una idea por gráfica, una línea que explica qué mide ----------
    const pct = (src, key) => [
      { label: 'p50', color: '--p50', get: (r) => src(r)?.[key()]?.p50 },
      { label: 'p95', color: '--p95', get: (r) => src(r)?.[key()]?.p95 },
      { label: 'p99', color: '--p99', get: (r) => src(r)?.[key()]?.p99 },
    ];
    const CHARTS = [
      { title: 'Usuarios', unit: 'usuarios', hint: 'Objetivo del escalón y usuarios realmente conectados.', series: [
        { label: 'Objetivo', color: '--s1', dash: true, get: (r) => r.load?.users.target },
        { label: 'Conectados', color: '--s2', get: (r) => r.load?.users.sockets },
      ] },
      { title: 'Qué están haciendo', unit: 'usuarios', hint: 'Cuántos usuarios hay en cada estado del flujo realista.', series: [
        { label: 'Mirando', color: '--s1', get: (r) => r.load?.states?.watch },
        { label: 'Cursor', color: '--s2', get: (r) => r.load?.states?.cursor },
        { label: 'Dibujando', color: '--s3', get: (r) => r.load?.states?.draw },
        { label: 'Moviendo', color: '--s4', get: (r) => r.load?.states?.move },
      ] },
      { title: 'Tiempo real recibido', unit: 'mensajes/s', hint: 'Lo que el servidor reenvía a los clientes: crece con el tamaño de cada tablero.', series: [
        { label: 'Cursores', color: '--s1', get: (r) => r.load?.ws.cursorsIn },
        { label: 'Previews', color: '--s2', get: (r) => r.load?.ws.previewsIn },
        { label: 'Total', color: '--s3', get: (r) => r.load?.ws.in },
      ] },
      { title: 'Latencia del usuario', unit: 'ms', select: ['op', LAT_OPS], hint: 'Lo que espera el usuario, incluida la red. Línea roja: límite.',
        threshold: () => (thr()[LAT_THR[view.op]] != null ? thr()[LAT_THR[view.op]] + base() : null),
        series: pct((r) => r.load?.ops, () => view.op) },
      { title: 'Latencia dentro del servidor', unit: 'ms', select: ['route', SRV_ROUTES], hint: 'Sin la red: sirve para comparar máquinas de forma justa.',
        series: pct((r) => r.agent?.srv, () => view.route) },
      { title: 'Errores', unit: 'por segundo', hint: 'Peticiones o mensajes que fallaron.', series: [
        { label: 'Errores', color: '--s2', get: (r) => r.load?.errors },
      ] },
      { title: 'CPU del servidor por hilo', unit: '% de un núcleo', hint: '100 = un núcleo entero. El hilo de JavaScript no puede pasar de 100.', threshold: () => 100, series: [
        { label: 'Hilo JavaScript', color: '--s1', get: (r) => r.agent?.server?.threads?.main },
        { label: 'libuv (scrypt)', color: '--s2', get: (r) => r.agent?.server?.threads?.['libuv-worker'] },
        { label: 'V8 (GC, JIT)', color: '--s3', get: (r) => { const t = r.agent?.server?.threads; return t ? Object.entries(t).reduce((s, [k, v]) => (k === 'main' || k === 'libuv-worker' ? s : s + v), 0) : null; } },
        { label: 'mongod', color: '--s4', get: (r) => r.agent?.mongo?.cpu },
      ] },
      { title: 'CPU de la máquina', unit: '% del total', hint: 'iowait: esperando al disco. steal: la nube nos quita CPU.', series: [
        { label: 'Usuario', color: '--s1', get: (r) => r.agent?.cpu.user },
        { label: 'Sistema', color: '--s2', get: (r) => r.agent?.cpu.system },
        { label: 'iowait', color: '--s3', get: (r) => r.agent?.cpu.iowait },
        { label: 'steal', color: '--s4', get: (r) => r.agent?.cpu.steal },
      ] },
      { title: 'Memoria residente', unit: 'MB', hint: 'Memoria física realmente usada. Línea roja: límite del contenedor.',
        threshold: () => R.find((r) => r.agent?.cgroup?.memLimitMB)?.agent.cgroup.memLimitMB ?? null,
        series: [
          { label: 'Servidor', color: '--s1', get: (r) => r.agent?.cgroup?.memMB ?? r.agent?.server?.rssMB },
          { label: 'mongod', color: '--s2', get: (r) => r.agent?.mongo?.rssMB },
        ] },
      { title: 'Disco', unit: 'operaciones/s', hint: 'Lecturas y escrituras al disco por segundo (IOPS).', series: [
        { label: 'Lectura', color: '--s1', get: (r) => r.agent && sumDisk(r.agent, 'readIops') },
        { label: 'Escritura', color: '--s2', get: (r) => r.agent && sumDisk(r.agent, 'writeIops') },
      ] },
      { title: 'Red', unit: 'MB/s', hint: 'Tráfico de la interfaz más usada.', series: [
        { label: 'Entrada', color: '--s1', get: (r) => (r.agent ? busiest(r.agent).rxMBs : null) },
        { label: 'Salida', color: '--s2', get: (r) => (r.agent ? busiest(r.agent).txMBs : null) },
      ] },
      { title: 'Contenedor frenado', unit: 'ms por segundo', hint: 'Tiempo que el kernel frenó al contenedor por agotar su cuota de CPU (sumado entre núcleos: puede pasar de 1.000).', only: () => R.some((r) => r.agent?.cgroup), series: [
        { label: 'Servidor', color: '--s1', get: (r) => r.agent?.cgroup?.throttledMs },
      ] },
    ];

    function rebuild() {
      if (!S.dirty) return;
      S.dirty = false;
      X = [];
      R = [];
      for (let s = 0; s <= S.maxSec; s++) {
        X.push(s);
        R.push(S.rows.get(s) ?? {});
      }
    }

    function stepBands(u) {
      const { left, top, width, height } = u.bbox;
      u.ctx.save();
      u.ctx.globalAlpha = 0.5;
      for (const st of S.steps) {
        const a = Math.max(left, u.valToPos(secOf(st.start), 'x', true));
        const b = Math.min(left + width, u.valToPos(secOf(st.end), 'x', true));
        u.ctx.fillStyle = css(st.pass ? '--band-pass' : '--band-fail');
        u.ctx.fillRect(a, top, b - a, height);
      }
      u.ctx.restore();
    }
    const thresholdLine = (def) => (u) => {
      const v = def.threshold?.();
      if (v == null) return;
      const y = u.valToPos(v, 'y', true);
      if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
      u.ctx.save();
      u.ctx.strokeStyle = css('--critical');
      u.ctx.setLineDash([6, 4]);
      u.ctx.lineWidth = devicePixelRatio;
      u.ctx.beginPath();
      u.ctx.moveTo(u.bbox.left, y);
      u.ctx.lineTo(u.bbox.left + u.bbox.width, y);
      u.ctx.stroke();
      u.ctx.restore();
    };

    function build() {
      rebuild();
      const grid = q('.charts');
      grid.innerHTML = '';
      plots.length = 0;
      const defs = CHARTS.filter((d) => !d.only || d.only());
      for (const def of defs) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<div class="card-h"><h3>${def.title} <span class="unit">${def.unit}</span></h3></div><div class="hint">${def.hint}</div><div class="plot"></div>`;
        if (def.select) {
          const [key, opts] = def.select;
          const sel = document.createElement('select');
          sel.innerHTML = Object.entries(opts).map(([k, v]) => `<option value="${k}" ${k === view[key] ? 'selected' : ''}>${v}</option>`).join('');
          sel.onchange = () => { view[key] = sel.value; draw(true); };
          card.querySelector('.card-h').appendChild(sel);
        }
        grid.appendChild(card);
        def.box = card.querySelector('.plot');
      }
      for (const def of defs) {
        def.plot = new uPlot({
          width: def.box.clientWidth || 500,
          height: 190,
          cursor: { sync: { key: sync.key }, drag: { x: false, y: false } },
          scales: { x: { time: false, range: () => [0, Math.max(1, S.maxSec)] }, y: { range: (u, min, max) => [0, Math.max((max ?? 0) * 1.1, (def.threshold?.() ?? 0) * 1.15, 1)] } },
          axes: [
            { stroke: css('--muted'), grid: { stroke: css('--grid') }, ticks: { show: false }, values: (u, v) => v.map(mmss), font: '11px system-ui' },
            { stroke: css('--muted'), grid: { stroke: css('--grid') }, ticks: { show: false }, size: 50, values: (u, v) => v.map((x) => fmt(x)), font: '11px system-ui' },
          ],
          series: [{ label: 'Tiempo', value: (u, v) => (v == null ? '–' : mmss(v)) }, ...def.series.map((s) => ({ label: s.label, stroke: css(s.color), width: 2, dash: s.dash ? [5, 4] : undefined, // Series con pocos datos (p. ej. un servidor saturado que casi no responde) se ven como puntos.
            points: { size: 5, show: (u, si) => u.data[si].reduce((n, v) => n + (v != null), 0) < 150 }, value: (u, v) => fmt(v) }))],
          hooks: { drawClear: [stepBands], draw: [thresholdLine(def)] },
        }, [[], ...def.series.map(() => [])], def.box);
        plots.push(def);
      }
      built = true;
      lastDrawn = -1;
    }

    function draw(force = false) {
      if (S.t0 == null) return;
      if (!built) build();
      // Una gráfica condicional (contenedor) aparece cuando llegan sus datos.
      if (S.dirty && CHARTS.some((d) => d.only && !d.plot && (rebuild(), d.only()))) build();
      rebuild();
      const end = live ? S.maxSec : Math.min(Math.floor(pos), S.maxSec);
      if (!force && end === lastDrawn) return;
      lastDrawn = end;
      const n = end + 1;
      for (const def of plots) {
        const data = [X.slice(0, n)];
        for (const s of def.series) {
          const col = new Array(n);
          for (let i = 0; i < n; i++) { const v = s.get(R[i]); col[i] = v == null || Number.isNaN(v) ? null : v; }
          data.push(col);
        }
        def.plot.setData(data, true);
      }
      drawHeat(end);
      drawBands();
      kpis(end);
      steps(end);
      info();
      q('.seek').max = String(S.maxSec);
      q('.seek').value = String(end);
      q('.clock').textContent = live ? mmss(end) : `${mmss(end)} / ${mmss(S.maxSec)}`;
    }

    function drawHeat(end) {
      const cv = q('.heat');
      const rows = S.cores || 1;
      const rowH = rows > 24 ? 6 : 9;
      const w = cv.clientWidth;
      const labelW = 30;
      cv.width = w * devicePixelRatio;
      cv.height = rows * rowH * devicePixelRatio;
      cv.style.height = `${rows * rowH}px`;
      const ctx = cv.getContext('2d');
      ctx.scale(devicePixelRatio, devicePixelRatio);
      const colW = (w - labelW) / Math.max(1, S.maxSec + 1);
      const rgb = css('--heat');
      for (let i = 0; i <= end; i++) {
        const c = R[i]?.agent?.cores;
        if (!c) continue;
        for (let k = 0; k < c.length; k++) {
          ctx.fillStyle = `rgba(${rgb}, ${Math.min(1, (c[k] ?? 0) / 100)})`;
          ctx.fillRect(labelW + i * colW, k * rowH, Math.ceil(colW), rowH - 1);
        }
      }
      ctx.fillStyle = css('--muted');
      ctx.font = '9px system-ui';
      ctx.textBaseline = 'middle';
      const topo = S.machine?.topology;
      for (let k = 0; k < rows; k += rows > 24 ? 4 : 1) {
        const f = topo?.[k]?.maxMHz;
        const tag = f ? (f >= 4000 ? 'P' : f >= 3000 ? 'E' : 'LP') : '';
        ctx.fillText(`${k}${tag}`, 0, k * rowH + rowH / 2);
      }
    }
    q('.heat').addEventListener('mousemove', (e) => {
      const r = e.target.getBoundingClientRect();
      const rowH = (S.cores || 1) > 24 ? 6 : 9;
      const sec = Math.floor(((e.clientX - r.left - 30) / (r.width - 30)) * (S.maxSec + 1));
      const core = Math.floor((e.clientY - r.top) / rowH);
      const v = R[sec]?.agent?.cores?.[core];
      q('.heat-hint').textContent = v == null ? 'Cada fila es un núcleo. Más oscuro = más ocupado.' : `Núcleo ${core} · ${mmss(sec)} · ${fmt(v, 0)} % ocupado`;
    });

    function drawBands() {
      const cv = q('.bands');
      const w = cv.clientWidth;
      if (!w) return;
      cv.width = w * devicePixelRatio;
      cv.height = 24 * devicePixelRatio;
      const ctx = cv.getContext('2d');
      ctx.scale(devicePixelRatio, devicePixelRatio);
      const total = Math.max(1, S.maxSec);
      ctx.font = '10px system-ui';
      ctx.textBaseline = 'middle';
      for (const st of S.steps) {
        const x = (secOf(st.start) / total) * w;
        const bw = ((secOf(st.end) - secOf(st.start)) / total) * w;
        ctx.fillStyle = css(st.pass ? '--band-pass' : '--band-fail');
        ctx.fillRect(x, 0, bw - 1, 24);
        if (bw > 26) {
          ctx.fillStyle = css('--text-2');
          ctx.fillText(String(st.users), x + 4, 12);
        }
      }
    }

    function kpis(end) {
      const win = R.slice(Math.max(0, end - 4), end + 1);
      const mean = (f) => avg(win.map(f));
      const t = thr();
      const b = base();
      const genBusy = mean((r) => (r.load ? Math.max(0, ...r.load.gen.elu) : null));
      const items = [
        ['Usuarios', mean((r) => r.load?.users.sockets), '', 0],
        ['p95 difusión', mean((r) => r.load?.ops.fanout?.p95), 'ms', 1, t.fanoutP95 != null ? t.fanoutP95 + b : null],
        ['p95 preview', mean((r) => r.load?.ops.preview?.p95), 'ms', 1, t.previewP95 != null ? t.previewP95 + b : null],
        ['p95 listar', mean((r) => r.load?.ops.list?.p95), 'ms', 1, t.restP95 != null ? t.restP95 + b : null],
        ['Errores', mean((r) => r.load?.errors), '/s', 1, 0.5],
        ['Hilo JS', mean((r) => r.agent?.server?.threads?.main), '%', 0, 90],
        ['RSS servidor', mean((r) => r.agent?.cgroup?.memMB ?? r.agent?.server?.rssMB), 'MB', 0],
        ['Disco', mean((r) => r.agent && sumDisk(r.agent, 'readIops') + sumDisk(r.agent, 'writeIops')), 'IOPS', 0],
      ];
      q('.kpis').innerHTML =
        items.map(([label, v, unit, d, limit]) => `<div class="kpi ${limit != null && v != null && v > limit ? 'over' : ''}"><b>${label}</b><span>${fmt(v, d)}</span><small>${unit}</small></div>`).join('') +
        (genBusy > 0.85 ? '<div class="kpi over"><b>Generador</b><span>saturado</span><small>no válido</small></div>' : '');
    }

    function steps(end) {
      const tb = q('.steps tbody');
      tb.innerHTML = S.steps
        .map((s, i) => {
          const a = secOf(s.start);
          const cur = end >= a && end <= secOf(s.end);
          const tag = s.invalid ? '<span class="tag neutral">no válido</span>' : s.pass ? '<span class="tag pass">✓ pasa</span>' : '<span class="tag fail">✕ no pasa</span>';
          return `<tr data-sec="${a}" class="${cur ? 'current' : ''}"><td class="num">${i + 1}</td>
            <td class="num">${s.users}</td><td class="num">${s.layout?.boards ?? '–'}</td><td>${tag}</td>
            <td class="num">${fmt(s.lat.rest?.p95)} ms</td><td class="num">${fmt(s.lat.fanout?.p95)} ms</td><td class="num">${fmt(s.lat.preview?.p95)} ms</td>
            <td class="num">${fmt(s.errorRate, 2)} %</td><td class="num">${fmt(s.res?.serverMainThread?.avg, 0)} %</td>
            <td class="num">${fmt(s.res?.serverRssMB?.max, 0)} MB</td><td class="reasons">${esc(s.reasons.join(' · ') || '–')}</td></tr>`;
        })
        .join('');
    }
    q('.steps').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sec]');
      if (tr && !live) seek(Number(tr.dataset.sec));
    });

    function info() {
      const m = S.meta;
      const mc = S.machine;
      const o = S.end?.outcome;
      let result = 'en curso';
      if (S.end) result = o?.maxGoodUsers != null ? `<b class="big">${o.maxGoodUsers}</b> usuarios con buen rendimiento` : `${S.steps.filter((s) => s.pass).length}/${S.steps.length} escalones pasan`;
      else if (!live) result = 'incompleta';
      q('.runinfo').innerHTML = [
        ['Prueba', m?.profile?.name ?? '–'],
        ['Entorno', m?.env ?? '–'],
        ['Máquina', mc ? `${esc(mc.cpuModel ?? '')} · ${mc.logicalCpus} hilos · ${fmt(mc.memTotalMB / 1024, 0)} GB` : '–'],
        ['Inicio', S.t0 ? new Date(S.t0).toLocaleString('es-CO') : '–'],
        ['Resultado', result],
      ].map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
    }

    // ---------- reproducción ----------
    function seek(sec) {
      pos = Math.max(0, Math.min(sec, S.maxSec));
      draw();
    }
    q('.seek').addEventListener('input', (e) => seek(Number(e.target.value)));
    q('.play').addEventListener('click', () => {
      if (pos >= S.maxSec) pos = 0;
      playing = !playing;
      q('.play').textContent = playing ? '❚❚' : '▶';
    });
    let last = performance.now();
    let alive = true;
    (function frame(now) {
      if (!alive) return;
      const dt = (now - last) / 1000;
      last = now;
      if (playing) {
        pos += dt * Number(q('.speed').value);
        if (pos >= S.maxSec) { pos = S.maxSec; playing = false; q('.play').textContent = '▶'; }
      }
      if (S.t0 != null && (playing || (live && S.dirty))) draw(live);
      requestAnimationFrame(frame);
    })(performance.now());

    addEventListener('resize', () => {
      for (const def of plots) def.plot.setSize({ width: def.box.clientWidth, height: 190 });
      draw(true);
    });

    return {
      ingest,
      loadText(text) {
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { ingest(JSON.parse(line)); } catch {}
        }
        if (S.t0 == null) return false;
        draw(true);
        return true;
      },
      destroy() { alive = false; },
    };
  }

  // ======================================================================
  // Pestañas
  // ======================================================================
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.onclick = () => {
      for (const o of document.querySelectorAll('[data-tab]')) o.setAttribute('aria-selected', String(o === b));
      $('tab-lab').hidden = b.dataset.tab !== 'lab';
      $('tab-results').hidden = b.dataset.tab !== 'results';
      if (b.dataset.tab === 'results') loadRuns();
      dispatchEvent(new Event('resize'));
    };
  }

  // ======================================================================
  // Resultados
  // ======================================================================
  let replay = null;
  function openReplay(text) {
    replay?.destroy();
    replay = Dashboard($('replay'), { live: false });
    if (!replay.loadText(text)) alert('El archivo no tiene datos de telemetría.');
  }
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) openReplay(await f.text());
    e.target.value = '';
  });
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    document.querySelector('[data-tab="results"]').click();
    openReplay(await f.text());
  });
  async function loadRuns() {
    if (!online) return;
    const { runs } = await fetch('api/runs').then((r) => r.json());
    $('runs').querySelector('tbody').innerHTML =
      runs
        .map((r) => {
          const [stamp, env, test] = r.file.replace('.ndjson', '').split('_');
          const when = `${stamp.slice(6, 8)}/${stamp.slice(4, 6)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}`;
          const o = r.outcome;
          const res = !o ? '<span class="muted">incompleta</span>' : o.maxGoodUsers != null ? `${o.maxGoodUsers} usuarios` : `${o.passed}/${o.steps} pasan`;
          return `<tr data-file="${esc(r.file)}"><td>${when}</td><td>${esc(env ?? '')}</td><td>${esc(test ?? '')}</td><td>${res}</td><td class="num">${fmt(r.bytes / 2 ** 20, 1)} MB</td></tr>`;
        })
        .join('') || '<tr><td colspan="5" class="muted">Todavía no hay corridas.</td></tr>';
  }
  $('runs').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-file]');
    if (!tr) return;
    for (const o of $('runs').querySelectorAll('tr')) o.classList.toggle('current', o === tr);
    openReplay(await fetch(`api/runs/${encodeURIComponent(tr.dataset.file)}`).then((r) => r.text()));
  });

  // ======================================================================
  // Laboratorio
  // ======================================================================
  const online = location.protocol.startsWith('http');
  if (!online) {
    document.querySelector('[data-tab="results"]').click();
    document.querySelector('[data-tab="lab"]').disabled = true;
    return;
  }
  let config = null;
  let st = {};
  let liveDash = null;
  let selMode = localStorage.getItem('lab.mode') || 'native';
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert(j.error ?? `Error ${r.status}`);
    });

  function renderModes() {
    const modes = { ...config.modes, remote: 'Nube (EC2)' };
    $('modes').innerHTML = Object.entries(modes).map(([k, v]) => `<button data-mode="${k}" aria-pressed="${k === selMode}">${v}</button>`).join('');
    $('remote-fields').hidden = selMode !== 'remote';
  }
  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || st.busy) return;
    selMode = b.dataset.mode;
    localStorage.setItem('lab.mode', selMode);
    renderModes();
  });
  $('r-host').value = localStorage.getItem('lab.host') ?? '';
  $('r-token').value = localStorage.getItem('lab.token') ?? '';
  $('prepare').onclick = () => {
    const host = $('r-host').value.trim();
    const token = $('r-token').value.trim();
    localStorage.setItem('lab.host', host);
    localStorage.setItem('lab.token', token);
    post('api/prepare', { mode: selMode, host, token });
  };
  $('reset').onclick = () => confirm('¿Borrar la base de datos de pruebas y crearla de nuevo? Las corridas guardadas no se tocan.') && post('api/reset');
  $('quick').checked = localStorage.getItem('lab.quick') === '1';
  $('quick').onchange = () => { localStorage.setItem('lab.quick', $('quick').checked ? '1' : '0'); renderTests(); };

  function renderChecks() {
    const s = st.status ?? {};
    const item = (ok, label, detail) => `<li class="${ok ? 'ok' : st.busy === 'preparing' ? 'wait' : 'off'}"><i></i>${label}<span>${detail}</span></li>`;
    $('checks').innerHTML = [
      item(s.mongo, 'MongoDB', s.mongo ? 'conectado' : '–'),
      item(s.server, 'Servidor', s.server ? (st.mode === 'remote' ? st.remote?.host : config.modes[st.mode] ?? '') : '–'),
      item(s.agent, 'Agente', s.agent ? '1 muestra/s' : '–'),
      item(s.seed > 0 || (st.ready && st.mode === 'remote'), 'Datos de prueba', s.seed ? `${fmt(s.seed, 0)} cuentas` : '–'),
    ].join('');
    $('prepare').disabled = !!st.busy;
    $('prepare').textContent = st.busy === 'preparing' ? 'Preparando…' : st.ready && st.mode === selMode ? 'Volver a preparar' : 'Preparar';
    $('reset').hidden = !st.mode || st.mode === 'remote';
    $('reset').disabled = !!st.busy;
  }

  function renderTests() {
    const quick = $('quick').checked;
    const running = st.test;
    $('tests').innerHTML = config.tests
      .map((t) => `<li><div><b>${t.name}</b><span class="dur">${quick ? t.quick : t.normal}</span><p>${t.question}</p></div>
        <button class="btn" data-test="${t.id}" ${!st.ready || st.busy ? 'disabled' : ''}>${running?.id === t.id ? 'Corriendo…' : 'Correr'}</button></li>`)
      .join('');
    const r = $('running');
    r.hidden = !running;
    if (running) {
      const p = running.progress;
      const el = p?.startedAt ? mmss((Date.now() - p.startedAt) / 1000) : '';
      const what = !p ? 'Reiniciando el servidor…' : p.rest ? `Pausa: todos salen (${p.sec} s)` : `Escalón ${p.step} · ${p.users} usuarios en ${p.layout?.boards ?? '?'} tableros · ${el} de ${mmss(p.sec)}`;
      r.innerHTML = `<div><b>${running.name}${running.quick ? ' (rápida)' : ''}</b><span>${what}</span></div><button class="btn danger" id="stop">Detener</button>`;
      $('stop').onclick = () => post('api/stop');
    }
  }
  $('tests').addEventListener('click', (e) => {
    const b = e.target.closest('[data-test]');
    if (b) post('api/test', { id: b.dataset.test, quick: $('quick').checked });
  });
  setInterval(() => st.test && renderTests(), 1000);

  function addLog(line) {
    const pre = $('log');
    pre.textContent += line + '\n';
    if (pre.textContent.length > 60_000) pre.textContent = pre.textContent.slice(-40_000);
    pre.scrollTop = pre.scrollHeight;
    $('lastlog').textContent = line.slice(10);
    $('logbox').classList.toggle('error', /ERROR/.test(line));
  }

  fetch('api/config')
    .then((r) => r.json())
    .then((c) => {
      config = c;
      renderModes();
      const es = new EventSource('api/events');
      es.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.kind === 'state') {
          const wasBusy = st.busy;
          st = m.state;
          if (st.mode && !wasBusy && st.busy === 'preparing') $('logbox').open = true;
          renderChecks();
          renderTests();
        } else if (m.kind === 'log') addLog(m.line);
        else if (m.kind === 'logs') { $('log').textContent = ''; m.lines.forEach(addLog); }
        else if (m.kind === 'test-begin') {
          liveDash?.destroy();
          $('live-empty').hidden = true;
          liveDash = Dashboard($('live'), { live: true });
        } else if (m.kind === 'rec') liveDash?.ingest(m.rec);
        else if (m.kind === 'runs-changed' && !$('tab-results').hidden) loadRuns();
      };
    });
})();
