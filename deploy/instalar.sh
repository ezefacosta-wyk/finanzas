#!/usr/bin/env bash
# Instala el bot de Mis Finanzas como servicio de Linux (systemd).
# Uso: desde la carpeta del repo →  bash deploy/instalar.sh
# Se puede volver a ejecutar sin problema (por ejemplo, después de completar el .env).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICIO="finanzas-bot"
UNIT="/etc/systemd/system/${SERVICIO}.service"
verde(){ printf '\033[32m%s\033[0m\n' "$*"; }; amarillo(){ printf '\033[33m%s\033[0m\n' "$*"; }; rojo(){ printf '\033[31m%s\033[0m\n' "$*" >&2; }

if [ "$(id -u)" -eq 0 ]; then
  rojo "No lo ejecutes como root (ni con sudo): el bot tiene que correr con tu usuario."
  rojo "Ejecutalo así:  bash deploy/instalar.sh   (te va a pedir la contraseña sólo para instalar el servicio)"
  exit 1
fi
USUARIO="$(id -un)"
cd "$DIR"

echo "== 1/5 Python"
if ! command -v python3 >/dev/null; then rojo "Falta python3. Instalalo: sudo apt install python3 python3-venv"; exit 1; fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then
  rojo "Se necesita Python 3.10 o más nuevo (tenés $(python3 -V))."; exit 1; fi
if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
  rojo "Falta el módulo venv. Instalalo: sudo apt install python3-venv   (Fedora: sudo dnf install python3)"; exit 1; fi
verde "$(python3 -V) OK"

echo "== 2/5 Entorno virtual y dependencias"
[ -d venv ] || python3 -m venv venv
venv/bin/pip install --quiet --upgrade pip
venv/bin/pip install --quiet -r requirements.txt
verde "Dependencias instaladas en $DIR/venv"

echo "== 3/5 Configuración (.env) y datos"
umask 077
mkdir -p data && chmod 700 data
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  amarillo "Se creó $DIR/.env. Completalo (BOT_TOKEN, GOOGLE_CLIENT_SECRET) y volvé a ejecutar este script:"
  amarillo "   nano $DIR/.env"
  exit 0
fi
chmod 600 .env
falta=0
for v in BOT_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  val="$(grep -E "^${v}=" .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  if [ -z "$val" ] || [[ "$val" == PEGAR_* ]] || [[ "$val" == COMPLETAR* ]]; then rojo "Falta completar $v en .env"; falta=1; fi
done
[ "$falta" -eq 0 ] || exit 1
if ! grep -qE '^ALLOWED_CHAT_IDS=[0-9]' .env; then
  amarillo "ALLOWED_CHAT_IDS está vacío: el bot va a arrancar, pero sólo te va a responder tu ID de chat."
  amarillo "Mandale /start, copiá el número a ALLOWED_CHAT_IDS en .env y reiniciá: sudo systemctl restart $SERVICIO"
fi
verde ".env OK (permisos 600)"

echo "== 4/5 Prueba de arranque"
LOG="$(mktemp)"
if ! timeout 20 venv/bin/python -c "import bot" >"$LOG" 2>&1; then
  rojo "El bot no pudo cargar:"; tail -n 15 "$LOG" >&2; rm -f "$LOG"; exit 1
fi
rm -f "$LOG"
verde "El bot carga sin errores"

echo "== 5/5 Servicio systemd (pide tu contraseña)"
source "${DIR}/deploy/servicio.sh"
if instalar_servicio "$USUARIO" "$DIR"; then
  verde "✔ Va a arrancar solo cada vez que prendas la PC."
else
  rojo "El servicio no arrancó."; exit 1
fi
echo
echo "Comandos útiles:"
echo "  Ver el log en vivo:   journalctl -u $SERVICIO -f"
echo "  Reiniciar:            sudo systemctl restart $SERVICIO"
echo "  Detener:              sudo systemctl stop $SERVICIO"
echo "  Actualizar el bot:    bash deploy/actualizar.sh"
