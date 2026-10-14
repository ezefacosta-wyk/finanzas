# Bot Mis Finanzas — Telegram

Bot personal de finanzas con Google Drive como backend.

## Deploy en Railway

### 1. Subir a GitHub
Creá un repo nuevo en GitHub y subí estos archivos.

### 2. Crear proyecto en Railway
1. Entrá a [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Seleccioná el repo que acabás de crear

### 3. Configurar variables de entorno en Railway
En el panel de Railway → tu proyecto → Variables, agregá:

| Variable | Valor |
|---|---|
| `BOT_TOKEN` | Tu token de BotFather |
| `GOOGLE_CLIENT_ID` | `40977181531-47pauk08197779rjmrccasm8omdpl5kk.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | El secret de tu OAuth client en Google Cloud |
| `REDIRECT_URI` | `https://TU-APP.railway.app/oauth/callback` (lo sabés una vez que Railway te da la URL) |
| `PORT` | `8080` |

### 4. Agregar Redirect URI en Google Cloud
1. Google Cloud Console → tu proyecto → APIs & Servicios → Credenciales
2. Clic en tu OAuth 2.0 Client ID
3. Authorized redirect URIs → Agregar: `https://TU-APP.railway.app/oauth/callback`

### 5. Obtener GOOGLE_CLIENT_SECRET
1. Google Cloud Console → APIs & Servicios → Credenciales
2. Clic en tu OAuth 2.0 Client ID
3. Copiar el campo "Client secret"

## Comandos

| Comando | Descripción |
|---|---|
| `/start` | Conectar con Google Drive (OAuth) |
| `/gasto MONTO CATEGORÍA desc` | Registrar gasto |
| `/ingreso MONTO descripción` | Registrar ingreso |
| `/tarjeta NOMBRE MONTO` | Registrar pago de tarjeta |
| `/resumen` | Resumen del mes actual |
| `/historial` | Selector de mes con botones |
| `/comparar` | Balance vs mes anterior |
| `/ayuda` | Lista de comandos |

## Categorías para /gasto
`super` `mercado` `luz` `gas` `expensas` `alquiler` `internet` `celular` `obra` `extra`

## Notificaciones automáticas
- **Día 28, 20hs (ART):** Recordatorio de cierre de mes
- **Día 1, 9hs (ART):** Resumen del mes cerrado + aviso de nuevo mes

## Datos
Los datos se guardan en Google Drive de cada usuario, en la carpeta `MisFinanzas/finanzas_data.json`.
El formato es el mismo que usa la web, por lo que todo queda sincronizado.
