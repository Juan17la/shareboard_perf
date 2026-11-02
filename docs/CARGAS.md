# Niveles de carga: cómo se diseñaron y por qué

Este documento explica qué hace cada usuario virtual, cómo se eligieron los cuatro niveles de carga y los números que salen de cada uno: usuarios activos, llegadas por segundo y por minuto, sesiones totales y operaciones por segundo.

Archivos que lo definen: `telemetry/profiles/flujo.json` (comportamiento de un usuario) y `telemetry/profiles/{2-baja,3-media,4-alta,5-server-killer}.json` (niveles).

---

## 1. Principio: carga continua, no una ráfaga

Una primera versión del generador traía a los usuarios al principio y luego los dejaba quietos. Las sesiones duraban 40 minutos, así que en una prueba de 5 minutos casi nadie salía y no había más logins. La entrada al sistema (login, registro, listar tableros) solo se ejercitaba en el primer minuto.

La versión actual mantiene un **número fijo de usuarios activos** y, durante toda la prueba, **unos terminan su sesión y salen mientras otros entran**. La relación entre las tres magnitudes es la ley de Little:

```
usuarios activos (L) = llegadas por segundo (λ) × duración media de la sesión (W)
```

Ejemplo, carga media: 2 usuarios/s × 120 s = **240 usuarios activos**.

Cada usuario virtual ocupa un "puesto". Cuando su sesión termina, sale (cierra su WebSocket) y otra persona ocupa ese puesto de inmediato con un login nuevo. La duración de cada sesión es aleatoria con distribución exponencial de media W, así las salidas (y por lo tanto las llegadas) son un proceso de Poisson: no llegan en bloque sino de forma irregular, como en la realidad.

Todas las pruebas **duran lo mismo** (12,5 minutos) y solo cambia el nivel de carga:

| Fase | Duración | Qué pasa |
|---|---|---|
| Llegada | 120 s | Los usuarios entran hasta completar el nivel |
| Estabilización | 30 s | Cachés, recolector de basura y conexiones llegan a régimen. No se mide |
| **Medición** | **600 s** | Carga sostenida: entradas y salidas continuas. Es lo que se reporta |

---

## 2. Qué hace un usuario (el flujo)

Cada llegada imita al cliente web real de Shareboard (frecuencias tomadas de `web/src/lib/config.ts`):

```
llega ─► login (95 %) o registro (5 %)
      ─► lista sus tableros (GET /me/boards)
      ─► crea un tablero (5 % de las llegadas)
      ─► se une a su tablero (POST /boards/:id/join) y abre el WebSocket
      ─► trabaja: alterna estados según su rol, vuelve a listar cada ~5 min
      ─► sale al terminar la sesión (cierra el WebSocket)
```

| Operación | Ruta | Qué cuesta en el servidor |
|---|---|---|
| Login | `POST /auth/login` | scrypt (N=2¹⁴, r=8, p=5: 16 MB y ~100-600 ms de CPU según la máquina) en el threadpool de libuv + lectura en Mongo |
| Registro | `POST /auth/register` | scrypt + escritura de la cuenta en Mongo |
| Listar tableros | `GET /me/boards` | Consulta a Mongo |
| Crear tablero | `POST /boards` | Escritura en Mongo, **esperada** por la petición |
| Unirse | `POST /boards/:id/join` | Carga el tablero en memoria si no estaba |
| Tiempo real | WebSocket `/ws` | Cada mensaje se reenvía a todos los demás del tablero |

Dentro del tablero el usuario alterna cuatro estados. Su peso depende del rol:

| Estado | Qué envía | Duración media |
|---|---|---|
| Mirando | Solo un ping cada 20 s | 12 s |
| Cursor | Posición del cursor cada 45 ms (~22/s) | 2,5 s |
| Dibujando | Cursor + vista previa del trazo cada 33 ms (~30/s) + el trazo final al soltar | 2 s |
| Moviendo | Selección + cursor + vista previa cada 33 ms + el cambio al soltar | 1,5 s |

| Rol | Dónde | Mirando | Cursor | Dibujando | Moviendo |
|---|---|---|---|---|---|
| Colaborador | Equipos y personas solas | 55 % | 25 % | 12 % | 8 % |
| Presentador | 1 por clase | 20 % | 35 % | 35 % | 10 % |
| Espectador | El resto de la clase | 85 % | 12 % | 3 % | 0 % |

Los usuarios se reparten en bloques de 250 que se repiten: **4 clases de 30, 22 equipos de 5 y 20 personas solas** (46 tableros por bloque). Las reuniones en línea promedian 7 a 10 personas (Zoom 2021-2022); los equipos de 5 son el caso típico y la clase de 30 el grupo grande.

Los porcentajes por estado son un supuesto de diseño: no hay datos públicos de Miro o Excalidraw sobre cuánto dibuja cada persona. Están en un solo archivo (`flujo.json`) y se pueden variar.

---

## 3. Los cuatro niveles

La entrada de usuarios es de **1 o 2 por segundo**. Lo que diferencia las cargas es el ritmo de entrada y cuánto tiempo se queda cada persona:

| Nivel | Llegadas (λ) | Sesión media (W) | **Usuarios activos (L)** | Tableros abiertos | Qué representa |
|---|---|---|---|---|---|
| **Baja** | 1/s | 2 min | **120** | 22 (2 clases, 10 equipos, 10 solos) | Una facultad en su hora pico: visitas cortas, varias clases a la vez |
| **Media** | 2/s | 2 min | **240** | 44 (4 clases, 21 equipos, 19 solos) | Varias facultades o empresas pequeñas a la vez. Doble ritmo de entrada que la baja |
| **Alta** | 2/s | 5 min | **600** | 107 (10 clases, 51 equipos, 46 solos) | Una universidad grande: el mismo ritmo de entrada que la media, pero clases y reuniones más largas. Más tiempo real simultáneo |
| **Server killer** | 20/s | 5 min | **6.000** | 1.104 (96 clases, 528 equipos, 480 solos) | La alta multiplicada por 10. No está hecha para pasar: muestra qué se rompe primero |

Por qué este diseño separa causas:

- **Baja → media:** se duplica el ritmo de login y registro (trabajo de scrypt, CPU) y se duplican los usuarios.
- **Media → alta:** el ritmo de login es **el mismo** (2/s), pero hay 2,5 veces más usuarios conectados. Si la alta falla y la media no, el problema es el tiempo real (reenvío de mensajes), no el login.
- **Server killer:** 10 veces todo a la vez, para ver qué recurso cede primero.

### 3.1 Números por nivel

Calculados con la ley de Little y con las proporciones del flujo (95 % login, 5 % registro, 5 % crean tablero):

| | Baja | Media | Alta | Server killer |
|---|---|---|---|---|
| Usuarios activos | 120 | 240 | 600 | 6.000 |
| Llegadas por segundo | 1 | 2 | 2 | 20 |
| Llegadas por minuto | 60 | 120 | 120 | 1.200 |
| Sesiones por hora | 3.600 | 7.200 | 7.200 | 72.000 |
| Logins por segundo | 0,95 | 1,9 | 1,9 | 19 |
| Registros por minuto | 3 | 6 | 6 | 60 |
| Tableros creados por minuto | 3 | 6 | 6 | 60 |
| Llegadas en los 10 min medidos | 600 | 1.200 | 1.200 | 12.000 |
| Sesiones en toda la prueba (12,5 min) | ~810 | ~1.620 | ~1.980 | ~19.800 |
| Velocidad de llegada durante los 120 s iniciales | 1/s | 2/s | 5/s | 50/s |

La última fila es consecuencia de que todas las pruebas duren lo mismo: los usuarios tienen 120 s para completar el nivel, así que en la alta y en Server killer entran más rápido al principio que en el estado estable. Esa fase no se mide, pero la puede soportar o no la máquina (ver [MEDICIONES.md](MEDICIONES.md)).

### 3.2 Lo que realmente se generó (medido)

La carga ofrecida se verifica en el propio generador. Ventana medida de las corridas en el PC (donde el servidor no limitó la carga):

| | Baja | Media | Alta |
|---|---|---|---|
| Usuarios conectados (promedio) | 119 | 238 | 599 |
| Entradas por segundo | 0,99 | 2,05 | 1,91 |
| Logins por segundo | 0,94 | 2,01 | 1,86 |
| Registros por segundo | 0,05 | 0,04 | 0,05 |
| Listar tableros por segundo | 1,35 | 2,73 | 3,92 |
| Tableros creados por segundo | 0,04 | 0,09 | 0,09 |
| Mensajes WebSocket enviados por los clientes (por segundo) | 1.203 | 2.426 | 6.392 |
| Mensajes WebSocket recibidos por los clientes (por segundo) | 11.505 | 22.863 | 59.135 |

Dos lecturas importantes:

1. **El servidor multiplica el tráfico por ~9,5.** Cada cursor o trazo que llega se reenvía a todos los demás del tablero. Por eso el trabajo en tiempo real crece con el cuadrado del tamaño del tablero: una clase de 30 genera unas 13 veces más reenvíos que un equipo de 5, con solo 6 veces más personas.
2. **Media y alta tienen el mismo ritmo de login** (2,01 y 1,86/s), pero la alta mueve 2,6 veces más mensajes. Separa limpiamente el costo de autenticar del costo del tiempo real.

---

## 4. ¿Es una carga realista?

La forma estándar de pasar de usuarios registrados a usuarios concurrentes (guías de k6 y BlazeMeter) es:

```
sesiones en la hora pico = usuarios activos al día (DAU) × sesiones por usuario × fracción del día en la hora pico
```

Con valores típicos de SaaS educativo y de equipos: 1,2 sesiones por usuario al día y el 15 % del uso concentrado en la hora pico (un pico de unas 3,6 veces el promedio, dentro del rango de 2 a 5 que citan las guías). DAU/MAU de 20 % (rango típico 10 a 20 %).

| Nivel | Sesiones en la hora pico | DAU equivalente | Usuarios registrados (MAU) equivalentes |
|---|---|---|---|
| Baja | 3.600 | ~20.000 | ~100.000 |
| Media | 7.200 | ~40.000 | ~200.000 |
| Alta | 7.200 (más largas) | ~40.000 | ~200.000 |
| Server killer | 72.000 | ~400.000 | ~2.000.000 |

La sesión de 2 minutos es corta para una clase completa: representa una **visita** (abrir el tablero, aportar, salir), que es el patrón que más estresa la entrada al sistema. Es una decisión a propósito: con sesiones de 40 minutos el login casi no aparece y se oculta el componente más caro del servidor. La carga alta usa sesiones de 5 minutos para representar el uso prolongado.

---

## 5. Criterio de "buen rendimiento"

Una prueba **pasa** si en los 10 minutos medidos se cumple todo esto:

| Métrica | Límite | Por qué |
|---|---|---|
| p95 de REST (listar, unirse, crear) | < 300 ms | Umbral común de respuesta "instantánea" para una acción de interfaz |
| p95 de login y de registro | < 1 s | El usuario tolera más en el inicio de sesión; scrypt es lento a propósito |
| p95 del trazo terminado a los demás | < 150 ms | Por encima, la colaboración se percibe con retraso |
| p95 de la vista previa | < 150 ms | Igual |
| p99 del ping | < 100 ms | Mide la cola del bucle de eventos de Node: si el ping tarda, todo tarda |
| Errores | < 1 % | |

A las latencias del cliente se les resta el RTT de red medido sin carga antes de cada prueba (1-3 ms), así el criterio es el mismo en el PC y en la nube.

El laboratorio **corta** una prueba si los errores pasan del 20 % durante 10 s o si un contenedor llega al 95 % de su memoria. La prueba queda registrada con el motivo y el tiempo que alcanzó a medir.

---

## Fuentes

- Cálculo de concurrentes desde la hora pico: [Grafana k6, Calculate concurrent users](https://grafana.com/docs/k6/latest/testing-guides/calculate-concurrent-users/), [BlazeMeter](https://www.blazemeter.com/blog/calculate-concurrent-users-performance-testing)
- Pico de 2 a 5 veces el promedio: [Zenocloud](https://zenocloud.io/blog/load-test/load-test-concurrent-visitors-google-analytics/), [LoadFocus](https://loadfocus.com/blog/2025/04/calculate-concurrent-users)
- Ley de Little en pruebas de carga: [Microsoft TestingSpot](https://techcommunity.microsoft.com/blog/testingspotblog/little-law-of-queuing-theory-and-how-it-impacts-load-testers/367620)
- DAU/MAU en SaaS B2B: [Gainsight](https://www.gainsight.com/essential-guide/product-management-metrics/dau-mau/)
- Tamaño de reuniones (Zoom): [Zoom, How you Zoomed over the past year](https://www.zoom.com/en/blog/how-you-zoomed-over-the-past-year-2021/)
- Frecuencias del cliente de Shareboard: `web/src/lib/config.ts` (`cursorThrottleMs: 45`, `previewThrottleMs: 33`, `heartbeatMs: 20000`)
