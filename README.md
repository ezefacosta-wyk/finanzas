# Mis Finanzas

- **Web:** `index.html` (GitHub Pages) — datos en tu Google Drive, carpeta `Finanzas/`.
- **Bot de Telegram:** `bot.py` — corre en una PC con Linux, sin abrir puertos ni necesitar IP pública.

## Bot de Telegram en Linux

El bot busca los mensajes en Telegram (modo *polling*), así que sólo hace conexiones salientes a
`api.telegram.org` y a Google. El único servidor que levanta escucha en `127.0.0.1:8080` y sirve
únicamente para recibir el regreso de Google cuando conectás tu cuenta.

### Requisitos
- Linux con **systemd** (Ubuntu, Debian, Mint, Fedora, Raspberry Pi OS, etc.)
- **Python 3.10+** con `venv` (`sudo apt install python3 python3-venv git`)
- La PC prendida para que el bot responda (Telegram guarda los mensajes hasta 24 h mientras está apagada)

### 1. Preparar Telegram y Google (una sola vez)
1. **Token del bot:** en Telegram, @BotFather → `/mybots` → tu bot → *API Token* → *Revoke current token*.
   Guardá el token nuevo.
2. **Google Cloud** → APIs y servicios → Credenciales → tu cliente OAuth:
   - En **URIs de redirección autorizados** agregá `http://localhost:8080/oauth/callback`
     (y borrá la de Railway si sigue).
   - Copiá el **Secreto del cliente**.

### 2. Instalar
```bash
git clone https://github.com/ezefacosta-wyk/finanzas.git
cd finanzas
bash deploy/instalar.sh          # la primera vez crea el archivo .env y se detiene
nano .env                        # completá BOT_TOKEN y GOOGLE_CLIENT_SECRET
bash deploy/instalar.sh          # instala dependencias y deja el bot corriendo como servicio
```
El script **no** se ejecuta con `sudo`: te pide la contraseña sólo para registrar el servicio.

### 3. Autorizarte y conectar Google
1. Mandale `/start` al bot. Como todavía no estás autorizado, te responde **"Tu ID de chat es: …"**.
2. Poné ese número en `.env` → `ALLOWED_CHAT_IDS=123456789` y reiniciá:
   `sudo systemctl restart finanzas-bot`
3. Mandale `/start` de nuevo y abrí el link **en el navegador de esa misma PC**. Al aceptar en Google,
   la página dice "¡Listo!" y el bot te confirma por Telegram.
   - **Si abrís el link en otro dispositivo** (o la PC no tiene pantalla): al final Google te lleva a una
     página de `localhost` que no carga. Copiá la dirección completa de esa página y mandásela al bot:
     `/codigo http://localhost:8080/oauth/callback?state=...&code=...`
   - Alternativa por SSH desde otra compu: `ssh -L 8080:localhost:8080 usuario@pc-del-bot` y abrí el link ahí.

### Uso diario
| Para… | Comando |
|---|---|
| Ver el log en vivo | `journalctl -u finanzas-bot -f` |
| Reiniciar / detener | `sudo systemctl restart finanzas-bot` / `sudo systemctl stop finanzas-bot` |
| Actualizar a la última versión | `bash deploy/actualizar.sh` |
| Desinstalar | `sudo systemctl disable --now finanzas-bot && sudo rm /etc/systemd/system/finanzas-bot.service` |

- Si la PC se suspende, el bot deja de responder: en *Energía* configurá **no suspender**.
- **Notificaciones:** día 28 desde las 20 h (cierre de mes) y día 1 desde las 9 h (resumen del mes).
  Si la PC estaba apagada a esa hora, se envían al prenderla (hasta fin de mes / hasta el día 5).

### Seguridad
- `.env` (token y secreto) y `data/` (tu sesión de Google) quedan sólo en tu PC con permisos `600`/`700`
  y están en `.gitignore`: **nunca** se suben al repo.
- El bot sólo atiende a los chats de `ALLOWED_CHAT_IDS`.
- El servicio corre con tu usuario, sin privilegios, sólo puede escribir en `data/` y está encerrado por
  systemd (`systemd-analyze security finanzas-bot` ≈ 1,6). Si en tu Linux alguna restricción impidiera
  arrancar, `instalar.sh`/`actualizar.sh` lo detectan y agregan
  `/etc/systemd/system/finanzas-bot.service.d/compat.conf`, que afloja sólo esas.
- `/desconectar` borra la sesión de tu PC y además revoca el permiso en tu cuenta de Google.
- No se guardan en el log las direcciones de regreso de Google (llevan el código de autorización).

## Web
- La lógica está en `app.js` (no hay JavaScript dentro de `index.html`): la Content-Security-Policy prohíbe
  scripts inline, así que aunque alguien lograra inyectar HTML, no se ejecutaría. Los botones usan
  `data-click` / `data-change` / `data-toggle` con la lista de acciones permitidas al final de `app.js`.
- Al modificar `app.js`, cambiá el `?v=` de `<script src="app.js?v=…">` en `index.html` para que los
  navegadores no usen la versión vieja guardada.

### Configuración (`.env`)
| Variable | Valor |
|---|---|
| `BOT_TOKEN` | Token de @BotFather |
| `GOOGLE_CLIENT_ID` | Ya viene completo |
| `GOOGLE_CLIENT_SECRET` | Secreto del cliente OAuth |
| `ALLOWED_CHAT_IDS` | Tu ID de chat (varios separados por coma) |
| `PORT` | Opcional, por defecto `8080` (si lo cambiás, actualizá la URI en Google Cloud) |
| `MODE` | Opcional: `polling` (por defecto) o `webhook` para un servidor con URL pública |

## Comandos del bot
| Comando | Descripción |
|---|---|
| `/start` | Conectar con Google Drive |
| `/gasto MONTO super` | Suma al Super/Mercado del mes |
| `/gasto MONTO extra descripción` | Agrega un gasto extra |
| `/gasto MONTO servicio` | Monto del mes de un servicio (ej. `/gasto 15000 luz`) |
| `/ingreso MONTO sueldo` | Sueldo del mes |
| `/ingreso MONTO descripción` | Ingreso extra |
| `/tarjeta NOMBRE MONTO` | Pago de una tarjeta (si ya tenía un pago, se suma como pago adicional) |
| `/servicios`, `/comprobante`, `/vercomprobantes` | Servicios y comprobantes |
| `/resumen`, `/historial`, `/comparar` | Resúmenes (mismo cálculo que la web) |
| `/ayuda` | Lista de comandos |

El bot lee y escribe los mismos archivos que la web. Si tenés la web abierta mientras cargás algo
por Telegram, al volver a la pestaña se actualiza sola (salvo que tengas un cambio propio sin guardar).

## Datos en Drive
```
Finanzas/
├── Comprobantes/<servicio>/<AAAA-MM>/...
└── Datos/   finanzas_AAAA_MM.json (un archivo por mes), servicios.json
```
