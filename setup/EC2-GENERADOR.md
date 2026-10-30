# EC2: instancia generadora (instalación a mano)

Comandos para dejar lista la instancia que corre **la interfaz del laboratorio y genera la carga**. No necesita Docker ni compilar el servidor. Es lo mismo que hace `ec2-preparar.sh generador`, paso por paso. La guía general está en [AWS-GRATIS.md](AWS-GRATIS.md) y el servidor en [EC2-SERVIDOR.md](EC2-SERVIDOR.md).

Instancia: Ubuntu Server 24.04, c7i-flex.large (o t3.micro), en **la misma subnet y el mismo security group** que el servidor.

## 0. Entrar a la instancia (desde tu PC)

```bash
ssh -i ~/.ssh/shareboard-perf.pem ubuntu@<IP pública del generador>
```

## 1. Paquetes del sistema

```bash
sudo apt-get update
sudo apt-get install -y git tmux curl
```

## 2. Límite de archivos abiertos

```bash
printf '* soft nofile 65535\n* hard nofile 65535\n' | sudo tee /etc/security/limits.d/90-carga.conf
```

## 3. Swap (solo con 1 GB de RAM)

```bash
swapon --show | grep -q swapfile || (sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile)
```

## 4. Node 22

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
node --version
```

## 5. Código

```bash
git clone https://github.com/Juan17la/shareboard_perf.git ~/shareboard_perf
```

## 6. Arrancar el laboratorio

```bash
cd ~/shareboard_perf
tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs'
```

Cuando diga `Laboratorio listo: http://localhost:7070/`, sal de tmux sin detenerlo: **Ctrl+B** y luego **D**.

Comprobar que alcanza al servidor por la red privada:

```bash
curl -s http://<IP privada del servidor>:3000/health
```

## 7. Túnel desde tu PC (en tu PC, no en EC2)

La interfaz solo escucha dentro del generador; se ve en tu navegador por un túnel SSH. En una terminal **de tu PC**, que debes dejar abierta:

```bash
ssh -i ~/.ssh/shareboard-perf.pem -N -L 7070:127.0.0.1:7070 ubuntu@<IP pública del generador>
```

- Se queda quieto sin mostrar nada: **así debe ser**, el túnel está abierto.
- Abre **http://localhost:7070** en tu navegador.
- Si dice `bind: Address already in use`, tu laboratorio local usa el 7070: ciérralo o usa `-L 7080:127.0.0.1:7070` y entra a http://localhost:7080.

## 8. Correr las pruebas

En http://localhost:7070:

1. **Entorno → Nube (EC2)**.
2. **IP privada del servidor** y **token** (en el servidor: `cat ~/shareboard_perf/data/token.txt`).
3. **Preparar**: los cuatro puntos en verde.
4. Pruebas en orden ([../PRUEBAS.md](../PRUEBAS.md)): Reposo, Pequeña x2, Mediana x2, Grande x2, Inicio de clase, Escalones (al final).

## 9. Traer los resultados a tu PC

En tu PC, desde la raíz del proyecto:

```bash
mkdir -p analitics/data/raw-aws
scp -i ~/.ssh/shareboard-perf.pem "ubuntu@<IP pública del generador>:shareboard_perf/data/raw/*.ndjson" analitics/data/raw-aws/
```

Luego **EC2 → Instances → Terminate** en las dos instancias.

## 10. Actualizar el código más adelante

```bash
tmux kill-session -t lab
cd ~/shareboard_perf && git pull
tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs'
```

---

## Problemas comunes

### Llave SSH equivocada

Síntoma: `Permission denied (publickey)` al abrir el túnel, aunque con otra terminal sí entras a la instancia.

Causa encontrada el 30 de octubre de 2026: había **dos llaves con nombres parecidos**:

| Archivo | ¿Sirve? |
|---|---|
| `~/.ssh/shareboard-perf.pem` | No: era de un intento anterior |
| `~/Documents/SSH_AWS/shareboard-perf-key.pem` | Sí: la llave con la que se lanzaron las instancias |

Cómo saber cuál es la buena:

1. En la consola: EC2 → Instances → la instancia → pestaña **Details** → **Key pair assigned at launch**.
2. En tu PC, el comando con el que sí entraste: `history | grep "ssh -i"`.

Solución: usar esa llave en el túnel, o dejarla como la oficial para que funcionen los comandos de estas guías:

```bash
mv ~/.ssh/shareboard-perf.pem ~/.ssh/shareboard-perf-vieja.pem
cp ~/Documents/SSH_AWS/shareboard-perf-key.pem ~/.ssh/shareboard-perf.pem
chmod 400 ~/.ssh/shareboard-perf.pem
```

Si no tienes ninguna llave de la instancia (entraste solo con EC2 Instance Connect), crea una y autorízala desde la consola:

```bash
# En tu PC
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# En la instancia (Connect → EC2 Instance Connect), pega la línea completa:
echo 'ssh-ed25519 AAAA...' >> ~/.ssh/authorized_keys
```

Y abre el túnel con `-i ~/.ssh/id_ed25519`.

### Otros

| Síntoma | Solución |
|---|---|
| Ejecutaste el túnel dentro de una EC2 | Sal con `exit` y ejecútalo en tu PC |
| `fallocate: Text file busy` | El swap ya existe: `swapon --show` para confirmarlo |
| "Preparar" en Nube falla | Desde el generador: `curl -s http://<IP privada del servidor>:3000/health` y `curl -s -H "x-token: <token>" http://<IP privada del servidor>:7070/api/target/status`. Si el primero no responde: security group (ver [EC2-SERVIDOR.md](EC2-SERVIDOR.md#security-group)). Si el segundo dice `token incorrecto`: copia de nuevo el token |
| "Generador saturado" en algún escalón | El generador no da abasto: ese escalón no vale; usa una instancia con más CPU |
