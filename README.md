# Shareboard: análisis de rendimiento

Laboratorio de carga para el proyecto final de Arquitectura de computadores: ¿en qué máquina debería correr [Shareboard](https://github.com/Juan17la/shareboard_server) y con qué datos lo sostenemos?

Mide CPU (total, por núcleo y por hilo), memoria residente, disco (IOPS y MB/s), red y latencia p50/p95/p99 bajo una carga realista sostenida, y compara un PC físico, un contenedor con límites y una instancia EC2 con las mismas pruebas.

## Qué hay aquí

| Carpeta | Contenido |
|---|---|
| `telemetry/` | El laboratorio: interfaz web, generador de carga, agente de telemetría, pruebas (`profiles/`) |
| `servidor/` | Copia exacta del servidor Shareboard que se midió (en el PC de desarrollo se usa `../server`) |
| `envs/` | Docker Compose de MongoDB y del servidor en contenedor con límites |
| `resultados/` | Corridas oficiales (`.ndjson`) y sus tablas |
| `setup/` | Guías: [laboratorio local](setup/SETUP.md), [AWS con capa gratuita](setup/AWS-GRATIS.md), instalación a mano del [servidor](setup/EC2-SERVIDOR.md) y del [generador](setup/EC2-GENERADOR.md) en EC2 |
| `PLAN.md`, `INVESTIGACION-CARGA.md`, `PRUEBAS.md` | Plan, investigación de la carga y protocolo de pruebas |

## Uso rápido

Requisitos: Linux, Node 22 (`nvm install 22`) y Docker.

```bash
git clone https://github.com/Juan17la/shareboard_perf.git
cd shareboard_perf
node telemetry/lab.mjs
```

Abre http://localhost:7070, elige el entorno, pulsa **Preparar** y corre las pruebas.

En EC2, un solo comando por instancia (ver [setup/AWS-GRATIS.md](setup/AWS-GRATIS.md)):

```bash
curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s servidor    # o: generador
```

## Licencia

[PolyForm Noncommercial 1.0.0](LICENSE).
