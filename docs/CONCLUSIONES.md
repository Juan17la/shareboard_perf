# Conclusiones

Respuestas a las cuatro preguntas del proyecto, sustentadas con las mediciones de [MEDICIONES.md](MEDICIONES.md). Cada afirmación lleva el número que la respalda y el archivo de donde sale (`resultados/<entorno>/`).

**Resumen.** Shareboard espera en la **CPU**, y en dos partes distintas del proceso de Node:

1. el **threadpool de libuv**, donde se calcula scrypt en cada login y registro;
2. el **único hilo de JavaScript**, que serializa y envía cada mensaje de tiempo real a todos los participantes de un tablero.

Ni el disco ni la memoria ni la red son el límite en ninguna de las cargas medidas.

| Entorno | Carga más alta que sostiene | Qué se agota primero |
|---|---|---|
| PC nativo (4 P-cores dedicados) | Alta: 600 usuarios activos | Hilo de JavaScript (75 % promedio, 102 % pico) |
| Contenedor 2 CPU | Media: 240 | Hilo de JavaScript (93 %) + freno de cuota |
| Contenedor 1 CPU | Baja: 120 | Cuota de CPU del cgroup (687 ms/s de freno con la máquina al 86 % libre) |
| AWS t3.small | Menos de 120 | CPU real: un núcleo físico con 2 hilos, al 80-100 % |

---

## 1. ¿Por qué ese número y no otro? ¿Cómo lo midieron?

### Cómo se midió

- **Carga sostenida, no ráfagas.** Cada prueba dura 12,5 minutos: 120 s de llegada, 30 s de estabilización y **600 s medidos**. Durante los 600 s los usuarios entran y salen sin parar al ritmo de la prueba (1 o 2 por segundo; 20 en Server killer), así el login, el registro y el tiempo real se ejercitan durante toda la medición.
- **Mediciones propias y reproducibles.** Los guiones están en `telemetry/`: `lab.mjs` es el laboratorio, `campana.mjs` corre todas las pruebas y `tablas.mjs` genera las tablas. Los datos crudos, segundo a segundo, están en `resultados/`. Ningún número viene de internet salvo los precios.
- **Fuente de cada número.** CPU de `/proc/stat` y de `/proc/<pid>/task/*/stat`, memoria de `VmRSS`, disco de `/proc/diskstats`, red de `/proc/net/dev`, freno del contenedor de `cpu.stat` del cgroup. La latencia del usuario la mide el generador en percentiles (p50, p95, p99). La latencia interna sale del log de Fastify.
- **Criterio de "pasa":** p95 de REST < 300 ms, p95 de login < 1 s, p95 del tiempo real < 150 ms, p99 del ping < 100 ms y errores < 1 % durante los 600 s.

### Por qué 600 usuarios en el PC (y no 1.000)

El costo del tiempo real en el hilo de JavaScript es **lineal y constante**. Dividiendo la CPU del hilo principal entre los mensajes entregados por segundo:

| PC nativo | Mensajes entregados/s | CPU del hilo JS | CPU por mensaje |
|---|---|---|---|
| Baja (120) | 11.505 | 14 % | 12,1 µs |
| Media (240) | 22.863 | 29 % | 12,5 µs |
| Alta (600) | 59.135 | 75 % | 12,7 µs |

Con 12,7 µs por mensaje, un hilo llega al 100 % en 1 / 12,7 µs ≈ **78.700 mensajes por segundo**. Con la mezcla de tableros de la prueba (~98 mensajes por usuario por segundo) eso son unos **800 usuarios** como techo físico.

Pero la latencia se rompe antes. Por teoría de colas, el tiempo de espera crece como ρ/(1−ρ): a ρ = 0,75 la espera media es 3 veces el tiempo de servicio y a ρ = 0,93, 13 veces. Con la carga alta el PC queda en ρ = 0,75 y su ping p99 es de 73 ms, cerca del límite de 100 ms. El contenedor de 2 CPU, con la **misma** carga, llega a ρ = 0,93: su ping p99 es de 1.225 ms y no pasa. **El límite útil del PC está entre 600 y 650 usuarios.**

### Por qué el login rompe todo en Server killer

El costo de un login en el threadpool también es medible: CPU de los hilos `libuv-worker` ÷ logins por segundo.

| | CPU por login (scrypt) |
|---|---|
| PC nativo y contenedores (P-cores a 4,5 GHz) | 142-185 ms |
| AWS t3.small (Xeon 8175M) | 300-365 ms |

El threadpool tiene 4 hilos (`UV_THREADPOOL_SIZE` por defecto), así que la capacidad máxima del PC es de 4 / 0,142 s ≈ **28 logins por segundo**. Server killer llega a 50 por segundo durante su rampa: la fila crece 22 por segundo y nunca se vacía. Los 4 hilos quedan al 393 % (llenos) y los logins superan los 15 s del tiempo límite. **El PC muere con el 57 % de la CPU libre**: el límite es el tamaño del pool, no la máquina.

### Por qué AWS no pasa ni la carga baja

En AWS, cada mensaje cuesta 30-33 µs de hilo JS (2,5 veces más que en el PC) y cada login 300-365 ms (2,1 veces más). La demanda de CPU de la carga baja es: hilo JS (tiempo real) 0,38 vCPU + threadpool (logins) 0,28 + MongoDB 0,04 = **0,70 vCPU de 2**. Coincide con lo medido para toda la máquina: 38 % = 0,76 vCPU. Las dos vCPU son un solo núcleo físico, así que dos hilos ocupados a la vez se reparten las mismas unidades de ejecución. Basta para el promedio, pero la cola del registro llega a 1.047 ms en p95 y supera el límite. En la carga media la demanda sube al 80 % de la máquina y el REST p95 a 1.178 ms.

---

## 2. ¿Qué componente del computador está causando ese comportamiento?

### 2.1 El núcleo de CPU que ejecuta el hilo de JavaScript (la parte secuencial)

Node ejecuta todo el JavaScript de un proceso en **un solo hilo**: el bucle de eventos. Cada mensaje de tiempo real pasa por `broadcast()` en `servidor/src/ws/hub.ts`, que llama a `client.send(msg)` para cada participante. `send` hace `JSON.stringify(msg)` **por cada destinatario** (`servidor/src/ws/index.ts:32`). Es trabajo de CPU puro, secuencial, que crece con el cuadrado del tamaño del tablero: n usuarios enviando a n−1 destinatarios.

La evidencia es la ley de Amdahl en los datos. En la carga alta del PC el núcleo más ocupado llega al 100 % mientras la máquina completa está al 18 % (81 % libre). Con 4 núcleos físicos disponibles, el proceso no puede usar más de uno para esta parte. Más núcleos no la aceleran; un núcleo **más rápido** sí. Por eso el mismo mensaje cuesta 12,7 µs en un P-core Meteor Lake a 4,5 GHz y 30 µs en una vCPU Skylake a 2,5-3,1 GHz que comparte el núcleo físico con otro hilo.

### 2.2 El threadpool de libuv y la caché/memoria (scrypt)

`hashPassword` y `verifyPassword` (`servidor/src/pin.ts`) usan scrypt con N=2¹⁴, r=8, p=5: 5 pasadas secuenciales que recorren al azar un bloque de **16 MB**. scrypt es *memory-hard* a propósito: su conjunto de trabajo no cabe en la caché L2 (2 MB por P-core en el PC, 1 MB en el Xeon) y cuatro logins simultáneos (64 MB) superan la L3 (18 MB en el PC, 33 MB compartidos con otros clientes en AWS). Cada acceso aleatorio que falla en caché va a la RAM. Por eso el login cuesta ~140 ms en el PC y más del doble en AWS, donde además los dos hilos hermanos de hyperthreading comparten la L1 y la L2 del mismo núcleo.

El cálculo corre en el threadpool de libuv (4 hilos), no en el hilo principal. Por eso el login no congela el tiempo real mientras hay CPU libre, pero limita la tasa máxima de logins a 4 / tiempo de servicio.

### 2.3 El planificador del kernel y la cuota del cgroup (contenedores)

`cpus: 1` no reserva un núcleo: el CFS le da al contenedor **100 ms de CPU cada 100 ms**. El proceso de Node tiene más de 10 hilos (JS, 4 de libuv, varios de V8). Cuando coinciden un login y el tiempo real, la cuota se gasta en 20-30 ms y el kernel **congela todo el contenedor** hasta el siguiente periodo, incluido el hilo de JavaScript.

| Contenedor 1 CPU | Baja | Media |
|---|---|---|
| CPU usada en promedio | 0,31 CPU | 0,69 CPU |
| Freno del kernel (promedio) | 73 ms/s | **687 ms/s** |
| Ping p99 (el servidor solo contesta "pong") | 36 ms | **680 ms** |
| CPU libre en la máquina | 91 % | **86 %** |

El contenedor de 1 CPU falla la carga media con el hardware ocioso: el componente responsable es el **límite del cgroup**, no la CPU. Con 2 CPU de cuota el freno baja a 21 ms/s y pasa la misma carga.

### 2.4 Lo que no es el cuello de botella (y por qué)

| Componente | Medición | Por qué no limita |
|---|---|---|
| Disco | IOPS promedio 11-504, %util promedio ≤ 4 %, iowait < 1 % en las 16 pruebas | Las escrituras de tableros se agrupan cada 1 s (`WRITE_DELAY_MS`) y la caché de WiredTiger de MongoDB (235-489 MB de RES) contiene todos los datos activos: las lecturas se sirven desde RAM. El EBS gp3 ofrece 3.000 IOPS de base; el NVMe del PC, cientos de miles |
| Memoria | RES del servidor 174-375 MB; nunca se acercó a los 512 MB del contenedor | Crece con los tableros abiertos: ~0,15 MB por usuario activo (202 MB con 120 usuarios, 276 MB con 600 en el PC) |
| Red | AWS: 10 MB/s de salida en la carga media (pico 26 MB/s) | Por debajo de los 16 MB/s de base de la t3.small. En el PC y los contenedores el tráfico es local |

---

## 3. Si la carga se multiplicara por diez, ¿qué se rompería primero?

Server killer **es** la carga alta multiplicada por diez (6.000 usuarios, 20 entradas por segundo), así que la respuesta está medida y no proyectada:

1. **Primero: el login, en los cuatro entornos.** Siempre el mismo error (`login:TIMEOUT`, 401 a 6.985 casos) y el mismo mecanismo: la llegada de logins supera la capacidad del threadpool (≈ 28/s en el PC, mucho menos con 1-2 CPU o en AWS), la fila crece sin límite y las peticiones superan los 15 s. El PC duró 95 s; los contenedores y AWS, entre 26 y 44 s.

Si el login se resolviera, lo siguiente se calcula con las demandas medidas:

2. **Segundo: el hilo de JavaScript (tiempo real).** 10 veces la carga alta son ~590.000 mensajes por segundo × 12,7 µs = **7,5 núcleos** de trabajo secuencial. Un proceso de Node solo puede usar uno. No hay máquina que lo resuelva sin cambiar la arquitectura (varios procesos).
3. **Tercero: la memoria en el contenedor.** A ~0,15 MB por usuario, 6.000 usuarios son ~200 MB + 880 MB ≈ **1,1 GB** de RES: el contenedor de 512 MB sería terminado por el kernel (OOM). En la t3.small (2 GB) apenas cabría junto a MongoDB.
4. **Cuarto, solo en la nube: la red.** La salida del servidor en la carga alta es ~35 MB/s (medida en loopback en el PC); por diez, ~350 MB/s ≈ 2,8 Gbps. Es 22 veces la base de la t3.small (0,128 Gbps): los créditos de ráfaga de red se agotarían en minutos.
5. **Lo último: el disco.** 117 IOPS promedio en la carga alta × 10 = ~1.200 IOPS, por debajo de los 3.000 de base de gp3.

---

## 4. ¿Qué opción descartaron y por qué?

### Descartada: AWS t3.small

Es la más barata (USD 20,43/mes con disco e IP), pero **no sostiene ni la carga baja**. Su problema es de hardware. Las 2 vCPU son **un solo núcleo físico** con hyperthreading, de una generación anterior y a menor frecuencia. Cada login cuesta 300-365 ms de CPU (2,1 veces el PC) y cada mensaje de tiempo real 30 µs (2,5 veces). Además es una instancia *burstable*: su línea base es el 20 % por vCPU. Con una carga sostenida al 80 % (la media) viviría de créditos en modo Unlimited, pagando el excedente (USD 0,05 por vCPU-hora). Subir a t3.medium no ayuda: tiene la misma CPU y solo agrega memoria, que no es el límite.

### Descartada: contenedor de 1 CPU (equivalente a un plan PaaS de 1 CPU, ~USD 25/mes)

Falla la carga media **con el 86 % de la CPU de la máquina libre**. El límite es la cuota del cgroup: los picos de varios hilos (scrypt + tiempo real) gastan los 100 ms del periodo y el kernel congela el proceso entero, incluido el hilo de JavaScript. Se paga por una CPU que el proceso no puede usar de forma continua.

### Lo que se recomienda

- **Para la carga media (240 usuarios activos, 2 entradas por segundo):** como mínimo, **2 CPU dedicadas** de buen rendimiento por hilo. El contenedor de 2 CPU la pasa con los mismos números que el PC (REST p95 4,9 ms, login p95 227 ms). Equivale a un plan de 2 CPU (Render Pro, USD 85/mes) o a una VM no *burstable* de 2 núcleos físicos. Esta VM no se midió; se recomienda repetir las pruebas antes de contratarla.
- **Para la carga alta (600):** ningún plan con un solo proceso de Node tiene margen; el PC la pasa con el hilo de JavaScript al 75 %. Hace falta cambiar el código.

### Cambios en el código que mueven el límite (por orden de impacto esperado)

| Cambio | Dónde | Ataca | Efecto esperado |
|---|---|---|---|
| Serializar una sola vez por difusión: `JSON.stringify(msg)` en `broadcast()` y enviar el mismo texto a todos | `ws/hub.ts`, `ws/index.ts:32` | Hilo de JavaScript (2.1) | Hoy un mensaje a un tablero de 30 se serializa 29 veces. Debería bajar buena parte de los 12,7 µs por mensaje |
| Agrupar cursores en el servidor: un mensaje por tablero cada 50 ms con todos los cursores | `ws/index.ts` | Hilo de JavaScript, red | Pasa de n² mensajes a n por ventana en tableros grandes |
| `UV_THREADPOOL_SIZE` igual al número de núcleos (8 en el PC) | Variable de entorno | Threadpool (2.2) | Duplica la capacidad de login del PC (≈ 28 → 56 por segundo). En un contenedor, lo contrario: `UV_THREADPOOL_SIZE` ≤ CPU de cuota, para no generar ráfagas que activen el freno |
| Sesiones más largas (tokens con renovación) para que el usuario no repita el login en cada visita | `routes/auth.ts`, `tokens.ts` | Threadpool | Menos logins por usuario. Bajar los parámetros de scrypt no es opción: N=2¹⁴, p=5 es el mínimo de OWASP |
| Varios procesos de Node con afinidad por tablero y Redis pub/sub entre ellos | `ws/hub.ts` (el comentario `ponytail:` ya describe el diseño) | Parte secuencial | Usa todos los núcleos: es lo único que resuelve el punto 2 de la sección 3 |

Cada cambio debe medirse con la misma prueba (misma carga, mismo entorno) y presentarse como "antes y después".

### Opciones de método que también se descartaron

| Opción | Por qué no |
|---|---|
| Generar la carga desde el PC de la casa hacia AWS | El cuello de botella sería la conexión de internet (decenas de MB/s de salida del servidor) y no la instancia. Se usó un generador en la misma zona de AWS (RTT 2-3 ms) |
| MongoDB Atlas como base de datos | Agrega latencia de red y otra máquina fuera de nuestro control. MongoDB corre en Docker en cada entorno, igual en los cuatro |
| Prometheus + Grafana | Son una caja negra para la sustentación. El agente propio permite señalar el archivo del kernel y la fórmula de cada número |
| Sesiones de 40 minutos (la primera versión del generador) | Casi no generaban logins en una prueba de 10 minutos y ocultaban el componente más caro (scrypt). Ver [CARGAS.md](CARGAS.md) |
