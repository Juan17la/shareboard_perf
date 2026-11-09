# Informe final: rendimiento de Shareboard

## 1. Introducción

**Shareboard** es una pizarra colaborativa en tiempo real: varias personas abren el mismo tablero y ven al instante los trazos y cursores de los demás.

El proyecto responde una pregunta práctica: **¿en qué máquina conviene correr el servidor, cuántos usuarios aguanta cada opción y por qué?** Se ejecutó el mismo servidor, con los mismos datos y la misma carga, en cinco entornos:

- un PC;
- dos contenedores Docker;
- una instancia de AWS en dos modos.

Hubo siete niveles de carga, de 100 a 6.000 personas a la vez, en 75 corridas. En cada una se midieron CPU, memoria, disco, red y tiempos de respuesta. Así se sabe quién aguanta más y también **qué se agota primero y por qué**. Con lo aprendido se mejoró el código y se repitió la campaña (sección 7).

**El repositorio** (`shareboard_perf`) tiene:

- `servidor/`: el servidor medido, en Node.js con MongoDB.
- `telemetry/`: el laboratorio. Una página web para lanzar pruebas, el simulador de usuarios, el medidor de la máquina y un guion que corre la campaña completa sin intervención.
- `envs/` y `setup/`: la configuración de Docker y de AWS.
- `resultados/` y `data/raw/`: los datos crudos, segundo a segundo.
- `docs/`: este informe y los documentos de detalle ([CARGAS](CARGAS.md), [MEDICIONES](MEDICIONES.md), [COMPARACIONES](COMPARACIONES.md), [CAMBIOS-SERVIDOR](CAMBIOS-SERVIDOR.md), [MEJORAS](MEJORAS.md)).

**Lo que hay que saber del servidor.** Tiene dos canales:

- **REST**, para las acciones puntuales: iniciar sesión, listar tableros, unirse a uno.
- **WebSocket**, una conexión abierta por persona por donde viajan trazos, cursores y pings.

Hay un detalle que explica casi todo el informe: Node ejecuta el código en **un solo hilo**. Cuando alguien dibuja, ese hilo reenvía el trazo a cada persona del tablero, una por una. Por eso **más núcleos no ayudan; un núcleo más rápido sí**. Los tableros abiertos viven en la memoria y se guardan en la base de datos cada segundo, así que el disco casi no trabaja.

## 2. Las cargas

El simulador imita personas reales, no un bombardeo a una sola dirección. Las personas llegan en **salas** que comparten tablero:

| Tamaño de la sala | Parte de las salas |
|---|---|
| Una persona | 45 % |
| Parejas o tríos | 30 % |
| Equipos de 4 a 8 | 18 % |
| Talleres de 10 a 15 | 5 % |
| Clases de 25 a 35 | 2 % |

Una sala dura de 15 a 50 minutos. Cuando una cierra se abre otra, y así el número de usuarios se mantiene. La gente llega a su hora aunque el servidor esté lento, así que un atasco se ve en los tiempos y en los errores, no se esconde.

Al llegar, la gente entra de cuatro formas:

- el 52 % ya tiene la sesión abierta;
- el 35 % entra como invitado con un enlace;
- el 12 % inicia sesión;
- el 1 % crea una cuenta.

Dentro del tablero, cada persona mira, mueve el cursor, dibuja, escribe o se va a otra pestaña. El cursor se envía cada 45 ms, la vista previa del trazo cada 33 ms y un ping cada 20 s, igual que en la aplicación real. Los porcentajes de salas y actividades son supuestos de diseño; las frecuencias salen del código.

**Casi todo el trabajo es tiempo real.** Con 300 usuarios llegan unos 780 mensajes por segundo y el servidor entrega miles, frente a menos de una petición REST por segundo. De esas peticiones REST:

- el 54 % lista tableros;
- el 36 % se une a uno;
- el 6 % inicia sesión;
- el 3 % crea un tablero;
- el 0,5 % crea una cuenta.

**Tiempos.** Cada prueba tiene 2 minutos de llegada y 30 s para estabilizarse. Después vienen **10 minutos medidos**, y luego una pausa de 1 minuto. Antes de cada prueba se reinicia el servidor y se restaura la base de datos (1.500 cuentas y 2.000 tableros).

| Prueba | Usuarios a la vez | Llegadas por minuto | Repeticiones | Representa |
|---|---|---|---|---|
| Baja | 100 | ~6 | 3 | Un colegio |
| Media | 300 | ~13 | 3 | Una universidad mediana (la referencia) |
| Alta | 600 | ~24 | 3 | Una universidad grande |
| Capacidad | 1.000 / 2.000 / 3.000 | 40 / 80 / 120 | 1 | Buscar el límite |
| Server killer | 6.000 | ~240 | 3 | La alta multiplicada por diez |

**Cuándo una prueba pasa:** el 95 % de las peticiones REST responde en menos de 0,3 s, el login en menos de 1 s y los trazos llegan a los demás en menos de 0,15 s. Además, el 99 % de los pings vuelve en menos de 0,1 s y fallan menos del 1 % de las peticiones. Son los tiempos en que una respuesta se siente instantánea. Se mira el 95 % o el 99 %, y no el promedio, porque los atascos aparecen en las respuestas más lentas. En el resto del documento, «p95» significa «el 95 % tarda menos que esto».

**Cómo se mide.** Un medidor lee cada segundo, desde el sistema operativo, la CPU, la memoria, el disco y la red del servidor. El simulador mide los tiempos desde el lado del usuario. Además, corre en otros núcleos o en otra máquina para no robarle CPU al servidor.

## 3. Los entornos

**PC.** Un portátil ASUS Zenbook 14 con un Intel Core Ultra 5 125H. El servidor y la base de datos usan sus **4 núcleos rápidos** (8 hilos, hasta **4,5 GHz**), y el simulador va en los núcleos de bajo consumo. Tiene **15 GB de RAM** y un disco NVMe local.

**Docker 1 CPU y 2 CPU.** El mismo PC, pero con el servidor dentro de un contenedor limitado a **1 o 2 CPU** y **512 MB de memoria**, como un plan pequeño en la nube. El límite funciona por turnos: si el contenedor gasta su CPU antes de tiempo, queda congelado hasta el siguiente turno, aunque la máquina esté libre.

**AWS t3.small, en modo Unlimited y Limited.** Un servidor en la nube con **un solo núcleo físico** (2 hilos) de un Xeon a **2,5 GHz**, **1,9 GB de RAM** y un disco por red. La t3 solo tiene garantizado ~20 % de la CPU, y por encima gasta créditos. En **Unlimited**, cuando se acaban los créditos sigue a toda velocidad y cobra el extra. En **Limited**, la frena a ese 20 %.

| | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| CPU | 4 núcleos, 4,5 GHz | Los mismos, techo de 2 | Los mismos, techo de 1 | 1 núcleo, 2,5 GHz | Igual, frenada al 20 % |
| Memoria | 15 GB | 512 MB | 512 MB | 1,9 GB | 1,9 GB |
| Lo más parecido en AWS | c7i.2xlarge (4 núcleos, 16 GB) | Fargate 2 vCPU, 4 GB | Fargate 1 vCPU, 2 GB | t3.small | t3.small |
| Costo al mes | **USD 265,86** en AWS (en casa, ~17.600 COP de luz) | **USD 75,73** | **USD 39,69** | **USD 20,43** + extra de CPU | **USD 20,43** |

**Cómo se calculó el costo.** A cada entorno se le buscó lo más parecido que alquila AWS, con precios de Virginia del 8 de noviembre de 2026 y meses de 730 horas.

- **PC:** AWS no alquila procesadores de portátil. Lo más parecido es la **c7i.2xlarge**, con 4 núcleos de un Intel de servidor de 2023 y 16 GB. Cuesta 13 veces la t3.small, y aun así cada núcleo es más lento que el del portátil (3,2 GHz contra 4,5 GHz). Una con núcleos más rápidos (r7iz, 3,9 GHz) costaría unos USD 548. En casa, el PC solo gasta luz, estimada sin medidor.
- **Contenedores:** el servicio de AWS equivalente es **Fargate**, que no deja pedir menos de 2 GB con 1 CPU ni menos de 4 GB con 2 CPU. Allí rendirían algo menos que en el PC, porque sus núcleos son más lentos.
- **t3.small:** la instancia (15,18), el disco (1,60) y la IP pública (3,65).

Ningún precio incluye la base de datos. Los de c7i y r7iz vienen de agregadores que copian la lista de AWS ([DoiT](https://www.doit.com/compute/spot/us-east-1/c7i.2xlarge), [Holori](https://calculator.holori.com/aws/ec2/r7iz.xlarge/us-east-1)), y los de Fargate de [AWS](https://aws.amazon.com/fargate/pricing/).

En todos los entornos se usó el mismo código, Node 22, MongoDB 7, los mismos datos y la misma carga.

## 4. Resultados

Cuántas repeticiones pasaron, con el código original:

| Entorno | 100 | 300 | 600 | 1.000 | 2.000 | 3.000 | 6.000 |
|---|---|---|---|---|---|---|---|
| **PC** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✓ | ✓ | ✕, sin caerse |
| **Docker 2 CPU** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✓ | ✕ se cayó | ✕ se cayó |
| **Docker 1 CPU** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✕ | ✕ | ✕ se cayó |
| **AWS Unlimited** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ | ✕ | ✕ | ✕ se cayó |
| **AWS Limited** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3, gastando créditos | ✕ | ✕ | ✕ | ✕ |

Con 600 usuarios todos pasan, así que sirve para ver cómo trabaja cada uno con el mismo esfuerzo:

| Con 600 usuarios | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| CPU de la máquina, promedio / pico | 7 / 24 % | 9 / 27 % | 9 / 32 % | 30 / 63 % | 27 / 52 % |
| Núcleo del servidor ocupado | 18 % | 22 % | 22 % | 45 % | 42 % |
| Memoria del servidor | 248 MB | 232 MB | 244 MB | 232 MB | 229 MB |
| Disco (operaciones por segundo) | 50 | 43 | 44 | 28 | 23 |
| Red de salida | 7,8 MB/s | 5,6 MB/s | 6,1 MB/s | 4,8 MB/s | 4,7 MB/s |
| REST: mitad / 95 % / 99 % | 3 / 30 / 32 ms | 4 / 30 / 33 ms | 4 / 31 / 35 ms | 7 / 51 / 57 ms | 6 / 26 / 57 ms |
| Ping: 95 % / 99 % | 0,4 / 0,9 ms | 0,6 / 1,2 ms | 0,6 / 1,9 ms | 3,5 / 12 ms | 2,8 / 7,2 ms |
| Login (la mitad tarda menos de) | 136 ms | 142 ms | 147 ms | 298 ms | 298 ms |

AWS usa más del doble del núcleo que el PC para el mismo trabajo. El disco y la red están lejos de cualquier límite en todos los entornos.

## 5. Respuestas por entorno

### PC

- **¿Aguanta?** Hasta 3.000 usuarios. Es el único que pasa todas las pruebas de capacidad. Con 6.000 falla, pero no se cae.
- **¿Dónde espera?** En **un solo núcleo**, el que corre el servidor. Con 3.000 usuarios ese núcleo va al 79 % mientras la máquina entera está al 17 %.
- **¿Por qué ese número?** Reenviar cada mensaje cuesta casi siempre lo mismo. Con ese costo, el núcleo se llenaría hacia los 3.600 usuarios. El PC llega lejos porque sus núcleos son los más rápidos medidos.
- **¿Qué sobra y qué falta?** Le sobran núcleos, memoria, disco y red. Le falta lo que una prueba no mide: IP fija, estar encendido las 24 horas y respaldo eléctrico.
- **Con 10 veces la carga:** el núcleo llega al 99 %. Entran unas 4.100 de 6.000 personas, y el 38 % de las peticiones se queda esperando hasta el límite de 15 s.
- **Costo:** ~17.600 COP de luz al mes en casa, o USD 265,86 por algo parecido en AWS. Para este servidor, pagar por más núcleos no compra capacidad: la compra un núcleo más rápido.

### Docker 2 CPU

- **¿Aguanta?** Hasta 2.000 usuarios. Con 3.000 se cae a los 5,5 minutos.
- **¿Dónde espera?** Primero en el núcleo, como el PC, y después en la **memoria**: con 512 MB, el servidor se queda sin espacio y se cierra.
- **¿Por qué ese número?** Usa los mismos núcleos que el PC, así que con poca carga rinde igual. Lo frenan antes sus límites, sobre todo el de memoria.
- **¿Qué sobra y qué falta?** Le sobra CPU y le falta memoria.
- **Con 10 veces la carga:** se cae en menos de 1,5 minutos por falta de memoria.
- **Costo:** USD 75,73 al mes en Fargate, 3,7 veces la t3.small.

### Docker 1 CPU

- **¿Aguanta?** Hasta 1.000 usuarios. Con 2.000 falla solo porque el 1 % más lento de los pings tarda 227 ms.
- **¿Dónde espera?** En su **límite de CPU**, no en el hardware. Con 2.000 usuarios quedó congelado 128 ms de cada segundo, mientras la máquina estaba al 19 %. Lo que llega durante esa pausa espera. Por eso la mayoría de las respuestas son rápidas y solo las más lentas lo delatan.
- **¿Qué sobra y qué falta?** Le sobra máquina; le faltan CPU asignada y memoria.
- **Con 10 veces la carga:** se cae en poco más de un minuto, por memoria.
- **Costo:** USD 39,69 al mes en Fargate, casi el doble que la t3.small por una capacidad parecida.

### AWS Unlimited

- **¿Aguanta?** Hasta 1.000 usuarios, sin margen: su núcleo ya va al 74 %. Con 2.000, el 15,5 % de las peticiones falla.
- **¿Dónde espera?** En la **CPU**. Con 2.000 usuarios el núcleo va al 97 % y el 1 % más lento de los pings pasa de 53 ms a más de 1 s.
- **¿Por qué ese número?** Cada mensaje le cuesta 2,7 veces más que al PC, por dos razones. El núcleo es más lento (2,5 GHz contra 4,5 GHz) y sus 2 vCPU son **un solo núcleo físico**, así que el servidor, el login y la base de datos se lo pelean. Cuando el núcleo se acerca al 100 %, la fila de mensajes crece muy rápido: al 75 % cada mensaje espera unas 3 veces su trabajo, y al 97 % unas 32 veces. Por eso los tiempos se disparan de golpe.
- **¿Qué sobra y qué falta?** Le sobran disco y red (aunque la red sería la siguiente en llenarse). Le faltan velocidad de núcleo y RAM.
- **Con 10 veces la carga:** se llena el núcleo y después la RAM. El sistema cierra el servidor o la base de datos entre los 8 y los 11 minutos.
- **Costo:** USD 20,43 al mes, más el extra de CPU si la carga durara todo el mes: unos USD 5 con 600 usuarios y USD 20 con 1.000.

### AWS Limited

- **¿Aguanta?** 300 usuarios sin problema. Pasó la de 600 gastando créditos ahorrados, y con 1.000 falla el 80 % de las peticiones.
- **¿Dónde espera?** En los **créditos**. Cuando se acaban, AWS le deja solo el 20 % de la CPU.
- **¿Por qué ese número?** Con 300 usuarios usa el 15 % de la máquina, por debajo de su 20 %. Con 600 usa el 27 %, por encima. Su límite sostenido estaría hacia los 400-450 usuarios (estimado, no medido).
- **¿Qué sobra y qué falta?** Le sobra todo excepto CPU sostenida.
- **Con 10 veces la carga:** no se cae porque entra poca gente, pero los pings tardan ~10 s. No se puede usar.
- **Costo:** USD 20,43 al mes, sin extras.

## 6. Respuestas generales

**¿Dónde espera Shareboard: CPU, disco o red?** En la **CPU**, y en particular en **un solo núcleo**: el que reenvía cada mensaje en tiempo real. El disco no es el límite, porque los tableros viven en memoria y en casi todas las pruebas el disco estuvo por debajo del 8 % de uso. La red tampoco, aunque sería la siguiente: en AWS, con 2.000 usuarios, llegó cerca de su base cuando la CPU ya estaba llena.

**¿Por qué ese número y no otro?** Cada número sale de una prueba de 10 minutos medida en la máquina, con los datos crudos en el repositorio. La capacidad de cada máquina es, básicamente, la velocidad de su núcleo dividida por lo que cuesta reenviar un mensaje. Ningún número de rendimiento viene de internet.

**¿Qué componente causa cada comportamiento?**

- **La velocidad de un núcleo** decide cuántos usuarios caben: el PC aguanta 3 veces más que AWS.
- **La memoria caché y la RAM** deciden cuánto tarda un login, porque la función de contraseñas usa mucha memoria a propósito.
- **Que 2 vCPU sean un solo núcleo** hace que en AWS todo compita por el mismo núcleo.
- **Los límites del contenedor** lo congelan o lo cierran aunque la máquina tenga recursos libres.
- **Los créditos** de AWS Limited lo recortan al 20 %.
- **Un solo hilo** pone el techo final: para 6.000 usuarios en el PC harían falta casi 2 núcleos de trabajo, y el servidor solo usa uno.

**Si la carga se multiplicara por diez, ¿qué se rompería primero?**

- En los contenedores, la memoria, en poco más de un minuto.
- En AWS Unlimited, el núcleo y después la RAM.
- En AWS Limited, los créditos, en 2 o 3 minutos.
- En el PC, el núcleo, sin caerse.

En todos, lo que el usuario nota es que **no puede entrar**: listar y unirse a un tablero hacen fila detrás de los mensajes en tiempo real.

**¿Qué opción se descarta?**

- **Docker 1 CPU:** falla por su límite con la máquina casi libre, y en AWS costaría el doble que la t3.small.
- **AWS Limited para más de 300 usuarios:** cuando se acaban los créditos, pasa de funcionar a fallar casi todo.
- **El PC para producción:** es el más capaz, pero no tiene IP fija ni está siempre encendido.

**Recomendación.** Para la carga de referencia (300 usuarios), la opción más barata que pasa es la **t3.small en modo Limited**, a USD 20,43 al mes. Para 600 usuarios o picos, la **t3.small Unlimited**, con unos USD 5 de extra. Con el código original, por encima de 1.000 usuarios ninguna opción barata tiene margen.

## 7. Cambios y mejoras visibles

Las mediciones señalaron dónde atacar: el núcleo que reenvía mensajes. Al perfilar el servidor con 3.000 usuarios, casi la mitad de su tiempo se iba en **un envío al sistema operativo por cada mensaje y cada persona**. En un tablero de 30 personas, un trazo eran 29 envíos, y con los cursores se juntaban miles por segundo.

Se hicieron cuatro cambios, sin dejar de usar un solo proceso:

1. **Envíos agrupados.** Los mensajes que le tocan a una misma persona en el mismo instante salen juntos en un solo envío. Cuanta más carga, más se ahorra.
2. **Preparar cada mensaje una vez**, en lugar de una vez por destinatario.
3. **Un PIN más liviano.** El PIN del tablero dejó de usar una función lenta que congelaba el servidor. Ahora usa una firma con clave secreta que tarda microsegundos. Lo que protege el PIN es el límite de intentos.
4. **Un nuevo método para las contraseñas** (Argon2id), el recomendado por OWASP, que necesita Node 24.

La campaña se repitió con las mismas pruebas y repeticiones: PC y Docker el 7 de noviembre, AWS Unlimited esa noche. Una primera versión esperaba 25 ms para juntar mensajes y empeoró todo; se corrigió para que no espere, y las cifras son de la versión corregida.

**Lo que mejoró:**

- **El núcleo trabaja menos con la misma carga:** en AWS, con 1.000 usuarios, bajó del 74 % al 51 %. AWS es donde más se nota, porque era donde cada mensaje costaba más.
- **Cerca del límite, las respuestas son de 5 a 15 veces más rápidas.** Alejarse un poco del 100 % acorta mucho la fila.
- **En AWS dejaron de fallar las peticiones.** Con 2.000 usuarios, los errores bajaron del 15,5 % a 0 % y entrar a un tablero pasó de 15 s a 0,13 s. Con 3.000, los errores bajaron del 51 % a 0 %.
- **El login es 5 veces más rápido** en todos los entornos.
- **Docker 1 CPU ahora pasa los 2.000 usuarios.**

| Antes → después | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited |
|---|---|---|---|---|
| Carga más alta que pasa | 3.000 → 3.000 | 2.000 → 2.000 | 1.000 → **2.000** | 1.000 → 1.000; 2.000 ya sin errores |
| Núcleo ocupado con 2.000 | 51 → 40 % | 75 → 63 % | 69 → 59 % | 97 → 90 % |
| 1 % más lento de los pings con 2.000 | 5,9 → 1,6 ms | 65 → 14 ms | 227 → 92 ms | 1.047 → 147 ms |
| Login con 600 | 136 → 24 ms | 142 → 25 ms | 147 → 24 ms | 298 → 53 ms |
| Con 3.000 usuarios | Pasa → pasa | Se cayó → se detuvo por memoria | Fallaba → se detuvo por memoria | 51 % de errores → **0 %** |

Detalle de cada cambio en [CAMBIOS-SERVIDOR.md](CAMBIOS-SERVIDOR.md) y todas las cifras en [MEJORAS.md](MEJORAS.md).

## 8. Dónde falla ahora y qué falta

- **La memoria es el nuevo primer límite.** El servidor nuevo usa entre 30 % y 80 % más memoria. En los contenedores de 512 MB, con 3.000 usuarios, la memoria se llena a los ~4 minutos y la prueba se detiene, aunque la CPU todavía tenía margen. En AWS, con 6.000 usuarios, la RAM se acaba a los ~3 minutos en lugar de 8-11: ahora entra más gente más rápido, y cada persona ocupa más memoria. La causa no está confirmada; puede ser Node 24, el nuevo método de contraseñas o las colas de mensajes. Es lo próximo que hay que investigar, empezando por contenedores de 1 GB.
- **El PC sigue sin poder con 6.000 usuarios.** Ahora entran 5.300 personas en vez de 4.100, y los pings mejoran mucho, pero el núcleo sigue lleno y un tercio de las peticiones se queda esperando. El techo es el hilo único. El servidor ya puede repartir tableros entre varios procesos, pero ese modo no se midió.
- **Con poca carga hay un costo mínimo:** los trazos tardan 0,2-0,4 ms más. Nadie lo nota.
- **Entrar con PIN sigue en ~31 ms con poca carga**, pero es un efecto de la prueba: la base se restaura con los PIN al estilo antiguo, y cada tablero paga la conversión la primera vez.
- **Falta medir AWS Limited con el código nuevo.** La repetición nunca se quedó sin créditos y se comportó como Unlimited, así que no sirvió. Hay que repetirla con los créditos agotados.
- **Node cambió de la versión 22 a la 24** junto con el código, así que parte de las diferencias puede venir de ahí.
