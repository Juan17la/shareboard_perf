# Plan del proyecto final: dimensionar la carga real de Shareboard

> Curso: Arquitectura de computadores. Proyecto: "Dimensionar una carga real".
> Pregunta central: ¿en qué máquina debería correr Shareboard y con qué datos lo sostenemos?
> Fecha del plan: 30 de octubre de 2026. Sustentación: 11 o 18 de noviembre.

---

## 1. Introducción

Shareboard es una pizarra colaborativa en tiempo real. Su backend es un único proceso de Node.js (Fastify) que atiende una API REST y conexiones WebSocket, y guarda los datos en MongoDB. Es un proyecto no profesional: nunca se ha medido bajo carga, por eso es un buen caso de estudio para responder tres preguntas:

1. **¿Qué recurso se agota primero?** CPU, memoria, disco o red.
2. **¿Cuántos usuarios concurrentes soporta con buen rendimiento?** En tres infraestructuras distintas.
3. **¿Qué cambio en el código o en la configuración mueve ese límite?** Y cuánto lo mueve.

El enunciado permite usar IA. La IA construye las herramientas; nosotros tenemos que poder explicar cada número. Por eso todo el plan está pensado para que cada métrica tenga una fuente que se pueda señalar (un archivo de `/proc`, un contador de Mongo, un temporizador del generador de carga) y un componente del computador responsable.

### 1.1 Qué pide la rúbrica y cómo lo cubre este plan

| Criterio (peso) | Cómo lo cubrimos |
|---|---|
| Mediciones propias, reproducibles, carga sostenida (1,0) | Generador de carga con escalones de 5 a 10 minutos, scripts versionados, datos crudos en `analitics/data/raw/` |
| Dónde espera la aplicación, con datos (1,5) | Método USE (utilización, saturación, errores) por recurso, más el retraso del event loop de Node |
| Comparación justa (1,0) | Misma carga, mismo algoritmo, mismas métricas en los tres entornos; fichas técnicas y precios reales |
| Explicar el porqué con arquitectura (1,5) | Para cada hallazgo: número, componente responsable y mecanismo (sección 9) |

### 1.2 Métricas obligatorias del enunciado

| Métrica | Fuente que usaremos |
|---|---|
| CPU promedio y pico, por núcleo | `/proc/stat` (por núcleo) y `/proc/<pid>/stat` (solo el servidor) |
| Memoria residente real | `VmRSS` en `/proc/<pid>/status`; en contenedor, `memory.current` del cgroup |
| Disco: IOPS y MB/s | `/proc/diskstats` (lecturas, escrituras, sectores, tiempo ocupado) |
| Red: entrada y salida por segundo | `/proc/net/dev` (bytes y paquetes por interfaz) |
| Latencia p50, p95, p99 | Medida en el generador (cliente) y en el servidor (log de Fastify) |

---

## 2. Lo que ya sabemos del código (hipótesis iniciales)

Antes de medir, leímos el servidor (`server/src`). Estas son las hipótesis que la medición debe confirmar o tumbar. Tenerlas escritas antes evita "acomodar" la explicación después.

| # | Observación en el código | Hipótesis | Recurso sospechoso |
|---|---|---|---|
| H1 | Un solo proceso Node; el JavaScript corre en un solo hilo | Con muchos usuarios, un núcleo llega al 100 % mientras los demás están ociosos | CPU (un núcleo) |
| H2 | Login y registro usan `scrypt` (N=2^14, r=8, p=5, unos 16 MB por cálculo) en el threadpool de libuv (4 hilos por defecto) | Picos de login saturan 4 núcleos y suben la memoria unos 64 MB; las demás peticiones no se bloquean, pero los logins hacen fila | CPU (threadpool) y memoria |
| H3 | `hub.broadcast` envía cada mensaje a todos los participantes del tablero | Los cursores generan tráfico que crece con el cuadrado de usuarios por tablero (n usuarios x n destinatarios) | CPU (serializar JSON) y red de salida |
| H4 | Los tableros abiertos viven en memoria y se descargan tras 5 min sin uso | La memoria residente crece con el número de tableros activos, no con el número de usuarios | Memoria |
| H5 | Las escrituras a Mongo se agrupan cada 1 s (`WRITE_DELAY_MS`) | El disco casi no trabaja; Mongo no será el cuello de botella | Disco (bajo) |
| H6 | `POST /boards` sí espera la escritura en Mongo | Crear tableros es la única ruta sensible al disco | Disco y latencia |
| H7 | Pool de Mongo de 20 conexiones | Con mucha concurrencia REST, las consultas hacen fila en el pool | Espera (no recurso físico) |

---

## 3. Arquitectura de la medición

Separamos tres papeles para que medir no contamine lo medido:

```
 ┌───────────────────────────┐         ┌────────────────────────────────────────┐
 │  Máquina de carga          │  HTTP   │  Máquina objetivo (target)             │
 │                            │  + WS   │                                        │
 │  Generador de carga ───────┼────────►│  Servidor Shareboard (Node)            │
 │  (usuarios virtuales)      │         │  MongoDB (docker compose)              │
 │                            │         │                                        │
 │  Controlador adaptativo    │◄────────┼── Agente de telemetría (lee /proc,     │
 │  (decide cuántos usuarios) │ métricas│   cgroups, Mongo, event loop)          │
 │                            │         │                                        │
 │  Panel web de gráficas     │         │                                        │
 └───────────────────────────┘         └────────────────────────────────────────┘
```

Reglas:

- **La telemetría no se guarda en el mismo Mongo de la aplicación.** Escribir métricas en Mongo sumaría escrituras al disco que estamos midiendo. Se guardan en archivos NDJSON/CSV, que además son los "datos crudos" que pide el entregable.
- **El generador no comparte núcleos con el servidor.** En el PC local, servidor y Mongo se fijan a unos núcleos y el generador a otros con `taskset`. El agente también mide el CPU del generador: si el generador pasa del 70 %, la prueba no vale (el cuello sería la herramienta, no Shareboard).
- **Doble latencia.** La latencia del cliente incluye la red; la del servidor (campo `responseTime` del log de Fastify) no. Para comparar entornos de forma justa usamos la del servidor; para hablar de experiencia del usuario usamos la del cliente.

---

## 4. La aplicación de telemetría

### 4.1 Lenguaje y por qué

**Node.js 22**, el mismo lenguaje del servidor. Razones:

- No suma otra tecnología que haya que explicar en la sustentación.
- Leer `/proc` es leer archivos de texto; no hace falta ninguna librería.
- El panel es una página HTML con una librería de gráficas pequeña (uPlot, unos 50 KB), servida por el mismo proceso.

**Alternativa descartada: Prometheus + Grafana + node_exporter + cAdvisor.** Es el estándar de la industria y requiere menos código, pero es una caja negra: en la sustentación tendríamos que explicar cómo Grafana calcula cada número. Con un agente propio podemos decir "el % de CPU es la diferencia de jiffies entre dos lecturas de `/proc/stat` dividida por el tiempo transcurrido". Lo usaremos solo como verificación cruzada si sobra tiempo.

### 4.2 Componentes

| Componente | Dónde corre | Qué hace |
|---|---|---|
| `agent` | Máquina objetivo | Cada 1 s lee el sistema, el proceso del servidor, el contenedor y Mongo. Escribe NDJSON local y envía cada muestra al controlador |
| `load` | Máquina de carga | Simula usuarios virtuales (REST + WebSocket). Cada segundo emite: peticiones, errores, p50/p95/p99 por tipo |
| `controller` | Máquina de carga | Recibe métricas, ejecuta el algoritmo adaptativo (sección 6), marca el inicio y fin de cada escalón, guarda la corrida |
| `panel` | Navegador | Gráficas en tiempo real y de corridas pasadas; exporta CSV |

### 4.3 Qué mide el agente (cada segundo)

**Sistema**

| Métrica | Fuente | Para qué sirve |
|---|---|---|
| CPU por núcleo (user, system, iowait, steal) | `/proc/stat` | Ver si un solo núcleo se satura (H1). `iowait` indica espera de disco; `steal` indica que la nube nos quita CPU |
| Carga promedio y procesos en cola | `/proc/loadavg`, `procs_running` | Saturación de CPU: más procesos listos que núcleos |
| Frecuencia del CPU | `/proc/cpuinfo` (MHz) | Detectar throttling térmico en el portátil |
| Temperatura | `/sys/class/thermal` | Mismo motivo |
| Energía | `/sys/class/powercap/intel-rapl` (el PC lo tiene) | Watts reales, para calcular el costo eléctrico de la opción física |
| Memoria libre, caché, swap | `/proc/meminfo` | Saber si el sistema empieza a usar swap |
| Disco: IOPS, MB/s, % ocupado, espera media | `/proc/diskstats` | Métrica obligatoria; confirmar H5 y H6 |
| Red: bytes y paquetes por segundo, retransmisiones TCP | `/proc/net/dev`, `/proc/net/snmp` | Métrica obligatoria; las retransmisiones delatan red saturada o con pérdida |

**Proceso del servidor y de Mongo**

| Métrica | Fuente |
|---|---|
| CPU del proceso (user y system) | `/proc/<pid>/stat` |
| Memoria residente (RSS) | `/proc/<pid>/status` |
| Hilos | `/proc/<pid>/status` |
| Bytes leídos y escritos a disco | `/proc/<pid>/io` |
| Descriptores abiertos (sockets) | `/proc/<pid>/fd` |

**Contenedor (solo en el escenario Docker)**

| Métrica | Fuente | Para qué sirve |
|---|---|---|
| CPU usada y tiempo **estrangulado** | `cpu.stat` (`throttled_usec`) del cgroup v2 | Si el límite de CPU frena al servidor, aquí se ve |
| Memoria actual y eventos OOM | `memory.current`, `memory.events` | Saber si el kernel mató el proceso por pasar el límite |

**Dentro de Node, sin tocar el servidor**

Requisito: la medición no puede modificar ni cargar el servidor. Por eso no se agrega ninguna ruta de métricas; lo que habría dado esa ruta se obtiene desde afuera:

| Métrica | Cómo se obtiene | Por qué es clave |
|---|---|---|
| CPU por hilo (hilo JavaScript, threadpool de libuv, hilos de V8) | `/proc/<pid>/task/*/stat`, agrupado por nombre de hilo | Muestra directamente si el único hilo de JavaScript llegó al 100 % mientras los demás núcleos esperan (H1) o si el threadpool de scrypt hace fila (H2) |
| Retraso del servidor (aproxima el event loop) | Ping WebSocket cada 10 s por usuario; el servidor solo contesta, así que el tiempo extra es fila dentro del hilo JS | Si sube, todo se vuelve lento aunque el CPU total parezca bajo |
| Latencia por ruta dentro del servidor | Log que Fastify ya escribe (`responseTime`) | Comparar entornos sin el ruido de la red |
| Mensajes WebSocket por segundo | Contados en el generador | Confirmar el crecimiento cuadrático (H3) |

**MongoDB**

| Métrica | Fuente |
|---|---|
| Operaciones por segundo (insert, query, update) | `db.serverStatus().opcounters` |
| Conexiones activas | `serverStatus().connections` |
| Caché de WiredTiger usada y páginas sucias | `serverStatus().wiredTiger.cache` |

### 4.4 Qué mide el generador de carga

- Latencia por tipo de operación: login, listar tableros, crear tablero, unirse, eco de WebSocket.
- **Latencia de difusión (fan-out):** un usuario dibuja, se mide cuánto tarda en llegar el mensaje a los otros usuarios del mismo tablero. Es la latencia que realmente siente quien colabora.
- Errores por código (4xx, 5xx, timeouts, conexiones rechazadas) y por causa de red (`ECONNRESET`, `ETIMEDOUT`).
- CPU y memoria del propio generador (para invalidar pruebas donde el generador es el cuello).

Los percentiles se calculan con un histograma por segundo (no con el promedio), y en el reporte por escalón se combinan los histogramas, no los percentiles (promediar percentiles da un número incorrecto).

### 4.5 Panel de gráficas

Vistas mínimas:

1. **En vivo:** CPU por núcleo (mapa de calor), CPU del proceso, RSS, event loop lag, IOPS, red entrada/salida, latencia p50/p95/p99, errores, usuarios activos. Las líneas verticales marcan el cambio de escalón.
2. **Corrida:** la misma vista sobre una corrida guardada, con un resumen por escalón (promedio, pico, p95 de cada métrica).
3. **Comparar:** los tres entornos superpuestos con el eje X en "usuarios concurrentes" en lugar de tiempo. Esta es la gráfica principal del informe: muestra dónde se dobla la curva de cada entorno.

Cada gráfica muestra mínimo, promedio, máximo y último valor, y líneas de umbral (por ejemplo, p95 = 300 ms).

### 4.6 Estructura de carpetas (implementada)

```
analitics/
├── PLAN.md                  este documento
├── PRUEBAS.md               las cinco pruebas y qué correr en cada máquina
├── setup/SETUP.md           cómo usar el laboratorio (PC, contenedor y EC2)
├── telemetry/
│   ├── lab.mjs              único comando: interfaz web + preparación del entorno + pruebas
│   ├── agent.mjs            agente en la máquina objetivo (/proc, cgroups, log, Mongo)
│   ├── vu-worker.mjs        hilos generadores de usuarios virtuales
│   ├── lib/                 runner (escalones), target (Mongo, servidor, puertos), seed, hist
│   ├── profiles/            las cinco pruebas (JSON)
│   └── ui/                  interfaz: laboratorio en vivo y reproducción de corridas
├── envs/                    compose de Mongo, servidor en contenedor y su Dockerfile
└── data/raw/                un NDJSON por corrida (entregable)
```

---

## 5. Modelo de carga: qué es "un usuario"

> **Actualizado:** el modelo de esta sección y la prueba adaptativa de la sección 6 fueron reemplazados por el flujo realista (roles, clases y equipos, previews) de [`INVESTIGACION-CARGA.md`](INVESTIGACION-CARGA.md). Las pruebas vigentes y el procedimiento de comparación están en [`PRUEBAS.md`](PRUEBAS.md). Lo que sigue queda como historia del diseño.

Un "usuario concurrente" es un usuario virtual que hace lo mismo que una persona real usando Shareboard en una sesión colaborativa. Usar solo peticiones REST aisladas no representaría la aplicación, porque su parte más exigente es el tiempo real.

### 5.1 Perfil del usuario virtual (sesión típica)

| Paso | Acción | Frecuencia aproximada | Recurso que estresa |
|---|---|---|---|
| 1 | `POST /auth/login` | 1 vez por sesión | CPU del threadpool y memoria (scrypt) |
| 2 | `GET /me/boards` | Al entrar y cada 60 s | Mongo (consulta) y serialización JSON |
| 3 | Unirse a un tablero (REST `join` + WebSocket `/ws` + mensaje `join`) | 1 vez | Memoria (tablero cargado), Mongo si no estaba en memoria |
| 4 | Mover el cursor (`cursor`) | Cada 50 a 100 ms mientras está activo | CPU del event loop y red de salida (fan-out) |
| 5 | Dibujar (`op` con un trazo) | Cada 3 a 5 s | CPU, memoria, escritura agrupada a Mongo |
| 6 | `ping` | Cada 15 s | Casi nada (control) |
| 7 | `POST /boards` | 1 de cada 20 sesiones | Disco (espera la escritura) |
| 8 | Salir y volver a empezar | Sesión de 3 a 5 min | Mantiene una fracción constante de logins |

Los usuarios se agrupan en tableros de **5 usuarios** (configurable). El tamaño del grupo importa por H3: 100 usuarios en 20 tableros de 5 generan mucho menos tráfico que 100 usuarios en un solo tablero. Haremos una corrida extra variando el tamaño del grupo (5, 20, 50) para mostrar ese efecto.

Los tiempos llevan una variación aleatoria (por ejemplo, ±30 %) para que los usuarios no actúen todos en el mismo milisegundo, con una semilla fija para que la corrida sea repetible.

### 5.2 Preparación (antes de cada corrida)

- **Usuarios precreados** automáticamente por el laboratorio (`lab.mjs`) la primera vez. El registro es caro (scrypt) y tiene límite por hora; no debe ser parte de la medición.
- **Límites de tasa elevados** con las variables que ya existen en `server/src/config.ts`: `LOGIN_PER_MINUTE`, `REGISTER_PER_HOUR`, `CREATE_BOARD_PER_HOUR`, `PIN_PER_MINUTE`. Todos los usuarios virtuales salen de la misma IP, así que sin esto el servidor respondería 429 y estaríamos midiendo el limitador, no la aplicación.
- **Base de datos limpia** y con el mismo volumen inicial (por ejemplo, 500 usuarios y 1.000 tableros) en todos los entornos.
- **Servidor reiniciado** antes de cada corrida, para empezar con la memoria en el mismo estado.

### 5.3 Pruebas aisladas por recurso (calibración)

Antes de la carga mixta, una corrida corta por cada tipo de operación para conocer su costo unitario:

| Prueba | Pregunta que responde |
|---|---|
| Solo login | ¿Cuántos ms de CPU cuesta un login? ¿Cuántos logins por segundo soporta el threadpool? |
| Solo listar tableros | ¿Cuánto cuesta una lectura de Mongo de punta a punta? |
| Solo crear tableros | ¿Cuánto aporta el disco a la latencia? |
| Solo WebSocket (cursores) | ¿Cómo crece el tráfico al subir usuarios por tablero? |

Con el costo unitario se puede **predecir** el límite (por ejemplo: si un login cuesta 25 ms de CPU y hay 4 hilos, el máximo teórico es unos 160 logins/s). Comparar la predicción con lo medido es exactamente el tipo de razonamiento que pide la sustentación.

---

## 6. Prueba adaptativa: encontrar el punto donde deja de ser óptimo

### 6.1 Definición de "buen rendimiento" (criterios del escalón)

Un escalón **pasa** si, en su ventana de medición, se cumplen todos:

| Criterio | Umbral propuesto | Por qué ese umbral |
|---|---|---|
| p95 de REST (sin login) | menor a 300 ms | Por encima, la interfaz se siente lenta |
| p95 de login | menor a 1.000 ms | Login es costoso por diseño (seguridad), se tolera más |
| p95 de difusión WS | menor a 150 ms | Por encima, los cursores y trazos ajenos se ven "a saltos" |
| Tasa de errores | menor a 1 % | Cualquier error sistemático es falla |
| Event loop lag p99 | menor a 100 ms | Indica que el hilo de JS ya no da abasto |
| CPU del generador | menor a 70 % | Si no, la prueba no es válida |

Los umbrales se fijan **antes** de medir y son iguales para los tres entornos.

### 6.2 Algoritmo

```
usuarios = 10
duración del escalón = 6 min (1 min de calentamiento que no cuenta + 5 min de medición)

mientras no se detenga:
    subir gradualmente a "usuarios" (rampa de 30 s, sin picos)
    esperar el calentamiento
    medir 5 minutos
    si el escalón pasa:
        último_bueno = usuarios
        usuarios = usuarios x 1,5          (crecimiento geométrico: llega rápido al límite)
    si no pasa:
        primer_malo = usuarios
        salir

búsqueda fina entre último_bueno y primer_malo:
    probar el punto medio con escalones de 8 min
    repetir 2 o 3 veces (hasta que la diferencia sea menor al 10 %)

confirmación:
    correr 15 minutos seguidos con el 80 % del límite encontrado
    si pasa, ese es el "máximo con buen rendimiento" del entorno
```

Reglas de seguridad: corte inmediato si la tasa de errores pasa del 20 %, si el servidor se cae, o si la memoria del contenedor llega al 95 % de su límite.

Duración estimada por entorno: entre 45 y 75 minutos. Cada corrida guarda la configuración usada (perfil, semilla, versión del servidor, commit) junto con los datos.

### 6.3 Por qué escalones largos y no una rampa continua

Una rampa continua mezcla causas: no se distingue si la latencia sube por la carga actual o por la que quedó acumulada. Con escalones de varios minutos el sistema llega a un **estado estable** (cachés llenas, recolector de basura en régimen, créditos de CPU consumiéndose en la nube) y el promedio de cada escalón es un dato limpio. Además el enunciado exige carga sostenida de varios minutos.

---

## 7. Los tres entornos

Los tres corren **el mismo commit** del servidor, la misma versión de Node (22) y de Mongo, el mismo volumen de datos y el mismo perfil de carga.

### 7.1 Máquina física: el PC actual

| Dato | Valor |
|---|---|
| CPU | Intel Core Ultra 5 125H: 4 núcleos P (con hyperthreading), 8 núcleos E, 2 núcleos LP E; 18 hilos en total |
| RAM | 14 GiB |
| Disco | NVMe (registrar modelo con `lsblk -d -o NAME,MODEL`) |
| Sistema | Debian, kernel 6.12 |

Preparación:

- Conectado a la corriente, perfil de energía en rendimiento (`powerprofilesctl set performance`), sin otras aplicaciones pesadas abiertas.
- Servidor en Node nativo, fijado a los núcleos P (`taskset -c 0-7`). Mongo en Docker sin límites, fijado a los mismos núcleos.
- Generador y controlador en los núcleos E (`taskset -c 8-15`).
- Registrar temperatura y frecuencia: un portátil puede bajar la frecuencia por calor y eso cambia los resultados a mitad de la prueba.

Costo mensual: precio del equipo amortizado a 3 años más la electricidad medida con RAPL (watts promedio x 730 h x tarifa local de kWh). Se aclara que no incluye conectividad pública ni disponibilidad 24/7.

### 7.2 Contenedor con límites

Mismo PC, pero el servidor y Mongo corren en Docker con límites definidos por nosotros:

| Servicio | CPU | Memoria | Justificación |
|---|---|---|---|
| Servidor | 1 CPU (`cpus: 1`) | 512 MB | Simula el plan más pequeño de un PaaS típico (como Render o Railway) |
| Mongo | 1 CPU | 1 GB | Suficiente para el volumen de prueba |

Además de la corrida principal, una corrida con **2 CPU** para ver si el servidor aprovecha el segundo núcleo (por H1 y H2: solo el threadpool de scrypt debería aprovecharlo).

Detalles que hay que explicar en el informe:

- `cpus: 1` no reserva un núcleo: le da al contenedor 100 ms de CPU cada 100 ms. Si los gasta antes, el kernel lo **estrangula** hasta el siguiente periodo. Por eso medimos `throttled_usec`.
- Node no siempre "sabe" que tiene 1 CPU; el threadpool sigue teniendo 4 hilos que compiten por esa única CPU.
- Si pasa de 512 MB, el kernel lo mata (OOM). Se registra en `memory.events`.

Costo mensual: el de un plan equivalente en un PaaS (precio publicado, 1 CPU / 512 MB) o el de la instancia de nube donde correría ese contenedor.

### 7.3 Nube: instancia EC2

| Dato | Valor propuesto |
|---|---|
| Instancia | `t3.small`: 2 vCPU, 2 GiB, red "hasta 5 Gbps" |
| Disco | gp3 de 20 GB (3.000 IOPS y 125 MB/s de base) |
| Región | `us-east-1` (la más barata y con más disponibilidad) |
| Sistema | Ubuntu Server 24.04 LTS |
| Precio | Consultar la página oficial de precios de EC2 el día de la medición y guardar captura con fecha |

Punto clave de arquitectura: **t3 es una instancia "burstable"**. Tiene un CPU base de 20 % por vCPU y acumula créditos cuando está por debajo. En una prueba larga los créditos se gastan y, en modo "standard", el CPU cae al 20 %; en modo "unlimited" (el defecto de t3) sigue rápido pero cobra extra. Hay que registrar `CPUCreditBalance` y `CPUSurplusCreditsCharged` en CloudWatch y mencionarlo en el costo. También medimos `steal` en `/proc/stat`: es el tiempo que el hipervisor le quita a nuestra máquina virtual.

Opcional, si el presupuesto lo permite: repetir en `c7i.large` (2 vCPU dedicados, no burstable) para separar "poco CPU" de "CPU estrangulado por créditos".

**Dónde corre el generador:** desde el PC, a través de internet. La latencia del cliente incluirá unos 60 a 150 ms de red entre Colombia y Virginia, por eso la comparación entre entornos se hace con la latencia del servidor. Si hay presupuesto, una segunda instancia pequeña en la misma zona como generador elimina ese ruido.

---

## 8. Paso a paso: desplegar y probar en AWS

> La versión con los comandos exactos está en [`setup/SETUP.md`](setup/SETUP.md), sección 5.

### 8.1 Preparar la cuenta (una sola vez)

1. Crear la cuenta de AWS (o usar AWS Academy si el curso la ofrece) y activar MFA en el usuario raíz.
2. **Crear una alarma de presupuesto** en Billing → Budgets: presupuesto mensual de 10 USD con aviso al correo al 50 % y al 80 %. Es la protección contra olvidar una instancia encendida.
3. Elegir la región `us-east-1` en la esquina superior derecha de la consola.

### 8.2 Red y acceso

4. EC2 → Key Pairs → crear `shareboard-perf` (formato `.pem`), guardarla en `~/.ssh/` con `chmod 400`.
5. EC2 → Security Groups → crear `shareboard-perf-sg` con estas reglas de entrada, todas restringidas a **mi IP** (no a `0.0.0.0/0`):
   - 22 (SSH)
   - 3000 (servidor Shareboard)
   - 7071 (agente de telemetría)
6. Mongo (27017) **no** se abre: solo lo usa el servidor dentro de la misma máquina.

### 8.3 Lanzar la instancia

7. EC2 → Launch instance: nombre `shareboard-perf`, imagen Ubuntu 24.04, tipo `t3.small`, el key pair y el security group anteriores, disco gp3 de 20 GB.
8. En "Advanced details", dejar `Credit specification` en `unlimited` y anotarlo (o elegir `standard` y documentar la diferencia).
9. Anotar la IP pública.

### 8.4 Instalar el entorno

10. Conectarse: `ssh -i ~/.ssh/shareboard-perf.pem ubuntu@<IP>`.
11. Instalar Docker (paquete oficial `docker.io` y `docker-compose-v2`) y Node 22 (con `nvm` o el repositorio de NodeSource).
12. Copiar el servidor y la carpeta de telemetría con `rsync` desde el PC (el mismo commit que se midió en local). Ejecutar `npm ci && npm run build` en `server/`.
13. Levantar Mongo con el mismo `analitics/envs/compose.yml` que en local.
14. Los datos iniciales los crea el laboratorio al preparar (`lab.mjs --target-only`).
15. Iniciar el servidor con `NODE_ENV=production`, `METRICS=true`, `MONGO_URL` local y los límites de tasa elevados.
16. Iniciar el agente de telemetría.
17. Verificar desde el PC: `curl http://<IP>:3000/health` debe responder con `db: true`.

### 8.5 Medir

18. Desde el PC, lanzar el controlador apuntando a `http://<IP>:3000` y al agente en `<IP>:7071`.
19. Ejecutar la prueba adaptativa completa (sección 6).
20. En CloudWatch, exportar `CPUUtilization`, `CPUCreditBalance`, `NetworkIn/Out` y `EBSReadOps/WriteOps` del mismo intervalo, como verificación cruzada de nuestras métricas.

### 8.6 Cerrar

21. Descargar los datos crudos con `rsync` a `analitics/data/raw/aws/`.
22. **Terminar** (no solo detener) la instancia y borrar el volumen si quedó. Revisar en Billing al día siguiente que no haya cargos corriendo.

Costo esperado de toda la fase: menos de 2 USD (unas pocas horas de `t3.small` más el disco).

---

## 9. Análisis: de los números a la arquitectura

### 9.1 Método USE por recurso

Para cada recurso y cada entorno se llena esta tabla con los datos del escalón límite:

| Recurso | Utilización (qué tan ocupado) | Saturación (cuánto trabajo espera) | Errores |
|---|---|---|---|
| CPU | % por núcleo, % del proceso | Procesos en cola, event loop lag, `throttled_usec`, `steal` | n/a |
| Memoria | RSS, heap | Uso de swap, cercanía al límite del cgroup | OOM kills |
| Disco | % ocupado, IOPS, MB/s | Espera media por operación, `iowait` | Errores de E/S |
| Red | Bytes/s frente a capacidad del enlace | Retransmisiones TCP, buffers de socket llenos | Conexiones reiniciadas |

**Dónde espera la aplicación:** el recurso con mayor saturación en el escalón donde se rompe el criterio. Ejemplo de redacción esperada: "en el escalón de 240 usuarios el núcleo 2 está al 98 % mientras los otros 17 están por debajo del 15 %, el event loop lag p99 sube de 2 ms a 180 ms y el disco está al 1 %: la aplicación espera CPU, específicamente el único hilo de JavaScript".

### 9.2 Plantilla para cada hallazgo

Cada conclusión del informe sigue esta forma, que es la misma que piden las preguntas de la sustentación:

1. **Número:** qué se midió y cuánto dio.
2. **Cómo se midió:** fuente exacta y ventana de tiempo.
3. **Componente responsable:** núcleo, threadpool, controlador de memoria, NVMe, interfaz de red, hipervisor.
4. **Mecanismo:** por qué ese componente produce ese número.
5. **Qué pasa con 10x de carga:** qué se rompe primero y por qué.

### 9.3 Tabla comparativa final

| Entorno | Usuarios máx. con buen rendimiento | Cuello de botella | Qué le sobra | Qué le falta | Costo mensual |
|---|---|---|---|---|---|
| PC físico | | | | | |
| Contenedor 1 CPU / 512 MB | | | | | |
| EC2 t3.small | | | | | |

Con una columna adicional derivada: **costo por cada 100 usuarios soportados**, que es la forma justa de comparar opciones de distinto tamaño.

---

## 10. Mejoras a evaluar (experimentos A/B)

Después de tener la línea base, se eligen **una o dos** mejoras y se miden con exactamente la misma prueba. Solo se proponen las que atacan el cuello de botella encontrado; si el cuello resulta ser otro, se cambia la lista.

| Mejora | Ataca | Cómo se mide el efecto | Riesgo o costo |
|---|---|---|---|
| Ajustar `UV_THREADPOOL_SIZE` al número de núcleos | H2 (logins en fila) | Logins por segundo y p95 de login | Más memoria en picos (16 MB por login simultáneo) |
| Agrupar o limitar mensajes de cursor en el servidor (por ejemplo, uno cada 50 ms por usuario) | H3 (fan-out) | Mensajes y bytes de salida por segundo, CPU del proceso | Cursores ajenos menos fluidos |
| Varios procesos de Node (cluster) con afinidad por tablero | H1 (un solo hilo) | Usuarios máximos y uso de núcleos | Cambio de arquitectura: el hub en memoria obliga a enviar a todos los usuarios de un tablero al mismo proceso |
| Índice en Mongo para la consulta de `/me/boards` | H7 o lecturas lentas | p95 de listar, operaciones de Mongo | Casi ninguno |
| Compresión de WebSocket (`permessage-deflate`) | Red de salida | Bytes por segundo frente a CPU | Intercambia red por CPU; útil solo si la red es el cuello |

El resultado se presenta como "antes y después" en la misma gráfica de usuarios contra latencia.

---

## 11. Riesgos y cómo los controlamos

| Riesgo | Efecto | Control |
|---|---|---|
| El generador se satura antes que el servidor | Límite falso, demasiado bajo | Medir CPU del generador; invalidar si pasa del 70 % |
| Límites de tasa del servidor | Errores 429 que no son de rendimiento | Variables de entorno elevadas, verificadas antes de medir |
| Puertos o descriptores agotados en el generador | Errores `EMFILE` o `EADDRNOTAVAIL` | `ulimit -n 65535` en ambas máquinas |
| Calor del portátil | La frecuencia baja a mitad de la prueba | Registrar frecuencia y temperatura; ventilación; repetir si hay throttling |
| Créditos de CPU de t3 | Resultados distintos según la hora | Registrar `CPUCreditBalance`; documentar el modo |
| Latencia de internet en la prueba de nube | Latencia de cliente inflada | Comparar con latencia del servidor |
| Variabilidad entre corridas | Conclusiones poco firmes | Repetir el escalón límite 3 veces y reportar la dispersión |
| Olvidar la instancia encendida | Cobro inesperado | Alarma de presupuesto; terminar al cerrar cada sesión |

---

## 12. Cronograma

| Fecha | Fase | Resultado |
|---|---|---|
| 30 y 31 oct | Fase 0: preparación | `compose.yml`, `Dockerfile`, datos semilla (sin tocar el servidor) |
| 31 oct a 2 nov | Fase 1: herramientas | Agente, generador, controlador y panel funcionando contra el PC |
| 2 y 3 nov | Fase 2: calibración | Pruebas aisladas por operación (sección 5.3), costos unitarios, umbrales confirmados |
| 3 a 5 nov | Fase 3: medición | Prueba adaptativa en PC, contenedor y EC2; confirmación de 15 min en cada uno |
| 4 nov | Asesoría | Llevar las primeras gráficas y la tabla USE parcial |
| 5 a 7 nov | Fase 4: mejoras | Uno o dos experimentos A/B (sección 10) |
| 7 a 9 nov | Fase 5: informe | 6 a 10 páginas, tabla comparativa, recomendación |
| 9 y 10 nov | Fase 6: sustentación | Presentación de 7 min y ensayo de las cuatro preguntas típicas |

---

## 13. Entregables

1. **Informe (6 a 10 páginas):** aplicación, generación de carga, mediciones, tabla comparativa y recomendación.
2. **Datos crudos:** `analitics/data/raw/` con una carpeta por corrida (métricas del agente, métricas del generador, configuración usada).
3. **Guiones:** todo `analitics/` más los cambios mínimos al servidor (ruta de métricas), con instrucciones para repetir cada prueba.
4. **Sustentación:** 7 minutos con tres gráficas centrales:
   - Usuarios contra latencia p95 en los tres entornos (dónde se dobla cada curva).
   - CPU por núcleo en el escalón límite (dónde espera la aplicación).
   - Costo por cada 100 usuarios (la recomendación).

### 13.1 Preparación para las preguntas típicas

| Pregunta | Qué debemos poder responder con los datos |
|---|---|
| ¿Por qué ese número y no otro? ¿Cómo lo midieron? | Fuente exacta (sección 4.3), ventana del escalón, cuántas repeticiones |
| ¿Qué componente causa ese comportamiento? | El de la tabla USE con mayor saturación, y su mecanismo |
| Si la carga fuera 10x, ¿qué se rompe primero? | Extrapolación con los costos unitarios de la calibración |
| ¿Qué opción descartaron y por qué? | La que peor costo por 100 usuarios tenga, o la que no soporte la carga objetivo |

---

## 14. Decisiones pendientes

- **Carga objetivo** para decir "soporta" o "no soporta": proponemos 100 usuarios concurrentes (unos 20 tableros activos de 5 personas), que es una cifra creíble para un curso o una empresa pequeña. Se ajusta cuando veamos la calibración.
- **Generador en la nube** para la prueba de AWS: solo si el presupuesto lo permite.
- **Segunda instancia de nube** (`c7i.large`): opcional, para separar el efecto de los créditos de CPU.
