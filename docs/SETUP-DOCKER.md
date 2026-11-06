# Instalación en contenedor con límites (Docker)

En este entorno el servidor corre dentro de un contenedor Docker con un **techo de CPU y de memoria**, en la misma máquina física que el entorno local. Así se aísla un solo factor: qué le pasa al mismo código, en el mismo hardware, cuando el kernel lo limita.

| Contenedor | CPU | Memoria | Núcleos permitidos |
|---|---|---|---|
| Servidor, "Contenedor 1 CPU" | 1 CPU (`cpus: 1`) | 512 MB, sin swap | P-cores 0-7 |
| Servidor, "Contenedor 2 CPU" | 2 CPU (`cpus: 2`) | 512 MB, sin swap | P-cores 0-7 |
| MongoDB (en ambos) | 1 CPU | 1 GB, sin swap | P-cores 0-7 |

Qué significa cada límite a nivel de kernel (cgroups v2):

- **`cpus: 1`** escribe `100000 100000` en `cpu.max`: el contenedor puede usar 100 ms de CPU cada 100 ms. Si los gasta antes (por ejemplo, con dos hilos ocupados a la vez), el planificador lo **frena** el resto del periodo. Ese freno queda en `cpu.stat` (`throttled_usec`), y el laboratorio lo grafica como **Contenedor frenado**.
- **`mem_limit: 512m`** con `memswap_limit` igual escribe `memory.max`: si el proceso pasa de 512 MB, el kernel lo mata (OOM kill). El laboratorio corta la prueba al 95 % para registrar el motivo.
- **`cpuset: 0-7`** lo deja en los mismos núcleos rápidos que el servidor nativo, para que la única diferencia sea el techo.

Los límites están en `envs/compose.container.yml`.

---

## 1. Requisitos

Los mismos del [entorno local](SETUP-LOCAL.md#1-requisitos): Linux (o WSL2), Git, Node 24 y Docker con Compose v2. Además, Docker debe usar **cgroups v2** (por defecto desde Debian 11, Ubuntu 21.10 y Arch desde 2021):

```bash
docker info --format '{{.CgroupVersion}}'   # debe responder 2
```

---

## 2. Instalación de Docker

### 2.1 Debian 12/13 y Ubuntu 22.04/24.04

```bash
sudo apt-get update
sudo apt-get install -y git curl util-linux docker.io
sudo apt-get install -y docker-compose || sudo apt-get install -y docker-compose-v2
sudo usermod -aG docker $USER
newgrp docker
docker run --rm hello-world
```

Si prefieres la versión de Docker Inc. (más nueva): https://docs.docker.com/engine/install/debian/ (o `/ubuntu/`).

### 2.2 Arch Linux

```bash
sudo pacman -Syu --needed git curl util-linux docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
docker run --rm hello-world
```

### 2.3 Windows 10/11

1. Instala WSL2 con Ubuntu (ver [SETUP-LOCAL.md, sección 2.3](SETUP-LOCAL.md#23-windows-1011-con-wsl2)).
2. Instala **Docker Desktop** (https://www.docker.com/products/docker-desktop/) y activa *Settings → Resources → WSL integration → Ubuntu-24.04*.
3. Todo lo demás se hace dentro de Ubuntu (WSL).

En Docker Desktop los contenedores corren dentro de la máquina virtual de WSL2. Los límites `cpus` y `mem_limit` funcionan igual, pero se aplican sobre los recursos que Docker Desktop le dio a esa máquina virtual (*Settings → Resources*). Anótalos en el informe.

### 2.4 Node 24 y código

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 24
git clone https://github.com/Juan17la/shareboard_perf.git
cd shareboard_perf
```

---

## 3. Correr las pruebas

```bash
node telemetry/lab.mjs
```

En **http://localhost:7070**:

1. Elige **Contenedor 1 CPU · 512 MB** (o **2 CPU**) y pulsa **Preparar**. El laboratorio compila el servidor, construye la imagen (`node:24-slim` + `dist/`), levanta MongoDB y el servidor con sus límites, y crea los datos de prueba.
2. **Reiniciar datos**: deja la base igual que en los demás entornos.
3. Corre **Carga baja, media, alta y Server killer**. Cada una dura 12,5 minutos.

O todo seguido, en otra terminal:

```bash
node telemetry/campana.mjs --envs docker1,docker2
```

### Comprobar que los límites están puestos

Mientras corre una prueba:

```bash
docker stats --no-stream shareboard-carga-server-1
docker inspect shareboard-carga-server-1 --format 'CPU={{.HostConfig.NanoCpus}} MEM={{.HostConfig.Memory}} CPUSET={{.HostConfig.CpusetCpus}}'
cat /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' shareboard-carga-server-1).scope/cpu.max
```

Para 1 CPU, el último comando muestra `100000 100000`; para 2 CPU, `200000 100000`.

### Guardar los resultados

Igual que en local: botones **Resumen (.csv)**, **Por segundo (.csv)** y **Datos crudos (.ndjson)** debajo de cada corrida. Los archivos también quedan en `data/raw/<fecha>_docker-1cpu_<prueba>.ndjson` (o `docker-2cpu`).

---

## 4. Si algo falla

| Síntoma | Causa y solución |
|---|---|
| `permission denied … docker.sock` | Falta el grupo docker: `sudo usermod -aG docker $USER` y vuelve a iniciar sesión |
| La prueba se corta con "memoria del contenedor al 95 %" | Es un resultado: el servidor no cabe en 512 MB con esa carga. Queda anotado en el motivo |
| `Contenedor frenado` siempre en 0 con carga alta | Docker no usa cgroups v2 (`docker info`), los límites no se aplican |
| `port is already allocated` | Otro contenedor usa el 3000 o el 27017: `docker ps` y detenlo |
