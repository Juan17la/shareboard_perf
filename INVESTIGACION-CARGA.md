# Carga realista para Shareboard

Investigación para definir **qué hace un usuario real**, **cuántos usuarios son una carga pequeña, mediana y grande** para una aplicación poco conocida, y **qué pruebas sostenidas de 5 minutos** reflejan eso.

> **Actualización (2 nov 2026): la carga ahora rota sin parar.** Con sesiones de 40 min, en una prueba de 5 minutos casi nadie salía y, al llegar al número de usuarios, ya no había más logins: la carga dejaba de ejercitar la entrada. Ahora la sesión media es de **2 minutos** y las pruebas son por **ritmo de llegada**: 120 activos (1/s), **240 activos (2/s)**, 600 activos (5/s) y escalones hasta 8/s, con 10 minutos medidos. Unos usuarios salen y otros entran durante toda la prueba (ley de Little: llegadas = activos ÷ sesión). 2/s son 7.200 sesiones por hora y 5/s son 18.000: el tráfico de hora pico de una app web con decenas de miles de usuarios activos al día. Las tablas de abajo (40 min, 25/250/1.000 usuarios) quedan como antecedente; la definición vigente está en [PRUEBAS.md](PRUEBAS.md#2-las-cinco-pruebas).

---

## 1. Resumen

| Carga | Usuarios registrados (MAU) | Activos al día (DAU) | **Concurrentes en la hora pico** | Tableros abiertos |
|---|---|---|---|---|
| Pequeña | 1.000 | 200 | **25** | 3 |
| Mediana | 10.000 | 2.000 | **250** | 46 |
| Grande | 50.000 | 10.000 | **1.000** | 184 |

- Un usuario real **no** está dibujando todo el tiempo. Pasa más de la mitad de la sesión mirando, una cuarta parte moviendo el cursor y cerca de un 12 % dibujando.
- Lo que más tráfico genera no son las peticiones REST sino el **tiempo real**: cursor (hasta 22 mensajes/s) y vista previa del trazo (hasta 30 mensajes/s), que el servidor reenvía a todos los del tablero.
- Por eso importa **cómo se agrupan**: 30 personas en una clase pesan mucho más que 30 personas en 6 equipos de 5.
- Propuesta: 6 pruebas, cada una con **5 minutos de medición estable** después de 1 minuto de llegada.

---

## 2. Lo que hace hoy el cliente de Shareboard (medido en el código)

Antes de suponer nada, revisamos qué envía el cliente web real (`web/src/lib/config.ts` y `web/src/hooks/use-board-sync.ts`):

| Mensaje | Cuándo se envía | Frecuencia máxima | Qué hace el servidor |
|---|---|---|---|
| `cursor` | Mientras el mouse se mueve sobre el tablero | 1 cada 45 ms (**~22/s**) | Lo reenvía a todos los demás del tablero |
| `preview` | Mientras se dibuja o se arrastra algo | 1 cada 33 ms (**~30/s**), con el trazo completo hasta ese punto | Lo reenvía a todos los demás |
| `op` | Al soltar el lápiz o terminar un cambio | Agrupado cada 50 ms | Lo aplica, lo reenvía a todos y lo guarda en Mongo (agrupado cada 1 s) |
| `select` | Al cambiar la selección | 1 cada 45 ms | Reenvía la lista de participantes |
| `ping` | Siempre | 1 cada **20 s** | Contesta solo a quien lo envió |
| REST | Login, listar tableros, unirse, crear | Pocas veces por sesión | Mongo + scrypt en el login |

**Diferencias con el generador actual:**

| Aspecto | Generador actual | Cliente real |
|---|---|---|
| Cursor | 5/s constantes, siempre | Hasta 22/s, **solo mientras el mouse se mueve** |
| Vista previa del trazo | No se envía | 30/s mientras se dibuja, con mensajes que crecen con el trazo |
| Actividad | Todos dibujan igual | Unos dibujan, la mayoría mira |
| Ping | Cada 10 s | Cada 20 s |
| Sesión | 3 a 5 min y vuelve a hacer login | Una reunión o clase dura 30 a 60 min |

El generador actual exagera el cursor de los que miran y omite la vista previa de los que dibujan, que es el mensaje más pesado.

---

## 3. Flujo realista por usuario

### 3.1 La sesión

```
login ─► lista sus tableros ─► se une a un tablero ─► [ sesión en el tablero: 30 a 60 min ] ─► sale
                                                      │
                                                      └─ cada ~5 min vuelve a listar sus tableros
```

- **Duración:** la guía más repetida para una sesión de lluvia de ideas es de unos 30 minutos (rango de 15 a 45). Una reunión de Zoom promedió 54 minutos en 2021. Usamos **40 minutos** de promedio.
- **Login:** una vez por sesión. Con sesiones de 40 min, en estado estable entra **1 de cada 2.400 usuarios por segundo** por Little's law (llegadas = usuarios / duración). Ejemplo: 250 usuarios generan un login cada 10 s. Los logins masivos solo ocurren al **inicio de una clase**, y eso tiene su propia prueba.

### 3.2 Dentro del tablero: cuatro estados

Un usuario alterna entre estados. Cada estado dura un tiempo aleatorio (distribución exponencial, para que no se sincronicen):

```
            ┌────────── Mirando ───────────┐
            │  solo ping cada 20 s          │
            │  ~55 % del tiempo, 5 a 30 s   │
            └──────┬───────────────▲────────┘
                   │               │
            ┌──────▼───────────────┴────────┐
            │  Moviendo el cursor           │
            │  ~22 cursores/s               │
            │  ~25 % del tiempo, 1 a 4 s    │
            └──────┬───────────────▲────────┘
                   │               │
     ┌─────────────▼──┐       ┌────┴────────────────┐
     │  Dibujando      │       │  Moviendo un objeto │
     │  ~12 %, 1 a 3 s │       │  ~8 %, 1 a 2 s      │
     │  cursor 22/s +  │       │  cursor + preview   │
     │  preview 30/s + │       │  + 1 op al soltar   │
     │  1 op al soltar │       │                     │
     └─────────────────┘       └─────────────────────┘
```

Los porcentajes son un supuesto de diseño (no encontramos mediciones publicadas de Miro o Excalidraw). Se justifican así: en una reunión solo habla una persona a la vez y el resto escucha. En lluvias de ideas todos aportan, pero en ráfagas cortas.

### 3.3 Dos roles

| Rol | Dónde aparece | Mirando | Cursor | Dibujando | Moviendo |
|---|---|---|---|---|---|
| **Colaborador** | Equipos de trabajo | 55 % | 25 % | 12 % | 8 % |
| **Presentador** | El profesor de una clase | 20 % | 35 % | 35 % | 10 % |
| **Espectador** | Los estudiantes de una clase | 85 % | 12 % | 3 % | 0 % |

### 3.4 Mensajes por segundo que eso produce (promedio)

| Rol | Cursor | Preview | Op | Total enviado |
|---|---|---|---|---|
| Colaborador | 22 x (0,25 + 0,12 + 0,08) ≈ 9,9 | 30 x (0,12 + 0,08) ≈ 6,0 | ~0,1 | **≈ 16/s** |
| Presentador | 22 x 0,80 ≈ 17,6 | 30 x 0,45 ≈ 13,5 | ~0,2 | **≈ 31/s** |
| Espectador | 22 x 0,15 ≈ 3,3 | 30 x 0,03 ≈ 0,9 | ~0,01 | **≈ 4/s** |

Lo que **recibe** cada uno depende del tablero, porque el servidor reenvía cada mensaje a los demás:

| Tablero | Mensajes que el servidor envía por segundo |
|---|---|
| Equipo de 5 colaboradores | 5 x 16 x 4 ≈ **320/s** |
| Clase de 30 (1 presentador + 29 espectadores) | (31 + 29 x 4) x 29 ≈ **4.300/s** |

Una clase de 30 genera unas 13 veces más trabajo que un equipo de 5, aunque tiene 6 veces más personas. Es el efecto cuadrático que ya vimos en la prueba Forma.

---

## 4. ¿Cuántos usuarios es una carga pequeña, mediana y grande?

### 4.1 Método

La fórmula estándar (documentación de k6 y BlazeMeter) parte de la hora pico:

```
usuarios concurrentes = sesiones en la hora pico x duración de la sesión (s) / 3.600
```

Y para llegar a las sesiones en la hora pico desde usuarios registrados:

| Paso | Valor usado | Fuente o razón |
|---|---|---|
| DAU / MAU | **20 %** | En SaaS B2B el rango típico es 10 a 20 %, con mediana cercana al 13 %. Usamos el borde alto porque una herramienta de clase o de equipo se abre varios días por semana |
| Sesiones por usuario activo al día | **1,2** | Una reunión o clase, a veces dos |
| Parte del día en la hora pico | **15 %** | Uso concentrado en horario de clase y oficina (7 a 18 h). Da un pico de unas 3,6 veces el promedio, dentro del rango de 2 a 5 veces que citan las guías |
| Duración de la sesión | **40 min** | Sección 3.1 |

### 4.2 Cálculo

| | Pequeña | Mediana | Grande |
|---|---|---|---|
| Ejemplo real | Una facultad o unos pocos cursos | Una universidad mediana o varias empresas pequeñas | Una app de nicho con algo de éxito en la región |
| MAU | 1.000 | 10.000 | 50.000 |
| DAU (20 %) | 200 | 2.000 | 10.000 |
| Sesiones al día (x 1,2) | 240 | 2.400 | 12.000 |
| Sesiones en la hora pico (15 %) | 36 | 360 | 1.800 |
| **Concurrentes** (x 2.400 s / 3.600) | **24 → 25** | **240 → 250** | **1.200 → 1.000 a 1.200** |
| Comprobación: 10 a 20 % del DAU | 20 a 40 ✓ | 200 a 400 ✓ | 1.000 a 2.000 ✓ |

Para "Grande" usamos **1.000**: es el borde bajo y ya representa una app que dejó de ser poco popular.

### 4.3 Cómo se reparten en tableros

Supuesto de uso para una herramienta de clase y de equipo: cerca de la mitad de la gente en clases, el resto en equipos y algunos trabajando solos. Las reuniones en línea promedian entre 7 y 10 personas (datos de Zoom 2021 y 2022). Usamos equipos de 5 como caso típico y clases de 30 como el grupo grande.

| Carga | Clases (1 presentador + espectadores) | Equipos de 5 | Solos | Total | Tableros |
|---|---|---|---|---|---|
| Pequeña | 1 clase de 15 | 2 | 0 | **25** | 3 |
| Mediana | 4 clases de 30 | 22 | 20 | **250** | 46 |
| Grande | 16 clases de 30 | 88 | 80 | **1.000** | 184 |

---

## 5. Pruebas propuestas

Todas con el flujo realista de la sección 3. Cada una: **1 minuto de llegada** (los usuarios entran escalonados) y **5 minutos de medición estable**. Así se cumple la "carga sostenida" del enunciado y cada máquina se compara con exactamente la misma carga.

| # | Prueba | Qué simula | Usuarios | Duración |
|---|---|---|---|---|
| 1 | **Reposo** | Servidor encendido sin nadie | 0 | 3 min |
| 2 | **Pequeña** | Hora pico de 1.000 usuarios registrados | 25 | 6 min |
| 3 | **Mediana** | Hora pico de 10.000 usuarios registrados | 250 | 6 min |
| 4 | **Grande** | Hora pico de 50.000 usuarios registrados | 1.000 | 6 min |
| 5 | **Inicio de clase** | Mediana estable y, a mitad de la prueba, 4 clases nuevas de 30 entran en 60 s (120 logins de golpe) | 250 → 370 | 8 min |
| 6 | **Escalones** | El mismo flujo creciendo sin pausa, 5 min medidos en cada nivel | 250 → 370 → 450 → 500 → 1.000 | 30 min |

- Las pruebas 2, 3 y 4 responden **"¿soporta la carga?"** en cada máquina, con el mismo número para las tres.
- La 5 responde qué pasa con un **pico real** (logins con scrypt + clases nuevas).
- La 6 responde **"¿cuántos aguanta?"** y "¿qué se rompe primero con más carga?". Reemplaza a la Escalera actual, pero con usuarios realistas.
- Salen la Forma, la Tormenta y la Resistencia actuales: sus preguntas quedan cubiertas por la mezcla de clases y equipos, por el Inicio de clase y por los Escalones.

### Criterio de buen rendimiento (sin cambios)

p95 REST < 300 ms · p95 login < 1 s · p95 difusión < 150 ms · p99 ping < 100 ms · errores < 1 %.

---

## 6. Cómo quedó implementado

1. **Máquina de estados por usuario** (mirando, cursor, dibujando, moviendo) con duraciones aleatorias exponenciales (`telemetry/vu-worker.mjs`, parámetros en `telemetry/profiles/flujo.json`).
2. **Roles** (colaborador, presentador, espectador) y **grupos mixtos** en bloques de 250 (`telemetry/lib/layout.mjs`). La carga grande son 4 bloques: 16 clases, 88 equipos y 80 solos.
3. **Mensajes `preview`** a 30/s mientras dibuja, con el trazo creciendo, como el cliente real.
4. **Cursor a 22/s** solo mientras se mueve; **ping cada 20 s**.
5. **Sesiones largas** (40 min promedio): en una prueba de 6 minutos casi nadie sale; los logins vienen de la llegada inicial y del Inicio de clase.

---

## 7. Supuestos y límites

- Los porcentajes de tiempo por estado (sección 3.2) son un **supuesto razonado**, no una medición. No encontramos datos públicos de Miro, Excalidraw o tldraw sobre cuánto tiempo dibuja cada persona. Si alguien pregunta en la sustentación, la respuesta es: "lo definimos así; los porcentajes están en un solo archivo (flujo.json) y se pueden variar para ver cuánto cambia el límite".
- Los 15 % de hora pico y 20 % DAU/MAU son valores típicos para SaaS B2B. Una app de colegio podría concentrar más el uso (pico mayor).
- El cliente móvil puede enviar a otras frecuencias. Se usa el cliente web como referencia.
- Toda la carga sale de una sola máquina. Por eso se sigue vigilando que el generador no se sature.

---

## Fuentes

- Cálculo de usuarios concurrentes desde sesiones en la hora pico: [Grafana k6, Calculate concurrent users](https://grafana.com/docs/k6/latest/testing-guides/calculate-concurrent-users/), [BlazeMeter](https://www.blazemeter.com/blog/calculate-concurrent-users-performance-testing)
- Pico de 2 a 5 veces el promedio y concurrencia de 10 a 20 % del DAU: [Zenocloud](https://zenocloud.io/blog/load-test/load-test-concurrent-visitors-google-analytics/), [LoadFocus](https://loadfocus.com/blog/2025/04/calculate-concurrent-users)
- Little's law con tiempo de pensar y modelado de sesiones: [Microsoft TestingSpot](https://techcommunity.microsoft.com/blog/testingspotblog/little-law-of-queuing-theory-and-how-it-impacts-load-testers/367620), [OneUptime](https://oneuptime.com/blog/post/2026-09-08-production-load-test-sessions-think-time-traffic-mix/view), [LoadView](https://www.loadview-testing.com/blog/load-testing-think-time-pacing-and-delays/)
- DAU/MAU en SaaS B2B (10 a 20 %, mediana cercana al 13 %): [Gainsight](https://www.gainsight.com/essential-guide/product-management-metrics/dau-mau/), [Alexander Jarvis](https://www.alexanderjarvis.com/what-is-dau-to-mau-ratio-in-saas/)
- Tamaño y duración de reuniones (Zoom: 10 personas y 54 min en 2021; 7 personas en 2022): [Zoom, How you Zoomed over the past year](https://www.zoom.com/en/blog/how-you-zoomed-over-the-past-year-2021/), [Notta, meeting statistics](https://notta.ai/en/blog/meeting-statistics)
- Duración de sesiones de lluvia de ideas (~30 min, rango 15 a 45): [Ideanote](https://ideanote.io/fr/faq/how-long-should-a-brainstorming-session-last), [Calendar UK](https://www.calendar-uk.co.uk/frequently-asked-questions/how-long-is-a-brainstorming-session)
- Frecuencia de cursores en herramientas colaborativas (Liveblocks: 100 ms por defecto, 16 ms = 60 fps): [Liveblocks, live cursors](https://liveblocks.io/docs/tutorial/react/getting-started/live-cursors), [Liveblocks, animating multiplayer cursors](https://liveblocks.io/blog/how-to-animate-multiplayer-cursors)
- Envío agrupado a 60 fps en tldraw sync: [Grida, tldraw sync architecture](https://grida.co/docs/wg/research/crdt/tldraw)
- Tamaños máximos de tablero en Miro (eventos de 250 a 370 personas): [Miro Help Center](https://help.miro.com/hc/articles/360013912300), [Miro, collaboration trends](https://miro.com/blog/collaboration-trends/)
- Frecuencias del cliente de Shareboard: `web/src/lib/config.ts` (`cursorThrottleMs: 45`, `previewThrottleMs: 33`, `heartbeatMs: 20000`) y `web/src/hooks/use-board-sync.ts`
