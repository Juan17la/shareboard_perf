// Genera ../presentacion.html a partir de template.html + datos.json (medianas por entorno/prueba, antes y después)
import fs from 'node:fs';
const d = fs.readFileSync(new URL('./datos.json', import.meta.url), 'utf8');
const t = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
fs.writeFileSync(new URL('../presentacion.html', import.meta.url), t.replace('__DATA__', d));
