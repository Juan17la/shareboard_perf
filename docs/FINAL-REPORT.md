# Informe final: rendimiento de Shareboard

## 1. Introducción

**Shareboard** es una pizarra colaborativa en tiempo real: varias personas abren el mismo tablero desde el navegador o el celular, dibujan, escriben y ven los cursores y trazos de las demás al instante.

Este proyecto responde a una pregunta práctica: **¿en qué máquina debería correr el servidor de Shareboard y cuántos usuarios aguanta cada opción?** Para responderla ejecutamos el mismo servidor, con los mismos datos y la misma carga, en cinco entornos:

| Entorno | Qué representa |
|---|---|
| **PC nativo** | Una máquina física con el servidor corriendo directamente |
| **Docker 1 CPU** | Un contenedor limitado a 1 CPU y 512 MB, como un plan pequeño de un PaaS |
| **Docker 2 CPU** | Lo mismo, con 2 CPU y 512 MB |
| **AWS Unlimited** | Una instancia EC2 t3.small que puede usar toda su CPU y paga el excedente |
| **AWS Limited** | La misma instancia, pero regulada por créditos de CPU |

Probamos siete niveles de carga, de 100 a 6.000 personas conectadas a la vez, con 75 corridas en total. En cada una medimos CPU, memoria, disco, red y latencia para saber no solo quién aguanta más, sino **qué recurso se agota y por qué**.

## 2. El proyecto

### Qué hace

Una persona crea un tablero y comparte su enlace o código corto. Quienes entran pueden dibujar a mano, añadir figuras, texto e imágenes, mover y borrar elementos, y ver en vivo los cursores y lo que los demás están dibujando. Se puede entrar con cuenta o como invitado, y un tablero puede protegerse con PIN. También tiene funciones de apoyo, como permisos y dibujo con IA, que no formaron parte de estas pruebas.

### Cómo está construido

Son tres proyectos independientes que solo comparten el contrato de comunicación:

```
Web (React + Vite)        ─┐
                           ├─ REST: cuentas, crear y unirse a tableros
Móvil (Expo/React Native) ─┘  WebSocket: trazos, cursores, presencia
                                     │
                                     ▼
                     Servidor (Node.js + Fastify + TypeScript)
                                     │  escritura diferida (máx. 1 s)
                                     ▼
                                  MongoDB
```

Estas pruebas se centran en el **servidor**, que tiene dos canales:

- **REST** para las acciones puntuales: registrarse, iniciar sesión, listar, crear y unirse a tableros.
- **WebSocket** para el tiempo real: cada persona mantiene una conexión abierta por la que envía y recibe trazos, cursores, vistas previas y pings.

### Decisiones de diseño que afectan el rendimiento

| Decisión | Cómo funciona | Consecuencia |
|---|---|---|
| **Tableros en memoria** | El tablero activo vive en la RAM del proceso y se guarda en MongoDB después de cambiar, agrupando los cambios de cada segundo. Sale de memoria 5 minutos después de quedar vacío | El tiempo real casi no toca el disco, pero la memoria crece con los tableros abiertos |
| **Un solo proceso de Node** | Todo el JavaScript se ejecuta en un hilo. La difusión recorre a los participantes del tablero y serializa y envía el mensaje a cada uno | **Es el principal límite medido.** Más núcleos no aceleran esta parte; un núcleo más rápido sí |
| **scrypt para contraseñas** | Es costoso a propósito (16 MB por cálculo) y corre en el threadpool de libuv, fuera del hilo principal | Un login tarda 136 ms en el PC y hasta 298 ms en AWS, pero no congela el tiempo real |
| **scrypt síncrono para el PIN** | Validar el PIN de un tablero usa `scryptSync`, que sí corre en el hilo principal | Coincide con el escalón del p95 de REST: ~30 ms en el PC y ~50 ms en AWS |
| **Sesiones firmadas de 30 días** | Tokens HMAC sin estado en el servidor | La mayoría de las visitas no hace login, lo que abarata la carga real |
| **Una sola instancia** | Las salas de cada tablero viven en ese proceso | Escalar a varios procesos requeriría un canal compartido (el código ya lo señala con Redis) |

### Dependencias del backend

| Dependencia | Para qué se usa |
|---|---|
| **Node.js ≥ 22** | Entorno de ejecución |
| **TypeScript** | Lenguaje; se compila con `tsc` (`tsx` solo en desarrollo) |
| **fastify** | Servidor HTTP y rutas REST; su log da la latencia interna que medimos |
| **@fastify/websocket** | Conexiones WebSocket del tiempo real |
| **@fastify/cors** | Permite las peticiones desde otros orígenes, como el cliente web |
| **mongodb** | Driver oficial para guardar tableros y cuentas (MongoDB 7, en Docker en todas las pruebas) |
| **nodemailer** | Correos de verificación y recuperación de contraseña; no se ejercita en las pruebas |

La criptografía (scrypt, HMAC) viene de `node:crypto`, sin librerías adicionales.

## 3. Cómo se genera la carga

Quisimos parecernos al uso real de una pizarra, no bombardear un endpoint. El generador simula **personas** organizadas en **salas**:

- **Salas de distinto tamaño.** Cada sala es un grupo que comparte tablero, desde una persona sola hasta una clase, con duración media de 15 a 50 minutos. Cuando una cierra, se abre otra para mantener el número de usuarios.
- **Modelo abierto.** Las llegadas y salidas siguen un horario que no depende de lo que tarde el servidor. Si el servidor se atasca, la carga no baja y el problema aparece en la latencia y los errores.
- **Caminos de entrada realistas.** La mayoría llega con sesión guardada o como invitado. Solo cerca del 13 % hace login y cerca del 1-3 % se registra. Si una petición falla, la persona reintenta dos veces y se rinde.
- **Actividad dentro del tablero.** Cada persona alterna entre mirar, mover el cursor, dibujar, escribir, mover, borrar y cambiar de pestaña. Las frecuencias salen del cliente real: cursor cada 45 ms, vista previa cada 33 ms y ping cada 20 s.

| Tipo de sala | % de salas | Personas | Duración media |
|---|---|---|---|
| Solo | 45 | 1 | 15 min |
| Pareja o trío | 30 | 2-3 | 20 min |
| Equipo | 18 | 4-8 | 30 min |
| Taller | 5 | 10-15 | 45 min |
| Clase | 2 | 25-35 | 50 min |

> Las frecuencias vienen del cliente real, pero los porcentajes de salas, caminos y actividades son **supuestos de diseño**: no tenemos datos de uso real para calibrarlos.

Casi todo el trabajo está en el tiempo real, no en REST. Con 300 usuarios en el PC, el servidor recibe unos 950 mensajes por segundo y entrega unos 6.000, frente a menos de una petición REST por segundo.

### Tiempos de cada prueba

**Todas las pruebas duran lo mismo, 12,5 minutos; solo cambia el número de usuarios.**

| Fase | Duración | Qué pasa |
|---|---|---|
| Preparación | Antes de cada prueba | Se reinicia el servidor y se restaura la base de datos (1.500 cuentas, 2.000 tableros) |
| Llegada | 120 s | Entran los usuarios, sin login, para no provocar una avalancha artificial |
| Estabilización | 30 s | Se deja asentar la carga; no se mide |
| **Medición** | **600 s** | La única ventana usada en los resultados |
| Pausa | 60 s | Hasta la siguiente prueba |

| Prueba | Usuarios a la vez | Llegadas por minuto (teórico) | Repeticiones |
|---|---|---|---|
| Baja | 100 | ~4 | 3 |
| Media (referencia) | 300 | ~12 | 3 |
| Alta | 600 | ~24 | 3 |
| Capacidad 1.000 | 1.000 | ~40 | 1 |
| Capacidad 2.000 | 2.000 | ~80 | 1 |
| Capacidad 3.000 | 3.000 | ~120 | 1 |
| Server killer | 6.000 | ~240 | 3 |

Las llegadas teóricas son los usuarios divididos entre los ~25 minutos de sesión media. Las reales varían entre corridas.

## 4. Resultados

### Cómo lo probamos

- **Mismas condiciones.** Mismo código, misma base de datos inicial, mismos perfiles de carga y MongoDB en Docker en todos los entornos.
- **El generador no compite con el servidor.** En el PC y en Docker corre en otros núcleos de la misma máquina (E-cores, con el servidor en los P-cores). En AWS corre en otra instancia de la misma zona.
- **Medición externa.** Un agente lee cada segundo los archivos del kernel (`/proc`) sin modificar el servidor. La latencia viene de dos lados: lo que ve el generador, en percentiles, y el log interno de Fastify.
- **Validez.** Una prueba se invalida si el generador supera el 85 % de ocupación. El máximo fue 73 %, así que ninguna quedó invalidada.

Una prueba **pasa** si durante los 600 s se cumple todo esto:

| Métrica | Límite |
|---|---|
| p95 de REST (listar, unirse, crear) | < 300 ms |
| p95 de login y registro | < 1 s |
| p95 de trazo y de vista previa a los demás | < 150 ms |
| p99 del ping | < 100 ms |
| Peticiones REST con error | < 1 % |

### ¿Quién aguanta qué?

Cada celda indica las repeticiones que pasaron sobre el total.

| Entorno | 100 | 300 | 600 | 1.000 | 2.000 | 3.000 | 6.000 |
|---|---|---|---|---|---|---|---|
| **PC nativo** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✓ 1/1 | ✓ 1/1 | ✕ 0/3 |
| **Docker 2 CPU** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✓ 1/1 | ✕ cayó | ✕ cayó 3/3 |
| **Docker 1 CPU** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✕ 0/1 | ✕ 0/1 | ✕ cayó 3/3 |
| **AWS Unlimited** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3 | ✓ 1/1 | ✕ 0/1 | ✕ 0/1 | ✕ cayó 3/3 |
| **AWS Limited** | ✓ 3/3 | ✓ 3/3 | ✓ 3/3* | ✕ 0/1 | ✕ 0/1 | ✕ 0/1 | ✕ 0/3 |

*Pasó gastando créditos acumulados; ver la sección 5.

Hasta 600 usuarios todos pasan, así que la carga de referencia no distingue a los entornos. Las diferencias aparecen desde 1.000. Los niveles de 1.000 a 3.000 tienen **una sola repetición**, por lo que indican el orden, pero no son un límite exacto.

### Misma carga: 600 usuarios

Valores medianos de las 3 repeticiones.

| Métrica | PC | Docker 2 CPU | Docker 1 CPU | AWS Unlimited | AWS Limited |
|---|---|---|---|---|---|
| REST p50, usuario | 3,2 ms | 3,6 ms | 3,6 ms | 7,2 ms | 6,4 ms |
| REST p50, dentro del servidor | 2,0 ms | 2,1 ms | 2,1 ms | 4,7 ms | 4,2 ms |
| Login p50, dentro del servidor | 136 ms | 142 ms | 147 ms | 298 ms | 298 ms |
| Trazo a los demás, p95 | 0,8 ms | 1,0 ms | 1,1 ms | 4,9 ms | 4,3 ms |
| Ping, p99 | 0,9 ms | 1,2 ms | 1,9 ms | 12 ms | 7,2 ms |
| Hilo de JavaScript, promedio | 18 % | 22 % | 22 % | 45 % | 42 % |
| CPU de JavaScript por mensaje entregado | 12,8 µs | 17,5 µs | 17,1 µs | 35 µs | 32 µs |
| Memoria del servidor, pico | 283 MB | 249 MB | 263 MB | 257 MB | 265 MB |

### Dónde empieza a fallar cada uno

| Entorno y carga | Conectados | Hilo JS | Ping p99 | Errores REST | Resultado |
|---|---|---|---|---|---|
| PC, 3.000 | 2.825 | 79 % | 47 ms | 0 % | Pasa |
| Docker 2 CPU, 2.000 | 1.856 | 75 % | 65 ms | 0 % | Pasa |
| Docker 1 CPU, 1.000 | 959 | 33 % | 22 ms | 0 % | Pasa |
| Docker 1 CPU, 2.000 | 1.901 | 69 % | **227 ms** | 0 % | Falla solo por ping |
| AWS Unlimited, 1.000 | 976 | 74 % | 53 ms | 0 % | Pasa |
| AWS Unlimited, 2.000 | 1.879 | 97 % | **1,05 s** | **15,5 %** | Falla |
| AWS Limited, 1.000 (sin créditos) | 628 | 90 % | **3,7 s** | **80,5 %** | Falla |

### Server killer: 6.000 usuarios

| Entorno | ¿Se cayó? | Causa y momento | Conectados | Ping p99 |
|---|---|---|---|---|
| PC | No (0/3) | Hilo JS al 99 %, 38 % de errores REST | ~4.130 | ~1 s |
| Docker 1 CPU | Sí (3/3) | Sin heap de V8, a los 52-77 s | – | – |
| Docker 2 CPU | Sí (3/3) | Sin heap de V8, a los 55-88 s | – | – |
| AWS Unlimited | Sí (3/3) | Sin RAM (OOM del kernel), a los 7,7-11,3 min | 1.240-2.240 | 1,1-5,2 s |
| AWS Limited | No (0/3) | Casi todas las peticiones fallan | ~1.370 | ~10,6 s |

En ninguna carga el disco fue el límite: fuera del killer de AWS Unlimited, los promedios se quedaron por debajo de 130 IOPS y de 8 %util, con espera de disco de unos 2 % o menos. En ese killer sí sube (hasta 1.014 IOPS y 25 %util de promedio, en la repetición donde MongoDB se reinició), pero aparece cuando la máquina ya se está quedando sin RAM: es un síntoma de esa falta de memoria, no la causa.

## 5. Qué cambia entre entornos y por qué

El orden de capacidad es:

**PC (3.000) > Docker 2 CPU (2.000) > Docker 1 CPU y AWS Unlimited (1.000) > AWS Limited (300 sostenibles, 600 con créditos).**

No hay una sola causa: cada entorno se queda sin algo distinto.

### Por qué el PC es el más fuerte

El factor decisivo es la **velocidad de un solo núcleo**. Como casi todo el trabajo pasa por un hilo de JavaScript, importa más un núcleo rápido que tener muchos. Los P-cores del Core Ultra 5 125H llegan a 4,5 GHz y son los que entregan más trabajo por hilo:

- Cada mensaje entregado cuesta **12,8 µs** de CPU en el PC y **unos 35 µs** en AWS, 2,7 veces más.
- En el PC el hilo llega al 79 % con 2.825 usuarios. AWS Unlimited llega al 74 % con solo 976.

El PC tampoco tiene un tope duro de memoria: tiene 15 GB, y en el killer el servidor llegó a 816 MB sin caer. Por eso se degrada sin morir: con el hilo saturado rechaza peticiones por tiempo de espera, pero el proceso sigue vivo.

### Docker: mismo hardware, pero con límites

Docker usa los mismos P-cores, por eso con poca carga es casi igual al PC. Lo distinguen dos límites:

- **Cuota de CPU.** "1 CPU" no reserva un núcleo: el kernel da 100 ms de CPU cada 100 ms y, si el proceso los gasta antes, congela **todo el contenedor** hasta el siguiente periodo. Con 2.000 usuarios, Docker 1 CPU tuvo 128 ms/s de freno. Sin errores REST, su ping p99 subió a 227 ms con la máquina mayormente libre (uso total del 19 %). Con 2 CPU, el freno baja a 16 ms/s y la misma carga pasa. La causa no es falta de hardware sino el límite configurado.
- **Memoria.** Con 512 MB, V8 limita su heap a cerca de la mitad del límite del contenedor. Por eso Docker 2 CPU cae con 3.000 usuarios (a los 332 s) y ambos caen en el killer en poco más de un minuto. El proceso muere por falta de heap, no porque el kernel lo mate. Es un límite configurable, aunque no probamos otro valor.

A igual carga, el hilo de JavaScript cuesta algo más que en el PC (17 frente a 12,8 µs por mensaje). La causa probable es la red del contenedor, pero no la aislamos. MongoDB también va limitado en este modo (1 CPU, 1 GB), lo que no ocurre en el PC ni en AWS.

### AWS: la CPU es más lenta y hay un solo núcleo físico

La t3.small es la más débil en CPU por dos razones:

- **2 vCPU no son 2 núcleos.** Son dos hilos de hyperthreading de **un solo núcleo físico** (Xeon Platinum 8259CL a 2,5 GHz de base). Cuando Node, los hilos de login y MongoDB coinciden, compiten por las mismas unidades de ejecución y la misma caché.
- **Frecuencia y caché menores.** El login, que siempre hace el mismo cálculo, sirve para comparar: tarda 136 ms en el PC y 255-298 ms en AWS, unas 2 veces más. scrypt recorre 16 MB de memoria al azar, por lo que también depende de la caché y de la RAM.

También cambia cómo falla: con 1,9 GB, el servidor (~690 MB) y MongoDB (~700 MB) llegan a dejar sin RAM a la máquina. El kernel los mata, y en una de las repeticiones mató primero a MongoDB. Docker había fallado por el heap de V8; aquí falla toda la máquina.

### AWS Unlimited frente a AWS Limited

Son la misma instancia con reglas distintas de CPU:

| | Unlimited | Limited |
|---|---|---|
| CPU sin créditos | Sigue al 100 %, paga el excedente | Queda en la base: **~20 % de la máquina** (0,4 vCPU) |
| Créditos | Da igual el saldo | Gana 24 por hora, se gastan al pasar de la base |
| Steal (CPU retirada) | ~0,3 % | **~60 %** al agotar créditos |

Medimos el recorte directamente: en el killer el steal es 0 % al inicio y salta a ~60 % en el minuto 2-3, cuando se acaban los créditos. Desde ahí, la CPU útil queda en 16-19 % de la máquina, lo que coincide con la base de 20 %.

Tres matices para leer bien estos resultados:

- **Con 100 y 300 usuarios no hay diferencia real.** Usan 6 % y 15 % de la máquina, por debajo de la base, así que Limited los puede sostener indefinidamente.
- **Con 600 usuarios Limited pasa, pero gastando reserva.** Usa ~27 %, por encima del 20 %. Pasó porque venía de ganar créditos en las pruebas anteriores. Sin reserva no los sostendría indefinidamente; por proyección lineal, el límite sostenido estaría en unos 400-450 usuarios, sin haberlo medido.
- **Las pruebas de capacidad de Limited son su peor caso.** Empezaron justo después de un killer, sin créditos. Con reserva habría rendido como Unlimited hasta gastarla.

Limited no se cayó en el killer (0 de 3), mientras Unlimited cayó las 3 veces. No es que sea más robusto: con la CPU recortada entran menos usuarios (~1.370 frente a un máximo de ~2.240) y la memoria no llega a agotarse. Sobrevive, pero con un ping p99 de ~10 s no es utilizable.

### Por qué uno tiene mejor latencia que otro

La latencia que ve el usuario suma varios tiempos, y cada entorno aporta distinto a cada uno:

| Origen | Qué es | Dónde pesa |
|---|---|---|
| **Velocidad de la CPU** | Lo que tarda el trabajo en sí | AWS: REST interno p50 de 4,7 ms frente a 2,0 ms en el PC, con 600 usuarios |
| **Fila del hilo de JavaScript** | Lo que espera un mensaje antes de procesarse | Crece muy rápido cerca del 100 %. AWS Unlimited pasa de ping p99 53 ms (hilo 74 %) a 1,05 s (hilo 97 %) |
| **Red** | El viaje entre generador y servidor | Pequeña: ping p50 de 0,5 ms en AWS frente a 0,1-0,2 ms local, con 600 usuarios |
| **Freno de cuota** | El contenedor congelado hasta el próximo periodo | Docker 1 CPU: aparece en p99 sin subir la mediana (REST p50 6,4 ms, ping p99 227 ms) |
| **Steal por créditos** | Tiempo que AWS le quita a la instancia | AWS Limited sin créditos: REST p50 llega a los 15 s de tiempo límite |
| **PIN con `scryptSync`** | Bloquea el hilo durante el cálculo | Produce el escalón del p95 de REST: ~30 ms en el PC, ~50 ms en AWS |

Por eso una mediana baja no garantiza buena experiencia, y el p95 y el p99 revelan problemas antes: Docker 1 CPU tiene buen p50 con 2.000 usuarios, y solo su p99 muestra el freno.

Una aclaración sobre AWS: su latencia de usuario incluye una red real, mientras el PC y Docker usan la interfaz local. Para comparar solo el servidor, conviene mirar las cifras "dentro del servidor". En AWS también cuentan las actualizaciones automáticas: en una repetición de 600 usuarios, Ubuntu instaló paquetes durante 2 minutos y el ping p99 subió a 96 ms en ese tramo, frente a 8 ms en el resto.
