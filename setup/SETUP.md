# Cómo correr el laboratorio

Todo se maneja desde una página web local. Un solo comando:

```bash
node analitics/telemetry/lab.mjs
```

y abre **http://localhost:7070**.

No importa qué versión de Node tenga tu terminal: el laboratorio busca Node 22 (o más nuevo) en `~/.nvm` y se relanza solo con él. También sube el límite de archivos abiertos y fija sus núcleos de CPU.

---

## 1. Requisitos (una sola vez)

| Necesitas | Comprobar |
|---|---|
| Node 22 instalado con nvm | `nvm install 22` |
| Docker con permiso para tu usuario | `docker ps` funciona sin `sudo` |

Nada más. El laboratorio instala las dependencias del servidor y lo compila si hace falta.

## 2. Uso

1. **Entorno:** elige *PC (nativo)*, *Contenedor 1 CPU* o *Contenedor 2 CPU* y pulsa **Preparar**. El laboratorio:
   - instala y compila el servidor si cambió,
   - levanta MongoDB en Docker,
   - arranca el servidor (nativo o en contenedor, con sus límites),
   - arranca el agente de telemetría,
   - crea los datos de prueba (3.000 cuentas y tableros) la primera vez.

   Si algún puerto (3000, 7071, 27017, 7070) está ocupado, cierra lo que lo ocupa y reintenta. Los cuatro puntos se ponen en verde cuando todo está listo.
2. **Pruebas:** pulsa **Correr** en la que quieras (el orden y las condiciones para comparar máquinas están en [`../PRUEBAS.md`](../PRUEBAS.md)). Antes de cada prueba el servidor se reinicia para empezar con la memoria limpia. La casilla **rápida** acorta los escalones (sirve para ensayar; para el informe usa la normal).
3. **En vivo:** debajo aparecen los indicadores y las gráficas mientras corre. **Detener** la corta y guarda lo que alcanzó a medir.
4. **Resultados:** lista de todas las corridas. Clic en una para reproducirla (▶, velocidad, barra de tiempo). **Abrir archivo** carga un `.ndjson` de otra máquina.

**Reiniciar datos** borra la base de pruebas y la vuelve a crear (las corridas guardadas no se tocan).

### Dónde queda cada cosa

| Qué | Dónde |
|---|---|
| Una prueba = un archivo | `analitics/data/raw/<fecha>_<entorno>_<prueba>.ndjson` |
| Respaldo del agente | `analitics/data/agent/` (o `agent-local/`) |
| Log del servidor durante la prueba | `analitics/envs/logs/server.log` |
| Datos de prueba (cuentas) | `analitics/data/seed-local.json` |

Cada archivo guarda todo, segundo a segundo: recursos de la máquina, histogramas de latencia, errores, escalones y su resultado. Por eso cualquier prueba se puede reproducir y volver a analizar sin repetirla.

### Para que la medición sea limpia en el PC

- Conectado a la corriente y en modo rendimiento: `powerprofilesctl set performance`.
- Cierra lo pesado (otros servidores, el IDE con indexación).
- El laboratorio reparte los núcleos solo: P-cores para servidor y Mongo, E-cores para el generador, LP-cores para el agente. Se ve en el Registro al preparar.
- Mirar la página en vivo también gasta CPU. En pruebas largas, déjala en otra pestaña.

---

## 3. Nube (EC2)

Guía completa en [`AWS-GRATIS.md`](AWS-GRATIS.md). En resumen: dos instancias gratuitas en la misma zona (servidor y generador), un comando por instancia (`curl … ec2-preparar.sh | bash -s servidor` o `generador`, que clona este repo), y la interfaz del generador vista en tu navegador por un túnel SSH.

---

## 4. Si algo falla

Abre **Registro** en la página: ahí sale el paso exacto y el error.

| Mensaje | Qué hacer |
|---|---|
| `El puerto X lo usa un proceso de otro usuario` | Algo de root lo ocupa (p. ej. un agente lanzado con sudo). `sudo fuser -k X/tcp` y vuelve a Preparar |
| `docker … permission denied` | Agrega tu usuario al grupo docker: `sudo usermod -aG docker $USER` y vuelve a iniciar sesión |
| `El servidor no respondió` | Mira `analitics/envs/logs/server.log` |
| Indicador **Generador saturado** | El PC de carga no dio abasto: ese escalón no vale |
