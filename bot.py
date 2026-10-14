"""
Bot de Telegram — Mis Finanzas
Stack: python-telegram-bot 20.x, Google Drive API (OAuth por usuario)
"""

import os, json, re, io, logging, asyncio
from datetime import datetime, date
from zoneinfo import ZoneInfo

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

DRIVE_FOLDER = "MisFinanzas"
DATA_FILE    = "finanzas_data.json"

MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
         "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]

CATEGORIAS = {
    "super": "Super/Mercado",
    "mercado": "Super/Mercado",
    "luz": "Luz",
    "gas": "Gas",
    "expensas": "Expensas",
    "alquiler": "Alquiler",
    "internet": "Internet",
    "celular": "Celular",
    "obra": "Obra Social",
    "social": "Obra Social",
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
    return Credentials(
        token=d.get("token"),
        refresh_token=d.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=SCOPES,
    )

def get_drive(creds: Credentials):
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def ensure_folder(drive, name=DRIVE_FOLDER) -> str:
    q = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    res = drive.files().list(q=q, fields="files(id)").execute()
    if res["files"]:
        return res["files"][0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    folder = drive.files().create(body=meta, fields="id").execute()
    return folder["id"]

def read_drive_data(creds: Credentials) -> dict:
    drive = get_drive(creds)
    folder_id = ensure_folder(drive)
    q = f"name='{DATA_FILE}' and '{folder_id}' in parents and trashed=false"
    res = drive.files().list(q=q, fields="files(id)").execute()
    if not res["files"]:
        return {}
    fid = res["files"][0]["id"]
    buf = io.BytesIO()
    request = drive.files().get_media(fileId=fid)
    dl = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = dl.next_chunk()
    buf.seek(0)
    return json.loads(buf.read().decode())

def write_drive_data(creds: Credentials, data: dict):
    drive = get_drive(creds)
    folder_id = ensure_folder(drive)
    q = f"name='{DATA_FILE}' and '{folder_id}' in parents and trashed=false"
    res = drive.files().list(q=q, fields="files(id)").execute()
    content = json.dumps(data, ensure_ascii=False).encode()
    buf = io.BytesIO(content)
    media = MediaIoBaseUpload(buf, mimetype="application/json")
    if res["files"]:
        drive.files().update(fileId=res["files"][0]["id"], media_body=media).execute()
    else:
        meta = {"name": DATA_FILE, "parents": [folder_id]}
        drive.files().create(body=meta, media_body=media, fields="id").execute()

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
def build_resumen(data: dict, key: str) -> str:
    mes = data.get(key, {})
    if not mes:
        return f"📭 No hay datos para {key_label(key)}."

    label = key_label(key)
    ingresos = mes.get("ingresos", {})
    sueldo = ingresos.get("sueldo", 0) or 0
    extras_ing = ingresos.get("extras", []) or []
    total_ing = sueldo + sum(e.get("monto", 0) for e in extras_ing)

    servicios = mes.get("servicios", {})
    nombres_srv = ["luz","gas","expensas","alquiler","internet","celular","obraSocial"]
    total_srv = sum(servicios.get(s, 0) or 0 for s in nombres_srv)

    tarjetas = mes.get("tarjetas", []) or []
    total_tar_ars = sum(t.get("pagado", 0) or 0 for t in tarjetas)
    total_tar_usd = sum(t.get("totalUsd", 0) or 0 for t in tarjetas)

    otros = mes.get("otrosGastos", {})
    super_val = otros.get("super", 0) or 0
    extras_gas = otros.get("extras", []) or []
    total_otros = super_val + sum(e.get("monto", 0) for e in extras_gas)

    total_gas = total_srv + total_tar_ars + total_otros
    disponible = total_ing - total_gas

    lineas = [
        f"📊 *Resumen — {label}*\n",
        f"💰 Ingresos:    $ {fmt(total_ing)}",
        f"  └ Sueldo:   $ {fmt(sueldo)}",
    ]
    for e in extras_ing:
        lineas.append(f"  └ {e.get('desc','Extra')}: $ {fmt(e.get('monto',0))}")

    lineas += [
        f"\n🏠 Servicios:   $ {fmt(total_srv)}",
        f"💳 Tarjetas:    $ {fmt(total_tar_ars)}",
    ]
    if total_tar_usd:
        lineas.append(f"   (USD {fmt(total_tar_usd)} incluidos)")
    lineas += [
        f"🛒 Otros:       $ {fmt(total_otros)}",
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
    flow.fetch_token(code=code)
    creds = flow.credentials

    # Obtener nombre del usuario
    svc = build("oauth2", "v2", credentials=creds)
    info = svc.userinfo().get().execute()
    name = info.get("name", "Usuario")

    uid = str(chat_id)
    users_db[uid] = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "name": name,
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
        await update.message.reply_text(
            f"👋 ¡Ya estás conectado, {users_db[uid]['name']}!\n"
            "Usá /ayuda para ver los comandos disponibles."
        )
        return
    url = make_oauth_url(update.effective_chat.id)
    await update.message.reply_text(
        "¡Hola! Para empezar, conectá tu cuenta de Google Drive "
        "donde se guardarán tus datos de finanzas.\n\n"
        f"👉 [Autorizar Google Drive]({url})",
        parse_mode="Markdown",
        disable_web_page_preview=True,
    )

async def cmd_ayuda(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    texto = (
        "📋 *Comandos disponibles:*\n\n"
        "/gasto `MONTO CATEGORÍA descripción`\n"
        "  _Ej: /gasto 4500 super verdulería_\n\n"
        "/ingreso `MONTO descripción`\n"
        "  _Ej: /ingreso 200000 freelance_\n\n"
        "/tarjeta `NOMBRE MONTO`\n"
        "  _Ej: /tarjeta visa 150000_\n\n"
        "/resumen — Resumen del mes actual\n"
        "/historial — Ver resumen de otro mes\n"
        "/comparar — Balance vs mes anterior\n\n"
        "📂 *Categorías para /gasto:*\n"
        "`super` `luz` `gas` `expensas` `alquiler`\n"
        "`internet` `celular` `obra` `extra`\n\n"
        "💡 Los montos aceptan coma o número entero.\n"
        "  _Ej: 4500 / 4,500 / 4.500_"
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
            "Ej: /gasto 4500 super mercado chino"
        )
        return

    monto = parse_monto(args[0])
    if monto is None:
        msg = "No pude leer el monto."
        if "." in args[0]:
            msg += "\n💡 Si usaste punto como separador de miles (ej: 4.500), también funciona. Si era decimal, usá coma (ej: 4,50)."
        await update.message.reply_text(msg)
        return

    cat_raw = args[1].lower()
    categoria = CATEGORIAS.get(cat_raw)
    if not categoria:
        await update.message.reply_text(
            f"Categoría '{cat_raw}' no reconocida.\n"
            "Usá: super, luz, gas, expensas, alquiler, internet, celular, obra, extra"
        )
        return

    desc = " ".join(args[2:]) if len(args) > 2 else categoria

    try:
        creds = creds_from_dict(users_db[uid])
        data = read_drive_data(creds)
        key = current_key()
        mes = data.setdefault(key, {})

        if categoria == "Super/Mercado":
            mes.setdefault("otrosGastos", {})
            mes["otrosGastos"]["super"] = mes["otrosGastos"].get("super", 0) + monto
        elif categoria == "Gasto Extra":
            mes.setdefault("otrosGastos", {})
            extras = mes["otrosGastos"].setdefault("extras", [])
            extras.append({"desc": desc, "monto": monto})
        elif categoria in ["Luz","Gas","Expensas","Alquiler","Internet","Celular","Obra Social"]:
            key_srv = {
                "Luz": "luz", "Gas": "gas", "Expensas": "expensas",
                "Alquiler": "alquiler", "Internet": "internet",
                "Celular": "celular", "Obra Social": "obraSocial"
            }[categoria]
            mes.setdefault("servicios", {})[key_srv] = monto

        write_drive_data(creds, data)
        await update.message.reply_text(
            f"✅ Gasto guardado:\n"
            f"  📌 {categoria}: *$ {fmt(monto)}*\n"
            f"  📝 {desc}\n"
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
        data = read_drive_data(creds)
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

        write_drive_data(creds, data)
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
        data = read_drive_data(creds)
        key = current_key()
        mes = data.setdefault(key, {})
        tarjetas = mes.setdefault("tarjetas", [])

        # Buscar si ya existe esa tarjeta
        tar = next((t for t in tarjetas if t.get("nombre","").upper() == nombre), None)
        if tar:
            tar["pagado"] = monto
        else:
            tarjetas.append({"nombre": nombre, "pagado": monto})

        write_drive_data(creds, data)
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
        data = read_drive_data(creds)
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
        data = read_drive_data(creds)
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
        data = read_drive_data(creds)
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

        def totales(key):
            mes = data.get(key, {})
            ingresos = mes.get("ingresos", {})
            sueldo = ingresos.get("sueldo", 0) or 0
            extras_ing = ingresos.get("extras", []) or []
            ti = sueldo + sum(e.get("monto", 0) for e in extras_ing)

            servicios = mes.get("servicios", {})
            ts = sum(servicios.get(s, 0) or 0 for s in
                     ["luz","gas","expensas","alquiler","internet","celular","obraSocial"])

            tarjetas = mes.get("tarjetas", []) or []
            tt = sum(t.get("pagado", 0) or 0 for t in tarjetas)

            otros = mes.get("otrosGastos", {})
            to_ = (otros.get("super", 0) or 0) + sum(e.get("monto",0) for e in otros.get("extras",[]) or [])
            tg = ts + tt + to_
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
            data = read_drive_data(creds)
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
        BotCommand("start",    "Conectar con Google Drive"),
        BotCommand("gasto",    "Registrar un gasto"),
        BotCommand("ingreso",  "Registrar un ingreso"),
        BotCommand("tarjeta",  "Registrar pago de tarjeta"),
        BotCommand("resumen",  "Ver resumen del mes actual"),
        BotCommand("historial","Ver resumen de otro mes"),
        BotCommand("comparar", "Comparar con mes anterior"),
        BotCommand("ayuda",    "Ver todos los comandos"),
    ])

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
def main():
    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .build()
    )

    # Handlers
    application.add_handler(CommandHandler("start",    cmd_start))
    application.add_handler(CommandHandler("ayuda",    cmd_ayuda))
    application.add_handler(CommandHandler("gasto",    cmd_gasto))
    application.add_handler(CommandHandler("ingreso",  cmd_ingreso))
    application.add_handler(CommandHandler("tarjeta",  cmd_tarjeta))
    application.add_handler(CommandHandler("resumen",  cmd_resumen))
    application.add_handler(CommandHandler("historial",cmd_historial))
    application.add_handler(CommandHandler("comparar", cmd_comparar))
    application.add_handler(CallbackQueryHandler(callback_historial, pattern=r"^hist:"))

    # Job queue — notificaciones automáticas (hora Argentina = UTC-3)
    jq = application.job_queue
    # Día 28 a las 20:00 ART = 23:00 UTC
    jq.run_daily(notif_cierre,   time=__import__("datetime").time(23, 0), days=(0,1,2,3,4,5,6))
    # Solo ejecutar el día 28:
    # (la función verifica el día internamente — ver nota abajo)
    # Día 1 a las 09:00 ART = 12:00 UTC
    jq.run_daily(notif_nuevo_mes, time=__import__("datetime").time(12, 0), days=(0,1,2,3,4,5,6))

    # Servidor web para OAuth callback
    web_app = web.Application()
    web_app["bot_app"] = application
    web_app.router.add_get("/oauth/callback", oauth_callback)
    web_app.router.add_get("/health", lambda r: web.Response(text="ok"))

    async def run():
        await application.initialize()
        await application.start()
        runner = web.AppRunner(web_app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", PORT)
        await site.start()
        log.info(f"Bot corriendo en el puerto {PORT}")
        # Mantener corriendo
        await application.updater.start_polling(drop_pending_updates=True)
        try:
            await asyncio.Event().wait()
        finally:
            await application.updater.stop()
            await application.stop()
            await application.shutdown()

    asyncio.run(run())

if __name__ == "__main__":
    main()
