# Shareboard: análisis de rendimiento

Proyecto final de Arquitectura de computadores: ¿en qué máquina debería correr [Shareboard](https://github.com/Juan17la/shareboard_server) y con qué datos lo sostenemos?

Se midieron CPU (total, por núcleo y por hilo), memoria residente, disco (IOPS, MB/s, %util), red y latencia p50/p95/p99 bajo carga continua y sostenida. Las mismas cuatro pruebas corrieron en cuatro entornos: el PC físico, un contenedor con 1 CPU, un contenedor con 2 CPU y una instancia AWS EC2.

**Resultado en una línea:** Shareboard espera en la CPU. El cuello está en el hilo único de JavaScript (tiempo real) y en el threadpool de scrypt (login), no en el disco, la memoria ni la red. El PC sostiene 600 usuarios activos, el contenedor de 2 CPU 240, el de 1 CPU 120 y la t3.small menos de 120.

## Documentación

| Documento | Contenido |
|---|---|
| [docs/SETUP-LOCAL.md](docs/SETUP-LOCAL.md) | Instalar y correr las pruebas en una máquina local (Debian/Ubuntu, Arch, Windows con WSL2) |
| [docs/SETUP-DOCKER.md](docs/SETUP-DOCKER.md) | El mismo servidor en un contenedor con límites de CPU y memoria |
| [docs/SETUP-AWS.md](docs/SETUP-AWS.md) | Servidor y generador en EC2, y cómo traer los resultados |
| [docs/CARGAS.md](docs/CARGAS.md) | Cómo se diseñaron los niveles de carga: flujo de usuario, ley de Little, usuarios por segundo, por minuto y totales |
| [docs/MEDICIONES.md](docs/MEDICIONES.md) | Qué se midió, de dónde sale cada número y todas las tablas por carga y entorno |
| [docs/COMPARACIONES.md](docs/COMPARACIONES.md) | Por qué cada entorno da lo que da, fichas técnicas y precios |
| [docs/CONCLUSIONES.md](docs/CONCLUSIONES.md) | Las cuatro preguntas del proyecto, con la causa en el código y en el hardware, y cómo solucionarla |

## Qué hay en el repositorio

| Carpeta | Contenido |
|---|---|
| `telemetry/` | El laboratorio: interfaz web (`lab.mjs`), generador de carga, agente de telemetría, pruebas (`profiles/`), guion de campaña (`campana.mjs`) y generador de tablas (`tablas.mjs`) |
| `resultados/` | Datos crudos oficiales, segundo a segundo (`pc/`, `docker-1cpu/`, `docker-2cpu/`, `aws/`). `anteriores/` guarda corridas del modelo de carga anterior |
| `servidor/` | Copia exacta del servidor Shareboard que se midió |
| `envs/` | Docker Compose de MongoDB y del servidor con límites |
| `setup/ec2-preparar.sh` | Instalación de una instancia EC2 con un comando |

## Uso rápido

Requisitos: Linux (o WSL2), Node 22 y Docker.

```bash
git clone https://github.com/Juan17la/shareboard_perf.git
cd shareboard_perf
node telemetry/lab.mjs          # abre http://localhost:7070
```

Elige el entorno, pulsa **Preparar** y corre las pruebas. Los resultados se descargan desde la misma página (CSV y NDJSON).

## Licencia

[MIT](LICENSE).
