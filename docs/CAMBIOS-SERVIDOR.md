# Cambios en el servidor para aumentar la capacidad

Qué se cambió en `server/`, cómo era antes y por qué. Los cambios salen de las conclusiones de [FINAL-REPORT.md](FINAL-REPORT.md): el límite principal es el hilo único de JavaScript en el tiempo real.

> **Estado.** Los cambios están en la rama `develop` de `server/`. Las cifras de esta página son una verificación rápida en el PC, no una campaña oficial. Falta repetir las pruebas; ver [Repetir las pruebas](#repetir-las-pruebas).

## Dónde se iba la CPU

Antes de cambiar nada se perfiló el servidor con 3.000 usuarios:

| Trabajo en el hilo principal | % del tiempo ocupado |
|---|---|
| **`writev`: una llamada al kernel por mensaje y por destinatario** | **46 %** |
| `send`, que incluye `JSON.stringify` | 7 % |
| `onPreview` + `onCursor` | 8 % |
| Recolección de basura | 2 % |

El costo principal no era construir los mensajes, sino **escribirlos uno por uno en los sockets**. Por eso el cambio de mayor efecto en un solo proceso es agrupar escrituras.

## Resumen

| # | Cambio | Antes | Ahora | Se activa |
|---|---|---|---|---|
| 1 | Validar el PIN | scrypt síncrono: congelaba el hilo ~45 ms | HMAC con `TOKEN_SECRET` (~0,003 ms); los PIN viejos se actualizan al entrar | Siempre |
| 2 | Escribir en los sockets | Un `writev` por mensaje y destinatario | Una escritura por socket por vuelta del event loop, sin espera | Siempre (`BROADCAST_FLUSH_MS` añade espera) |
| 3 | Serializar y decodificar | `JSON.stringify` por destinatario; `raw.toString()` dos veces | Una vez por difusión y por mensaje | Siempre |
| 4 | Procesos de Node | Uno solo | Varios, cada tablero siempre en el mismo | **`WORKERS=n`** |
| 5 | Hash de contraseñas | scrypt N=2¹⁴, p=5 | Argon2id 19 MiB, t=2 | **Node 24.7 o más nuevo** |
| 6 | `bufferutil` | No estaba | Dependencia opcional que `ws` usa si existe | Siempre que se instale |

El protocolo no cambió, así que el cliente web y la app móvil no necesitan cambios.

## Verificación rápida

Servidor real con MongoDB, en el PC, Node 22 (sin Argon2), una corrida de 30 s por fila. Usa un generador simplificado, no el laboratorio, así que las cifras **no se comparan directamente con las de la campaña**.

| Usuarios | Versión | Conectados | Hilo JS | Ping p50 / p99 |
|---|---|---|---|---|
| 3.000 | Antes | 3.000 | 94 % | 1,9 / 24,8 ms |
| 3.000 | **Ahora, 1 proceso** | 3.000 | **73 %** | 1,3 / 14,9 ms |
| 5.000 | Antes | 4.868 (79 no pudieron unirse) | 99,5 % | 58,5 / 185 ms |
| 5.000 | **Ahora, 1 proceso** | 5.000 | 95 % | 12,1 / 41,4 ms |
| 5.000 | **Ahora, 4 procesos** | 5.000 | 40-51 % cada uno | 0,4 / 7,8 ms |
| 8.000 | **Ahora, 4 procesos** | 8.000 | 63-66 % cada uno | 0,8 / 13,9 ms |

Cómo leerlas:

- **Es una sola corrida corta por fila**, y el mismo servidor varió más de 10 puntos de hilo JS entre corridas. Indican la dirección, no el tamaño exacto de la mejora.
- **El ping no pasa por la cola de 25 ms**, así que esta tabla no mide ese retraso: el trazo que ven los demás puede llegar hasta 25 ms más tarde. Debe medirse en la campaña con la métrica de difusión.
- **No se probó en AWS ni en Docker.** Con 4 procesos se usa más CPU total (unas 1,8 veces con 5.000 usuarios) y más memoria (~620 MB frente a ~340 MB).

## Cada cambio

### 1. El PIN ya no cuesta 45 ms

`server/src/pin.ts` y `server/src/routes/boards.ts`.

```ts
// Antes: scrypt, ~45 ms de CPU por cada entrada de invitado a un tablero con PIN.
const key = scryptSync(pin, salt, 32);

// Ahora: un HMAC con TOKEN_SECRET, como los códigos por correo (~0,003 ms).
return `p1$${salt}$${codeHash('pin', salt, pin)}`;
```

Un hash lento no protege un PIN de 4 a 12 dígitos (10⁴ intentos a 45 ms son minutos de un núcleo). Los intentos en línea los frena el límite de PIN, y sin el secreto una base filtrada no se puede probar fuera de línea. Los PIN viejos (`<sal>:<clave>`, scrypt) siguen funcionando y se reescriben en la siguiente entrada correcta. Si se cambia `TOKEN_SECRET`, los invitados no entran a tableros con PIN hasta que el creador lo vuelva a poner (creador y miembros no lo necesitan).

### 2. Escrituras agrupadas

`server/src/ws/hub.ts` y `server/src/ws/index.ts`.

**Antes:** cada difusión hacía un `socket.send`, y con ello un `writev`, por destinatario y por mensaje.

**Ahora:** las difusiones se encolan por socket y se escriben juntas al final de cada vuelta del event loop (`setImmediate`), usando `cork`/`uncork` del socket TCP:

```ts
const tcp = socket._socket;
tcp.cork();
for (const text of queued) socket.send(text);
tcp.uncork();
```

- **Orden:** un envío directo a un socket (`pong`, `joined`, errores) primero vacía su cola, así el cliente siempre recibe los mensajes en orden. Cerrar un socket también la vacía.
- **Retraso:** ninguno añadido. La primera versión esperaba 25 ms y la campaña del 7-nov midió +25 ms en cada mensaje difundido (op p95 de 0,5 a 5 ms → 27 a 30 ms en los cinco entornos). Ahora la cola se vacía con `setImmediate` al final de la vuelta del event loop: con carga, la vuelta es más larga y el lote crece solo.
- **Configuración:** `BROADCAST_FLUSH_MS=n` (por defecto 0) añade una espera de n ms para lotes más grandes, a costa de n ms en cada mensaje.
- **Detalle técnico:** `ws` no ofrece agrupación propia, así que se usa `_socket`, una propiedad interna. Al actualizar `ws`, hay que comprobar que siga existiendo.

### 3. Menos serialización

`server/src/ws/hub.ts` y `server/src/ws/index.ts`.

| | Antes | Ahora |
|---|---|---|
| Por difusión | `JSON.stringify(msg)` una vez por destinatario | Una vez, y el mismo texto para todos |
| Por mensaje recibido | `raw.toString()` dos veces | Una vez |
| Tamaño de una vista previa | Volvía a serializarla para medirla | Usa la longitud del mensaje recibido |

Por sí solo apenas se notó en las pruebas, porque la serialización pesa poco. Se hizo porque es lo que permite encolar el mismo texto para todos.

El límite de 64 KB de la vista previa ahora mide el mensaje completo, unos bytes más que antes.

### 4. Varios procesos de Node

Archivo nuevo: `server/src/workers.ts`. También cambian `index.ts`, `app.ts`, `config.ts`, `store/boards.ts` y `store/users.ts`.

**Antes:** un solo proceso, y por tanto un solo hilo de JavaScript, sin importar cuántos núcleos tuviera la máquina.

**Ahora,** con `WORKERS=n`:

```
Cliente ──► Primario: lee la petición y elige el proceso según el tablero
                 │ entrega el socket y se aparta
                 ▼
     Proceso 0   Proceso 1   Proceso 2   Proceso 3   (hijos)
                         │
                         ▼
                      MongoDB
```

Se usan procesos y no `worker_threads` porque pasar un mensaje a otro hilo cuesta unas 3 veces más que serializarlo (6,6 µs frente a 2,3 µs) y no quita las escrituras a los sockets.

Decisiones que evitan errores:

| Riesgo | Cómo se evita |
|---|---|
| Dos copias vivas de un tablero se sobrescribirían al guardar | El id del tablero decide su proceso. Otro proceso responde 404 en lugar de cargarlo |
| Todos los usuarios de un colegio detrás de una IP en un solo proceso | Los ids son aleatorios: el proceso que crea un tablero ajeno solo lo guarda en MongoDB, y su dueño lo carga al primer uso |
| Una conexión reutilizada llevaría una petición al proceso equivocado | Con procesos, REST responde `Connection: close`. Abre más conexiones TCP, y el WebSocket no se ve afectado |
| Un tablero de invitado pasa a una cuenta, pero otro proceso conserva al dueño anterior | Los procesos se avisan entre sí |
| Una sesión cerrada en un proceso seguiría válida en otro hasta 30 s | Igual: se avisan al cambiar una cuenta |
| Un proceso muere | El primario lo reinicia en 1 s y sus tableros se recargan de MongoDB. Se pierde lo no guardado, hasta 1 s, como antes |
| Fallo al arrancar (sin base de datos, sin secreto) | El primario termina con error, sin reintentar sin fin |

**Cuántos procesos usar:**

| Máquina | `WORKERS` recomendado | Por qué |
|---|---|---|
| PC (4 P-cores) | 3 o 4 | Uno por núcleo físico. MongoDB también necesita CPU |
| t3.small (1 núcleo físico) | 1 | Dos hilos del mismo núcleo: ganancia pequeña y más memoria |
| Contenedor de 1 CPU | 1 | La cuota se reparte entre todos los procesos |
| Contenedor de 512 MB | 1 | Cada proceso tiene su propio heap |

Por defecto es 1, porque el valor correcto depende de los núcleos físicos, y Node solo ve los hilos.

**Limitaciones conocidas:**

- El límite de intentos de login por cuenta puede llegar a n veces su valor si los intentos vienen de direcciones distintas. El límite por dirección sigue correcto.
- `WORKERS` mayor que 1 no funciona con `MEMORY_ONLY=true`: el servidor se niega a arrancar.
- Sirve para una sola máquina. Varias máquinas necesitarían un balanceador con la misma regla y Redis.

### 5. Argon2id para contraseñas

`server/src/pin.ts`.

| | Antes | Ahora |
|---|---|---|
| Algoritmo | scrypt N=2¹⁴, r=8, p=5 | Argon2id, 19 MiB, t=2, p=1 |
| Tiempo medido (Node 24) | 211 ms | **34 ms**, unas 6 veces menos |
| Posición en OWASP | Alternativa | Primera opción, ambas en su mínimo |
| Formato guardado | `s1$sal$clave` | `a1$sal$clave` |

- **Mejora los logins, no la capacidad del tiempo real.** Solo ~13 % de las llegadas hace login.
- **Migración automática:** el hash viejo se reemplaza en el siguiente inicio de sesión, con el `needsRehash` que ya existía.
- **Node 22 sigue funcionando** con scrypt.
- **Riesgo:** volver a Node 22 después de actualizar a Argon2id deja a esas cuentas sin poder iniciar sesión hasta que restablezcan su contraseña.

### 6. `bufferutil`

`server/package.json`. `ws` lo usa si está instalado para procesar más rápido los mensajes entrantes. Es opcional: si no se instala, el servidor funciona igual. En la prueba rápida no hubo diferencia clara frente al ruido.

## Pruebas

| Prueba | Resultado |
|---|---|
| `npm run typecheck` | ✓ |
| `check:patch`, `check:persistence` | ✓ |
| `check:auth` en Node 22 y 24 | ✓ |
| `smoke` con 1 proceso, 4 procesos y `BROADCAST_FLUSH_MS=0`, Node 22; 4 procesos, Node 24 | ✓ |
| **`check:workers` (nueva)** en Node 22 y 24 | ✓ Rutas, 3 procesos, tableros desde cualquier proceso, orden de los mensajes, transferencia entre procesos, proceso muerto que vuelve y parada limpia que guarda |

`npm run smoke` ya fallaba antes de estos cambios, porque se registraba sin email. Se corrigió.

No se ejecutó `check:ai`, que no se relaciona con estos cambios.

## Repetir las pruebas

El laboratorio ya está preparado para estos cambios:

| Qué cambió en el laboratorio | Para qué |
|---|---|
| Campo **Procesos de Node** al preparar un entorno local | Fija `WORKERS`. Las corridas con más de uno se guardan como `pc-4w`, para no confundirlas con las de uno solo |
| `WORKERS=n bash -s servidor` en `setup/ec2-preparar.sh` y `--workers n` en `campana.mjs` | Lo mismo en EC2 y en las campañas locales |
| El agente suma CPU y memoria de todos los procesos | «Hilo JS» es el del proceso más ocupado, que es el que limita. También guarda el valor de cada uno en `mainPerWorker` |
| El agente distingue las peticiones por proceso | Los ids de Fastify se repiten entre procesos, y la latencia interna se habría mezclado |
| El agente encuentra Node 24 en los contenedores | Sin esto, un contenedor con `node:24-slim` se quedaba sin datos de CPU ni memoria |
| Node 24 en el laboratorio, en `setup/ec2-preparar.sh` y en `node:24-slim` | Activa Argon2id. El laboratorio busca Node 24 en `~/.nvm` |
| Datos de prueba versión 3 | Se recrean solos al preparar, con cuentas en el hash nuevo |
| `servidor/` actualizado | EC2 y los clones del repositorio miden el código nuevo. Las corridas ya guardadas corresponden al código anterior, que sigue en el historial de git |

Se comprobó con una corrida corta de 2 procesos, nativa y en un contenedor. Ninguna campaña oficial se ha repetido todavía.

Al repetir, conviene:

- **Comparar `BROADCAST_FLUSH_MS` en 0 y 25**, y medir un `WRITE_DELAY_MS` mayor. Ambas variables pasan del entorno del laboratorio al servidor. Cada guardado vuelve a serializar el tablero completo en el hilo principal (1 a 19 ms según su tamaño), y ese costo no se aisló.
- **Guardar los resultados en una carpeta nueva.** La página Comparar muestra las carpetas de `ENV_DIRS` en `telemetry/lib/comparar.mjs`, que hoy son las de la campaña anterior a estos cambios.

## Lo que no se cambió

- **`WRITE_DELAY_MS`:** subirlo podría ahorrar CPU, a cambio de perder más ediciones si el servidor cae.
- **Límite de memoria:** `--max-old-space-size` y la caché de MongoDB podrían retrasar las caídas de los contenedores y de la t3.small. No se probaron.
- **`uWebSockets.js`:** podría ayudar, pero reemplaza toda la capa de WebSocket, y las cifras públicas vienen de terceros o de proveedores.

## Fuentes

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): parámetros y orden de preferencia de Argon2id y scrypt.
- [Documentación de `crypto` de Node.js](https://nodejs.org/api/crypto.html): `crypto.argon2`.
