// Dónde está el servidor Shareboard que se mide.
//   - En el PC de desarrollo: ../server (el repo real, junto a analitics/).
//   - En un clon del repo de análisis (p. ej. en EC2): servidor/ (copia exacta del código medido).
//   - SHAREBOARD_SERVER=<ruta> manda sobre ambos.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVER =
  process.env.SHAREBOARD_SERVER ?? [resolve(ROOT, '../server'), resolve(ROOT, 'servidor')].find((p) => existsSync(resolve(p, 'package.json'))) ?? resolve(ROOT, 'servidor');
