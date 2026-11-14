#!/usr/bin/env bash
# Trae la última versión del repo, actualiza dependencias y reinicia el bot.
# Uso: bash deploy/actualizar.sh        (-y para no preguntar)
#
# Seguridad: reinstalar el servicio usa sudo con archivos que vienen del repo. Por eso, si cambió
# algo de deploy/ o de las dependencias, primero se muestra el cambio y se pide confirmación:
# así una modificación que no hiciste vos (por ejemplo, alguien que entró a tu cuenta de GitHub)
# no llega a correr como administrador sin que la veas.
#
# Todo está dentro de main(): bash lee el script completo antes de ejecutarlo, y el git pull
# puede reemplazar este mismo archivo sin afectar la ejecución en curso.
set -euo pipefail

main() {
  local dir si=0
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ "${1:-}" = "-y" ] && si=1
  cd "$dir"
  if [ "$(id -u)" -eq 0 ]; then echo "Ejecutalo con tu usuario, sin sudo." >&2; exit 1; fi

  git fetch --quiet
  local nuevo; nuevo="$(git rev-parse '@{u}')"
  if [ "$(git rev-parse HEAD)" = "$nuevo" ]; then
    echo "Ya tenés la última versión."
  else
    echo "Cambios nuevos:"
    git --no-pager log --oneline "HEAD..$nuevo"
    if ! git diff --quiet HEAD "$nuevo" -- deploy/ requirements.lock requirements.txt; then
      echo
      echo "⚠ Cambian archivos que se usan con sudo o se instalan en el sistema:"
      git --no-pager diff --stat HEAD "$nuevo" -- deploy/ requirements.lock requirements.txt
      echo
      git --no-pager diff HEAD "$nuevo" -- deploy/
      if [ "$si" -ne 1 ]; then
        if [ ! -t 0 ]; then echo "Revisalo y volvé a ejecutar con -y para aplicarlo." >&2; exit 1; fi
        local resp; read -r -p "¿Son cambios tuyos y querés aplicarlos? [s/N] " resp
        case "$resp" in s|S|si|SI|sí|Sí) ;; *) echo "Cancelado: no se cambió nada."; exit 1;; esac
      fi
    fi
    git merge --ff-only --quiet "$nuevo"
  fi

  venv/bin/pip install --quiet --require-hashes -r requirements.lock
  # Reinstala el servicio (por si cambió la plantilla) y comprueba que arranque
  # shellcheck source=deploy/servicio.sh
  source "${dir}/deploy/servicio.sh"
  instalar_servicio "$(id -un)" "$dir"
  systemctl --no-pager --lines=5 status "$SERVICIO" || true
}

main "$@"
exit
