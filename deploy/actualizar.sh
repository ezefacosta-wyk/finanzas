#!/usr/bin/env bash
# Trae la última versión del repo, actualiza dependencias y reinicia el bot.
# Uso: bash deploy/actualizar.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICIO="finanzas-bot"
cd "$DIR"
if [ "$(id -u)" -eq 0 ]; then echo "Ejecutalo con tu usuario, sin sudo." >&2; exit 1; fi
git pull --ff-only
venv/bin/pip install --quiet -r requirements.txt
# por si cambió la plantilla del servicio
sed -e "s|__USUARIO__|$(id -un)|g" -e "s|__DIR__|${DIR}|g" deploy/finanzas-bot.service | sudo tee /etc/systemd/system/${SERVICIO}.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICIO"
sleep 3
systemctl --no-pager --lines=5 status "$SERVICIO" || true
