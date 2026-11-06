# Comparaciones: PC, contenedores y nube

Campaña del 4 al 6 de noviembre de 2026 con el [modelo de carga actual](CARGAS.md). Los cinco entornos se evaluaron con **las mismas cargas, el mismo código, los mismos datos y las mismas métricas** ([MEDICIONES.md](MEDICIONES.md)). Este documento explica, carga por carga, por qué dan resultados distintos y compara su costo. El resumen para leer de corrido está en [FINAL-REPORT.md](FINAL-REPORT.md).

Baja, media, alta y killer tienen 3 repeticiones (mediana); las cargas de 1.000, 2.000 y 3.000 tienen 1.

---

## 1. Fichas técnicas y precios

| | PC nativo | Contenedor 1 CPU | Contenedor 2 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| Procesador | Intel Core Ultra 5 125H (2023): 4 P-cores + 8 E-cores + 2 LP-cores, 18 hilos | El mismo | El mismo | Intel Xeon Platinum 8259CL, 2,5 GHz de base | El mismo tipo |
| Núcleos del servidor | P-cores 0-7: **4 núcleos físicos con 2 hilos cada uno**, hasta 4,5 GHz | Los mismos, con cuota de **1 CPU** de tiempo | Los mismos, con cuota de **2 CPU** de tiempo | **2 vCPU = 1 núcleo físico con 2 hilos** | Igual |
| Modelo de CPU | Dedicada | Cuota CFS: 100 ms cada 100 ms; si la gasta, el kernel lo frena | Igual, 200 ms cada 100 ms | *Burstable*: puede usar el 100 % y paga el excedente | *Burstable*: base de 20 % por vCPU (~20 % de la máquina); por encima gasta créditos y, sin ellos, AWS la recorta |
| Memoria | 15 GB | 512 MB (límite) | 512 MB (límite) | 1,9 GB | 1,9 GB |
| MongoDB | Docker, sin límite | Docker, 1 CPU y 1 GB | Docker, 1 CPU y 1 GB | Docker, sin límite | Docker, sin límite |
| Disco | NVMe Micron 2550, 512 GB | El mismo | El mismo | EBS gp3: 3.000 IOPS y 125 MB/s de base, por red | Igual |
| Red | Local | Local, por el puente de Docker | Igual | "Hasta 5 Gbps": 0,128 Gbps (16 MB/s) de base con ráfagas | Igual |
| **Precio** | Compra del portátil: ________ COP (a 36 meses: ________ COP/mes) + energía ≈ **17.600 COP/mes** (28 W × 730 h × 863,6 COP/kWh) | Plan equivalente: Render Standard (1 CPU, 2 GB) **USD 25/mes** | Render Pro (2 CPU, 4 GB) **USD 85/mes** | **USD 20,43/mes** + excedente de CPU | **USD 20,43/mes**: instancia 15,18 (0,0208 × 730 h) + disco 1,60 (20 GB × 0,08) + IPv4 3,65 (0,005 × 730 h) |

Notas de precio:

- AWS On-Demand, us-east-1, consultado el 2 de noviembre de 2026. El generador (t3.micro, USD 0,0104/h) solo existe para medir y no cuenta.
- Energía: tarifa de Enel Colombia, estrato 4, agosto de 2026. La potencia del PC **no se midió**: 28 W es la potencia base según Intel. El PC tampoco incluye IP pública, disponibilidad 24/7 ni respaldo eléctrico.
- Render no incluye la base de datos: MongoDB se pagaría aparte.

---

## 2. Carga por carga

### 2.1 Baja, media y alta: 100, 300 y 600 usuarios

Los cinco entornos pasan todas las repeticiones (45 de 45).

| Con 600 usuarios | PC | Cont. 1 CPU | Cont. 2 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| Conectados | 577 | 574 | 581 | 580 | 582 |
| REST p50, usuario / servidor | 3,2 / 2,0 ms | 3,6 / 2,1 ms | 3,6 / 2,1 ms | 7,2 / 4,7 ms | 6,4 / 4,2 ms |
| Login p50, servidor | 136 ms | 147 ms | 142 ms | 298 ms | 298 ms |
| Ping p50 / p99 | 0,12 / 0,9 ms | 0,17 / 1,9 ms | 0,17 / 1,2 ms | 0,52 / 12 ms | 0,50 / 7,2 ms |
| Hilo JS | 18 % | 22 % | 22 % | 45 % | 42 % |
| CPU de JS por mensaje entregado | 12,8 µs | 17,1 µs | 17,5 µs | 35 µs | 32 µs |
| Contenedor frenado | – | 7 ms/s | 0 ms/s | – | – |
| Steal | 0 % | 0 % | 0 % | 0,3 % | 0,3 % |

**Qué explica la diferencia:**

- **AWS gasta unas 2,5-2,7 veces más CPU por el mismo trabajo.** El login, que siempre hace el mismo cálculo scrypt, cuesta 136 ms en el PC y 298 ms en AWS. El hilo de JavaScript hace el mismo trabajo y sube de 18 % a 45 %.
- **La red casi no explica nada:** el ping p50 en AWS es de 0,5 ms frente a 0,1-0,2 ms locales. La diferencia en REST viene principalmente de la CPU, como muestra la columna "servidor".
- **Docker es casi igual al PC.** Con el mismo procesador, su hilo de JS cuesta algo más por mensaje, probablemente por la red del contenedor. No se aisló esa causa.
- **Limited y Unlimited son iguales aquí, pero por razones distintas según la carga.** Con 100 y 300 usuarios (6 % y 15 % de la máquina), Limited está por debajo de su base de 20 %. Con 600 (27 %) está por encima y pasa gastando los créditos que ganó en las pruebas anteriores: el resultado no demuestra que los sostenga indefinidamente.

### 2.2 Capacidad: 1.000, 2.000 y 3.000 usuarios

| | PC | Cont. 1 CPU | Cont. 2 CPU | AWS Unlimited | AWS Limited (sin créditos) |
|---|---|---|---|---|---|
| **1.000**: resultado | ✓ | ✓ | ✓ | ✓ | ✕ |
| Conectados / hilo JS | 960 / 29 % | 959 / 33 % | 963 / 33 % | 976 / 74 % | 628 / 90 % |
| Ping p99 / errores | 2,1 ms / 0 % | 22 ms / 0 % | 2,6 ms / 0 % | 53 ms / 0 % | 3,7 s / 80,5 % |
| **2.000**: resultado | ✓ | ✕ | ✓ | ✕ | ✕ |
| Conectados / hilo JS | 1.921 / 51 % | 1.901 / 69 % | 1.856 / 75 % | 1.879 / 97 % | 746 / 86 % |
| Ping p99 / errores | 5,9 ms / 0 % | 227 ms / 0 % | 65 ms / 0 % | 1,05 s / 15,5 % | 2,9 s / ~100 % |
| **3.000**: resultado | ✓ | ✕ | ✕ cayó a los 332 s | ✕ | ✕ |
| Conectados / hilo JS | 2.825 / 79 % | 2.427 / 84 % | – | 2.119 / 96 % | 673 / 79 % |
| Ping p99 / errores | 47 ms / 0 % | 1,2 s / 63,4 % | – | 1,43 s / 50,9 % | 2,6 s / ~100 % |

**Qué explica la diferencia:**

- **La capacidad sigue la velocidad del hilo de JavaScript.** Con el hilo cerca del 75-80 %, el PC atiende 2.825 usuarios, el contenedor de 2 CPU 1.856 y AWS Unlimited 976.
- **El contenedor de 1 CPU falla con 2.000 por la cuota, no por falta de hardware.** La máquina está al 19 % de uso, sin errores REST. El kernel lo frena 128 ms por segundo y el ping p99 sube a 227 ms. Con 2 CPU, el freno baja a 16 ms/s y la misma carga pasa.
- **El contenedor de 2 CPU cae con 3.000 por memoria.** Con 512 MB, V8 limita su heap a cerca de la mitad del contenedor. AWS Unlimited no cae en esa carga porque no tiene ese límite, aunque ya está saturado de CPU.
- **Limited sin créditos no llega ni a 1.000.** Con steal de 60-71 %, la CPU útil queda en 16-19 % de la máquina. Se estabiliza en ~630-750 conectados, pero con casi todas las peticiones fallando, así que esa cifra **no** es su capacidad sostenida. Por proyección lineal desde los ~27 % que usa con 600 usuarios, estaría en unos 400-450; no se midió.

### 2.3 Server killer: 6.000 usuarios

| | PC | Cont. 1 CPU | Cont. 2 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| Se cayó | **0/3** | 3/3 | 3/3 | 3/3 | **0/3** |
| Momento | – | 52-77 s | 55-88 s | 464-680 s | – |
| Causa | Hilo JS saturado | Heap de V8 con 512 MB | Heap de V8 con 512 MB | OOM del kernel, RAM de la máquina | CPU recortada |
| Conectados | ~4.130 | – | – | 1.240-2.240 | ~1.370 |
| Hilo JS | 99 % | – | – | 86-92 % antes de caer | 89 % |
| Memoria del servidor (pico) | 816 MB | – | – | ~690-750 MB | 590-660 MB |
| Ping p99 | ~1 s | – | – | 1,1-5,2 s | ~10,6 s |
| Steal | 0 % | – | – | ~0,1 % | ~60 % |

**Qué explica la diferencia:**

- **Cada entorno se rompe por algo distinto.** El PC agota el hilo, los contenedores el heap, AWS Unlimited la RAM y AWS Limited los créditos.
- **El PC no cae porque no tiene tope de memoria cercano** (15 GB), pero tampoco atiende a todos: 38 % de errores REST, sobre todo al unirse y listar por tiempo de espera.
- **AWS Unlimited** sostiene mejor el tiempo real que Limited, pero se queda sin RAM: servidor ~690 MB + MongoDB ~700 MB de 1,9 GB. En una repetición el kernel mató primero a MongoDB, que Docker reinició en unos 2 s, y el servidor cayó después.
- **AWS Limited no cae, pero no es utilizable.** El recorte llega en el minuto 2-3 y limita a la gente que entra, así que la memoria se queda por debajo de lo que mata a Unlimited. Es una explicación coherente con los datos, no un mecanismo probado por separado.

---

## 3. Costo frente a capacidad

| Opción | Costo mensual | Carga más alta que pasa | Costo por usuario activo al mes |
|---|---|---|---|
| PC nativo | ~17.600 COP de energía + amortización | 3.000 | Energía: ~6 COP |
| Contenedor 2 CPU (≈ Render Pro) | USD 85 | 2.000 | USD 0,04 |
| Contenedor 1 CPU (≈ Render Standard) | USD 25 | 1.000 | USD 0,03 |
| AWS Unlimited | USD 20,43 + excedente | 1.000 | ~USD 0,02-0,04 |
| AWS Limited | USD 20,43 | 300 sostenidos (600 con créditos) | USD 0,07 |

El excedente de Unlimited es una **estimación** con USD 0,05 por vCPU-hora, usando la CPU medida por encima de la base de 0,4 vCPU, si esa carga durara las 730 horas del mes:

- Con 600 usuarios: (0,54 − 0,40) × 0,05 × 730 ≈ USD 5/mes.
- Con 1.000 usuarios: (0,96 − 0,40) × 0,05 × 730 ≈ USD 20/mes.

Una carga real tiene horas valle, así que el excedente sería menor. Limited con reserva de créditos también podría absorber picos cortos (acumula hasta 576 créditos).

Lectura:

- **El PC** tiene la mayor capacidad, pero no es una opción de producción: sin IP fija, disponibilidad 24/7 ni redundancia.
- **La t3.small es la opción más económica y sostiene la carga de referencia de 300 usuarios.** Para esa carga, Limited basta.
- **Doblar la cuota del contenedor dobla la capacidad** (de 1.000 a 2.000), pero un mes cuesta más del triple según los planes comparados.

La recomendación y lo que se descartó están en [CONCLUSIONES.md](CONCLUSIONES.md).

---

## Fuentes

- AWS EC2 On-Demand, us-east-1: [aws.amazon.com/ec2/pricing/on-demand](https://aws.amazon.com/ec2/pricing/on-demand/) (t3.small USD 0,0208/h, t3.micro USD 0,0104/h)
- Créditos de CPU y modo Unlimited: [AWS, instancias de rendimiento ampliable](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode.html), [conceptos de créditos](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html)
- AWS EBS gp3 (USD 0,08 por GB-mes): [aws.amazon.com/ebs/pricing](https://aws.amazon.com/ebs/pricing/)
- AWS IPv4 pública (USD 0,005 por hora): [AWS News Blog](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)
- Ancho de banda base de t3.small (0,128 Gbps): [AWS, instancias de uso general](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html#gp_network)
- Render: [render.com/docs/compute-plans](https://render.com/docs/compute-plans) (Standard USD 25, Pro USD 85)
- Tarifa de energía Enel Colombia, agosto de 2026: [pliego tarifario](https://www.enel.com.co/content/dam/enel-co/español/personas/1-17-1/2026/pliego%20tarifario%20digital%20_agosto_2026.pdf)
- Intel Core Ultra 5 125H (potencia base 28 W): [ark.intel.com](https://www.intel.com/content/www/us/en/products/sku/236847/intel-core-ultra-5-processor-125h-18m-cache-up-to-4-50-ghz/specifications.html)
