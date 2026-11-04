# Plan de carga: cómo se diseñó y por qué

Define qué hace cada usuario virtual, cómo se reparten los endpoints, qué números usa cada nivel y cómo se garantiza que el trabajo sea constante.

Archivos que lo definen: `telemetry/profiles/flujo.json` (comportamiento), `telemetry/profiles/{2-baja,3-media,4-alta,5-server-killer}.json` (niveles), `telemetry/lib/rooms.mjs` (planificador) y `telemetry/vu-worker.mjs` (el usuario).

> **Estado de los datos.** Este modelo reemplaza al anterior (sesiones de 2 a 5 minutos con 95 % de logins). Las tablas de [MEDICIONES.md](MEDICIONES.md), [COMPARACIONES.md](COMPARACIONES.md) y [CONCLUSIONES.md](CONCLUSIONES.md) siguen siendo del modelo anterior hasta repetir la campaña.

## 1. Qué pide el proyecto y cómo se cumple

| Requisito del proyecto | Cómo se cumple |
|---|---|
| Carga sostenida, al menos varios minutos | 600 s de medición en cada prueba, con llegadas y salidas continuas |
| Uso de CPU: promedio y pico, por núcleo | Agente con `/proc/stat`; también por hilo y por proceso |
| Memoria residente | `VmRSS` del servidor y de MongoDB |
| Operaciones de disco: IOPS y MB/s | `/proc/diskstats`, más `%util` |
| Tráfico de red: entrada y salida por segundo | `/proc/net/dev` |
| Latencia p50, p95 y p99, no el promedio | Histogramas por endpoint, incluyendo a quien no fue atendido |
| ¿Dónde espera: CPU, disco o red? | Panel «¿Dónde está esperando la aplicación?» |
| Tres opciones con las mismas mediciones | Máquina física, contenedor con límites e instancia EC2, con perfiles idénticos |
| Mediciones propias y reproducibles | Guiones en `telemetry/`, datos crudos en `resultados/` |

## 2. Los cinco endpoints

| Endpoint | Qué hace | Recurso que exige | Quién lo usa |
|---|---|---|---|
| `POST /auth/login` | Verifica la contraseña con scrypt y entrega una sesión de 30 días | Threadpool de libuv, memoria y caché | Solo quien no tiene sesión guardada |
| `POST /auth/register` | Calcula scrypt y crea la cuenta | Threadpool, escritura en MongoDB | Personas nuevas |
| `GET /me/boards` | Lista los tableros del usuario | Lectura en MongoDB, hilo de JavaScript | Quien tiene cuenta, al entrar y de vez en cuando |
| `POST /boards` | Crea un tablero y espera a que quede guardado | Escritura en MongoDB | Parte de quienes abren una sala propia |
| `POST /boards/:id/join` | Carga el tablero si no está en memoria, valida el PIN y entrega el token del WebSocket | MongoDB (carga en frío), hilo de JavaScript (PIN con `scryptSync`) | Todos |

Además, cada persona mantiene un **WebSocket** (`/ws`) abierto para el tiempo real. No cuenta como endpoint REST, pero es donde está la mayor parte del trabajo. Las demás rutas de la app no se ejercitan, por decisión de alcance.

### Reparto medido

Corrida de carga media en el PC: 600 s, 148 llegadas. Es una sola corrida, así que los endpoints poco frecuentes varían entre pruebas. Cada corrida reporta el suyo en el panel «Los 5 endpoints».

| Endpoint | Peticiones/s | Por llegada | % del tráfico REST | p50 | p95 |
|---|---|---|---|---|---|
| `GET /me/boards` | 0,361 | 1,5 | 54 % | 3,4 ms | 4,3 ms |
| `POST /boards/:id/join` | 0,243 | 1,0 | 36 % | 1,8 ms | 29,5 ms |
| `POST /auth/login` | 0,043 | 0,18 | 6 % | 136 ms | 172 ms |
| `POST /boards` | 0,022 | 0,09 | 3 % | 3,6 ms | 4,5 ms |
| `POST /auth/register` | 0 en esta corrida | ~0,015 esperado | ~0,5 % | – | – |

El tráfico REST es pequeño: casi todo el trabajo está en el tiempo real (~780 mensajes/s de los clientes, 2,6 por usuario). El p95 de 29,5 ms de `join` es compatible con `scryptSync`, que bloquea el hilo cuando alguien entra a un tablero con PIN.

## 3. El flujo de un usuario

No es un bucle: cada persona llega a una **sala**, sigue uno de cuatro caminos y va cambiando de actividad según lo que acaba de hacer.

### Salas

Una sala es un grupo que comparte tablero. Cuando una cierra, se abre otra para mantener el objetivo de usuarios.

| Tipo | % de salas | Personas | Duración media | Ventana de llegada | Roles |
|---|---|---|---|---|---|
| Solo | 45 | 1 | 15 min | – | Trabajo individual |
| Pareja o trío | 30 | 2-3 | 20 min | 1 min | Participantes |
| Equipo | 18 | 4-8 | 30 min | 2 min | 1 presentador + participantes |
| Taller | 5 | 10-15 | 45 min | 3 min | 1 presentador + participantes |
| Clase | 2 | 25-35 | 50 min | 4 min | 1 presentador + espectadores |

El 15 % se va antes de que acabe la sala. La sesión media resulta de unos 25 minutos.

### Caminos de llegada

| Camino | Grupo | Solo | Qué hace |
|---|---|---|---|
| Con sesión guardada | 52 % | 80 % | Lista → elige (2-8 s) → se une. La sesión dura 30 días, por eso es lo normal |
| Invitado con enlace | 35 % | – | Escribe su nombre (3-10 s) → se une, con PIN si el tablero lo pide |
| Debe iniciar sesión | 12 % | 17 % | Escribe (5-15 s) → login → lista → elige → se une |
| Cuenta nueva | 1 % | 3 % | Llena el formulario (20-40 s) → registro → se une |

El 30 % de las salas de una persona crea un tablero nuevo antes de entrar. El 20 % de los tableros tiene PIN.

Si una petición falla, la persona reintenta dos veces y se rinde. Ese abandono se cuenta como resultado.

### Dentro del tablero

La siguiente actividad depende de la actual y del rol (cadena de Markov en `flujo.json`): quien acaba de dibujar suele seguir dibujando o mover el cursor; quien mira, a veces se va a otra pestaña.

| Actividad | Qué envía | Duración media |
|---|---|---|
| Mirando | Solo ping cada 20 s | 25 s |
| Cursor | Posición cada 45 ms mientras la mano se mueve, con pausas | 4 s |
| Dibujando | Cursor + vista previa cada 33 ms + trazo final | 3 s |
| Figura | Cursor + vista previa + figura final | 4 s |
| Escribiendo | Nada hasta confirmar; luego el texto (1 % son imágenes de ~22 KB) | 8 s |
| Moviendo | Selección + cursor + vista previa + posición final | 2,5 s |
| Borrando | Un borrado | 1 s |
| En otra pestaña | Solo ping | 60 s |

Eventos de fondo: la red se cae cada ~20 min y el socket reconecta con el mismo token, sin REST; quien tiene cuenta vuelve a abrir su lista cada ~12 min.

Frecuencias tomadas del cliente real: `web/src/lib/config.ts`. **Los porcentajes de salas, caminos y actividades son supuestos de diseño**: no hay datos públicos de este tipo de app. La mejor calibración es grabar 2 o 3 sesiones reales y ajustar `flujo.json`.

## 4. Los niveles

Todas las pruebas duran lo mismo: 120 s de llegada, 30 s de estabilización y **600 s medidos**. Solo cambia el número de usuarios.

Usuarios al mes se calcula con la guía de k6 y BlazeMeter: sesiones en hora pico ÷ (1,2 sesiones al día × 15 % en la hora pico) ÷ 20 % de activos al día.

| | Baja | Media | Alta | Server killer |
|---|---|---|---|---|
| **Usuarios a la vez** | **100** | **300** | **600** | **6.000** |
| Salas abiertas | ~30 | ~85 | ~170 | ~1.700 |
| Llegadas por minuto | ~6 | ~12-15 | ~24 | ~240 |
| Logins por minuto | ~0,8 | ~1,6 | ~3 | ~31 |
| Sesiones por hora | ~350 | ~720 | ~1.440 | ~14.400 |
| Usuarios al mes equivalentes | ~10.000 | ~20.000 | ~40.000 | ~400.000 |
| Representa | Una facultad o un colegio | Una universidad mediana | Una universidad grande | La alta ×10, sostenida |

Con 100 usuarios hay menos clases: una sala de 30 movería demasiado la carga, y el planificador no abre salas que pasen mucho del objetivo. Por eso la sesión media baja un poco en ese nivel.

Las cifras son de la simulación (la corrida de carga media tuvo 14,8 llegadas por minuto); cada corrida reporta las reales en el panel «Los 5 endpoints».

## 5. Cómo se mantiene constante el trabajo

| Qué se mantiene | Cómo | Qué lo verifica |
|---|---|---|
| Usuarios | Una sala nueva reemplaza a la que cierra (100 ± 2 y 600 a 612 en la simulación) | Gráfica «Usuarios activos» |
| Llegadas | Horario independiente del servidor. Si el servidor se atasca, la carga no baja | «Peticiones por endpoint» |
| Tamaño de los tableros | Cada persona guarda hasta 5 elementos propios; al crear otro borra el más viejo | Tabla «Inicio, mitad y final» |
| Punto de partida | Antes de cada corrida se restaura la copia base de la base de datos | Registro: «Base restaurada» |
| Llegada inicial | Sin login ni registro: usa sesiones ya emitidas, y no se mide. Arranca con la mezcla de salas del estado estable, donde las salas largas pesan más | La ventana arranca después |

La memoria tarda más que el resto en estabilizarse: los tableros sin nadie salen de memoria a los 5 minutos, así que RES sigue subiendo unos minutos hasta aplanarse. Es comportamiento del servidor, no carga que crece.

Los tableros de la semilla tienen tamaños distintos, como los reales: mediana 80, p90 ~500 y p99 ~2.800 elementos, de cuatro tipos (70 % trazos, 20 % figuras, casi 10 % textos, 0,3 % imágenes). Cada sala toma uno libre, así que los tableros también se cargan en frío durante la prueba.

Límites por IP desactivados: toda la carga sale de una sola máquina. En producción son 10 logins por minuto por IP, un límite que 30 estudiantes detrás de la misma IP sí pueden alcanzar.

## 6. Criterio de «buen rendimiento»

Una prueba **pasa** si en los 600 s medidos se cumple todo:

| Métrica | Límite | Muestra mínima | Por qué |
|---|---|---|---|
| p95 de REST (listar, unirse, crear) | < 300 ms | 100 | Respuesta rápida a una acción de interfaz |
| p95 de autenticación (login y registro) | < 1 s | 100 | Scrypt es lento a propósito |
| p95 del trazo a los demás | < 150 ms | 100 | Por encima, la colaboración se percibe con retraso |
| p95 de la vista previa | < 150 ms | 100 | Igual |
| p99 del ping | < 100 ms | 1.000 | Mide la cola del hilo de JavaScript |
| Errores por petición REST | < 1 % | – | Se calcula contra peticiones, no contra mensajes |

Son umbrales de diseño, alineados con los [límites de respuesta de Nielsen](https://www.nngroup.com/videos/3-response-time-limits-interaction-design/) (0,1 s se siente instantáneo, 1 s no interrumpe el pensamiento).

Con menos muestras que el mínimo, el percentil se reporta pero no se juzga. Es lo normal para login en carga baja (~8 en toda la ventana). Para evaluar el login por sí solo se necesita una prueba aparte.

El laboratorio ya no corta una prueba por errores, así todas duran lo mismo y se ve cómo cae el servidor. Solo la corta si un contenedor llega al 95 % de su memoria. Si el generador supera el 85 % de ocupación (p95 de su hilo más ocupado), la prueba queda como no válida.

## Fuentes

- Modelos abierto y cerrado: [Grafana k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)
- Concurrentes desde la hora pico: [Grafana k6](https://grafana.com/docs/k6/latest/testing-guides/calculate-concurrent-users/), [BlazeMeter](https://www.blazemeter.com/blog/calculate-concurrent-users-performance-testing)
- DAU/MAU: [Gainsight](https://www.gainsight.com/essential-guide/product-management-metrics/dau-mau/)
- Frecuencias del cliente: `web/src/lib/config.ts`. Sesión de 30 días: `servidor/src/tokens.ts`
