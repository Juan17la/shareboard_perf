# EC2: instancia del servidor (instalación a mano)

Comandos para dejar lista la instancia que corre **MongoDB + servidor Shareboard + agente de telemetría**. Es lo mismo que hace `ec2-preparar.sh servidor`, paso por paso. La guía general (cuenta, llave, security group, lanzar instancias) está en [AWS-GRATIS.md](AWS-GRATIS.md).

Instancia: Ubuntu Server 24.04, t3.small (o t3.micro), en el security group `shareboard-perf-sg`.

## 0. Entrar a la instancia (desde tu PC)

```bash
ssh -i ~/.ssh/shareboard-perf.pem ubuntu@<IP pública del servidor>
```

Usa **la llave con la que lanzaste la instancia** (ver [Problemas comunes](#problemas-comunes)).

## 1. Paquetes del sistema y Docker

```bash
sudo apt-get update
sudo apt-get install -y git tmux curl docker.io docker-compose-v2
sudo usermod -aG docker $USER
newgrp docker
```

`newgrp docker` aplica el grupo sin cerrar sesión. Comprobar: `docker ps` funciona sin `sudo`.

## 2. Límite de archivos abiertos

Cada usuario virtual es un socket:

```bash
printf '* soft nofile 65535\n* hard nofile 65535\n' | sudo tee /etc/security/limits.d/90-carga.conf
```

## 3. Swap (solo con 1 GB de RAM, p. ej. t3.micro)

```bash
swapon --show | grep -q swapfile || (sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile)
```

Si ya existe no hace nada. Para que sobreviva a un reinicio (opcional):

```bash
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Anota en el informe que la instancia tenía 2 GB de swap: si el servidor llega a usarla, la latencia sube por esperar al disco.

## 4. Node 22

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
node --version
```

## 5. Código y dependencias del servidor

```bash
git clone https://github.com/Juan17la/shareboard_perf.git ~/shareboard_perf
cd ~/shareboard_perf/servidor
npm ci
npm run build
```

`servidor/` es una copia exacta del servidor que se midió en el PC.

## 6. Arrancar (MongoDB, servidor, agente y datos de prueba)

```bash
cd ~/shareboard_perf
tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs --target-only'
```

Levanta MongoDB en Docker, arranca el servidor y el agente, y crea las 3.000 cuentas de prueba (3 a 6 minutos). Al final imprime el **token**.

- Salir de tmux sin detenerlo: **Ctrl+B** y luego **D**. Volver: `tmux attach -t lab`.
- Ver el token después: `cat ~/shareboard_perf/data/token.txt`
- Ver la IP privada (la que va en la interfaz del generador): `hostname -I | awk '{print $1}'`

## 7. Comprobar que está listo

En el servidor:

```bash
curl -s localhost:3000/health                                              # {"ok":true,"db":true,...}
curl -s -H "x-token: $(cat ~/shareboard_perf/data/token.txt)" localhost:7070/api/target/status   # "ready":true
```

Desde el **generador** (prueba la red privada y el security group):

```bash
curl -s http://<IP privada del servidor>:3000/health
```

## 8. Actualizar el código más adelante

```bash
tmux kill-session -t lab
cd ~/shareboard_perf && git pull
cd servidor && npm ci && npm run build && cd ..
tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs --target-only'
```

---

## Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `fallocate: fallocate failed: Text file busy` | `/swapfile` ya existe y está activo (lo creó el script o un intento anterior) | Nada que hacer. Confirma con `swapon --show` y `free -h` (fila Swap ≈ 2,0 Gi). Si no aparece: `sudo swapon /swapfile` |
| `Permission denied (publickey)` al entrar | La llave no es la de la instancia | Ver la sección de llaves en [EC2-GENERADOR.md](EC2-GENERADOR.md#llave-ssh-equivocada) |
| `docker: permission denied` | El grupo docker aún no aplica | `newgrp docker` o cerrar y abrir la sesión SSH |
| El generador no alcanza `:3000/health` | Security group | Ver [Security group](#security-group) |
| El laboratorio muestra `ERROR` | Ver detalle | `tail -50 ~/lab.log` o `tmux attach -t lab` |

### Security group

Reglas de entrada correctas de `shareboard-perf-sg`:

| Tipo | Puerto | Origen |
|---|---|---|
| All TCP | 0-65535 | el mismo grupo (`sg-…  / shareboard-perf-sg`) |
| SSH | 22 | tu IP (`x.x.x.x/32`, "My IP") |

Confirma además:

1. El `sg-…` del origen de "All TCP" es el ID de **este mismo** grupo.
2. **Las dos instancias** tienen `shareboard-perf-sg` (EC2 → Instances → pestaña Security). Si no: Actions → Security → Change security groups.
3. Reglas de salida: las de por defecto (All traffic a `0.0.0.0/0`).
4. Si tu IP de casa cambia, edita la regla SSH y vuelve a elegir **My IP**.
