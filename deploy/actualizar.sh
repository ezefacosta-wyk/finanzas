#!/usr/bin/env bash
# Trae la última versión del repo, actualiza dependencias y reinicia el bot.
# Uso: bash deploy/actualizar.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
if [ "$(id -u)" -eq 0 ]; then echo "Ejecutalo con tu usuario, sin sudo." >&2; exit 1; fi
git pull --ff-only
venv/bin/pip install --quiet -r requirements.txt
# Reinstala el servicio (por si cambió la plantilla) y comprueba que arranque
source "${DIR}/deploy/servicio.sh"
instalar_servicio "$(id -un)" "$DIR"
systemctl --no-pager --lines=5 status "$SERVICIO" || true
