# Comparaciones: PC, contenedor y nube

Las cuatro opciones se evaluaron con **las mismas cargas, el mismo código, los mismos datos y las mismas métricas** ([MEDICIONES.md](MEDICIONES.md)). Este documento explica, prueba por prueba, por qué dan resultados distintos, y compara su costo.

---

## 1. Fichas técnicas y precios

| | PC nativo | Contenedor 1 CPU | Contenedor 2 CPU | AWS t3.small |
|---|---|---|---|---|
| Procesador | Intel Core Ultra 5 125H (Meteor Lake, 2023): 4 P-cores + 8 E-cores + 2 LP-cores, 18 hilos | El mismo | El mismo | Intel Xeon Platinum 8175M (Skylake-SP, 2017), 2,5 GHz base, 3,5 GHz turbo |
| Núcleos usados por el servidor | P-cores 0-7: **4 núcleos físicos con 2 hilos cada uno**, hasta 4,5 GHz | Los mismos, con cuota de **1 CPU** de tiempo | Los mismos, con cuota de **2 CPU** de tiempo | **2 vCPU = 1 núcleo físico con 2 hilos** (hyperthreading) |
| Caché L2 / L3 | 2 MB por P-core / 18 MB compartida | Igual | Igual | 1 MB por núcleo / 33 MB compartida entre todos los clientes del host |
| Memoria | 15 GB LPDDR5x | 512 MB (límite) | 512 MB (límite) | 2 GB |
| Disco | NVMe Micron 2550, 512 GB | El mismo | El mismo | EBS gp3: 3.000 IOPS y 125 MB/s de base, por red |
| Red | Loopback (misma máquina) | Loopback | Loopback | "Hasta 5 Gbps": 0,128 Gbps (16 MB/s) de base con créditos de ráfaga |
| Modelo de CPU | Dedicada | Cuota CFS: 100 ms cada 100 ms por CPU; si la gasta, el kernel lo frena | Igual, 200 ms cada 100 ms | *Burstable*: línea base de 20 % por vCPU; con créditos Unlimited puede usar el 100 % y paga el excedente |
| **Precio** | Precio de compra del portátil: ________ COP (amortizado a 36 meses: ________ COP/mes) + energía ≈ **17.600 COP/mes** (28 W de potencia base × 730 h × 863,6 COP/kWh) | Plan equivalente en un PaaS: Render Standard (1 CPU, 2 GB) **USD 25/mes** | Render Pro (2 CPU, 4 GB) **USD 85/mes** | **USD 20,43/mes**: instancia USD 15,18 (0,0208 × 730 h) + disco USD 1,60 (20 GB × 0,08) + IPv4 pública USD 3,65 (0,005 × 730 h) |

Notas de precio:

- Precios de AWS On-Demand, región us-east-1, consultados el 2 de noviembre de 2026. El generador (t3.micro, USD 0,0104/h) no cuenta: solo existe para medir.
- La tarifa de energía es la de Enel Colombia para estrato 4, agosto de 2026 (863,6 COP/kWh). La potencia del PC **no se midió** (RAPL requiere root): 28 W es la potencia base del procesador según Intel y se usa como estimación. El PC además no incluye IP pública, disponibilidad 24/7 ni respaldo eléctrico.
- Render no incluye la base de datos: MongoDB se pagaría aparte en los tres casos sin máquina propia.

---

## 2. Prueba por prueba

### 2.1 Carga baja: 120 usuarios, 1 entrada por segundo

| | PC | Cont. 1 CPU | Cont. 2 CPU | AWS |
|---|---|---|---|---|
| Resultado | ✓ | ✓ | ✓ | ✕ (registro p95 1.047 ms, límite 1.000) |
| Login p50 dentro del servidor | 136 ms | 153 ms | 136 ms | **298 ms** |
| Login p99 visto por el usuario | 245 ms | **735 ms** | 202 ms | 895 ms |
| REST p95 | 3,8 ms | 4,3 ms | 3,7 ms | 17 ms |
| CPU de la máquina (promedio) | 9 % | 9 % | 6 % | **38 %** |
| Contenedor frenado (promedio / pico) | – | 73 / 2.210 ms/s | 1 / 126 ms/s | – |

**Qué explica la diferencia:**

- **El login cuesta el doble en AWS.** El login calcula scrypt, un algoritmo diseñado para ser caro en CPU y en memoria: 5 pasadas secuenciales sobre un bloque de 16 MB. En el PC tarda 136 ms; en la t3.small, 298 ms (2,2 veces más). Hay tres causas en el hardware: frecuencia (4,5 GHz de turbo en el P-core contra 2,5-3,1 GHz en el Xeon), microarquitectura (Meteor Lake hace más instrucciones por ciclo que Skylake) y que las 2 vCPU son **un solo núcleo con hyperthreading**: cuando dos logins se calculan a la vez, comparten las mismas unidades de ejecución y la misma caché L2, y cada uno avanza más lento.
- **El contenedor de 1 CPU ya muestra el freno en la cola de latencia.** El promedio de CPU es bajo, pero cuando coinciden un login (threadpool) y el tiempo real (hilo principal), los hilos del proceso gastan los 100 ms de cuota antes de terminar el periodo y el kernel congela el contenedor hasta el siguiente. Por eso el p99 del login sube de 245 a 735 ms aunque la mediana casi no cambia.
- Con 2 CPU de cuota el freno casi desaparece (1 ms/s promedio) y los números son iguales a los del PC.

### 2.2 Carga media: 240 usuarios, 2 entradas por segundo

| | PC | Cont. 1 CPU | Cont. 2 CPU | AWS |
|---|---|---|---|---|
| Resultado | ✓ | ✕ | ✓ | ✕ |
| REST p95 usuario / dentro del servidor | 4,5 / 2,8 ms | **442 / 103 ms** | 4,9 / 2,7 ms | **1.178 / 442 ms** |
| Login p95 | 202 ms | 1.490 ms | 227 ms | 2.791 ms |
| Ping WebSocket p99 | 2,8 ms | **680 ms** | 6,7 ms | **1.490 ms** |
| CPU de la máquina (us / sy / id) | 8 / 3 / 88 % | 10 / 4 / **86 %** | 6 / 3 / 90 % | 64 / 16 / **19 %** |
| Hilo JS + libuv (promedio, % de un núcleo) | 29 + 32 | 34 + 35 | 31 + 27 | 66 + 72 |
| Contenedor frenado | – | **687 ms/s** | 21 ms/s | – |

**Qué explica la diferencia:**

- **El contenedor de 1 CPU falla con la máquina ociosa** (86 % idle). No le falta hardware: le falta **cuota**. El proceso usa en promedio 0,69 CPU (34 % del hilo JS + 35 % de libuv), pero lo hace en ráfagas: cuando el hilo de JavaScript y varios hilos del threadpool trabajan a la vez, consumen los 100 ms del periodo en 20-30 ms y quedan congelados el resto. El frenado promedio es de 687 ms por segundo (sumado entre hilos). Durante esa pausa el hilo de JavaScript no atiende a nadie: el ping, que solo responde "pong", sube a 680 ms en p99.
- **AWS falla por CPU real.** La máquina está al 80 % de uso promedio con picos de 100 %. Solo los logins consumen ~0,7 de núcleo (2 por segundo × ~0,35 s de scrypt). El resto es el tiempo real y MongoDB. Con dos hilos compitiendo por un núcleo físico, las peticiones esperan turno: dentro del servidor el REST p95 es 442 ms, y visto por el usuario 1.178 ms. La diferencia es la cola antes de que Node lea la petición.
- **El contenedor de 2 CPU pasa igual que el PC:** con 2 CPU de cuota, las ráfagas de login y el hilo principal caben en el periodo (21 ms/s de frenado).
- Disco y red no influyen en ningún entorno: %util promedio entre 2,7 y 4 %, iowait < 1 %.

### 2.3 Carga alta: 600 usuarios, 2 entradas por segundo, sesiones de 5 minutos

| | PC | Cont. 1 CPU | Cont. 2 CPU | AWS |
|---|---|---|---|---|
| Resultado | ✓ | ✕ (cortada a los 67 s) | ✕ | ✕ (cortada a los 94 s) |
| Hilo JS (promedio / pico) | **75 / 102 %** | 18 / 22 % | **93 / 103 %** | – |
| REST p95 / p99 | 60 / 186 ms | 14.491 ms | 2.791 / 5.653 ms | 13.398 ms |
| Trazo a los demás p99 | 49 ms | 654 ms | 680 ms | 218 ms |
| Ping p99 | 73 ms | 735 ms | 1.225 ms | 425 ms |
| CPU de la máquina | 18 % | 13 % | 25 % | **100 %** (93,5 us, 0 id) |
| Contenedor frenado | – | **4.131 ms/s** | 181 ms/s | – |
| RES del servidor (pico) | 300 MB | 250 MB | 303 MB | 267 MB |

**Qué explica la diferencia:**

- Esta prueba tiene el mismo ritmo de login que la media, pero 2,5 veces más usuarios conectados: **el costo nuevo es el tiempo real**. Los clientes reciben 59.000 mensajes por segundo. Cada uno es un `JSON.stringify` y un `socket.send` que hace el **único hilo de JavaScript**.
- **En el PC pasa al límite:** el hilo de JavaScript está al 75 % promedio y toca el 102 % en picos, y el ping p99 llega a 73 ms (el límite es 100). Mientras tanto la máquina tiene el 81 % de la CPU libre: ese trabajo no se puede repartir, porque Node ejecuta todo el JavaScript en un solo hilo.
- **El contenedor de 2 CPU falla con la misma carga que el PC pasa.** Su hilo de JavaScript sube al 93 % y además el kernel lo frena 181 ms por segundo. Con una utilización tan cerca de 1, cualquier pausa hace crecer la cola más rápido de lo que se vacía (teoría de colas: la espera crece como ρ/(1−ρ); con ρ = 0,93 la espera media es 13 veces el tiempo de servicio, con ρ = 0,75 es 3 veces). El REST p95 pasa de 60 ms a 2,8 s.
- **El contenedor de 1 CPU y AWS caen antes de medir:** la llegada de 600 usuarios en 120 s son 5 logins por segundo, más de lo que una CPU puede hashear mientras atiende el tiempo real. Los logins hacen fila hasta el tiempo límite de 15 s y el laboratorio corta la prueba por errores.
- La memoria no es el límite: el servidor usa como máximo 303 MB de los 512 MB del contenedor.

### 2.4 Server killer: 6.000 usuarios, 20 entradas por segundo

| | PC | Cont. 1 CPU | Cont. 2 CPU | AWS |
|---|---|---|---|---|
| Duró hasta el corte | 95 s | 26 s | 44 s | 26 s |
| Usuarios conectados al corte | 342 | 43 | 121 | 42 |
| Error dominante | `login:TIMEOUT` | `login:TIMEOUT` | `login:TIMEOUT` | `login:TIMEOUT` |
| libuv (threadpool) | **393 %** (4 hilos llenos) | 79 % | 155 % | — |
| CPU de la máquina idle | **57 %** | 88 % | 83 % | 9 % |
| Login dentro del servidor p50 | 735 ms | 581 ms | 680 ms | 860 ms |
| Login visto por el usuario p50 | 6.878 ms | 7.737 ms | 7.737 ms | 8.368 ms |

**Qué explica la diferencia:**

- En los cuatro entornos se rompe **lo mismo, el login**, y en el mismo orden: la fila de scrypt crece hasta que las peticiones superan los 15 s.
- **El PC muere con el 57 % de la CPU libre.** El threadpool de libuv tiene 4 hilos por defecto (`UV_THREADPOOL_SIZE=4`) y están al 393 %, es decir, llenos. Cada login ocupa un hilo ~135 ms, así que la capacidad máxima es de 4 / 0,135 ≈ **30 logins por segundo**. La llegada inicial de Server killer es de 50 por segundo: la fila crece 20 por segundo y nunca se vacía. Es un límite del **software** (el tamaño del pool), no del hardware.
- Dentro del servidor el login tarda 0,6 a 0,9 s, pero el usuario espera 7 a 8 s: la diferencia es el tiempo en la fila del threadpool y del *backlog* TCP, antes de que el cálculo empiece.
- En los contenedores y en AWS la fila crece antes porque hay menos CPU para el threadpool: con 1 CPU de cuota, los 4 hilos se reparten 100 ms por periodo.

---

## 3. Costo frente a capacidad

| Opción | Costo mensual | Carga más alta que pasa | Usuarios activos que sostiene | Costo por usuario activo al mes |
|---|---|---|---|---|
| PC nativo | ~17.600 COP de energía + amortización del equipo | **Alta** | 600 | Energía: ~29 COP |
| Contenedor 1 CPU (≈ Render Standard) | USD 25 | Baja | 120 | USD 0,21 |
| Contenedor 2 CPU (≈ Render Pro) | USD 85 | Media | 240 | USD 0,35 |
| AWS t3.small | USD 20,43 | Ninguna (la baja falló por 45 ms en el p95 del registro) | < 120 | — |

Lectura:

- El **PC** da la mayor capacidad porque tiene 4 núcleos físicos rápidos dedicados. No es una opción de producción: sin IP fija, sin disponibilidad 24/7, sin redundancia.
- La **t3.small** es la más barata, pero su CPU es un solo núcleo físico a 2,5 GHz y no alcanza para el costo del login a 1 entrada por segundo.
- **Doblar la cuota del contenedor dobla la capacidad** (de baja a media), pero no llega a la alta: ahí el límite es el hilo único de JavaScript, que no mejora con más CPU de cuota.

La recomendación y lo que se descartó están en [CONCLUSIONES.md](CONCLUSIONES.md).

---

## Fuentes de precios

- AWS EC2 On-Demand, us-east-1: [aws.amazon.com/ec2/pricing/on-demand](https://aws.amazon.com/ec2/pricing/on-demand/) (t3.small USD 0,0208/h, t3.micro USD 0,0104/h); también [DoIT](https://www.doit.com/compute/spot/us-east-1/t3.small) y [Holori](https://calculator.holori.com/aws/ec2/t3.small/us-east-1)
- AWS EBS gp3 (USD 0,08 por GB-mes): [aws.amazon.com/ebs/pricing](https://aws.amazon.com/ebs/pricing/)
- AWS IPv4 pública (USD 0,005 por hora): [AWS News Blog](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)
- Ancho de banda base de t3.small (0,128 Gbps): [AWS, instancias de uso general](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html#gp_network)
- Render: [render.com/docs/compute-plans](https://render.com/docs/compute-plans) (Standard USD 25, Pro USD 85)
- Tarifa de energía Enel Colombia, agosto de 2026: [pliego tarifario](https://www.enel.com.co/content/dam/enel-co/español/personas/1-17-1/2026/pliego%20tarifario%20digital%20_agosto_2026.pdf)
- Intel Core Ultra 5 125H (potencia base 28 W, caché 18 MB): [ark.intel.com](https://www.intel.com/content/www/us/en/products/sku/236847/intel-core-ultra-5-processor-125h-18m-cache-up-to-4-50-ghz/specifications.html)
