# Pruebas y cómo compararlas

Este documento dice **qué pruebas correr, en qué orden y en qué condiciones** para que los resultados del PC, del contenedor y de EC2 se puedan comparar y sacar conclusiones. El porqué de cada número está en [`INVESTIGACION-CARGA.md`](INVESTIGACION-CARGA.md). Cómo arrancar el laboratorio está en [`setup/SETUP.md`](setup/SETUP.md).

---

## 1. Cómo se genera la carga

Cada usuario virtual hace lo mismo que el cliente web real:

```
login ─► lista sus tableros ─► se une a SU tablero ─► sesión de ~40 min ─► sale y entra "otra persona"
```

Dentro del tablero alterna cuatro estados con duraciones aleatorias:

| Estado | Qué envía | Duración media |
|---|---|---|
| Mirando | Nada (solo ping cada 20 s) | 12 s |
| Cursor | Cursor cada 45 ms (~22/s) | 2,5 s |
| Dibujando | Cursor + preview del trazo cada 33 ms (~30/s) + el trazo final al soltar | 2 s |
| Moviendo | Selección + cursor + preview del movimiento cada 33 ms + el cambio al soltar | 1,5 s |

Cuánto tiempo pasa en cada estado depende del **rol**:

| Rol | Dónde | Mirando | Cursor | Dibujando | Moviendo |
|---|---|---|---|---|---|
| Colaborador | Equipos y personas solas | 55 % | 25 % | 12 % | 8 % |
| Presentador | 1 por clase | 20 % | 35 % | 35 % | 10 % |
| Espectador | El resto de la clase | 85 % | 12 % | 3 % | 0 % |

Los usuarios se reparten en **bloques de 250**: 4 clases de 30, 22 equipos de 5 y 20 personas solas (46 tableros). Las cargas más grandes repiten el bloque.

Todo esto está en `telemetry/profiles/flujo.json` (flujo y roles) y en cada `telemetry/profiles/N-*.json` (pruebas). Comprobado en una corrida: el 68,4 % del tiempo los usuarios estuvieron mirando, que es exactamente lo que da la mezcla de roles.

**Buen rendimiento:** p95 REST < 300 ms · p95 login < 1 s · p95 trazo terminado y p95 preview < 150 ms · p99 ping < 100 ms · errores < 1 %. A las latencias del cliente se les resta el RTT de red medido sin carga.

---

## 2. Las pruebas

La carga **no se detiene** cuando se llega al número de usuarios: cada prueba mantiene un número fijo de **usuarios activos** y, durante toda la prueba, unos terminan su sesión y salen mientras otros entran. Por la ley de Little:

> usuarios activos = llegadas por segundo × duración media de la sesión (2/s × 120 s = **240**)

Cada llegada hace lo que haría una persona real:

| Al entrar | Proporción |
|---|---|
| Inicia sesión (login) | 95 % |
| Se registra como cuenta nueva (scrypt + escritura en Mongo) | 5 % |
| Lista sus tableros | 100 % (y de nuevo cada ~5 min) |
| Crea un tablero | 5 % |
| Se une a su tablero y trabaja (mira, mueve el cursor, dibuja, mueve elementos) según su rol | 100 % |

**Todas las pruebas duran lo mismo (12,5 min)**; solo cambia el nivel de carga: 2 min de llegada, 30 s de estabilización y **10 minutos medidos**.

| # | Prueba | Entran y salen | Sesión media | Usuarios activos | Sesiones por hora | Duración | Pregunta |
|---|---|---|---|---|---|---|---|
| 1 | Reposo | – | – | 0 | – | 12,5 min | ¿Cuánto consume la máquina sin nadie? |
| 2 | Carga baja | 1/s | 2 min | 120 | 3.600 | 12,5 min | Un colegio o una facultad en hora pico |
| 3 | Carga media | 2/s | 2 min | 240 | 7.200 | 12,5 min | Varias facultades o empresas pequeñas a la vez |
| 4 | Carga alta | 2/s | 5 min | 600 | 7.200 | 12,5 min | Una universidad grande: clases y reuniones largas, mucho tiempo real |
| 5 | Server killer | 20/s | 5 min | 6.000 | 72.000 | 12,5 min | La alta x10: ¿qué se rompe primero y cómo cae? |

Baja y media se diferencian en el **ritmo de entrada** (logins y registros: CPU por scrypt). Media y alta tienen el mismo ritmo de entrada, pero en la alta la gente se queda más: se diferencian en el **tiempo real** (cursores y trazos que se reenvían a todo el tablero). Server killer no está hecha para pasar; si los errores pasan del 20 % o el contenedor llega al 95 % de su memoria, el laboratorio la corta y anota el motivo.

En la página, la gráfica **Entradas y salidas** muestra que los logins siguen hasta el último segundo.

La casilla **rápida** mide 3 minutos en lugar de 10. Sirve para ensayar; **para el informe usa siempre la versión normal**.

---

## 3. Reglas para que la comparación sea justa

Lo que **debe ser igual** en las tres máquinas:

| Qué | Cómo se asegura |
|---|---|
| Mismo código del servidor | No cambies `server/` durante la campaña. Anota el commit (`git -C server log -1 --oneline`) |
| Misma versión de Node | El laboratorio usa Node 22 en el PC; en EC2 se instala `nvm install 22` |
| Misma base de datos | **Reiniciar datos** antes de empezar cada máquina: 6.000 cuentas y 6.000 tableros vacíos |
| Mismas pruebas | Versión normal (sin "rápida"), mismos perfiles |
| Servidor en frío | El laboratorio reinicia el servidor antes de cada prueba (automático) |
| Mismo criterio | Los umbrales están en los perfiles; no los cambies entre máquinas |

Lo que **cambia a propósito** (es lo que comparamos): la máquina, los límites del contenedor y la red.

---

## 4. Procedimiento por máquina

### 4.1 Antes de empezar (cada máquina)

1. Arranca el laboratorio (`node analitics/telemetry/lab.mjs`) y abre http://localhost:7070.
2. Elige el entorno y pulsa **Preparar**. Espera los cuatro puntos verdes.
3. Pulsa **Reiniciar datos** (deja la base igual que en las otras máquinas).
4. **No mires la página en vivo durante las pruebas largas**: el navegador gasta CPU del mismo PC. Revisa todo después en **Resultados**.

Solo en el PC (nativo y contenedores):

- Conectado a la corriente: `powerprofilesctl set performance`.
- Cierra el IDE, el navegador con muchas pestañas y cualquier servidor de desarrollo.
- Espera 2 minutos entre pruebas para que baje la temperatura (la verás en el registro de la máquina, gráfica de CPU por núcleo).

### 4.2 Orden de las pruebas

| Paso | Prueba | PC nativo | Contenedor 1 CPU | Contenedor 2 CPU | EC2 t3.small |
|---|---|---|---|---|---|
| 1 | Reposo | ✓ | ✓ | ✓ | ✓ |
| 2 | Carga baja | ✓ x2 | ✓ x2 | ✓ x2 | ✓ x2 |
| 3 | Carga media | ✓ x2 | ✓ x2 | ✓ x2 | ✓ x2 |
| 4 | Carga alta | ✓ x2 | ✓ x2 | ✓ x2 | ✓ x2 |
| 5 | Server killer | ✓ | ✓ | ✓ | ✓ (al final) |
| | **Tiempo aproximado** | ~2 h | ~2 h | ~1,5 h | ~2 h |

- **x2:** las tres cargas se corren dos veces. Si el p95 de las dos difiere más de 20 %, corre una tercera y usa la mediana. Así puedes decir en la sustentación que el número es estable.
- **Contenedor 2 CPU:** solo repite lo necesario para responder "¿un segundo núcleo le sirve a un servidor con un solo hilo de JavaScript?".
- **EC2:** Server killer va al final, porque es la que gasta los créditos de CPU de la t3. Antes de empezar anota en CloudWatch el `CPUCreditBalance`.

### 4.3 Qué revisar después de cada prueba

En **Resultados**, abre la corrida y confirma:

- **No válido:** si aparece "Generador saturado", repítela (el PC de carga no dio abasto).
- **Errores:** si hay errores, mira el código en la columna Motivo (por ejemplo `login:TIMEOUT`).
- **Usuarios:** la gráfica Usuarios debe mostrar que los conectados llegaron al objetivo. Si no llegaron, eso ya es un resultado: la máquina no pudo aceptarlos.

---

## 5. Cómo sacar las conclusiones

### 5.1 Tabla comparativa (una columna por máquina)

Las tablas con todas las métricas que pide el enunciado salen solas de los archivos:

```bash
node analitics/telemetry/report.mjs analitics/data/raw/<corrida-pc>.ndjson analitics/data/raw/<corrida-docker>.ndjson > analitics/resultados/TABLAS.md
```

| | PC nativo | Contenedor 1 CPU | Contenedor 2 CPU | EC2 t3.small |
|---|---|---|---|---|
| Pequeña (25): ¿pasa? p95 preview | | | | |
| Mediana (250): ¿pasa? p95 preview | | | | |
| Grande (1.000): ¿pasa? p95 preview | | | | |
| Última carga que pasa (baja, media o alta) y qué rompió primero en Server killer | | | | |
| Hilo JS en el máximo (%) | | | | |
| RSS del servidor en el máximo (MB) | | | | |
| Disco en el máximo (IOPS) | | | | |
| Red de salida en el máximo (MB/s) | | | | |
| Costo al mes (USD) | | | | |
| **Costo por cada 100 usuarios** | | | | |

### 5.2 Dónde espera la aplicación

En la **primera carga que falla** (o en Server killer), mira en este orden:

| Si ves esto | Espera por | Componente |
|---|---|---|
| Hilo JavaScript cerca de 100 % y los demás núcleos libres | CPU, un solo núcleo | El hilo principal de Node (un solo núcleo hace todo el reenvío) |
| libuv alto y logins lentos | CPU del threadpool | scrypt en los 4 hilos de libuv |
| Contenedor frenado alto | Cuota de CPU | El límite `cpus` del cgroup |
| iowait alto, disco muy ocupado | Disco | El SSD o el volumen EBS (gp3) |
| Red de salida cerca del límite, retransmisiones | Red | La interfaz o el ancho de banda de la instancia |
| steal alto (solo EC2) | Hipervisor | La nube le da CPU a otra máquina virtual |
| Memoria en la línea roja | Memoria | El límite del contenedor (riesgo de OOM) |

### 5.3 Preguntas de la sustentación

| Pregunta | Dónde está la respuesta |
|---|---|
| ¿Por qué ese número? ¿Cómo lo midieron? | Tabla de escalones de la corrida + este documento (flujo, criterios) |
| ¿Qué componente lo causa? | Sección 5.2 con las gráficas del escalón que falla |
| Si la carga fuera 10x, ¿qué se rompe primero? | Escalones (qué recurso llega primero al límite entre 500 y 1.000) |
| ¿Qué opción descartaron y por qué? | Tabla 5.1: la que no soporta la carga objetivo o la de peor costo por 100 usuarios |

---

## 6. Primeros resultados (PC nativo, versión rápida, 30 de octubre)

Sirven para saber qué esperar, no para el informe.

| Carga | Resultado | Hilo JS | p95 preview | Detalle |
|---|---|---|---|---|
| Mediana (250) | ✓ pasa | 26 % (pico 42 %) | 1,3 ms | Los clientes reciben ~24.000 mensajes/s; red 16 MB/s |
| Grande (1.000) | ✕ no pasa | **99 %** | 1.177 ms | Solo 394 de 1.000 lograron conectarse; los logins se agotan por timeout. El generador estaba al 34 % (medición válida) |

Primera conclusión a confirmar con las versiones normales: en el PC el límite está entre 250 y 1.000 usuarios, y lo marca **el único hilo de JavaScript** reenviando cursores y previews, no el disco ni la memoria.
