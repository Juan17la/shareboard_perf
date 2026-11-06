# Mediciones

Qué se midió, cómo y con qué resultado, para las siete cargas en los cinco entornos (75 corridas, del 4 al 6 de noviembre de 2026). Todo sale de mediciones propias guardadas en `resultados/`. Las tablas de la sección 4 se generan con un comando a partir de esos archivos:

```bash
node telemetry/tablas.mjs        # imprime las tablas de la sección 4
```

---

## 1. Entornos medidos

| Entorno | Máquina | CPU disponible para el servidor | Memoria | Disco | Carga generada desde |
|---|---|---|---|---|---|
| **PC nativo** | ASUS Zenbook 14 UX3405MA, Debian 13, kernel 6.12 | Intel Core Ultra 5 125H: P-cores 0-7 (4 núcleos con hyperthreading, hasta 4,5 GHz), sin límite | 15 GB | NVMe Micron 2550, 512 GB | El mismo PC, E-cores |
| **Contenedor 1 CPU** | El mismo PC | Los mismos P-cores, con cuota de **1 CPU** | **512 MB**, sin swap | El mismo | El mismo PC, E-cores |
| **Contenedor 2 CPU** | El mismo PC | Los mismos P-cores, con cuota de **2 CPU** | **512 MB**, sin swap | El mismo | El mismo PC, E-cores |
| **AWS Unlimited** | EC2 t3.small, us-east-1, Ubuntu 26.04.1 | 2 vCPU Intel Xeon Platinum 8259CL a 2,5 GHz de base (= **1 núcleo físico** con 2 hilos), créditos Unlimited | 1,9 GB, sin swap | EBS gp3 20 GiB | Otra instancia EC2 (t3.micro) en la misma zona |
| **AWS Limited** | La misma instancia | Igual, con créditos *standard*: base de ~20 % de la máquina | 1,9 GB, sin swap | El mismo | La misma |

Igual en todos: el mismo código del servidor (`servidor/`), Node 22, MongoDB 7 en Docker, 1.500 cuentas y 2.000 tableros de prueba, el mismo perfil de carga y los mismos criterios. Antes de cada prueba se reinicia el servidor y se restaura la base. En los contenedores, MongoDB también está limitado (1 CPU, 1 GB).

Validez de la carga: el bucle de eventos del hilo más ocupado del generador llegó como máximo al 73 % (AWS, 2.000 usuarios), por debajo del 85 % en que el laboratorio invalida una prueba.

## 2. Qué se mide y de dónde sale cada número

El agente de telemetría corre en la máquina del servidor, **fuera** del servidor: no lo instrumenta ni lo modifica. Cada segundo lee archivos del kernel y calcula la diferencia con la lectura anterior.

| Métrica del enunciado | Equivale a | Fuente exacta |
|---|---|---|
| CPU us / sy / wa / id / st | Columnas de `top` | `/proc/stat` línea `cpu`: diferencia de *jiffies* (10 ms) de user+nice, system+irq+softirq, iowait, idle y steal entre dos lecturas |
| CPU por núcleo y núcleo más ocupado | `mpstat -P ALL 1` | Líneas `cpu0…cpuN` de `/proc/stat` |
| CPU por hilo del servidor | `top -H -p PID` | `/proc/<pid>/task/<tid>/stat` (utime + stime), agrupado por nombre: hilo principal de JavaScript, `libuv-worker` (threadpool) y hilos de V8 |
| Contenedor frenado | — | `cpu.stat` del cgroup: `throttled_usec` |
| Memoria residente | `top` → RES | `VmRSS` de `/proc/<pid>/status` |
| Disco: IOPS, MB/s, %util | `iostat -x 1` | `/proc/diskstats`: lecturas, escrituras, sectores y milisegundos con E/S en curso |
| Red: entrada y salida | `sar -n DEV 1` | `/proc/net/dev`, la interfaz con más tráfico |
| Latencia del usuario p50 / p95 / p99 | — | El generador: tiempo de cada petición REST, de cada login, del trazo hasta que lo reciben los demás y del ping por WebSocket. Histograma logarítmico con error máximo de 4 % |
| Latencia dentro del servidor | — | Campo `responseTime` del log de Fastify, leído por el agente. No incluye la red ni la espera antes de que Node acepte la conexión |

Se reporta el **promedio y el pico** de cada recurso en la ventana medida (600 s), y la latencia en **percentiles**, nunca en promedio.

---

## 3. Lectura rápida

| | Baja (100) | Media (300) | Alta (600) | 1.000 | 2.000 | 3.000 | Killer (6.000) |
|---|---|---|---|---|---|---|---|
| PC nativo | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✓ | ✓ | ✕ 0/3 |
| Contenedor 1 CPU | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✕ | ✕ | ✕ cayó 3/3 |
| Contenedor 2 CPU | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✓ | ✕ cayó | ✕ cayó 3/3 |
| AWS Unlimited | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✕ | ✕ | ✕ cayó 3/3 |
| AWS Limited | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 (con créditos) | ✕ | ✕ | ✕ | ✕ 0/3 |

Baja, media, alta y killer tienen 3 repeticiones; 1.000, 2.000 y 3.000 tienen 1. Las causas se explican en [COMPARACIONES.md](COMPARACIONES.md) y [CONCLUSIONES.md](CONCLUSIONES.md).

---

## 4. Tablas

### Resumen: mediana de las repeticiones

Las latencias solo usan corridas con el servidor vivo.

| Entorno | Prueba | Pasan | Caídas | Conectados | Msg/s | Hilo JS % | RES máx. MB | REST p50 / p95 / p99 | Ping p99 | Errores % |
|---|---|---|---|---|---|---|---|---|---|---|
| PC nativo | Baja | 3/3 | 0 | 99 | 360 | 4,1 | 224 | 3,4 / 31 / 33 | 0,5 | 0 |
| PC nativo | Media | 3/3 | 0 | 293 | 949 | 9,3 | 246 | 3,2 / 20 / 32 | 0,6 | 0 |
| PC nativo | Alta | 3/3 | 0 | 577 | 1.870 | 17,7 | 283 | 3,2 / 30 / 32 | 0,9 | 0 |
| PC nativo | 1.000 | 1/1 | 0 | 960 | 2.958 | 28,7 | 319 | 3 / 31 / 32 | 2,1 | 0 |
| PC nativo | 2.000 | 1/1 | 0 | 1.921 | 5.204 | 51,4 | 405 | 3,7 / 28 / 32 | 5,9 | 0 |
| PC nativo | 3.000 | 1/1 | 0 | 2.825 | 9.185 | 78,5 | 529 | 5,5 / 40 / 100 | 47 | 0 |
| PC nativo | Server killer | 0/3 | 0 | 4.127 | 12.353 | 99,3 | 816 | 827 / 15.071 / 15.071 | 1.007 | 38 |
| Contenedor 1 CPU | Baja | 3/3 | 0 | 99 | 360 | 4,1 | 181 | 3,6 / 30 / 39 | 0,6 | 0 |
| Contenedor 1 CPU | Media | 3/3 | 0 | 289 | 967 | 11 | 220 | 3,4 / 31 / 36 | 0,7 | 0 |
| Contenedor 1 CPU | Alta | 3/3 | 0 | 574 | 1.900 | 22,5 | 263 | 3,6 / 31 / 35 | 1,9 | 0 |
| Contenedor 1 CPU | 1.000 | 1/1 | 0 | 959 | 3.063 | 33,2 | 298 | 3,6 / 13 / 45 | 22 | 0 |
| Contenedor 1 CPU | 2.000 | 0/1 | 0 | 1.901 | 5.923 | 69 | 398 | 6,4 / 218 / 378 | 227 | 0 |
| Contenedor 1 CPU | 3.000 | 0/1 | 0 | 2.427 | 7.285 | 83,8 | 448 | 15.071 / 15.071 / 15.071 | 1.225 | 63,4 |
| Contenedor 1 CPU | Server killer | 0/3 | 3 | – | – | – | – | – | – | – |
| Contenedor 2 CPU | Baja | 3/3 | 0 | 99 | 359 | 3,6 | 176 | 3,6 / 9,8 / 32 | 0,6 | 0 |
| Contenedor 2 CPU | Media | 3/3 | 0 | 289 | 893 | 10,9 | 216 | 3,4 / 30 / 32 | 0,7 | 0 |
| Contenedor 2 CPU | Alta | 3/3 | 0 | 581 | 1.852 | 21,7 | 249 | 3,6 / 30 / 33 | 1,2 | 0 |
| Contenedor 2 CPU | 1.000 | 1/1 | 0 | 963 | 3.021 | 32,5 | 329 | 3,8 / 30 / 33 | 2,6 | 0 |
| Contenedor 2 CPU | 2.000 | 1/1 | 0 | 1.856 | 5.366 | 74,9 | 408 | 6,9 / 53 / 131 | 65 | 0 |
| Contenedor 2 CPU | 3.000 | 0/1 | 1 | – | – | – | – | – | – | – |
| Contenedor 2 CPU | Server killer | 0/3 | 3 | – | – | – | – | – | – | – |
| AWS Unlimited | Baja | 3/3 | 0 | 100 | 319 | 8,7 | 182 | 5,9 / 51 / 57 | 1,4 | 0 |
| AWS Unlimited | Media | 3/3 | 0 | 296 | 965 | 22,7 | 220 | 5,7 / 49 / 57 | 3,6 | 0 |
| AWS Unlimited | Alta | 3/3 | 0 | 580 | 1.925 | 45,3 | 257 | 7,2 / 51 / 57 | 12 | 0 |
| AWS Unlimited | 1.000 | 1/1 | 0 | 976 | 2.914 | 74,1 | 337 | 11 / 55 / 112 | 53 | 0 |
| AWS Unlimited | 2.000 | 0/1 | 0 | 1.879 | 5.615 | 96,6 | 506 | 654 / 15.071 / 15.071 | 1.047 | 15,5 |
| AWS Unlimited | 3.000 | 0/1 | 0 | 2.119 | 6.349 | 95,7 | 550 | 7.439 / 15.071 / 15.071 | 1.433 | 50,9 |
| AWS Unlimited | Server killer | 0/3 | 3 | – | – | – | – | – | – | – |
| AWS Limited | Baja | 3/3 | 0 | 99 | 310 | 9,3 | 214 | 5,9 / 51 / 57 | 1,7 | 0 |
| AWS Limited | Media | 3/3 | 0 | 295 | 940 | 23,7 | 238 | 5,9 / 49 / 55 | 3,4 | 0 |
| AWS Limited | Alta | 3/3 | 0 | 582 | 1.711 | 41,9 | 265 | 6,4 / 26 / 57 | 7,2 | 0 |
| AWS Limited | 1.000 | 0/1 | 0 | 628 | 1.901 | 90 | 346 | 15.071 / 15.071 / 15.071 | 3.672 | 80,5 |
| AWS Limited | 2.000 | 0/1 | 0 | 746 | 2.338 | 86,2 | 427 | 15.071 / 15.071 / 15.071 | 2.902 | 100 |
| AWS Limited | 3.000 | 0/1 | 0 | 673 | 1.828 | 78,8 | 446 | 15.071 / 15.071 / 15.071 | 2.580 | 100 |
| AWS Limited | Server killer | 0/3 | 0 | 1.368 | 3.892 | 88,7 | 620 | 10.589 / 15.071 / 15.071 | 10.589 | 100 |

### Resultado

| Entorno | Prueba | Rep. | Resultado | Segundos medidos | Usuarios conectados | Entradas/s | Errores | Motivo |
|---|---|---|---|---|---|---|---|---|
| PC nativo | Baja | 1 | ✓ pasa | 600 | 96 | 0,1 | 0 % | – |
| PC nativo | Baja | 2 | ✓ pasa | 600 | 99 | 0,09 | 0 % | – |
| PC nativo | Baja | 3 | ✓ pasa | 600 | 99 | 0,02 | 0 % | – |
| PC nativo | Media | 1 | ✓ pasa | 600 | 291 | 0,16 | 0 % | – |
| PC nativo | Media | 2 | ✓ pasa | 600 | 294 | 0,2 | 0 % | – |
| PC nativo | Media | 3 | ✓ pasa | 600 | 293 | 0,24 | 0 % | – |
| PC nativo | Alta | 1 | ✓ pasa | 600 | 575 | 0,26 | 0 % | – |
| PC nativo | Alta | 2 | ✓ pasa | 600 | 589 | 0,32 | 0 % | – |
| PC nativo | Alta | 3 | ✓ pasa | 600 | 577 | 0,26 | 0 % | – |
| PC nativo | 1.000 | 1 | ✓ pasa | 600 | 960 | 0,48 | 0 % | – |
| PC nativo | 2.000 | 1 | ✓ pasa | 600 | 1.921 | 0,85 | 0 % | – |
| PC nativo | 3.000 | 1 | ✓ pasa | 600 | 2.825 | 1,62 | 0 % | – |
| PC nativo | Server killer | 1 | ✕ no pasa | 600 | 4.127 | 3,65 | 38 % | p95 REST 15070 ms > 300; p95 autenticación 15070 ms > 1000; p95 difusión 348 ms > 150; p95 preview 275 ms > 150; p99 ping 1006 ms > 100; errores 38 % (join:TIMEOUT x1252) |
| PC nativo | Server killer | 2 | ✕ no pasa | 600 | 4.077 | 3,81 | 33,68 % | p95 REST 15070 ms > 300; p95 autenticación 15070 ms > 1000; p95 difusión 348 ms > 150; p95 preview 264 ms > 150; p99 ping 1324 ms > 100; errores 33.7 % (join:TIMEOUT x1152) |
| PC nativo | Server killer | 3 | ✕ no pasa | 600 | 4.601 | 2,89 | 53,41 % | p95 REST 15070 ms > 300; p95 autenticación 15070 ms > 1000; p95 difusión 209 ms > 150; p95 preview 159 ms > 150; p99 ping 628 ms > 100; errores 53.4 % (join:TIMEOUT x1650) |
| Contenedor 1 CPU | Baja | 1 | ✓ pasa | 600 | 99 | 0,04 | 0 % | – |
| Contenedor 1 CPU | Baja | 2 | ✓ pasa | 600 | 99 | 0,05 | 0 % | – |
| Contenedor 1 CPU | Baja | 3 | ✓ pasa | 600 | 99 | 0,08 | 0 % | – |
| Contenedor 1 CPU | Media | 1 | ✓ pasa | 600 | 288 | 0,16 | 0 % | – |
| Contenedor 1 CPU | Media | 2 | ✓ pasa | 600 | 292 | 0,22 | 0 % | – |
| Contenedor 1 CPU | Media | 3 | ✓ pasa | 600 | 289 | 0,18 | 0 % | – |
| Contenedor 1 CPU | Alta | 1 | ✓ pasa | 600 | 574 | 0,33 | 0 % | – |
| Contenedor 1 CPU | Alta | 2 | ✓ pasa | 600 | 582 | 0,38 | 0 % | – |
| Contenedor 1 CPU | Alta | 3 | ✓ pasa | 600 | 569 | 0,48 | 0 % | – |
| Contenedor 1 CPU | 1.000 | 1 | ✓ pasa | 600 | 959 | 0,54 | 0 % | – |
| Contenedor 1 CPU | 2.000 | 1 | ✕ no pasa | 600 | 1.901 | 1,11 | 0 % | p99 ping 226 ms > 100 |
| Contenedor 1 CPU | 3.000 | 1 | ✕ no pasa | 600 | 2.427 | 1,34 | 63,41 % | p95 REST 15070 ms > 300; p95 autenticación 15070 ms > 1000; p95 difusión 628 ms > 150; p95 preview 496 ms > 150; p99 ping 1224 ms > 100; errores 63.4 % (list:TIMEOUT x1361) |
| Contenedor 1 CPU | Server killer | 1 | ✕ servidor caído (100 % de la ventana) | 600 | 0 | 0 | 100 % | errores 100 % (join:ECONNREFUSED x4601) |
| Contenedor 1 CPU | Server killer | 2 | ✕ servidor caído (100 % de la ventana) | 600 | 0 | 0 | 100 % | errores 100 % (join:ECONNREFUSED x4172) |
| Contenedor 1 CPU | Server killer | 3 | ✕ servidor caído (100 % de la ventana) | 600 | 0 | 0 | 100 % | errores 100 % (join:ECONNREFUSED x4883) |
| Contenedor 2 CPU | Baja | 1 | ✓ pasa | 600 | 98 | 0,05 | 0 % | – |
| Contenedor 2 CPU | Baja | 2 | ✓ pasa | 600 | 100 | 0,03 | 0 % | – |
| Contenedor 2 CPU | Baja | 3 | ✓ pasa | 600 | 99 | 0,06 | 0 % | – |
| Contenedor 2 CPU | Media | 1 | ✓ pasa | 600 | 289 | 0,28 | 0 % | – |
| Contenedor 2 CPU | Media | 2 | ✓ pasa | 600 | 298 | 0,12 | 0 % | – |
| Contenedor 2 CPU | Media | 3 | ✓ pasa | 600 | 288 | 0,21 | 0 % | – |
| Contenedor 2 CPU | Alta | 1 | ✓ pasa | 600 | 586 | 0,35 | 0 % | – |
| Contenedor 2 CPU | Alta | 2 | ✓ pasa | 600 | 571 | 0,3 | 0 % | – |
| Contenedor 2 CPU | Alta | 3 | ✓ pasa | 600 | 581 | 0,36 | 0 % | – |
| Contenedor 2 CPU | 1.000 | 1 | ✓ pasa | 600 | 963 | 0,6 | 0 % | – |
| Contenedor 2 CPU | 2.000 | 1 | ✓ pasa | 600 | 1.856 | 0,97 | 0 % | – |
| Contenedor 2 CPU | 3.000 | 1 | ✕ servidor caído (70 % de la ventana) | 600 | 763 | 0,68 | 93,96 % | p95 REST 15070 ms > 300; p95 autenticación 15070 ms > 1000; p95 difusión 441 ms > 150; p95 preview 348 ms > 150; p99 ping 1610 ms > 100; errores 94 % (ws:SOCKET_ERROR x3136) |
| Contenedor 2 CPU | Server killer | 1 | ✕ servidor caído (100 % de la ventana) | 600 | 0 | 0 | 100 % | errores 100 % (join:ECONNREFUSED x4636) |
| Contenedor 2 CPU | Server killer | 2 | ✕ servidor caído (100 % de la ventana) | 600 | 0 | 0 | 100 % | errores 100 % (join:ECONNREFUSED x4381) |
| Contenedor 2 CPU | Server killer | 3 | ✕ servidor caído (0 % de la ventana) | 65 | 1.122 | 31,06 | 2,15 % | memoria del contenedor al 100 %; p95 REST 6877 ms > 300; p95 difusión 264 ms > 150; p95 preview 185 ms > 150; p99 ping 516 ms > 100; errores 2.1 % (join:TIMEOUT x55) |
| AWS Unlimited | Baja | 1 | ✓ pasa | 600 | 100 | 0,05 | 0 % | – |
| AWS Unlimited | Baja | 2 | ✓ pasa | 600 | 100 | 0,04 | 0 % | – |
| AWS Unlimited | Baja | 3 | ✓ pasa | 600 | 98 | 0,12 | 0 % | – |
| AWS Unlimited | Media | 1 | ✓ pasa | 600 | 292 | 0,22 | 0 % | – |
| AWS Unlimited | Media | 2 | ✓ pasa | 600 | 296 | 0,15 | 0 % | – |
| AWS Unlimited | Media | 3 | ✓ pasa | 600 | 299 | 0,08 | 0 % | – |
| AWS Unlimited | Alta | 1 | ✓ pasa | 600 | 576 | 0,33 | 0 % | – |
| AWS Unlimited | Alta | 2 | ✓ pasa | 600 | 587 | 0,24 | 0 % | – |
| AWS Unlimited | Alta | 3 | ✓ pasa | 600 | 580 | 0,37 | 0 % | – |
| AWS Unlimited | 1.000 | 1 | ✓ pasa | 600 | 976 | 0,43 | 0 % | – |
| AWS Unlimited | 2.000 | 1 | ✕ no pasa | 600 | 1.879 | 1,2 | 15,52 % | p95 REST 15069 ms > 300; p95 difusión 457 ms > 150; p95 preview 361 ms > 150; p99 ping 1045 ms > 100; errores 15.5 % (join:TIMEOUT x197) |
| AWS Unlimited | 3.000 | 1 | ✕ no pasa | 600 | 2.119 | 1,82 | 50,94 % | p95 REST 15068 ms > 300; p95 autenticación 15068 ms > 1000; p95 difusión 375 ms > 150; p95 preview 333 ms > 150; p99 ping 1430 ms > 100; errores 50.9 % (join:TIMEOUT x1441) |
| AWS Unlimited | Server killer | 1 | ✕ servidor caído (48 % de la ventana) | 600 | 1.356 | 1,93 | 90,43 % | p95 REST 15069 ms > 300; p95 autenticación 15069 ms > 1000; p95 difusión 423 ms > 150; p95 preview 321 ms > 150; p99 ping 1130 ms > 100; errores 90.4 % (ws:SOCKET_ERROR x3911) |
| AWS Unlimited | Server killer | 2 | ✕ servidor caído (45 % de la ventana) | 600 | 1.242 | 0,93 | 100 % | p95 REST 15068 ms > 300; p95 autenticación 15068 ms > 1000; p95 difusión 406 ms > 150; p95 preview 346 ms > 150; p99 ping 2203 ms > 100; errores 100 % (join:TIMEOUT x3452) |
| AWS Unlimited | Server killer | 3 | ✕ servidor caído (12 % de la ventana) | 600 | 2.237 | 1,95 | 91,48 % | p95 REST 15069 ms > 300; p95 autenticación 15069 ms > 1000; p95 difusión 457 ms > 150; p95 preview 321 ms > 150; p99 ping 5225 ms > 100; errores 91.5 % (join:TIMEOUT x3496) |
| AWS Limited | Baja | 1 | ✓ pasa | 600 | 99 | 0,08 | 0 % | – |
| AWS Limited | Baja | 2 | ✓ pasa | 600 | 97 | 0,13 | 0 % | – |
| AWS Limited | Baja | 3 | ✓ pasa | 600 | 99 | 0,09 | 0 % | – |
| AWS Limited | Media | 1 | ✓ pasa | 600 | 295 | 0,18 | 0 % | – |
| AWS Limited | Media | 2 | ✓ pasa | 600 | 297 | 0,14 | 0 % | – |
| AWS Limited | Media | 3 | ✓ pasa | 600 | 284 | 0,1 | 0 % | – |
| AWS Limited | Alta | 1 | ✓ pasa | 600 | 582 | 0,41 | 0 % | – |
| AWS Limited | Alta | 2 | ✓ pasa | 600 | 580 | 0,21 | 0 % | – |
| AWS Limited | Alta | 3 | ✓ pasa | 600 | 590 | 0,23 | 0 % | – |
| AWS Limited | 1.000 | 1 | ✕ no pasa | 600 | 628 | 0,34 | 80,53 % | p95 REST 15069 ms > 300; p95 difusión 1883 ms > 150; p95 preview 1547 ms > 150; p99 ping 3670 ms > 100; errores 80.5 % (join:TIMEOUT x578) |
| AWS Limited | 2.000 | 1 | ✕ no pasa | 600 | 746 | 0,02 | 100 % | p95 REST 15069 ms > 300; p95 autenticación 15069 ms > 1000; p95 difusión 1375 ms > 150; p95 preview 1222 ms > 150; p99 ping 2900 ms > 100; errores 100 % (join:UND_ERR_CONNECT_TIMEOUT x1521) |
| AWS Limited | 3.000 | 1 | ✕ no pasa | 600 | 673 | 0,04 | 100 % | p95 REST 15069 ms > 300; p95 autenticación 15069 ms > 1000; p95 difusión 1130 ms > 150; p95 preview 966 ms > 150; p99 ping 2578 ms > 100; errores 100 % (join:TIMEOUT x2590) |
| AWS Limited | Server killer | 1 | ✕ no pasa | 600 | 1.579 | 0,38 | 100 % | p95 REST 15069 ms > 300; p95 autenticación 15069 ms > 1000; p95 difusión 7151 ms > 150; p95 preview 6112 ms > 150; p99 ping 14489 ms > 100; errores 100 % (join:UND_ERR_CONNECT_TIMEOUT x4986) |
| AWS Limited | Server killer | 2 | ✕ no pasa | 600 | 1.368 | 0,03 | 100 % | p95 REST 15069 ms > 300; p95 autenticación 15069 ms > 1000; p95 difusión 5434 ms > 150; p95 preview 4830 ms > 150; p99 ping 10586 ms > 100; errores 100 % (join:UND_ERR_CONNECT_TIMEOUT x6918) |
| AWS Limited | Server killer | 3 | ✕ no pasa | 600 | 1.212 | 0,02 | 100 % | p95 REST 15067 ms > 300; p95 autenticación 15067 ms > 1000; p95 difusión 3669 ms > 150; p95 preview 3136 ms > 150; p99 ping 6111 ms > 100; errores 100 % (join:UND_ERR_CONNECT_TIMEOUT x6657) |

### CPU (promedio / pico)

| Entorno | Prueba | Rep. | Máquina % | Núcleo más ocupado % | us % | sy % | wa % | id % | st % | Hilo JS % | libuv % | Frenado ms/s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PC nativo | Baja | 1 | 5 / 24 | 12 / 56 | 3,4 / 20,2 | 1,5 / 6,6 | 0,3 / 2 | 95 / 99 | 0 / 0 | 4 / 10 | 0 / 40 | – |
| PC nativo | Baja | 2 | 5 / 18 | 21 / 93 | 3,4 / 14,2 | 1,9 / 8 | 0,2 / 2 | 94 / 98 | 0 / 0 | 4 / 9 | 0 / 14 | – |
| PC nativo | Baja | 3 | 4 / 14 | 9 / 47 | 2,6 / 12,3 | 1,1 / 5,9 | 0,3 / 1,5 | 96 / 99 | 0 / 0 | 4 / 8 | 0 / 12 | – |
| PC nativo | Media | 1 | 6 / 27 | 14 / 96 | 4,3 / 21,3 | 1,6 / 6,3 | 0,3 / 3,1 | 94 / 98 | 0 / 0 | 10 / 16 | 0 / 14 | – |
| PC nativo | Media | 2 | 5 / 24 | 14 / 75 | 3,5 / 20,5 | 1,6 / 6,3 | 0,2 / 1,5 | 95 / 98 | 0 / 0 | 9 / 17 | 0 / 14 | – |
| PC nativo | Media | 3 | 2 / 12 | 7 / 27 | 1,4 / 7,5 | 0,7 / 4,8 | 0,1 / 1,4 | 98 / 99 | 0 / 0 | 7 / 14 | 0 / 13 | – |
| PC nativo | Alta | 1 | 7 / 24 | 16 / 72 | 4,8 / 19,2 | 2 / 5,9 | 0,4 / 3,5 | 93 / 97 | 0 / 0 | 19 / 28 | 0 / 17 | – |
| PC nativo | Alta | 2 | 8 / 30 | 19 / 88 | 5,8 / 25 | 2 / 6,3 | 0,3 / 3,6 | 92 / 97 | 0 / 0 | 18 / 27 | 1 / 28 | – |
| PC nativo | Alta | 3 | 4 / 13 | 13 / 33 | 2,4 / 8,2 | 1,2 / 5,1 | 0,1 / 2,2 | 96 / 98 | 0 / 0 | 15 / 23 | 1 / 26 | – |
| PC nativo | 1.000 | 1 | 9 / 18 | 21 / 38 | 6 / 14,2 | 2,6 / 6,6 | 0,4 / 1,6 | 91 / 94 | 0 / 0 | 29 / 39 | 1 / 15 | – |
| PC nativo | 2.000 | 1 | 12 / 25 | 35 / 60 | 8,6 / 17,7 | 3,4 / 8,1 | 0,2 / 2,4 | 88 / 92 | 0 / 0 | 51 / 65 | 2 / 43 | – |
| PC nativo | 3.000 | 1 | 17 / 34 | 55 / 94 | 12,2 / 23,6 | 4,7 / 11 | 0,2 / 1,4 | 83 / 87 | 0 / 0 | 79 / 103 | 4 / 77 | – |
| PC nativo | Server killer | 1 | 22 / 46 | 70 / 100 | 15,7 / 35,5 | 6,1 / 12,7 | 0,4 / 2,5 | 78 / 86 | 0 / 0 | 98 / 104 | 8 / 83 | – |
| PC nativo | Server killer | 2 | 21 / 43 | 76 / 100 | 15 / 31,2 | 5,9 / 12,2 | 0,3 / 1,6 | 79 / 85 | 0 / 0 | 99 / 104 | 9 / 76 | – |
| PC nativo | Server killer | 3 | 21 / 47 | 73 / 100 | 14,8 / 36,5 | 6,3 / 11 | 0,3 / 1,6 | 79 / 84 | 0 / 0 | 100 / 104 | 8 / 80 | – |
| Contenedor 1 CPU | Baja | 1 | 4 / 23 | 11 / 65 | 3,1 / 17,9 | 1,4 / 6,1 | 0,2 / 2,6 | 95 / 99 | 0 / 0 | 5 / 10 | 0 / 13 | 0 / 0 |
| Contenedor 1 CPU | Baja | 2 | 4 / 20 | 11 / 97 | 2,9 / 17,2 | 1,2 / 5,5 | 0,3 / 1,5 | 96 / 99 | 0 / 0 | 4 / 9 | 0 / 13 | 0 / 1 |
| Contenedor 1 CPU | Baja | 3 | 3 / 14 | 7 / 47 | 2 / 12 | 1,1 / 5,7 | 0,2 / 1,8 | 97 / 99 | 0 / 0 | 4 / 8 | 0 / 13 | 0 / 4 |
| Contenedor 1 CPU | Media | 1 | 8 / 34 | 16 / 76 | 5,5 / 27,3 | 2,4 / 6,7 | 0,3 / 2,7 | 92 / 98 | 0 / 0 | 12 / 24 | 1 / 23 | 0 / 51 |
| Contenedor 1 CPU | Media | 2 | 8 / 33 | 19 / 100 | 5,4 / 24,3 | 2,5 / 8,6 | 0,4 / 12,2 | 92 / 98 | 0 / 0 | 11 / 20 | 0 / 17 | 0 / 53 |
| Contenedor 1 CPU | Media | 3 | 4 / 14 | 10 / 44 | 2,7 / 9,7 | 1,6 / 6 | 0,2 / 1,8 | 95 / 98 | 0 / 0 | 10 / 16 | 0 / 14 | 0 / 25 |
| Contenedor 1 CPU | Alta | 1 | 9 / 32 | 20 / 96 | 5,9 / 24,1 | 2,9 / 10,5 | 0,3 / 2,3 | 91 / 96 | 0 / 0 | 22 / 45 | 1 / 16 | 8 / 288 |
| Contenedor 1 CPU | Alta | 2 | 10 / 38 | 20 / 100 | 6,2 / 25,7 | 3,3 / 12 | 0,3 / 2,5 | 90 / 96 | 0 / 0 | 23 / 48 | 1 / 18 | 3 / 211 |
| Contenedor 1 CPU | Alta | 3 | 8 / 18 | 17 / 34 | 4,8 / 12,9 | 2,8 / 6,6 | 0,4 / 2,4 | 92 / 96 | 0 / 0 | 21 / 33 | 1 / 15 | 7 / 570 |
| Contenedor 1 CPU | 1.000 | 1 | 10 / 25 | 25 / 40 | 6,4 / 15,5 | 3,5 / 9,5 | 0,1 / 2,6 | 90 / 93 | 0 / 0 | 33 / 53 | 1 / 31 | 36 / 692 |
| Contenedor 1 CPU | 2.000 | 1 | 19 / 39 | 47 / 81 | 11,8 / 24,5 | 7 / 15 | 0,1 / 1,1 | 81 / 86 | 0 / 0 | 69 / 96 | 3 / 36 | 128 / 1.288 |
| Contenedor 1 CPU | 3.000 | 1 | 22 / 41 | 61 / 99 | 14,4 / 28,2 | 8 / 14,7 | 0,1 / 2,1 | 78 / 84 | 0 / 0 | 84 / 101 | 8 / 44 | 381 / 2.429 |
| Contenedor 1 CPU | Server killer | 1 | 4 / 23 | 11 / 100 | 2,9 / 19,1 | 1,1 / 6,4 | 0,6 / 2,2 | 96 / 99 | 0 / 0 | – | – | – |
| Contenedor 1 CPU | Server killer | 2 | 4 / 27 | 12 / 94 | 3,2 / 22,5 | 1,2 / 6 | 0,3 / 6,7 | 95 / 98 | 0 / 0 | – | – | – |
| Contenedor 1 CPU | Server killer | 3 | 3 / 14 | 7 / 24 | 1,8 / 10,4 | 0,8 / 4,5 | 0,3 / 2,3 | 97 / 98 | 0 / 0 | – | – | – |
| Contenedor 2 CPU | Baja | 1 | 4 / 26 | 10 / 64 | 2,9 / 21 | 1,1 / 5,8 | 0,2 / 2,5 | 96 / 99 | 0 / 0 | 3 / 7 | 0 / 11 | 0 / 0 |
| Contenedor 2 CPU | Baja | 2 | 5 / 27 | 12 / 77 | 3,6 / 23 | 1,5 / 7,1 | 0,3 / 2,7 | 95 / 99 | 0 / 0 | 4 / 14 | 0 / 16 | 0 / 0 |
| Contenedor 2 CPU | Baja | 3 | 3 / 12 | 6 / 31 | 1,7 / 9,4 | 0,9 / 4,8 | 0,2 / 3 | 97 / 99 | 0 / 0 | 4 / 7 | 0 / 14 | 0 / 0 |
| Contenedor 2 CPU | Media | 1 | 6 / 22 | 13 / 73 | 4,2 / 17,7 | 1,7 / 6,5 | 0,2 / 2,5 | 94 / 98 | 0 / 0 | 10 / 17 | 1 / 15 | 0 / 0 |
| Contenedor 2 CPU | Media | 2 | 6 / 23 | 12 / 42 | 3,8 / 16,3 | 2,1 / 7,7 | 0,3 / 1,6 | 94 / 97 | 0 / 0 | 11 / 18 | 0 / 18 | 0 / 0 |
| Contenedor 2 CPU | Media | 3 | 6 / 24 | 12 / 52 | 3,8 / 16,3 | 2,1 / 7,6 | 0,4 / 1,7 | 94 / 97 | 0 / 0 | 12 / 20 | 0 / 14 | 0 / 0 |
| Contenedor 2 CPU | Alta | 1 | 9 / 36 | 21 / 66 | 6,2 / 26,8 | 3,3 / 10,8 | 0,3 / 4,4 | 90 / 96 | 0 / 0 | 22 / 42 | 1 / 28 | 0 / 6 |
| Contenedor 2 CPU | Alta | 2 | 8 / 23 | 17 / 39 | 5,4 / 16,8 | 2,9 / 8,7 | 0,3 / 1,7 | 91 / 95 | 0 / 0 | 20 / 34 | 1 / 15 | 0 / 0 |
| Contenedor 2 CPU | Alta | 3 | 9 / 27 | 18 / 57 | 5,8 / 20,5 | 3,2 / 7,9 | 0,4 / 1,6 | 91 / 95 | 0 / 0 | 22 / 38 | 0 / 15 | 0 / 72 |
| Contenedor 2 CPU | 1.000 | 1 | 10 / 19 | 25 / 44 | 6,6 / 11,9 | 3,6 / 7,3 | 0,1 / 1,7 | 90 / 93 | 0 / 0 | 33 / 43 | 1 / 29 | 0 / 98 |
| Contenedor 2 CPU | 2.000 | 1 | 20 / 43 | 52 / 94 | 12,6 / 27,6 | 7,7 / 15,9 | 0,2 / 1,7 | 80 / 86 | 0 / 0 | 75 / 103 | 2 / 44 | 16 / 361 |
| Contenedor 2 CPU | 3.000 | 1 | 10 / 39 | 32 / 100 | 6,6 / 26,7 | 2,9 / 14,6 | 0,1 / 1,6 | 90 / 98 | 0 / 0 | 95 / 103 | 8 / 60 | 167 / 2.140 |
| Contenedor 2 CPU | Server killer | 1 | 5 / 18 | 18 / 93 | 3,2 / 11,8 | 1,5 / 7,4 | 0,2 / 1,3 | 95 / 98 | 0 / 0 | – | – | – |
| Contenedor 2 CPU | Server killer | 2 | 3 / 11 | 7 / 30 | 2,1 / 9,6 | 0,9 / 4,4 | 0,2 / 1,4 | 97 / 99 | 0 / 0 | – | – | – |
| Contenedor 2 CPU | Server killer | 3 | 17 / 34 | 52 / 91 | 13,1 / 24 | 3,8 / 9,6 | 0,6 / 4,3 | 82 / 95 | 0 / 0 | 71 / 103 | 0 / 3 | 188 / 1.837 |
| AWS Unlimited | Baja | 1 | 7 / 20 | 9 / 28 | 4,4 / 16 | 2,1 / 4,5 | 0,3 / 2 | 93 / 97 | 0,2 / 1,5 | 10 / 19 | 0 / 24 | – |
| AWS Unlimited | Baja | 2 | 5 / 14 | 8 / 18 | 3,5 / 11,1 | 1,7 / 4 | 0,2 / 2 | 94 / 99 | 0,1 / 0,5 | 8 / 17 | 0 / 13 | – |
| AWS Unlimited | Baja | 3 | 6 / 22 | 8 / 30 | 4,2 / 19,3 | 1,7 / 4,5 | 0,3 / 3,5 | 94 / 98 | 0,1 / 1,5 | 9 / 20 | 0 / 25 | – |
| AWS Unlimited | Media | 1 | 15 / 33 | 20 / 44 | 9,8 / 26,5 | 5 / 12 | 0,6 / 2,5 | 84 / 93 | 0,5 / 4,5 | 23 / 42 | 1 / 30 | – |
| AWS Unlimited | Media | 2 | 14 / 36 | 18 / 44 | 9,2 / 31 | 4,8 / 18,9 | 0,6 / 3,1 | 85 / 93 | 0,1 / 2,1 | 21 / 34 | 1 / 29 | – |
| AWS Unlimited | Media | 3 | 14 / 32 | 19 / 36 | 9,1 / 25,6 | 5,1 / 8,7 | 0,5 / 2 | 85 / 92 | 0,2 / 1,5 | 23 / 36 | 0 / 26 | – |
| AWS Unlimited | Alta | 1 | 30 / 63 | 37 / 78 | 19,8 / 49 | 9,8 / 14,2 | 1 / 5 | 69 / 80 | 0,4 / 7,3 | 45 / 71 | 1 / 64 | – |
| AWS Unlimited | Alta | 2 | 26 / 52 | 33 / 60 | 17,1 / 43,1 | 9,1 / 13,6 | 0,9 / 3,1 | 73 / 83 | 0,3 / 2,5 | 40 / 57 | 1 / 54 | – |
| AWS Unlimited | Alta | 3 | 38 / 96 | 45 / 99 | 25,5 / 75,4 | 12,2 / 48,7 | 2,5 / 29,6 | 60 / 81 | 0,3 / 4,5 | 46 / 68 | 1 / 55 | – |
| AWS Unlimited | 1.000 | 1 | 48 / 80 | 62 / 93 | 31,1 / 58,5 | 17 / 22 | 1,1 / 3,1 | 51 / 65 | 0,3 / 2,6 | 74 / 102 | 2 / 63 | – |
| AWS Unlimited | 2.000 | 1 | 69 / 93 | 88 / 100 | 44,8 / 70,4 | 23,6 / 28,3 | 1,1 / 3 | 30 / 38 | 0,3 / 4,1 | 97 / 143 | 5 / 79 | – |
| AWS Unlimited | 3.000 | 1 | 73 / 100 | 90 / 100 | 50,2 / 88 | 22,1 / 38,7 | 1,3 / 14,1 | 26 / 38 | 0,3 / 5,4 | 96 / 196 | 10 / 148 | – |
| AWS Unlimited | Server killer | 1 | 75 / 99 | 89 / 100 | 54,4 / 87,1 | 20,4 / 37,5 | 2,7 / 61,3 | 22 / 37 | 0,1 / 1 | 92 / 129 | 18 / 154 | – |
| AWS Unlimited | Server killer | 2 | 78 / 100 | 87 / 100 | 56,4 / 81,8 | 21,1 / 36,6 | 7,4 / 77,1 | 15 / 35 | 0,1 / 1,6 | 86 / 129 | 28 / 155 | – |
| AWS Unlimited | Server killer | 3 | 78 / 100 | 90 / 100 | 57,1 / 87,3 | 20,5 / 69,9 | 2,1 / 81 | 20 / 36 | 0,1 / 2,2 | 91 / 145 | 22 / 111 | – |
| AWS Limited | Baja | 1 | 7 / 21 | 10 / 33 | 5,1 / 19,2 | 1,9 / 4,5 | 0,3 / 2,1 | 93 / 98 | 0,2 / 2 | 10 / 22 | 0 / 24 | – |
| AWS Limited | Baja | 2 | 6 / 23 | 8 / 31 | 3,9 / 21,3 | 1,5 / 3 | 0,3 / 2,5 | 94 / 98 | 0,1 / 2,5 | 8 / 16 | 1 / 24 | – |
| AWS Limited | Baja | 3 | 7 / 20 | 9 / 29 | 4,5 / 16,8 | 1,9 / 4,5 | 0,3 / 2 | 93 / 98 | 0,1 / 1,5 | 9 / 17 | 1 / 25 | – |
| AWS Limited | Media | 1 | 16 / 40 | 21 / 52 | 10,4 / 32,5 | 5,4 / 10,2 | 0,6 / 11,7 | 84 / 91 | 0,2 / 2,5 | 24 / 38 | 1 / 27 | – |
| AWS Limited | Media | 2 | 15 / 54 | 20 / 57 | 10 / 25 | 5,3 / 32,3 | 0,7 / 2,6 | 84 / 91 | 0,2 / 3 | 23 / 33 | 1 / 27 | – |
| AWS Limited | Media | 3 | 15 / 33 | 20 / 48 | 10 / 23,7 | 5,1 / 23,9 | 0,6 / 16,7 | 84 / 92 | 0,3 / 5 | 24 / 39 | 0 / 27 | – |
| AWS Limited | Alta | 1 | 27 / 50 | 34 / 62 | 17,8 / 41,2 | 9,4 / 13,3 | 1 / 3 | 72 / 81 | 0,2 / 4 | 42 / 60 | 1 / 39 | – |
| AWS Limited | Alta | 2 | 28 / 52 | 35 / 61 | 17,4 / 37,8 | 9,8 / 15,1 | 0,8 / 2,6 | 72 / 82 | 0,4 / 3,6 | 43 / 60 | 1 / 31 | – |
| AWS Limited | Alta | 3 | 26 / 54 | 33 / 59 | 16,8 / 41,1 | 9,3 / 12,8 | 0,8 / 2,6 | 73 / 82 | 0,3 / 7,4 | 41 / 55 | 1 / 48 | – |
| AWS Limited | 1.000 | 1 | 75 / 100 | 88 / 100 | 10,9 / 100 | 4,8 / 13,3 | 1,3 / 14,1 | 23 / 59 | 59,5 / 84,6 | 90 / 244 | 12 / 201 | – |
| AWS Limited | 2.000 | 1 | 84 / 100 | 93 / 100 | 12,8 / 100 | 4,5 / 13,3 | 1,2 / 10,6 | 15 / 36 | 66,5 / 86,7 | 86 / 175 | 31 / 255 | – |
| AWS Limited | 3.000 | 1 | 90 / 100 | 96 / 100 | 15,2 / 100 | 3,7 / 100 | 0,8 / 9,7 | 9 / 35 | 71 / 92,9 | 79 / 266 | 65 / 511 | – |
| AWS Limited | Server killer | 1 | 78 / 100 | 92 / 100 | 17 / 84,1 | 6,2 / 100 | 1 / 14,5 | 21 / 37 | 54,4 / 82,1 | 89 / 166 | 7 / 211 | – |
| AWS Limited | Server killer | 2 | 77 / 100 | 90 / 100 | 11,3 / 20,6 | 4,4 / 8 | 0,8 / 11,9 | 22 / 37 | 61,5 / 81,6 | 90 / 189 | 6 / 215 | – |
| AWS Limited | Server killer | 3 | 81 / 100 | 92 / 100 | 12,5 / 19,6 | 4,1 / 10,6 | 1 / 10,7 | 18 / 36 | 64,5 / 92,9 | 86 / 210 | 10 / 188 | – |

### Memoria residente (promedio / pico, MB)

| Entorno | Prueba | Rep. | RES servidor | RES mongod |
|---|---|---|---|---|
| PC nativo | Baja | 1 | 198 / 232 | 730 / 742 |
| PC nativo | Baja | 2 | 181 / 224 | 876 / 876 |
| PC nativo | Baja | 3 | 152 / 160 | 901 / 906 |
| PC nativo | Media | 1 | 231 / 245 | 765 / 767 |
| PC nativo | Media | 2 | 228 / 262 | 982 / 988 |
| PC nativo | Media | 3 | 219 / 246 | 928 / 938 |
| PC nativo | Alta | 1 | 282 / 299 | 879 / 890 |
| PC nativo | Alta | 2 | 247 / 274 | 989 / 990 |
| PC nativo | Alta | 3 | 248 / 283 | 999 / 1.000 |
| PC nativo | 1.000 | 1 | 302 / 319 | 1.007 / 1.009 |
| PC nativo | 2.000 | 1 | 372 / 405 | 1.077 / 1.092 |
| PC nativo | 3.000 | 1 | 506 / 529 | 1.165 / 1.180 |
| PC nativo | Server killer | 1 | 742 / 816 | 1.069 / 1.085 |
| PC nativo | Server killer | 2 | 693 / 782 | 1.093 / 1.116 |
| PC nativo | Server killer | 3 | 789 / 851 | 1.159 / 1.179 |
| Contenedor 1 CPU | Baja | 1 | 128 / 146 | 410 / 410 |
| Contenedor 1 CPU | Baja | 2 | 149 / 199 | 409 / 410 |
| Contenedor 1 CPU | Baja | 3 | 151 / 181 | 410 / 411 |
| Contenedor 1 CPU | Media | 1 | 193 / 220 | 445 / 464 |
| Contenedor 1 CPU | Media | 2 | 210 / 220 | 422 / 422 |
| Contenedor 1 CPU | Media | 3 | 192 / 224 | 419 / 419 |
| Contenedor 1 CPU | Alta | 1 | 246 / 263 | 476 / 477 |
| Contenedor 1 CPU | Alta | 2 | 240 / 255 | 455 / 463 |
| Contenedor 1 CPU | Alta | 3 | 244 / 271 | 511 / 511 |
| Contenedor 1 CPU | 1.000 | 1 | 277 / 298 | 446 / 451 |
| Contenedor 1 CPU | 2.000 | 1 | 381 / 398 | 513 / 514 |
| Contenedor 1 CPU | 3.000 | 1 | 421 / 448 | 537 / 538 |
| Contenedor 1 CPU | Server killer | 1 | – | 525 / 526 |
| Contenedor 1 CPU | Server killer | 2 | – | 538 / 538 |
| Contenedor 1 CPU | Server killer | 3 | – | 531 / 531 |
| Contenedor 2 CPU | Baja | 1 | 141 / 147 | 439 / 440 |
| Contenedor 2 CPU | Baja | 2 | 156 / 176 | 455 / 455 |
| Contenedor 2 CPU | Baja | 3 | 181 / 206 | 433 / 434 |
| Contenedor 2 CPU | Media | 1 | 217 / 234 | 442 / 462 |
| Contenedor 2 CPU | Media | 2 | 203 / 216 | 454 / 455 |
| Contenedor 2 CPU | Media | 3 | 188 / 208 | 459 / 460 |
| Contenedor 2 CPU | Alta | 1 | 232 / 243 | 479 / 480 |
| Contenedor 2 CPU | Alta | 2 | 223 / 249 | 460 / 461 |
| Contenedor 2 CPU | Alta | 3 | 244 / 274 | 478 / 498 |
| Contenedor 2 CPU | 1.000 | 1 | 306 / 329 | 515 / 516 |
| Contenedor 2 CPU | 2.000 | 1 | 383 / 408 | 533 / 534 |
| Contenedor 2 CPU | 3.000 | 1 | 430 / 460 | 556 / 559 |
| Contenedor 2 CPU | Server killer | 1 | – | 503 / 503 |
| Contenedor 2 CPU | Server killer | 2 | – | 539 / 539 |
| Contenedor 2 CPU | Server killer | 3 | 303 / 390 | 514 / 531 |
| AWS Unlimited | Baja | 1 | 146 / 182 | 531 / 538 |
| AWS Unlimited | Baja | 2 | 136 / 148 | 711 / 711 |
| AWS Unlimited | Baja | 3 | 169 / 204 | 722 / 723 |
| AWS Unlimited | Media | 1 | 220 / 241 | 527 / 537 |
| AWS Unlimited | Media | 2 | 200 / 220 | 711 / 711 |
| AWS Unlimited | Media | 3 | 168 / 208 | 723 / 725 |
| AWS Unlimited | Alta | 1 | 275 / 288 | 593 / 595 |
| AWS Unlimited | Alta | 2 | 232 / 252 | 710 / 711 |
| AWS Unlimited | Alta | 3 | 227 / 257 | 719 / 725 |
| AWS Unlimited | 1.000 | 1 | 312 / 337 | 613 / 617 |
| AWS Unlimited | 2.000 | 1 | 456 / 506 | 633 / 634 |
| AWS Unlimited | 3.000 | 1 | 498 / 550 | 636 / 653 |
| AWS Unlimited | Server killer | 1 | 648 / 686 | 674 / 678 |
| AWS Unlimited | Server killer | 2 | 660 / 690 | 703 / 709 |
| AWS Unlimited | Server killer | 3 | 697 / 749 | 621 / 706 |
| AWS Limited | Baja | 1 | 199 / 221 | 692 / 693 |
| AWS Limited | Baja | 2 | 190 / 214 | 688 / 689 |
| AWS Limited | Baja | 3 | 193 / 212 | 688 / 690 |
| AWS Limited | Media | 1 | 223 / 252 | 693 / 694 |
| AWS Limited | Media | 2 | 215 / 234 | 688 / 690 |
| AWS Limited | Media | 3 | 216 / 238 | 692 / 694 |
| AWS Limited | Alta | 1 | 262 / 288 | 695 / 696 |
| AWS Limited | Alta | 2 | 226 / 256 | 688 / 690 |
| AWS Limited | Alta | 3 | 229 / 265 | 691 / 693 |
| AWS Limited | 1.000 | 1 | 299 / 346 | 717 / 718 |
| AWS Limited | 2.000 | 1 | 391 / 427 | 717 / 718 |
| AWS Limited | 3.000 | 1 | 397 / 446 | 717 / 719 |
| AWS Limited | Server killer | 1 | 642 / 662 | 683 / 688 |
| AWS Limited | Server killer | 2 | 549 / 592 | 683 / 683 |
| AWS Limited | Server killer | 3 | 569 / 620 | 690 / 694 |

### Disco y red (promedio / pico)

| Entorno | Prueba | Rep. | IOPS | MB/s | %util | Red entrada MB/s | Red salida MB/s |
|---|---|---|---|---|---|---|---|
| PC nativo | Baja | 1 | 40 / 1.443 | 1,4 / 95,2 | 1,5 / 24,8 | 1,1 / 6,1 | 1,1 / 6,1 |
| PC nativo | Baja | 2 | 19 / 250 | 0,3 / 3,3 | 1,1 / 22,8 | 1,3 / 3,6 | 1,3 / 3,6 |
| PC nativo | Baja | 3 | 17 / 130 | 0,3 / 10 | 1,1 / 23,6 | 1,6 / 3,5 | 1,6 / 3,5 |
| PC nativo | Media | 1 | 37 / 413 | 1 / 22,5 | 2 / 25,2 | 3,6 / 8 | 3,6 / 8 |
| PC nativo | Media | 2 | 37 / 1.123 | 1,5 / 108,7 | 1,9 / 25,6 | 3,9 / 15,7 | 3,9 / 15,7 |
| PC nativo | Media | 3 | 23 / 172 | 0,6 / 8,7 | 1,8 / 25,2 | 3,3 / 8,1 | 3,3 / 8,1 |
| PC nativo | Alta | 1 | 57 / 3.023 | 2,1 / 133,1 | 2,9 / 56 | 8,5 / 15,5 | 8,5 / 15,5 |
| PC nativo | Alta | 2 | 50 / 929 | 1,6 / 81,6 | 2,6 / 23,2 | 7,8 / 15,4 | 7,8 / 15,4 |
| PC nativo | Alta | 3 | 30 / 299 | 1,1 / 26 | 2,2 / 26,4 | 7,2 / 13,6 | 7,2 / 13,6 |
| PC nativo | 1.000 | 1 | 48 / 370 | 2 / 23,7 | 2,5 / 25,2 | 12,6 / 21,8 | 12,6 / 21,8 |
| PC nativo | 2.000 | 1 | 64 / 564 | 3,5 / 42,4 | 3,1 / 25,6 | 24,5 / 35,1 | 24,5 / 35,1 |
| PC nativo | 3.000 | 1 | 88 / 775 | 5,8 / 60,6 | 3,3 / 24,4 | 36,1 / 50,9 | 36,1 / 50,9 |
| PC nativo | Server killer | 1 | 151 / 1.798 | 9,3 / 102,6 | 4,5 / 30 | 42,8 / 67,4 | 42,8 / 67,4 |
| PC nativo | Server killer | 2 | 120 / 1.150 | 8,2 / 96 | 4,1 / 28 | 43,7 / 62,1 | 43,7 / 62,1 |
| PC nativo | Server killer | 3 | 127 / 1.283 | 9,7 / 104,7 | 4,3 / 28,4 | 52,4 / 72,3 | 52,4 / 72,3 |
| Contenedor 1 CPU | Baja | 1 | 24 / 596 | 0,5 / 47 | 1,1 / 24,8 | 1,3 / 3,6 | 1,3 / 3,6 |
| Contenedor 1 CPU | Baja | 2 | 26 / 976 | 0,9 / 59,3 | 1,1 / 22,8 | 0,8 / 3,4 | 0,8 / 3,2 |
| Contenedor 1 CPU | Baja | 3 | 16 / 147 | 0,3 / 2,9 | 1,1 / 25,2 | 1,1 / 3,6 | 1,1 / 3,3 |
| Contenedor 1 CPU | Media | 1 | 45 / 1.034 | 1,2 / 18,8 | 1,9 / 23,6 | 3,2 / 7,5 | 3,1 / 5,9 |
| Contenedor 1 CPU | Media | 2 | 132 / 16.115 | 3,7 / 199 | 2,9 / 50,4 | 2,6 / 6,6 | 2,6 / 5,7 |
| Contenedor 1 CPU | Media | 3 | 27 / 198 | 0,8 / 8,3 | 1,8 / 25,2 | 2,9 / 6 | 2,9 / 6 |
| Contenedor 1 CPU | Alta | 1 | 63 / 926 | 2,2 / 32,3 | 2,5 / 25,2 | 6,2 / 11,9 | 6,1 / 10,3 |
| Contenedor 1 CPU | Alta | 2 | 44 / 279 | 1,5 / 19,8 | 2,5 / 25,2 | 5,8 / 10,4 | 5,8 / 10,4 |
| Contenedor 1 CPU | Alta | 3 | 38 / 368 | 1,4 / 20,1 | 2,4 / 24,8 | 6,2 / 14,9 | 6,1 / 12,3 |
| Contenedor 1 CPU | 1.000 | 1 | 51 / 292 | 2,3 / 23,3 | 2,5 / 25,2 | 9,6 / 15,1 | 9,6 / 15,1 |
| Contenedor 1 CPU | 2.000 | 1 | 75 / 534 | 4,2 / 40,2 | 2,7 / 24,8 | 18,3 / 26,3 | 18,3 / 26,3 |
| Contenedor 1 CPU | 3.000 | 1 | 79 / 701 | 5,3 / 57,4 | 2,7 / 26 | 22,5 / 32,8 | 22,5 / 32,8 |
| Contenedor 1 CPU | Server killer | 1 | 14 / 174 | 0,2 / 3 | 0,5 / 21,2 | 0,1 / 8,3 | 0,1 / 0,1 |
| Contenedor 1 CPU | Server killer | 2 | 35 / 7.010 | 0,4 / 56,4 | 0,7 / 48 | 0,1 / 11,6 | 0,1 / 0,1 |
| Contenedor 1 CPU | Server killer | 3 | 9 / 94 | 0,1 / 0,9 | 0,6 / 23,2 | 0,1 / 0,1 | 0,1 / 0,1 |
| Contenedor 2 CPU | Baja | 1 | 31 / 1.476 | 0,9 / 159,7 | 1 / 24,8 | 0,6 / 2,9 | 0,6 / 2,9 |
| Contenedor 2 CPU | Baja | 2 | 30 / 777 | 0,5 / 20,2 | 1,2 / 22,4 | 1,1 / 3,7 | 1,1 / 3,7 |
| Contenedor 2 CPU | Baja | 3 | 22 / 1.437 | 0,5 / 55,5 | 1,2 / 23,2 | 1 / 3,9 | 0,9 / 3,1 |
| Contenedor 2 CPU | Media | 1 | 37 / 333 | 1,1 / 17,1 | 2,2 / 25,6 | 2,7 / 7,8 | 2,6 / 5,6 |
| Contenedor 2 CPU | Media | 2 | 29 / 299 | 0,8 / 9,7 | 1,7 / 24,8 | 3,2 / 7,7 | 3,1 / 7,7 |
| Contenedor 2 CPU | Media | 3 | 25 / 163 | 0,6 / 4,9 | 1,7 / 25,2 | 3,3 / 6,8 | 3,3 / 6,8 |
| Contenedor 2 CPU | Alta | 1 | 81 / 3.238 | 2,4 / 129,8 | 3 / 53,5 | 5,7 / 10,9 | 5,6 / 10,9 |
| Contenedor 2 CPU | Alta | 2 | 39 / 263 | 1,2 / 13,9 | 2,3 / 24 | 5,3 / 10,6 | 5,3 / 10,6 |
| Contenedor 2 CPU | Alta | 3 | 43 / 336 | 1,5 / 18,9 | 2,3 / 25,2 | 5,8 / 11,6 | 5,7 / 11,2 |
| Contenedor 2 CPU | 1.000 | 1 | 57 / 350 | 2,6 / 30,9 | 2,6 / 24,8 | 9,8 / 16,9 | 9,7 / 16,9 |
| Contenedor 2 CPU | 2.000 | 1 | 81 / 589 | 4,6 / 45,5 | 3,2 / 26 | 18,6 / 27,4 | 18,6 / 27,4 |
| Contenedor 2 CPU | 3.000 | 1 | 43 / 3.799 | 2,8 / 434,3 | 1,3 / 27,6 | 6,8 / 31,4 | 6,7 / 29,6 |
| Contenedor 2 CPU | Server killer | 1 | 14 / 139 | 0,2 / 2,1 | 0,6 / 21,6 | 0,1 / 0,1 | 0,1 / 0,1 |
| Contenedor 2 CPU | Server killer | 2 | 10 / 92 | 0,1 / 9,1 | 0,5 / 24 | 0,1 / 3,3 | 0,1 / 0,1 |
| Contenedor 2 CPU | Server killer | 3 | 126 / 1.610 | 9,7 / 188,9 | 6,2 / 16 | 18,3 / 33,4 | 13,9 / 24,1 |
| AWS Unlimited | Baja | 1 | 7 / 79 | 0,2 / 3,4 | 0,6 / 3,9 | 0,3 / 2 | 0,9 / 2,5 |
| AWS Unlimited | Baja | 2 | 6 / 88 | 0,2 / 3,4 | 0,4 / 3,6 | 0,2 / 2,5 | 0,7 / 3,3 |
| AWS Unlimited | Baja | 3 | 7 / 106 | 0,3 / 5 | 0,5 / 7,5 | 0,3 / 5,2 | 0,8 / 5,2 |
| AWS Unlimited | Media | 1 | 15 / 134 | 0,7 / 10,1 | 1,3 / 6 | 0,7 / 4,9 | 2,4 / 7,3 |
| AWS Unlimited | Media | 2 | 16 / 146 | 0,9 / 15,1 | 1,3 / 5,5 | 0,9 / 7,1 | 2,5 / 7,1 |
| AWS Unlimited | Media | 3 | 11 / 107 | 0,4 / 6,5 | 1 / 4,3 | 0,6 / 2,6 | 2,5 / 7,4 |
| AWS Unlimited | Alta | 1 | 28 / 220 | 1,9 / 23,2 | 2,3 / 11,9 | 1,5 / 9,4 | 4,9 / 9,8 |
| AWS Unlimited | Alta | 2 | 24 / 216 | 1,4 / 16,8 | 2 / 6,3 | 1,2 / 5,3 | 4,6 / 9,7 |
| AWS Unlimited | Alta | 3 | 155 / 1.478 | 13,4 / 212,1 | 8,7 / 70 | 1,3 / 5,5 | 4,8 / 10,1 |
| AWS Unlimited | 1.000 | 1 | 36 / 264 | 2,6 / 29,8 | 2,9 / 8,5 | 2,2 / 8,1 | 8,9 / 14,5 |
| AWS Unlimited | 2.000 | 1 | 58 / 318 | 5,6 / 31,6 | 3,8 / 9,7 | 3,7 / 12,8 | 15,4 / 24,7 |
| AWS Unlimited | 3.000 | 1 | 84 / 1.247 | 7,6 / 132,9 | 5 / 59,7 | 4 / 15,8 | 12,7 / 27,2 |
| AWS Unlimited | Server killer | 1 | 288 / 6.301 | 14,8 / 242,7 | 10,2 / 96,7 | 5,1 / 23,8 | 11 / 23,8 |
| AWS Unlimited | Server killer | 2 | 1.014 / 10.571 | 37,4 / 437,5 | 24,5 / 221,1 | 5,8 / 19,1 | 9,2 / 19,1 |
| AWS Unlimited | Server killer | 3 | 237 / 9.905 | 14,7 / 445,2 | 8,9 / 252,6 | 5,6 / 21,7 | 10,9 / 21,7 |
| AWS Limited | Baja | 1 | 8 / 109 | 0,5 / 10,1 | 0,6 / 4,2 | 0,6 / 5,2 | 1,5 / 9,2 |
| AWS Limited | Baja | 2 | 7 / 126 | 0,3 / 4,6 | 0,6 / 5,1 | 0,3 / 3 | 0,6 / 3 |
| AWS Limited | Baja | 3 | 7 / 102 | 0,4 / 5,7 | 0,5 / 3,7 | 0,5 / 3,4 | 1 / 3,4 |
| AWS Limited | Media | 1 | 15 / 390 | 0,7 / 11,7 | 1,3 / 24,4 | 0,8 / 5,3 | 2,6 / 9,3 |
| AWS Limited | Media | 2 | 17 / 175 | 1 / 14,5 | 1,4 / 5,4 | 1 / 5 | 2,8 / 6,9 |
| AWS Limited | Media | 3 | 16 / 586 | 0,8 / 13,2 | 1,3 / 34,3 | 0,8 / 7,5 | 2,5 / 7,5 |
| AWS Limited | Alta | 1 | 26 / 217 | 1,4 / 19,5 | 2,2 / 6,8 | 1,3 / 6,3 | 4,6 / 9,5 |
| AWS Limited | Alta | 2 | 23 / 197 | 1,3 / 16,4 | 1,8 / 5,4 | 1,3 / 6,2 | 4,7 / 9,5 |
| AWS Limited | Alta | 3 | 22 / 190 | 1,2 / 17,2 | 1,9 / 5,5 | 1,2 / 6 | 4,7 / 9,5 |
| AWS Limited | 1.000 | 1 | 22 / 236 | 1,6 / 19,4 | 5,7 / 49,5 | 1,5 / 7 | 3,5 / 7,8 |
| AWS Limited | 2.000 | 1 | 28 / 290 | 2,2 / 32,4 | 6,7 / 42,7 | 2 / 7,9 | 3 / 7,9 |
| AWS Limited | 3.000 | 1 | 26 / 319 | 1,8 / 28,2 | 5,9 / 36,6 | 1,8 / 8,1 | 2,2 / 8,1 |
| AWS Limited | Server killer | 1 | 46 / 594 | 3,6 / 24,2 | 6,4 / 69,1 | 3,3 / 19,7 | 4,6 / 19,7 |
| AWS Limited | Server killer | 2 | 27 / 522 | 2,3 / 33,3 | 5,5 / 56,2 | 2,7 / 9 | 3,3 / 9 |
| AWS Limited | Server killer | 3 | 35 / 249 | 3,1 / 23 | 7,1 / 42,8 | 3,1 / 9,3 | 3,6 / 9,3 |

### Latencia vista por el usuario: p50 / p95 / p99 (ms)

| Entorno | Prueba | Rep. | REST | Login | Registro | Trazo a los demás | Ping WebSocket |
|---|---|---|---|---|---|---|---|
| PC nativo | Baja | 1 | 3,4 / 32 / 36 | 136 / 153 / 153 | – | 0,4 / 0,6 / 0,7 | 0,2 / 0,3 / 0,5 |
| PC nativo | Baja | 2 | 3,3 / 31 / 33 | 136 / 147 / 147 | – | 0,4 / 0,6 / 0,8 | 0,2 / 0,4 / 0,5 |
| PC nativo | Baja | 3 | 3,4 / 8,1 / 31 | 136 / 136 / 136 | – | 0,4 / 0,6 / 0,7 | 0,2 / 0,3 / 0,4 |
| PC nativo | Media | 1 | 3,2 / 6,1 / 33 | 136 / 147 / 147 | 131 / 142 / 142 | 0,3 / 0,6 / 0,9 | 0,1 / 0,3 / 0,6 |
| PC nativo | Media | 2 | 3,4 / 20 / 32 | 136 / 142 / 142 | 147 / 147 / 147 | 0,3 / 0,7 / 1,2 | 0,1 / 0,3 / 0,6 |
| PC nativo | Media | 3 | 3,2 / 28 / 31 | 126 / 136 / 136 | 131 / 131 / 131 | 0,3 / 0,5 / 0,8 | 0,1 / 0,3 / 0,5 |
| PC nativo | Alta | 1 | 3,2 / 30 / 32 | 142 / 172 / 172 | 136 / 136 / 136 | 0,3 / 0,8 / 1,3 | 0,1 / 0,5 / 1,1 |
| PC nativo | Alta | 2 | 3,2 / 30 / 32 | 136 / 153 / 159 | 136 / 136 / 136 | 0,3 / 0,8 / 1,3 | 0,1 / 0,4 / 0,9 |
| PC nativo | Alta | 3 | 3,3 / 28 / 31 | 131 / 131 / 136 | 126 / 126 / 126 | 0,3 / 0,7 / 1,1 | 0,1 / 0,4 / 0,8 |
| PC nativo | 1.000 | 1 | 3 / 31 / 32 | 136 / 147 / 159 | 147 / 147 / 147 | 0,4 / 1,1 / 2,1 | 0,1 / 0,7 / 2,1 |
| PC nativo | 2.000 | 1 | 3,7 / 28 / 32 | 142 / 159 / 194 | 142 / 153 / 153 | 0,7 / 2,4 / 6,1 | 0,3 / 1,8 / 5,9 |
| PC nativo | 3.000 | 1 | 5,5 / 40 / 100 | 159 / 227 / 265 | 172 / 227 / 227 | 1,7 / 13 / 36 | 1 / 14 / 47 |
| PC nativo | Server killer | 1 | 827 / 15.071 / 15.071 | 363 / 15.071 / 15.071 | 393 / 13.934 / 13.934 | 31 / 349 / 707 | 55 / 605 / 1.007 |
| PC nativo | Server killer | 2 | 363 / 15.071 / 15.071 | 408 / 15.071 / 15.071 | 459 / 15.071 / 15.071 | 39 / 349 / 895 | 73 / 765 / 1.325 |
| PC nativo | Server killer | 3 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 10.181 / 15.071 / 15.071 | 39 / 210 / 425 | 73 / 393 / 629 |
| Contenedor 1 CPU | Baja | 1 | 3,6 / 32 / 44 | 136 / 136 / 136 | – | 0,5 / 0,7 / 0,9 | 0,3 / 0,5 / 0,6 |
| Contenedor 1 CPU | Baja | 2 | 3,6 / 30 / 39 | 136 / 166 / 166 | – | 0,5 / 0,8 / 1,1 | 0,3 / 0,5 / 0,6 |
| Contenedor 1 CPU | Baja | 3 | 3,6 / 5,5 / 32 | 142 / 142 / 142 | – | 0,5 / 0,7 / 1 | 0,3 / 0,5 / 0,7 |
| Contenedor 1 CPU | Media | 1 | 3,4 / 31 / 36 | 142 / 186 / 276 | 147 / 202 / 202 | 0,4 / 0,8 / 1,4 | 0,2 / 0,4 / 0,8 |
| Contenedor 1 CPU | Media | 2 | 3,4 / 31 / 37 | 147 / 194 / 194 | 136 / 136 / 136 | 0,4 / 0,8 / 1,4 | 0,2 / 0,4 / 0,7 |
| Contenedor 1 CPU | Media | 3 | 3,4 / 30 / 32 | 142 / 153 / 153 | 136 / 147 / 147 | 0,3 / 0,7 / 1,1 | 0,2 / 0,3 / 0,6 |
| Contenedor 1 CPU | Alta | 1 | 3,6 / 28 / 35 | 159 / 202 / 218 | 153 / 276 / 276 | 0,4 / 1,1 / 2,3 | 0,2 / 0,6 / 1,9 |
| Contenedor 1 CPU | Alta | 2 | 3,6 / 31 / 37 | 147 / 210 / 323 | 136 / 159 / 159 | 0,5 / 1,2 / 2,2 | 0,2 / 0,7 / 1,6 |
| Contenedor 1 CPU | Alta | 3 | 3,4 / 31 / 35 | 147 / 265 / 310 | 142 / 153 / 153 | 0,4 / 0,9 / 7,8 | 0,2 / 0,6 / 5,1 |
| Contenedor 1 CPU | 1.000 | 1 | 3,6 / 13 / 45 | 166 / 255 / 310 | 166 / 287 / 287 | 0,5 / 1,6 / 24 | 0,2 / 1,1 / 22 |
| Contenedor 1 CPU | 2.000 | 1 | 6,4 / 218 / 378 | 378 / 654 / 827 | 425 / 629 / 629 | 1,5 / 70 / 179 | 0,9 / 116 / 227 |
| Contenedor 1 CPU | 3.000 | 1 | 15.071 / 15.071 / 15.071 | 15.071 / 15.071 / 15.071 | 15.071 / 15.071 / 15.071 | 112 / 629 / 968 | 265 / 931 / 1.225 |
| Contenedor 1 CPU | Server killer | 1 | servidor caído | – | – | – | – |
| Contenedor 1 CPU | Server killer | 2 | servidor caído | – | – | – | – |
| Contenedor 1 CPU | Server killer | 3 | servidor caído | – | – | – | – |
| Contenedor 2 CPU | Baja | 1 | 3,6 / 7,5 / 11 | 142 / 142 / 142 | – | 0,6 / 1,1 / 1,8 | 0,3 / 0,6 / 0,8 |
| Contenedor 2 CPU | Baja | 2 | 3,6 / 9,8 / 44 | 136 / 172 / 172 | – | 0,4 / 0,7 / 1 | 0,2 / 0,5 / 0,6 |
| Contenedor 2 CPU | Baja | 3 | 3,4 / 11 / 32 | 136 / 142 / 142 | 136 / 142 / 142 | 0,4 / 0,7 / 0,8 | 0,3 / 0,5 / 0,6 |
| Contenedor 2 CPU | Media | 1 | 3,4 / 30 / 32 | 136 / 153 / 159 | 136 / 142 / 142 | 0,4 / 0,7 / 1,1 | 0,2 / 0,3 / 0,7 |
| Contenedor 2 CPU | Media | 2 | 3,4 / 30 / 33 | 136 / 186 / 186 | – | 0,4 / 0,8 / 1,2 | 0,2 / 0,4 / 0,7 |
| Contenedor 2 CPU | Media | 3 | 3,6 / 31 / 32 | 142 / 147 / 147 | 142 / 142 / 142 | 0,4 / 0,9 / 1,3 | 0,2 / 0,4 / 0,8 |
| Contenedor 2 CPU | Alta | 1 | 3,6 / 30 / 35 | 142 / 159 / 186 | 153 / 186 / 186 | 0,4 / 1,1 / 2,1 | 0,2 / 0,6 / 1,3 |
| Contenedor 2 CPU | Alta | 2 | 3,4 / 30 / 33 | 136 / 147 / 153 | 142 / 147 / 147 | 0,4 / 1 / 2,2 | 0,2 / 0,5 / 1,1 |
| Contenedor 2 CPU | Alta | 3 | 3,6 / 31 / 33 | 142 / 172 / 172 | 142 / 147 / 147 | 0,4 / 0,9 / 1,5 | 0,2 / 0,6 / 1,2 |
| Contenedor 2 CPU | 1.000 | 1 | 3,8 / 30 / 33 | 147 / 172 / 210 | 147 / 159 / 159 | 0,5 / 1,3 / 2,7 | 0,2 / 0,9 / 2,6 |
| Contenedor 2 CPU | 2.000 | 1 | 6,9 / 53 / 131 | 202 / 310 / 408 | 218 / 349 / 349 | 1,6 / 16 / 53 | 0,9 / 19 / 65 |
| Contenedor 2 CPU | 3.000 | 1 | servidor caído | – | – | – | – |
| Contenedor 2 CPU | Server killer | 1 | servidor caído | – | – | – | – |
| Contenedor 2 CPU | Server killer | 2 | servidor caído | – | – | – | – |
| Contenedor 2 CPU | Server killer | 3 | servidor caído | – | – | – | – |
| AWS Unlimited | Baja | 1 | 5,7 / 53 / 55 | 255 / 255 / 255 | – | 1,1 / 2,1 / 2,8 | 0,6 / 0,9 / 1,4 |
| AWS Unlimited | Baja | 2 | 5,9 / 51 / 70 | 255 / 255 / 255 | – | 1,1 / 2,1 / 2,7 | 0,5 / 0,8 / 1,3 |
| AWS Unlimited | Baja | 3 | 6,1 / 51 / 57 | 245 / 245 / 245 | 245 / 245 / 245 | 1,1 / 1,9 / 2,4 | 0,5 / 0,8 / 1,4 |
| AWS Unlimited | Media | 1 | 5,7 / 51 / 57 | 265 / 298 / 298 | 265 / 265 / 265 | 1,2 / 3,2 / 4,7 | 0,5 / 1,4 / 4,3 |
| AWS Unlimited | Media | 2 | 5,7 / 49 / 57 | 255 / 298 / 298 | 265 / 298 / 298 | 1,1 / 2,5 / 4,9 | 0,5 / 1,1 / 3,6 |
| AWS Unlimited | Media | 3 | 5,9 / 14 / 53 | 276 / 287 / 287 | – | 1,2 / 2,8 / 4 | 0,5 / 1,4 / 2,5 |
| AWS Unlimited | Alta | 1 | 6,4 / 51 / 57 | 298 / 363 / 408 | 287 / 298 / 298 | 1,4 / 4,9 / 16 | 0,5 / 3,6 / 12 |
| AWS Unlimited | Alta | 2 | 7,2 / 51 / 53 | 298 / 349 / 363 | 298 / 310 / 310 | 1,4 / 3,7 / 6,1 | 0,5 / 2,6 / 6,1 |
| AWS Unlimited | Alta | 3 | 7,2 / 53 / 79 | 298 / 605 / 680 | 323 / 336 / 336 | 1,6 / 5,7 / 28 | 0,5 / 4,5 / 23 |
| AWS Unlimited | 1.000 | 1 | 11 / 55 / 112 | 408 / 497 / 497 | 363 / 363 / 363 | 2,5 / 13 / 39 | 1,4 / 15 / 53 |
| AWS Unlimited | 2.000 | 1 | 654 / 15.071 / 15.071 | 1.047 / 11.453 / 15.071 | 968 / 7.439 / 7.439 | 96 / 459 / 765 | 202 / 735 / 1.047 |
| AWS Unlimited | 3.000 | 1 | 7.439 / 15.071 / 15.071 | 895 / 15.071 / 15.071 | 931 / 5.879 / 5.879 | 49 / 378 / 895 | 92 / 680 / 1.433 |
| AWS Unlimited | Server killer | 1 | servidor caído | – | – | – | – |
| AWS Unlimited | Server killer | 2 | servidor caído | – | – | – | – |
| AWS Unlimited | Server killer | 3 | servidor caído | – | – | – | – |
| AWS Limited | Baja | 1 | 6,1 / 53 / 70 | 245 / 245 / 245 | 255 / 255 / 255 | 1 / 1,9 / 2,9 | 0,6 / 0,9 / 2,1 |
| AWS Limited | Baja | 2 | 5,7 / 49 / 57 | 236 / 276 / 276 | 236 / 245 / 245 | 1 / 1,6 / 2,1 | 0,5 / 0,8 / 1,3 |
| AWS Limited | Baja | 3 | 5,9 / 51 / 57 | 236 / 255 / 255 | – | 1,1 / 2,1 / 2,7 | 0,6 / 0,9 / 1,7 |
| AWS Limited | Media | 1 | 5,9 / 23 / 55 | 265 / 287 / 287 | – | 1,2 / 3 / 4,7 | 0,5 / 1,5 / 3 |
| AWS Limited | Media | 2 | 5,7 / 51 / 55 | 265 / 287 / 287 | 255 / 255 / 255 | 1,1 / 2,8 / 5,1 | 0,5 / 1,4 / 3,4 |
| AWS Limited | Media | 3 | 5,9 / 49 / 53 | 276 / 287 / 287 | 265 / 265 / 265 | 1,3 / 3,4 / 5,3 | 0,5 / 1,6 / 3,7 |
| AWS Limited | Alta | 1 | 6,4 / 26 / 60 | 298 / 349 / 349 | 276 / 287 / 287 | 1,3 / 4,3 / 9,8 | 0,5 / 2,8 / 7,8 |
| AWS Limited | Alta | 2 | 6,1 / 17 / 57 | 298 / 323 / 323 | 287 / 323 / 323 | 1,4 / 4,5 / 9,5 | 0,5 / 2,9 / 7,2 |
| AWS Limited | Alta | 3 | 6,7 / 49 / 55 | 298 / 323 / 323 | 323 / 336 / 336 | 1,4 / 4,2 / 8,1 | 0,5 / 2,7 / 6,7 |
| AWS Limited | 1.000 | 1 | 15.071 / 15.071 / 15.071 | 12.883 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 298 / 1.885 / 2.902 | 517 / 2.791 / 3.672 |
| AWS Limited | 2.000 | 1 | 15.071 / 15.071 / 15.071 | 15.071 / 15.071 / 15.071 | 15.071 / 15.071 / 15.071 | 298 / 1.378 / 2.121 | 559 / 1.961 / 2.902 |
| AWS Limited | 3.000 | 1 | 15.071 / 15.071 / 15.071 | 15.071 / 15.071 / 15.071 | 15.071 / 15.071 / 15.071 | 202 / 1.132 / 2.039 | 378 / 1.612 / 2.580 |
| AWS Limited | Server killer | 1 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 1.325 / 7.153 / 11.012 | 2.902 / 11.012 / 14.491 |
| AWS Limited | Server killer | 2 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 1.178 / 5.436 / 8.368 | 2.294 / 8.703 / 10.589 |
| AWS Limited | Server killer | 3 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 10.589 / 15.071 / 15.071 | 931 / 3.672 / 5.436 | 1.813 / 5.026 / 6.115 |

### Latencia dentro del servidor (log de Fastify, sin red): p50 / p95 / p99 (ms)

| Entorno | Prueba | Rep. | REST | Login |
|---|---|---|---|---|
| PC nativo | Baja | 1 | 2,1 / 31 / 39 | 136 / 153 / 153 |
| PC nativo | Baja | 2 | 2,1 / 30 / 32 | 136 / 147 / 147 |
| PC nativo | Baja | 3 | 2,1 / 6,7 / 30 | 136 / 136 / 136 |
| PC nativo | Media | 1 | 1,9 / 4,7 / 32 | 136 / 142 / 142 |
| PC nativo | Media | 2 | 2,1 / 6,9 / 31 | 136 / 142 / 142 |
| PC nativo | Media | 3 | 2,1 / 26 / 30 | 126 / 131 / 136 |
| PC nativo | Alta | 1 | 2 / 28 / 30 | 142 / 172 / 172 |
| PC nativo | Alta | 2 | 2 / 27 / 30 | 136 / 147 / 159 |
| PC nativo | Alta | 3 | 2,1 / 27 / 30 | 126 / 131 / 136 |
| PC nativo | 1.000 | 1 | 1,8 / 28 / 31 | 136 / 147 / 159 |
| PC nativo | 2.000 | 1 | 2,3 / 27 / 30 | 136 / 159 / 186 |
| PC nativo | 3.000 | 1 | 2,9 / 31 / 44 | 159 / 218 / 245 |
| PC nativo | Server killer | 1 | 22 / 442 / 1.433 | 236 / 765 / 1.961 |
| PC nativo | Server killer | 2 | 33 / 245 / 827 | 255 / 497 / 6.878 |
| PC nativo | Server killer | 3 | 32 / 159 / 1.089 | 227 / 795 / 1.676 |
| Contenedor 1 CPU | Baja | 1 | 2,1 / 30 / 42 | 136 / 136 / 136 |
| Contenedor 1 CPU | Baja | 2 | 2,1 / 28 / 37 | 136 / 159 / 159 |
| Contenedor 1 CPU | Baja | 3 | 2,1 / 4 / 30 | 136 / 136 / 136 |
| Contenedor 1 CPU | Media | 1 | 2,1 / 28 / 35 | 142 / 186 / 276 |
| Contenedor 1 CPU | Media | 2 | 2 / 28 / 35 | 147 / 194 / 194 |
| Contenedor 1 CPU | Media | 3 | 2 / 28 / 30 | 136 / 153 / 153 |
| Contenedor 1 CPU | Alta | 1 | 2,2 / 13 / 30 | 153 / 194 / 218 |
| Contenedor 1 CPU | Alta | 2 | 2,1 / 28 / 35 | 142 / 210 / 323 |
| Contenedor 1 CPU | Alta | 3 | 2,1 / 28 / 32 | 147 / 265 / 298 |
| Contenedor 1 CPU | 1.000 | 1 | 2,1 / 5,1 / 32 | 166 / 227 / 298 |
| Contenedor 1 CPU | 2.000 | 1 | 3,4 / 53 / 142 | 363 / 537 / 707 |
| Contenedor 1 CPU | 3.000 | 1 | 35 / 707 / 2.385 | 707 / 2.205 / 3.531 |
| Contenedor 1 CPU | Server killer | 1 | servidor caído | – |
| Contenedor 1 CPU | Server killer | 2 | servidor caído | – |
| Contenedor 1 CPU | Server killer | 3 | servidor caído | – |
| Contenedor 2 CPU | Baja | 1 | 2,1 / 5,7 / 8,4 | 142 / 142 / 142 |
| Contenedor 2 CPU | Baja | 2 | 2,1 / 8,1 / 42 | 136 / 166 / 166 |
| Contenedor 2 CPU | Baja | 3 | 2,1 / 9,5 / 30 | 136 / 142 / 142 |
| Contenedor 2 CPU | Media | 1 | 2,1 / 28 / 31 | 136 / 153 / 159 |
| Contenedor 2 CPU | Media | 2 | 2,1 / 27 / 31 | 136 / 186 / 186 |
| Contenedor 2 CPU | Media | 3 | 2,1 / 30 / 31 | 136 / 147 / 147 |
| Contenedor 2 CPU | Alta | 1 | 2,1 / 28 / 33 | 142 / 159 / 186 |
| Contenedor 2 CPU | Alta | 2 | 2,1 / 28 / 31 | 136 / 147 / 153 |
| Contenedor 2 CPU | Alta | 3 | 2,2 / 28 / 31 | 142 / 172 / 172 |
| Contenedor 2 CPU | 1.000 | 1 | 2,5 / 28 / 32 | 147 / 166 / 210 |
| Contenedor 2 CPU | 2.000 | 1 | 4 / 37 / 55 | 202 / 298 / 310 |
| Contenedor 2 CPU | 3.000 | 1 | servidor caído | – |
| Contenedor 2 CPU | Server killer | 1 | servidor caído | – |
| Contenedor 2 CPU | Server killer | 2 | servidor caído | – |
| Contenedor 2 CPU | Server killer | 3 | servidor caído | – |
| AWS Unlimited | Baja | 1 | 3,6 / 51 / 53 | 255 / 255 / 255 |
| AWS Unlimited | Baja | 2 | 3,7 / 49 / 67 | 255 / 255 / 255 |
| AWS Unlimited | Baja | 3 | 4 / 49 / 55 | 236 / 245 / 245 |
| AWS Unlimited | Media | 1 | 3,8 / 49 / 57 | 255 / 298 / 298 |
| AWS Unlimited | Media | 2 | 3,7 / 47 / 53 | 255 / 298 / 298 |
| AWS Unlimited | Media | 3 | 3,8 / 12 / 49 | 276 / 287 / 287 |
| AWS Unlimited | Alta | 1 | 4 / 49 / 53 | 298 / 363 / 393 |
| AWS Unlimited | Alta | 2 | 4,7 / 47 / 51 | 287 / 349 / 349 |
| AWS Unlimited | Alta | 3 | 4,7 / 49 / 73 | 298 / 605 / 680 |
| AWS Unlimited | 1.000 | 1 | 6,9 / 49 / 65 | 408 / 478 / 497 |
| AWS Unlimited | 2.000 | 1 | 126 / 680 / 1.178 | 680 / 1.225 / 1.433 |
| AWS Unlimited | 3.000 | 1 | 37 / 497 / 1.490 | 629 / 1.274 / 2.294 |
| AWS Unlimited | Server killer | 1 | servidor caído | – |
| AWS Unlimited | Server killer | 2 | servidor caído | – |
| AWS Unlimited | Server killer | 3 | servidor caído | – |
| AWS Limited | Baja | 1 | 4 / 49 / 60 | 236 / 245 / 245 |
| AWS Limited | Baja | 2 | 3,8 / 47 / 55 | 236 / 276 / 276 |
| AWS Limited | Baja | 3 | 4 / 49 / 55 | 236 / 255 / 255 |
| AWS Limited | Media | 1 | 3,8 / 15 / 55 | 265 / 276 / 276 |
| AWS Limited | Media | 2 | 3,6 / 47 / 53 | 265 / 287 / 287 |
| AWS Limited | Media | 3 | 3,8 / 47 / 51 | 276 / 287 / 287 |
| AWS Limited | Alta | 1 | 4,2 / 16 / 55 | 298 / 336 / 349 |
| AWS Limited | Alta | 2 | 4 / 11 / 51 | 298 / 323 / 323 |
| AWS Limited | Alta | 3 | 4,5 / 47 / 53 | 298 / 310 / 310 |
| AWS Limited | 1.000 | 1 | 62 / 2.385 / 3.531 | 3.395 / 6.359 / 6.359 |
| AWS Limited | 2.000 | 1 | 0,6 / 497 / 1.047 | – |
| AWS Limited | 3.000 | 1 | 2,2 / 478 / 968 | – |
| AWS Limited | Server killer | 1 | 0,5 / 112 / 287 | 654 / 9.413 / 9.413 |
| AWS Limited | Server killer | 2 | 76 / 735 / 1.743 | – |
| AWS Limited | Server killer | 3 | 57 / 581 / 2.580 | – |

Archivos usados:

- `2026-11-04/pc/20261104-205513_pc_baja.ndjson`
- `2026-11-04/pc/20261104-234422_pc_baja.ndjson`
- `2026-11-04/pc/20261105-023350_pc_baja.ndjson`
- `2026-11-04/pc/20261104-210851_pc_media.ndjson`
- `2026-11-04/pc/20261104-235759_pc_media.ndjson`
- `2026-11-04/pc/20261105-024727_pc_media.ndjson`
- `2026-11-04/pc/20261104-212226_pc_alta.ndjson`
- `2026-11-04/pc/20261105-001134_pc_alta.ndjson`
- `2026-11-04/pc/20261105-030102_pc_alta.ndjson`
- `2026-11-04/pc/20261105-051202_pc_capacidad-1000.ndjson`
- `2026-11-04/pc/20261105-052539_pc_capacidad-2000.ndjson`
- `2026-11-04/pc/20261105-053914_pc_capacidad-3000.ndjson`
- `2026-11-04/pc/20261104-213601_pc_server-killer.ndjson`
- `2026-11-04/pc/20261105-002509_pc_server-killer.ndjson`
- `2026-11-04/pc/20261105-031437_pc_server-killer.ndjson`
- `2026-11-04/docker-1cpu/20261104-215106_docker-1cpu_baja.ndjson`
- `2026-11-04/docker-1cpu/20261105-004024_docker-1cpu_baja.ndjson`
- `2026-11-04/docker-1cpu/20261105-032956_docker-1cpu_baja.ndjson`
- `2026-11-04/docker-1cpu/20261104-220443_docker-1cpu_media.ndjson`
- `2026-11-04/docker-1cpu/20261105-005401_docker-1cpu_media.ndjson`
- `2026-11-04/docker-1cpu/20261105-034333_docker-1cpu_media.ndjson`
- `2026-11-04/docker-1cpu/20261104-221820_docker-1cpu_alta.ndjson`
- `2026-11-04/docker-1cpu/20261105-010738_docker-1cpu_alta.ndjson`
- `2026-11-04/docker-1cpu/20261105-035710_docker-1cpu_alta.ndjson`
- `2026-11-04/docker-1cpu/20261105-055417_docker-1cpu_capacidad-1000.ndjson`
- `2026-11-04/docker-1cpu/20261105-060754_docker-1cpu_capacidad-2000.ndjson`
- `2026-11-04/docker-1cpu/20261105-062131_docker-1cpu_capacidad-3000.ndjson`
- `2026-11-04/docker-1cpu/20261104-223157_docker-1cpu_server-killer.ndjson`
- `2026-11-04/docker-1cpu/20261105-012115_docker-1cpu_server-killer.ndjson`
- `2026-11-04/docker-1cpu/20261105-041047_docker-1cpu_server-killer.ndjson`
- `2026-11-04/docker-2cpu/20261104-224947_docker-2cpu_baja.ndjson`
- `2026-11-04/docker-2cpu/20261105-013915_docker-2cpu_baja.ndjson`
- `2026-11-04/docker-2cpu/20261105-042834_docker-2cpu_baja.ndjson`
- `2026-11-04/docker-2cpu/20261104-230324_docker-2cpu_media.ndjson`
- `2026-11-04/docker-2cpu/20261105-015252_docker-2cpu_media.ndjson`
- `2026-11-04/docker-2cpu/20261105-044211_docker-2cpu_media.ndjson`
- `2026-11-04/docker-2cpu/20261104-231701_docker-2cpu_alta.ndjson`
- `2026-11-04/docker-2cpu/20261105-020629_docker-2cpu_alta.ndjson`
- `2026-11-04/docker-2cpu/20261105-045549_docker-2cpu_alta.ndjson`
- `2026-11-04/docker-2cpu/20261105-063913_docker-2cpu_capacidad-1000.ndjson`
- `2026-11-04/docker-2cpu/20261105-065250_docker-2cpu_capacidad-2000.ndjson`
- `2026-11-04/docker-2cpu/20261105-070627_docker-2cpu_capacidad-3000.ndjson`
- `2026-11-04/docker-2cpu/20261104-233038_docker-2cpu_server-killer.ndjson`
- `2026-11-04/docker-2cpu/20261105-022006_docker-2cpu_server-killer.ndjson`
- `2026-11-04/docker-2cpu/20261105-050926_docker-2cpu_server-killer.ndjson`
- `2026-11-05/aws-unlimited/20261105-220013_nube-172.31.12.123_baja.ndjson`
- `2026-11-05/aws-unlimited/20261106-043605_nube-172.31.12.123_baja.ndjson`
- `2026-11-05/aws-unlimited/20261106-053240_nube-172.31.12.123_baja.ndjson`
- `2026-11-05/aws-unlimited/20261105-221350_nube-172.31.12.123_media.ndjson`
- `2026-11-05/aws-unlimited/20261106-045022_nube-172.31.12.123_media.ndjson`
- `2026-11-05/aws-unlimited/20261106-054659_nube-172.31.12.123_media.ndjson`
- `2026-11-05/aws-unlimited/20261105-222726_nube-172.31.12.123_alta.ndjson`
- `2026-11-05/aws-unlimited/20261106-050441_nube-172.31.12.123_alta.ndjson`
- `2026-11-05/aws-unlimited/20261106-060118_nube-172.31.12.123_alta.ndjson`
- `2026-11-05/aws-unlimited/20261105-224103_nube-172.31.12.123_capacidad-1000.ndjson`
- `2026-11-05/aws-unlimited/20261105-225440_nube-172.31.12.123_capacidad-2000.ndjson`
- `2026-11-05/aws-unlimited/20261105-230817_nube-172.31.12.123_capacidad-3000.ndjson`
- `2026-11-05/aws-unlimited/20261105-232156_nube-172.31.12.123_server-killer.ndjson`
- `2026-11-05/aws-unlimited/20261106-051832_nube-172.31.12.123_server-killer.ndjson`
- `2026-11-05/aws-unlimited/20261106-061508_nube-172.31.12.123_server-killer.ndjson`
- `2026-11-05/aws-limited/20261106-005713_nube-172.31.12.123_baja.ndjson`
- `2026-11-05/aws-limited/20261106-015313_nube-172.31.12.123_baja.ndjson`
- `2026-11-05/aws-limited/20261106-024920_nube-172.31.12.123_baja.ndjson`
- `2026-11-05/aws-limited/20261106-011129_nube-172.31.12.123_media.ndjson`
- `2026-11-05/aws-limited/20261106-020742_nube-172.31.12.123_media.ndjson`
- `2026-11-05/aws-limited/20261106-030340_nube-172.31.12.123_media.ndjson`
- `2026-11-05/aws-limited/20261106-012523_nube-172.31.12.123_alta.ndjson`
- `2026-11-05/aws-limited/20261106-022131_nube-172.31.12.123_alta.ndjson`
- `2026-11-05/aws-limited/20261106-031730_nube-172.31.12.123_alta.ndjson`
- `2026-11-05/aws-limited/20261106-034517_nube-172.31.12.123_capacidad-1000.ndjson`
- `2026-11-05/aws-limited/20261106-035937_nube-172.31.12.123_capacidad-2000.ndjson`
- `2026-11-05/aws-limited/20261106-041356_nube-172.31.12.123_capacidad-3000.ndjson`
- `2026-11-05/aws-limited/20261106-013918_nube-172.31.12.123_server-killer.ndjson`
- `2026-11-05/aws-limited/20261106-023523_nube-172.31.12.123_server-killer.ndjson`
- `2026-11-05/aws-limited/20261106-033122_nube-172.31.12.123_server-killer.ndjson`

---

## 5. Observaciones sobre los datos

- **Actualización automática de Ubuntu (AWS Unlimited, Alta, repetición 3):** `apt-daily-upgrade` corrió de 06:11 a 06:13 UTC, dentro de la ventana medida, con 1 min 33 s de CPU. El ping p99 de la corrida es 23 ms: 95,7 ms durante esos minutos y 8,09 ms fuera de ellos. No se repitió la corrida; la mediana de las 3 repeticiones no la usa. También cayeron dentro de corridas `apt-daily` (capacidad 3.000 de Unlimited, 15 s de CPU) y `man-db` (media, ronda 3 de Limited), sin señal visible.
- **Créditos de AWS Limited:** las corridas de 1.000, 2.000 y 3.000 empezaron justo después de un killer, sin créditos: son el peor caso. Baja, media y alta se corrieron en ese orden, acumulando créditos antes de alta.
- **`serverDownPct` en AWS:** los archivos de Limited guardan valores de 4 a 11 % y motivos «servidor caído» falsos, por una fórmula ya corregida que contaba como caída las muestras atrasadas del agente; el killer 1 de Unlimited guarda 0 % cuando el real es 48 %. Estas tablas y la página Comparar recalculan el valor; los archivos no se modificaron.
- **Errores por encima de 100 %:** un fallo dentro de la ventana puede ser de un intento iniciado antes de ella. Las tablas los limitan a 100 %.
- **CPU por proceso con la máquina saturada:** cuando el agente recibe CPU tarde, la diferencia de *jiffies* abarca más de un segundo y aparecen valores imposibles, como un hilo por encima de 100 %. En esos casos, usa el promedio y no el pico.
- **MongoDB muerto por OOM (AWS Unlimited, killer, repetición 3):** a los ~4 min el kernel mató a `mongod`, Docker lo reinició en ~2 s y el servidor cayó a los 680 s. Esa corrida no es igual a las otras dos del mismo nivel.
- **`ws:VALIDATION`:** de 0 a 111 por corrida, sin patrón por entorno. La causa no se confirmó, porque el generador solo guarda el código de error; no afecta el criterio de aprobación.
- **Red local:** en el PC y Docker todo pasa por interfaces locales, así que entrada y salida no son comparables con una red real.
- **Energía:** no se midió. El contador RAPL requiere permisos de root y el laboratorio no los pide.

---

## 6. Datos crudos

Cada archivo `resultados/<fecha>/<entorno>/<fecha>_<entorno>_<prueba>.ndjson` guarda la prueba completa segundo a segundo: la máquina, el perfil de carga, cada muestra del agente, cada segundo del generador (con histogramas de latencia) y el resumen final. Se ven en el laboratorio en **Comparar**, o en **Resultados → Abrir archivo** con las mismas gráficas de una corrida.

Para repetir cualquier medición: [SETUP-LOCAL.md](SETUP-LOCAL.md), [SETUP-DOCKER.md](SETUP-DOCKER.md) y [SETUP-AWS.md](SETUP-AWS.md).
