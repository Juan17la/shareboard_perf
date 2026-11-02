# Mediciones

Qué se midió, cómo y con qué resultado, para las cuatro cargas en los cuatro entornos. Todo sale de mediciones propias guardadas en `resultados/`. Las tablas de la sección 4 se generan con un comando a partir de esos archivos:

```bash
node telemetry/tablas.mjs        # imprime las tablas de la sección 4
```

---

## 1. Entornos medidos

| Entorno | Máquina | CPU disponible para el servidor | Memoria | Disco | Carga generada desde |
|---|---|---|---|---|---|
| **PC nativo** | ASUS Zenbook 14 UX3405MA, Debian 13, kernel 6.12 | Intel Core Ultra 5 125H: P-cores 0-7 (4 núcleos con hyperthreading, hasta 4,5 GHz), sin límite | 15 GB | NVMe Micron 2550, 512 GB | El mismo PC, E-cores 8-15 |
| **Contenedor 1 CPU** | El mismo PC | Los mismos P-cores, con cuota de **1 CPU** (`cpu.max = 100000 100000`) | **512 MB**, sin swap | El mismo | El mismo PC, E-cores |
| **Contenedor 2 CPU** | El mismo PC | Los mismos P-cores, con cuota de **2 CPU** | **512 MB**, sin swap | El mismo | El mismo PC, E-cores |
| **AWS t3.small** | EC2 us-east-1, Ubuntu 26.04.1, kernel 7.0 | 2 vCPU Intel Xeon Platinum 8175M a 2,5 GHz (= **1 núcleo físico** con 2 hilos), créditos Unlimited | 2 GB | EBS gp3 20 GiB (3.000 IOPS, 125 MB/s de base) | Otra instancia EC2 (t3.micro) en la misma zona |

Igual en los cuatro: el mismo código del servidor (`servidor/`), Node 22, MongoDB 7 en Docker, 6.000 cuentas y 6.000 tableros de prueba, el mismo perfil de carga y los mismos criterios. El servidor se reinicia antes de cada prueba.

Validez de la carga: el generador nunca se saturó. El bucle de eventos de su hilo más ocupado estuvo como máximo al 41 % (media en AWS), lejos del 85 % en que el laboratorio invalida una prueba. Si una prueba falla, es por el servidor y no por la herramienta.

---

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

| | Baja (120) | Media (240) | Alta (600) | Server killer (6.000) |
|---|---|---|---|---|
| PC nativo | ✓ | ✓ | ✓ | ✕ (95 s) |
| Contenedor 1 CPU | ✓ | ✕ | ✕ (67 s) | ✕ (26 s) |
| Contenedor 2 CPU | ✓ | ✓ | ✕ | ✕ (44 s) |
| AWS t3.small | ✕ por 45 ms | ✕ | ✕ (94 s) | ✕ (26 s) |

Entre paréntesis, los segundos que alcanzó a medir una prueba que el laboratorio cortó (errores > 20 %). La causa de cada fallo se explica en [COMPARACIONES.md](COMPARACIONES.md) y [CONCLUSIONES.md](CONCLUSIONES.md).

---

## 4. Tablas

### 4.1 Resultado

| Entorno | Prueba | Resultado | Segundos medidos | Usuarios conectados | Entradas/s | Errores | Motivo |
|---|---|---|---|---|---|---|---|
| PC nativo | Baja | ✓ pasa | 600 | 119 | 0,99 | 0 % | – |
| PC nativo | Media | ✓ pasa | 600 | 238 | 2,05 | 0 % | – |
| PC nativo | Alta | ✓ pasa | 600 | 599 | 1,91 | 0 % | – |
| PC nativo | Server killer | ✕ no pasa | 95 | 342 | 4,74 | 9,88 % | errores 20 % (login:TIMEOUT x1500); p95 REST 3138 ms > 300; p95 login 14490 ms > 1000; p99 ping 217 ms > 100; errores 9.9 % (login:TIMEOUT x6985) |
| Contenedor 1 CPU | Baja | ✓ pasa | 600 | 119 | 1,05 | 0 % | – |
| Contenedor 1 CPU | Media | ✕ no pasa | 600 | 237 | 2,02 | 0,01 % | p95 REST 441 ms > 300; p95 login 1489 ms > 1000; p95 registro 1812 ms > 1000; p95 difusión 171 ms > 150; p95 preview 165 ms > 150; p99 ping 679 ms > 100 |
| Contenedor 1 CPU | Alta | ✕ no pasa | 67 | 134 | 0 | 11,29 % | errores 20 % (login:TIMEOUT x253); p95 REST 14490 ms > 300; p95 difusión 424 ms > 150; p95 preview 275 ms > 150; p99 ping 734 ms > 100; errores 11.3 % (login:TIMEOUT x1640) |
| Contenedor 1 CPU | Server killer | ✕ no pasa | 26 | 43 | 2,62 | 15,06 % | errores 22 % (login:TIMEOUT x412); p95 REST 407 ms > 300; p95 login 14490 ms > 1000; errores 15.1 % (login:TIMEOUT x412) |
| Contenedor 2 CPU | Baja | ✓ pasa | 600 | 112 | 0,98 | 0 % | – |
| Contenedor 2 CPU | Media | ✓ pasa | 600 | 236 | 1,87 | 0 % | – |
| Contenedor 2 CPU | Alta | ✕ no pasa | 600 | 594 | 2 | 0 % | p95 REST 2790 ms > 300; p95 login 2790 ms > 1000; p95 registro 3971 ms > 1000; p95 difusión 407 ms > 150; p95 preview 441 ms > 150; p99 ping 1223 ms > 100 |
| Contenedor 2 CPU | Server killer | ✕ no pasa | 44 | 121 | 3,84 | 9,75 % | errores 21 % (login:TIMEOUT x777); p95 login 14490 ms > 1000; p95 registro 13933 ms > 1000; p99 ping 392 ms > 100; errores 9.8 % (login:TIMEOUT x1475) |
| AWS t3.small | Baja | ✕ no pasa | 600 | 120 | 0,95 | 0 % | p95 registro 1045 ms > 1000 |
| AWS t3.small | Media | ✕ no pasa | 600 | 235 | 1,97 | 0 % | p95 REST 1175 ms > 300; p95 login 2788 ms > 1000; p95 registro 3262 ms > 1000; p95 difusión 360 ms > 150; p95 preview 308 ms > 150; p99 ping 1487 ms > 100 |
| AWS t3.small | Alta | ✕ no pasa | 94 | 137 | 0,02 | 13,14 % | errores 21 % (login:TIMEOUT x244); p95 REST 13395 ms > 300; p95 login 13931 ms > 1000; p95 difusión 177 ms > 150; p95 preview 170 ms > 150; p99 ping 422 ms > 100; errores 13.1 % (login:TIMEOUT x2095) |
| AWS t3.small | Server killer | ✕ no pasa | 26 | 42 | 2,69 | 13,9 % | errores 22 % (login:TIMEOUT x401); p95 login 14489 ms > 1000; p99 ping 134 ms > 100; errores 13.9 % (login:TIMEOUT x401) |

### 4.2 CPU (promedio / pico)

| Entorno | Prueba | Máquina % | Núcleo más ocupado % | us % | sy % | wa % | id % | st % | Hilo JS % | libuv % | Frenado ms/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PC nativo | Baja | 9 / 34 | 28 / 100 | 6,7 / 26,6 | 1,8 / 7 | 0,3 / 2,8 | 91 / 98 | 0 / 0 | 14 / 30 | 14 / 138 | – |
| PC nativo | Media | 11 / 32 | 29 / 75 | 8,4 / 24 | 2,5 / 9,5 | 0,9 / 31,4 | 88 / 95 | 0 / 0 | 29 / 55 | 32 / 124 | – |
| PC nativo | Alta | 18 / 42 | 49 / 100 | 13,4 / 33,1 | 4,8 / 11,1 | 0,4 / 1,8 | 81 / 90 | 0 / 0 | 75 / 102 | 35 / 153 | – |
| PC nativo | Server killer | 43 / 73 | 99 / 100 | 37,6 / 59,8 | 4,9 / 13,2 | 0,3 / 1,1 | 57 / 94 | 0 / 0 | 88 / 105 | 393 / 417 | – |
| Contenedor 1 CPU | Baja | 9 / 26 | 21 / 77 | 6,2 / 21,7 | 2,4 / 6,5 | 0,2 / 1,6 | 91 / 97 | 0 / 0 | 16 / 36 | 15 / 73 | 73 / 2.210 |
| Contenedor 1 CPU | Media | 14 / 35 | 32 / 85 | 9,7 / 26,6 | 4 / 8,4 | 0,2 / 1,7 | 86 / 95 | 0 / 0 | 34 / 58 | 35 / 80 | 687 / 3.861 |
| Contenedor 1 CPU | Alta | 13 / 25 | 26 / 40 | 10,6 / 20,4 | 2,3 / 4,5 | 0,2 / 1,2 | 87 / 89 | 0 / 0 | 18 / 22 | 79 / 93 | 4.131 / 4.889 |
| Contenedor 1 CPU | Server killer | 12 / 17 | 27 / 35 | 9,7 / 13,9 | 2,5 / 4,7 | 0,3 / 0,4 | 88 / 91 | 0 / 0 | 13 / 18 | 79 / 92 | 3.645 / 4.377 |
| Contenedor 2 CPU | Baja | 6 / 26 | 18 / 74 | 4,2 / 21,2 | 1,8 / 5,6 | 0,2 / 2,5 | 94 / 98 | 0 / 0 | 15 / 22 | 14 / 78 | 1 / 126 |
| Contenedor 2 CPU | Media | 9 / 19 | 27 / 62 | 6,4 / 15,2 | 3 / 6,4 | 0,2 / 1,3 | 90 / 95 | 0 / 0 | 31 / 47 | 27 / 102 | 21 / 979 |
| Contenedor 2 CPU | Alta | 25 / 39 | 67 / 100 | 15,8 / 25,7 | 9,1 / 13,9 | 0,2 / 1,2 | 75 / 85 | 0 / 0 | 93 / 103 | 44 / 121 | 181 / 1.864 |
| Contenedor 2 CPU | Server killer | 17 / 27 | 42 / 48 | 14,8 / 23,5 | 2,1 / 3,9 | 0,1 / 0,7 | 83 / 95 | 0 / 0 | 31 / 41 | 155 / 182 | 2.931 / 3.341 |
| AWS t3.small | Baja | 38 / 100 | 45 / 100 | 28,5 / 91,3 | 8,3 / 13,7 | 0,6 / 2,5 | 62 / 87 | 0,7 / 34,8 | 38 / 86 | 28 / 163 | – |
| AWS t3.small | Media | 80 / 100 | 86 / 100 | 63,5 / 91,4 | 16,4 / 40 | 0,4 / 2,1 | 19 / 61 | 0,5 / 66,7 | 66 / 135 | 72 / 317 | – |
| AWS t3.small | Alta | 100 / 100 | 100 / 100 | 93,5 / 96,3 | 6,5 / 8,8 | 0 / 0 | 0 / 0 | 0 / 0 | 47 / 123 | 203 / 493 | – |
| AWS t3.small | Server killer | 91 / 100 | 92 / 100 | 88,3 / 98,7 | 3 / 5,5 | 0 / 0,5 | 9 / 99 | 0 / 0 | 29 / 84 | 193 / 478 | – |

### 4.3 Memoria residente (promedio / pico, MB)

| Entorno | Prueba | RES servidor | RES mongod |
|---|---|---|---|
| PC nativo | Baja | 202 / 213 | 235 / 258 |
| PC nativo | Media | 226 / 243 | 301 / 325 |
| PC nativo | Alta | 276 / 300 | 432 / 485 |
| PC nativo | Server killer | 315 / 375 | 489 / 497 |
| Contenedor 1 CPU | Baja | 174 / 180 | 223 / 240 |
| Contenedor 1 CPU | Media | 225 / 245 | 292 / 319 |
| Contenedor 1 CPU | Alta | 238 / 250 | 339 / 340 |
| Contenedor 1 CPU | Server killer | 193 / 222 | 338 / 338 |
| Contenedor 2 CPU | Baja | 196 / 202 | 228 / 241 |
| Contenedor 2 CPU | Media | 221 / 233 | 282 / 302 |
| Contenedor 2 CPU | Alta | 267 / 303 | 401 / 421 |
| Contenedor 2 CPU | Server killer | 226 / 261 | 418 / 419 |
| AWS t3.small | Baja | 189 / 197 | 234 / 257 |
| AWS t3.small | Media | 228 / 255 | 311 / 346 |
| AWS t3.small | Alta | 256 / 267 | 358 / 360 |
| AWS t3.small | Server killer | 190 / 219 | 359 / 360 |

### 4.4 Disco y red (promedio / pico)

| Entorno | Prueba | IOPS | MB/s | %util | Red entrada MB/s | Red salida MB/s |
|---|---|---|---|---|---|---|
| PC nativo | Baja | 40 / 599 | 1,3 / 45,6 | 2,1 / 23,6 | 7,1 / 16 | 7,1 / 16 |
| PC nativo | Media | 504 / 33.765 | 6,1 / 213,3 | 4 / 83,9 | 16,5 / 28,3 | 16,5 / 28,3 |
| PC nativo | Alta | 117 / 494 | 8,9 / 47,9 | 3,6 / 26,8 | 42,4 / 62,7 | 42,4 / 62,7 |
| PC nativo | Server killer | 105 / 468 | 8,5 / 42,7 | 4,2 / 22,8 | 30,5 / 45,2 | 30,5 / 45,2 |
| Contenedor 1 CPU | Baja | 39 / 315 | 1,2 / 27,4 | 1,9 / 24,4 | 5,7 / 13,9 | 5,7 / 13,9 |
| Contenedor 1 CPU | Media | 69 / 440 | 3,9 / 41,1 | 2,7 / 25,6 | 12,5 / 25,3 | 12,2 / 25,3 |
| Contenedor 1 CPU | Alta | 64 / 286 | 3,8 / 24,9 | 2,1 / 24 | 7,1 / 12,3 | 5,7 / 10,5 |
| Contenedor 1 CPU | Server killer | 33 / 201 | 0,9 / 3,6 | 0,8 / 2,8 | 4,1 / 10,5 | 3,8 / 8,2 |
| Contenedor 2 CPU | Baja | 36 / 216 | 1,2 / 21,1 | 1,9 / 25,2 | 5,8 / 13,4 | 5,8 / 13,4 |
| Contenedor 2 CPU | Media | 64 / 340 | 3,8 / 26,4 | 2,8 / 25,2 | 12,5 / 25,7 | 12,2 / 25,7 |
| Contenedor 2 CPU | Alta | 118 / 945 | 9,8 / 82,9 | 3,4 / 25,2 | 30,1 / 53 | 29,6 / 45,7 |
| Contenedor 2 CPU | Server killer | 71 / 408 | 5 / 38 | 2,3 / 22 | 13 / 20,8 | 10,7 / 16,2 |
| AWS t3.small | Baja | 17 / 110 | 1 / 7,9 | 1,8 / 5,8 | 0,9 / 3,9 | 5,2 / 14,4 |
| AWS t3.small | Media | 44 / 598 | 4,5 / 95,3 | 3,4 / 43,4 | 2,3 / 66,7 | 10,2 / 25,7 |
| AWS t3.small | Alta | 48 / 220 | 5,1 / 31,5 | 3,6 / 12,1 | 5,9 / 18,6 | 6,7 / 18,6 |
| AWS t3.small | Server killer | 11 / 37 | 0,9 / 4,6 | 0,7 / 3,2 | 1,3 / 5,2 | 4,5 / 13 |

### 4.5 Latencia vista por el usuario: p50 / p95 / p99 (ms)

| Entorno | Prueba | REST | Login | Registro | Trazo a los demás | Ping WebSocket |
|---|---|---|---|---|---|---|
| PC nativo | Baja | 2,6 / 3,8 / 4,7 | 136 / 210 / 245 | 136 / 194 / 210 | 0,4 / 1,1 / 1,8 | 0,1 / 0,4 / 0,9 |
| PC nativo | Media | 2,6 / 4,5 / 6,7 | 147 / 202 / 255 | 153 / 210 / 227 | 0,5 / 1,8 / 3,7 | 0,1 / 0,9 / 2,8 |
| PC nativo | Alta | 4,9 / 60 / 186 | 179 / 310 / 442 | 166 / 245 / 459 | 1,6 / 16 / 49 | 0,9 / 16 / 73 |
| PC nativo | Server killer | 4,5 / 3.139 / 10.181 | 6.878 / 14.491 / 15.071 | – | 12 / 85 / 147 | 13 / 131 / 218 |
| Contenedor 1 CPU | Baja | 2,7 / 4,3 / 55 | 153 / 363 / 735 | 159 / 298 / 363 | 0,5 / 1,9 / 39 | 0,2 / 0,9 / 36 |
| Contenedor 1 CPU | Media | 3,7 / 442 / 1.089 | 349 / 1.490 / 2.294 | 442 / 1.813 / 1.961 | 1 / 172 / 408 | 0,5 / 255 / 680 |
| Contenedor 1 CPU | Alta | 6.878 / 14.491 / 14.491 | – | – | 60 / 425 / 654 | 65 / 336 / 735 |
| Contenedor 1 CPU | Server killer | 6,4 / 408 / 605 | 7.737 / 14.491 / 15.071 | – | 16 / 73 / 147 | 47 / 88 / 96 |
| Contenedor 2 CPU | Baja | 2,6 / 3,7 / 4,3 | 136 / 159 / 202 | 136 / 147 / 159 | 0,5 / 1 / 1,5 | 0,2 / 0,5 / 0,9 |
| Contenedor 2 CPU | Media | 2,7 / 4,9 / 12 | 142 / 227 / 336 | 142 / 408 / 442 | 0,6 / 1,8 / 5,1 | 0,2 / 1,2 / 6,7 |
| Contenedor 2 CPU | Alta | 336 / 2.791 / 5.653 | 735 / 2.791 / 7.153 | 707 / 3.972 / 5.227 | 62 / 408 / 680 | 126 / 795 / 1.225 |
| Contenedor 2 CPU | Server killer | 4,7 / 186 / 629 | 7.737 / 14.491 / 15.071 | 8.368 / 13.934 / 13.934 | 42 / 136 / 276 | 31 / 159 / 393 |
| AWS t3.small | Baja | 4,9 / 17 / 62 | 310 / 654 / 895 | 336 / 1.047 / 1.047 | 2,1 / 9,8 / 32 | 0,5 / 6,1 / 37 |
| AWS t3.small | Media | 45 / 1.178 / 4.296 | 765 / 2.791 / 7.439 | 895 / 3.265 / 6.115 | 14 / 363 / 1.007 | 15 / 537 / 1.490 |
| AWS t3.small | Alta | 1.378 / 13.398 / 14.491 | 9.790 / 13.934 / 13.934 | – | 25 / 179 / 218 | 28 / 276 / 425 |
| AWS t3.small | Server killer | 14 / 236 / 349 | 8.368 / 14.491 / 15.071 | – | 6,4 / 17 / 65 | 5,7 / 82 / 136 |

### 4.6 Latencia dentro del servidor (log de Fastify, sin red): p50 / p95 / p99 (ms)

| Entorno | Prueba | REST | Login |
|---|---|---|---|
| PC nativo | Baja | 1,4 / 2,4 / 2,9 | 136 / 202 / 245 |
| PC nativo | Media | 1,4 / 2,8 / 3,8 | 147 / 202 / 255 |
| PC nativo | Alta | 2,2 / 23 / 85 | 179 / 298 / 378 |
| PC nativo | Server killer | 2,9 / 31 / 67 | 735 / 1.325 / 1.325 |
| Contenedor 1 CPU | Baja | 1,3 / 2,4 / 11 | 153 / 363 / 707 |
| Contenedor 1 CPU | Media | 1,6 / 103 / 517 | 336 / 1.132 / 1.550 |
| Contenedor 1 CPU | Alta | 88 / 323 / 323 | 6.115 / 6.878 / 6.878 |
| Contenedor 1 CPU | Server killer | 4,5 / 393 / 393 | 581 / 968 / 968 |
| Contenedor 2 CPU | Baja | 1,3 / 2,1 / 2,5 | 136 / 153 / 194 |
| Contenedor 2 CPU | Media | 1,4 / 2,7 / 4,5 | 142 / 218 / 336 |
| Contenedor 2 CPU | Alta | 73 / 1.089 / 2.385 | 497 / 1.433 / 1.743 |
| Contenedor 2 CPU | Server killer | 3 / 186 / 186 | 680 / 860 / 860 |
| AWS t3.small | Baja | 2,7 / 8,8 / 27 | 298 / 605 / 827 |
| AWS t3.small | Media | 5,5 / 442 / 1.378 | 680 / 1.490 / 3.018 |
| AWS t3.small | Alta | 6,1 / 276 / 276 | 9.413 / 9.790 / 9.790 |
| AWS t3.small | Server killer | – | 860 / 860 / 860 |


---

## 5. Observaciones sobre los datos

- **Red en el PC y en los contenedores:** el generador y el servidor están en la misma máquina, así que el tráfico pasa por la interfaz `lo` y la entrada es igual a la salida. En AWS la interfaz es la real (`ens5`): la salida del servidor es 4 a 6 veces la entrada, porque cada mensaje recibido se reenvía a varios clientes.
- **Pico de disco en PC media (33.765 IOPS, 213 MB/s, 84 %util):** fue un solo segundo. El promedio de la prueba fue 504 IOPS y 4 %util, y en ese segundo no subió ninguna latencia. Coincide con un *checkpoint* de MongoDB o con actividad del escritorio del PC; no lo causó la carga.
- **CPU por proceso en AWS alta y Server killer:** el agente comparte las 2 vCPU con el servidor saturado. Cuando el agente recibe CPU tarde, la diferencia de *jiffies* abarca más de un segundo y aparecen valores por proceso mayores a 200 %, que son imposibles en 2 vCPU. Para esas dos pruebas vale la CPU total de la máquina (`/proc/stat`: 100 % us+sy, 0 % id), que no tiene ese problema porque mide toda la máquina en el mismo intervalo.
- **Energía:** no se midió. El contador RAPL del procesador requiere permisos de root y el laboratorio no los pide. La temperatura del paquete del PC estuvo entre 71 y 93 °C, sin bajadas de frecuencia que afectaran las pruebas.
- **Errores `USERNAME_TAKEN` (0,01 %):** un error del generador, ya corregido, que repetía nombres de registro entre corridas. No afecta los resultados (son 16 a 34 de unas 30.000 operaciones por prueba).

## 6. Datos crudos

Cada archivo `resultados/<entorno>/<fecha>_<entorno>_<prueba>.ndjson` guarda la prueba completa segundo a segundo: la máquina, el perfil de carga, cada muestra del agente, cada segundo del generador (con histogramas de latencia) y el resumen final. Se abren en el laboratorio con **Resultados → Abrir archivo** (mismas gráficas) o se convierten a CSV con los botones de descarga.

Para repetir cualquier medición: [SETUP-LOCAL.md](SETUP-LOCAL.md), [SETUP-DOCKER.md](SETUP-DOCKER.md) y [SETUP-AWS.md](SETUP-AWS.md).
