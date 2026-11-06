# Conclusiones

Respuestas a las cuatro preguntas del proyecto, sustentadas con las mediciones de [MEDICIONES.md](MEDICIONES.md). Los datos crudos están en `resultados/2026-11-04/` (PC y Docker) y `resultados/2026-11-05/` (AWS).

**Resumen.** Shareboard espera en la **CPU**, sobre todo en el **único hilo de JavaScript**, que procesa y reenvía cada mensaje de tiempo real. Fuera de ese límite, cada entorno tiene el suyo: la cuota y el heap en los contenedores, la RAM y la velocidad del núcleo en AWS, y los créditos de CPU en Limited. El disco y la red no fueron el límite en ninguna carga.

| Entorno | Carga más alta que sostiene | Qué se agota primero |
|---|---|---|
| PC nativo | 3.000 usuarios | Hilo de JavaScript (79 % a 3.000, 99 % en el killer) |
| Contenedor 2 CPU | 2.000 | Hilo (75 %) y, con 3.000, el heap de V8 |
| Contenedor 1 CPU | 1.000 | Cuota de CPU (128 ms/s de freno con la máquina casi libre) |
| AWS Unlimited | 1.000 | Hilo (74 % a 1.000, 97 % a 2.000) y, con 6.000, la RAM |
| AWS Limited | 300 sostenidos; 600 con créditos acumulados | Créditos de CPU (steal ~60 % al agotarlos) |

Baja, media, alta y killer tienen 3 repeticiones; las cargas de 1.000, 2.000 y 3.000 tienen 1, así que esos límites indican el orden y no un valor exacto.

---

## 1. ¿Por qué ese número y no otro? ¿Cómo lo midieron?

### Cómo se midió

- **Carga sostenida y realista.** Cada prueba dura 12,5 minutos: 120 s de llegada, 30 s de estabilización y **600 s medidos**. Las personas llegan y salen en salas de distintos tamaños, con un horario que no depende de lo que tarde el servidor ([CARGAS.md](CARGAS.md)).
- **Mediciones propias y reproducibles.** `lab.mjs` es el laboratorio, `campana.mjs` corre las pruebas y `tablas.mjs` genera las tablas. Ningún número de rendimiento viene de internet.
- **Fuente de cada número.** CPU de `/proc/stat` y `/proc/<pid>/task/*/stat`, memoria de `VmRSS`, disco de `/proc/diskstats`, red de `/proc/net/dev`, freno de `cpu.stat` del cgroup. La latencia del usuario la mide el generador en percentiles; la interna sale del log de Fastify.
- **Criterio de "pasa":** p95 de REST < 300 ms, p95 de login y registro < 1 s, p95 del tiempo real < 150 ms, p99 del ping < 100 ms y errores REST < 1 % durante los 600 s.

### Por qué 3.000 usuarios en el PC

El costo del tiempo real en el hilo de JavaScript es casi **constante por mensaje**. Dividiendo la CPU del hilo entre los mensajes entregados por segundo:

| PC nativo | Conectados | Mensajes entregados/s | Hilo JS | CPU por mensaje |
|---|---|---|---|---|
| Alta | 577 | 13.859 | 18 % | 12,8 µs |
| 1.000 | 960 | 21.989 | 29 % | 13 µs |
| 2.000 | 1.921 | 45.535 | 51 % | 11,3 µs |
| 3.000 | 2.825 | 61.505 | 79 % | 12,8 µs |

Con ~12,8 µs por mensaje, el hilo llega al 100 % en unos **78.000 mensajes por segundo**. Con la mezcla de esta prueba, son unos 3.600 usuarios como techo.

La latencia se rompe antes de ese techo. Por teoría de colas, la espera crece como ρ/(1−ρ): con ρ = 0,75 es 3 veces el tiempo de servicio y con ρ = 0,97 es 32 veces. Se ve en AWS Unlimited: el ping p99 pasa de 53 ms con el hilo al 74 % a 1,05 s con el hilo al 97 %.

### Por qué 1.000 en AWS Unlimited

Cada mensaje cuesta unos **35 µs** en AWS, 2,7 veces más que en el PC, y cada login 255-298 ms frente a 136 ms. Con 976 usuarios, el hilo ya va al 74 %. La memoria y la red todavía no molestan.

### Por qué Limited rinde menos sin que cambie la máquina

Limited gana 24 créditos por hora, lo que equivale a 0,4 vCPU, **cerca del 20 % de la máquina**. Sin créditos, AWS le retira el resto: el steal sube a ~60 % y la CPU útil queda en 16-19 %. Baja y media (6 % y 15 %) quedan por debajo. Alta (27 %) queda por encima: pasó gastando reserva. Por proyección lineal, el límite sostenido estaría en unos 400-450 usuarios; no se midió.

---

## 2. ¿Qué componente del computador está causando ese comportamiento?

### 2.1 El núcleo que ejecuta el hilo de JavaScript

Node ejecuta todo el JavaScript de un proceso en **un solo hilo**. Cada mensaje de tiempo real pasa por `broadcast()` en `servidor/src/ws/hub.ts`, que llama a `send` para cada participante. `send` hace `JSON.stringify(msg)` **por cada destinatario** (`servidor/src/ws/index.ts:32`). Es trabajo de CPU secuencial.

La evidencia está en los datos: en el PC con 3.000 usuarios el hilo va al 79 % mientras la máquina entera está al 17 %. Más núcleos no aceleran esa parte, pero un núcleo más rápido sí: el mismo mensaje cuesta 12,8 µs en un P-core a 4,5 GHz y unos 35 µs en una vCPU de 2,5 GHz de base que comparte el núcleo físico con otro hilo.

### 2.2 El threadpool de libuv, la caché y la memoria (scrypt)

`hashPassword` y `verifyPassword` (`servidor/src/pin.ts`) usan scrypt con N=2¹⁴, r=8, p=5, sobre un bloque de **16 MB** recorrido al azar. Ese bloque no cabe en la caché L2 y cada fallo va a la RAM. Por eso el login cuesta 136 ms en el PC y unas 2 veces más en AWS.

Corre en el threadpool, no en el hilo principal, y en este modelo solo ~13 % de las llegadas hace login. Por eso **ya no es el límite**: en el killer del PC, libuv usa ~8 % de un núcleo frente al 99 % del hilo de JavaScript. El PIN de un tablero sí usa `scryptSync` en el hilo principal, y coincide con un escalón del p95 de REST (~30 ms en el PC, ~50 ms en AWS).

### 2.3 La cuota del cgroup y el heap de V8 (contenedores)

`cpus: 1` no reserva un núcleo: el kernel da **100 ms de CPU cada 100 ms** y, si el proceso los gasta antes, congela todo el contenedor.

| Con 2.000 usuarios | Contenedor 1 CPU | Contenedor 2 CPU |
|---|---|---|
| Freno del kernel | 128 ms/s | 16 ms/s |
| Ping p99 | **227 ms** | 65 ms |
| Máquina en uso | 19 % | 20 % |
| Resultado | ✕ | ✓ |

El contenedor de 1 CPU falla con el hardware casi libre: el responsable es el **límite del cgroup**.

Con 512 MB de memoria, V8 limita su heap a cerca de la mitad del contenedor. Por eso el proceso muere con `Ineffective mark-compacts near heap limit` a ~249 MB de heap vivo, sin que el kernel intervenga. Ocurre en el killer (52-88 s) y en el contenedor de 2 CPU con 3.000 usuarios (332 s). `--max-old-space-size` podría moverlo, pero no se probó.

### 2.4 Un solo núcleo físico, la RAM y los créditos (AWS)

- **1 núcleo físico.** Las 2 vCPU comparten unidades de ejecución y caché; Node, libuv y MongoDB compiten por ellas.
- **RAM.** Con 6.000 usuarios, servidor (~690 MB) y MongoDB (~700 MB) agotan 1,9 GB. El kernel mata procesos: 3 de 3 corridas en Unlimited. En una de ellas mató primero a MongoDB.
- **Créditos.** Solo en Limited, ver la sección 1.

### 2.5 Lo que no es el cuello de botella

| Componente | Medición | Por qué no limita |
|---|---|---|
| Disco | Fuera del killer de Unlimited: promedio < 130 IOPS, < 8 %util, espera de ~2 % o menos | Los cambios se agrupan cada 1 s (`WRITE_DELAY_MS`) y los tableros activos están en RAM. En ese killer sube hasta 1.014 IOPS, pero al quedarse la máquina sin RAM: es un síntoma |
| Memoria (salvo los casos anteriores) | ~0,12 MB por usuario conectado en el PC (181 MB a 100 usuarios, 506 MB a 2.825) | Solo limita con 512 MB (contenedor) o 1,9 GB (AWS) y mucha carga |
| Red | AWS Unlimited: 15 MB/s de salida con 2.000 usuarios | Se acerca a la base de 16 MB/s, pero ahí el hilo ya está saturado. Sería el siguiente límite al mejorar la CPU |

---

## 3. Si la carga se multiplicara por diez, ¿qué se rompería primero?

Server killer **es** la carga alta multiplicada por diez (600 → 6.000 usuarios), así que la respuesta está medida:

| Entorno | Qué se rompe primero | Cuándo |
|---|---|---|
| Contenedores | Heap de V8 con 512 MB: el proceso muere | 52-88 s |
| AWS Limited | Créditos de CPU: steal ~60 % | Minuto 2-3 |
| AWS Unlimited | Primero el hilo de JavaScript y luego la RAM, que tumba el proceso | 7,7-11,3 min |
| PC | Hilo de JavaScript (99 %): 38 % de errores, sin caída | Toda la prueba |

En todos, lo que falla para el usuario es **entrar**: `join` y `list` llegan al tiempo límite de 15 s, porque sus peticiones esperan en la fila del hilo.

Si se resolvieran esos límites, seguiría el trabajo secuencial. Mantener 6.000 usuarios requeriría ~130.000 mensajes por segundo × 12,8 µs ≈ **1,7 núcleos** de JavaScript en el PC (proyección). Un solo proceso de Node solo puede usar uno, así que no hay máquina que lo resuelva sin cambiar la arquitectura.

---

## 4. ¿Qué opción descartaron y por qué?

### Descartada: contenedor de 1 CPU

Con 2.000 usuarios falla con la máquina casi libre: el kernel lo frena por su cuota. Cuesta más que la t3.small (~USD 25/mes frente a USD 20,43) y da la misma capacidad medida.

### Descartada para más de 300 usuarios: AWS Limited sin reserva

Por encima de ~20 % de la máquina depende de créditos, y cuando se acaban pasa de funcionar a fallar casi todo. Sirve para la carga de referencia o para picos cortos con reserva, no para cargas altas sostenidas.

### Descartado para producción: PC

Es el más capaz, pero sin IP fija, disponibilidad 24/7 ni redundancia.

### Lo que se recomienda

| Si se necesita | Opción | Por qué |
|---|---|---|
| Hasta 300 usuarios (referencia) | **AWS t3.small con créditos (Limited)**, USD 20,43/mes | Usa 15 % de la máquina, por debajo de su base de 20 %. Es lo más barato que la pasa |
| Hasta 600, con picos | **t3.small Unlimited** | Pasa sin riesgo de recorte. El excedente estimado es de hasta ~USD 5/mes si la carga durara todo el mes |
| Hasta 1.000 | t3.small Unlimited, sin margen (hilo al 74 %, una sola corrida) o una instancia con más CPU | Una VM de mayor rendimiento por hilo no se midió: repetir las pruebas antes de contratarla |
| Más de 2.000 | Cambiar el código | Ninguna opción medida con un proceso de Node tiene margen por mucho tiempo |

### Cambios en el código que mueven el límite

No se probaron. Cada uno debe medirse con la misma prueba y presentarse como "antes y después".

| Cambio | Dónde | Ataca | Efecto esperado |
|---|---|---|---|
| Serializar una sola vez por difusión | `ws/hub.ts`, `ws/index.ts:32` | Hilo de JS | Hoy un mensaje a un tablero de 30 se serializa 29 veces. Debería bajar buena parte del costo por mensaje |
| Agrupar cursores en el servidor | `ws/index.ts` | Hilo de JS y red | Pasa de n² mensajes a n por ventana en tableros grandes |
| Hacer asíncrona la validación del PIN | `pin.ts` | Hilo de JS | Elimina el bloqueo de ~30-50 ms al unirse a un tablero con PIN |
| Varios procesos de Node con Redis entre ellos | `ws/hub.ts` (el comentario `ponytail:` ya describe el diseño) | Parte secuencial | Usa todos los núcleos; es lo único que resuelve el punto de la sección 3 |
| Ajustar `--max-old-space-size` y la caché de MongoDB al tamaño de la máquina | Configuración | Memoria | Debería retrasar las caídas de los contenedores y de la t3.small |

### Opciones de método que también se descartaron

| Opción | Por qué no |
|---|---|
| Generar la carga desde el PC de la casa hacia AWS | El cuello de botella sería la conexión a internet. Se usó un generador en la misma zona de AWS |
| MongoDB Atlas como base de datos | Agrega latencia de red y otra máquina fuera de nuestro control. MongoDB corre en Docker en cada entorno |
| Prometheus + Grafana | El agente propio permite señalar el archivo del kernel y la fórmula de cada número |
| Modelo de carga anterior (sesiones de 2-5 min, 95 % de logins) | Representaba más una avalancha de scrypt que el uso real y dejaba crecer los tableros sin límite. Ver [CARGAS.md](CARGAS.md) |
