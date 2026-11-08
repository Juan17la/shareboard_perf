# Mejoras visibles del servidor corregido

Qué mejoró, entorno por entorno, entre el servidor de antes y el servidor con los cambios de capacidad ya corregidos (difusión sin espera de 25 ms y PIN con HMAC; ver [CAMBIOS-SERVIDOR.md](CAMBIOS-SERVIDOR.md)).

- **Antes:** servidor anterior con Node 22. PC y Docker del 4-nov (`resultados/2026-11-04/`), AWS del 5-nov (`resultados/2026-11-05/`).
- **Después:** servidor corregido con Node 24. PC y Docker del 7-nov, de 09:53 a 19:05, con el perfil de energía «balanced» y sin nada más en la máquina. AWS Unlimited del 7-nov, de 20:26 a 23:58 (`resultados/2026-11-07/aws-unlimited/`).
- **Mismas repeticiones que antes:** 3 en baja, media, alta y server killer, y 1 en capacidad 1.000, 2.000 y 3.000. Todas las cifras son medianas y los tiempos están en ms.
- **Cómo leer las tablas:** «antes → después». En **negrita**, los cambios grandes.

## En una línea

**Entrar es 5 veces más rápido en todos los entornos, y con carga alta el servidor responde de 2 a 15 veces más rápido y con menos CPU.** Con poca carga la diferencia es de décimas de milisegundo, y nadie la nota.

## 1. Registro e inicio de sesión (p50 de autenticación)

| Entorno | baja | media | alta | 1.000 | 2.000 | 3.000 |
|---|---|---|---|---|---|---|
| PC | **136 → 26** | **136 → 24** | **136 → 24** | **136 → 23** | **142 → 24** | **166 → 26** |
| Docker 1 CPU | **136 → 26** | **147 → 25** | **147 → 24** | **166 → 25** | **378 → 31** | 15.071 → 100 |
| Docker 2 CPU | **136 → 26** | **136 → 25** | **142 → 25** | **147 → 25** | **202 → 33** | — → 76 |
| AWS Unlimited | **255 → 55** | **265 → 49** | **298 → 53** | **408 → 57** | **1.007 → 100** | **895 → 236** |

La causa es el cambio de scrypt a Argon2id, que usa unas 6 veces menos CPU por inicio de sesión. En el p95 se ve lo mismo: de 142 a 227 ms bajó a entre 27 y 37 ms en el PC y en Docker.

## 2. Trazo que ven los demás (p95 de difusión)

| Entorno | baja | media | alta | 1.000 | 2.000 | 3.000 |
|---|---|---|---|---|---|---|
| PC | 0,58 → 1,01 | 0,61 → 0,80 | 0,77 → 0,71 | 1,09 → 0,83 | **2,4 → 1,3** | **13 → 2,9** |
| Docker 1 CPU | 0,74 → 0,97 | 0,77 → 0,90 | 1,09 → 0,86 | 1,62 → 1,28 | **70 → 33** | **629 → 236** |
| Docker 2 CPU | 0,74 → 1,01 | 0,80 → 0,83 | 0,97 → 0,90 | 1,33 → 1,18 | **16 → 5** | **442 → 82** |
| AWS Unlimited | 2,05 → 1,56 | 2,8 → 2,4 | 4,86 → 3,55 | **13 → 6,9** | **459 → 51** | **378 → 147** |

Con baja y media carga sube entre 0,2 y 0,4 ms en el PC y en Docker. Es lo que tarda una vuelta del event loop, que ahora se usa para juntar los envíos de cada cliente en una sola escritura. A partir de alta, el p95 baja en todos los entornos.

## 3. Respuesta del servidor (ping p95 / p99)

| Entorno y prueba | Antes | Después |
|---|---|---|
| PC, 3.000 | 14 / 47 | **1,6 / 4,3** |
| PC, server killer | 605 / 1.007 | **65 / 85** |
| Docker 1 CPU, 2.000 | 116 / 227 | **23 / 92** |
| Docker 1 CPU, 3.000 | 931 / 1.225 | **210 / 276** |
| Docker 2 CPU, 2.000 | 19 / 65 | **2,9 / 14** |
| Docker 2 CPU, 3.000 | 735 / 1.612 | **65 / 108** |
| AWS Unlimited, 2.000 | 735 / 1.047 | **40 / 147** |
| AWS Unlimited, 3.000 | 680 / 1.433 | **121 / 287** |

## 4. Entrar a un tablero (p95 de unirse)

| Entorno y prueba | Antes | Después |
|---|---|---|
| PC, 1.000 / 2.000 / 3.000 | 32 / 31 / 44 | **7,5 / 7,2 / 11** |
| Docker 1 CPU, 2.000 / 3.000 | 194 / 15.071 | **67 / 349** |
| Docker 2 CPU, 2.000 / 3.000 | 55 / 15.071 | **37 / 153** |
| AWS Unlimited, 2.000 / 3.000 | 15.071 / 15.071 | **131 / 276** |

15.071 ms es el tope del generador: antes, con 3.000 usuarios, la gente no lograba entrar, y ahora entra en menos de 0,4 s. Con poca carga sigue en unos 31 ms (ver [Lo que no mejoró](#lo-que-no-mejoró)).

## 5. CPU del servidor (%)

| Entorno | alta | 1.000 | 2.000 | 3.000 |
|---|---|---|---|---|
| PC | 19 → 18 | 30 → 27 | **54 → 44** | **84 → 68** |
| Docker 1 CPU | **25 → 20** | 38 → 36 | **77 → 67** | 100 → 99 |
| Docker 2 CPU | 24 → 22 | 36 → 33 | **83 → 71** | 128 → 120 |
| AWS Unlimited | **47 → 33** | **77 → 55** | 106 → 96 | 110 → 102 |

Con la misma carga, el servidor hace el mismo trabajo con menos CPU, y le queda margen para más usuarios. Con carga baja la CPU queda igual o sube poco (en el PC, de 4,2 a 5,7 %).

## 6. Pruebas que antes fallaban y ahora pasan o aguantan

| Entorno y prueba | Antes | Después |
|---|---|---|
| Docker 2 CPU, 3.000 | servidor caído el 70 % de la ventana; REST p95 de 15 s | **sin caídas**; solo falla el p99 de ping (105 ms > 100) y la memoria, al 95 % |
| Docker 1 CPU, 3.000 | REST p95 de 15 s (no respondía) | **REST p95 de 378 ms**, sin caídas; la memoria llega al 96 % |
| Docker 1 y 2 CPU, server killer | caído en las 3 repeticiones (100 % de conexiones rechazadas) | **aguanta 2 de 3** repeticiones |
| REST p95 con 3.000 (Docker 1 y 2 CPU) | 15.071 | **378 / 194** |

## Lo que no mejoró

- **La memoria sube entre 30 y 80 % en todos los entornos.** En el contenedor de 512 MB llega al 100 % en server killer y en 3.000, y es lo que tumba el servidor en la 3.ª repetición de server killer en Docker. En AWS el servidor se cae el 92 % de la ventana de server killer (antes, 45 %). La causa no está confirmada; los sospechosos son Node 24 y los 19 MiB de Argon2id por cada hash. **Es lo siguiente que hay que revisar.**
- **Entrar a un tablero con PIN y poca carga sigue en ~31 ms.** El seed restaura los PIN viejos (scrypt) antes de cada prueba, así que la primera entrada a cada tablero todavía paga scrypt y lo cambia a HMAC. En uso real eso pasa una sola vez por tablero.
- **AWS Limited no se pudo comparar.** La repetición del 8-nov no tuvo CPU robada (≈1 %, contra 54–71 % el 5-nov): el servidor no se quedó sin créditos, y por eso no se guardó como Limited. Hay que repetirla en Standard con los créditos agotados.
- **Node también cambió (22 → 24)**, así que las diferencias no son solo del código.
