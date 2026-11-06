# Funciones compartidas por instalar.sh y actualizar.sh (se cargan con "source").
# Instala el servicio endurecido y comprueba que arranque. Si no arranca, prueba de nuevo con
# compat.conf (afloja las restricciones más estrictas) para que el bot no quede caído.

SERVICIO="finanzas-bot"
UNIT="/etc/systemd/system/${SERVICIO}.service"
DROPIN_DIR="/etc/systemd/system/${SERVICIO}.service.d"

_reinicios() { systemctl show -p NRestarts --value "$SERVICIO" 2>/dev/null || echo 0; }

_servicio_ok() {
  # Activo durante ~10 s y sin reinicios automáticos en ese lapso (un bot que se cae entra en
  # bucle de reinicio cada 10 s, ver RestartSec en el servicio)
  local antes; antes="$(_reinicios)"
  sleep 12
  systemctl is-active --quiet "$SERVICIO" && [ "$(_reinicios)" = "$antes" ]
}

instalar_servicio() {   # instalar_servicio USUARIO DIR
  local usuario="$1" dir="$2"
  sed -e "s|__USUARIO__|${usuario}|g" -e "s|__DIR__|${dir}|g" "${dir}/deploy/finanzas-bot.service" | sudo tee "$UNIT" >/dev/null
  # Siempre se prueba primero la versión endurecida
  sudo rm -f "${DROPIN_DIR}/compat.conf"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICIO" >/dev/null 2>&1
  sudo systemctl restart "$SERVICIO"
  echo "   Comprobando que arranque..."
  if _servicio_ok; then
    echo "✔ El bot está corriendo (servicio endurecido)."
    return 0
  fi
  echo "⚠ Con las restricciones más estrictas no arrancó. Últimas líneas del log:"
  journalctl -u "$SERVICIO" -n 8 --no-pager 2>/dev/null | sed 's/^/     /' || true
  echo "   Pruebo con compat.conf (sigue protegido, con menos restricciones)..."
  sudo mkdir -p "$DROPIN_DIR"
  printf '%s\n' "# Agregado por deploy/servicio.sh porque el bot no arrancó con todas las restricciones." \
    "[Service]" "SystemCallFilter=" "RestrictAddressFamilies=" "PrivateUsers=no" "ProcSubset=all" "ProtectProc=default" \
    | sudo tee "${DROPIN_DIR}/compat.conf" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl restart "$SERVICIO"
  if _servicio_ok; then
    echo "✔ El bot está corriendo (modo compatible). Si fue un corte de internet al arrancar,"
    echo "  volvé a correr: bash deploy/actualizar.sh   (vuelve a probar el modo endurecido)"
    return 0
  fi
  echo "✘ El servicio no arranca. Mirá el detalle con: journalctl -u $SERVICIO -n 50 --no-pager"
  return 1
}
