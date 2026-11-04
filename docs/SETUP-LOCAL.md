# Instalación en una máquina local (servidor nativo)

En este entorno el servidor de Shareboard corre directamente sobre el sistema operativo, sin contenedor ni límites. MongoDB sí corre en Docker, en todos los entornos, para que la base de datos sea idéntica en todas las comparaciones.

Las tres funciones (servidor, generador de carga y agente de telemetría) están en la misma máquina, pero cada una en núcleos distintos. El laboratorio los reparte solo con `taskset`:

| Función | Núcleos en el PC medido (Core Ultra 5 125H) |
|---|---|
| Servidor y MongoDB | P-cores 0-7 (los más rápidos, hasta 4,5 GHz) |
| Generador de carga | E-cores 8-15 |
| Agente de telemetría | LP-cores 16-17 |

Así el generador no le roba CPU al servidor que se mide.

---

## 1. Requisitos

| Necesitas | Para qué |
|---|---|
| Linux con kernel 5.x o más nuevo | El agente lee `/proc`, `/sys` y los cgroups del kernel |
| Git y curl | Clonar el repositorio e instalar nvm |
| Node.js 22 (con nvm) | El laboratorio y el servidor |
| Docker y Docker Compose v2 | MongoDB (y el servidor en el entorno contenedor) |
| `taskset` (paquete `util-linux`) | Fijar núcleos. Viene instalado en casi todas las distribuciones |
| 8 GB de RAM o más | La carga alta mantiene 600 usuarios con sus sockets |

---

## 2. Instalación

### 2.1 Debian 12/13 y Ubuntu 22.04/24.04

```bash
sudo apt-get update
sudo apt-get install -y git curl util-linux docker.io
# Docker Compose v2: en Debian el paquete se llama docker-compose; en Ubuntu, docker-compose-v2
sudo apt-get install -y docker-compose || sudo apt-get install -y docker-compose-v2
sudo usermod -aG docker $USER
newgrp docker            # aplica el grupo sin cerrar sesión
docker compose version   # debe responder 2.x
```

### 2.2 Arch Linux (y Manjaro, EndeavourOS)

```bash
sudo pacman -Syu --needed git curl util-linux docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
docker compose version
```

### 2.3 Windows 10/11 (con WSL2)

El laboratorio no corre directamente en Windows: el agente lee `/proc` y los cgroups, que solo existen en Linux. Se usa WSL2, que ejecuta un kernel Linux real.

En **PowerShell como administrador**:

```powershell
wsl --install -d Ubuntu-24.04
```

Reinicia, abre **Ubuntu** desde el menú Inicio y crea tu usuario. Desde ahí sigue los pasos de Debian/Ubuntu (2.1) dentro de Ubuntu.

Para Docker hay dos opciones:

- **Docker Desktop para Windows** con *Settings → Resources → WSL integration* activado para Ubuntu-24.04. En ese caso omite `docker.io` y `docker-compose` en el paso 2.1.
- **Docker dentro de WSL** (paso 2.1 completo) y además, una vez: `sudo service docker start`.

Advertencia para el informe: en WSL2 la máquina medida es la máquina virtual de WSL (por defecto con el 50 % de la RAM de Windows y todos los núcleos), no Windows. Anótalo junto con el resultado.

### 2.4 Node.js 22 (todos los sistemas, dentro de Linux o WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
node --version   # v22.x
```

No hace falta cambiar la versión por defecto: el laboratorio busca Node 22 en `~/.nvm` y se relanza solo con ella.

### 2.5 Límite de archivos abiertos

Cada usuario virtual es un socket. El laboratorio sube el límite al máximo permitido, pero conviene que ese máximo sea alto:

```bash
printf '* soft nofile 65535\n* hard nofile 65535\n' | sudo tee /etc/security/limits.d/90-carga.conf
```

Cierra la sesión y vuelve a entrar para que aplique (`ulimit -Hn` debe mostrar 65535 o más).

---

## 3. Código

```bash
git clone https://github.com/Juan17la/shareboard_perf.git
cd shareboard_perf
```

`servidor/` es una copia exacta del servidor que se midió. Si trabajas dentro del proyecto Shareboard completo, el laboratorio usa `../server` en su lugar (orden de búsqueda: variable `SHAREBOARD_SERVER`, luego `../server`, luego `./servidor`).

---

## 4. Correr las pruebas

```bash
node telemetry/lab.mjs
```

Abre **http://localhost:7070**.

1. **Entorno:** elige **PC (nativo)** y pulsa **Preparar**. El laboratorio compila el servidor si cambió, levanta MongoDB en Docker, arranca el servidor y el agente, y crea los datos de prueba (1.500 cuentas y 2.000 tableros con contenido, 1 o 2 minutos la primera vez). Los cuatro puntos se ponen en verde.
2. **Reiniciar datos** antes de la primera prueba, para que la base sea igual en todos los entornos.
3. **Pruebas:** pulsa **Correr** en Carga baja, media, alta y Server killer, en ese orden. Cada una dura 12,5 minutos. Antes de cada prueba el servidor se reinicia, así siempre arranca con la memoria limpia.
4. **Resultados:** cada corrida queda en la lista. Clic en una para reproducirla.

### Guardar los resultados en tu equipo

Debajo de cada corrida hay tres botones:

| Botón | Contenido |
|---|---|
| **Resumen (.csv)** | Una fila por prueba: CPU (promedio, pico, núcleo más ocupado, us/sy/wa/id), RES, disco (IOPS, MB/s, %util), red y latencias p50/p95/p99 |
| **Por segundo (.csv)** | Una fila por segundo con las mismas métricas |
| **Datos crudos (.ndjson)** | Todo lo registrado; se vuelve a abrir con **Abrir archivo** |

Los CSV usan `;` y coma decimal (Excel en español los abre sin configurar nada). Los archivos crudos también quedan en `data/raw/<fecha>_<entorno>_<prueba>.ndjson`.

### Para que la medición sea limpia

- Portátil conectado a la corriente y en modo rendimiento: `powerprofilesctl set performance` (Debian/Ubuntu/Arch con GNOME o KDE).
- Cierra el IDE, el navegador con muchas pestañas y otros servidores.
- No mires la página en vivo durante las pruebas: el navegador gasta CPU del mismo equipo. Revisa todo después en **Resultados**.
- Espera un minuto entre pruebas para que baje la temperatura.

### Correr todo sin estar presente

Con el laboratorio abierto, en otra terminal:

```bash
node telemetry/campana.mjs --envs native
```

Corre las cuatro pruebas seguidas, con un minuto de pausa entre ellas. Es el guion que se usó para las mediciones oficiales (`--envs native,docker1,docker2` corre los tres entornos locales).

---

## 5. Si algo falla

Abre **Registro** en la página: ahí aparece el paso exacto y el error.

| Mensaje | Qué hacer |
|---|---|
| `Se necesita Node 22 o más nuevo` | `nvm install 22` |
| `docker … permission denied` | `sudo usermod -aG docker $USER` y vuelve a iniciar sesión |
| `El puerto X lo usa un proceso de otro usuario` | `sudo fuser -k X/tcp` y vuelve a **Preparar** |
| `El servidor no respondió` | Revisa `envs/logs/server.log` |
| Indicador **Generador saturado** | El generador no dio abasto: esa prueba no vale y se repite |
