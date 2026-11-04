# Instalación en la nube (AWS EC2)

En este entorno el servidor corre en una instancia EC2 y la carga sale de **otra** instancia EC2 en la misma zona. La carga no sale de tu PC por dos razones:

- **Red:** a 240 usuarios el servidor envía varios MB/s a los clientes. Por internet, el cuello de botella sería tu conexión de casa y no la instancia.
- **Latencia:** entre dos instancias de la misma zona el tiempo de ida y vuelta es de ~2 ms (medido: 2,1 a 2,7 ms), parecido al del PC (1 a 1,3 ms).

Tu PC solo sirve para entrar por SSH y ver la interfaz por un túnel.

```
 Tu PC ──SSH (túnel :7070)──► Generador EC2 ──red privada AWS──► Servidor EC2
 (navegador)                  (interfaz + carga)                 (MongoDB + Shareboard + agente)
```

## Instancias usadas en las mediciones

| Rol | Tipo | CPU | RAM | Disco | Precio On-Demand (us-east-1) |
|---|---|---|---|---|---|
| Servidor | **t3.small** | 2 vCPU, Intel Xeon Platinum 8175M a 2,5 GHz (1 núcleo físico con 2 hilos) | 2 GB | EBS gp3 20 GiB | USD 0,0208/h |
| Generador | t3.micro | 2 vCPU, misma familia | 1 GB (+2 GB de swap) | EBS gp3 8 GiB | USD 0,0104/h |

Sistema: Ubuntu Server LTS (la medición se hizo con Ubuntu 26.04.1, kernel 7.0.0-1014-aws), región us-east-1, modo de créditos de CPU **Unlimited**.

---

## 1. Tu PC: cliente SSH

### Debian / Ubuntu

```bash
sudo apt-get update && sudo apt-get install -y openssh-client curl
```

### Arch Linux

```bash
sudo pacman -S --needed openssh curl
```

### Windows 10/11

OpenSSH viene incluido. Compruébalo en **PowerShell**:

```powershell
ssh -V
```

Si no responde: *Configuración → Sistema → Características opcionales → Agregar → Cliente OpenSSH*.

---

## 2. Cuenta, presupuesto y llave (una vez, en la consola de AWS)

1. Activa **MFA** en el usuario raíz (menú de tu nombre → *Security credentials*).
2. **Billing and Cost Management → Budgets → Create budget → Zero spend budget** (o uno de USD 5) con aviso a tu correo.
3. Arriba a la derecha elige la región **US East (N. Virginia) us-east-1**.
4. **EC2 → Key pairs → Create key pair**: nombre `shareboard-perf-key`, tipo RSA, formato `.pem`. Se descarga una vez; guárdala.

Permisos de la llave (SSH rechaza llaves que otros usuarios pueden leer):

**Linux (Debian, Ubuntu, Arch):**

```bash
mkdir -p ~/.ssh
mv ~/Descargas/shareboard-perf-key.pem ~/.ssh/
chmod 400 ~/.ssh/shareboard-perf-key.pem
```

**Windows (PowerShell):**

```powershell
mkdir $HOME\.ssh -Force
Move-Item $HOME\Downloads\shareboard-perf-key.pem $HOME\.ssh\
icacls $HOME\.ssh\shareboard-perf-key.pem /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

---

## 3. Grupo de seguridad (firewall)

**EC2 → Security groups → Create security group**, nombre `shareboard-perf-sg`, VPC por defecto.

| Tipo | Puerto | Origen | Para qué |
|---|---|---|---|
| SSH | 22 | **My IP** | Entrar desde tu PC |
| All TCP | 0-65535 | **el mismo grupo** `shareboard-perf-sg` (agrégalo después de crearlo, editándolo) | Que el generador hable con el servidor por la red privada (puertos 3000, 7070 y 7071) |

Nada queda abierto a internet salvo SSH desde tu IP. Si tu IP de casa cambia, edita la regla SSH y vuelve a elegir **My IP**.

---

## 4. Lanzar las dos instancias

**EC2 → Instances → Launch instances**, dos veces:

| Campo | Servidor | Generador |
|---|---|---|
| Name | `shareboard-servidor` | `shareboard-generador` |
| AMI | Ubuntu Server LTS, 64-bit x86 | igual |
| Instance type | t3.small | t3.micro (mejor c7i-flex.large si está disponible: no se satura) |
| Key pair | `shareboard-perf-key` | igual |
| Network → Edit | Una subnet fija (p. ej. us-east-1a), IP pública habilitada, grupo `shareboard-perf-sg` | **La misma subnet**, igual, igual |
| Storage | 20 GiB gp3 | 8 GiB gp3 |
| Advanced → Credit specification | Unlimited | igual |

Anota de cada una la **IP pública** (para SSH) y la **IP privada** (para la prueba). Guarda una captura con fecha de la página de precios de EC2: es la ficha de precio que pide la rúbrica.

---

## 5. Instalar el servidor

Desde tu PC (en Windows, en PowerShell, cambiando `~/.ssh/` por `$HOME\.ssh\`):

```bash
ssh -i ~/.ssh/shareboard-perf-key.pem ubuntu@<IP pública del servidor>
```

Dentro de la instancia, un solo comando:

```bash
curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s servidor
```

El script instala `git`, `tmux`, Docker y Node 22 (con nvm), sube el límite de archivos abiertos a 65.535, agrega 2 GB de swap si la instancia tiene menos de 1,5 GB de RAM, clona el repositorio en `~/shareboard_perf` y arranca el laboratorio en modo `--target-only` dentro de `tmux`.

El laboratorio levanta MongoDB en Docker, compila y arranca el servidor y el agente, y crea los datos de prueba: 1.500 cuentas y 2.000 tableros. **En una t3.small esto tarda ~10 minutos**: cada registro calcula scrypt, y la instancia hace unos 3 por segundo. Al final imprime la **IP privada** y el **token**.

<details>
<summary>Los mismos pasos a mano</summary>

```bash
sudo apt-get update
sudo apt-get install -y git tmux curl docker.io docker-compose-v2
sudo usermod -aG docker $USER && newgrp docker
printf '* soft nofile 65535\n* hard nofile 65535\n' | sudo tee /etc/security/limits.d/90-carga.conf
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 22
git clone https://github.com/Juan17la/shareboard_perf.git ~/shareboard_perf
cd ~/shareboard_perf/servidor && npm ci && npm run build && cd ..
tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs --target-only 2>&1 | tee ~/lab.log'
```

</details>

Comprobar:

```bash
curl -s localhost:3000/health                      # {"ok":true,"db":true,...}
cat ~/shareboard_perf/data/token.txt               # el token
hostname -I | awk '{print $1}'                     # la IP privada
```

---

## 6. Instalar el generador

En otra terminal de tu PC:

```bash
ssh -i ~/.ssh/shareboard-perf-key.pem ubuntu@<IP pública del generador>
curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s generador
```

No necesita Docker. Comprueba que alcanza al servidor por la red privada:

```bash
curl -s http://<IP privada del servidor>:3000/health
```

---

## 7. Correr las pruebas

### Opción A: con la interfaz

1. En tu PC abre el túnel y déjalo abierto:

   ```bash
   ssh -i ~/.ssh/shareboard-perf-key.pem -N -L 7070:127.0.0.1:7070 ubuntu@<IP pública del generador>
   ```

   Si tu laboratorio local usa el 7070, usa `-L 7080:127.0.0.1:7070` y entra a http://localhost:7080.
2. Abre **http://localhost:7070**. Es la interfaz del generador vista en tu navegador.
3. **Entorno → Nube (EC2)**: IP privada del servidor y token. **Preparar**.
4. Corre **Carga baja, media, alta y Server killer**, en ese orden.

### Opción B: todo seguido, sin túnel

En el generador:

```bash
cd ~/shareboard_perf
tmux new -d -s campana "node telemetry/campana.mjs --remote <IP privada del servidor> <token> 2>&1 | tee ~/campana.log"
tail -f ~/campana.log
```

Las cuatro pruebas tardan ~55 minutos. Si se corta tu conexión SSH, la prueba sigue: corre dentro de `tmux`.

---

## 8. Traer los resultados a tu PC

**Desde la interfaz** (opción A): en **Resultados**, abre cada corrida y pulsa **Resumen (.csv)**, **Por segundo (.csv)** o **Datos crudos (.ndjson)**. La página llega por el túnel, así que el navegador guarda los archivos en tu PC.

**Todos de una vez** (Linux):

```bash
mkdir -p data/raw-aws
scp -i ~/.ssh/shareboard-perf-key.pem "ubuntu@<IP pública del generador>:shareboard_perf/data/raw/*.ndjson" data/raw-aws/
```

**Windows (PowerShell):**

```powershell
mkdir data\raw-aws -Force
scp -i $HOME\.ssh\shareboard-perf-key.pem "ubuntu@<IP pública del generador>:shareboard_perf/data/raw/*.ndjson" data\raw-aws\
```

Luego, en tu laboratorio local, **Resultados → Abrir archivo** para verlos con las mismas gráficas.

---

## 9. Apagar todo

**EC2 → Instances → selecciona las dos → Instance state → Terminate.** *Stop* no basta: el disco EBS (USD 0,08 por GB al mes) y la IP pública (USD 0,005 por hora) siguen cobrando. Al día siguiente revisa **Billing → Bills**.

Costo de una campaña completa (2 h de las dos instancias, incluida la creación de datos): ~USD 0,08 de cómputo + ~USD 0,02 de IP pública.

---

## 10. Problemas encontrados y su solución

| Síntoma | Causa | Solución |
|---|---|---|
| `Permission denied (publickey)` | Llave distinta a la del lanzamiento. Pasó con dos llaves de nombre parecido (`shareboard-perf.pem` y `shareboard-perf-key.pem`) | EC2 → la instancia → Details → *Key pair assigned at launch*; usa esa |
| `node: command not found` por SSH sin sesión interactiva | nvm solo se carga en shells interactivos | `source ~/.nvm/nvm.sh` antes del comando, o `bash -lc '…'` |
| "El remoto no está listo" al preparar Nube | El servidor sigue creando las cuentas de prueba | Esperar (`tail ~/lab.log` en el servidor). `campana.mjs` reintenta solo |
| El generador no alcanza `:3000/health` | Falta la regla "All TCP desde el mismo grupo", o están en VPC distintas | Revisa el paso 3 y que las dos tengan `shareboard-perf-sg` |
| `fallocate: Text file busy` | El swap ya existe | Nada que hacer: `swapon --show` lo confirma |
| "Generador saturado" en una prueba | El generador no dio abasto | Esa prueba no vale; usa una instancia generadora más grande |
