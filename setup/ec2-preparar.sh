#!/usr/bin/env bash
# Prepara una instancia EC2 (Ubuntu 24.04) para las pruebas de carga. Un solo comando:
#
#   curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s servidor
#   curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s generador
#
#   servidor  -> Docker + MongoDB + servidor Shareboard + agente (laboratorio en modo --target-only)
#   generador -> laboratorio con la interfaz web (genera la carga)
#
# WORKERS=n antes de "bash" fija los procesos de Node del servidor (por defecto 1).
#
# Clona (o actualiza) el repo en ~/shareboard_perf y deja el laboratorio corriendo en tmux ("lab").
# Volver a ejecutarlo es seguro: actualiza el código y reinicia el laboratorio.
set -euo pipefail

ROL="${1:-}"
REPO="${REPO:-https://github.com/Juan17la/shareboard_perf.git}"
DIR="$HOME/shareboard_perf"
if [[ "$ROL" != "servidor" && "$ROL" != "generador" ]]; then
  echo "Uso: bash ec2-preparar.sh servidor|generador" >&2
  exit 1
fi

echo "== 1/4 Paquetes del sistema =="
sudo apt-get update -y -qq
sudo apt-get install -y -qq git tmux curl >/dev/null
if [[ "$ROL" == "servidor" ]]; then
  sudo apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
  sudo usermod -aG docker "$USER"
fi
# Más sockets abiertos por proceso: cada usuario virtual es una conexión.
printf '* soft nofile 65535\n* hard nofile 65535\n' | sudo tee /etc/security/limits.d/90-carga.conf >/dev/null

# Con 1 GB de RAM (t3.micro) la compilación del servidor puede quedarse sin memoria: swap de respaldo.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB < 1500 )) && ! swapon --show | grep -q swapfile; then
  echo "Solo ${MEM_MB} MB de RAM: agrego 2 GB de swap (anótalo en el informe)"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
fi

echo "== 2/4 Node 24 =="
export NVM_DIR="$HOME/.nvm"
[[ -s "$NVM_DIR/nvm.sh" ]] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
NODE="$(nvm which 24)"
"$NODE" --version

echo "== 3/4 Código =="
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi
git -C "$DIR" log -1 --format='commit %h (%cd)' --date=short

echo "== 4/4 Arrancando el laboratorio ($ROL) =="
tmux kill-session -t lab 2>/dev/null || true
: > "$HOME/lab.log"
cd "$DIR"
if [[ "$ROL" == "servidor" ]]; then
  TOKEN="${TOKEN:-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  # sg docker: usa el grupo docker sin cerrar la sesión.
  tmux new-session -d -s lab "sg docker -c 'ulimit -n 65535; $NODE telemetry/lab.mjs --target-only --token $TOKEN --workers ${WORKERS:-1} 2>&1 | tee -a $HOME/lab.log'"
  echo "Preparando MongoDB, servidor y datos de prueba (3 a 6 minutos)…"
  until grep -qE "Listo\. En el PC|ERROR" "$HOME/lab.log"; do sleep 3; done
  if grep -q ERROR "$HOME/lab.log"; then grep ERROR "$HOME/lab.log"; exit 1; fi
  IMDS=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  PRIV=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS" http://169.254.169.254/latest/meta-data/local-ipv4)
  TYPE=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS" http://169.254.169.254/latest/meta-data/instance-type)
  echo
  echo "=============================================================="
  echo " Servidor listo ($TYPE)"
  echo "   IP privada: $PRIV"
  echo "   Token:      $TOKEN"
  echo " En la interfaz del generador elige \"Nube (EC2)\" con esos datos."
  echo " Ver el laboratorio: tmux attach -t lab   (salir: Ctrl+B y luego D)"
  echo "=============================================================="
else
  tmux new-session -d -s lab "ulimit -n 65535; $NODE telemetry/lab.mjs 2>&1 | tee -a $HOME/lab.log"
  until grep -qE "Laboratorio listo|ERROR" "$HOME/lab.log"; do sleep 1; done
  echo
  echo "=============================================================="
  echo " Generador listo. Desde tu PC abre el túnel (deja la terminal abierta):"
  echo "   ssh -i ~/.ssh/shareboard-perf.pem -N -L 7070:127.0.0.1:7070 ubuntu@<IP pública del generador>"
  echo " y entra a http://localhost:7070"
  echo "=============================================================="
fi
