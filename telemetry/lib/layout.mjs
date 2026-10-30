// Reparte a los usuarios virtuales en tableros: clases (1 presentador + espectadores),
// equipos (colaboradores) y personas solas. El reparto es "estable por prefijo": los
// primeros N usuarios siempre forman los mismos grupos, así subir de 250 a 375 usuarios
// agrega grupos nuevos sin mover a nadie de su tablero.
//
// profile.groups = [{ type: 'class'|'team'|'solo', count, size }]   (un "bloque")
// profile.then   = grupos que se agregan después del primer bloque (p. ej. clases que llegan tarde)
// profile.repeat = true: el bloque se repite (cargas grandes y prueba de capacidad)

/** Intercala los grupos de un bloque para que cualquier parte del bloque tenga la misma mezcla. */
function interleave(groups) {
  const left = groups.map((g) => ({ ...g, placed: 0 }));
  const total = left.reduce((s, g) => s + g.count, 0);
  const out = [];
  for (let k = 0; k < total; k++) {
    // El tipo que va más atrasado respecto a su proporción.
    const next = left.filter((g) => g.placed < g.count).sort((a, b) => a.placed / a.count - b.placed / b.count)[0];
    next.placed++;
    out.push({ type: next.type, size: next.type === 'solo' ? 1 : next.size });
  }
  return out;
}

/** Lista de usuarios: [{ board, role }] para los primeros `max` usuarios. */
export function buildLayout(profile, max) {
  const block = interleave(profile.groups);
  const tail = profile.then ? interleave(profile.then) : [];
  const groups = [];
  let users = 0;
  const push = (g) => {
    groups.push(g);
    users += g.size;
  };
  for (const g of block) push(g);
  for (const g of tail) push(g);
  while (profile.repeat && users < max) for (const g of block) push(g);

  const slots = [];
  groups.forEach((g, board) => {
    for (let m = 0; m < g.size; m++) {
      const role = g.type === 'class' ? (m === 0 ? 'presenter' : 'viewer') : 'collaborator';
      slots.push({ board, role, group: g.type });
    }
  });
  return slots.slice(0, max);
}

/** Resumen para mostrar: cuántos tableros y de qué tipo forman los primeros n usuarios. */
export function describe(slots, n) {
  const seen = new Map();
  for (const s of slots.slice(0, n)) seen.set(s.board, s.group);
  const c = { class: 0, team: 0, solo: 0 };
  for (const t of seen.values()) c[t]++;
  return { boards: seen.size, classes: c.class, teams: c.team, solos: c.solo };
}

// Comprobación rápida: node lib/layout.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const mediana = { groups: [{ type: 'class', count: 4, size: 30 }, { type: 'team', count: 22, size: 5 }, { type: 'solo', count: 20 }], repeat: true };
  const s = buildLayout(mediana, 1000);
  const d250 = describe(s, 250);
  const d1000 = describe(s, 1000);
  console.assert(s.length === 1000, 'longitud');
  console.assert(d250.classes === 4 && d250.teams === 22 && d250.solos === 20, JSON.stringify(d250));
  console.assert(d1000.classes === 16 && d1000.teams === 88 && d1000.solos === 80, JSON.stringify(d1000));
  console.assert(s.filter((x) => x.role === 'presenter').length === 16, 'presentadores');
  console.log('ok', d250, d1000, describe(s, 375));
}
