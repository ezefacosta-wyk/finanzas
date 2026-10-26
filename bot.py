"""
Bot de Telegram — Mis Finanzas
Stack: python-telegram-bot 20.x, Google Drive API (OAuth por usuario)
"""

import os, json, re, io, logging, asyncio
from datetime import datetime, date
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor

from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters
)
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from aiohttp import web

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
BOT_TOKEN   = os.environ["BOT_TOKEN"]
CLIENT_ID   = os.environ["GOOGLE_CLIENT_ID"]
CLIENT_SECRET = os.environ["GOOGLE_CLIENT_SECRET"]
REDIRECT_URI  = os.environ["REDIRECT_URI"]          # https://tu-app.railway.app/oauth/callback
PORT          = int(os.environ.get("PORT", 8080))
TZ = ZoneInfo("America/Buenos_Aires")

SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "openid",
    "https://www.googleapis.com/auth/userinfo.profile",
]

# Estructura en Drive raíz:
#   Finanzas/
#     finanzas_data.json
#     servicios.json
#     Comprobantes/
#       <NombreServicio>/
#         <archivo>
DRIVE_ROOT_FOLDER  = "Finanzas"
DATA_FILE          = "finanzas_data.json"
SERVICIOS_FILE     = "servicios.json"
COMPROBANTES_FOLDER = "Comprobantes"

MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
         "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]

CATEGORIAS_FIJAS = {
    "super": "Super/Mercado",
    "mercado": "Super/Mercado",
    "extra": "Gasto Extra",
}

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Almacenamiento simple en memoria + JSON local
# (en Railway se puede usar un volumen o Redis)
# ──────────────────────────────────────────────
USERS_FILE  = "users.json"
STATES_FILE = "oauth_states.json"

def load_users() -> dict:
    if os.path.exists(USERS_FILE):
        with open(USERS_FILE) as f:
            return json.load(f)
    return {}

def save_users(users: dict):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)

def load_states() -> dict:
    if os.path.exists(STATES_FILE):
        with open(STATES_FILE) as f:
            return json.load(f)
    return {}

def save_states(states: dict):
    with open(STATES_FILE, "w") as f:
        json.dump(states, f, indent=2)

users_db: dict = load_users()   # { telegram_id: {creds, name, ...} }

# ──────────────────────────────────────────────
# Helpers de fecha
# ──────────────────────────────────────────────
def now_ar() -> datetime:
    return datetime.now(TZ)

def current_key() -> str:
    n = now_ar()
    return f"fin4_{n.year}_{n.month}"

def prev_key() -> str:
    n = now_ar()
    m, y = n.month - 1, n.year
    if m == 0:
        m, y = 12, y - 1
    return f"fin4_{y}_{m}"

def key_label(key: str) -> str:
    parts = key.split("_")
    return f"{MESES[int(parts[2])-1]} {parts[1]}"

# ──────────────────────────────────────────────
# Google Drive helpers
# ──────────────────────────────────────────────
def creds_from_dict(d: dict) -> Credentials:
    from google.auth.transport.requests import Request
    creds = Credentials(
        token=d.get("token"),
        refresh_token=d.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=SCOPES,
    )
    # Refrescar si está vencido o no tiene token válido
    if not creds.valid:
        if creds.refresh_token:
            try:
                creds.refresh(Request())
                log.info("Token de Google refrescado correctamente")
            except Exception as e:
                log.error(f"Error al refrescar token: {e}")
                raise
        else:
            raise ValueError("No hay refresh_token — el usuario debe reconectar con /start")
    return creds

_drive_executor = ThreadPoolExecutor(max_workers=4)

def get_drive(creds: Credentials):
    return build("drive", "v3", credentials=creds, cache_discovery=False)

# ── Helpers de carpetas en Drive raíz ──────────────────────────────────────

def find_folder(drive, name: str, parent_id: str | None = None) -> str | None:
    """Busca una carpeta por nombre. Si parent_id es None busca en root."""
    parent_q = f"'{parent_id}' in parents" if parent_id else "'root' in parents"
    q = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and {parent_q} and trashed=false"
    res = drive.files().list(q=q, spaces="drive", fields="files(id)").execute()
    files = res.get("files", [])
    return files[0]["id"] if files else None

def ensure_folder(drive, name: str, parent_id: str | None = None) -> str:
    """Devuelve el id de la carpeta, creándola si no existe."""
    fid = find_folder(drive, name, parent_id)
    if fid:
        return fid
    meta = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        meta["parents"] = [parent_id]
    f = drive.files().create(body=meta, fields="id").execute()
    log.info(f"Carpeta creada en Drive: '{name}' (id={f['id']})")
    return f["id"]

def get_root_folder(drive) -> str:
    """Devuelve (creando si no existe) el id de la carpeta raíz Finanzas/."""
    return ensure_folder(drive, DRIVE_ROOT_FOLDER)

def get_comprobantes_folder(drive, root_id: str, servicio_name: str) -> str:
    """Devuelve el id de Finanzas/Comprobantes/<servicio>, creando la jerarquía si falta."""
    comp_id = ensure_folder(drive, COMPROBANTES_FOLDER, root_id)
    return ensure_folder(drive, servicio_name, comp_id)

# ── Helpers de archivos JSON ────────────────────────────────────────────────

def find_file_in_folder(drive, name: str, folder_id: str) -> str | None:
    q = f"name='{name}' and '{folder_id}' in parents and trashed=false"
    res = drive.files().list(q=q, spaces="drive", fields="files(id)",
                             orderBy="modifiedTime desc").execute()
    files = res.get("files", [])
    return files[0]["id"] if files else None

def read_json_file(drive, file_id: str) -> dict | list:
    buf = io.BytesIO()
    request = drive.files().get_media(fileId=file_id)
    dl = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = dl.next_chunk()
    buf.seek(0)
    return json.loads(buf.read().decode())

def write_json_file(drive, name: str, folder_id: str, data, existing_id: str | None = None):
    content = json.dumps(data, ensure_ascii=False).encode()
    buf = io.BytesIO(content)
    media = MediaIoBaseUpload(buf, mimetype="application/json")
    if existing_id:
        drive.files().update(fileId=existing_id, media_body=media).execute()
        log.info(f"'{name}' actualizado (id={existing_id})")
    else:
        meta = {"name": name, "parents": [folder_id]}
        drive.files().create(body=meta, media_body=media, fields="id").execute()
        log.info(f"'{name}' creado en carpeta {folder_id}")

# ── finanzas_data.json ──────────────────────────────────────────────────────

def read_drive_data(creds: Credentials) -> dict:
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    fid = find_file_in_folder(drive, DATA_FILE, root_id)
    if not fid:
        log.info(f"No se encontró {DATA_FILE} en Finanzas/")
        return {}
    log.info(f"Leyendo {DATA_FILE} con id={fid}")
    return read_json_file(drive, fid)

def write_drive_data(creds: Credentials, data: dict):
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    fid = find_file_in_folder(drive, DATA_FILE, root_id)
    write_json_file(drive, DATA_FILE, root_id, data, fid)

# ── servicios.json ──────────────────────────────────────────────────────────

def read_servicios(creds: Credentials) -> list:
    """Devuelve la lista de servicios perpetuos del usuario."""
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    fid = find_file_in_folder(drive, SERVICIOS_FILE, root_id)
    if not fid:
        return []
    return read_json_file(drive, fid)

def write_servicios(creds: Credentials, servicios: list):
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    fid = find_file_in_folder(drive, SERVICIOS_FILE, root_id)
    write_json_file(drive, SERVICIOS_FILE, root_id, servicios, fid)

# ── Subir comprobante ───────────────────────────────────────────────────────

def upload_comprobante(creds: Credentials, servicio_name: str,
                       filename: str, content: bytes, mime: str) -> str:
    """Sube un archivo a Finanzas/Comprobantes/<servicio>/. Devuelve el file id."""
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    srv_folder_id = get_comprobantes_folder(drive, root_id, servicio_name)
    buf = io.BytesIO(content)
    media = MediaIoBaseUpload(buf, mimetype=mime)
    meta = {"name": filename, "parents": [srv_folder_id]}
    f = drive.files().create(body=meta, media_body=media, fields="id,webViewLink").execute()
    log.info(f"Comprobante subido: {filename} (id={f['id']})")
    return f["id"]

def list_comprobantes(creds: Credentials, servicio_name: str, mes_prefix: str) -> list:
    """
    Lista comprobantes de un servicio para un mes dado.
    mes_prefix ej: '2026-10'  → busca archivos que empiecen con ese prefijo.
    Devuelve lista de {id, name}.
    """
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    srv_folder_id = get_comprobantes_folder(drive, root_id, servicio_name)
    q = f"'{srv_folder_id}' in parents and name contains '{mes_prefix}' and trashed=false"
    res = drive.files().list(q=q, spaces="drive",
                             fields="files(id,name)", orderBy="name").execute()
    return res.get("files", [])

def download_file(creds: Credentials, file_id: str) -> bytes:
    drive = get_drive(creds)
    buf = io.BytesIO()
    request = drive.files().get_media(fileId=file_id)
    dl = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = dl.next_chunk()
    buf.seek(0)
    return buf.read()

# ── Async wrappers ──────────────────────────────────────────────────────────

def _run_in_executor(fn, *args):
    loop = asyncio.get_event_loop()
    return loop.run_in_executor(_drive_executor, fn, *args)

async def read_drive_data_async(creds: Credentials) -> dict:
    return await _run_in_executor(read_drive_data, creds)

async def write_drive_data_async(creds: Credentials, data: dict):
    return await _run_in_executor(write_drive_data, creds, data)

async def read_servicios_async(creds: Credentials) -> list:
    return await _run_in_executor(read_servicios, creds)

async def write_servicios_async(creds: Credentials, servicios: list):
    return await _run_in_executor(write_servicios, creds, servicios)

async def upload_comprobante_async(creds, servicio_name, filename, content, mime) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _drive_executor, upload_comprobante,
        creds, servicio_name, filename, content, mime
    )

async def list_comprobantes_async(creds, servicio_name, mes_prefix) -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _drive_executor, list_comprobantes,
        creds, servicio_name, mes_prefix
    )

async def download_file_async(creds, file_id) -> bytes:
    return await _run_in_executor(download_file, creds, file_id)

# ──────────────────────────────────────────────
# Parsear montos (acepta 1500 / 1.500 / 1,500 / 1.500,00 / 1,500.00)
# ──────────────────────────────────────────────
def parse_monto(texto: str):
    """Devuelve float o None. Acepta coma o punto como decimal/miles."""
    t = texto.strip().replace(" ", "")
    # Si tiene tanto punto como coma: el último es el decimal
    if "." in t and "," in t:
        if t.rfind(".") < t.rfind(","):
            # formato 1.234,56
            t = t.replace(".", "").replace(",", ".")
        else:
            # formato 1,234.56
            t = t.replace(",", "")
    elif "," in t:
        # puede ser decimal (1,50) o miles (1,500) → si hay exactamente 3 cifras después tratar como miles
        partes = t.split(",")
        if len(partes) == 2 and len(partes[1]) == 3:
            t = t.replace(",", "")   # miles sin decimal
        else:
            t = t.replace(",", ".")  # decimal
    elif "." in t:
        partes = t.split(".")
        if len(partes) == 2 and len(partes[1]) == 3:
            t = t.replace(".", "")   # miles sin decimal
        # sino queda como está (decimal inglés)
    try:
        return float(t)
    except ValueError:
        return None

# ──────────────────────────────────────────────
# Formato de números
# ──────────────────────────────────────────────
def fmt(v: float, decimals=2) -> str:
    if v is None:
        return "—"
    fmt_str = f"{v:,.{decimals}f}"
    # Cambiar separadores al estilo argentino
    return fmt_str.replace(",", "X").replace(".", ",").replace("X", ".")

# ──────────────────────────────────────────────
# Resumen de un mes
# ──────────────────────────────────────────────
def parse_mes(raw) -> dict:
    """
    Normaliza el estado de un mes al formato interno del bot.
    La web app guarda cada clave como un JSON string en localStorage y luego
    vuelca esos strings al JSON de Drive → data[key] = "{\"sueldo\":...}"
    El bot guarda dicts directamente.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    if not isinstance(raw, dict):
        return {}

    # Estructura de la web app:
    #   { sueldo, extras:[{desc,amt}], tarjetas:[{name,total,pagado,usdTotal,...}],
    #     servicios:[{name,amt}], superAmt, gastosExtra:[{desc,amt}] }
    # Estructura del bot (al guardar desde bot):
    #   { ingresos:{sueldo, extras:[{desc,monto}]}, servicios:{luz,...},
    #     tarjetas:[{pagado,totalUsd,...}], otrosGastos:{super, extras:[{desc,monto}]} }

    def nv(v):
        try: return float(v) if v not in (None, '', 'NaN') else 0.0
        except: return 0.0

    # ── Ingresos ──
    if "ingresos" in raw:
        # formato bot
        ing = raw["ingresos"] if isinstance(raw["ingresos"], dict) else {}
        sueldo = nv(ing.get("sueldo", 0))
        extras_ing = [{"desc": e.get("desc","Extra"), "monto": nv(e.get("monto",0))}
                      for e in (ing.get("extras") or [])]
    else:
        # formato web
        sueldo = nv(raw.get("sueldo", 0))
        extras_ing = [{"desc": e.get("desc", e.get("name","Extra")), "monto": nv(e.get("amt", e.get("monto",0)))}
                      for e in (raw.get("extras") or [])]

    # ── Servicios ──
    if "servicios" in raw and isinstance(raw["servicios"], list):
        # formato web: [{name, amt}]
        total_srv = sum(nv(s.get("amt", 0)) for s in raw["servicios"])
        srv_detalle = [(s.get("name","Servicio"), nv(s.get("amt",0)))
                       for s in raw["servicios"] if nv(s.get("amt",0)) > 0]
    elif "servicios" in raw and isinstance(raw["servicios"], dict):
        # formato bot: {luz, gas, ...}
        srv = raw["servicios"]
        nombres_srv = ["luz","gas","expensas","alquiler","internet","celular","obraSocial"]
        nombres_label = {"luz":"Luz","gas":"Gas","expensas":"Expensas","alquiler":"Alquiler",
                         "internet":"Internet","celular":"Celular","obraSocial":"Obra Social"}
        total_srv = sum(nv(srv.get(s, 0)) for s in nombres_srv)
        srv_detalle = [(nombres_label[s], nv(srv.get(s,0))) for s in nombres_srv if nv(srv.get(s,0)) > 0]
    else:
        total_srv = 0
        srv_detalle = []

    # ── Tarjetas ──
    tarjetas = raw.get("tarjetas") or []
    total_tar_ars = 0
    total_tar_usd = 0
    for t in tarjetas:
        pagado = nv(t.get("pagado", 0))
        extra_pagos = sum(nv(p.get("amt", p.get("monto", 0))) for p in (t.get("extraPagos") or []))
        total_tar_ars += pagado + extra_pagos
        total_tar_usd += nv(t.get("usdTotal", t.get("totalUsd", 0)))

    # ── Otros gastos ──
    if "otrosGastos" in raw and isinstance(raw["otrosGastos"], dict):
        # formato bot
        otros = raw["otrosGastos"]
        super_val = nv(otros.get("super", 0))
        extras_gas = [{"desc": e.get("desc","Extra"), "monto": nv(e.get("monto",0))}
                      for e in (otros.get("extras") or [])]
    else:
        # formato web
        super_val = nv(raw.get("superAmt", 0))
        extras_gas = [{"desc": e.get("desc", e.get("name","Extra")), "monto": nv(e.get("amt", e.get("monto",0)))}
                      for e in (raw.get("gastosExtra") or [])]

    return {
        "sueldo": sueldo,
        "extras_ing": extras_ing,
        "total_srv": total_srv,
        "srv_detalle": srv_detalle,
        "total_tar_ars": total_tar_ars,
        "total_tar_usd": total_tar_usd,
        "super_val": super_val,
        "extras_gas": extras_gas,
    }


def build_resumen(data: dict, key: str) -> str:
    raw = data.get(key)
    if not raw:
        return f"📭 No hay datos para {key_label(key)}."

    mes = parse_mes(raw)
    if not mes:
        return f"📭 No hay datos para {key_label(key)}."

    label = key_label(key)
    sueldo = mes["sueldo"]
    extras_ing = mes["extras_ing"]
    total_ing = sueldo + sum(e["monto"] for e in extras_ing)

    total_srv = mes["total_srv"]
    srv_detalle = mes["srv_detalle"]
    total_tar_ars = mes["total_tar_ars"]
    total_tar_usd = mes["total_tar_usd"]
    super_val = mes["super_val"]
    extras_gas = mes["extras_gas"]

    total_otros = super_val + sum(e["monto"] for e in extras_gas)
    total_gas = total_srv + total_tar_ars + total_otros
    disponible = total_ing - total_gas

    lineas = [
        f"📊 *Resumen — {label}*\n",
        f"💰 Ingresos:    $ {fmt(total_ing)}",
        f"  └ Sueldo:   $ {fmt(sueldo)}",
    ]
    for e in extras_ing:
        lineas.append(f"  └ {e['desc']}: $ {fmt(e['monto'])}")

    lineas.append(f"\n🏠 Servicios:   $ {fmt(total_srv)}")
    for nombre, monto in srv_detalle:
        lineas.append(f"  └ {nombre}: $ {fmt(monto)}")

    lineas.append(f"💳 Tarjetas:    $ {fmt(total_tar_ars)}")
    if total_tar_usd:
        lineas.append(f"   (USD {fmt(total_tar_usd)} incluidos)")
    if super_val:
        lineas.append(f"🛒 Super/Merc.: $ {fmt(super_val)}")
    for e in extras_gas:
        lineas.append(f"  └ {e['desc']}: $ {fmt(e['monto'])}")

    lineas += [
        f"\n📉 Total gastos: $ {fmt(total_gas)}",
        f"{'✅' if disponible >= 0 else '🔴'} Disponible:  $ {fmt(disponible)}",
    ]
    return "\n".join(lineas)

# ──────────────────────────────────────────────
# OAuth Flow
# ──────────────────────────────────────────────
def make_oauth_url(chat_id: int) -> str:
    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "redirect_uris": [REDIRECT_URI],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
    )
    url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    # Persistir el state en disco para sobrevivir reinicios
    states = load_states()
    states[state] = chat_id
    save_states(states)
    return url

async def oauth_callback(request: web.Request) -> web.Response:
    """Endpoint HTTP que recibe el callback de Google OAuth."""
    state = request.rel_url.query.get("state", "")
    code  = request.rel_url.query.get("code", "")

    # Leer state desde disco (sobrevive reinicios del proceso)
    states = load_states()
    chat_id = states.pop(state, None)
    if chat_id:
        save_states(states)

    if not chat_id or not code:
        return web.Response(
            text="<html><body><h2>❌ Error: sesión expirada o inválida. Volvé a Telegram y usá /start de nuevo.</h2></body></html>",
            content_type="text/html",
            status=400,
        )

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "redirect_uris": [REDIRECT_URI],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
        state=state,
    )
    import os as _os
    _os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
    flow.fetch_token(code=code)
    creds = flow.credentials

    # Obtener nombre del usuario
    svc = build("oauth2", "v2", credentials=creds)
    info = svc.userinfo().get().execute()
    name = info.get("name", "Usuario")

    uid = str(chat_id)
    # Preservar el refresh_token viejo si Google no mandó uno nuevo
    # (Google solo envía refresh_token en el primer authorization)
    old_refresh_token = users_db.get(uid, {}).get("refresh_token")
    users_db[uid] = {
        "token": creds.token,
        "refresh_token": creds.refresh_token or old_refresh_token,
        "name": name,
        "scope_version": 4,  # drive.file en raíz visible (v4)
    }
    save_users(users_db)

    # Notificar al usuario por Telegram
    app = request.app["bot_app"]
    await app.bot.send_message(
        chat_id=chat_id,
        text=f"✅ ¡Hola {name}! Tu cuenta de Google quedó conectada.\n\n"
             f"Ya podés usar todos los comandos. Escribí /ayuda para ver qué podés hacer.",
    )
    return web.Response(
        text="<html><body><h2>✅ ¡Listo! Podés cerrar esta pestaña y volver a Telegram.</h2></body></html>",
        content_type="text/html",
    )

# ──────────────────────────────────────────────
# Handlers de comandos
# ──────────────────────────────────────────────
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid in users_db:
        # Verificar si el token tiene el scope correcto (drive.file v4)
        creds_data = users_db[uid]
        tiene_scope_correcto = creds_data.get("scope_version", 1) >= 4
        if tiene_scope_correcto:
            await update.message.reply_text(
                f"👋 ¡Ya estás conectado, {users_db[uid]['name']}!\n"
                "Usá /ayuda para ver los comandos disponibles."
            )
            return
        # Tiene token viejo → reconectar para obtener drive.file
        await update.message.reply_text(
            "🔄 Actualicé la forma en que guardo tus datos (ahora en Drive visible 📂).\n\n"
            "Necesito que autorices de nuevo una sola vez para continuar:"
        )
    url = make_oauth_url(update.effective_chat.id)
    await update.message.reply_text(
        "¡Hola! Para empezar, conectá tu cuenta de Google Drive "
        "donde se guardarán tus datos de finanzas.\n\n"
        f"👉 [Autorizar Google Drive]({url})",
        parse_mode="Markdown",
        disable_web_page_preview=True,
    )

async def cmd_desconectar(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid in users_db:
        del users_db[uid]
        save_users(users_db)
        await update.message.reply_text(
            "🔓 Cuenta desconectada. Usá /start para volver a conectar tu Google Drive."
        )
    else:
        await update.message.reply_text("No tenías ninguna cuenta conectada.")

async def cmd_ayuda(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    texto = (
        "📋 *Comandos disponibles:*\n\n"
        "📂 *Servicios y comprobantes:*\n"
        "/servicios — Crear, ver y eliminar servicios\n"
        "/comprobante — Subir comprobante a un servicio\n"
        "/vercomprobantes — Ver y descargar comprobantes\n\n"
        "💰 *Registrar datos:*\n"
        "/gasto `MONTO NOMBRE_SERVICIO`\n"
        "  _Ej: /gasto 15000 luz_\n"
        "/ingreso `MONTO descripción`\n"
        "  _Ej: /ingreso 200000 freelance_\n"
        "/tarjeta `NOMBRE MONTO`\n"
        "  _Ej: /tarjeta visa 150000_\n\n"
        "📊 *Resúmenes:*\n"
        "/resumen — Mes actual\n"
        "/historial — Elegir un mes\n"
        "/comparar — Balance vs mes anterior\n\n"
        "📌 *Categorías especiales para /gasto:*\n"
        "`super` o `mercado` → Super/Mercado\n"
        "`extra` → Gasto extra\n\n"
        "💡 Montos: `4500` / `4,500` / `4.500`"
    )
    await update.message.reply_text(texto, parse_mode="Markdown")

async def cmd_gasto(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return

    args = ctx.args
    if len(args) < 2:
        await update.message.reply_text(
            "Uso: /gasto MONTO CATEGORÍA descripción\n"
            "Ej: /gasto 4500 super mercado chino\n"
            "Para ver tus servicios disponibles: /servicios"
        )
        return

    monto = parse_monto(args[0])
    if monto is None:
        msg = "No pude leer el monto."
        if "." in args[0]:
            msg += "\n💡 Si usaste punto como separador de miles (ej: 4.500), también funciona."
        await update.message.reply_text(msg)
        return

    cat_raw = args[1].lower()
    desc = " ".join(args[2:]) if len(args) > 2 else args[1]

    try:
        creds = creds_from_dict(users_db[uid])
        data = await read_drive_data_async(creds)
        servicios = await read_servicios_async(creds)
        key = current_key()
        mes = data.setdefault(key, {})

        # Buscar si coincide con un servicio del usuario (por nombre aproximado)
        srv_match = next(
            (s for s in servicios if s["name"].lower() == cat_raw or
             s["name"].lower().startswith(cat_raw)),
            None
        )

        if CATEGORIAS_FIJAS.get(cat_raw) == "Super/Mercado":
            mes.setdefault("otrosGastos", {})
            mes["otrosGastos"]["super"] = mes["otrosGastos"].get("super", 0) + monto
            etiqueta = "Super/Mercado"
        elif CATEGORIAS_FIJAS.get(cat_raw) == "Gasto Extra":
            mes.setdefault("otrosGastos", {})
            extras = mes["otrosGastos"].setdefault("extras", [])
            extras.append({"desc": desc, "monto": monto})
            etiqueta = desc
        elif srv_match:
            # Guardar monto del servicio para este mes
            srv_list = mes.setdefault("servicios", [])
            existing = next((s for s in srv_list if s.get("id") == srv_match["id"]), None)
            if existing:
                existing["amt"] = monto
            else:
                srv_list.append({"id": srv_match["id"], "name": srv_match["name"], "amt": monto})
            etiqueta = srv_match["name"]
        else:
            nombres_srv = ", ".join(s["name"] for s in servicios) if servicios else "(ninguno creado)"
            await update.message.reply_text(
                f"❓ Categoría '{args[1]}' no reconocida.\n\n"
                f"Categorías fijas: `super`, `extra`\n"
                f"Tus servicios: {nombres_srv}\n\n"
                f"Para crear servicios: /servicios"
            , parse_mode="Markdown")
            return

        await write_drive_data_async(creds, data)
        await update.message.reply_text(
            f"✅ Gasto guardado:\n"
            f"  📌 {etiqueta}: *$ {fmt(monto)}*\n"
            f"  📅 {key_label(key)}",
            parse_mode="Markdown"
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al guardar en Drive. Intentá de nuevo.")

async def cmd_ingreso(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return

    args = ctx.args
    if not args:
        await update.message.reply_text("Uso: /ingreso MONTO descripción\nEj: /ingreso 850000 sueldo")
        return

    monto = parse_monto(args[0])
    if monto is None:
        msg = "No pude leer el monto."
        if "." in args[0]:
            msg += "\n💡 Si usaste punto como separador de miles (ej: 850.000), también funciona."
        await update.message.reply_text(msg)
        return

    desc = " ".join(args[1:]) if len(args) > 1 else "Ingreso"
    es_sueldo = any(p in desc.lower() for p in ["sueldo","salario"])

    try:
        creds = creds_from_dict(users_db[uid])
        data = await read_drive_data_async(creds)
        key = current_key()
        mes = data.setdefault(key, {})
        ingresos = mes.setdefault("ingresos", {})

        if es_sueldo:
            ingresos["sueldo"] = monto
            etiqueta = "Sueldo"
        else:
            extras = ingresos.setdefault("extras", [])
            extras.append({"desc": desc, "monto": monto})
            etiqueta = desc

        await write_drive_data_async(creds, data)
        await update.message.reply_text(
            f"✅ Ingreso guardado:\n"
            f"  💰 {etiqueta}: *$ {fmt(monto)}*\n"
            f"  📅 {key_label(key)}",
            parse_mode="Markdown"
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al guardar en Drive.")

async def cmd_tarjeta(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return

    args = ctx.args
    if len(args) < 2:
        await update.message.reply_text(
            "Uso: /tarjeta NOMBRE MONTO\nEj: /tarjeta visa 150000"
        )
        return

    nombre = args[0].upper()
    monto = parse_monto(args[1])
    if monto is None:
        await update.message.reply_text("No pude leer el monto.")
        return

    try:
        creds = creds_from_dict(users_db[uid])
        data = await read_drive_data_async(creds)
        key = current_key()
        mes = data.setdefault(key, {})
        tarjetas = mes.setdefault("tarjetas", [])

        # Buscar si ya existe esa tarjeta
        tar = next((t for t in tarjetas if t.get("nombre","").upper() == nombre), None)
        if tar:
            tar["pagado"] = monto
        else:
            tarjetas.append({"nombre": nombre, "pagado": monto})

        await write_drive_data_async(creds, data)
        await update.message.reply_text(
            f"✅ Pago de tarjeta guardado:\n"
            f"  💳 {nombre}: *$ {fmt(monto)}*\n"
            f"  📅 {key_label(key)}",
            parse_mode="Markdown"
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al guardar en Drive.")

async def cmd_resumen(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return
    try:
        creds = creds_from_dict(users_db[uid])
        data = await read_drive_data_async(creds)
        texto = build_resumen(data, current_key())
        await update.message.reply_text(texto, parse_mode="Markdown")
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer los datos.")

async def cmd_historial(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Muestra un teclado con los 12 meses para elegir cuál ver."""
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return

    n = now_ar()
    botones = []
    fila = []
    for i in range(12):
        m = ((n.month - 1 - i) % 12) + 1
        y = n.year if n.month - i > 0 else n.year - 1
        if n.month - i <= 0:
            y = n.year - 1
        # Calcular año correctamente
        mes_idx = n.month - 1 - i
        if mes_idx < 0:
            mes_idx += 12
            y = n.year - 1
        else:
            y = n.year
        m = mes_idx + 1
        key = f"fin4_{y}_{m}"
        label = f"{MESES[mes_idx][:3]} {str(y)[2:]}"
        fila.append(InlineKeyboardButton(label, callback_data=f"hist:{key}"))
        if len(fila) == 4:
            botones.append(fila)
            fila = []
    if fila:
        botones.append(fila)

    await update.message.reply_text(
        "📅 ¿De qué mes querés ver el resumen?",
        reply_markup=InlineKeyboardMarkup(botones)
    )

async def callback_historial(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    uid = str(query.from_user.id)
    if uid not in users_db:
        await query.edit_message_text("Primero conectá tu cuenta con /start.")
        return
    _, key = query.data.split(":", 1)
    try:
        creds = creds_from_dict(users_db[uid])
        data = await read_drive_data_async(creds)
        texto = build_resumen(data, key)
        await query.edit_message_text(texto, parse_mode="Markdown")
    except Exception as e:
        log.exception(e)
        await query.edit_message_text("❌ Error al leer los datos.")

async def cmd_comparar(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return
    try:
        creds = creds_from_dict(users_db[uid])
        data = await read_drive_data_async(creds)
        key_act = current_key()
        key_ant = prev_key()

        if key_ant not in data:
            await update.message.reply_text(
                f"📭 No hay datos del mes anterior ({key_label(key_ant)}) para comparar.\n"
                f"Mostrando solo el mes actual:"
            )
            texto = build_resumen(data, key_act)
            await update.message.reply_text(texto, parse_mode="Markdown")
            return

        def totales(k):
            raw = data.get(k)
            if not raw:
                return 0, 0, 0
            mes = parse_mes(raw)
            if not mes:
                return 0, 0, 0
            ti = mes["sueldo"] + sum(e["monto"] for e in mes["extras_ing"])
            tg = mes["total_srv"] + mes["total_tar_ars"] + mes["super_val"] + sum(e["monto"] for e in mes["extras_gas"])
            return ti, tg, ti - tg

        ti_a, tg_a, disp_a = totales(key_act)
        ti_p, tg_p, disp_p = totales(key_ant)

        def flecha(v_act, v_ant):
            if v_act > v_ant: return "🔺"
            if v_act < v_ant: return "🔻"
            return "➡️"

        texto = (
            f"📊 *Comparación de meses*\n\n"
            f"{'':20} *{key_label(key_ant)[:6]}* → *{key_label(key_act)[:6]}*\n"
            f"💰 Ingresos:  $ {fmt(ti_p)} → $ {fmt(ti_a)} {flecha(ti_a, ti_p)}\n"
            f"📉 Gastos:    $ {fmt(tg_p)} → $ {fmt(tg_a)} {flecha(tg_a, tg_p)}\n"
            f"✅ Disponible:$ {fmt(disp_p)} → $ {fmt(disp_a)} {flecha(disp_a, disp_p)}\n"
        )
        await update.message.reply_text(texto, parse_mode="Markdown")
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer los datos.")

# ──────────────────────────────────────────────
# /servicios — gestión de servicios perpetuos
# ──────────────────────────────────────────────
import uuid as _uuid

def _servicios_keyboard(servicios: list, mode: str = "menu") -> InlineKeyboardMarkup:
    """Teclado inline para listar servicios. mode='menu'|'eliminar'|'comprobante'"""
    botones = []
    for s in servicios:
        sid = s["id"]
        nombre = s["name"]
        if mode == "eliminar":
            botones.append([InlineKeyboardButton(f"🗑 {nombre}", callback_data=f"srv_del:{sid}")])
        elif mode == "comprobante":
            botones.append([InlineKeyboardButton(f"📎 {nombre}", callback_data=f"srv_comp:{sid}:{nombre}")])
        else:
            botones.append([InlineKeyboardButton(nombre, callback_data=f"srv_info:{sid}")])
    if mode == "menu":
        botones.append([
            InlineKeyboardButton("➕ Nuevo servicio", callback_data="srv_nuevo"),
            InlineKeyboardButton("🗑 Eliminar",        callback_data="srv_modo_del"),
        ])
    else:
        botones.append([InlineKeyboardButton("⬅️ Cancelar", callback_data="srv_cancelar")])
    return InlineKeyboardMarkup(botones)

async def cmd_servicios(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return
    try:
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        if not servicios:
            texto = "📋 *Tus servicios*\n\nNo tenés servicios creados todavía."
        else:
            lineas = ["📋 *Tus servicios*\n"]
            for s in servicios:
                lineas.append(f"  • {s['name']}")
            texto = "\n".join(lineas)
        await update.message.reply_text(
            texto,
            parse_mode="Markdown",
            reply_markup=_servicios_keyboard(servicios)
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer servicios.")

async def callback_servicios(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    uid = str(query.from_user.id)
    if uid not in users_db:
        await query.edit_message_text("Primero conectá tu cuenta con /start.")
        return

    data_cb = query.data

    # ── Crear nuevo ──
    if data_cb == "srv_nuevo":
        ctx.user_data["esperando_srv_nombre"] = True
        await query.edit_message_text(
            "✏️ Escribí el nombre del nuevo servicio (ej: *Luz*, *Gas*, *Netflix*):",
            parse_mode="Markdown"
        )
        return

    # ── Modo eliminar ──
    if data_cb == "srv_modo_del":
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        if not servicios:
            await query.edit_message_text("No tenés servicios para eliminar.")
            return
        await query.edit_message_text(
            "🗑 *Seleccioná el servicio a eliminar:*",
            parse_mode="Markdown",
            reply_markup=_servicios_keyboard(servicios, mode="eliminar")
        )
        return

    # ── Confirmar eliminación ──
    if data_cb.startswith("srv_del:"):
        sid = data_cb.split(":", 1)[1]
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        nombre = next((s["name"] for s in servicios if s["id"] == sid), sid)
        servicios = [s for s in servicios if s["id"] != sid]
        await write_servicios_async(creds, servicios)
        await query.edit_message_text(
            f"✅ Servicio *{nombre}* eliminado.\n"
            f"_(La carpeta de comprobantes en Drive no se borra automáticamente.)_",
            parse_mode="Markdown"
        )
        return

    # ── Ver info de un servicio ──
    if data_cb.startswith("srv_info:"):
        sid = data_cb.split(":", 1)[1]
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        srv = next((s for s in servicios if s["id"] == sid), None)
        if not srv:
            await query.edit_message_text("Servicio no encontrado.")
            return
        # Ver monto del mes actual si existe
        fin_data = await read_drive_data_async(creds)
        key = current_key()
        mes_data = fin_data.get(key, {})
        if isinstance(mes_data, str):
            try: mes_data = json.loads(mes_data)
            except: mes_data = {}
        srv_mes = next(
            (s for s in mes_data.get("servicios", []) if s.get("id") == sid), None
        )
        monto_txt = f"$ {fmt(srv_mes['amt'])}" if srv_mes else "Sin cargar este mes"
        await query.edit_message_text(
            f"🏠 *{srv['name']}*\n\n"
            f"💰 {key_label(key)}: {monto_txt}\n\n"
            f"Usá `/gasto MONTO {srv['name'].lower()}` para actualizar.",
            parse_mode="Markdown"
        )
        return

    # ── Cancelar ──
    if data_cb == "srv_cancelar":
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        await query.edit_message_text(
            "📋 *Tus servicios*",
            parse_mode="Markdown",
            reply_markup=_servicios_keyboard(servicios)
        )
        return

async def msg_nuevo_servicio(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Recibe el nombre del nuevo servicio cuando el usuario está en modo creación."""
    if not ctx.user_data.get("esperando_srv_nombre"):
        return  # No es nuestro mensaje
    uid = str(update.effective_chat.id)
    nombre = update.message.text.strip()
    if not nombre or len(nombre) > 50:
        await update.message.reply_text("El nombre debe tener entre 1 y 50 caracteres.")
        return
    ctx.user_data.pop("esperando_srv_nombre", None)
    try:
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        # Verificar duplicado
        if any(s["name"].lower() == nombre.lower() for s in servicios):
            await update.message.reply_text(f"Ya existe un servicio llamado *{nombre}*.", parse_mode="Markdown")
            return
        nuevo = {"id": str(_uuid.uuid4()), "name": nombre}
        servicios.append(nuevo)
        await write_servicios_async(creds, servicios)
        await update.message.reply_text(
            f"✅ Servicio *{nombre}* creado.\n\n"
            f"Ahora podés cargar su monto con:\n`/gasto MONTO {nombre.lower()}`",
            parse_mode="Markdown"
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al crear el servicio.")

# ──────────────────────────────────────────────
# /comprobante — subir y bajar comprobantes
# ──────────────────────────────────────────────

async def cmd_comprobante(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Muestra los servicios para elegir a cuál subir comprobante."""
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return
    try:
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        if not servicios:
            await update.message.reply_text(
                "No tenés servicios creados.\nCreá uno con /servicios primero."
            )
            return
        await update.message.reply_text(
            "📎 *¿A qué servicio querés subir el comprobante?*",
            parse_mode="Markdown",
            reply_markup=_servicios_keyboard(servicios, mode="comprobante")
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer servicios.")

async def callback_comprobante(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """El usuario eligió el servicio; queda esperando el archivo."""
    query = update.callback_query
    await query.answer()
    uid = str(query.from_user.id)
    # data: srv_comp:<id>:<nombre>
    parts = query.data.split(":", 2)
    sid, nombre = parts[1], parts[2]
    ctx.user_data["comp_srv_id"]   = sid
    ctx.user_data["comp_srv_name"] = nombre
    ctx.user_data["esperando_comp"] = True
    n = now_ar()
    ctx.user_data["comp_mes_prefix"] = f"{n.year}-{n.month:02d}"
    await query.edit_message_text(
        f"📎 *{nombre}* — enviame el archivo (PDF, foto JPG/PNG).\n\n"
        f"Se guardará en Drive → Finanzas/Comprobantes/{nombre}/",
        parse_mode="Markdown"
    )

async def msg_recibir_comprobante(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Recibe el archivo/foto y lo sube a Drive."""
    if not ctx.user_data.get("esperando_comp"):
        return
    uid = str(update.effective_chat.id)
    nombre_srv = ctx.user_data["comp_srv_name"]
    mes_prefix  = ctx.user_data["comp_mes_prefix"]

    # Determinar qué llegó
    file_obj = None
    mime = "application/octet-stream"
    ext  = "bin"

    if update.message.document:
        doc = update.message.document
        mime = doc.mime_type or mime
        ext  = doc.file_name.rsplit(".", 1)[-1] if doc.file_name and "." in doc.file_name else "pdf"
        file_obj = doc
    elif update.message.photo:
        file_obj = update.message.photo[-1]  # mayor resolución
        mime = "image/jpeg"
        ext  = "jpg"
    else:
        await update.message.reply_text(
            "Por favor enviá un archivo PDF o una foto (JPG/PNG)."
        )
        return

    ctx.user_data.pop("esperando_comp", None)

    try:
        tg_file = await file_obj.get_file()
        content = bytes(await tg_file.download_as_bytearray())

        # Nombre del archivo: 2026-10_<timestamp>.<ext>
        ts = now_ar().strftime("%H%M%S")
        filename = f"{mes_prefix}_{ts}.{ext}"

        creds = creds_from_dict(users_db[uid])
        file_id = await upload_comprobante_async(
            creds, nombre_srv, filename, content, mime
        )
        await update.message.reply_text(
            f"✅ Comprobante guardado en Drive:\n"
            f"  📁 Finanzas/Comprobantes/{nombre_srv}/\n"
            f"  📄 {filename}",
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al subir el comprobante a Drive.")

async def cmd_ver_comprobantes(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Muestra los servicios para elegir de cuál ver comprobantes del mes actual."""
    uid = str(update.effective_chat.id)
    if uid not in users_db:
        await update.message.reply_text("Primero conectá tu cuenta con /start.")
        return
    try:
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        if not servicios:
            await update.message.reply_text("No tenés servicios creados.")
            return

        botones = []
        n = now_ar()
        mes_prefix = f"{n.year}-{n.month:02d}"
        for s in servicios:
            botones.append([InlineKeyboardButton(
                s["name"],
                callback_data=f"ver_comp:{s['id']}:{s['name']}:{mes_prefix}"
            )])
        await update.message.reply_text(
            f"📂 *Comprobantes del mes*\n¿De qué servicio?",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(botones)
        )
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer servicios.")

async def callback_ver_comprobantes(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Lista los comprobantes del servicio elegido y permite descargarlos."""
    query = update.callback_query
    await query.answer()
    uid = str(query.from_user.id)
    # data: ver_comp:<id>:<nombre>:<mes_prefix>
    parts = query.data.split(":", 3)
    sid, nombre, mes_prefix = parts[1], parts[2], parts[3]

    try:
        creds = creds_from_dict(users_db[uid])
        archivos = await list_comprobantes_async(creds, nombre, mes_prefix)

        if not archivos:
            await query.edit_message_text(
                f"📭 No hay comprobantes de *{nombre}* para {mes_prefix}.",
                parse_mode="Markdown"
            )
            return

        botones = [
            [InlineKeyboardButton(f"⬇️ {a['name']}", callback_data=f"dl_comp:{a['id']}:{a['name']}")]
            for a in archivos
        ]
        await query.edit_message_text(
            f"📂 *Comprobantes — {nombre} ({mes_prefix})*\n\nElegí cuál descargar:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(botones)
        )
    except Exception as e:
        log.exception(e)
        await query.edit_message_text("❌ Error al listar comprobantes.")

async def callback_dl_comprobante(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Descarga y envía el comprobante al usuario."""
    query = update.callback_query
    await query.answer("Descargando…")
    uid = str(query.from_user.id)
    parts = query.data.split(":", 2)
    file_id, filename = parts[1], parts[2]

    try:
        creds = creds_from_dict(users_db[uid])
        content = await download_file_async(creds, file_id)
        await query.message.reply_document(
            document=io.BytesIO(content),
            filename=filename,
            caption=f"📄 {filename}"
        )
    except Exception as e:
        log.exception(e)
        await query.message.reply_text("❌ Error al descargar el comprobante.")

# ──────────────────────────────────────────────
# Notificaciones automáticas
# ──────────────────────────────────────────────
async def notif_cierre(ctx: ContextTypes.DEFAULT_TYPE):
    """Día 28, 20hs: recordatorio de cierre."""
    n = now_ar()
    if n.day != 28:
        return
    label = key_label(current_key())
    for uid in list(users_db.keys()):
        try:
            await ctx.bot.send_message(
                chat_id=int(uid),
                text=(
                    f"🔔 *Recordatorio de cierre de mes*\n\n"
                    f"Quedan pocos días de {label}.\n"
                    f"¿Tenés algún gasto o ingreso pendiente de cargar?\n\n"
                    f"Usá /gasto, /ingreso o /tarjeta para registrarlo."
                ),
                parse_mode="Markdown"
            )
        except Exception as e:
            log.warning(f"No se pudo notificar a {uid}: {e}")

async def notif_nuevo_mes(ctx: ContextTypes.DEFAULT_TYPE):
    """Día 1, 9hs: resumen del mes cerrado + aviso de nuevo mes."""
    n = now_ar()
    if n.day != 1:
        return
    # El mes anterior es el que cerró
    ant_key = prev_key()
    nuevo_label = key_label(current_key())

    for uid in list(users_db.keys()):
        try:
            creds = creds_from_dict(users_db[uid])
            data = await read_drive_data_async(creds)
            resumen = build_resumen(data, ant_key)
            await ctx.bot.send_message(
                chat_id=int(uid),
                text=(
                    f"📅 *¡Comenzó {nuevo_label}!*\n\n"
                    f"Aquí el resumen del mes que cerró:\n\n"
                    f"{resumen}\n\n"
                    f"🆕 Ya podés empezar a cargar los datos de {nuevo_label}."
                ),
                parse_mode="Markdown"
            )
        except Exception as e:
            log.warning(f"No se pudo notificar a {uid}: {e}")

# ──────────────────────────────────────────────
# Setup de comandos en el menú de Telegram
# ──────────────────────────────────────────────
async def post_init(app: Application):
    await app.bot.set_my_commands([
        BotCommand("start",            "Conectar con Google Drive"),
        BotCommand("desconectar",      "Desconectar cuenta de Google"),
        BotCommand("servicios",        "Gestionar servicios (luz, gas, etc.)"),
        BotCommand("comprobante",      "Subir comprobante de un servicio"),
        BotCommand("vercomprobantes",  "Ver/descargar comprobantes"),
        BotCommand("gasto",            "Registrar un gasto o servicio"),
        BotCommand("ingreso",          "Registrar un ingreso"),
        BotCommand("tarjeta",          "Registrar pago de tarjeta"),
        BotCommand("resumen",          "Ver resumen del mes actual"),
        BotCommand("historial",        "Ver resumen de otro mes"),
        BotCommand("comparar",         "Comparar con mes anterior"),
        BotCommand("ayuda",            "Ver todos los comandos"),
    ])

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
def main():
    WEBHOOK_URL = os.environ.get("WEBHOOK_URL", REDIRECT_URI.replace("/oauth/callback", ""))

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .updater(None)   # Sin updater propio — usamos webhook vía aiohttp
        .build()
    )

    # Handlers
    application.add_handler(CommandHandler("start",           cmd_start))
    application.add_handler(CommandHandler("desconectar",     cmd_desconectar))
    application.add_handler(CommandHandler("ayuda",           cmd_ayuda))
    application.add_handler(CommandHandler("gasto",           cmd_gasto))
    application.add_handler(CommandHandler("ingreso",         cmd_ingreso))
    application.add_handler(CommandHandler("tarjeta",         cmd_tarjeta))
    application.add_handler(CommandHandler("resumen",         cmd_resumen))
    application.add_handler(CommandHandler("historial",       cmd_historial))
    application.add_handler(CommandHandler("comparar",        cmd_comparar))
    application.add_handler(CommandHandler("servicios",       cmd_servicios))
    application.add_handler(CommandHandler("comprobante",     cmd_comprobante))
    application.add_handler(CommandHandler("vercomprobantes", cmd_ver_comprobantes))

    # Callbacks inline — orden importante: los más específicos primero
    application.add_handler(CallbackQueryHandler(callback_historial,       pattern=r"^hist:"))
    application.add_handler(CallbackQueryHandler(callback_comprobante,     pattern=r"^srv_comp:"))
    application.add_handler(CallbackQueryHandler(callback_ver_comprobantes,pattern=r"^ver_comp:"))
    application.add_handler(CallbackQueryHandler(callback_dl_comprobante,  pattern=r"^dl_comp:"))
    application.add_handler(CallbackQueryHandler(callback_servicios,       pattern=r"^srv_"))

    # Mensajes de texto/archivos para flujos conversacionales
    application.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND, msg_nuevo_servicio
    ))
    application.add_handler(MessageHandler(
        (filters.Document.ALL | filters.PHOTO) & ~filters.COMMAND,
        msg_recibir_comprobante
    ))

    # Job queue — notificaciones automáticas (hora Argentina = UTC-3)
    jq = application.job_queue
    # Día 28 a las 20:00 ART = 23:00 UTC
    jq.run_daily(notif_cierre,    time=__import__("datetime").time(23, 0), days=(0,1,2,3,4,5,6))
    # Día 1 a las 09:00 ART = 12:00 UTC
    jq.run_daily(notif_nuevo_mes, time=__import__("datetime").time(12, 0), days=(0,1,2,3,4,5,6))

    async def telegram_webhook(request: web.Request) -> web.Response:
        """Recibe updates de Telegram vía webhook."""
        data = await request.json()
        update = Update.de_json(data, application.bot)
        await application.process_update(update)
        return web.Response(text="ok")

    # Servidor web unificado: webhook de Telegram + OAuth callback
    web_app = web.Application()
    web_app["bot_app"] = application
    web_app.router.add_post(f"/webhook/{BOT_TOKEN}", telegram_webhook)
    web_app.router.add_get("/oauth/callback", oauth_callback)
    web_app.router.add_get("/health", lambda r: web.Response(text="ok"))

    async def run():
        await application.initialize()
        await application.start()

        # Registrar webhook en Telegram
        webhook_endpoint = f"{WEBHOOK_URL}/webhook/{BOT_TOKEN}"
        await application.bot.set_webhook(
            url=webhook_endpoint,
            drop_pending_updates=True,
        )
        log.info(f"Webhook registrado: {webhook_endpoint}")

        runner = web.AppRunner(web_app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", PORT)
        await site.start()
        log.info(f"Bot corriendo en el puerto {PORT}")

        try:
            await asyncio.Event().wait()
        finally:
            await application.bot.delete_webhook()
            await application.stop()
            await application.shutdown()

    asyncio.run(run())

if __name__ == "__main__":
    main()
