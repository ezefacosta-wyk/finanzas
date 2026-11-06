"""
Bot de Telegram — Mis Finanzas
Stack: python-telegram-bot 20.x, Google Drive API (OAuth por usuario)
"""

import os, sys, json, re, io, logging, asyncio, hmac, hashlib, time, signal, tempfile, threading
from urllib.parse import urlparse, parse_qs
from datetime import datetime, date
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor

from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand, LinkPreviewOptions
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters,
    TypeHandler, ApplicationHandlerStop
)
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from aiohttp import web

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def _load_env(path: str):
    """Carga KEY=VALOR de un archivo .env (sin dependencias). No pisa variables ya definidas."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

_load_env(os.path.join(BASE_DIR, ".env"))

def _required(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v or v.startswith("PEGAR_") or v.startswith("COMPLETAR"):
        sys.exit(f"Falta configurar {name} en el archivo .env ({os.path.join(BASE_DIR, '.env')})")
    return v

BOT_TOKEN     = _required("BOT_TOKEN")
CLIENT_ID     = _required("GOOGLE_CLIENT_ID")
CLIENT_SECRET = _required("GOOGLE_CLIENT_SECRET")
PORT          = int(os.environ.get("PORT") or 8080)
# polling: el bot busca los mensajes en Telegram (no necesita IP pública ni abrir puertos)
# webhook: Telegram le envía los mensajes a una URL pública (como en Railway)
MODE          = (os.environ.get("MODE") or "polling").strip().lower()
# En polling el servidor web sólo atiende el regreso de Google, y sólo desde esta misma PC
BIND_HOST     = os.environ.get("BIND_HOST") or ("127.0.0.1" if MODE == "polling" else "0.0.0.0")
REDIRECT_URI  = os.environ.get("REDIRECT_URI") or f"http://localhost:{PORT}/oauth/callback"
WEBHOOK_URL   = os.environ.get("WEBHOOK_URL") or REDIRECT_URI.replace("/oauth/callback", "")
DATA_DIR      = os.environ.get("DATA_DIR") or os.path.join(BASE_DIR, "data")
TZ = ZoneInfo("America/Buenos_Aires")

# ── Seguridad ──
# Chats autorizados a usar el bot (IDs separados por coma). Si está vacío, nadie puede usarlo:
# el bot sólo responde con el ID de chat de quien le escribe, para poder configurarlo.
ALLOWED_CHAT_IDS = {x.strip() for x in os.environ.get("ALLOWED_CHAT_IDS", "").split(",") if x.strip()}
# Secreto que Telegram manda en cada webhook (cabecera X-Telegram-Bot-Api-Secret-Token).
# Si no se define, se deriva del BOT_TOKEN: cambia solo al revocar el token.
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET") or hmac.new(
    BOT_TOKEN.encode(), b"finanzas-webhook-secret", hashlib.sha256).hexdigest()
WEBHOOK_PATH = "/telegram/webhook"   # ya no lleva el token en la URL
OAUTH_STATE_TTL = 15 * 60            # los links de /start vencen a los 15 minutos

def is_allowed(chat_id) -> bool:
    return str(chat_id) in ALLOWED_CHAT_IDS

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
DATA_FOLDER        = "Datos"   # Finanzas/Datos/: los .json de la app (igual que la web)
COMPROBANTES_FOLDER = "Comprobantes"

MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
         "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]

CATEGORIAS_FIJAS = {
    "super": "Super/Mercado",
    "mercado": "Super/Mercado",
    "extra": "Gasto Extra",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)   # en polling registraría cada consulta a Telegram
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Almacenamiento simple en memoria + JSON local
# (en data/, con permisos sólo para el usuario que corre el bot)
# ──────────────────────────────────────────────
os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
USERS_FILE  = os.path.join(DATA_DIR, "users.json")         # sesión de Google (refresh token): permisos 600
STATES_FILE = os.path.join(DATA_DIR, "oauth_states.json")
NOTIF_FILE  = os.path.join(DATA_DIR, "notificaciones.json") # qué notificaciones ya se enviaron

def _write_private_json(path: str, obj):
    """Escribe JSON de forma atómica y sólo legible por el usuario dueño (600)."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def load_users() -> dict:
    if os.path.exists(USERS_FILE):
        with open(USERS_FILE) as f:
            return json.load(f)
    return {}

def save_users(users: dict):
    _write_private_json(USERS_FILE, users)

def load_states() -> dict:
    if os.path.exists(STATES_FILE):
        with open(STATES_FILE) as f:
            return json.load(f)
    return {}

def save_states(states: dict):
    _write_private_json(STATES_FILE, states)

users_db: dict = load_users()   # { telegram_id: {creds, name, ...} }

# ──────────────────────────────────────────────
# Helpers de fecha
# ──────────────────────────────────────────────
def now_ar() -> datetime:
    return datetime.now(TZ)

# En el bot los meses se manejan como (año, mes) con mes de 1 a 12.
def mes_actual() -> tuple[int, int]:
    n = now_ar()
    return n.year, n.month

def mes_anterior(y: int, m: int) -> tuple[int, int]:
    return (y - 1, 12) if m == 1 else (y, m - 1)

def mes_label(y: int, m: int) -> str:
    return f"{MESES[m-1]} {y}"

def md(texto) -> str:
    """Escapa texto del usuario (nombres de servicios, tarjetas, etc.) para parse_mode=Markdown.
    Sin esto, un nombre con _ o * hace que Telegram rechace el mensaje entero."""
    s = str(texto)
    for ch in ("_", "*", "`", "["):
        s = s.replace(ch, "\\" + ch)
    return s

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

def dq(v: str) -> str:
    """Texto seguro dentro de una consulta de Drive ('...')."""
    return str(v).replace("\\", "\\\\").replace("'", "\\'")

def find_folder(drive, name: str, parent_id: str | None = None) -> str | None:
    """Busca una carpeta por nombre. Si parent_id es None busca en root."""
    parent_q = f"'{parent_id}' in parents" if parent_id else "'root' in parents"
    q = f"name='{dq(name)}' and mimeType='application/vnd.google-apps.folder' and {parent_q} and trashed=false"
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
    q = f"name='{dq(name)}' and '{folder_id}' in parents and trashed=false"
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

# ── Carpeta de datos: Finanzas/Datos/ ───────────────────────────────────────

def get_data_folder(drive, root_id: str) -> str:
    return ensure_folder(drive, DATA_FOLDER, root_id)

def find_data_file(drive, name: str, root_id: str) -> tuple[str | None, str]:
    """Busca un .json en Finanzas/Datos/. Si todavía está suelto en Finanzas/, lo mueve
    a Datos (conserva el mismo id, no se borra nada). Devuelve (file_id, data_folder_id)."""
    data_id = get_data_folder(drive, root_id)
    fid = find_file_in_folder(drive, name, data_id)
    if fid:
        return fid, data_id
    old = find_file_in_folder(drive, name, root_id)
    if old:
        drive.files().update(fileId=old, addParents=data_id, removeParents=root_id,
                             fields="id").execute()
        log.info(f"'{name}' movido a {DRIVE_ROOT_FOLDER}/{DATA_FOLDER}/ (id={old})")
        return old, data_id
    return None, data_id

# ── Datos de cada mes ───────────────────────────────────────────────────────
# Son los mismos archivos que usa la web: Finanzas/Datos/finanzas_AAAA_MM.json (MM = 01..12),
# con el formato de la web:
#   { sueldo, extras:[{name,amt}], superAmt, gastosExtra:[{name,amt,fecha}],
#     servicios:[{id,name,amt}],
#     tarjetas:[{name,total,minimo,usdTotal,usdMinimo,tcambio,pagado,extraPagos:[{name,amt}],detalle:[]}] }
# La web suma los amt de las listas sin convertirlos, así que siempre se guardan como números.
#
# finanzas_data.json es el archivo viejo (todos los meses juntos). Ahí la web guardaba cada mes
# como texto JSON con la clave fin4_AAAA_M (mes de 0 a 11) y las versiones anteriores del bot
# guardaban objetos con otro formato bajo fin4_AAAA_M (mes de 1 a 12). Se usa sólo para leer
# meses que todavía no tienen su archivo, y para pasar una vez lo que había cargado el bot.

MONTH_KEY_RE = re.compile(r"^fin4_(\d{4})_(\d{1,2})$")

def month_file_name(y: int, m: int) -> str:
    return f"finanzas_{y}_{m:02d}.json"

def nv(v) -> float:
    """Número de un monto guardado ('' / None / texto inválido → 0), como nv() de la web."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f and f not in (float("inf"), float("-inf")) else 0.0

def nueva_tarjeta(name: str = "") -> dict:
    return {"name": name, "total": "", "minimo": "", "usdTotal": "", "usdMinimo": "",
            "tcambio": "", "pagado": "", "extraPagos": [], "detalle": []}

def tc_name(t: dict, i: int) -> str:
    return (t.get("name") or "").strip() or f"Tarjeta {i+1}"

def mes_vacio(servicios_perp: list, anterior: dict | None = None) -> dict:
    """Mes nuevo. Las tarjetas toman los nombres del mes anterior (sin montos)."""
    nombres = [t.get("name") for t in (anterior or {}).get("tarjetas") or []
               if isinstance(t, dict) and (t.get("name") or "").strip()]
    return {
        "sueldo": "", "extras": [],
        "tarjetas": [nueva_tarjeta(n) for n in nombres] or [nueva_tarjeta(), nueva_tarjeta()],
        "servicios": [{"id": s["id"], "name": s["name"], "amt": 0} for s in servicios_perp],
        "superAmt": "", "gastosExtra": [],
    }

def normalizar_mes(st: dict, servicios_perp: list) -> dict:
    """Completa lo que falte para que la web pueda abrir el mes y agrega los servicios nuevos."""
    st.setdefault("sueldo", "")
    st.setdefault("superAmt", "")
    for k in ("extras", "gastosExtra", "servicios", "tarjetas"):
        st[k] = [x for x in (st.get(k) or []) if isinstance(x, dict)]
    for lst in (st["extras"], st["gastosExtra"], st["servicios"]):
        for x in lst:
            x["amt"] = nv(x.get("amt"))
    base = nueva_tarjeta()
    for t in st["tarjetas"]:
        for k, v in base.items():
            t.setdefault(k, [] if isinstance(v, list) else v)
        t["extraPagos"] = [p for p in (t.get("extraPagos") or []) if isinstance(p, dict)]
        for p in t["extraPagos"]:
            p["amt"] = nv(p.get("amt"))
    ids = {s.get("id") for s in st["servicios"]}
    for s in servicios_perp:
        if s.get("id") not in ids:
            st["servicios"].append({"id": s["id"], "name": s["name"], "amt": 0})
    return st

def calc_mes(st: dict) -> dict:
    """Mismo cálculo que calcMes() de la web.
    Disponible = ingresos − pagos realizados (tarjetas pagadas + servicios + super + gastos extra)."""
    ing = nv(st.get("sueldo")) + sum(nv(e.get("amt")) for e in st.get("extras") or [])
    tc_pag = sum(nv(t.get("pagado")) + sum(nv(p.get("amt")) for p in t.get("extraPagos") or [])
                 for t in st.get("tarjetas") or [])
    tc_total = sum(nv(t.get("total")) for t in st.get("tarjetas") or [])
    sv = sum(nv(s.get("amt")) for s in st.get("servicios") or [])
    sup = nv(st.get("superAmt"))
    gx = sum(nv(g.get("amt")) for g in st.get("gastosExtra") or [])
    pagos = tc_pag + sv + sup + gx
    return {"ing": ing, "tc_pag": tc_pag, "tc_total": tc_total, "sv": sv, "sup": sup,
            "gx": gx, "pagos": pagos, "disp": ing - pagos}

# ── Operaciones sobre un mes (las usan los comandos y la migración) ──

def buscar_tarjeta(st: dict, nombre: str) -> int | None:
    """Índice de la tarjeta cuyo nombre coincide (exacto, o el único que empieza/contiene el texto)."""
    q = nombre.strip().lower()
    if not q:
        return None
    nombres = [tc_name(t, i).lower() for i, t in enumerate(st["tarjetas"])]
    for criterio in (lambda n: n == q, lambda n: n.startswith(q), lambda n: q in n):
        hits = [i for i, n in enumerate(nombres) if criterio(n)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            return None
    return None

def pagar_tarjeta(st: dict, idx: int, monto: float) -> str:
    """Registra un pago. Si la tarjeta ya tenía un pago cargado, se suma como pago adicional."""
    t = st["tarjetas"][idx]
    if nv(t.get("pagado")):
        t["extraPagos"].append({"name": "Pago (Telegram)", "amt": monto})
        return "adicional"
    t["pagado"] = monto
    return "pago"

def poner_servicio(st: dict, srv_id: str, nombre: str, monto: float) -> float:
    """Pone el monto del mes de un servicio. Devuelve el monto que tenía antes."""
    s = next((x for x in st["servicios"] if x.get("id") == srv_id), None)
    if s is None:
        s = {"id": srv_id, "name": nombre, "amt": 0}
        st["servicios"].append(s)
    antes = nv(s.get("amt"))
    s["amt"] = monto
    return antes

def aplicar_mes_bot_viejo(st: dict, viejo: dict, servicios_perp: list):
    """Pasa al formato de la web lo que una versión anterior del bot guardó para un mes."""
    ing = viejo.get("ingresos") if isinstance(viejo.get("ingresos"), dict) else {}
    if nv(ing.get("sueldo")) and not nv(st.get("sueldo")):
        st["sueldo"] = nv(ing["sueldo"])
    for e in ing.get("extras") or []:
        if isinstance(e, dict) and nv(e.get("monto")):
            st["extras"].append({"name": e.get("desc") or "Ingreso", "amt": nv(e["monto"])})
    og = viejo.get("otrosGastos") if isinstance(viejo.get("otrosGastos"), dict) else {}
    if nv(og.get("super")):
        st["superAmt"] = nv(st.get("superAmt")) + nv(og["super"])
    for e in og.get("extras") or []:
        if isinstance(e, dict) and nv(e.get("monto")):
            st["gastosExtra"].append({"name": e.get("desc") or "Gasto extra", "amt": nv(e["monto"]), "fecha": ""})
    srv = viejo.get("servicios")
    if isinstance(srv, list):
        for s in srv:
            if isinstance(s, dict) and s.get("id") and nv(s.get("amt")):
                poner_servicio(st, s["id"], s.get("name") or "Servicio", nv(s["amt"]))
    elif isinstance(srv, dict):
        for k, v in srv.items():
            if not nv(v):
                continue
            p = next((x for x in servicios_perp if x["name"].lower() == str(k).lower()), None)
            if p:
                poner_servicio(st, p["id"], p["name"], nv(v))
            else:
                st["gastosExtra"].append({"name": str(k).capitalize(), "amt": nv(v), "fecha": ""})
    for t in viejo.get("tarjetas") or []:
        if not isinstance(t, dict) or not nv(t.get("pagado")):
            continue
        nombre = (t.get("nombre") or t.get("name") or "Tarjeta").strip()
        idx = buscar_tarjeta(st, nombre)
        if idx is None:
            st["tarjetas"].append(nueva_tarjeta(nombre.title()))
            idx = len(st["tarjetas"]) - 1
        pagar_tarjeta(st, idx, nv(t["pagado"]))

# ── Lectura / escritura en Drive ──

def _leer_global(drive, root_id: str) -> tuple[str | None, dict | None]:
    fid, _ = find_data_file(drive, DATA_FILE, root_id)
    if not fid:
        return None, None
    try:
        g = read_json_file(drive, fid)
    except Exception as e:
        log.warning(f"No se pudo leer {DATA_FILE}: {e}")
        return fid, None
    return fid, (g if isinstance(g, dict) else None)

def _leer_mes_drive(drive, root_id: str, y: int, m: int, glob: dict | None = None,
                    glob_leido: bool = False) -> tuple[dict | None, str | None]:
    """(estado del mes en formato web o None, id del archivo del mes o None)."""
    fid, _ = find_data_file(drive, month_file_name(y, m), root_id)
    if fid:
        try:
            st = read_json_file(drive, fid)
        except Exception as e:
            log.warning(f"No se pudo leer {month_file_name(y, m)}: {e}")
            st = None
        return (st if isinstance(st, dict) else None), fid
    # Sin archivo propio: el mes puede estar todavía en el archivo viejo (formato web, mes 0..11)
    if not glob_leido:
        _, glob = _leer_global(drive, root_id)
    v = (glob or {}).get(f"fin4_{y}_{m-1}")
    if isinstance(v, str):
        try:
            st = json.loads(v)
            if isinstance(st, dict):
                return st, None
        except ValueError:
            pass
    return None, None

def _servicios_drive(drive, root_id: str) -> list:
    fid, _ = find_data_file(drive, SERVICIOS_FILE, root_id)
    if not fid:
        return []
    d = read_json_file(drive, fid)
    return [s for s in d if isinstance(s, dict) and s.get("id")] if isinstance(d, list) else []

_migracion_hecha: set[str] = set()   # carpetas Finanzas/ ya revisadas en esta ejecución
# Un cambio a la vez: dos /gasto seguidos leen y guardan el mismo archivo y uno pisaría al otro.
_mes_lock = threading.RLock()

def migrar_datos_bot_viejo(drive, root_id: str, servicios_perp: list):
    """Una sola vez: lo que versiones anteriores del bot guardaron en finanzas_data.json
    (/gasto, /ingreso, /tarjeta) se pasa al archivo de cada mes, que es lo que lee la web.
    Antes se guarda una copia completa del archivo viejo como respaldo."""
    with _mes_lock:
        if root_id in _migracion_hecha:
            return
        _migrar(drive, root_id, servicios_perp)
        _migracion_hecha.add(root_id)

def _migrar(drive, root_id: str, servicios_perp: list):
    gid, glob = _leer_global(drive, root_id)
    viejos = {k: v for k, v in (glob or {}).items() if isinstance(v, dict) and MONTH_KEY_RE.match(k)}
    if viejos:
        data_id = get_data_folder(drive, root_id)
        hoy = now_ar().strftime("%Y-%m-%d")
        write_json_file(drive, f"finanzas_data (respaldo bot {hoy}).json", data_id, glob)
        for k, viejo in sorted(viejos.items()):
            yy, mm = (int(x) for x in MONTH_KEY_RE.match(k).groups())
            if not 1 <= mm <= 12:
                continue
            st, fid = _leer_mes_drive(drive, root_id, yy, mm, glob, glob_leido=True)
            if st is None and fid:
                log.warning(f"Migración: {month_file_name(yy, mm)} ilegible, se deja como está")
                continue
            if st is None:
                st = mes_vacio(servicios_perp)
            normalizar_mes(st, servicios_perp)
            aplicar_mes_bot_viejo(st, viejo, servicios_perp)
            write_json_file(drive, month_file_name(yy, mm), data_id, st, fid)
            log.info(f"Migración: datos del bot de {mes_label(yy, mm)} pasados a {month_file_name(yy, mm)}")
        limpio = {k: v for k, v in glob.items() if k not in viejos}
        write_json_file(drive, DATA_FILE, data_id, limpio, gid)

def leer_mes(creds: Credentials, y: int, m: int) -> dict | None:
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    perp = _servicios_drive(drive, root_id)
    migrar_datos_bot_viejo(drive, root_id, perp)
    st, _ = _leer_mes_drive(drive, root_id, y, m)
    return normalizar_mes(st, perp) if st is not None else None

def modificar_mes(creds: Credentials, y: int, m: int, cambio):
    """Lee el mes (o lo crea), llama a cambio(estado, servicios) y, si devuelve (True, info),
    guarda el archivo del mes. Devuelve (guardado, info, estado)."""
    with _mes_lock:
        return _modificar_mes(creds, y, m, cambio)

def _modificar_mes(creds: Credentials, y: int, m: int, cambio):
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    perp = _servicios_drive(drive, root_id)
    migrar_datos_bot_viejo(drive, root_id, perp)
    st, fid = _leer_mes_drive(drive, root_id, y, m)
    if st is None:
        if fid:   # existe pero no se pudo leer: no pisarlo
            raise RuntimeError(f"No se pudo leer {month_file_name(y, m)}")
        anterior, _ = _leer_mes_drive(drive, root_id, *mes_anterior(y, m))
        st = mes_vacio(perp, anterior)
    normalizar_mes(st, perp)
    guardar, info = cambio(st, perp)
    if guardar:
        write_json_file(drive, month_file_name(y, m), get_data_folder(drive, root_id), st, fid)
    return guardar, info, st

# ── servicios.json ──────────────────────────────────────────────────────────

def read_servicios(creds: Credentials) -> list:
    """Devuelve la lista de servicios perpetuos del usuario."""
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    fid, _ = find_data_file(drive, SERVICIOS_FILE, root_id)
    if not fid:
        return []
    return read_json_file(drive, fid)

def write_servicios(creds: Credentials, servicios: list):
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    fid, data_id = find_data_file(drive, SERVICIOS_FILE, root_id)
    write_json_file(drive, SERVICIOS_FILE, data_id, servicios, fid)

# ── Subir comprobante ───────────────────────────────────────────────────────

def upload_comprobante(creds: Credentials, servicio_name: str,
                       filename: str, content: bytes, mime: str, mes_prefix: str) -> str:
    """Sube un archivo a Finanzas/Comprobantes/<servicio>/<AAAA-MM>/ (igual que la web).
    Devuelve el file id."""
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    srv_folder_id = ensure_folder(drive, mes_prefix, get_comprobantes_folder(drive, root_id, servicio_name))
    buf = io.BytesIO(content)
    media = MediaIoBaseUpload(buf, mimetype=mime)
    meta = {"name": filename, "parents": [srv_folder_id]}
    f = drive.files().create(body=meta, media_body=media, fields="id,webViewLink").execute()
    log.info(f"Comprobante subido: {filename} (id={f['id']})")
    return f["id"]

def _archivos_en(drive, folder_id: str) -> list:
    q = f"'{folder_id}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false"
    res = drive.files().list(q=q, spaces="drive", pageSize=200, fields="files(id,name)").execute()
    return res.get("files", [])

def list_comprobantes(creds: Credentials, servicio_name: str, mes_prefix: str) -> list:
    """Comprobantes de un servicio para un mes ('2026-10'). Devuelve [{id, name}].
    Mira las dos ubicaciones: Comprobantes/<servicio>/<AAAA-MM>/ (web y bot actual) y archivos
    'AAAA-MM_...' sueltos en Comprobantes/<servicio>/ (versiones anteriores del bot)."""
    drive = get_drive(creds)
    root_id = get_root_folder(drive)
    comp_id = find_folder(drive, COMPROBANTES_FOLDER, root_id)
    srv_id = find_folder(drive, servicio_name, comp_id) if comp_id else None
    if not srv_id:
        return []
    archivos = [f for f in _archivos_en(drive, srv_id) if f["name"].startswith(mes_prefix)]
    mes_id = find_folder(drive, mes_prefix, srv_id)
    if mes_id:
        archivos += _archivos_en(drive, mes_id)
    return sorted(archivos, key=lambda f: f["name"].lower())

def file_name(creds: Credentials, file_id: str) -> str:
    return get_drive(creds).files().get(fileId=file_id, fields="name").execute().get("name", "comprobante")

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

async def leer_mes_async(creds: Credentials, y: int, m: int) -> dict | None:
    return await _run_in_executor(leer_mes, creds, y, m)

async def modificar_mes_async(creds: Credentials, y: int, m: int, cambio):
    return await _run_in_executor(modificar_mes, creds, y, m, cambio)

async def read_servicios_async(creds: Credentials) -> list:
    return await _run_in_executor(read_servicios, creds)

async def write_servicios_async(creds: Credentials, servicios: list):
    return await _run_in_executor(write_servicios, creds, servicios)

async def upload_comprobante_async(creds, servicio_name, filename, content, mime, mes_prefix) -> str:
    return await _run_in_executor(upload_comprobante, creds, servicio_name, filename, content, mime, mes_prefix)

async def list_comprobantes_async(creds, servicio_name, mes_prefix) -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _drive_executor, list_comprobantes,
        creds, servicio_name, mes_prefix
    )

async def download_file_async(creds, file_id) -> bytes:
    return await _run_in_executor(download_file, creds, file_id)

async def file_name_async(creds, file_id) -> str:
    return await _run_in_executor(file_name, creds, file_id)

# ──────────────────────────────────────────────
# Parsear montos (acepta 1500 / 1.500 / 1,500 / 1.500,00 / 1,500.00)
# ──────────────────────────────────────────────
def parse_monto(texto: str):
    """Devuelve float o None. Formato argentino primero: 2.600.000 / 4.500,50 / 1500 / 1,5.
    También 1,234.56 (si aparecen punto y coma, el último es el decimal)."""
    t = str(texto).strip().replace(" ", "").replace("$", "")
    if not re.fullmatch(r"\d[\d.,]*", t):
        return None
    if "." in t and "," in t:
        dec = "," if t.rfind(",") > t.rfind(".") else "."
        mil = "." if dec == "," else ","
        t = t.replace(mil, "").replace(dec, ".")
    elif t.count(".") > 1 or t.count(",") > 1:
        # 2.600.000 / 2,600,000: separadores de miles
        sep = "." if "." in t else ","
        if not re.fullmatch(rf"\d{{1,3}}(\{sep}\d{{3}})+", t):
            return None
        t = t.replace(sep, "")
    elif "." in t or "," in t:
        sep = "." if "." in t else ","
        ent, frac = t.split(sep)
        # 4.500 → miles; 4,5 / 4.50 → decimales
        t = ent + frac if len(frac) == 3 else ent + "." + frac
    try:
        return float(t)
    except ValueError:
        return None

# ──────────────────────────────────────────────
# Formato de números
# ──────────────────────────────────────────────
def fmt(v: float, decimals: int | None = None) -> str:
    """1234567.5 → '1.234.567,50'. Sin decimals: sin centavos si el monto es entero (como la web)."""
    if v is None:
        return "—"
    if decimals is None:
        decimals = 0 if abs(v - round(v)) < 0.005 else 2
    fmt_str = f"{v:,.{decimals}f}"
    # Cambiar separadores al estilo argentino
    return fmt_str.replace(",", "X").replace(".", ",").replace("X", ".")

def pesos(v: float) -> str:
    return f"−$ {fmt(-v)}" if v < 0 else f"$ {fmt(v)}"

# ──────────────────────────────────────────────
# Resumen de un mes (mismo criterio que la web)
# ──────────────────────────────────────────────
def build_resumen(st: dict | None, y: int, m: int) -> str:
    label = mes_label(y, m)
    if not st:
        return f"📭 Todavía no hay datos de {label}."
    c = calc_mes(st)
    L = [f"📊 *Resumen — {label}*", ""]

    L.append(f"💰 *Ingresos: {pesos(c['ing'])}*")
    if nv(st.get("sueldo")):
        L.append(f"  └ Sueldo: {pesos(nv(st['sueldo']))}")
    for e in st["extras"]:
        L.append(f"  └ {md(e.get('name') or 'Extra')}: {pesos(nv(e.get('amt')))}")

    L.append("")
    L.append(f"💳 Tarjetas pagadas: {pesos(c['tc_pag'])}")
    for i, t in enumerate(st["tarjetas"]):
        pag = nv(t.get("pagado")) + sum(nv(p.get("amt")) for p in t["extraPagos"])
        tot = nv(t.get("total"))
        if not pag and not tot:
            continue
        linea = f"  └ {md(tc_name(t, i))}: {pesos(pag)}"
        if tot:
            linea += f" de {pesos(tot)}" + (" ✅" if pag >= tot else "")
        L.append(linea)

    L.append(f"🏠 Servicios: {pesos(c['sv'])}")
    for s in st["servicios"]:
        if nv(s.get("amt")):
            L.append(f"  └ {md(s.get('name') or 'Servicio')}: {pesos(nv(s['amt']))}")

    L.append(f"🛒 Super / Mercado: {pesos(c['sup'])}")

    L.append(f"🏷 Gastos extra: {pesos(c['gx'])}")
    for g in st["gastosExtra"]:
        L.append(f"  └ {md(g.get('name') or 'Gasto')}: {pesos(nv(g.get('amt')))}")

    L += ["",
          f"📉 Pagos realizados: {pesos(c['pagos'])}",
          f"{'✅' if c['disp'] >= 0 else '🔴'} *Disponible: {pesos(c['disp'])}*"]
    pendiente = c["tc_total"] - c["tc_pag"]
    if pendiente > 0:
        L.append(f"⏳ Falta pagar de tarjetas: {pesos(pendiente)}")
    return "\n".join(L)

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
        autogenerate_code_verifier=True,   # PKCE: sin esto la librería no lo usa
    )
    url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    # Persistir el state en disco para sobrevivir reinicios; descartar los vencidos
    now = time.time()
    states = {k: v for k, v in load_states().items()
              if isinstance(v, dict) and now - v.get("ts", 0) < OAUTH_STATE_TTL}
    states[state] = {"chat_id": chat_id, "ts": now, "cv": flow.code_verifier}
    save_states(states)
    return url

def _exchange_code(state: str, code: str, code_verifier: str | None = None):
    """Cambia el código de Google por credenciales (bloqueante: se corre en un hilo)."""
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
        code_verifier=code_verifier,
    )
    os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
    flow.fetch_token(code=code)
    creds = flow.credentials
    info = build("oauth2", "v2", credentials=creds).userinfo().get().execute()
    return creds, info.get("name", "Usuario")

async def complete_oauth(bot, state: str, code: str, expected_chat: int | None = None) -> tuple[bool, str]:
    """Valida el state (vigente, de un chat autorizado y, si se indica, del mismo chat) y guarda la sesión."""
    states = load_states()
    entry = states.pop(state, None) if state else None
    if entry is not None:
        save_states(states)
    chat_id = None
    verifier = entry.get("cv") if isinstance(entry, dict) else None
    if isinstance(entry, dict) and time.time() - entry.get("ts", 0) < OAUTH_STATE_TTL:
        chat_id = entry.get("chat_id")
    if chat_id is not None and (not is_allowed(chat_id) or (expected_chat is not None and int(chat_id) != int(expected_chat))):
        chat_id = None
    if not chat_id or not code:
        return False, "sesión expirada o inválida"
    try:
        creds, name = await _run_in_executor(_exchange_code, state, code, verifier)
    except Exception as e:
        log.warning(f"No se pudo completar la conexión con Google: {e}")
        return False, "Google rechazó el código (puede haber vencido)"
    uid = str(chat_id)
    # Preservar el refresh_token viejo si Google no mandó uno nuevo
    old_refresh_token = users_db.get(uid, {}).get("refresh_token")
    users_db[uid] = {
        "token": creds.token,
        "refresh_token": creds.refresh_token or old_refresh_token,
        "name": name,
        "scope_version": 4,  # drive.file en raíz visible (v4)
    }
    save_users(users_db)
    await bot.send_message(
        chat_id=chat_id,
        text=f"✅ ¡Hola {name}! Tu cuenta de Google quedó conectada.\n\n"
             f"Ya podés usar todos los comandos. Escribí /ayuda para ver qué podés hacer.",
    )
    return True, name

async def oauth_callback(request: web.Request) -> web.Response:
    """Endpoint HTTP que recibe el regreso de Google (http://localhost:PUERTO/oauth/callback)."""
    state = request.rel_url.query.get("state", "")
    code  = request.rel_url.query.get("code", "")
    ok, msg = await complete_oauth(request.app["bot_app"].bot, state, code)
    if not ok:
        return web.Response(
            text=f"<html><body><h2>❌ Error: {msg}. Volvé a Telegram y usá /start de nuevo.</h2></body></html>",
            content_type="text/html", status=400)
    return web.Response(
        text="<html><body><h2>✅ ¡Listo! Podés cerrar esta pestaña y volver a Telegram.</h2></body></html>",
        content_type="text/html")

async def cmd_codigo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Para cuando el navegador no está en la PC del bot: se pega la dirección a la que volvió Google."""
    texto = " ".join(ctx.args or [])
    q = parse_qs(urlparse(texto).query) if "?" in texto else {}
    state, code = (q.get("state") or [""])[0], (q.get("code") or [""])[0]
    try:
        await update.message.delete()   # el mensaje contiene un código de un solo uso: no lo dejamos en el chat
    except Exception:
        pass
    if not state or not code:
        await update.effective_chat.send_message(
            "Pegá la dirección completa de la página a la que te llevó Google, por ejemplo:\n"
            f"/codigo {REDIRECT_URI}?state=...&code=...")
        return
    ok, msg = await complete_oauth(ctx.bot, state, code, expected_chat=update.effective_chat.id)
    if not ok:
        await update.effective_chat.send_message(f"❌ No se pudo conectar: {msg}. Usá /start para generar un link nuevo.")

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
                f"👋 ¡Ya estás conectado, {md(users_db[uid]['name'])}!\n"
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
        f"👉 [Autorizar Google Drive]({url})"
        + ("\n\n_Si abrís el link desde otro dispositivo y al final la página no carga, copiá la dirección "
           "completa de esa página y mandámela así:_ `/codigo dirección`" if MODE == "polling" else ""),
        parse_mode="Markdown",
        link_preview_options=LinkPreviewOptions(is_disabled=True),
    )

def revocar_en_google(user: dict) -> bool:
    """Anula el permiso en la cuenta de Google (deja de figurar en myaccount.google.com/permissions)."""
    import requests
    tok = user.get("refresh_token") or user.get("token")
    if not tok:
        return False
    try:
        r = requests.post("https://oauth2.googleapis.com/revoke", data={"token": tok},
                          headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=15)
        return r.status_code == 200
    except Exception as e:
        log.warning(f"No se pudo revocar el permiso en Google: {type(e).__name__}")
        return False

async def cmd_desconectar(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_chat.id)
    if uid in users_db:
        user = users_db.pop(uid)
        save_users(users_db)
        revocado = await _run_in_executor(revocar_en_google, user)
        await update.message.reply_text(
            "🔓 Cuenta desconectada" + (" y permiso revocado en Google." if revocado else
            ".\n⚠️ No pude revocar el permiso en Google: quitalo a mano en "
            "myaccount.google.com/permissions") +
            "\n\nUsá /start para volver a conectar tu Google Drive."
        )
    else:
        await update.message.reply_text("No tenías ninguna cuenta conectada.")

async def cmd_ayuda(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    texto = (
        "📋 *Comandos disponibles:*\n\n"
        "💰 *Registrar en el mes actual* (se ve en la web):\n"
        "/gasto `MONTO super` — suma al Super/Mercado\n"
        "/gasto `MONTO extra descripción` — gasto extra\n"
        "/gasto `MONTO servicio` — monto del mes de un servicio\n"
        "  _Ej: /gasto 15000 luz_\n"
        "/ingreso `MONTO sueldo` — sueldo del mes\n"
        "/ingreso `MONTO descripción` — ingreso extra\n"
        "/tarjeta `NOMBRE MONTO` — pago de una tarjeta\n"
        "  _Ej: /tarjeta visa 150000_\n\n"
        "📊 *Resúmenes:*\n"
        "/resumen — Mes actual\n"
        "/historial — Elegir un mes\n"
        "/comparar — Mes actual vs anterior\n\n"
        "📂 *Servicios y comprobantes:*\n"
        "/servicios — Crear, ver y eliminar servicios\n"
        "/comprobante — Subir comprobante a un servicio\n"
        "/vercomprobantes — Ver y descargar comprobantes\n\n"
        "💡 Montos: `4500` / `4.500` / `4.500,50`\n"
        "💡 Si tenés la web abierta, volvé a la pestaña y se actualiza sola."
    )
    await update.message.reply_text(texto, parse_mode="Markdown")

MAX_MONTO = 100_000_000_000   # cien mil millones: más que eso es un error de tipeo
MAX_NOMBRE = 80               # largo máximo de descripciones y nombres

def _leer_monto(texto: str):
    """Monto entre 0 y MAX_MONTO, o None."""
    v = parse_monto(texto)
    return v if v is not None and 0 < v <= MAX_MONTO else None

_INVISIBLES = re.compile(r"[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")

def limpiar_nombre(texto: str, largo: int = MAX_NOMBRE) -> str:
    """Saca caracteres de control e invisibles (incluidos los que invierten el texto),
    junta espacios y corta al largo máximo."""
    t = _INVISIBLES.sub("", str(texto))
    return " ".join(t.split())[:largo].strip()

def partir(texto: str, limite: int = 4000) -> list[str]:
    """Divide un mensaje largo en partes de hasta `limite` caracteres, cortando entre líneas
    (Telegram rechaza mensajes de más de 4096 caracteres)."""
    partes, actual = [], ""
    for linea in texto.split("\n"):
        while len(linea) > limite:
            if actual:
                partes.append(actual); actual = ""
            partes.append(linea[:limite]); linea = linea[limite:]
        if len(actual) + len(linea) + 1 > limite:
            partes.append(actual); actual = linea
        else:
            actual = f"{actual}\n{linea}" if actual else linea
    if actual:
        partes.append(actual)
    return partes or [""]

async def responder(message, texto: str, **kw):
    for parte in partir(texto):
        await message.reply_text(parte, **kw)

def _hoy_iso() -> str:
    return now_ar().strftime("%Y-%m-%d")

async def _sin_cuenta(update: Update) -> bool:
    if str(update.effective_chat.id) in users_db:
        return False
    await update.message.reply_text("Primero conectá tu cuenta con /start.")
    return True

async def cmd_gasto(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if await _sin_cuenta(update):
        return
    uid = str(update.effective_chat.id)
    args = ctx.args or []
    if len(args) < 2:
        await update.message.reply_text(
            "Uso: /gasto MONTO CATEGORÍA [descripción]\n"
            "• /gasto 45000 super\n"
            "• /gasto 12000 extra regalo cumpleaños\n"
            "• /gasto 15000 luz   (un servicio de /servicios)"
        )
        return
    monto = _leer_monto(args[0])
    if monto is None:
        await update.message.reply_text("Monto inválido (entre 1 y 100.000.000.000). Ej: /gasto 4.500 super")
        return
    palabras = args[1:]
    cat = palabras[0].lower()
    desc = limpiar_nombre(" ".join(palabras[1:]))
    y, m = mes_actual()

    def cambio(st, perp):
        tipo = CATEGORIAS_FIJAS.get(cat)
        if tipo == "Super/Mercado":
            st["superAmt"] = nv(st.get("superAmt")) + monto
            return True, ("super", None)
        if tipo == "Gasto Extra":
            nombre = desc or "Gasto extra"
            st["gastosExtra"].append({"name": nombre, "amt": monto, "fecha": _hoy_iso()})
            return True, ("extra", nombre)
        # Servicio: el nombre puede tener varias palabras ("obra social")
        texto = " ".join(palabras).lower()
        srv = next((s for s in perp if s["name"].lower() == texto), None)
        if not srv:
            for k in range(len(palabras), 0, -1):
                cand = " ".join(palabras[:k]).lower()
                hits = [s for s in perp if s["name"].lower() == cand] or \
                       [s for s in perp if s["name"].lower().startswith(cand)]
                if len(hits) == 1:
                    srv = hits[0]
                    break
        if not srv:
            return False, ("desconocido", [s["name"] for s in perp])
        antes = poner_servicio(st, srv["id"], srv["name"], monto)
        return True, ("servicio", (srv["name"], antes))

    try:
        creds = creds_from_dict(users_db[uid])
        ok, (tipo, info), st = await modificar_mes_async(creds, y, m, cambio)
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al guardar en Drive. Intentá de nuevo.")
        return

    if not ok:
        nombres = ", ".join(md(n) for n in info) if info else "(todavía no creaste ninguno)"
        await update.message.reply_text(
            f"❓ No reconozco «{md(' '.join(palabras))}».\n\n"
            f"Categorías: `super`, `extra`\n"
            f"Tus servicios: {nombres}\n\n"
            f"Para crear servicios: /servicios",
            parse_mode="Markdown")
        return
    if tipo == "super":
        linea = f"🛒 Super/Mercado: +{pesos(monto)}\n  Total del mes: *{pesos(nv(st['superAmt']))}*"
    elif tipo == "extra":
        linea = f"🏷 {md(info)}: *{pesos(monto)}*"
    else:
        nombre, antes = info
        linea = f"🏠 {md(nombre)}: *{pesos(monto)}*"
        if antes and antes != monto:
            linea += f"\n  (antes: {pesos(antes)})"
    disp = calc_mes(st)["disp"]
    await update.message.reply_text(
        f"✅ Gasto guardado — {mes_label(y, m)}\n{linea}\n\n💵 Disponible: {pesos(disp)}",
        parse_mode="Markdown")

async def cmd_ingreso(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if await _sin_cuenta(update):
        return
    uid = str(update.effective_chat.id)
    args = ctx.args or []
    if not args:
        await update.message.reply_text(
            "Uso: /ingreso MONTO descripción\n"
            "• /ingreso 850000 sueldo\n"
            "• /ingreso 120000 freelance")
        return
    monto = _leer_monto(args[0])
    if monto is None:
        await update.message.reply_text("Monto inválido (entre 1 y 100.000.000.000). Ej: /ingreso 850.000 sueldo")
        return
    desc = limpiar_nombre(" ".join(args[1:])) or "Ingreso"
    es_sueldo = desc.lower() in ("sueldo", "salario")
    y, m = mes_actual()

    def cambio(st, perp):
        if es_sueldo:
            antes = nv(st.get("sueldo"))
            st["sueldo"] = monto
            return True, antes
        st["extras"].append({"name": desc, "amt": monto})
        return True, None

    try:
        creds = creds_from_dict(users_db[uid])
        _, antes, st = await modificar_mes_async(creds, y, m, cambio)
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al guardar en Drive. Intentá de nuevo.")
        return
    linea = f"💰 {'Sueldo' if es_sueldo else md(desc)}: *{pesos(monto)}*"
    if es_sueldo and antes and antes != monto:
        linea += f"\n  (antes: {pesos(antes)})"
    c = calc_mes(st)
    await update.message.reply_text(
        f"✅ Ingreso guardado — {mes_label(y, m)}\n{linea}\n\n"
        f"Ingresos del mes: {pesos(c['ing'])}\n💵 Disponible: {pesos(c['disp'])}",
        parse_mode="Markdown")

async def cmd_tarjeta(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if await _sin_cuenta(update):
        return
    uid = str(update.effective_chat.id)
    args = ctx.args or []
    if len(args) < 2:
        await update.message.reply_text("Uso: /tarjeta NOMBRE MONTO\nEj: /tarjeta visa 150000")
        return
    # El monto va al final (también se acepta al principio: /tarjeta 150000 visa)
    monto = _leer_monto(args[-1]); nombre = limpiar_nombre(" ".join(args[:-1]))
    if monto is None:
        monto = _leer_monto(args[0]); nombre = limpiar_nombre(" ".join(args[1:]))
    if monto is None:
        await update.message.reply_text("Monto inválido (entre 1 y 100.000.000.000). Ej: /tarjeta visa 150.000")
        return
    y, m = mes_actual()

    def cambio(st, perp):
        idx = buscar_tarjeta(st, nombre)
        con_nombre = [tc_name(t, i) for i, t in enumerate(st["tarjetas"]) if (t.get("name") or "").strip()]
        if idx is None:
            if con_nombre:   # no adivinar: un error de tipeo crearía una tarjeta de más
                return False, con_nombre
            vacia = next((i for i, t in enumerate(st["tarjetas"]) if not (t.get("name") or "").strip()), None)
            if vacia is None:
                st["tarjetas"].append(nueva_tarjeta())
                vacia = len(st["tarjetas"]) - 1
            st["tarjetas"][vacia]["name"] = nombre.strip().title()
            idx = vacia
        tipo = pagar_tarjeta(st, idx, monto)
        return True, (idx, tipo)

    try:
        creds = creds_from_dict(users_db[uid])
        ok, info, st = await modificar_mes_async(creds, y, m, cambio)
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al guardar en Drive. Intentá de nuevo.")
        return
    if not ok:
        await update.message.reply_text(
            f"❓ No encontré la tarjeta «{md(nombre)}».\nTus tarjetas este mes: "
            + ", ".join(md(n) for n in info), parse_mode="Markdown")
        return
    idx, tipo = info
    t = st["tarjetas"][idx]
    pag = nv(t["pagado"]) + sum(nv(p["amt"]) for p in t["extraPagos"])
    tot = nv(t.get("total"))
    linea = f"💳 {md(tc_name(t, idx))}: *{pesos(monto)}*"
    if tipo == "adicional":
        linea += f"\n  Se sumó a lo ya pagado → total pagado {pesos(pag)}"
    if tot:
        falta = tot - pag
        linea += f"\n  Resumen: {pesos(tot)} · " + (f"falta {pesos(falta)}" if falta > 0 else "pagada ✅")
    await update.message.reply_text(
        f"✅ Pago de tarjeta guardado — {mes_label(y, m)}\n{linea}\n\n"
        f"💵 Disponible: {pesos(calc_mes(st)['disp'])}",
        parse_mode="Markdown")

async def cmd_resumen(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if await _sin_cuenta(update):
        return
    uid = str(update.effective_chat.id)
    y, m = mes_actual()
    try:
        creds = creds_from_dict(users_db[uid])
        st = await leer_mes_async(creds, y, m)
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer los datos de Drive.")
        return
    await responder(update.message, build_resumen(st, y, m), parse_mode="Markdown")

async def cmd_historial(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Muestra un teclado con los últimos 12 meses para elegir cuál ver."""
    if await _sin_cuenta(update):
        return
    y, m = mes_actual()
    botones, fila = [], []
    for _ in range(12):
        fila.append(InlineKeyboardButton(f"{MESES[m-1][:3]} {str(y)[2:]}", callback_data=f"hist:{y}-{m}"))
        if len(fila) == 4:
            botones.append(fila); fila = []
        y, m = mes_anterior(y, m)
    if fila:
        botones.append(fila)
    await update.message.reply_text("📅 ¿De qué mes querés ver el resumen?",
                                    reply_markup=InlineKeyboardMarkup(botones))

async def callback_historial(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    uid = str(query.from_user.id)
    if uid not in users_db:
        await query.edit_message_text("Primero conectá tu cuenta con /start.")
        return
    mt = re.fullmatch(r"hist:(\d{4})-(\d{1,2})", query.data or "")
    if not mt or not 1 <= int(mt.group(2)) <= 12:
        await query.edit_message_text("Ese botón es de una versión anterior. Usá /historial de nuevo.")
        return
    y, m = int(mt.group(1)), int(mt.group(2))
    try:
        creds = creds_from_dict(users_db[uid])
        st = await leer_mes_async(creds, y, m)
        primera, *resto = partir(build_resumen(st, y, m))
        await query.edit_message_text(primera, parse_mode="Markdown")
        for parte in resto:
            await query.message.reply_text(parte, parse_mode="Markdown")
    except Exception as e:
        log.exception(e)
        await query.edit_message_text("❌ Error al leer los datos de Drive.")

async def cmd_comparar(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if await _sin_cuenta(update):
        return
    uid = str(update.effective_chat.id)
    ya, ma = mes_actual()
    yp, mp = mes_anterior(ya, ma)
    try:
        creds = creds_from_dict(users_db[uid])
        act = await leer_mes_async(creds, ya, ma)
        ant = await leer_mes_async(creds, yp, mp)
    except Exception as e:
        log.exception(e)
        await update.message.reply_text("❌ Error al leer los datos de Drive.")
        return
    if not ant:
        await responder(update.message,
            f"📭 No hay datos de {mes_label(yp, mp)} para comparar. Este es el mes actual:\n\n"
            + build_resumen(act, ya, ma), parse_mode="Markdown")
        return
    a, p = calc_mes(act or mes_vacio([])), calc_mes(ant)

    def fila(icono, titulo, k):
        va, vp = a[k], p[k]
        if abs(va - vp) < 0.005:
            marca = "➡️"
        else:
            marca = "🔺" if va > vp else "🔻"
            if vp:
                marca += f" {abs(va - vp) / abs(vp) * 100:.0f}%"
        return f"{icono} {titulo}: {pesos(vp)} → *{pesos(va)}* {marca}"

    texto = "\n".join([
        f"📊 *{MESES[mp-1]} → {MESES[ma-1]}*", "",
        fila("💰", "Ingresos", "ing"),
        fila("💳", "Tarjetas pagadas", "tc_pag"),
        fila("🏠", "Servicios", "sv"),
        fila("🛒", "Super", "sup"),
        fila("🏷", "Gastos extra", "gx"),
        fila("📉", "Pagos realizados", "pagos"),
        fila("💵", "Disponible", "disp"),
    ])
    await update.message.reply_text(texto, parse_mode="Markdown")

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
            botones.append([InlineKeyboardButton(f"📎 {nombre}", callback_data=f"srv_comp:{sid}")])
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
                lineas.append(f"  • {md(s['name'])}")
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
            f"✅ Servicio eliminado: {md(nombre)}\n"
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
        # Monto del mes actual (del archivo del mes, el mismo que muestra la web)
        y, m = mes_actual()
        st = await leer_mes_async(creds, y, m)
        srv_mes = next((s for s in (st or {}).get("servicios", []) if s.get("id") == sid), None)
        monto_txt = pesos(nv(srv_mes["amt"])) if srv_mes and nv(srv_mes.get("amt")) else "sin cargar"
        await query.edit_message_text(
            f"🏠 {md(srv['name'])}\n\n"
            f"💰 {mes_label(y, m)}: {monto_txt}\n\n"
            f"Para cargarlo: /gasto MONTO {md(srv['name'].lower())}",
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
    nombre = limpiar_nombre(update.message.text, 50)
    if not nombre or len(update.message.text.strip()) > 50:
        await update.message.reply_text("El nombre debe tener entre 1 y 50 caracteres.")
        return
    ctx.user_data.pop("esperando_srv_nombre", None)
    try:
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        # Verificar duplicado
        if any(s["name"].lower() == nombre.lower() for s in servicios):
            await update.message.reply_text(f"Ya existe un servicio llamado {md(nombre)}.", parse_mode="Markdown")
            return
        nuevo = {"id": str(_uuid.uuid4()), "name": nombre}
        servicios.append(nuevo)
        await write_servicios_async(creds, servicios)
        await update.message.reply_text(
            f"✅ Servicio creado: {md(nombre)}\n\n"
            f"Ahora podés cargar su monto con:\n/gasto MONTO {md(nombre.lower())}",
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
    if uid not in users_db:
        await query.edit_message_text("Primero conectá tu cuenta con /start.")
        return
    # data: srv_comp:<id>  (sólo el id: Telegram limita los datos del botón a 64 bytes)
    sid = query.data.split(":")[1]
    try:
        servicios = await read_servicios_async(creds_from_dict(users_db[uid]))
    except Exception as e:
        log.exception(e)
        await query.edit_message_text("❌ Error al leer servicios.")
        return
    nombre = next((s["name"] for s in servicios if s["id"] == sid), None)
    if not nombre:
        await query.edit_message_text("Ese servicio ya no existe. Usá /comprobante de nuevo.")
        return
    ctx.user_data["comp_srv_id"]   = sid
    ctx.user_data["comp_srv_name"] = nombre
    ctx.user_data["esperando_comp"] = True
    n = now_ar()
    ctx.user_data["comp_mes_prefix"] = f"{n.year}-{n.month:02d}"
    await query.edit_message_text(
        f"📎 {md(nombre)} — enviame el archivo (PDF, foto JPG/PNG).\n\n"
        f"Se guardará en Drive → Finanzas/Comprobantes/{md(nombre)}/{ctx.user_data['comp_mes_prefix']}/",
        parse_mode="Markdown"
    )

COMP_TIPOS = {"pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg",
              "png": "image/png", "webp": "image/webp"}

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
        ext = doc.file_name.rsplit(".", 1)[-1].lower() if doc.file_name and "." in doc.file_name else ""
        mime = COMP_TIPOS.get(ext)
        if not mime or (doc.mime_type and doc.mime_type != mime) or (doc.file_size or 0) > 20 * 1024 * 1024:
            await update.message.reply_text(
                "Sólo acepto PDF, JPG, PNG o WEBP de hasta 20 MB. Mandá otro archivo.")
            return
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
            creds, nombre_srv, filename, content, mime, mes_prefix
        )
        await update.message.reply_text(
            f"✅ Comprobante guardado en Drive:\n"
            f"  📁 Finanzas/Comprobantes/{nombre_srv}/{mes_prefix}/\n"
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
                callback_data=f"ver_comp:{s['id']}:{mes_prefix}"
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
    if uid not in users_db:
        await query.edit_message_text("Primero conectá tu cuenta con /start.")
        return
    # data: ver_comp:<id>:<AAAA-MM>
    parts = query.data.split(":")
    if len(parts) != 3 or not re.fullmatch(r"\d{4}-\d{2}", parts[2]):
        await query.edit_message_text("Ese botón es de una versión anterior. Usá /vercomprobantes de nuevo.")
        return
    sid, mes_prefix = parts[1], parts[2]

    try:
        creds = creds_from_dict(users_db[uid])
        servicios = await read_servicios_async(creds)
        nombre = next((s["name"] for s in servicios if s["id"] == sid), None)
        if not nombre:
            await query.edit_message_text("Ese servicio ya no existe.")
            return
        archivos = await list_comprobantes_async(creds, nombre, mes_prefix)

        if not archivos:
            await query.edit_message_text(
                f"📭 No hay comprobantes de {md(nombre)} para {mes_prefix}.",
                parse_mode="Markdown"
            )
            return

        botones = [
            [InlineKeyboardButton(f"⬇️ {a['name']}", callback_data=f"dl_comp:{a['id']}")]
            for a in archivos
        ]
        await query.edit_message_text(
            f"📂 Comprobantes — {md(nombre)} ({mes_prefix})\n\nElegí cuál descargar:",
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
    if uid not in users_db:
        await query.message.reply_text("Primero conectá tu cuenta con /start.")
        return
    file_id = query.data.split(":")[1]

    try:
        creds = creds_from_dict(users_db[uid])
        filename = await file_name_async(creds, file_id)
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
def _notif_load() -> dict:
    try:
        with open(NOTIF_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def _notif_mark(kind: str, ym: str):
    d = _notif_load(); d[kind] = ym
    _write_private_json(NOTIF_FILE, d)

def _destinatarios() -> list[str]:
    return [u for u in users_db if is_allowed(u)]

async def notif_cierre(ctx: ContextTypes.DEFAULT_TYPE):
    """Desde el día 28 a las 20hs: recordatorio de cierre (una vez por mes; si la PC estaba
    apagada a esa hora, se envía cuando vuelve a prender, hasta fin de mes)."""
    n = now_ar(); ym = f"{n.year}-{n.month:02d}"
    if not (n.day > 28 or (n.day == 28 and n.hour >= 20)):
        return
    if _notif_load().get("cierre") == ym or not _destinatarios():
        return
    label = mes_label(*mes_actual())
    for uid in _destinatarios():
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
    _notif_mark("cierre", ym)

async def notif_nuevo_mes(ctx: ContextTypes.DEFAULT_TYPE):
    """Desde el día 1 a las 9hs: resumen del mes cerrado + aviso de nuevo mes (una vez por mes;
    si la PC estaba apagada, se envía al prender, hasta el día 5)."""
    n = now_ar(); ym = f"{n.year}-{n.month:02d}"
    if not (1 < n.day <= 5 or (n.day == 1 and n.hour >= 9)):
        return
    if _notif_load().get("nuevo_mes") == ym or not _destinatarios():
        return
    # El mes anterior es el que cerró
    y, m = mes_actual()
    ya, ma = mes_anterior(y, m)
    nuevo_label = mes_label(y, m)

    for uid in _destinatarios():
        try:
            creds = creds_from_dict(users_db[uid])
            st = await leer_mes_async(creds, ya, ma)
            resumen = build_resumen(st, ya, ma)
            texto = (f"📅 *¡Comenzó {nuevo_label}!*\n\n"
                     f"Aquí el resumen del mes que cerró:\n\n"
                     f"{resumen}\n\n"
                     f"🆕 Ya podés empezar a cargar los datos de {nuevo_label}.")
            for parte in partir(texto):
                await ctx.bot.send_message(chat_id=int(uid), text=parte, parse_mode="Markdown")
        except Exception as e:
            log.warning(f"No se pudo notificar a {uid}: {e}")
    _notif_mark("nuevo_mes", ym)

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
# Filtro de usuarios
# ──────────────────────────────────────────────
async def auth_gate(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Corta cualquier update de un chat que no esté en ALLOWED_CHAT_IDS."""
    chat = update.effective_chat
    if chat is not None and is_allowed(chat.id):
        return
    log.warning("Update rechazado de chat no autorizado: %s", chat.id if chat else None)
    if update.message and chat is not None:
        await update.message.reply_text(
            f"🔒 Este bot es privado.\nTu ID de chat es: {chat.id}"
        )
    raise ApplicationHandlerStop

# ──────────────────────────────────────────────
# Servidor web: webhook de Telegram + OAuth callback
# ──────────────────────────────────────────────
def make_web_app(application, webhook: bool | None = None) -> web.Application:
    if webhook is None:
        webhook = MODE == "webhook"
    async def telegram_webhook(request: web.Request) -> web.Response:
        """Recibe updates de Telegram. Rechaza todo pedido sin el secreto que sólo Telegram conoce."""
        got = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not hmac.compare_digest(got, WEBHOOK_SECRET):
            log.warning("Webhook rechazado: secreto inválido desde %s", request.remote)
            return web.Response(status=403, text="forbidden")
        try:
            data = await request.json()
        except Exception:
            return web.Response(status=400, text="bad request")
        update = Update.de_json(data, application.bot)
        await application.process_update(update)
        return web.Response(text="ok")

    web_app = web.Application(client_max_size=1024 * 1024)
    web_app["bot_app"] = application
    if webhook:
        web_app.router.add_post(WEBHOOK_PATH, telegram_webhook)
    web_app.router.add_get("/oauth/callback", oauth_callback)
    web_app.router.add_get("/health", lambda r: web.Response(text="ok"))
    return web_app

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
def main():
    builder = Application.builder().token(BOT_TOKEN).post_init(post_init)
    if MODE == "webhook":
        builder = builder.updater(None)   # los mensajes llegan por el webhook (aiohttp)
    application = builder.build()

    # Filtro global (grupo -1, corre antes que todo): sólo chats autorizados
    application.add_handler(TypeHandler(Update, auth_gate), group=-1)

    # Handlers
    application.add_handler(CommandHandler("start",           cmd_start))
    application.add_handler(CommandHandler("codigo",          cmd_codigo))
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

    # Notificaciones: se revisa cada 30 minutos si corresponde enviar (día 28 desde las 20hs y día 1
    # desde las 9hs, hora Argentina). Cada una se envía una sola vez por mes; si la PC estuvo apagada,
    # sale al volver a prender.
    jq = application.job_queue
    jq.run_repeating(notif_cierre,    interval=1800, first=30)
    jq.run_repeating(notif_nuevo_mes, interval=1800, first=45)

    web_app = make_web_app(application)

    async def run():
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):   # systemctl stop / Ctrl+C
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                pass

        await application.initialize()
        await application.start()
        if MODE == "webhook":
            webhook_endpoint = f"{WEBHOOK_URL}{WEBHOOK_PATH}"
            await application.bot.set_webhook(url=webhook_endpoint, secret_token=WEBHOOK_SECRET,
                                              drop_pending_updates=True)
            log.info(f"Modo webhook: {webhook_endpoint}")
        else:
            # Borra cualquier webhook viejo y procesa los mensajes que Telegram guardó mientras estaba apagado
            await application.updater.start_polling(drop_pending_updates=False,
                                                    allowed_updates=Update.ALL_TYPES)
            log.info("Modo polling: recibiendo mensajes de Telegram")
        if not ALLOWED_CHAT_IDS:
            log.warning("ALLOWED_CHAT_IDS está vacío: el bot no atiende a nadie hasta configurarlo.")

        # access_log=None: el log de accesos guardaría la URL completa del regreso de Google
        # (con el código de autorización) en journalctl
        runner = web.AppRunner(web_app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, BIND_HOST, PORT).start()
        log.info(f"Esperando el regreso de Google en {REDIRECT_URI} (escuchando en {BIND_HOST}:{PORT})")

        try:
            await stop.wait()
        finally:
            log.info("Deteniendo el bot…")
            if MODE == "webhook":
                await application.bot.delete_webhook()
            elif application.updater and application.updater.running:
                await application.updater.stop()
            await runner.cleanup()
            await application.stop()
            await application.shutdown()

    asyncio.run(run())

if __name__ == "__main__":
    main()
