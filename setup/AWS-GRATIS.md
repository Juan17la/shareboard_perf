# Pruebas en AWS con la capa gratuita

Guía paso a paso para correr las mismas pruebas del PC en EC2 sin pagar (o casi), y obtener los archivos para comparar.

---

## 1. Antes de empezar: qué instancia te toca gratis

Depende de **cuándo creaste tu cuenta de AWS**:

| Cuenta creada | Instancias gratis | Servidor | Generador |
|---|---|---|---|
| Desde el 15 de julio de 2025 (plan gratuito con créditos) | t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large | **t3.small** (2 vCPU, 2 GB) | **c7i-flex.large** (2 vCPU, 4 GB) |
| Antes del 15 de julio de 2025 (12 meses gratis) | t2.micro, t3.micro (750 h al mes) | **t3.micro** (2 vCPU, 1 GB) | t3.micro o tu PC (ver 1.2) |

En la consola, al elegir el tipo de instancia, las elegibles muestran la etiqueta **Free tier eligible**. Si tu tipo no la muestra, no lo uses.

### 1.1 Por qué dos instancias

A 500 usuarios el servidor envía unos **38 MB/s (~300 Mbps)** a los clientes. Si la carga sale de tu PC por internet, el cuello de botella sería **tu conexión de casa**, no EC2, y la comparación no valdría. Con el generador en otra instancia de la **misma zona**, la red entre ambas es la de AWS (hasta 5 Gbps) y la latencia es de menos de 1 ms, como en el PC.

### 1.2 Si solo tienes t3.micro

Funciona igual, con dos avisos:

- 1 GB de RAM es poco para Mongo y el servidor juntos. El script agrega 2 GB de swap para que compile; anótalo en el informe.
- El generador en t3.micro se satura antes. Si la interfaz marca **Generador saturado**, ese escalón no vale. En ese caso corre solo Pequeña y Mediana, o usa tu PC como generador para esas dos.

### 1.3 Lo que sí puede costar

| Qué | Cómo evitarlo |
|---|---|
| IP pública (USD 0,005 por hora y por IP) | Termina las instancias al acabar; dos instancias por 4 horas son unos USD 0,04 |
| Créditos de CPU de las t3 en modo *unlimited* | Revisa `CPUSurplusCreditsCharged` en CloudWatch; en una tarde de pruebas es de centavos |
| Olvidar las instancias encendidas | Alarma de presupuesto (paso 2) y **Terminate** al final (paso 7) |

---

## 2. Cuenta y alarma de presupuesto (una vez)

1. Entra a la consola de AWS y activa **MFA** en el usuario raíz (menú de tu nombre → Security credentials).
2. **Billing and Cost Management → Budgets → Create budget → Zero spend budget** (o uno de USD 5) con aviso a tu correo.
3. Arriba a la derecha elige la región **US East (N. Virginia) us-east-1**.

## 3. Llave SSH

1. **EC2 → Network & Security → Key pairs → Create key pair**.
   - Nombre: `shareboard-perf` · Tipo: RSA · Formato: `.pem`.
2. En tu PC:
   ```bash
   mv ~/Descargas/shareboard-perf.pem ~/.ssh/ && chmod 400 ~/.ssh/shareboard-perf.pem
   ```

## 4. Grupo de seguridad (firewall)

**EC2 → Security groups → Create security group**:

- Nombre: `shareboard-perf-sg`, VPC por defecto.
- Reglas de entrada:

| Tipo | Puerto | Origen | Para qué |
|---|---|---|---|
| SSH | 22 | **My IP** | Entrar desde tu PC |

Créalo. Luego **edítalo** y agrega una segunda regla de entrada:

| Tipo | Puerto | Origen | Para qué |
|---|---|---|---|
| All TCP | 0-65535 | **el mismo grupo** `shareboard-perf-sg` (escríbelo en el buscador de origen) | Que el generador hable con el servidor por la red privada |

Nada queda abierto a internet salvo SSH desde tu IP.

## 5. Lanzar las dos instancias

**EC2 → Instances → Launch instances**, dos veces:

| Campo | Servidor | Generador |
|---|---|---|
| Name | `shareboard-servidor` | `shareboard-generador` |
| AMI | Ubuntu Server 24.04 LTS (64-bit x86) | igual |
| Instance type | t3.small (o t3.micro) | c7i-flex.large (o t3.micro) |
| Key pair | `shareboard-perf` | igual |
| Network settings → Edit | Subnet: **elige una** (p. ej. us-east-1a) · Auto-assign public IP: Enable · Security group: `shareboard-perf-sg` | **la misma subnet** · igual · igual |
| Storage | 20 GiB **gp3** | 8 GiB gp3 |
| Advanced → Credit specification | Unlimited (anótalo) | igual |

Anota de cada una la **IP pública** (para SSH) y la **IP privada**.

Guarda una captura con fecha del precio por hora de cada tipo en la página de precios de EC2 (On-Demand, us-east-1). Es la "ficha técnica y precio real" que pide la rúbrica, aunque te salga gratis.

## 6. Instalar y arrancar (todo por comandos)

Todo el código sale del repo público **https://github.com/Juan17la/shareboard_perf** (incluye una copia exacta del servidor que se midió en el PC, en `servidor/`). Nada se sube desde tu PC.

### 6.1 Servidor (MongoDB + Shareboard + agente)

Desde tu PC entra a la instancia del servidor:

```bash
ssh -i ~/.ssh/shareboard-perf.pem ubuntu@<IP pública del servidor>
```

Ya dentro, pega este único comando:

```bash
curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s servidor
```

Qué hace, en orden (3 a 6 minutos):

1. Instala `git`, `tmux`, `docker.io` y `docker-compose-v2`, y agrega tu usuario al grupo `docker`.
2. Sube el límite de archivos abiertos a 65.535 y, si la instancia tiene menos de 1,5 GB de RAM, agrega 2 GB de swap.
3. Instala Node 22 con nvm.
4. Clona el repo en `~/shareboard_perf`.
5. Arranca el laboratorio en modo `--target-only` dentro de `tmux` (sesión `lab`): levanta MongoDB en Docker, compila y arranca el servidor, arranca el agente y crea las 3.000 cuentas de prueba.

Termina mostrando la **IP privada** y el **token**. Cópialos.

### 6.2 Generador (interfaz y carga)

En otra terminal de tu PC:

```bash
ssh -i ~/.ssh/shareboard-perf.pem ubuntu@<IP pública del generador>
```

Dentro:

```bash
curl -fsSL https://raw.githubusercontent.com/Juan17la/shareboard_perf/main/setup/ec2-preparar.sh | bash -s generador
```

Instala `git`, `tmux` y Node 22, clona el repo y arranca el laboratorio con la interfaz en el puerto 7070 (solo accesible por el túnel del paso 7).

### 6.3 Si prefieres hacerlo a mano

Guías completas paso a paso, con los problemas que ya aparecieron y su solución: [EC2-SERVIDOR.md](EC2-SERVIDOR.md) y [EC2-GENERADOR.md](EC2-GENERADOR.md). Resumen:

Los mismos pasos sin el script:

```bash
# Ambas instancias
sudo apt-get update && sudo apt-get install -y git tmux curl
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 22
git clone https://github.com/Juan17la/shareboard_perf.git ~/shareboard_perf

# Solo el servidor
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER && newgrp docker
cd ~/shareboard_perf && tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs --target-only'

# Solo el generador
cd ~/shareboard_perf && tmux new -s lab 'ulimit -n 65535; node telemetry/lab.mjs'
```

El servidor imprime el token en `tmux` (y lo guarda en `~/shareboard_perf/data/token.txt`).

### 6.4 Útil mientras tanto

| Para | Comando (en la instancia) |
|---|---|
| Ver el laboratorio en vivo | `tmux attach -t lab` (salir sin cerrarlo: Ctrl+B y luego D) |
| Ver el registro | `tail -f ~/lab.log` |
| Actualizar el código y reiniciar | Volver a ejecutar el mismo `curl … \| bash -s servidor` (o `generador`) |
| Ver el token del servidor | `cat ~/shareboard_perf/data/token.txt` |

## 7. Correr las pruebas

1. En tu PC abre el túnel hacia la interfaz del generador (deja esta terminal abierta):
   ```bash
   ssh -i ~/.ssh/shareboard-perf.pem -N -L 7070:127.0.0.1:7070 ubuntu@<IP pública del generador>
   ```
   Si tu laboratorio local está usando el 7070, ciérralo antes.
2. Abre **http://localhost:7070**. Es la interfaz del generador, aunque la veas en tu navegador.
3. **Entorno → Nube (EC2)**: escribe la **IP privada** del servidor y el **token**. Pulsa **Preparar**.
4. Corre las pruebas en el mismo orden que en el PC ([`../PRUEBAS.md`](../PRUEBAS.md)): Reposo, Pequeña x2, Mediana x2, Grande x2, Inicio de clase y Escalones (al final).
5. Antes de los Escalones, anota `CPUCreditBalance` en **CloudWatch → Metrics → EC2 → Per-Instance Metrics** del servidor. Repítelo al final: si los créditos llegan a cero, la t3 se limita a su línea base (20 % por vCPU en t3.small).

## 8. Traer los resultados a tu PC

```bash
mkdir -p analitics/data/raw-aws
scp -i ~/.ssh/shareboard-perf.pem "ubuntu@<IP pública del generador>:shareboard_perf/data/raw/*.ndjson" analitics/data/raw-aws/
```

Luego en tu laboratorio local, **Resultados → Abrir archivo**, o las tablas para el informe:

```bash
node analitics/telemetry/report.mjs analitics/data/raw/<pc-escalones>.ndjson analitics/data/raw/<docker-escalones>.ndjson analitics/data/raw-aws/<aws-escalones>.ndjson > analitics/resultados/TABLAS.md
```

## 9. Apagar todo

**EC2 → Instances → selecciona las dos → Instance state → Terminate**. *Stop* no basta: el disco y la IP siguen cobrando. Al día siguiente revisa **Billing → Bills** y confirma que no quedó nada corriendo.

---

## Problemas comunes

| Síntoma | Solución |
|---|---|
| `Permission denied (publickey)` | Usuario `ubuntu`, llave correcta, `chmod 400` a la llave |
| SSH no conecta | Cambió tu IP pública: actualiza la regla SSH a **My IP** |
| Al preparar Nube: "El remoto no está listo" | En el servidor: `tail ~/lab.log` o `tmux attach -t lab` y mira el error |
| No conecta a la IP privada | Las dos instancias deben estar en la **misma VPC** y la regla "All TCP desde el mismo grupo" debe existir |
| Escalones marcados "Generador saturado" | El generador no da abasto: usa un tipo con más CPU o reporta solo los niveles válidos |
| La instancia micro se congela | Falta memoria: confirma que el script agregó swap (`swapon --show`) |

## Fuentes sobre la capa gratuita

- [AWS, tipos de instancia elegibles para la capa gratuita de EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)
- [AWS, cobro por direcciones IPv4 públicas](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)
- [AWS re:Post, qué instancia es gratuita](https://www.repost.aws/questions/QUlaKi-MimTo-3OjekpKMWiA/what-is-correct-for-ec2-free-tier-instance)
