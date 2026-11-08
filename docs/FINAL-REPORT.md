# Informe final: rendimiento de Shareboard

## 1. Introducción

### Qué se hizo

**Shareboard** es una pizarra colaborativa en tiempo real. Varias personas abren el mismo tablero desde el navegador o el celular, dibujan, escriben y ven al instante los cursores y los trazos de los demás.

El proyecto responde a una pregunta práctica: **¿en qué máquina debería correr el servidor de Shareboard, cuántos usuarios aguanta cada opción y por qué?** Para responderla se ejecutó el mismo servidor, con los mismos datos y la misma carga, en cinco entornos: un PC, dos contenedores Docker con límites distintos y una instancia de AWS en dos modos de CPU. Se probaron siete niveles de carga, de 100 a 6.000 personas conectadas a la vez, en 75 corridas. En cada corrida se midió la CPU, la memoria, el disco, la red y la latencia, para saber no solo quién aguanta más, sino **qué recurso se agota primero y qué parte del computador lo causa**.

Con lo aprendido se optimizó el código del servidor y se repitió la campaña en el PC, en los dos contenedores y en AWS Unlimited. La sección 7 cuenta qué cambió y qué mejoró.

### El repositorio

Todo el trabajo está en el repositorio `shareboard_perf`, organizado así:

- **`servidor/`**: una copia del servidor real de Shareboard, el que se mide. Está escrito en TypeScript sobre Node.js, con Fastify para las peticiones REST, WebSocket para el tiempo real y MongoDB como base de datos.
- **`telemetry/`**: el laboratorio de medición. `lab.mjs` levanta una interfaz web en el puerto 7070 desde donde se prepara un entorno y se lanza una prueba. `vu-worker.mjs` simula a las personas, `agent.mjs` mide la máquina del servidor y `campana.mjs` corre una serie completa de pruebas sin intervención.
- **`envs/`** y **`setup/`**: la configuración de los contenedores Docker y el guion que prepara las instancias de AWS.
- **`resultados/`** y **`data/raw/`**: los datos crudos de cada corrida, segundo a segundo, en formato `ndjson`.
- **`docs/`**: este informe y los documentos de detalle: [CARGAS.md](CARGAS.md), [MEDICIONES.md](MEDICIONES.md), [COMPARACIONES.md](COMPARACIONES.md), [CONCLUSIONES.md](CONCLUSIONES.md) y [CAMBIOS-SERVIDOR.md](CAMBIOS-SERVIDOR.md).

### Cómo funciona el servidor, en lo que importa para el rendimiento

El servidor tiene dos canales. Por **REST** pasan las acciones puntuales: registrarse, iniciar sesión, listar tableros, crear uno y unirse a uno. Por **WebSocket** pasa el tiempo real: cada persona mantiene una conexión abierta por la que envía y recibe trazos, cursores, vistas previas y pings.

Cuatro decisiones de diseño explican casi todo lo que se midió:

1. **Un solo proceso de Node.** Node ejecuta todo el JavaScript de un proceso en **un solo hilo**. Cuando alguien dibuja, ese hilo recibe el mensaje y lo reenvía a cada persona del tablero, una por una. Más núcleos no aceleran ese trabajo; un núcleo más rápido sí.
2. **Los tableros activos viven en la memoria RAM.** Los cambios se guardan en MongoDB agrupados cada segundo. Por eso el tiempo real casi no toca el disco, pero la memoria crece con los tableros abiertos.
3. **Las contraseñas usan scrypt**, una función lenta a propósito para que adivinarlas cueste. Corre en el *threadpool* (un grupo de hilos auxiliares de Node), fuera del hilo principal.
4. **El PIN de un tablero usaba `scryptSync`**, la versión síncrona de scrypt, que sí corre en el hilo principal y lo congela mientras calcula.

## 2. Las cargas

### Cómo se comportan las personas simuladas

La carga intenta parecerse al uso real de una pizarra, no bombardear un solo endpoint. El generador simula **personas** organizadas en **salas**: grupos que comparten un tablero. Casi la mitad de las salas (45 %) son de una sola persona, el 30 % son parejas o tríos, el 18 % equipos de 4 a 8, el 5 % talleres de 10 a 15 y el 2 % clases de 25 a 35. Cada sala dura entre 15 y 50 minutos según su tamaño, y la sesión media de una persona es de unos 25 minutos. Cuando una sala cierra, se abre otra, así el número de usuarios se mantiene constante.

Las llegadas siguen un horario que **no depende de lo que tarde el servidor**: si el servidor se atasca, la gente sigue llegando, y el problema aparece en la latencia y en los errores en lugar de esconderse. A esto se le llama *modelo abierto*.

Al llegar, el 52 % de las personas ya tiene sesión guardada (la sesión dura 30 días), el 35 % entra como invitado con un enlace, el 12 % tiene que iniciar sesión y el 1 % crea una cuenta. Si una petición falla, la persona reintenta dos veces y se rinde. Dentro del tablero, cada persona alterna entre mirar, mover el cursor, dibujar, escribir, mover y borrar elementos, o irse a otra pestaña. Las frecuencias salen del cliente real: el cursor se envía cada 45 ms, la vista previa del trazo cada 33 ms y el ping cada 20 s.

Los porcentajes de salas, caminos y actividades son **supuestos de diseño**: no hay datos públicos de uso de este tipo de aplicación. Las frecuencias, en cambio, son las del código del cliente.

### Distribución de las peticiones

Casi todo el trabajo está en el tiempo real, no en REST. Con 300 usuarios, el servidor recibe unos 780 mensajes por segundo de los clientes y entrega miles, frente a menos de una petición REST por segundo. De esas pocas peticiones REST, el 54 % son listar tableros, el 36 % unirse a uno, el 6 % iniciar sesión, el 3 % crear un tablero y cerca del 0,5 % registrarse.

### Niveles, cantidades y tiempos

Todas las pruebas duran lo mismo: **120 s de llegada, 30 s de estabilización y 600 s de medición**, más una pausa de 60 s entre pruebas. Solo cuenta la ventana de 600 s. Antes de cada prueba se reinicia el servidor y se restaura la base de datos, con 1.500 cuentas y 2.000 tableros de tamaños variados.

| Prueba | Usuarios a la vez | Llegadas por minuto | Logins por minuto | Repeticiones | Representa |
|---|---|---|---|---|---|
| Baja | 100 | ~6 | ~0,8 | 3 | Una facultad o un colegio |
| Media | 300 | ~12-15 | ~1,6 | 3 | Una universidad mediana (la referencia) |
| Alta | 600 | ~24 | ~3 | 3 | Una universidad grande |
| Capacidad 1.000 | 1.000 | ~40 | ~5 | 1 | Buscar el límite |
| Capacidad 2.000 | 2.000 | ~80 | ~10 | 1 | Buscar el límite |
| Capacidad 3.000 | 3.000 | ~120 | ~15 | 1 | Buscar el límite |
| Server killer | 6.000 | ~240 | ~31 | 3 | La alta multiplicada por diez |

Las pruebas de capacidad tienen una sola repetición, así que indican el orden de los entornos, no un límite exacto.

### Cuándo una prueba «pasa»

Una prueba pasa si durante los 600 s medidos el p95 de REST queda bajo 300 ms, el p95 del login bajo 1 s, el p95 del trazo que ven los demás bajo 150 ms, el p99 del ping bajo 100 ms y los errores REST bajo el 1 %. Los umbrales siguen los límites de respuesta de Nielsen: 0,1 s se siente instantáneo y 1 s no interrumpe el pensamiento. Se usan percentiles y no promedios: el p95 es el tiempo que no supera el 95 % de las peticiones, y el p99 muestra lo que vive el 1 % más lento, que es donde aparecen los atascos.

### Cómo se mide

Un agente corre en la máquina del servidor, **fuera** del servidor, y cada segundo lee los archivos del kernel de Linux: `/proc/stat` para la CPU (total, por núcleo y por hilo), `VmRSS` para la memoria que el proceso usa de verdad, `/proc/diskstats` para el disco, `/proc/net/dev` para la red y, en los contenedores, `cpu.stat` del cgroup para saber cuánto los frena su límite. La latencia la mide el generador desde el lado del usuario. El generador corre en otros núcleos (en el PC) o en otra máquina (en AWS) para no competir con el servidor, y una prueba se invalida si el generador pasa del 85 % de ocupación. El máximo registrado fue 73 %.

## 3. Los entornos

**PC nativo.** Un portátil ASUS Zenbook 14 con Debian 13 y un Intel Core Ultra 5 125H. Ese procesador mezcla núcleos de rendimiento (P-cores), de eficiencia (E-cores) y de bajo consumo. El servidor y MongoDB se fijaron a los **4 P-cores**, con 2 hilos cada uno (8 hilos) y hasta **4,5 GHz**. El generador quedó en los E-cores. Tiene **15 GB de RAM** y un disco NVMe Micron 2550 de 512 GB. No tiene ningún límite artificial.

**Docker 1 CPU y Docker 2 CPU.** El mismo PC y los mismos P-cores, pero con el servidor dentro de un contenedor con un techo de **1 o 2 CPU de tiempo** y **512 MB de memoria sin swap**, como un plan pequeño de un PaaS. «1 CPU» no reserva un núcleo: el kernel le da al contenedor 100 ms de CPU cada 100 ms y, si los gasta antes, lo congela hasta el siguiente periodo. MongoDB también va limitado a 1 CPU y 1 GB.

**AWS Unlimited y AWS Limited.** Una instancia EC2 **t3.small** en us-east-1 con Ubuntu. Tiene 2 vCPU de un Intel Xeon Platinum 8259CL a **2,5 GHz de base**, pero esas 2 vCPU son los dos hilos de **un solo núcleo físico**. Tiene **1,9 GB de RAM** y un disco EBS gp3 de 20 GiB (3.000 IOPS y 125 MB/s de base), conectado por red. Su red es de «hasta 5 Gbps», con una base de 16 MB/s. La t3 es una instancia *burstable*: solo tiene garantizado ~20 % de la máquina, y por encima gasta créditos de CPU. En modo **Unlimited**, al acabarse los créditos sigue a toda velocidad y AWS cobra el excedente. En modo **Limited** (*standard*), AWS la recorta a su base. El generador corre en otra instancia (t3.micro) de la misma zona.

| | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| CPU para el servidor | 4 núcleos físicos, 8 hilos, hasta 4,5 GHz | Los mismos, con techo de 2 CPU | Los mismos, con techo de 1 CPU | 1 núcleo físico, 2 hilos, 2,5 GHz de base | Igual, con base de ~20 % |
| Memoria | 15 GB | 512 MB | 512 MB | 1,9 GB | 1,9 GB |
| Disco | NVMe local | NVMe local | NVMe local | EBS gp3 por red | EBS gp3 por red |
| Costo al mes | ~17.600 COP de energía, más la compra del equipo | USD 85 (Render Pro, sin base de datos) | USD 25 (Render Standard, sin base de datos) | USD 20,43 más el excedente de CPU | USD 20,43 |

El precio de AWS suma la instancia (USD 0,0208 la hora × 730 h = 15,18), el disco (20 GB × USD 0,08 = 1,60) y la IP pública (USD 0,005 la hora × 730 h = 3,65), con los precios On-Demand de us-east-1 consultados el 2 de noviembre de 2026. Los contenedores se compararon con los planes de Render de CPU parecida. La energía del PC usa la potencia base del procesador (28 W) y la tarifa de Enel Colombia; no se midió con un medidor.

Igual en todos: el mismo código, Node 22, MongoDB 7 en Docker, los mismos datos y la misma carga.

## 4. Resultados

Cada celda indica cuántas repeticiones pasaron sobre el total.

| Entorno | 100 | 300 | 600 | 1.000 | 2.000 | 3.000 | 6.000 |
|---|---|---|---|---|---|---|---|
| **PC** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✓ 1/1 | ✓ 1/1 | ✕ 0/3, sin caerse |
| **Docker 2 CPU** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✓ 1/1 | ✕ se cayó | ✕ se cayó 3/3 |
| **Docker 1 CPU** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✕ 0/1 | ✕ 0/1 | ✕ se cayó 3/3 |
| **AWS Unlimited** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✕ 0/1 | ✕ 0/1 | ✕ se cayó 3/3 |
| **AWS Limited** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3, gastando créditos | ✕ 0/1 | ✕ 0/1 | ✕ 0/1 | ✕ 0/3 |

Con 600 usuarios todos pasan, así que esa carga sirve para comparar cómo trabaja cada entorno con el mismo esfuerzo (medianas de 3 repeticiones):

| Con 600 usuarios | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| CPU de toda la máquina, promedio / pico | 7 % / 24 % | 9 % / 27 % | 9 % / 32 % | 30 % / 63 % | 27 % / 52 % |
| Hilo de JavaScript, promedio / pico | 18 % / 27 % | 22 % / 38 % | 22 % / 45 % | 45 % / 68 % | 42 % / 60 % |
| Memoria del servidor, promedio / pico | 248 / 283 MB | 232 / 249 MB | 244 / 263 MB | 232 / 257 MB | 229 / 265 MB |
| Disco, IOPS promedio y MB/s | 50 y 1,6 | 43 y 1,5 | 44 y 1,4 | 28 y 1,9 | 23 y 1,3 |
| Red, MB/s de salida | 7,8 | 5,6 | 6,1 | 4,8 | 4,7 |
| REST p50 / p95 / p99 | 3,1 / 30 / 32 ms | 3,5 / 30 / 33 ms | 3,5 / 31 / 35 ms | 7,2 / 51 / 57 ms | 6,4 / 26 / 57 ms |
| Ping p50 / p95 / p99 | 0,1 / 0,4 / 0,9 ms | 0,2 / 0,6 / 1,2 ms | 0,2 / 0,6 / 1,9 ms | 0,5 / 3,5 / 12 ms | 0,5 / 2,8 / 7,2 ms |
| Login p50 | 136 ms | 142 ms | 147 ms | 298 ms | 298 ms |

## 5. Respuestas por entorno

### PC nativo

**¿Aguanta la carga?** Sí, hasta 3.000 usuarios. Es el único que pasa todas las pruebas de capacidad. Con 6.000 falla, pero no se cae.

**¿Dónde espera?** En la **CPU**, y concretamente en **un solo núcleo**: el que ejecuta el hilo de JavaScript. Con 3.000 usuarios ese hilo va al 79 % mientras la máquina entera está al 17 %. Le sobran núcleos, pero el servidor no puede usarlos.

**¿Por qué ese número?** El costo de reenviar un mensaje es casi constante: unos **12,8 µs** de CPU por cada mensaje entregado, desde 600 hasta 3.000 usuarios. Con ese costo, el hilo llegaría al 100 % en unos 78.000 mensajes por segundo, que con esta mezcla de actividad son unos 3.600 usuarios. El PC llega lejos porque sus P-cores son los más rápidos medidos (4,5 GHz) y porque tiene 15 GB, así que la memoria nunca lo limita.

**¿Qué le sobra y qué le falta?** Le sobran núcleos, memoria (el servidor llegó a 816 MB en el peor caso), disco y red. Le falta lo que no se mide en una prueba: IP fija, disponibilidad las 24 horas y respaldo eléctrico.

**Si la carga se multiplica por diez:** el hilo se satura (99 %). El proceso sigue vivo, pero las peticiones esperan tanto en la fila que el 38 % llega al tiempo límite de 15 s. Entran unas 4.130 personas de 6.000, con un ping p99 de ~1 s.

### Docker 2 CPU

**¿Aguanta la carga?** Hasta 2.000 usuarios. Con 3.000 se cae a los 5,5 minutos.

**¿Dónde espera?** Primero en el hilo de JavaScript (75 % con 2.000), como el PC, y después en la **memoria**. Con 512 MB, V8, el motor de JavaScript de Node, limita su espacio de objetos (*heap*) a cerca de la mitad del contenedor. Cuando lo llena, el proceso muere con «heap limit», sin que el kernel intervenga.

**¿Por qué ese número?** Usa los mismos P-cores que el PC, así que con poca carga rinde casi igual. Lo que lo frena antes son los dos límites configurados: la cuota de CPU, que con 2 CPU casi no actúa (16 ms de freno por segundo con 2.000 usuarios), y los 512 MB.

**¿Qué le sobra y qué le falta?** Le sobra CPU: con 2.000 usuarios no la agota. Le falta memoria.

**Si la carga se multiplica por diez:** se cae entre los 55 y los 88 segundos por falta de heap.

**Costo:** el plan equivalente (Render Pro, 2 CPU y 4 GB) cuesta USD 85 al mes, sin contar la base de datos.

### Docker 1 CPU

**¿Aguanta la carga?** Hasta 1.000 usuarios. Con 2.000 falla solo por el p99 del ping (227 ms), sin errores REST.

**¿Dónde espera?** En la **cuota de CPU**, es decir, en el límite configurado, no en el hardware. Con 2.000 usuarios, el kernel congeló el contenedor 128 ms de cada segundo mientras la máquina estaba al 19 % de uso. Cada vez que el contenedor gasta sus 100 ms antes de tiempo, todo se detiene hasta el siguiente periodo, y los mensajes que llegan en ese hueco esperan. Por eso la mediana sigue baja (REST p50 de 6,4 ms) y solo el p99 lo delata.

**¿Qué le sobra y qué le falta?** Le sobra hardware: la máquina está casi libre. Le falta cuota de CPU y, con más carga, memoria.

**Si la carga se multiplica por diez:** se cae entre los 52 y los 77 segundos, por el heap de V8, igual que el de 2 CPU.

**Costo:** USD 25 al mes (Render Standard). Da la misma capacidad que la t3.small y cuesta más.

### AWS Unlimited

**¿Aguanta la carga?** Hasta 1.000 usuarios, sin margen: el hilo de JavaScript ya va al 74 %. Con 2.000 falla el 15,5 % de las peticiones.

**¿Dónde espera?** En la **CPU**. Con 2.000 usuarios el hilo va al 97 % y el ping p99 pasa de 53 ms a 1,05 s.

**¿Por qué ese número?** Cada mensaje cuesta unos **35 µs** de CPU, 2,7 veces más que en el PC, y cada login tarda 255-298 ms contra 136 ms. Hay dos razones de hardware. La primera es que el núcleo es más lento (2,5 GHz de base contra 4,5 GHz). La segunda es que las 2 vCPU son **un solo núcleo físico**: cuando Node, los hilos del login y MongoDB trabajan a la vez, compiten por las mismas unidades de ejecución y la misma caché. El login sirve de comparación limpia, porque siempre hace el mismo cálculo: scrypt recorre al azar 16 MB de memoria, un bloque que no cabe en la caché del núcleo, así que depende de la caché y de la RAM, y tarda unas 2 veces más.

La latencia sube de golpe cerca del límite por la **fila** del hilo. Cada mensaje espera a que el hilo termine lo que tiene delante. Por teoría de colas, esa espera crece como ρ / (1 − ρ), donde ρ es la fracción del tiempo que el hilo está ocupado: con ρ = 0,75 es 3 veces el tiempo de trabajo y con ρ = 0,97 es 32 veces.

**¿Qué le sobra y qué le falta?** Le sobran disco y red: el disco promedió menos de 100 IOPS de sus 3.000, y la red llegó a 15 MB/s de salida con 2.000 usuarios, cerca de su base de 16 MB/s, cuando el hilo ya estaba saturado. Le faltan CPU por núcleo y RAM.

**Si la carga se multiplica por diez:** primero se satura el hilo y después se acaba la RAM. El servidor (~690 MB) y MongoDB (~700 MB) agotan los 1,9 GB, y el kernel los mata entre los 7,7 y los 11,3 minutos. En una repetición mató primero a MongoDB.

**Costo:** USD 20,43 al mes, más el excedente de CPU si la carga se sostuviera todo el mes: unos USD 5 con 600 usuarios y unos USD 20 con 1.000. Es una estimación a USD 0,05 por vCPU-hora; una carga real tiene horas valle.

### AWS Limited

**¿Aguanta la carga?** 300 usuarios de forma sostenida. Pasó la de 600, pero gastando créditos acumulados en las pruebas anteriores. Con 1.000 falla el 80,5 % de las peticiones.

**¿Dónde espera?** En los **créditos de CPU**. Gana 24 créditos por hora, que equivalen a 0,4 vCPU, cerca del 20 % de la máquina. Cuando se acaban, AWS le retira el resto: el *steal* (tiempo que la máquina virtual quería CPU y el hipervisor no se la dio) sube a ~60 %, y la CPU útil queda en 16-19 %, justo su base.

**¿Por qué ese número?** Con 100 y 300 usuarios usa 6 % y 15 % de la máquina, por debajo de la base, y puede sostenerlos indefinidamente. Con 600 usa ~27 %, por encima. Por proyección lineal, sin haberlo medido, su límite sostenido estaría en unos 400-450 usuarios.

**¿Qué le sobra y qué le falta?** Le sobra todo excepto CPU sostenida.

**Si la carga se multiplica por diez:** no se cae, pero solo porque, con la CPU recortada, entran muchos menos usuarios (~1.370) y la memoria no alcanza a agotarse. Con un ping p99 de ~10 s no es utilizable.

**Costo:** USD 20,43 al mes, sin excedente.

## 6. Respuestas generales para la aplicación

### ¿Dónde está esperando Shareboard? ¿Por CPU, por disco o por red?

**Por CPU**, y en particular por **un solo núcleo**: el que ejecuta el hilo de JavaScript, que recibe y reenvía cada mensaje de tiempo real. La prueba está en los números. En el PC, con 3.000 usuarios, ese hilo va al 79 % con la máquina al 17 %. En AWS, el mismo trabajo cuesta 2,7 veces más porque el núcleo es más lento. Fuera de ese límite, cada entorno tiene el suyo: la cuota y el heap en los contenedores, la RAM en AWS Unlimited y los créditos en AWS Limited.

**El disco no es el límite.** Los tableros activos están en RAM y los cambios se guardan agrupados cada segundo. En todas las pruebas, fuera de una, el disco promedió menos de 130 IOPS y menos de 8 % de ocupación, con una espera de disco de 2 % o menos. La excepción es el server killer de AWS Unlimited, donde llega a 1.014 IOPS, pero cuando la máquina ya se está quedando sin RAM: es un síntoma, no la causa.

**La red tampoco**, aunque sería la siguiente. En AWS, con 2.000 usuarios, la salida llega a 15 MB/s, cerca de la base de 16 MB/s de la t3.small, pero ahí la CPU ya está saturada.

### ¿Por qué ese número y no otro? ¿Cómo se midió?

Cada número sale de una prueba sostenida de 600 s medida con el agente sobre los archivos del kernel, con los guiones y los datos crudos en el repositorio. Los límites de capacidad salen de dividir la CPU del hilo entre los mensajes que entrega por segundo: ese costo es casi constante, así que el techo de cada máquina es su velocidad por núcleo dividida entre el trabajo por mensaje. Ningún número de rendimiento viene de internet.

### ¿Qué componente del computador causa cada comportamiento?

- **La velocidad de un núcleo** decide la capacidad del tiempo real, porque Node ejecuta el JavaScript en un solo hilo. Por eso el PC, con núcleos de 4,5 GHz, aguanta 3 veces más que AWS.
- **La caché y la RAM** deciden cuánto tarda un login: scrypt recorre 16 MB al azar y cada lectura que no está en la caché va a la RAM.
- **El hyperthreading** de AWS hace que dos vCPU no sean dos núcleos: Node, los hilos de login y MongoDB compiten por el mismo núcleo físico.
- **Los límites del cgroup** en los contenedores congelan el proceso al gastar su cuota de CPU y lo matan al llenar su heap, aunque el hardware tenga recursos libres.
- **Los créditos de CPU** en AWS Limited recortan la máquina a su 20 % de base.
- **La parte secuencial** del trabajo, la que solo puede ejecutar un hilo, pone el techo final: para sostener 6.000 usuarios en el PC harían falta ~1,7 núcleos de JavaScript, y un proceso de Node solo usa uno.

### Si la carga se multiplicara por diez, ¿qué se rompería primero?

Server killer es exactamente eso: la carga alta (600) multiplicada por diez (6.000). En los contenedores se rompe primero la memoria, en poco más de un minuto. En AWS Unlimited se satura el hilo y después se acaba la RAM, a los 7,7-11,3 minutos. En AWS Limited se acaban los créditos en el minuto 2 o 3. En el PC se satura el hilo, sin caerse. En todos, lo que falla para el usuario es **entrar**: listar y unirse a un tablero llegan al tiempo límite de 15 s, porque sus peticiones esperan en la misma fila del hilo que el tiempo real.

### ¿Qué opción se descarta y por qué?

- **Docker 1 CPU**: falla con 2.000 usuarios con la máquina casi libre, por su cuota, y cuesta más que la t3.small (USD 25 contra USD 20,43) con la misma capacidad medida.
- **AWS Limited para más de 300 usuarios**: cuando se acaban los créditos pasa de funcionar a fallar casi todo. Sirve para la carga de referencia o para picos cortos.
- **El PC para producción**: es el más capaz, pero no tiene IP fija, disponibilidad 24/7 ni redundancia.

### Recomendación

Para la carga de referencia (300 usuarios), la opción más barata que la pasa es la **t3.small en modo Limited**, a USD 20,43 al mes: usa el 15 % de la máquina, por debajo de su base. Si se esperan 600 usuarios o picos, conviene la **t3.small Unlimited**, con un excedente estimado de hasta USD 5 al mes. Para 1.000 usuarios, con el código original, la t3.small Unlimited va sin margen. Por encima de 2.000, ninguna opción medida con un solo proceso de Node tiene margen por mucho tiempo: hay que cambiar el código.

## 7. Cambios en el servidor y mejoras visibles

### Qué se cambió

Las mediciones dijeron dónde atacar: el hilo de JavaScript. Un perfil del servidor con 3.000 usuarios mostró que el 46 % del tiempo de ese hilo se iba en **una llamada al kernel (`writev`) por cada mensaje y cada destinatario**. Cada llamada al kernel tiene un costo fijo: el procesador deja el programa, entra al kernel, copia los datos al socket y vuelve. En un tablero de 30 personas, un trazo eran 29 llamadas, y con cursores cada 45 ms y vistas previas cada 33 ms se juntaban miles por segundo.

Se hicieron cuatro cambios, con el servidor todavía en **un solo proceso de Node**:

1. **Escrituras agrupadas.** Si a una persona le llegan varios mensajes en la misma vuelta del *event loop* (el ciclo en el que Node atiende el trabajo pendiente), ahora se escriben con una sola llamada al kernel. Cuanta más carga hay, más mensajes caben en cada vuelta y más se ahorra.
2. **Serializar una vez.** Antes, cada mensaje se convertía a texto (`JSON.stringify`) una vez por destinatario; ahora una sola vez para todos.
3. **El PIN con HMAC.** El PIN del tablero ya no usa `scryptSync` en el hilo principal, sino un HMAC, una firma con una clave secreta del servidor que se calcula en microsegundos. Un hash lento no protege un PIN de 4 a 12 dígitos: lo protege el límite de intentos, y sin la clave secreta una base filtrada no se puede probar fuera de línea.
4. **Contraseñas con Argon2id** en lugar de scrypt, con los parámetros mínimos de OWASP, que lo pone como primera opción. Necesita Node 24.

La campaña se repitió con las mismas pruebas, los mismos datos y las mismas repeticiones: PC y Docker el 7 de noviembre, AWS Unlimited esa misma noche. Hubo un tropiezo en el camino: la primera versión del cambio esperaba 25 ms para juntar más mensajes, y eso sumó 25 ms a cada trazo en todos los entornos. Se corrigió para que no espere nada, y las cifras de esta sección son de la versión corregida.

### Qué mejoró

**El hilo de JavaScript trabaja menos con la misma carga.** En el PC, con 3.000 usuarios, bajó del 79 % al 63 %. En AWS Unlimited, con 1.000 usuarios, del 74 % al 51 %, y con 600 del 45 % al 31 %. AWS es donde más se nota, porque era el entorno donde cada mensaje costaba más.

**La latencia cerca del límite cae entre 5 y 15 veces.** Que el hilo trabaje un 15 o 20 % menos no explicaría por sí solo una mejora tan grande. La razón es la fila: cerca del 100 % la espera crece muy rápido, y bajar de 97 % a 90 %, o de 79 % a 63 %, aleja al servidor de ese borde.

**En EC2 la t3.small dejó de rechazar a la gente.** Con 2.000 usuarios, los errores REST bajaron del 15,5 % a 0 %, y entrar a un tablero pasó de 15 s a 131 ms. Con 3.000, los errores bajaron del 50,9 % a 0 % y lograron conectarse 2.888 personas, contra 2.119.

**El login es 5 veces más rápido** en todos los entornos: de 136-166 ms a 23-26 ms en el PC y en Docker, y de 255-408 ms a 49-57 ms en AWS. Argon2id da una protección equivalente según OWASP. La explicación probable de que cueste menos, sin aislarla, es que recorre su memoria por bloques grandes y de forma más predecible, y el procesador puede adelantar las lecturas en vez de esperarlas una por una.

**Desapareció el escalón de 30 ms en REST.** Con poca carga, el p95 de REST tenía un escalón fijo de ~30 ms: era el PIN congelando el hilo. En el PC bajó de 30 ms a 6-7 ms.

**Docker 1 CPU ahora pasa la prueba de 2.000 usuarios**, que antes fallaba por el freno de su cuota.

| Antes → después | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited |
|---|---|---|---|---|
| Carga más alta que pasa | 3.000 → 3.000, con el hilo al 63 % | 2.000 → 2.000 | 1.000 → **2.000** | 1.000 → 1.000, con el hilo al 51 %; 2.000 sin errores |
| Hilo JS con 2.000 usuarios | 51 % → 40 % | 75 % → 63 % | 69 % → 59 % | 97 % → 90 % |
| Ping p99 con 2.000 | 5,9 → 1,6 ms | 65 → 14 ms | 227 → 92 ms | 1.047 → 147 ms |
| Trazo a los demás p95 con 2.000 | 2,4 → 1,3 ms | 16 → 5 ms | 70 → 33 ms | 459 → 51 ms |
| Login p50 con 600 | 136 → 24 ms | 142 → 25 ms | 147 → 24 ms | 298 → 53 ms |
| Con 3.000 usuarios | Pasa → pasa | Se cayó → se detuvo por memoria | 63 % de errores → se detuvo por memoria | 50,9 % de errores → **0 %** |

Los datos crudos están en `data/raw/` (PC y Docker, desde el 7 de noviembre a las 09:53) y en `resultados/2026-11-07/aws-unlimited/`. El detalle de cada cambio está en [CAMBIOS-SERVIDOR.md](CAMBIOS-SERVIDOR.md) y todas las cifras en [MEJORAS.md](MEJORAS.md).

## 8. Dónde falla ahora y qué falta

**La memoria es el nuevo primer límite.** El servidor optimizado usa entre 30 % y 80 % más memoria: en el PC, con 3.000 usuarios, pasó de 529 a 944 MB, y en AWS de 550 a 651 MB. En los contenedores de 512 MB esto ahora llega antes que el límite de CPU. Con 3.000 usuarios el contenedor pasa del 95 % de su memoria a los ~4 minutos y el laboratorio detiene la prueba, cuando el hilo todavía iba al 79 %. En server killer pasa a los 50-70 segundos, como antes. En AWS, con server killer, la RAM se acaba a los ~3,3 minutos en lugar de 7,7-11,3, porque cada persona cuesta menos CPU, entra más gente más rápido y cada una ocupa más memoria. La causa de la memoria extra **no está confirmada**. Hay tres sospechosos sin aislar: Node 24, que maneja el heap distinto que Node 22; Argon2id, que reserva 19 MiB por cada login en curso; y las colas de mensajes por persona. Es lo siguiente que hay que investigar, y lo primero que conviene probar son contenedores de 1 GB o un tope de heap ajustado (`--max-old-space-size`).

**El PC sigue sin poder con 6.000 usuarios.** Ahora entran 5.292 personas, contra 4.127, con un ping p99 de 85 ms en lugar de ~1 s, pero el hilo sigue al 99,8 % y el 29-37 % de las peticiones REST llega al tiempo límite. Es el techo de la parte secuencial: un solo hilo de JavaScript no da para tanto. El servidor ya puede repartir los tableros entre varios procesos de Node (`WORKERS`), pero ese modo no se midió en esta campaña.

**Con poca carga hay un costo pequeño.** Con 100 usuarios, el trazo a los demás tarda 0,2-0,4 ms más y la CPU del servidor sube un poco (de 4,1 % a 5,4 % en el PC). A esa carga casi nunca hay dos mensajes para la misma persona en una vuelta, así que agrupar no ahorra nada y solo agrega la gestión de la cola. Nadie lo nota.

**Entrar a un tablero con PIN sigue en ~31 ms con poca carga**, pero es un efecto de la prueba: la base se restaura antes de cada corrida con los PIN guardados al estilo antiguo, y la primera entrada a cada tablero todavía los verifica con scrypt antes de reescribirlos como HMAC. En uso real eso pasa una sola vez por tablero.

**Falta medir AWS Limited con el código nuevo.** La repetición no tuvo CPU retirada (*steal* ≈1 %, contra 54-71 % en la original): la instancia no se quedó sin créditos y se comportó como Unlimited, así que no se usó. Hay que repetirla en modo Standard con los créditos agotados. Mientras tanto, la recomendación para Limited sigue con los datos del código original.

**Node también cambió**, de la versión 22 a la 24, junto con el código, así que parte de las diferencias puede venir de ahí.
