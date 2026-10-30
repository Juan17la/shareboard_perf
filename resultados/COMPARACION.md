# Resultados: prueba Escalones (PC físico vs contenedor con límites)

Prueba: flujo realista (clases, equipos y personas solas; ver `INVESTIGACION-CARGA.md`), creciendo sin pausa 250 → 370 → 450 → 500 → 1.000 usuarios, con 1 minuto de llegada y 5 minutos medidos por nivel. Misma base de datos (reiniciada antes de cada corrida), mismo código y mismo generador. Fecha: 30 de octubre de 2026.

| | PC físico (nativo) | Contenedor 1 CPU · 512 MB |
|---|---|---|
| Máquina | Intel Core Ultra 5 125H, 18 hilos, 15 GB; servidor fijado a los 8 P-cores | Mismo PC; servidor con cuota de 1 CPU y 512 MB, Mongo con 1 CPU y 1 GB |
| Último nivel que pasa | **500 usuarios** | **Ninguno** (falla desde 250 por los logins) |
| Tiempo real (preview p95) a 370 | 1,6 ms | 131 ms |
| Usuarios realmente conectados a 1.000 | 802 a 935 | 275 a 343 |
| Recurso que se agota | El hilo de JavaScript (100 % de un núcleo a 1.000) | La cuota de CPU del contenedor (100 % desde 450, frenado hasta 2 s por segundo) |

## Lectura rápida

1. **PC físico: el límite es un solo núcleo.** El hilo de JavaScript sube unos 11 puntos por cada 100 usuarios (23 % a 250, 53 % a 500) y llega al 100 % a 1.000, donde ya no alcanza a conectar a todos (entre 802 y 935 de 1.000). En ese momento la máquina entera solo está al 28 % de CPU, el disco casi no espera (iowait 0,3 %) y la memoria del servidor es de 333 MB. El servidor no puede usar los otros 17 hilos porque todo el reenvío de cursores y previews pasa por un solo hilo. Por la tendencia, el límite real está entre 800 y 900 usuarios.
2. **Contenedor de 1 CPU: el límite es la cuota.** El tiempo real aguanta hasta 370 (preview p95 de 131 ms). Pero el login usa scrypt (unos 130 ms de CPU y 16 MB por login), y con una sola CPU compite con el hilo de JavaScript: por eso el login p95 ya es de 3,4 s a 250 usuarios. Desde 450 el contenedor usa el 100 % de su cuota y el kernel lo frena; deja de aceptar conexiones y solo quedan conectados entre 275 y 343 usuarios aunque el generador intente 1.000.
3. **La memoria y el disco no son el problema en ninguno.** El servidor no pasó de 361 MB (nativo) ni de 255 MB (contenedor, lejos del límite de 512 MB). El disco tuvo picos al guardar trazos, pero con iowait por debajo del 1 % de promedio.
4. **La espera está en la cola del event loop.** A 1.000 usuarios en el PC, listar tableros tarda 218 ms de mediana dentro del servidor, pero 459 ms vistos por el usuario: el resto es tiempo en la fila antes de que el único hilo de JavaScript lo atienda.

Validez: el uso promedio del hilo generador más ocupado no pasó del 32 % en ningún escalón (pico de un segundo: 50 %; límite 85 %), así que las fallas son del servidor y no de la herramienta.

---

## Escalones · pc

Archivo `20261030-162150_pc_escalones.ndjson` · Intel(R) Core(TM) Ultra 5 125H · 18 hilos · 15 GB · RTT base 1,29 ms

### Rendimiento

| Usuarios | Tableros | Resultado | REST p50 / p95 / p99 (ms) | Trazo a otros p95 (ms) | Preview p95 (ms) | Login p95 (ms) | Ping p99 (ms) | Errores | Motivo |
|---|---|---|---|---|---|---|---|---|---|
| 250 | 46 | ✓ pasa | 2,9 / 4 / 4,9 | 1,1 | 1,1 | 201,6 | 1,1 | 0 % | – |
| 370 | 68 | ✓ pasa | 3,2 / 5,1 / 5,9 | 1,8 | 1,6 | 159,3 | 1,9 | 0 % | – |
| 450 | 82 | ✓ pasa | 3,7 / 8,4 / 15,1 | 3,6 | 3,3 | 218 | 7,2 | 0 % | – |
| 500 | 92 | ✓ pasa | 3,6 / 9,1 / 13,5 | 3,7 | 3,4 | 179,2 | 5,7 | 0 % | – |
| 1000 | 184 | ✕ no pasa | 459,4 / 1.549,5 / 2.205,5 | 335,7 | 335,7 | 1.743 | 930,6 | 0,24 % | p95 REST 1548 ms > 300; p95 login 1742 ms > 1000; p95 difusión 334 ms > 150; p95 preview 334 ms > 150; p99 ping 929 ms > 100 |

### Recursos (promedio / pico)

| Usuarios | CPU máquina % | Núcleo más ocupado % | Hilo JS % | Servidor total % de un núcleo | RSS servidor MB | RSS mongod MB | Disco IOPS | Disco MB/s | Red entrada MB/s | Red salida MB/s | iowait % | Contenedor frenado ms/s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 250 | 8,5 / 16,4 | 16 / 32 | 23 / 37 | 26 / 98 | 197 / 204 | 214 / 235 | 40 / 476 | 1,08 / 6,3 | 13 / 23,1 | 13 / 23,1 | 0,2 / 1,9 | – |
| 370 | 10,3 / 19,8 | 23 / 41 | 37 / 50 | 39 / 72 | 215 / 221 | 264 / 284 | 70 / 1.161 | 3,41 / 41 | 22,5 / 35,8 | 22,5 / 35,8 | 0,3 / 1,5 | – |
| 450 | 15,5 / 60,8 | 33 / 100 | 50 / 99 | 55 / 103 | 239 / 249 | 333 / 355 | 132 / 3.057 | 6,74 / 77,4 | 30,3 / 72 | 30,3 / 72 | 0,4 / 5,8 | – |
| 500 | 12,7 / 22,9 | 35 / 66 | 53 / 73 | 58 / 97 | 265 / 275 | 385 / 416 | 134 / 751 | 9,78 / 77,9 | 38,1 / 55,3 | 38,1 / 55,3 | 0,3 / 1,4 | – |
| 1000 | 27,8 / 41,6 | 71 / 100 | 100 / 104 | 187 / 420 | 333 / 361 | 516 / 563 | 174 / 1.228 | 14,04 / 95,7 | 61,2 / 83,6 | 61,2 / 83,6 | 0,3 / 1,6 | – |

### Latencia dentro del servidor (log de Fastify, sin red), p50 / p95 / p99 ms

| Usuarios | Listar | Unirse | Login |
|---|---|---|---|
| 250 | 1,8 / 2,5 / 3,2 | 0,2 / 0,3 / 0,3 | 136,2 / 193,8 / 209,7 |
| 370 | 1,9 / 3,2 / 4 | 0,2 / 0,3 / 1,5 | 141,6 / 159,3 / 165,7 |
| 450 | 2,3 / 4,9 / 15,8 | 0,3 / 0,3 / 0,4 | 159,3 / 209,7 / 275,9 |
| 500 | 2,3 / 5,5 / 9,8 | 0,2 / 0,3 / 0,4 | 147,3 / 179,2 / 201,6 |
| 1000 | 218 / 827,3 / 1.432,6 | 0,4 / 363,1 / 1.088,7 | 477,8 / 1.046,8 / 1.549,5 |

## Escalones · docker-1cpu

Archivo `20261030-165539_docker-1cpu_escalones.ndjson` · Intel(R) Core(TM) Ultra 5 125H · 18 hilos · 15 GB · RTT base 1,06 ms

### Rendimiento

| Usuarios | Tableros | Resultado | REST p50 / p95 / p99 (ms) | Trazo a otros p95 (ms) | Preview p95 (ms) | Login p95 (ms) | Ping p99 (ms) | Errores | Motivo |
|---|---|---|---|---|---|---|---|---|---|
| 250 | 46 | ✕ no pasa | 3,3 / 1.006,6 / 3.139,1 | 1,4 | 1,3 | 3.395,2 | 275,9 | 0 % | p95 REST 1005 ms > 300; p95 login 3394 ms > 1000; p99 ping 275 ms > 100 |
| 370 | 68 | ✕ no pasa | 5,3 / 459,4 / 1.676 | 141,6 | 131 | 1.812,7 | 1.088,7 | 0 % | p95 REST 458 ms > 300; p95 login 1812 ms > 1000; p99 ping 1088 ms > 100 |
| 450 | 82 | ✕ no pasa | 4.646,6 / 11.910,6 / 13.933,8 | 1.885,3 | 1.960,7 | 11.012,1 | 3.672,3 | 0,25 % | p95 REST 11910 ms > 300; p95 login 11011 ms > 1000; p95 difusión 1884 ms > 150; p95 preview 1960 ms > 150; p99 ping 3671 ms > 100 |
| 500 | 92 | ✕ no pasa | 2.580,1 / 9.789,7 / 11.012,1 | 1.885,3 | 2.039,1 | 7.736,9 | 3.672,3 | 0,74 % | p95 REST 9789 ms > 300; p95 login 7736 ms > 1000; p95 difusión 1884 ms > 150; p95 preview 2038 ms > 150; p99 ping 3671 ms > 100 |
| 1000 | 184 | ✕ no pasa | 3.971,9 / 7.736,9 / 8.046,4 | 2.293,7 | 2.580,1 | 6.613,6 | 4.130,8 | 5,78 % | p95 REST 7736 ms > 300; p95 login 6613 ms > 1000; p95 difusión 2293 ms > 150; p95 preview 2579 ms > 150; p99 ping 4130 ms > 100; errores 5.8 % (login:TIMEOUT x8714) |

### Recursos (promedio / pico)

| Usuarios | CPU máquina % | Núcleo más ocupado % | Hilo JS % | Servidor total % de un núcleo | RSS servidor MB | RSS mongod MB | Disco IOPS | Disco MB/s | Red entrada MB/s | Red salida MB/s | iowait % | Contenedor frenado ms/s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 250 | 8,9 / 18,4 | 21 / 34 | 27 / 37 | 30 / 100 | 195 / 200 | 217 / 233 | 37 / 228 | 1,15 / 7,8 | 11,8 / 21 | 11,8 / 21 | 0,2 / 1,9 | 35 / 3.896 |
| 370 | 23,8 / 99,1 | 46 / 100 | 59 / 103 | 66 / 110 | 206 / 224 | 247 / 264 | 474 / 7.083 | 18,71 / 429,1 | 18,4 / 30,1 | 18,4 / 30,1 | 0,8 / 13,6 | 88 / 1.321 |
| 450 | 43,3 / 74,4 | 68 / 100 | 73 / 103 | 100 / 108 | 211 / 221 | 278 / 327 | 240 / 15.753 | 9,19 / 226,5 | 17,8 / 32,5 | 17 / 32,5 | 0,7 / 3,8 | 682 / 2.999 |
| 500 | 34,5 / 53,5 | 57 / 100 | 57 / 98 | 100 / 110 | 233 / 239 | 340 / 352 | 134 / 1.482 | 8,31 / 88,5 | 17,8 / 38,5 | 15,4 / 29,3 | 0,2 / 1,5 | 1.293 / 4.097 |
| 1000 | 29,5 / 53,7 | 47 / 92 | 45 / 94 | 100 / 112 | 249 / 255 | 373 / 390 | 228 / 9.761 | 10,09 / 280,9 | 17,7 / 40,6 | 14,5 / 35,1 | 0,2 / 4,6 | 2.085 / 4.952 |

### Latencia dentro del servidor (log de Fastify, sin red), p50 / p95 / p99 ms

| Usuarios | Listar | Unirse | Login |
|---|---|---|---|
| 250 | 1,8 / 37,3 / 827,3 | 0,3 / 310,3 / 496,9 | 179,2 / 2.580,1 / 2.580,1 |
| 370 | 3,2 / 218 / 653,8 | 0,4 / 0,7 / 1,8 | 441,7 / 1.132,2 / 1.676 |
| 450 | 3.819,2 / 10.588,5 / 13.397,9 | 860,4 / 6.878,1 / 9.413,2 | 2.902,3 / 7.736,9 / 8.703 |
| 500 | 1.432,6 / 7.439,4 / 9.051,1 | 764,9 / 3.018,3 / 7.736,9 | 2.790,6 / 5.435,9 / 6.114,6 |
| 1000 | 2.790,6 / 5.226,8 / 5.653,3 | 1.224,6 / 4.296 / 5.653,3 | 3.264,6 / 4.646,6 / 5.435,9 |

