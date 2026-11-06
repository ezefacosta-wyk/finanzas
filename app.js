// Mis Finanzas — lógica de la página (index.html). Se carga como archivo aparte para que la
// Content-Security-Policy pueda prohibir cualquier script escrito dentro del HTML.
const CLIENT_ID='40977181531-47pauk08197779rjmrccasm8omdpl5kk.apps.googleusercontent.com';
const SCOPES='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile openid';
const DRIVE_FILE='finanzas_data.json';
const SERVICIOS_FILE='servicios.json';
const ROOT_FOLDER='Finanzas';
const DATA_FOLDER='Datos';   // Finanzas/Datos/: los .json de la app (meses, servicios)
pdfjsLib.GlobalWorkerOptions.workerSrc='lib/pdf.worker.min.js';

/* ── LÍMITES DE COLUMNAS (coordenadas X del PDF de Galicia) ──
   FECHA:       x < 73
   INDICADOR:   73 ≤ x < 86   (K, F, *)
   REFERENCIA:  86 ≤ x < 310  (descripción + datos embebidos)
   CUOTA:      310 ≤ x < 355  (NN/NN)
   COMPROBANTE:355 ≤ x < 425  (número de 6 dígitos)
   PESOS:      425 ≤ x < 530
   DÓLARES:    530 ≤ x < 620
*/
const X = { IND:73, REF:86, CUOTA:310, COMP:355, PESOS:425, DOL:530, DOL_END:620 };

/* Líneas a filtrar — son ajustes/impuestos, no consumos reales */
const SKIP = /^(SU PAGO|TARJETA\s+\d+\s+Total|DETALLE DEL CONSUMO|FECHA|CONSOLIDADO|TOTAL A PAGAR|PAGO M[IÍ]NIMO|INTERESES FINANCIACION|DB IVA|DB\.IVA|DB\.RG|IIBB PERCEP|IVA RG)/i;

const MESES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const TDEF=['',''];
let now=new Date(), curYear=now.getFullYear(), curMonth=now.getMonth();
let accessToken=null, driveFileId=null, serviciosFileId=null, rootFolderId=null, pushTimer=null;
// servicios perpetuos: [{id, name}]
let serviciosPerpetuas=[];

function mkey(y,m){return 'fin4_'+(y===undefined?curYear:y)+'_'+(m===undefined?curMonth:m);}
function defState(){return {sueldo:'',extras:[],tarjetas:TDEF.map(n=>({name:n,total:'',minimo:'',usdTotal:'',usdMinimo:'',tcambio:'',pagado:'',extraPagos:[],detalle:[]})),servicios:serviciosPerpetuas.map(s=>({id:s.id,name:s.name,amt:0})),superAmt:'',gastosExtra:[]};}
function getState(y,m){try{const r=localStorage.getItem(mkey(y,m));if(r){const s=JSON.parse(r);s.tarjetas.forEach(t=>{if(t.name==='Nueva tarjeta'||/^Tarjeta \d+$/.test(t.name||''))t.name='';if(!t.extraPagos)t.extraPagos=[];if(!t.detalle)t.detalle=[];});// merge perpetual services: add new ones, keep amounts for existing
const curIds=new Set((s.servicios||[]).map(sv=>sv.id));serviciosPerpetuas.forEach(ps=>{if(!curIds.has(ps.id))s.servicios.push({id:ps.id,name:ps.name,amt:0});});s.servicios=s.servicios.filter(sv=>serviciosPerpetuas.find(ps=>ps.id===sv.id));return s;}}catch(e){}return (y===undefined&&m===undefined)?defState():null;}
let state=getState();
function fmt(n){n=Math.round(n||0);return (n<0?'−':'')+'$'+Math.abs(n).toLocaleString('es-AR');}
// Disponible = sueldo + extras − pagos realizados (tarjetas pagadas + servicios + super + gastos extra). Sin reserva.
// Es el mismo criterio en el resumen mobile y en el dashboard desktop.
function calcMes(s,superOverride){const st=s||state;const ing=totalIngresos(st);
  const tcPag=calcTarjetasPagadas(st),tcTotal=st.tarjetas.reduce((a,t)=>a+nv(t.total),0);
  const sv=(st.servicios||[]).reduce((a,x)=>a+nv(x.amt),0);
  const sup=superOverride!=null?superOverride:nv(st.superAmt);
  const gx=(st.gastosExtra||[]).reduce((a,g)=>a+nv(g.amt),0);
  const pagos=tcPag+sv+sup+gx;return {ing,tcPag,tcTotal,sv,sup,gx,pagos,disp:ing-pagos};}
function fmtUSD(n){return 'U$S '+parseFloat(n||0).toFixed(2);}
function nv(v){return parseFloat(v)||0;}
// Muestra un monto guardado con separador de miles para un campo editable (vacío si es 0)
function fmtInput(v){const n=parseFloat(v)||0;return n?n.toLocaleString('es-AR',{maximumFractionDigits:2}):'';}
// Campos .money: al enfocarlos muestran el número sin puntos para editar; al salir, con separador de miles
document.addEventListener('focusin',e=>{const el=e.target;if(el.classList&&el.classList.contains('money')){const n=parseMoney(el.value);el.value=n?String(n).replace('.',','):'';try{el.select();}catch(_){}}});
document.addEventListener('focusout',e=>{const el=e.target;if(el.classList&&el.classList.contains('money'))el.value=fmtInput(parseMoney(el.value));});
// Monto en pesos escrito por el usuario: '2.433.431' o '2433431' o '1.500,50'
function parseMoney(v){const t=String(v??'').replace(/[^\d,-]/g,'').replace(',','.');return parseFloat(t)||0;}
function parseMonto(s){return parseFloat(String(s||'').replace(/\./g,'').replace(',','.'))||0;}
function getInitials(n){if(!n)return '?';const p=n.trim().split(/\s+/);return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.slice(0,2).toUpperCase();}
function avatarColor(n){const c=['#2c5f9e','#1a7a4a','#8a5f10','#6b3fa0','#c0392b','#16798a'];let h=0;for(let i=0;i<(n||'').length;i++)h=(h*31+n.charCodeAt(i))%c.length;return c[Math.abs(h)];}

// Token de Google: en sessionStorage (sobrevive a recargar la página, se borra al cerrar la pestaña).
// Antes estaba en localStorage, que queda guardado indefinidamente: se limpia si quedó de antes.
function tokenLeer(){try{localStorage.removeItem('fin_gtoken');return sessionStorage.getItem('fin_gtoken');}catch(e){return null;}}
function tokenGuardar(t){try{sessionStorage.setItem('fin_gtoken',t);}catch(e){}}
function tokenBorrar(){try{sessionStorage.removeItem('fin_gtoken');localStorage.removeItem('fin_gtoken');}catch(e){}}
function signIn(){const cl=google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID,scope:SCOPES,callback:async(r)=>{if(r.error){setSyncInfo('Error al conectar','err');return;}accessToken=r.access_token;tokenGuardar(accessToken);await fetchUserInfo();await loadFromDrive();showApp();}});cl.requestAccessToken();}
async function signOut(){
  // 1) Si hay un cambio esperando subirse a Drive, subirlo antes de salir
  let enDrive=true;
  if(pushTimer&&accessToken){clearTimeout(pushTimer);pushTimer=null;await saveMonthToDrive();enDrive=!document.getElementById('syncInfo').className.includes('err');}
  try{if(accessToken&&window.google)google.accounts.oauth2.revoke(accessToken);}catch(e){}
  document.body.classList.remove('con-sesion');
  accessToken=null;driveFileId=null;serviciosFileId=null;rootFolderId=null;dataFolderId=null;dataMigrated=false;serviciosPerpetuas=[];
  try{if(typeof monthFileIds==='object')Object.keys(monthFileIds).forEach(k=>delete monthFileIds[k]);}catch(e){}
  // 2) Borrar de este navegador el token y los datos financieros (quedan en tu Drive).
  //    Si el último cambio no se pudo subir, los datos se conservan para no perderlos.
  tokenBorrar();
  Object.keys(localStorage).filter(k=>k==='fin_gtoken'||k.startsWith('fin_gdrive_')||(enDrive&&k.startsWith('fin4_'))).forEach(k=>localStorage.removeItem(k));
  state=defState();
  document.getElementById('desktopDashboard').classList.remove('visible');
  document.querySelector('.header').style.display='flex';
  document.getElementById('driveBar').style.display='none';document.getElementById('appContent').style.display='none';document.getElementById('loginScreen').style.display='block';document.body.classList.remove('con-sesion');
  if(!enDrive)alert('No se pudo subir tu último cambio a Drive. Lo dejé guardado en este navegador: se va a sincronizar la próxima vez que entres.');
}
async function fetchUserInfo(){try{const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:'Bearer '+accessToken}});if(!r.ok)return;const u=await r.json();const name=u.name||u.email||'Usuario';document.getElementById('driveName').textContent=name;const av=document.getElementById('driveAvatar');av.textContent=getInitials(name);av.style.background=avatarColor(name);syncDrawerUser();}catch(e){}}
function isDesktop(){return window.innerWidth>=1024;}
function showApp(){
  document.body.classList.add('con-sesion');
  document.getElementById('loginScreen').style.display='none';
  if(isDesktop()){
    document.getElementById('driveBar').style.display='none';
    document.getElementById('appContent').style.display='none';
    document.getElementById('desktopDashboard').classList.add('visible');
    // Ocultar el header mobile (menú + selector de mes) en desktop
    document.querySelector('.header').style.display='none';
    renderDashboard();
  } else {
    document.getElementById('driveBar').style.display='flex';
    document.getElementById('appContent').style.display='block';
    document.getElementById('desktopDashboard').classList.remove('visible');
    document.querySelector('.header').style.display='flex';
    renderAll();
  }
}
function exitDesktop(section){
  document.getElementById('desktopDashboard').classList.remove('visible');
  document.getElementById('driveBar').style.display='flex';
  document.getElementById('appContent').style.display='block';
  document.querySelector('.header').style.display='flex';
  renderAll();
  if(section&&section!=='resumen')navTo(section);
}
const MESES_DD=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
// Nombres como los escribió el usuario; sólo se capitaliza si están todo en minúscula ("visa" → "Visa")
function ddName(n){n=String(n||'');return n&&n===n.toLowerCase()?n.replace(/(^|\s)\S/g,c=>c.toUpperCase()):n;}
const ddHistFetched=new Set();
function ddMonthData(y,m){if(y===curYear&&m===curMonth)return state;try{const r=localStorage.getItem('fin4_'+y+'_'+m);if(r)return JSON.parse(r);}catch(e){}
  // Si no está en este navegador, traerlo de Drive una sola vez y volver a dibujar
  const k=y+'_'+m;if(accessToken&&!ddHistFetched.has(k)){ddHistFetched.add(k);loadMonthFromDrive(y,m).then(d=>{if(d){try{localStorage.setItem('fin4_'+y+'_'+m,JSON.stringify(d));}catch(e){}renderDashboard();renderSides();}}).catch(()=>{});}
  return null;}
// Mes de otro período: primero lo guardado en este navegador; si no está, se trae de Drive (una vez)
// y queda guardado. Así la comparación y el historial funcionan también en un teléfono nuevo.
const mesPedidos=new Map(),mesSinDatos=new Set();
function cargarMes(y,m){
  if(y===curYear&&m===curMonth)return Promise.resolve(state);
  const s=getState(y,m);if(s)return Promise.resolve(s);
  const k=y+'_'+m;if(!accessToken||mesSinDatos.has(k))return Promise.resolve(null);
  if(!mesPedidos.has(k))mesPedidos.set(k,loadMonthFromDrive(y,m).then(d=>{
      if(d&&Array.isArray(d.tarjetas)){try{localStorage.setItem(mkey(y,m),JSON.stringify(d));}catch(e){}return getState(y,m)||d;}
      mesSinDatos.add(k);return null;})
    .catch(()=>{mesSinDatos.add(k);return null;})
    .finally(()=>mesPedidos.delete(k)));
  return mesPedidos.get(k);
}
function ddPct(v,base){return base>0?Math.round(v/base*100):0;}
function renderDashboard(){
  if(!document.getElementById('desktopDashboard').classList.contains('visible'))return;
  const M=calcMes(state);
  const {ing,tcPag,tcTotal,sv,sup,gx,pagos,disp}=M;const otros=sup+gx,svg=sv+otros;
  const $=id=>document.getElementById(id);
  $('dd-month-label').textContent=MESES_DD[curMonth]+' '+curYear;
  $('dd-dist-month').textContent=MESES_DD[curMonth].toLowerCase();
  const srcAv=$('driveAvatar');if(srcAv){$('dd-avatar').textContent=srcAv.textContent;$('dd-avatar').title=$('driveName')?.textContent||'';}

  // ── KPI principal: Disponible / Déficit ──
  const hero=$('dd-kpi-disp'),pd=ddPct(disp,ing);
  const estado=ing<=0&&pagos<=0?'empty':disp<0?'neg':pd<20?'warn':'ok';
  hero.className='dd-kpi dd-kpi-hero '+estado;
  $('dd-l-disp').textContent=disp<0?'Déficit':'Disponible';
  $('dd-v-disp').textContent=fmt(disp);
  $('dd-chip-disp').innerHTML=ing>0?(pd<0?'−':'')+Math.abs(pd)+'%<span class="dd-chip-x"> del ingreso</span>':'';
  $('dd-chip-disp').style.display=ing>0?'':'none';
  $('dd-s-disp').textContent=estado==='empty'?'Cargá tus ingresos y pagos para calcularlo'
    :disp<0?'Pagaste '+fmt(-disp)+' más de lo que ingresó'
    :ing<=0?'Sin ingresos cargados':'Sueldo + extras − pagos realizados';

  // ── Otros KPI ──
  $('dd-v-ing').textContent=fmt(ing);
  $('dd-s-ing').textContent=ing<=0?'Sin ingresos cargados':'Sueldo'+((state.extras||[]).length?' + extras':'');
  $('dd-v-tc').textContent=fmt(tcPag);
  $('dd-chip-tc').innerHTML=ing>0?ddPct(tcPag,ing)+'%<span class="dd-chip-x"> del ingreso</span>':'';$('dd-chip-tc').style.display=ing>0?'':'none';
  const tcResta=Math.max(0,tcTotal-tcPag);
  $('dd-s-tc').textContent=tcTotal<=0?'Sin resúmenes cargados':tcResta>0?'de '+fmt(tcTotal)+' · resta '+fmt(tcResta):'Resúmenes saldados';
  $('dd-v-sv').textContent=fmt(svg);
  $('dd-chip-sv').innerHTML=ing>0?ddPct(svg,ing)+'%<span class="dd-chip-x"> del ingreso</span>':'';$('dd-chip-sv').style.display=ing>0?'':'none';
  const nSv=state.servicios.filter(s=>nv(s.amt)>0).length;
  $('dd-s-sv').textContent=(nSv?nSv+' servicio'+(nSv!==1?'s':''):'Sin servicios')+(otros>0?' + otros '+fmt(otros):'');

  // ── Sincronización (sin tilde duplicada) ──
  const syncSrc=$('syncInfo'),pill=$('dd-sync-pill'),pillTxt=$('dd-sync-text');
  if(syncSrc){const t=syncSrc.textContent.replace(/✓/g,'').trim();const err=/Error|exp/.test(t);pillTxt.textContent=t||'Sincronizado';pill.style.borderColor=err?'rgba(248,113,113,.3)':'rgba(52,211,153,.25)';pill.style.color=err?'#f87171':'#34d399';}

  // ── Tarjetas ──
  $('dd-tc-total-lbl').textContent=tcTotal>0?'Pagado '+fmt(tcPag)+' de '+fmt(tcTotal):'';
  $('dd-tarjetas-list').innerHTML=!state.tarjetas.length?'<div class="dd-empty">No hay tarjetas cargadas</div>':state.tarjetas.map((t,i)=>{
    const total=nv(t.total),pagado=nv(t.pagado)+((t.extraPagos||[]).reduce((a,p)=>a+nv(p.amt),0));
    const badge=total<=0?'':pagado>=total?'<span class="dd-badge" style="background:rgba(52,211,153,.12);color:#34d399"><i class="ti ti-check"></i> Saldada</span>'
      :pagado<=0?'<span class="dd-badge" style="background:rgba(248,113,113,.12);color:#f87171"><i class="ti ti-alert-triangle"></i> Sin pagar</span>'
      :'<span class="dd-badge" style="background:rgba(251,191,36,.10);color:#fbbf24"><i class="ti ti-circle-half-2"></i> Parcial</span>';
    const meta=total<=0?'Sin resumen cargado':'Pagado '+fmt(pagado)+(nv(t.minimo)>0?' · mín. '+fmt(nv(t.minimo)):'');
    return `<div class="dd-card-row">${cardMiniIcon(t.name)}<div class="dd-card-info"><div class="dd-card-name">${esc(ddName(tcName(t,i)))}</div><div class="dd-card-meta">${esc(meta)}</div></div><div class="dd-card-right"><div class="dd-card-total">${total>0?fmt(total):'—'}</div>${badge}</div></div>`;
  }).join('');

  // ── Servicios y gastos ──
  $('dd-svc-total-lbl').textContent=svg>0?fmt(svg):'';
  const svColors=['#6c8fff','#fbbf24','#34d399','#f87171','#5dcaa5','#a78bfa'];
  const rows=state.servicios.map((x,i)=>({name:ddName(x.name),amt:nv(x.amt),color:svColors[i%svColors.length],tag:''}));
  if(sup>0)rows.push({name:'Super / Mercado',amt:sup,color:'#5dcaa5',tag:''});
  (state.gastosExtra||[]).forEach(g=>rows.push({name:ddName(g.name),amt:nv(g.amt),color:'#8892aa',tag:'gasto extra'}));
  $('dd-svc-list').innerHTML=!rows.length?'<div class="dd-empty">No hay servicios ni gastos cargados</div>':rows.map(r=>`<div class="dd-svc-row"><div class="dd-svc-bar" style="background:${r.color}"></div><div class="dd-svc-info"><span class="dd-svc-name">${esc(r.name)}</span>${r.tag?`<span class="dd-svc-tag">${r.tag}</span>`:''}</div><div class="dd-svc-amt">${r.amt>0?fmt(r.amt):'<span style="font-size:11px;color:#fbbf24">sin monto</span>'}</div></div>`).join('');

  // ── Disponible por mes (6 meses, con negativos) ──
  const ML=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const months=[];for(let i=5;i>=0;i--){let m=curMonth-i,y=curYear;while(m<0){m+=12;y--;}const d=ddMonthData(y,m);
    const c=d?calcMes(d):null;
    const has=!!c&&(c.ing>0||c.pagos>0);months.push({m,y,lbl:ML[m],cur:y===curYear&&m===curMonth,has,v:has?c.disp:0});}
  const ct=$('dd-chart-title');ct.textContent=fmt(disp);ct.style.color=disp<0?'#f87171':'#6c8fff';
  const conDatos=months.filter(x=>x.has),prev=months[4],chip=$('dd-chart-chip');
  const avg=conDatos.length?conDatos.reduce((a,x)=>a+x.v,0)/conDatos.length:0;
  $('dd-chart-sub').textContent=conDatos.length>1?'Promedio de '+conDatos.length+' meses: '+fmt(avg):MESES_DD[curMonth];
  if(prev.has&&months[5].has){const dif=disp-prev.v;chip.style.display='';chip.textContent=(dif>=0?'↑ ':'↓ ')+fmt(Math.abs(dif))+' vs '+prev.lbl;
    chip.style.background=dif>=0?'rgba(52,211,153,.12)':'rgba(248,113,113,.12)';chip.style.color=dif>=0?'#34d399':'#f87171';}
  else chip.style.display='none';
  const chart=$('dd-chart');
  if(conDatos.length<2){chart.className='';chart.innerHTML='<div class="dd-chart-empty">El historial aparece a medida que cargás meses.<br>Hace falta al menos un mes anterior con datos para comparar.</div>';}
  else{chart.className='dd-chart';
    const maxP=Math.max(0,...conDatos.map(x=>x.v)),maxN=Math.max(0,...conDatos.map(x=>-x.v)),span=(maxP+maxN)||1;
    const zero=maxP/span*100; // % desde arriba donde está el cero
    chart.innerHTML=months.map(x=>{let bar;
      if(!x.has)bar=`<div class="dd-col-bar nodata" style="top:calc(${zero}% - 3px)" title="${x.lbl}: sin datos"></div>`;
      else{const h=Math.max(Math.abs(x.v)/span*100,1.5);const col=x.v<0?(x.cur?'#f87171':'rgba(248,113,113,.4)'):(x.cur?'#6c8fff':'rgba(108,143,255,.32)');
        bar=x.v>=0?`<div class="dd-col-bar" style="bottom:${100-zero}%;height:${h}%;background:${col}" title="${x.lbl}: ${fmt(x.v)}"></div>`
                  :`<div class="dd-col-bar" style="top:${zero}%;height:${h}%;background:${col}" title="${x.lbl}: ${fmt(x.v)}"></div>`;}
      return `<div class="dd-col"><div class="dd-col-plot"><div class="dd-col-zero" style="top:${zero}%"></div>${bar}</div><div class="dd-bar-lbl ${x.cur?'cur':''}">${x.lbl}</div></div>`;}).join('');}

  // ── Distribución: siempre suma 100% ──
  const base=Math.max(ing,pagos);
  $('dd-dist-base').textContent=base<=0?'':pagos>ing?'Sobre el total pagado: los pagos superan los ingresos':'Sobre tus ingresos ('+fmt(ing)+')';
  const items=[{lbl:'Tarjetas pagadas',v:tcPag,color:'#a78bfa'},{lbl:'Servicios',v:sv,color:'#fbbf24'}];
  if(otros>0)items.push({lbl:'Super y gastos extra',v:otros,color:'#5dcaa5'});
  if(disp>=0)items.push({lbl:'Disponible',v:disp,color:'#6c8fff'});
  // Porcentajes por mayor resto: siempre suman exactamente 100
  const raw=items.map(d=>base>0?d.v/base*100:0),fl=raw.map(Math.floor);let falta=100-fl.reduce((x,y)=>x+y,0);
  raw.map((r,i)=>[r-fl[i],i]).sort((x,y)=>y[0]-x[0]).forEach(([,i])=>{if(falta>0&&base>0){fl[i]++;falta--;}});
  let html=base<=0?'<div class="dd-empty">Sin datos este mes</div>':items.map((d,i)=>`<div class="dd-dist-row"><div class="dd-dist-dot" style="background:${d.color}"></div><div class="dd-dist-name">${d.lbl}</div><div class="dd-dist-amt">${fmt(d.v)}</div><div class="dd-dist-pct">${fl[i]}%</div><div class="dd-dist-track"><div class="dd-dist-fill" style="width:${raw[i]}%;background:${d.color}"></div></div></div>`).join('');
  if(disp<0&&base>0){const cub=Math.round(ing/pagos*100);
    html+=`<div class="dd-cover"><div class="dd-cover-lbl"><span>Cubierto con ingresos <b>${cub}%</b></span><span style="color:#f87171">Sin cubrir <b>${fmt(-disp)}</b> · ${100-cub}%</span></div><div class="dd-cover-bar"><div style="width:${ing/pagos*100}%;background:#34d399"></div><div style="flex:1;background:#f87171"></div></div></div>`;}
  $('dd-dist-rows').innerHTML=html;
}
function totalIngresosFrom(s){if(!s)return 0;const base=nv(s.sueldo);const extras=(s.extras||[]).reduce((a,e)=>a+nv(e.amt),0);return base+extras;}
async function driveReq(url,opts={}){const r=await fetch(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+accessToken}});if(r.status===401){setSyncInfo('Sesión expirada','err');return null;}return r;}

/* ── Drive folder/file helpers ── */
// Texto seguro dentro de una consulta de Drive ('...'): escapa \ y '
function dq(v){return String(v??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
async function driveList(q,fields){const r=await driveReq('https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&q='+encodeURIComponent(q)+'&fields='+encodeURIComponent('files('+fields+')'));if(!r||!r.ok)return [];const d=await r.json();return d.files||[];}
// ── Comprobantes del mes: sólo lee Drive, nunca crea carpetas ──
// Busca igual que «Ver»: Comprobantes/<servicio>/<AAAA-MM>/ (web), más los archivos del bot
// en Comprobantes/<servicio>/ cuyo nombre empieza con AAAA-MM. Compara nombres sin distinguir
// mayúsculas, acentos ni espacios de más, y tolera carpetas duplicadas.
const compCache={};
const FOLDER="application/vnd.google-apps.folder";
const normName=v=>String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().replace(/\s+/g,' ').toLowerCase();
async function driveListAll(q,fields){let out=[],tok='';for(let i=0;i<10;i++){const r=await driveReq('https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&q='+encodeURIComponent(q)+'&fields='+encodeURIComponent('nextPageToken,files('+fields+')')+(tok?'&pageToken='+encodeURIComponent(tok):''));if(!r||!r.ok)throw new Error('drive');const d=await r.json();out=out.concat(d.files||[]);if(!d.nextPageToken)break;tok=d.nextPageToken;}return out;}
const inParents=ids=>'('+ids.map(id=>"'"+dq(id)+"' in parents").join(' or ')+')';
async function loadCompCounts(force){if(!accessToken)return;const mes=curYear+'-'+String(curMonth+1).padStart(2,'0');const c=compCache[mes];
  if(c&&(c.loading||(!force&&Date.now()-c.t<60000)))return;compCache[mes]={loading:true,map:c&&c.map,t:c?c.t:0};
  try{const root=await getRootFolder();if(!root){delete compCache[mes];return;}
    const map={};
    const comps=await driveListAll("mimeType='"+FOLDER+"' and name='Comprobantes' and '"+dq(root)+"' in parents and trashed=false",'id');
    if(comps.length){const srv=await driveListAll("mimeType='"+FOLDER+"' and "+inParents(comps.map(f=>f.id))+" and trashed=false",'id,name');
      if(srv.length){const srvName={};srv.forEach(f=>srvName[f.id]=normName(f.name));
        const meses=await driveListAll("mimeType='"+FOLDER+"' and name='"+dq(mes)+"' and "+inParents(srv.map(f=>f.id))+" and trashed=false",'id,parents');
        const mesSrv={};meses.forEach(f=>mesSrv[f.id]=srvName[(f.parents||[])[0]]);
        const files=await driveListAll("mimeType!='"+FOLDER+"' and "+inParents(srv.map(f=>f.id).concat(meses.map(f=>f.id)))+" and trashed=false",'id,name,parents');
        files.forEach(f=>{const par=(f.parents||[])[0];let n=null;
          if(mesSrv[par])n=mesSrv[par];                                   // subido desde la web
          else if(srvName[par]&&String(f.name||'').startsWith(mes))n=srvName[par]; // subido por el bot
          if(n)map[n]=(map[n]||0)+1;});}}
    compCache[mes]={map,t:Date.now()};renderSides();updateCompButtons();
  }catch(e){compCache[mes]={map:(c&&c.map)||null,t:0,err:true};renderSides();}}
// Actualiza sólo los botones «Ver» (no redibuja la lista, para no interrumpir si estás escribiendo un monto)
function updateCompButtons(){state.servicios.forEach((x,i)=>{const row=document.getElementById('srv-row-'+(x.id||('srv_'+i)));if(!row)return;const btn=row.querySelectorAll('.srv-actions .btn-sm')[1];if(!btn)return;const n=compCount(x.name);
  btn.classList.toggle('has-comp',n>0);btn.title=n==null?'Ver comprobantes':n+' comprobante(s) este mes';btn.innerHTML='<i class="ti ti-files"></i> Ver'+(n>0?' <span class="comp-n">'+n+'</span>':'');});}
function compCount(name){const mes=curYear+'-'+String(curMonth+1).padStart(2,'0'),c=compCache[mes];return c&&c.map?(c.map[normName(name)]||0):null;}
async function findFolder(name,parentId){let q='mimeType=\'application/vnd.google-apps.folder\' and name=\''+dq(name)+'\' and trashed=false';if(parentId)q+=' and \''+parentId+'\' in parents';else q+=' and \'root\' in parents';const r=await driveReq('https://www.googleapis.com/drive/v3/files?spaces=drive&q='+encodeURIComponent(q)+'&fields=files(id,name)');if(!r)return null;const d=await r.json();return(d.files&&d.files.length)?d.files[0].id:null;}
async function ensureFolder(name,parentId){let fid=await findFolder(name,parentId);if(fid)return fid;const meta={name,mimeType:'application/vnd.google-apps.folder'};if(parentId)meta.parents=[parentId];else meta.parents=['root'];const r=await driveReq('https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(meta)});if(!r)return null;const d=await r.json();return d.id||null;}
// ── Carpeta de datos: Finanzas/Datos/ ──
let dataFolderId=null,dataMigrated=false;
// Si varias búsquedas piden la carpeta a la vez, comparten una sola búsqueda/creación (evita carpetas duplicadas)
let dataFolderP=null,rootFolderP=null;
async function getDataFolder(){if(dataFolderId)return dataFolderId;const c=localStorage.getItem('fin_gdrive_data_id');if(c){dataFolderId=c;return c;}
  if(!dataFolderP)dataFolderP=(async()=>{const root=await getRootFolder();if(!root)return null;const id=await ensureFolder(DATA_FOLDER,root);if(id){dataFolderId=id;localStorage.setItem('fin_gdrive_data_id',id);}return id;})().finally(()=>{dataFolderP=null;});
  return dataFolderP;}
const isDataFile=n=>/^finanzas_\d{4}_\d{2}\.json$/.test(n)||n===SERVICIOS_FILE||n===DRIVE_FILE;
async function moveFile(id,toId,fromId,newName){const u='https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?addParents='+encodeURIComponent(toId)+'&removeParents='+encodeURIComponent(fromId)+'&fields=id';
  const r=await driveReq(u,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(newName?{name:newName}:{})});return !!(r&&r.ok);}
async function renameFile(id,name){const r=await driveReq('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?fields=id',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});return !!(r&&r.ok);}
// Mueve a Finanzas/Datos/ los .json que hayan quedado sueltos en Finanzas/. No borra nada:
// si el mismo archivo ya está en Datos, se queda el más reciente y el otro se renombra como respaldo.
async function migrateDataFiles(){if(dataMigrated||!accessToken)return;
  try{const root=await getRootFolder(),datos=await getDataFolder();if(!root||!datos)return;
    const sueltos=(await driveListAll("'"+dq(root)+"' in parents and mimeType!='"+FOLDER+"' and trashed=false",'id,name,modifiedTime')).filter(f=>isDataFile(f.name));
    if(sueltos.length){const enDatos={};(await driveListAll("'"+dq(datos)+"' in parents and mimeType!='"+FOLDER+"' and trashed=false",'id,name,modifiedTime')).forEach(f=>{if(!enDatos[f.name]||f.modifiedTime>enDatos[f.name].modifiedTime)enDatos[f.name]=f;});
      const hoy=new Date().toISOString().slice(0,10);
      for(const f of sueltos){const otro=enDatos[f.name];
        if(!otro){await moveFile(f.id,datos,root);continue;}
        const resp=f.name.replace(/\.json$/,'')+' (respaldo '+hoy+').json';
        if(f.modifiedTime>otro.modifiedTime){await renameFile(otro.id,resp);await moveFile(f.id,datos,root);}
        else await moveFile(f.id,datos,root,resp);}
      // los ids guardados pueden apuntar a un respaldo: se vuelven a buscar
      driveFileId=null;serviciosFileId=null;localStorage.removeItem('fin_gdrive_fileid');localStorage.removeItem('fin_gdrive_srv_id');Object.keys(monthFileIds).forEach(k=>delete monthFileIds[k]);}
    dataMigrated=true;
  }catch(e){/* se reintenta en la próxima carga; findDataFile igual mueve archivo por archivo */}}
// Busca un .json en Datos; si todavía está en la raíz, lo mueve a Datos (mismo id) y lo devuelve
async function findDataFile(name){const datos=await getDataFolder();if(!datos)return null;let id=await findFileInFolder(name,datos);if(id)return id;
  const root=await getRootFolder();const vieja=root?await findFileInFolder(name,root):null;if(vieja&&await moveFile(vieja,datos,root))return vieja;return vieja||null;}
async function getRootFolder(){if(rootFolderId)return rootFolderId;const cached=localStorage.getItem('fin_gdrive_root_id');if(cached){rootFolderId=cached;return cached;}
  if(!rootFolderP)rootFolderP=(async()=>{const id=await ensureFolder(ROOT_FOLDER,null);if(id){rootFolderId=id;localStorage.setItem('fin_gdrive_root_id',id);}return id;})().finally(()=>{rootFolderP=null;});
  return rootFolderP;}
async function findFileInFolder(name,folderId){const q='name=\''+dq(name)+'\' and \''+folderId+'\' in parents and trashed=false';const r=await driveReq('https://www.googleapis.com/drive/v3/files?spaces=drive&q='+encodeURIComponent(q)+'&fields=files(id,name)');if(!r)return null;const d=await r.json();return(d.files&&d.files.length)?d.files[0].id:null;}
async function readJsonFile(fileId){const r=await driveReq('https://www.googleapis.com/drive/v3/files/'+fileId+'?alt=media');if(!r)return null;try{return await r.json();}catch(e){return null;}}
async function writeJsonFile(name,folderId,data,existingId){const blob=new Blob([JSON.stringify(data)],{type:'application/json'});if(existingId){const r=await driveReq('https://www.googleapis.com/upload/drive/v3/files/'+existingId+'?uploadType=media',{method:'PATCH',headers:{'Content-Type':'application/json'},body:blob});return (r&&r.ok)?existingId:null;}const meta={name,parents:[folderId]};const form=new FormData();form.append('metadata',new Blob([JSON.stringify(meta)],{type:'application/json'}));form.append('file',blob);const r=await driveReq('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',body:form});if(!r||!r.ok)return null;const d=await r.json();return d.id||null;}

async function findDriveFile(){if(driveFileId)return driveFileId;const c=localStorage.getItem('fin_gdrive_fileid');if(c){driveFileId=c;return c;}const fid=await findDataFile(DRIVE_FILE);if(fid){driveFileId=fid;localStorage.setItem('fin_gdrive_fileid',fid);}return driveFileId||null;}
async function findServiciosFile(){if(serviciosFileId)return serviciosFileId;const c=localStorage.getItem('fin_gdrive_srv_id');if(c){serviciosFileId=c;return c;}const fid=await findDataFile(SERVICIOS_FILE);if(fid){serviciosFileId=fid;localStorage.setItem('fin_gdrive_srv_id',fid);}return serviciosFileId||null;}

async function loadServiciosFromDrive(){try{const fid=await findServiciosFile();if(!fid){serviciosPerpetuas=[];return;}const d=await readJsonFile(fid);if(Array.isArray(d))serviciosPerpetuas=d;else serviciosPerpetuas=[];}catch(e){serviciosPerpetuas=[];}}
async function saveServiciosToDrive(){try{const datos=await getDataFolder();if(!datos)return;const fid=await findServiciosFile();const newId=await writeJsonFile(SERVICIOS_FILE,datos,serviciosPerpetuas,fid||null);if(newId&&!serviciosFileId){serviciosFileId=newId;localStorage.setItem('fin_gdrive_srv_id',newId);}}catch(e){setSyncInfo('Error al guardar servicios','err');}}

async function loadFromDrive(){setSyncInfo('<i class="ti ti-loader"></i> Cargando...','spin');try{await migrateDataFiles();await loadServiciosFromDrive();// Cargar mes actual desde archivo mensual
const driveData=await loadMonthFromDrive(curYear,curMonth);if(driveData){try{localStorage.setItem(mkey(),JSON.stringify(driveData));}catch(e){}state=getState();setSyncInfo('Sincronizado ✓','ok');return;}// Fallback: leer archivo global viejo (migración)
const fid=await findDriveFile();if(!fid){setSyncInfo('Sin datos en la nube aún','');return;}const d=await readJsonFile(fid);if(!d){setSyncInfo('Error al leer datos','err');return;}Object.entries(d).forEach(([k,v])=>localStorage.setItem(k,typeof v==='string'?v:JSON.stringify(v)));state=getState();setSyncInfo('Sincronizado ✓','ok');}catch(e){setSyncInfo('Error al cargar','err');}}
async function pushToDrive(){if(!accessToken)return;setSyncInfo('<i class="ti ti-loader"></i> Guardando...','spin');try{const datos=await getDataFolder();if(!datos){setSyncInfo('Error: carpeta Drive','err');return;}const d={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith('fin4_'))d[k]=localStorage.getItem(k);}const fid=await findDriveFile();const newId=await writeJsonFile(DRIVE_FILE,datos,d,fid||null);if(newId&&!driveFileId){driveFileId=newId;localStorage.setItem('fin_gdrive_fileid',newId);}const ts=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});setSyncInfo('Guardado '+ts+' ✓','ok');}catch(e){setSyncInfo('Error al guardar','err');}}
function setSyncInfo(msg,type){const el=document.getElementById('syncInfo');el.innerHTML=msg;el.className='sync-info'+(type?' '+type:'');syncDrawerUser();updateHdrSync(type,el.textContent.trim());}
// Indicador de sincronización en la cabecera (reemplaza la franja con avatar y Salir)
function updateHdrSync(type,txt){const h=document.getElementById('hdrSync');if(!h)return;const ic={spin:'ti-loader-2 spin',ok:'ti-cloud-check',err:'ti-cloud-off'}[type]||'ti-cloud';h.className='hdr-sync'+(type?' '+type:'');const t=txt||'Sin cambios pendientes';h.innerHTML='<i class="ti '+ic+'"></i><span class="hdr-sync-txt">'+esc(t.replace(/✓/g,'').trim()||'Sincronizado')+'</span>';h.title=t;h.setAttribute('aria-label',t);}
function schedulePush(){dirty=true;clearTimeout(pushTimer);pushTimer=setTimeout(()=>{saveMonthToDrive();updateDrawerBadges();},800);}
async function init(){document.getElementById('loginScreen').style.display='block';document.body.classList.remove('con-sesion');const saved=tokenLeer();if(saved){accessToken=saved;try{const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:'Bearer '+accessToken}});if(r.ok){await fetchUserInfo();await loadFromDrive();showApp();return;}}catch(e){}tokenBorrar();accessToken=null;}}

/* ════════════════════════════════════════════════════
   PDF PARSER — GALICIA — BASADO EN POSICIÓN X ESTRICTA
   ════════════════════════════════════════════════════ */
async function parsePDF(file, idx){
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data:ab,isEvalSupported:false}).promise;
  const movimientos = [];
  let totalPagar=0, totalUSD=0, minimoVal=0;

  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();

    // Agrupar por Y (tolerancia 2px)
    const byY = {};
    tc.items.forEach(item=>{
      if(!item.str.trim()) return;
      const y = Math.round(item.transform[5]/2)*2;
      if(!byY[y]) byY[y]=[];
      byY[y].push({ x: item.transform[4], str: item.str.trim() });
    });

    for(const y of Object.keys(byY).sort((a,b)=>b-a)){
      const items = byY[y].sort((a,b)=>a.x-b.x);
      const full = items.map(i=>i.str).join(' ');

      // — Capturar TOTAL A PAGAR —
      if(/TOTAL A PAGAR/i.test(full)){
        const pesos = items.filter(i=>i.x>=X.PESOS && i.x<X.DOL);
        const dols  = items.filter(i=>i.x>=X.DOL  && i.x<X.DOL_END);
        if(pesos.length) totalPagar = parseMonto(pesos[pesos.length-1].str);
        if(dols.length)  totalUSD   = parseMonto(dols[dols.length-1].str);
        continue;
      }

      // — Capturar PAGO MINIMO —
      if(/PAGO M[IÍ]NIMO/i.test(full)){
        const pesos = items.filter(i=>i.x>=X.PESOS && i.x<X.DOL);
        if(pesos.length) minimoVal = parseMonto(pesos[pesos.length-1].str);
        continue;
      }

      // — Saltar líneas que no son consumos —
      if(SKIP.test(full)) continue;

      // — Debe empezar con fecha dd-mm-aa —
      const fechaItem = items.find(i=>i.x<X.IND && /^\d{2}-\d{2}-\d{2,4}$/.test(i.str));
      if(!fechaItem) continue;

      // — Clasificar items por columna —
      const refItems  = items.filter(i=>i.x>=X.REF  && i.x<X.CUOTA);
      const cuotaItems= items.filter(i=>i.x>=X.CUOTA && i.x<X.COMP);
      const compItems = items.filter(i=>i.x>=X.COMP  && i.x<X.PESOS);
      const pesosItems= items.filter(i=>i.x>=X.PESOS && i.x<X.DOL);
      const dolItems  = items.filter(i=>i.x>=X.DOL   && i.x<X.DOL_END);

      // — Monto PESOS: solo de columna PESOS —
      let montoPesos = pesosItems.length ? parseMonto(pesosItems[pesosItems.length-1].str) : 0;

      // — Monto USD: prioridad 1 = columna DÓLARES; prioridad 2 = "USD X,XX" embebido en REFERENCIA —
      let montoUSD = 0;
      if(dolItems.length){
        montoUSD = parseMonto(dolItems[dolItems.length-1].str);
      } else {
        // Buscar patrón USD/USDxxxx seguido de número en REFERENCIA
        const refText = refItems.map(i=>i.str).join(' ');
        const usdEmbed = refText.match(/USD\s*([\d.,]+)/i);
        if(usdEmbed) montoUSD = parseMonto(usdEmbed[1]);
      }

      // Sin ningún monto → saltar
      if(!montoPesos && !montoUSD) continue;

      // — Cuota —
      let cuotas=false, cuotaActual=0, cuotaTotal=0;
      if(cuotaItems.length){
        const cm = cuotaItems.map(i=>i.str).join('').match(/(\d+)\/(\d+)/);
        if(cm){ cuotas=true; cuotaActual=parseInt(cm[1]); cuotaTotal=parseInt(cm[2]); }
      }

      // — Nombre: tokens de REFERENCIA, descartando:
      //   • el indicador K/F/* si cayó en zona REF
      //   • el token "USD" y el número que le sigue
      //   • tokens que son puro número (embebidos de referencia)
      //   • tokens con "USD" pegado (MicrosoftUSD, 4zRklSoirUSD, etc.)
      const nombreTokens = [];
      let skipNext = false;
      for(const item of refItems){
        if(skipNext){ skipNext=false; continue; }
        const s = item.str;
        if(/^[KF\*]$/.test(s)) continue;               // indicador
        if(/^USD$/i.test(s)){ skipNext=true; continue;} // "USD" suelto → saltar + siguiente número
        // Token con USD pegado: quedarse solo con la parte antes de USD
        if(/USD/i.test(s)){
          const clean = s.replace(/USD[\d.,]*/gi,'').trim();
          if(clean) nombreTokens.push(clean);
          continue;
        }
        // Número puro (embebido en referencia, ej: "18,38", "864571110287,43") → saltar
        if(/^-?[\d.,]+$/.test(s)) continue;
        // Texto entre paréntesis numérico como "(TNA 82,01)" → saltar
        if(/^\(/.test(s) && /[\d,]/.test(s)) continue;
        nombreTokens.push(s);
      }

      let nombre = nombreTokens.join(' ').replace(/\s+/g,' ').trim().toUpperCase();
      if(!nombre) continue;

      movimientos.push({ nombre, fecha:fechaItem.str, monto:montoPesos, montoUSD, cuotas, cuotaActual, cuotaTotal });
    }
  }

  if(!movimientos.length){ alert('No se encontraron consumos en el PDF.\nAsegurate de subir el resumen de Galicia completo.'); return; }

  state.tarjetas[idx].detalle = movimientos;
  if(totalPagar>0 && !nv(state.tarjetas[idx].total))   state.tarjetas[idx].total   = Math.round(totalPagar);
  if(totalUSD>0   && !nv(state.tarjetas[idx].usdTotal)) state.tarjetas[idx].usdTotal = totalUSD;
  if(minimoVal>0  && !nv(state.tarjetas[idx].minimo))   state.tarjetas[idx].minimo   = Math.round(minimoVal);
  save(); renderTarjetas(); recalc();
}

/* ════════ APP ════════ */
// Guarda el estado en memoria. NO lee campos de pantalla: en el dashboard de PC esos campos no están cargados
// y leerlos ponía el sueldo y el super en 0 al cambiar de mes.
function save(){try{localStorage.setItem(mkey(),JSON.stringify(state));}catch(e){}schedulePush();}
function prevMonthYM(){let pm=curMonth-1,py=curYear;if(pm<0){pm=11;py--;}return{y:py,m:pm};}
async function changeMonth(d){try{localStorage.setItem(mkey(),JSON.stringify(state));}catch(e){}if(pushTimer){clearTimeout(pushTimer);pushTimer=null;await saveMonthToDrive();}curMonth+=d;if(curMonth>11){curMonth=0;curYear++;}if(curMonth<0){curMonth=11;curYear--;}// Intentar cargar del Drive primero, fallback a localStorage
if(accessToken){setSyncInfo('<i class="ti ti-loader"></i> Cargando mes...','spin');const driveData=await loadMonthFromDrive(curYear,curMonth);if(driveData){try{localStorage.setItem(mkey(),JSON.stringify(driveData));}catch(e){}state=getState();setSyncInfo(MESES[curMonth]+' cargado ✓','ok');}else{state=getState();setSyncInfo('','');}}else{state=getState();}renderAll();}
/* ── DRAWER NAV ── */
const TAB_LABELS={resumen:'Resumen',ingresos:'Ingresos',tarjetas:'Tarjetas',servicios:'Servicios',gastos:'Otros gastos'};
function toggleDrawer(){const d=document.getElementById('navDrawer'),o=document.getElementById('drawerOverlay'),b=document.getElementById('menuBtn');const open=d.classList.toggle('open');o.classList.toggle('open',open);b.classList.toggle('open',open);document.body.style.overflow=open?'hidden':'';}
function closeDrawer(){const d=document.getElementById('navDrawer'),o=document.getElementById('drawerOverlay'),b=document.getElementById('menuBtn');d.classList.remove('open');o.classList.remove('open');b.classList.remove('open');document.body.style.overflow='';}
function navTo(name){
  // En desktop: si estamos en el dashboard, salir a mobile primero
  if(isDesktop()&&document.getElementById('desktopDashboard').classList.contains('visible')){
    // Ya estás en el Resumen (dashboard): sólo cerrar el menú
    if(name==='resumen'){closeDrawer();return;}
    exitDesktop(name);
    closeDrawer();
    return;
  }
  showTab(name);closeDrawer();
}
function showTab(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.dnav-item').forEach(i=>i.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  const di=document.getElementById('dnav-'+name);if(di)di.classList.add('active');
  document.querySelectorAll('.bnav-item').forEach(b=>{const on=b.dataset.arg===name;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const lbl=document.getElementById('currentTabLabel');if(lbl)lbl.textContent=TAB_LABELS[name]||name;const ht=document.getElementById('hdrTitle');if(ht)ht.textContent=TAB_LABELS[name]||name;renderSides();if(name==='servicios'&&accessToken)loadCompCounts(true);
  // En desktop: Resumen vuelve al dashboard
  if(isDesktop()&&name==='resumen'&&!document.getElementById('desktopDashboard').classList.contains('visible'))showApp();
}
function syncDrawerUser(){const n=document.getElementById('driveName'),a=document.getElementById('driveAvatar'),s=document.getElementById('syncInfo');const dn=document.getElementById('drawerName'),da=document.getElementById('drawerAvatar'),ds=document.getElementById('drawerSync');if(n&&dn)dn.textContent=n.textContent||'—';if(a&&da)da.textContent=a.textContent||'?';const ha=document.getElementById('hdrAv');if(a&&ha){ha.textContent=a.textContent||'?';ha.title=(n&&n.textContent)||'';}if(s&&ds)ds.textContent=s.textContent||'';}
function totalIngresos(s){const st=s||state;return nv(st.sueldo)+st.extras.reduce((a,e)=>a+e.amt,0);}
function calcTarjetasPagadas(s){const st=s||state;return st.tarjetas.reduce((a,t)=>a+nv(t.pagado)+t.extraPagos.reduce((s2,p)=>s2+p.amt,0),0);}
function totalPagadoTarjetas(){return calcTarjetasPagadas();}
function getCategorias(s){const sa=(s===state||!s)?(nv(state.superAmt)):nv(s.superAmt);const st=s||state;return [{key:'ingresos',label:'Ingresos totales',icon:'ti-wallet',val:totalIngresos(s),ingreso:true},{key:'servicios',label:'Servicios fijos',icon:'ti-building',val:st.servicios.reduce((a,sv)=>a+sv.amt,0)},{key:'super',label:'Super / Mercado',icon:'ti-shopping-cart',val:sa},{key:'gastos_extra',label:'Gastos extra',icon:'ti-tag',val:st.gastosExtra.reduce((a,g)=>a+g.amt,0)},{key:'tarjetas',label:'Tarjetas pagadas',icon:'ti-credit-card',val:calcTarjetasPagadas(s)}];}
function renderComparacion(){const {y,m}=prevMonthYM();const prev=getState(y,m);const prevLabel=MESES[m]+' '+y,curLabel=MESES[curMonth]+' '+curYear;document.getElementById('comp-month-labels').innerHTML=`<span class="comp-month-label prev">${prevLabel}</span><span class="comp-sep">→</span><span class="comp-month-label current">${curLabel}</span>`;if(!prev){const k=y+'_'+m;
  if(accessToken&&!mesSinDatos.has(k)){document.getElementById('comp-content').innerHTML=`<div class="no-data-prev"><i class="ti ti-loader-2"></i>Buscando ${prevLabel} en Drive…</div>`;
    const cy=curYear,cm=curMonth;cargarMes(y,m).then(()=>{if(cy===curYear&&cm===curMonth)renderComparacion();});return;}
  document.getElementById('comp-content').innerHTML=`<div class="no-data-prev"><i class="ti ti-database-off"></i>No hay datos de ${prevLabel} para comparar</div>`;return;}const catCur=getCategorias(state),catPrev=getCategorias(prev);const maxVal=Math.max(...catCur.map(c=>c.val),...catPrev.map(c=>c.val),1);let tc=0,tp=0;catCur.forEach(c=>{if(!c.ingreso)tc+=c.val;});catPrev.forEach(c=>{if(!c.ingreso)tp+=c.val;});const rows=catCur.map((cur,i)=>{const prv=catPrev[i],diff=cur.val-prv.val,pct=prv.val>0?Math.round((diff/prv.val)*100):0;const eb=cur.ingreso?diff>0:diff<0,em=cur.ingreso?diff<0:diff>0;// color: verde si el cambio es bueno (más ingresos o menos gastos); flecha y signo: si el monto subió o bajó
const dc=diff===0?'same':eb?'down':'up',di=diff===0?'ti-minus':diff>0?'ti-arrow-up':'ti-arrow-down';const ad='$'+Math.abs(Math.round(diff)).toLocaleString('es-AR');const sg=diff>0?'+':'−';const dl=diff===0?'Sin cambio':'<span class="nw amt">'+sg+ad+'</span>'+(pct!==0?'<span class="pct"> (<span class="sg">'+sg+'</span>'+Math.abs(pct)+'%)</span>':'');const bw=Math.round((Math.abs(diff)/maxVal)*100),bc=em?'var(--danger)':eb?'var(--success)':'var(--accent)';return `<tr><td class="cat"><i class="ti ${cur.icon}"></i>${cur.label}</td><td class="num">${fmt(prv.val)}</td><td class="num">${fmt(cur.val)}</td><td class="diff"><span class="diff-pill ${dc}"><i class="ti ${di}"></i>${dl}</span><span class="diff-bar-wrap"><span class="diff-bar-fill" style="width:${bw}%;background:${bc}"></span></span></td></tr>`;});const td=tc-tp,tpct=tp>0?Math.round((td/tp)*100):0,tb=td<0;const tdc=td===0?'same':tb?'down':'up',tdi=td===0?'ti-minus':tb?'ti-arrow-down':'ti-arrow-up';const atd='$'+Math.abs(Math.round(td)).toLocaleString('es-AR');document.getElementById('comp-content').innerHTML=`<table class="comp-table"><thead><tr><th style="text-align:left">Categoría</th><th>${prevLabel}</th><th>${curLabel}</th><th>Diferencia</th></tr></thead><tbody>${rows.join('')}<tr class="comp-total-row"><td class="cat"><i class="ti ti-sigma"></i> Total gastos</td><td class="num">${fmt(tp)}</td><td class="num">${fmt(tc)}</td><td class="diff"><span class="diff-pill ${tdc}"><i class="ti ${tdi}"></i>${td===0?'Sin cambio':'<span class="nw amt">'+(tb?'−':'+')+atd+'</span>'+(tpct!==0?'<span class="pct"> (<span class="sg">'+(tb?'−':'+')+'</span>'+Math.abs(tpct)+'%)</span>':'')}</span></td></tr></tbody></table>`;}
function renderAll(){if(document.getElementById('desktopDashboard').classList.contains('visible')){renderDashboard();return;}document.getElementById('monthLabel').innerHTML='<span class="m-long">'+MESES[curMonth]+'</span><span class="m-short">'+MESES[curMonth].slice(0,3)+'</span> '+curYear;document.getElementById('sueldo').value=fmtInput(state.sueldo);document.getElementById('super-amt').value=fmtInput(state.superAmt);renderExtras();renderTarjetas();renderServicios();renderGastosExtra();recalc();updateOfflineBadge();updateDrawerBadges();}
function renderExtras(){document.getElementById('extra-list').innerHTML=state.extras.map((e,i)=>`<div class="item-row"><span class="item-name">${esc(e.name)}</span><span class="item-amt">${fmt(e.amt)}</span><button class="btn-del" data-click="removeExtra" data-i="${i}" aria-label="Eliminar ingreso" title="Eliminar ingreso"><i class="ti ti-trash"></i></button></div>`).join('');}
function addExtra(){const nm=document.getElementById('extra-name').value.trim(),a=parseMoney(document.getElementById('extra-amt').value);if(!nm||!a)return;state.extras.push({name:nm,amt:a});document.getElementById('extra-name').value='';document.getElementById('extra-amt').value='';save();renderExtras();recalc();}
function removeExtra(i){confirmDelete('¿Eliminar ingreso extra?',()=>{state.extras.splice(i,1);save();renderExtras();recalc();});}
/* ── CARD VISUAL helpers ── */
// Logos de marcas: formas de Simple Icons (simpleicons.org, licencia CC0). Las marcas pertenecen a sus dueños;
// se usan sólo para identificar la red de cada tarjeta.
const SI_LOGOS={"visa":["0 8.124 24 7.751","M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z"],"amex":["0 0 24 24","M16.015 14.378c0-.32-.135-.496-.344-.622-.21-.12-.464-.135-.81-.135h-1.543v2.82h.675v-1.027h.72c.24 0 .39.024.478.125.12.13.104.38.104.55v.35h.66v-.555c-.002-.25-.017-.376-.108-.516-.06-.08-.18-.18-.33-.234l.02-.008c.18-.072.48-.297.48-.747zm-.87.407l-.028-.002c-.09.053-.195.058-.33.058h-.81v-.63h.824c.12 0 .24 0 .33.05.098.048.156.147.15.255 0 .12-.045.215-.134.27zM20.297 15.837H19v.6h1.304c.676 0 1.05-.278 1.05-.884 0-.28-.066-.448-.187-.582-.153-.133-.392-.193-.73-.207l-.376-.015c-.104 0-.18 0-.255-.03-.09-.03-.15-.105-.15-.21 0-.09.017-.166.09-.21.083-.046.177-.066.272-.06h1.23v-.602h-1.35c-.704 0-.958.437-.958.84 0 .9.776.855 1.407.87.104 0 .18.015.225.06.046.03.082.106.082.18 0 .077-.035.15-.08.18-.06.053-.15.07-.277.07zM0 0v10.096L.81 8.22h1.75l.225.464V8.22h2.043l.45 1.02.437-1.013h6.502c.295 0 .56.057.756.236v-.23h1.787v.23c.307-.17.686-.23 1.12-.23h2.606l.24.466v-.466h1.918l.254.465v-.466h1.858v3.948H20.87l-.36-.6v.585h-2.353l-.256-.63h-.583l-.27.614h-1.213c-.48 0-.84-.104-1.08-.24v.24h-2.89v-.884c0-.12-.03-.12-.105-.135h-.105v1.036H6.067v-.48l-.21.48H4.69l-.202-.48v.465H2.235l-.256-.624H1.4l-.256.624H0V24h23.786v-7.108c-.27.135-.613.18-.973.18H21.09v-.255c-.21.165-.57.255-.914.255H14.71v-.9c0-.12-.018-.12-.12-.12h-.075v1.022h-1.8v-1.066c-.298.136-.643.15-.928.136h-.214v.915h-2.18l-.54-.617-.57.6H4.742v-3.93h3.61l.518.602.554-.6h2.412c.28 0 .74.03.942.225v-.24h2.177c.202 0 .644.045.903.225v-.24h3.265v.24c.163-.164.508-.24.803-.24h1.89v.24c.194-.15.464-.24.84-.24h1.176V0H0zM21.156 14.955c.004.005.006.012.01.016.01.01.024.01.032.02l-.042-.035zM23.828 13.082h.065v.555h-.065zM23.865 15.03v-.005c-.03-.025-.046-.048-.075-.07-.15-.153-.39-.215-.764-.225l-.36-.012c-.12 0-.194-.007-.27-.03-.09-.03-.15-.105-.15-.21 0-.09.03-.16.09-.204.076-.045.15-.05.27-.05h1.223v-.588h-1.283c-.69 0-.96.437-.96.84 0 .9.78.855 1.41.87.104 0 .18.015.224.06.046.03.076.106.076.18 0 .07-.034.138-.09.18-.045.056-.136.07-.27.07h-1.288v.605h1.287c.42 0 .734-.118.9-.36h.03c.09-.134.135-.3.135-.523 0-.24-.045-.39-.135-.526zM18.597 14.208v-.583h-2.235V16.458h2.235v-.585h-1.57v-.57h1.533v-.584h-1.532v-.51M13.51 8.787h.685V11.6h-.684zM13.126 9.543l-.007.006c0-.314-.13-.5-.34-.624-.217-.125-.47-.135-.81-.135H10.43v2.82h.674v-1.034h.72c.24 0 .39.03.487.12.122.136.107.378.107.548v.354h.677v-.553c0-.25-.016-.375-.11-.516-.09-.107-.202-.19-.33-.237.172-.07.472-.3.472-.75zm-.855.396h-.015c-.09.054-.195.056-.33.056H11.1v-.623h.825c.12 0 .24.004.33.05.09.04.15.128.15.25s-.047.22-.134.266zM15.92 9.373h.632v-.6h-.644c-.464 0-.804.105-1.02.33-.286.3-.362.69-.362 1.11 0 .512.123.833.36 1.074.232.238.645.31.97.31h.78l.255-.627h1.39l.262.627h1.36v-2.11l1.272 2.11h.95l.002.002V8.786h-.684v1.963l-1.18-1.96h-1.02V11.4L18.11 8.744h-1.004l-.943 2.22h-.3c-.177 0-.362-.03-.468-.134-.125-.15-.186-.36-.186-.662 0-.285.08-.51.194-.63.133-.135.272-.165.516-.165zm1.668-.108l.464 1.118v.002h-.93l.466-1.12zM2.38 10.97l.254.628H4V9.393l.972 2.205h.584l.973-2.202.015 2.202h.69v-2.81H6.118l-.807 1.904-.876-1.905H3.343v2.663L2.205 8.787h-.997L.01 11.597h.72l.26-.626h1.39zm-.688-1.705l.46 1.118-.003.002h-.915l.457-1.12zM11.856 13.62H9.714l-.85.923-.825-.922H5.346v2.82H8l.855-.932.824.93h1.302v-.94h.838c.6 0 1.17-.164 1.17-.945l-.006-.003c0-.78-.598-.93-1.128-.93zM7.67 15.853l-.014-.002H6.02v-.557h1.47v-.574H6.02v-.51H7.7l.733.82-.764.824zm2.642.33l-1.03-1.147 1.03-1.108v2.253zm1.553-1.258h-.885v-.717h.885c.24 0 .42.098.42.344 0 .243-.15.372-.42.372zM9.967 9.373v-.586H7.73V11.6h2.237v-.58H8.4v-.564h1.527V9.88H8.4v-.507"],"diners":["0 1.627 24 20.746","M16.506 11.982a6.026 6.026 0 0 0-3.866-5.618V17.6a6.025 6.025 0 0 0 3.866-5.618zM8.33 17.598V6.365a6.03 6.03 0 0 0-3.863 5.617 6.028 6.028 0 0 0 3.863 5.616zm2.156-15.113A9.497 9.497 0 0 0 .99 11.982a9.495 9.495 0 0 0 9.495 9.494c5.245 0 9.495-4.25 9.496-9.494a9.499 9.499 0 0 0-9.496-9.497Zm-.023 19.888C4.723 22.4 0 17.75 0 12.09 0 5.905 4.723 1.626 10.463 1.627h2.69C18.822 1.627 24 5.903 24 12.09c0 5.658-5.176 10.283-10.848 10.283"],"discover":["0.001 9.977 24 4.046","M14.58 12a2.023 2.023 0 1 1-2.025-2.023h.002c1.118 0 2.023.906 2.023 2.023zm-5.2-2.001c-1.124 0-2.025.884-2.025 1.99 0 1.118.878 1.984 2.007 1.984.319 0 .593-.063.93-.221v-.873c-.296.297-.559.416-.895.416-.747 0-1.277-.542-1.277-1.312 0-.73.547-1.306 1.243-1.306.354 0 .622.126.93.428v-.873a1.898 1.898 0 0 0-.913-.233zm-3.352 1.545c-.445-.165-.576-.273-.576-.479 0-.239.233-.422.553-.422.222 0 .405.091.598.308l.388-.508a1.665 1.665 0 0 0-1.117-.422c-.673 0-1.186.467-1.186 1.089 0 .524.239.792.936 1.043.291.103.438.171.513.217a.456.456 0 0 1 .222.394c0 .308-.245.536-.576.536-.354 0-.639-.177-.809-.507l-.479.461c.342.502.752.724 1.317.724.771 0 1.311-.513 1.311-1.249-.002-.603-.252-.876-1.095-1.185zM24 10.3a.29.29 0 0 1-.288.291.29.29 0 0 1-.291-.291v-.003A.29.29 0 1 1 24 10.3zm-.059.001a.235.235 0 0 0-.231-.239.234.234 0 0 0-.232.239c0 .132.104.239.232.239a.235.235 0 0 0 .231-.239zM3.472 13.887h.742v-3.803h-.742v3.803zm12.702-1.248l-1.014-2.554h-.81l1.614 3.9h.399l1.643-3.9h-.804l-1.028 2.554zm2.166 1.248h2.104v-.644h-1.362v-1.027h1.312v-.644h-1.312v-.844h1.362v-.644H18.34v3.803zm5.409-3.557l.11.138h-.097l-.094-.13v.13h-.08v-.334h.107c.081 0 .126.036.126.103.001.046-.025.08-.072.093zm-.006-.092c0-.029-.021-.043-.06-.043h-.014v.087h.014c.039 0 .06-.014.06-.044zm-1.228 2.047l1.197 1.602H22.8l-1.027-1.528h-.097v1.528h-.741v-3.803h1.1c.855 0 1.346.411 1.346 1.123 0 .583-.308.965-.866 1.078zm.103-1.038c0-.37-.251-.563-.713-.563h-.228v1.152h.217c.473-.001.724-.207.724-.589zm-19.487.742a1.91 1.91 0 0 1-.69 1.46c-.365.303-.781.439-1.357.439H.001v-3.803H1.09c1.202 0 2.041.781 2.041 1.904zm-.764-.006c0-.364-.154-.718-.411-.947-.245-.222-.536-.308-1.015-.308H.742v2.515h.199c.479 0 .782-.092 1.015-.302.256-.228.411-.593.411-.958z"]};
function siSvg(k,h,fill){const[vb,d]=SI_LOGOS[k];const[, ,w,hh]=vb.split(' ').map(Number);return`<svg viewBox="${vb}" height="${h}" width="${Math.round(h*w/hh)}" fill="${fill}" aria-hidden="true"><path d="${d}"/></svg>`;}
function mcSvg(h){return`<svg viewBox="0 0 48 30" height="${h}" width="${Math.round(h*1.6)}" aria-hidden="true"><circle cx="18" cy="15" r="14" fill="#eb001b"/><circle cx="30" cy="15" r="14" fill="#f79e1b"/><path d="M24 4.8a14 14 0 010 20.4A14 14 0 0124 4.8z" fill="#ff5f00"/></svg>`;}
function txtSvg(t,h,size){return`<svg viewBox="0 0 ${Math.round(t.length*size*0.78)} ${Math.round(size*1.25)}" height="${h}" aria-hidden="true"><text x="0" y="${size}" font-family="Arial Black,sans-serif" font-size="${size}" font-weight="900" fill="white">${t}</text></svg>`;}
// Orden: redes antes que bancos ("Visa Galicia" → Visa)
const CARD_BRANDS=[
  {k:'amex',re:/amex|american/,cls:'cp-amex',bg:'#2E77BC',logo:()=>siSvg('amex',46,'#fff'),mini:()=>siSvg('amex',22,'#2E77BC'),miniBg:'#fff',title:'American Express'},
  {k:'visa',re:/visa/,cls:'cp-visa',bg:'#1A1F71',logo:()=>siSvg('visa',20,'#fff'),mini:()=>siSvg('visa',9,'#fff'),title:'Visa'},
  {k:'mc',re:/master|\bmc\b/,cls:'cp-mastercard',bg:'#252525',logo:()=>mcSvg(30),mini:()=>mcSvg(15),title:'Mastercard'},
  {k:'diners',re:/diners/,cls:'cp-diners',bg:'#004C97',logo:()=>siSvg('diners',30,'#fff'),mini:()=>siSvg('diners',15,'#fff'),title:'Diners Club'},
  {k:'discover',re:/discover/,cls:'cp-discover',bg:'#FF6000',logo:()=>siSvg('discover',12,'#fff'),mini:()=>siSvg('discover',6,'#fff'),title:'Discover'},
  {k:'naranja',re:/naranja/,cls:'cp-naranja',bg:'#c45210',logo:()=>txtSvg('naranja',22,16),mini:()=>txtSvg('NX',10,10),title:'Naranja'},
  {k:'cabal',re:/cabal/,cls:'cp-cabal',bg:'#1a5c9e',logo:()=>txtSvg('CABAL',22,16),mini:()=>txtSvg('CABAL',8,10),title:'Cabal'},
  {k:'galicia',re:/galicia/,cls:'cp-galicia',bg:'#b91c1c',logo:()=>txtSvg('Galicia',22,16),mini:()=>txtSvg('GAL',9,10),title:'Galicia'}
];
function cardBrand(name){const n=(name||'').toLowerCase();return CARD_BRANDS.find(b=>b.re.test(n))||null;}
function getCardTheme(name){const b=cardBrand(name);return b?{cls:b.cls,logo:b.logo()}:{cls:'cp-default',logo:''};}
function cardMiniIcon(name){const b=cardBrand(name);return b?`<div class="dd-card-ico" style="background:${b.miniBg||b.bg}" title="${b.title}">${b.mini()}</div>`:`<div class="dd-card-ico" style="background:#262d40" title="Sin marca"><svg width="18" height="13" viewBox="0 0 18 13" fill="none" stroke="#8892aa" stroke-width="1.4" aria-hidden="true"><rect x=".7" y=".7" width="16.6" height="11.6" rx="2"/><path d="M.7 4.3h16.6M3.5 9h3"/></svg></div>`;}
// Escapa texto para insertarlo en HTML: datos del usuario, de Drive o de archivos importados nunca se interpretan como código
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// Nombre visible: si la tarjeta no tiene nombre, "Tarjeta N"
function tcName(t,i){return (t&&t.name)||('Tarjeta '+(i+1));}
function renderCardPlastic(t,i){const{cls,logo}=getCardTheme(t.name);return`<div class="tcard-plastic-wrap"><div class="card-plastic ${cls}">
  <div class="cp-top">
    <div class="cp-chip"><div class="cp-chip-lines"><span></span><span></span><span></span></div></div>
    <div class="cp-logo">${logo}</div>
  </div>
  <div class="cp-fields">
    <div class="cp-fields-grid">
      <div class="cp-field"><label for="t${i}-total">Total a pagar</label><div class="cp-pfx"><span>$</span><input class="money" type="text" inputmode="decimal" autocomplete="off" id="t${i}-total" value="${fmtInput(t.total)}" placeholder="0" data-change="commitMoney" data-i="${i}" data-f="total"></div></div>
      <div class="cp-field"><label for="t${i}-minimo">Pago mínimo</label><div class="cp-pfx"><span>$</span><input class="money" type="text" inputmode="decimal" autocomplete="off" id="t${i}-minimo" value="${fmtInput(t.minimo)}" placeholder="0" data-change="commitMoney" data-i="${i}" data-f="minimo"></div></div>
    </div>
    <div class="cp-realizado-box">
      <label class="cp-realizado-lbl" for="t${i}-pagado"><i class="ti ti-check" style="font-size:11px"></i> Pago realizado</label>
      <div class="cp-pagado-pfx"><span>$</span><input class="money" type="text" inputmode="decimal" autocomplete="off" id="t${i}-pagado" value="${fmtInput(t.pagado)}" placeholder="0" data-change="commitMoney" data-i="${i}" data-f="pagado"></div>
    </div>
  </div>
  <div class="cp-bottom">
    <label class="cp-name-edit" title="Nombre de la tarjeta (ej: Visa Galicia, Amex)"><input class="cp-name-input" value="${esc(t.name)}" placeholder="Nombre de la tarjeta" aria-label="Nombre de la tarjeta" data-change="renameTarjeta" data-i="${i}"><i class="ti ti-pencil"></i></label>
  </div>
</div></div>`;}
function updateCardBadgeInPlastic(i){const t=state.tarjetas[i];const totalPagado=nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0);const resto=Math.max(0,nv(t.total)-totalPagado);const cls=nv(t.total)===0?'':resto===0?'ok':resto<nv(t.total)*0.5?'warn':'neg';const txt=nv(t.total)===0?'Sin cargar':resto===0?'Saldada':fmt(resto)+' pendiente';const badge=document.getElementById('cpbadge-'+i);if(badge){badge.className='cp-badge '+(cls||'');badge.textContent=txt;}}

// Secciones plegables de cada tarjeta: se recuerda cuáles abriste mientras usás la página
const tcOpen=new Set();
function tcToggle(el){const k=el.dataset.sec+el.dataset.i;el.open?tcOpen.add(k):tcOpen.delete(k);}
function tcPagos(t){const extras=(t.extraPagos||[]).reduce((s,p)=>s+nv(p.amt),0);return {total:nv(t.total),pago:nv(t.pagado),extras,pagado:nv(t.pagado)+extras};}
function restaHTML(t){const {total,pago,extras,pagado}=tcPagos(t);const resto=Math.max(0,total-pagado);
  if(total<=0)return '<div class="tc-resta-main muted">Cargá el total del resumen</div><div class="tc-resta-sub">En «Total a pagar», dentro de la tarjeta</div>';
  const det='Pagado '+fmt(pagado)+' de '+fmt(total)+(extras>0?' (pago '+fmt(pago)+' + adicionales '+fmt(extras)+')':'');
  if(resto<=0)return '<div class="tc-resta-main ok"><i class="ti ti-check"></i> Saldada</div><div class="tc-resta-sub">'+det+'</div>';
  return '<div class="tc-resta-lbl">Resta pagar</div><div class="tc-resta-main warn">'+fmt(resto)+'</div><div class="tc-resta-sub">'+det+'</div>';}
function updateResta(i){const t=state.tarjetas[i],el=document.getElementById('tc-resta-'+i);if(el)el.innerHTML=restaHTML(t);const pb=document.querySelector('#tc-'+i+' .pago-box');if(pb)pb.style.display=tcPagos(t).pagado>=nv(t.total)?'none':'';}
function renderTarjetas(){const ingresos=totalIngresos(),superAmt=nv(state.superAmt);const servicios=state.servicios.reduce((a,s)=>a+s.amt,0),gastosExtra=state.gastosExtra.reduce((a,g)=>a+g.amt,0);const otrosGastos=servicios+superAmt+gastosExtra,reserva=ingresos*0.10;const disponibleBase=Math.max(0,ingresos-otrosGastos-reserva);
document.getElementById('tarjetas-container').innerHTML=state.tarjetas.map((t,i)=>{const {sugerido,puedeTotal,parcial}=pagoSugerido(t,disponibleBase,ingresos-otrosGastos-reserva);
const usdSum=nv(t.usdTotal)>0?fmtUSD(nv(t.usdTotal))+(nv(t.tcambio)>0?' · '+fmt(nv(t.usdTotal)*nv(t.tcambio)):''):'Sin saldo';
const detSum=t.detalle&&t.detalle.length?t.detalle.length+' movimientos':'Subir PDF o Excel';
const op=k=>tcOpen.has(k+i)?' open':'';
return `<div class="tcard-unit" draggable="true">${renderCardPlastic(t,i)}<div class="tcard tcard-with-plastic" id="tc-${i}">
<div class="tc-toolbar"><span class="drag-handle" title="Arrastrar para reordenar"><i class="ti ti-grip-horizontal"></i></span><div class="tc-tools"><button class="btn btn-sm" data-click="showHistorialTarjeta" data-i="${i}"><i class="ti ti-history"></i> Historial</button><button class="btn-del" data-click="removeTarjeta" data-i="${i}" aria-label="Eliminar tarjeta" title="Eliminar tarjeta"><i class="ti ti-trash"></i></button></div></div>
<div class="tc-resta" id="tc-resta-${i}">${restaHTML(t)}</div>
${nv(t.total)>0?`<div class="pago-box"${tcPagos(t).pagado>=nv(t.total)?' style="display:none"':''}><div class="pago-box-lbl"><i class="ti ti-calculator"></i> Pago sugerido</div><div class="pago-row"><span class="pago-amt">${fmt(sugerido)}</span>${nv(t.usdTotal)>0?`<span class="pago-usd">+ ${fmtUSD(nv(t.usdMinimo)||nv(t.usdTotal))}</span>`:''}</div><div class="pago-desc">${puedeTotal?(parcial?'Podés pagar lo que falta':'Podés pagar el total completo'):'Máximo posible dejando un 10% del sueldo como colchón'}</div></div>`:''}
<div class="extra-pago-section"><div class="epago-title"><i class="ti ti-plus-circle"></i> Pagos adicionales <span class="epago-hint">se suman al pago realizado</span></div><div id="epagos-${i}">${t.extraPagos.map((p,j)=>`<div class="item-row"><span class="item-name">${esc(p.name)}</span><span class="item-amt" style="color:var(--success)">${fmt(p.amt)}</span><button class="btn-del" data-click="removeExtraPago" data-i="${i}" data-j="${j}" aria-label="Eliminar pago adicional" title="Eliminar pago adicional"><i class="ti ti-trash"></i></button></div>`).join('')}</div><div class="add-row" style="margin-top:6px"><input type="text" id="ep-name-${i}" placeholder="Descripción" aria-label="Descripción del pago"><div class="money-field"><span>$</span><input class="money" type="text" inputmode="decimal" autocomplete="off" id="ep-amt-${i}" placeholder="Monto" aria-label="Monto del pago"></div><button class="btn primary" data-click="addExtraPago" data-i="${i}" aria-label="Agregar pago"><i class="ti ti-plus"></i></button></div></div>
<details class="tc-sec" data-sec="usd" data-i="${i}"${op('usd')} data-toggle="tcToggle"><summary><span><i class="ti ti-currency-dollar" style="color:var(--teal)"></i> Saldo en dólares</span><span class="tc-sec-sum">${usdSum}</span><i class="ti ti-chevron-down tc-chev"></i></summary>
<div class="tfields"><div class="tfield"><label for="t${i}-usdTotal">Total a pagar</label><div class="pfx"><span>U$S</span><input type="number" id="t${i}-usdTotal" value="${esc(t.usdTotal)}" placeholder="0.00" step="0.01" data-change="commitRaw" data-i="${i}" data-f="usdTotal"></div></div><div class="tfield"><label for="t${i}-usdMinimo">Pago mínimo</label><div class="pfx"><span>U$S</span><input type="number" id="t${i}-usdMinimo" value="${esc(t.usdMinimo)}" placeholder="0.00" step="0.01" data-change="commitRaw" data-i="${i}" data-f="usdMinimo"></div></div></div><div class="tfield" style="margin-top:6px"><label for="t${i}-tcambio">Tipo de cambio</label><div class="pfx"><span>$</span><input type="number" id="t${i}-tcambio" value="${esc(t.tcambio)}" placeholder="Cotización" data-change="commitRaw" data-i="${i}" data-f="tcambio"></div></div>${nv(t.tcambio)>0&&nv(t.usdTotal)>0?`<p style="font-size:12px;color:var(--ink3);margin-top:6px">Equiv. en pesos: <strong style="color:var(--teal)">${fmt(nv(t.usdTotal)*nv(t.tcambio))}</strong></p>`:''}</details>
<details class="tc-sec" data-sec="det" data-i="${i}"${op('det')} data-toggle="tcToggle"><summary><span><i class="ti ti-list"></i> Detalle del resumen</span><span class="tc-sec-sum">${detSum}</span><i class="ti ti-chevron-down tc-chev"></i></summary>${renderDetalleHTML(t,i)}</details>
</div></div>`;}).join('');renderPageTotals();initDragDrop();}
function renderDetalleHTML(t,i){if(!t.detalle||!t.detalle.length){return `<div class="upload-area" data-click="pickFile" data-i="${i}"><i class="ti ti-upload"></i>Subir resumen de Galicia (.pdf, .xlsx o .csv)<div style="font-size:11px;margin-top:3px">PDF: Home Banking → Tarjetas → Resumen → Descargar PDF<br>Excel: Movimientos → Descargar Excel</div><input type="file" id="upl-${i}" accept=".pdf,.xlsx,.xls,.csv" style="display:none" data-change="handleFile" data-i="${i}"></div>`;}const grupos={};t.detalle.forEach(r=>{const k=r.nombre;if(!grupos[k])grupos[k]={monto:0,montoUSD:0,count:0,cuotas:false,cuotaActual:0,cuotaTotal:0};grupos[k].monto+=r.monto||0;grupos[k].montoUSD+=r.montoUSD||0;grupos[k].count++;if(r.cuotas){grupos[k].cuotas=true;grupos[k].cuotaActual=r.cuotaActual;grupos[k].cuotaTotal=r.cuotaTotal;}});const items=Object.entries(grupos).sort((a,b)=>b[1].monto-a[1].monto);const totalPesos=items.reduce((s,[,v])=>s+v.monto,0);const totalUSD=items.reduce((s,[,v])=>s+v.montoUSD,0);return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px"><span style="font-size:11px;color:var(--ink3)">${t.detalle.length} movimientos · ${items.length} comercios</span><button class="btn danger-btn" style="font-size:11px;padding:3px 8px" data-click="clearDetalle" data-i="${i}"><i class="ti ti-trash"></i> Limpiar</button></div><div>${items.map(([nombre,v])=>`<div class="detalle-item"><span class="detalle-name">${esc(nombre)}${v.count>1&&!v.cuotas?`<span class="detalle-count"> ×${v.count}</span>`:''}</span>${v.cuotas?`<span class="detalle-cuota">${esc(v.cuotaActual)}/${esc(v.cuotaTotal)}</span>`:''}<span class="detalle-monto">${v.monto>0?fmt(v.monto):''}${v.montoUSD>0?`<span style="color:var(--teal);margin-left:4px">${fmtUSD(v.montoUSD)}</span>`:''}</span></div>`).join('')}<div class="detalle-item" style="font-weight:500;border-top:0.5px solid var(--border2);margin-top:4px"><span class="detalle-name">Total consumos</span><span class="detalle-monto">${fmt(totalPesos)}${totalUSD>0?`<span style="color:var(--teal);margin-left:8px">${fmtUSD(totalUSD)}</span>`:''}</span></div></div><div style="margin-top:8px"><div class="upload-area" style="padding:8px;font-size:12px" data-click="pickFile" data-i="${i}"><i class="ti ti-refresh"></i> Reemplazar archivo<input type="file" id="upl-${i}" accept=".pdf,.xlsx,.xls,.csv" style="display:none" data-change="handleFile" data-i="${i}"></div></div>`;}
function handleFile(event,i){const file=event.target.files[0];if(!file)return;if(file.name.toLowerCase().endsWith('.pdf'))parsePDF(file,i);else{const reader=new FileReader();reader.onload=function(e){try{const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});parseXLS(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''}),i);}catch(err){alert('No se pudo leer el archivo.');}};reader.readAsArrayBuffer(file);}}
function parseXLS(rows,i){const mov=[];let hr=-1;for(let r=0;r<rows.length;r++){const row=rows[r].map(c=>String(c||'').toLowerCase());if(row.some(c=>c.includes('descrip')||c.includes('concepto')||c.includes('comercio'))){hr=r;break;}}const header=hr>=0?rows[hr].map(c=>String(c||'').toLowerCase()):[];const iD=Math.max(header.findIndex(c=>c.includes('descrip')||c.includes('concepto')||c.includes('comercio')),1);const iM=header.findIndex(c=>c.includes('monto')||c.includes('importe')||c.includes('total'));const iC=header.findIndex(c=>c.includes('cuota'));for(let r=hr>=0?hr+1:1;r<rows.length;r++){const row=rows[r];if(!row||row.every(c=>!c))continue;const desc=String(row[iD]||row[1]||'').trim();if(!desc)continue;const monto=Math.abs(parseFloat(String(iM>=0?row[iM]:row[row.length-1]).replace(/[^0-9.,-]/g,'').replace(',','.'))||0);if(!monto)continue;let nombre=desc.replace(/\s+/g,' ').trim();let cuotas=false,cuotaActual=0,cuotaTotal=0;const cm=(iC>=0?String(row[iC]||''):'')+' '+nombre,mx=cm.match(/(\d+)\s*\/\s*(\d+)/);if(mx){cuotas=true;cuotaActual=parseInt(mx[1]);cuotaTotal=parseInt(mx[2]);nombre=nombre.replace(/\d+\s*\/\s*\d+/,'').replace(/cuota/i,'').trim();}mov.push({nombre:nombre.replace(/\s+/g,' ').trim().toUpperCase(),monto,montoUSD:0,cuotas,cuotaActual,cuotaTotal});}if(!mov.length){alert('No se encontraron movimientos.');return;}state.tarjetas[i].detalle=mov;if(!nv(state.tarjetas[i].total))state.tarjetas[i].total=Math.round(mov.reduce((s,m)=>s+m.monto,0));save();renderTarjetas();recalc();}
function clearDetalle(i){confirmDelete('¿Borrar el detalle cargado?\nPodés volver a subir el archivo cuando quieras.',()=>{state.tarjetas[i].detalle=[];save();renderTarjetas();});}
function renameTarjeta(i,v){state.tarjetas[i].name=v;save();// El plástico contiene el nombre y el logo/gradiente puede cambiar
const card=document.getElementById('tc-'+i);if(card){const old=card.previousElementSibling;if(old&&old.classList.contains('tcard-plastic-wrap')){old.outerHTML=renderCardPlastic(state.tarjetas[i],i);}}}
function commitT(i,k,v){state.tarjetas[i][k]=v;save();updateTResumen(i);updateCardBadge(i);updateCardBadgeInPlastic(i);updateResta(i);recalc();}
function updateCardBadge(i){const t=state.tarjetas[i];const totalPagado=nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0);const resto=Math.max(0,nv(t.total)-totalPagado);const cls=nv(t.total)===0?'':resto===0?'ok':resto<nv(t.total)*0.5?'warn':'neg';const txt=nv(t.total)===0?'Sin cargar':resto===0?'Saldada':fmt(resto)+' pendiente';const wrap=document.querySelector('#tc-'+i+' ~ div, .tcard-plastic-wrap');/* buscar el badge en el plastic wrap previo al tcard */const card=document.getElementById('tc-'+i);if(!card)return;const plastic=card.previousElementSibling;if(!plastic||!plastic.classList.contains('tcard-plastic-wrap'))return;const badge=plastic.querySelector('.cp-badge');if(badge){badge.className='cp-badge '+(cls||'');badge.textContent=txt;}}
// Pago sugerido sobre lo que FALTA pagar: total y mínimo menos lo ya pagado (pago + adicionales)
function pagoSugerido(t,dispBase,margen){const pag=tcPagos(t).pagado,resto=Math.max(0,nv(t.total)-pag),minResto=Math.max(0,nv(t.minimo)-pag);
  return {sugerido:Math.min(resto,Math.max(minResto,dispBase)),puedeTotal:resto>0&&resto<=margen,parcial:pag>0};}
function updateTResumen(i){const t=state.tarjetas[i],ingresos=totalIngresos(),superAmt=nv(state.superAmt);const otrosGastos=state.servicios.reduce((a,s)=>a+s.amt,0)+superAmt+state.gastosExtra.reduce((a,g)=>a+g.amt,0);const reserva=ingresos*0.10,disponibleBase=Math.max(0,ingresos-otrosGastos-reserva);const {sugerido,puedeTotal,parcial}=pagoSugerido(t,disponibleBase,ingresos-otrosGastos-reserva);const totalPagado=nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0),resto=Math.max(0,nv(t.total)-totalPagado);const card=document.getElementById('tc-'+i);if(!card)return;const pb=card.querySelector('.pago-box');if(pb&&nv(t.total)>0){pb.querySelector('.pago-amt').textContent=fmt(sugerido);pb.querySelector('.pago-desc').textContent=puedeTotal?(parcial?'Podés pagar lo que falta':'Podés pagar el total completo'):'Máximo posible dejando un 10% del sueldo como colchón';}const re=document.getElementById('resto-'+i);if(re){re.textContent=resto>0?fmt(resto):'Saldada';re.className='resto-badge '+(resto>0?'badge warn':'badge success');}}
function addExtraPago(i){const nm=document.getElementById('ep-name-'+i).value.trim(),a=parseMoney(document.getElementById('ep-amt-'+i).value);if(!nm||!a)return;state.tarjetas[i].extraPagos.push({name:nm,amt:a});document.getElementById('ep-name-'+i).value='';document.getElementById('ep-amt-'+i).value='';save();renderTarjetas();recalc();}
function removeExtraPago(i,j){confirmDelete('¿Eliminar este pago adicional?',()=>{state.tarjetas[i].extraPagos.splice(j,1);save();renderTarjetas();recalc();});}
function addTarjeta(){state.tarjetas.push({name:'',total:'',minimo:'',usdTotal:'',usdMinimo:'',tcambio:'',pagado:'',extraPagos:[],detalle:[]});save();renderTarjetas();}
function removeTarjeta(i){confirmDelete('¿Eliminar tarjeta "'+tcName(state.tarjetas[i],i)+'"? Se perderán todos sus datos.',()=>{state.tarjetas.splice(i,1);save();renderTarjetas();recalc();});}
function renderServicios(){
  const mespfx=curYear+'-'+(curMonth+1).toString().padStart(2,'0');
  document.getElementById('servicios-list').innerHTML=state.servicios.map((s,i)=>{
    const srvId=s.id||('srv_'+i);
    return `<div class="srv-row${nv(s.amt)>0?'':' srv-missing'}" id="srv-row-${esc(srvId)}">
      <span class="srv-name">${esc(s.name)}</span>
      <div class="money-field"><span>$</span><input class="money" type="text" inputmode="decimal" autocomplete="off" value="${fmtInput(s.amt)}" placeholder="Sin cargar" aria-label="Monto de ${esc(s.name)}" data-change="updateServ" data-id="${esc(srvId)}"></div>
      <div class="srv-actions">
        <button class="btn btn-sm" data-click="openComprobante" data-id="${esc(srvId)}" data-name="${esc(s.name)}" data-mes="${esc(mespfx)}"><i class="ti ti-upload"></i> Subir</button>
        <button class="btn btn-sm${compCount(s.name)>0?' has-comp':''}" data-click="verComprobantes" data-id="${esc(srvId)}" data-name="${esc(s.name)}" data-mes="${esc(mespfx)}" title="${compCount(s.name)==null?'Ver comprobantes':compCount(s.name)+' comprobante(s) este mes'}"><i class="ti ti-files"></i> Ver${compCount(s.name)>0?' <span class="comp-n">'+compCount(s.name)+'</span>':''}</button>
        <button class="btn-del" data-click="removeServicio" data-id="${esc(srvId)}" aria-label="Eliminar servicio" title="Eliminar servicio"><i class="ti ti-trash"></i></button>
      </div>
    </div>`;
  }).join('')+'<div id="comp-modal-area"></div>';}
function updateServ(srvId,v){const s=state.servicios.find(sv=>sv.id===srvId);if(s){s.amt=parseMoney(v);const row=document.getElementById('srv-row-'+srvId);if(row)row.classList.toggle('srv-missing',!(s.amt>0));save();recalc();}}
async function removeServicio(srvId){confirmDelete('¿Eliminar este servicio permanentemente?\nDesaparecerá de todos los meses.',async ()=>{serviciosPerpetuas=serviciosPerpetuas.filter(s=>s.id!==srvId);state.servicios=state.servicios.filter(s=>s.id!==srvId);await saveServiciosToDrive();save();renderServicios();recalc();});}
async function addServicio(){const nm=document.getElementById('serv-name').value.trim();if(!nm)return;const newSrv={id:'srv_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),name:nm};serviciosPerpetuas.push(newSrv);state.servicios.push({id:newSrv.id,name:nm,amt:0});document.getElementById('serv-name').value='';await saveServiciosToDrive();save();renderServicios();recalc();}

/* ── Comprobantes ── */
async function getComprobantesFolder(srvName,mesPfx){const root=await getRootFolder();if(!root)return null;let compRoot=await findFolder('Comprobantes',root);if(!compRoot){compRoot=await ensureFolder('Comprobantes',root);}const srvFolder=await ensureFolder(srvName,compRoot);return ensureFolder(mesPfx,srvFolder);}
function openComprobante(srvId,srvName,mesPfx){const area=document.getElementById('comp-modal-area');area.innerHTML=`<div class="comp-upload-box" id="comp-box-${esc(srvId)}">
  <div style="font-weight:500;margin-bottom:6px"><i class="ti ti-upload"></i> Subir comprobante — ${esc(srvName)} (${esc(mesPfx)})</div>
  <input type="file" id="comp-file-${esc(srvId)}" accept=".pdf,.png,.jpg,.jpeg,.webp" multiple>
  <div style="margin-top:8px;display:flex;gap:8px">
    <button class="btn primary" data-click="uploadComprobante" data-id="${esc(srvId)}" data-name="${esc(srvName)}" data-mes="${esc(mesPfx)}"><i class="ti ti-cloud-upload"></i> Subir</button>
    <button class="btn" data-click="closeCompModal">Cancelar</button>
  </div>
  <div id="comp-status-${esc(srvId)}" style="margin-top:6px;font-size:12px"></div>
</div>`;}
// Comprobantes: sólo PDF e imágenes, hasta 20 MB (el accept del input es sólo una sugerencia del navegador)
const COMP_TIPOS={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
function compPermitido(f){const ext=(String(f.name).split('.').pop()||'').toLowerCase();return !!COMP_TIPOS[ext]&&(!f.type||f.type===COMP_TIPOS[ext])&&f.size>0&&f.size<=20*1024*1024;}
async function uploadComprobante(srvId,srvName,mesPfx){const input=document.getElementById('comp-file-'+srvId);if(!input||!input.files.length){alert('Seleccioná un archivo primero.');return;}const status=document.getElementById('comp-status-'+srvId);status.textContent='Subiendo...';try{const folderId=await getComprobantesFolder(srvName,mesPfx);if(!folderId){status.textContent='Error: no se pudo crear carpeta';return;}let ok=0,rechazados=[];for(const file of input.files){if(!compPermitido(file)){rechazados.push(file.name);continue;}const fname=file.name;const blob=file;const meta={name:fname,parents:[folderId]};const form=new FormData();form.append('metadata',new Blob([JSON.stringify(meta)],{type:'application/json'}));form.append('file',blob);const r=await driveReq('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',body:form});if(r&&r.ok)ok++;}status.innerHTML='<span style="color:var(--success)">✓ '+ok+' archivo(s) subido(s)</span>'+(rechazados.length?'<br><span style="color:var(--danger)">No se subieron (sólo PDF, JPG, PNG o WEBP de hasta 20 MB): '+esc(rechazados.join(', '))+'</span>':'');loadCompCounts(true);if(!rechazados.length)setTimeout(()=>{document.getElementById('comp-modal-area').innerHTML='';},2000);}catch(e){status.textContent='Error al subir: '+e.message;}}
async function verComprobantes(srvId,srvName,mesPfx){const area=document.getElementById('comp-modal-area');area.innerHTML=`<div class="comp-upload-box"><div style="font-weight:500;margin-bottom:8px"><i class="ti ti-files"></i> Comprobantes — ${esc(srvName)} (${esc(mesPfx)})</div><div id="comp-list-${esc(srvId)}">Cargando...</div><button class="btn" style="margin-top:8px" data-click="closeCompModal">Cerrar</button></div>`;
try{const folderId=await getComprobantesFolder(srvName,mesPfx);if(!folderId){document.getElementById('comp-list-'+srvId).textContent='Sin carpeta';return;}const q='\''+folderId+'\' in parents and trashed=false';const r=await driveReq('https://www.googleapis.com/drive/v3/files?spaces=drive&q='+encodeURIComponent(q)+'&fields=files(id,name,mimeType,size,webViewLink,webContentLink)');if(!r){document.getElementById('comp-list-'+srvId).textContent='Error';return;}const d=await r.json();const files=d.files||[];if(!files.length){document.getElementById('comp-list-'+srvId).innerHTML='<em>No hay comprobantes para este mes</em>';return;}document.getElementById('comp-list-'+srvId).innerHTML=files.map(f=>`<div class="item-row" style="gap:8px"><span class="item-name" style="font-size:12px">${esc(f.name)}</span><a href="${esc(f.webViewLink)}" target="_blank" class="btn-icon" title="Ver"><i class="ti ti-eye"></i></a><a href="${esc(f.webContentLink)}" download class="btn-icon" title="Descargar"><i class="ti ti-download"></i></a></div>`).join('');}catch(e){document.getElementById('comp-list-'+srvId).textContent='Error: '+e.message;}}
function renderGastosExtra(){document.getElementById('gastos-extra-list').innerHTML=state.gastosExtra.map((g,i)=>`<div class="item-row"><span class="item-name">${esc(g.name)}</span>${g.fecha?`<span class="item-date">${esc(String(g.fecha).slice(8,10)+'/'+String(g.fecha).slice(5,7))}</span>`:''}<span class="item-amt">${fmt(g.amt)}</span><button class="btn-del" data-click="removeGastoExtra" data-i="${i}" aria-label="Eliminar gasto" title="Eliminar gasto"><i class="ti ti-trash"></i></button></div>`).join('');}
function addGastoExtra(){const nm=document.getElementById('gextra-name').value.trim(),a=parseMoney(document.getElementById('gextra-amt').value);if(!nm||!a)return;state.gastosExtra.push({name:nm,amt:a,fecha:new Date().toISOString().slice(0,10)});document.getElementById('gextra-name').value='';document.getElementById('gextra-amt').value='';save();renderGastosExtra();recalc();}
function removeGastoExtra(i){confirmDelete('¿Eliminar gasto extra?',()=>{state.gastosExtra.splice(i,1);save();renderGastosExtra();recalc();});}
function recalc(){const ingresos=totalIngresos(),servicios=state.servicios.reduce((a,s)=>a+s.amt,0);const superAmt=nv(state.superAmt);const gastosExtra=state.gastosExtra.reduce((a,g)=>a+g.amt,0);const otrosGastos=servicios+superAmt+gastosExtra,tarjetasPagadas=totalPagadoTarjetas();const tarjetasUSD=state.tarjetas.reduce((a,t)=>a+nv(t.usdTotal),0);const disponible=ingresos-otrosGastos-tarjetasPagadas;const pct=ingresos>0?Math.round((disponible/ingresos)*100):0;document.getElementById('s-ing').textContent=fmt(ingresos);document.getElementById('s-fij').textContent=fmt(otrosGastos);document.getElementById('s-tar').textContent=fmt(tarjetasPagadas);document.getElementById('s-usd').textContent=fmtUSD(tarjetasUSD);
// Hero card
const heroDisp=document.getElementById('s-disp');heroDisp.textContent=fmt(disponible);heroDisp.className='hero-amount';
const heroSub=document.getElementById('hero-sub');if(ingresos>0){heroSub.textContent=`De ${fmt(ingresos)} en ingresos · ${pct}% libre`;}else{heroSub.textContent='Cargá tus ingresos para ver el análisis';}
const hpIng=document.getElementById('hp-ing');hpIng.textContent=fmt(ingresos);
const hpPill=document.getElementById('hp-prog-wrap');if(ingresos>0&&pct<10){hpPill.style.display='';document.getElementById('hp-prog').textContent='¡Margen crítico!';}else{hpPill.style.display='none';}
const pct2=Math.max(0,Math.min(100,ingresos>0?(disponible/ingresos)*100:0));const prog=document.getElementById('s-prog');prog.style.width=pct2+'%';prog.style.background=pct2>20?'var(--accent)':pct2>10?'var(--warn)':'var(--danger)';const bd=document.getElementById('summary-breakdown'),brows=[];if(state.sueldo)brows.push(['<i class="ti ti-wallet"></i> Sueldo neto',fmt(nv(state.sueldo)),'pos']);if(state.extras.length)brows.push(['<i class="ti ti-plus"></i> Ingresos extra',fmt(state.extras.reduce((a,e)=>a+e.amt,0)),'pos']);if(servicios)brows.push(['<i class="ti ti-building"></i> Servicios fijos','−'+fmt(servicios),'']);if(superAmt)brows.push(['<i class="ti ti-shopping-cart"></i> Super / Mercado','−'+fmt(superAmt),'']);if(gastosExtra)brows.push(['<i class="ti ti-tag"></i> Gastos extra','−'+fmt(gastosExtra),'']);state.tarjetas.forEach((t,i)=>{const pagado=nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0),resto=Math.max(0,nv(t.total)-pagado);if(pagado)brows.push([`<i class="ti ti-credit-card"></i> ${esc(tcName(t,i))} (pagado)`,'−'+fmt(pagado),'']);if(resto)brows.push([`<i class="ti ti-clock"></i> ${esc(tcName(t,i))} (resto pendiente)`,fmt(resto),'warn']);});bd.innerHTML=brows.map(([l,v,c])=>`<tr><td class="lbl">${l}</td><td class="amt" style="${c==='pos'?'color:var(--success)':c==='warn'?'color:var(--warn)':''}">${v}</td></tr>`).join('')+`<tr class="total-row"><td class="lbl"><i class="ti ti-coin"></i> Disponible</td><td class="amt" style="color:${disponible>=0?'var(--success)':'var(--danger)'}">${fmt(disponible)}</td></tr>`;renderComparacion();const ins=[];if(ingresos>0){if(pct>=20)ins.push(`<span class="badge success"><i class="ti ti-thumb-up"></i> Buen margen: ${pct}% disponible</span>`);else if(pct>=10)ins.push(`<span class="badge warn"><i class="ti ti-alert-triangle"></i> Margen ajustado: ${pct}% disponible</span>`);else if(pct>=0)ins.push(`<span class="badge danger"><i class="ti ti-alert-circle"></i> Margen crítico: ${pct}% disponible</span>`);else ins.push(`<span class="badge danger"><i class="ti ti-x"></i> Gastos superan ingresos (${pct}%)</span>`);const cats=[{label:'Servicios',val:servicios},{label:'Super/Mercado',val:superAmt},{label:'Gastos extra',val:gastosExtra},{label:'Tarjetas',val:tarjetasPagadas}];const mayor=cats.sort((a,b)=>b.val-a.val)[0];if(mayor.val>0)ins.push(`<span class="badge info"><i class="ti ti-chart-bar"></i> Mayor gasto: ${mayor.label} (${fmt(mayor.val)})</span>`);state.tarjetas.forEach((t,i)=>{const resto=Math.max(0,nv(t.total)-(nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0)));if(resto>0)ins.push(`<span class="badge warn"><i class="ti ti-clock"></i> ${esc(tcName(t,i))}: resta pagar ${fmt(resto)}</span>`);});}else ins.push(`<span class="badge info"><i class="ti ti-info-circle"></i> Cargá tus ingresos para ver el análisis</span>`);document.getElementById('insight-row').innerHTML=ins.join('');updateDrawerBadges();renderPageTotals();}
/* ══════════════════════════════════════════════
   PUNTO 4 — CONFIRM MODAL
   ══════════════════════════════════════════════ */
function confirmDelete(msg,onConfirm){
  const ov=document.createElement('div');
  ov.className='confirm-overlay';
  const lines=msg.split('\n');
  ov.innerHTML=`<div class="confirm-box">
    <div class="confirm-icon"><i class="ti ti-trash"></i></div>
    <div class="confirm-title">${esc(lines[0])}</div>
    ${lines[1]?`<div class="confirm-msg">${esc(lines.slice(1).join('\n'))}</div>`:''}
    <div class="confirm-actions">
      <button class="btn" id="cfm-cancel">Cancelar</button>
      <button class="btn danger-btn" id="cfm-ok"><i class="ti ti-trash"></i> Eliminar</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#cfm-cancel').onclick=()=>ov.remove();
  ov.querySelector('#cfm-ok').onclick=()=>{ov.remove();onConfirm();};
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
}

/* ══════════════════════════════════════════════
   PUNTO 6 — DRAWER BADGES (indicadores pendientes)
   ══════════════════════════════════════════════ */
// ══ Paneles laterales de escritorio (propuesta A) ══
const isWide=()=>window.matchMedia('(min-width:1024px)').matches;
const MCORTO=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function prevYM(k){let m=curMonth-k,y=curYear;while(m<0){m+=12;y--;}return {y,m};}
// Diferencia vs mes anterior. bueno='up' para ingresos (subir es bueno), 'down' para gastos
function sideDelta(a,p,bueno){if(p==null)return '<span class="sd-eq">sin datos</span>';if(!(a>0))return '<span class="sd-eq">sin cargar todavía</span>';const d=a-p;if(!d)return '<span class="sd-eq">= sin cambios</span>';const pc=p?Math.round(d/p*100):0;const good=(d>0)===(bueno==='up');return '<span class="'+(good?'sd-good':'sd-bad')+'">'+(d>0?'▲ ':'▼ ')+fmt(Math.abs(d))+(p?' <small>'+(pc>0?'+':'')+pc+'%</small>':'')+'</span>';}
function sidePrev(fn){const {y,m}=prevYM(1);const d=ddMonthData(y,m);return d?fn(d):null;}
function sideSpark(titulo,fn,color){const ms=[];for(let k=5;k>=0;k--){const {y,m}=prevYM(k);const d=ddMonthData(y,m);ms.push({lbl:MCORTO[m],cur:k===0,v:d?fn(d):null});}
  const con=ms.filter(x=>x.v!=null&&x.v>0);if(con.length<2)return '<div class="side-card"><div class="side-lbl">'+titulo+'</div><div class="side-empty">El gráfico aparece cuando haya al menos dos meses cargados.</div></div>';
  const mx=Math.max(...con.map(x=>x.v));return '<div class="side-card"><div class="side-lbl">'+titulo+'</div><div class="side-spark">'+ms.map(x=>'<div><b class="'+(x.cur?'cur':'')+(x.v==null||!(x.v>0)?' nodata':'')+'" style="height:'+(x.v>0?Math.max(4,x.v/mx*100):6)+'%;'+(x.v>0?'background:'+(x.cur?color:color+'55'):'')+'" title="'+x.lbl+': '+(x.v>0?fmt(x.v):'sin datos')+'"></b><small class="'+(x.cur?'cur':'')+'">'+x.lbl+'</small></div>').join('')+'</div></div>';}
function sideBar(parts){const tot=parts.reduce((a,x)=>a+x.v,0)||1;return '<div class="side-bar">'+parts.filter(x=>x.v>0).map(x=>'<div style="width:'+(x.v/tot*100)+'%;background:'+x.c+'"></div>').join('')+'</div><div class="side-leg">'+parts.map(x=>'<span><i style="background:'+x.c+'"></i>'+x.n+' '+Math.round(x.v/tot*100)+'%</span>').join('')+'</div>';}
const kv=(k,v)=>'<div class="side-kv"><span>'+k+'</span>'+v+'</div>';
function compRow(){if(!accessToken||!state.servicios.length)return '';loadCompCounts();const mes=curYear+'-'+String(curMonth+1).padStart(2,'0'),c=compCache[mes];
  if(!c||!c.map)return kv('Comprobantes subidos','<span class="side-sub" style="margin:0">'+(c&&c.err?'No se pudo consultar Drive':'Buscando…')+'</span>');
  const con=state.servicios.filter(x=>compCount(x.name)>0),sin=state.servicios.filter(x=>!(compCount(x.name)>0));
  return kv('Comprobantes subidos','<span class="dd-badge" style="background:'+(sin.length?'rgba(251,191,36,.10);color:#fbbf24':'rgba(52,211,153,.12);color:#34d399')+'">'+(sin.length?con.length+' de '+state.servicios.length:'<i class="ti ti-check"></i> Todos')+'</span>')+
    (sin.length?'<div class="side-sub" style="text-align:right;margin-top:-4px">Falta: '+sin.map(x=>esc(x.name)).join(', ')+'</div>':'');}
function renderSides(){if(!isWide()||!document.getElementById('side-ingresos'))return;const $=id=>document.getElementById(id);
  const pm=MCORTO[prevYM(1).m];const ingT=totalIngresos();
  // Ingresos
  const ext=(state.extras||[]).reduce((a,e)=>a+nv(e.amt),0),su=nv(state.sueldo);
  const pIng=sidePrev(d=>totalIngresos(d)),pSu=sidePrev(d=>nv(d.sueldo));
  $('hint-sueldo').textContent=pSu!=null?pm+': '+fmt(pSu):'';$('hint-extras').textContent=ext>0?fmt(ext):'';
  $('side-ingresos').innerHTML='<div class="side-card"><div class="side-lbl">Total ingresos del mes</div><div class="side-big" style="color:var(--success)">'+fmt(su+ext)+'</div>'+(su+ext>0?sideBar([{n:'Sueldo',v:su,c:'#34d399'},{n:'Extras',v:ext,c:'#5dcaa5'}]):'')+
    '<div class="side-sep">'+kv('Sueldo','<b>'+fmt(su)+'</b>')+kv('Extras','<b>'+fmt(ext)+'</b>')+kv('vs '+pm,sideDelta(su+ext,pIng,'up'))+'</div></div>'+sideSpark('Ingresos de los últimos 6 meses',d=>totalIngresos(d),'#34d399');
  // Servicios
  const sv=state.servicios.reduce((a,x)=>a+nv(x.amt),0),carg=state.servicios.filter(x=>nv(x.amt)>0),falt=state.servicios.filter(x=>!(nv(x.amt)>0));
  const pSv=sidePrev(d=>(d.servicios||[]).reduce((a,x)=>a+nv(x.amt),0));const pServ=sidePrev(d=>d.servicios||[])||[];
  const prevDe=x=>{const q=pServ.find(z=>z.id===x.id);return q&&nv(q.amt)>0?nv(q.amt):null;};
  let alerta='';if(falt.length){const nombres=falt.map(x=>esc(x.name));const det=falt.length===1&&prevDe(falt[0])!=null?'En '+MESES[prevYM(1).m].toLowerCase()+' pagaste '+fmt(prevDe(falt[0])):'Cargá cuánto pagaste este mes';
    alerta='<div class="side-alert"><i class="ti ti-alert-triangle"></i><div><b>'+(falt.length===1?'Falta cargar '+nombres[0]:'Faltan cargar '+nombres.slice(0,-1).join(', ')+' y '+nombres.slice(-1))+'</b><div>'+det+'</div></div></div>';}
  const cols=['#6c8fff','#fbbf24','#34d399','#f87171','#5dcaa5','#a78bfa'];
  $('side-servicios').innerHTML='<div class="side-card"><div class="side-lbl">Total servicios del mes</div><div class="side-big">'+fmt(sv)+'</div><div class="side-sub">'+(state.servicios.length?carg.length+' de '+state.servicios.length+' cargados':'Sin servicios')+(ingT>0?' · '+Math.round(sv/ingT*100)+'% del ingreso':'')+'</div>'+alerta+
    '<div class="side-sep">'+kv('vs '+pm,sideDelta(sv,pSv,'down'))+compRow()+'</div></div>'+
    (carg.length?'<div class="side-card"><div class="side-lbl">En qué se va</div>'+state.servicios.map((x,i)=>nv(x.amt)>0?'<div class="side-dist"><span>'+esc(x.name)+'</span><div class="side-track"><div style="width:'+(nv(x.amt)/sv*100)+'%;background:'+cols[i%cols.length]+'"></div></div><b>'+Math.round(nv(x.amt)/sv*100)+'%</b></div>':'').join('')+'</div>':'');
  // Otros gastos
  const sp=nv(state.superAmt),gx=(state.gastosExtra||[]).reduce((a,g)=>a+nv(g.amt),0);const pSp=sidePrev(d=>nv(d.superAmt)),pGx=sidePrev(d=>(d.gastosExtra||[]).reduce((a,g)=>a+nv(g.amt),0));
  $('hint-super').textContent=pSp!=null?pm+': '+fmt(pSp):'';$('hint-gastos').textContent=gx>0?fmt(gx):'';
  $('side-gastos').innerHTML='<div class="side-card"><div class="side-lbl">Total otros gastos</div><div class="side-big">'+fmt(sp+gx)+'</div>'+(sp+gx>0?sideBar([{n:'Super',v:sp,c:'#5dcaa5'},{n:'Extras',v:gx,c:'#a78bfa'}]):'')+
    '<div class="side-sep">'+kv('Super vs '+pm,sideDelta(sp,pSp,'down'))+kv('Extras vs '+pm,sideDelta(gx,pGx,'down'))+kv('% del ingreso','<b>'+(ingT>0?Math.round((sp+gx)/ingT*100)+'%':'—')+'</b>')+'</div></div>'+sideSpark('Super por mes',d=>nv(d.superAmt),'#5dcaa5');
  // Tarjetas
  const tot=state.tarjetas.reduce((a,t)=>a+nv(t.total),0),pag=state.tarjetas.reduce((a,t)=>a+tcPagos(t).pagado,0),resta=Math.max(0,tot-pag);
  const otros=sv+sp+gx,dispBase=Math.max(0,ingT-otros-ingT*0.10);
  const pend=state.tarjetas.filter(t=>nv(t.total)>0&&tcPagos(t).pagado<nv(t.total));
  const sug=pend.reduce((a,t)=>a+pagoSugerido(t,dispBase,Infinity).sugerido,0),mins=pend.reduce((a,t)=>a+nv(t.minimo),0),usd=state.tarjetas.reduce((a,t)=>a+nv(t.usdTotal),0);
  $('side-tarjetas').innerHTML='<div class="side-card"><div class="side-lbl">'+(tot>0&&resta<=0?'Tarjetas del mes':'Resta pagar este mes')+'</div><div class="side-big" style="color:'+(tot>0&&resta<=0?'var(--success)':'var(--warn)')+'">'+(tot>0&&resta<=0?'<i class="ti ti-check"></i> Todo saldado':fmt(resta))+'</div><div class="side-sub">'+(tot>0?'Pagado '+fmt(pag)+' de '+fmt(tot):'Cargá el total de cada resumen')+'</div>'+
    (state.tarjetas.length?'<div class="side-sep">'+state.tarjetas.map((t,i)=>{const P=tcPagos(t),ok=P.total>0&&P.pagado>=P.total,pc=P.total>0?Math.min(100,P.pagado/P.total*100):0;
      return '<div class="side-tc">'+cardMiniIcon(t.name)+'<div class="side-tc-b"><div class="side-tc-h"><b>'+esc(ddName(tcName(t,i)))+'</b>'+(P.total<=0?'<span class="dd-badge" style="background:rgba(255,255,255,.06);color:var(--ink3)">Sin cargar</span>':ok?'<span class="dd-badge" style="background:rgba(52,211,153,.12);color:#34d399"><i class="ti ti-check"></i> Saldada</span>':'<span class="dd-badge" style="background:rgba(251,191,36,.10);color:#fbbf24">'+Math.round(pc)+'% pagado</span>')+'</div><div class="side-track"><div style="width:'+pc+'%;background:'+(ok?'#34d399':'#fbbf24')+'"></div></div></div></div>';}).join('')+'</div>':'')+'</div>'+
    '<div class="side-card">'+kv('Pago sugerido total','<b style="color:var(--info)">'+(pend.length?fmt(sug):'—')+'</b>')+kv('Mínimos del mes','<b>'+(mins?fmt(mins):'—')+'</b>')+kv('Saldo en dólares','<b>'+(usd?fmtUSD(usd):'—')+'</b>')+
    '<button class="btn side-add" data-click="addTarjeta"><i class="ti ti-plus"></i> Agregar tarjeta</button></div>';
}
window.addEventListener('resize',()=>{clearTimeout(window.__rsT);window.__rsT=setTimeout(renderSides,200);});
function renderPageTotals(){const $=id=>document.getElementById(id);if(!$('tot-ingresos'))return;
  const ext=(state.extras||[]).reduce((a,e)=>a+nv(e.amt),0),su=nv(state.sueldo);
  $('tot-ingresos').textContent=fmt(su+ext);$('tot-ingresos-sub').textContent=ext>0?'Sueldo '+fmt(su)+' + extras '+fmt(ext):'Sueldo';
  const sv=state.servicios.reduce((a,x)=>a+nv(x.amt),0),falt=state.servicios.filter(x=>!(nv(x.amt)>0)).length;
  $('tot-servicios').textContent=fmt(sv);$('tot-servicios-sub').textContent=state.servicios.length?(falt?falt+' sin cargar este mes':'Todos cargados'):'Sin servicios';
  const sp=nv(state.superAmt),gx=(state.gastosExtra||[]).reduce((a,g)=>a+nv(g.amt),0);
  $('tot-gastos').textContent=fmt(sp+gx);$('tot-gastos-sub').textContent='Super '+fmt(sp)+(gx>0?' + extras '+fmt(gx):'');
  renderSides();
  const tot=state.tarjetas.reduce((a,t)=>a+nv(t.total),0),pag=state.tarjetas.reduce((a,t)=>a+tcPagos(t).pagado,0),el=$('tc-summary');
  if(el){if(tot>0||pag>0){const r=Math.max(0,tot-pag);el.style.display='';el.innerHTML='<div><div class="page-total-lbl">Tarjetas del mes</div><div class="page-total-sub">Pagado '+fmt(pag)+' de '+fmt(tot)+'</div></div><div style="text-align:right"><div class="page-total-lbl">'+(r>0?'Resta pagar':'Todo saldado')+'</div><div class="page-total-amt" style="color:'+(r>0?'var(--warn)':'var(--success)')+'">'+(r>0?fmt(r):'<i class="ti ti-check"></i>')+'</div></div>';}else el.style.display='none';}}
function updateDrawerBadges(){
  // Tarjetas: cuántas tienen saldo pendiente
  const tarjetasPend=state.tarjetas.filter(t=>{
    const pagado=nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0);
    return nv(t.total)>0&&pagado<nv(t.total);
  }).length;
  const bt=document.getElementById('dnav-badge-tarjetas');
  if(bt){if(tarjetasPend>0){bt.textContent=tarjetasPend+(tarjetasPend>1?' pendientes':' pendiente');bt.className='dnav-badge';bt.style.display='';}else bt.style.display='none';}
  // Servicios: cuántos sin monto este mes
  const servSinMonto=state.servicios.filter(s=>!s.amt||s.amt===0).length;
  const bs=document.getElementById('dnav-badge-servicios');
  if(bs){if(servSinMonto>0){bs.textContent=servSinMonto+' sin monto';bs.className='dnav-badge warn';bs.style.display='';}else bs.style.display='none';}
  // Barra inferior: los mismos avisos, como número sobre el ícono
  const nt=document.getElementById('bnav-badge-tarjetas'),ns=document.getElementById('bnav-badge-servicios');
  if(nt){nt.hidden=!tarjetasPend;nt.textContent=tarjetasPend;nt.parentElement.parentElement.setAttribute('aria-label','Tarjetas'+(tarjetasPend?', '+tarjetasPend+' con saldo pendiente':''));}
  if(ns){ns.hidden=!servSinMonto;ns.textContent=servSinMonto;ns.parentElement.parentElement.setAttribute('aria-label','Servicios'+(servSinMonto?', '+servSinMonto+' sin monto':''));}
}

/* ══════════════════════════════════════════════
   PUNTO 1 — PERSISTENCIA REAL POR MES EN DRIVE
   Los datos de cada mes se guardan en un archivo
   separado: finanzas_YYYY_MM.json
   ══════════════════════════════════════════════ */
const monthFileIds={};
function monthFileName(y,m){return 'finanzas_'+(y===undefined?curYear:y)+'_'+String((m===undefined?curMonth:m)+1).padStart(2,'0')+'.json';}
// Último contenido de cada mes que se leyó o guardó en Drive: sirve para notar cambios hechos desde el bot
const monthJson={};
let dirty=false,lastRefresh=0;
async function loadMonthFromDrive(y,m){
  const fname=monthFileName(y,m);
  const fid=await findDataFile(fname);
  if(!fid)return null;
  monthFileIds[fname]=fid;
  const d=await readJsonFile(fid);
  if(d)monthJson[fname]=JSON.stringify(d);
  return d;
}
// Al volver a la pestaña: si el mes cambió en Drive (por ejemplo, un /gasto desde Telegram), se trae.
// No se hace si hay cambios propios sin subir o si estás escribiendo en un campo.
async function refreshMonthFromDrive(){
  if(!accessToken||dirty||!navigator.onLine||Date.now()-lastRefresh<10000)return;
  const ae=document.activeElement;if(ae&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))return;
  lastRefresh=Date.now();const y=curYear,m=curMonth,fname=monthFileName(y,m);
  try{const fid=monthFileIds[fname]||await findDataFile(fname);if(!fid)return;monthFileIds[fname]=fid;
    const d=await readJsonFile(fid);if(!d||!Array.isArray(d.tarjetas))return;
    const js=JSON.stringify(d);
    if(js===monthJson[fname]||dirty||y!==curYear||m!==curMonth)return;
    monthJson[fname]=js;
    try{localStorage.setItem(mkey(),js);}catch(e){}
    state=getState();renderAll();renderSides();
    setSyncInfo('Actualizado desde Drive ✓','ok');
  }catch(e){}
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshMonthFromDrive();});
window.addEventListener('focus',refreshMonthFromDrive);
async function saveMonthToDrive(){
  if(!accessToken)return;
  setSyncInfo('<i class="ti ti-loader"></i> Guardando...','spin');
  try{
    const datos=await getDataFolder();if(!datos){setSyncInfo('Error: carpeta Drive','err');return;}
    const fname=monthFileName();
    const fid=monthFileIds[fname]||await findDataFile(fname);
    const js=JSON.stringify(state);
    let newId=await writeJsonFile(fname,datos,state,fid);
    // id guardado que ya no sirve (archivo movido o borrado): se vuelve a buscar una vez
    if(!newId&&fid){delete monthFileIds[fname];const f2=await findDataFile(fname);if(f2!==fid)newId=await writeJsonFile(fname,datos,state,f2);}
    if(!newId){setSyncInfo('Error al guardar','err');return;}
    monthFileIds[fname]=newId;monthJson[fname]=js;if(JSON.stringify(state)===js)dirty=false;
    // también guardar en localStorage como cache
    try{localStorage.setItem(mkey(),JSON.stringify(state));}catch(e){}
    const ts=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
    setSyncInfo('Guardado '+ts+' ✓','ok');
  }catch(e){setSyncInfo('Error al guardar','err');}
}
// Reemplazar schedulePush para que use el guardado por mes
function schedulePush2(){clearTimeout(pushTimer);pushTimer=setTimeout(saveMonthToDrive,800);}

/* ══════════════════════════════════════════════
   PUNTO 8 — MODO OFFLINE / CACHE LOCAL
   ══════════════════════════════════════════════ */
function updateOfflineBadge(){
  const b=document.getElementById('offlineBadge');
  if(b)b.classList.toggle('show',!navigator.onLine);
}
window.addEventListener('online',()=>{updateOfflineBadge();if(accessToken)saveMonthToDrive();});
window.addEventListener('offline',updateOfflineBadge);

/* ══════════════════════════════════════════════
   PUNTO 2 — HISTORIAL DE TARJETAS
   ══════════════════════════════════════════════ */
async function showHistorialTarjeta(idx){
  const cardName=tcName(state.tarjetas[idx],idx);
  // Últimos 6 meses: de este navegador o, si faltan, de Drive
  const espera=document.createElement('div');espera.className='hist-modal';
  espera.innerHTML='<div class="hist-box" style="text-align:center;color:var(--ink3);padding:2rem"><i class="ti ti-loader-2"></i> Cargando historial…</div>';
  document.body.appendChild(espera);
  const periodos=[];
  for(let d=5;d>=0;d--){let m=curMonth-d,y=curYear;while(m<0){m+=12;y--;}periodos.push({y,m});}
  const estados=await Promise.all(periodos.map(({y,m})=>cargarMes(y,m)));
  espera.remove();
  const clave=(cardName||'').trim().toLowerCase();
  const months=periodos.map(({y,m},j)=>{
    const s=estados[j],ts=s?.tarjetas||[];
    // la misma tarjeta por nombre (el orden puede cambiar entre meses); si no tiene nombre, por posición
    let t=clave?ts.find((x,i)=>tcName(x,i).trim().toLowerCase()===clave):null;
    if(!t&&!(state.tarjetas[idx].name||'').trim())t=ts[idx];
    const pagado=t?nv(t.pagado)+(t.extraPagos||[]).reduce((a,p)=>a+nv(p.amt),0):0;
    const total=t?nv(t.total):0;
    return {label:MESES[m].slice(0,3)+' '+String(y).slice(2),pagado,total,y,m};
  });
  const maxVal=Math.max(...months.map(m=>Math.max(m.pagado,m.total)),1);
  const ov=document.createElement('div');
  ov.className='hist-modal';
  ov.innerHTML=`<div class="hist-box">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--ink)">${esc(cardName)}</div>
        <div style="font-size:12px;color:var(--ink4)">Historial últimos 6 meses</div>
      </div>
      <button class="btn-icon" data-click="closeHist"><i class="ti ti-x" style="font-size:18px"></i></button>
    </div>
    ${months.map(m=>`
    <div class="hist-month-row">
      <div style="width:52px;font-size:12px;color:var(--ink3);font-weight:600">${m.label}</div>
      <div style="flex:1">
        ${m.total>0?`<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <span style="font-size:10px;color:var(--ink4);width:42px">Total</span>
          <div class="hist-bar-bg"><div class="hist-bar-fill" style="width:${Math.round(m.total/maxVal*100)}%;background:var(--ink4)"></div></div>
          <span style="font-size:11px;color:var(--ink3)">${fmt(m.total)}</span>
        </div>`:'<span style="font-size:11px;color:var(--ink4)">Sin datos</span>'}
        ${m.pagado>0?`<div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;color:var(--ink4);width:42px">Pagado</span>
          <div class="hist-bar-bg"><div class="hist-bar-fill" style="width:${Math.round(m.pagado/maxVal*100)}%;background:var(--success)"></div></div>
          <span style="font-size:11px;color:var(--success)">${fmt(m.pagado)}</span>
        </div>`:''}
      </div>
      ${m.total>0&&m.pagado>=m.total?`<span style="font-size:11px;color:var(--success);font-weight:700">✓</span>`:m.total>0?`<span style="font-size:10px;color:var(--warn)">${fmt(m.total-m.pagado)}<br>pend.</span>`:''}
    </div>`).join('')}
    <button class="btn" style="width:100%;justify-content:center;margin-top:1rem" data-click="closeHist">Cerrar</button>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
}

/* ══════════════════════════════════════════════
   PUNTO 3 — EXPORTAR RESUMEN PDF (via print)
   ══════════════════════════════════════════════ */
function exportResumenPDF(){
  const mes=MESES[curMonth]+' '+curYear;
  const ingresos=totalIngresos();
  const servicios=state.servicios.reduce((a,s)=>a+s.amt,0);
  const superAmt=nv(state.superAmt);
  const gastosExtra=state.gastosExtra.reduce((a,g)=>a+g.amt,0);
  const tarjetas=state.tarjetas;
  const tarjetasPagadas=totalPagadoTarjetas();
  const disponible=ingresos-servicios-superAmt-gastosExtra-tarjetasPagadas;
  const w=window.open('','_blank');
  if(!w){alert('El navegador bloqueó la ventana del resumen: permití las ventanas emergentes para este sitio.');return;}
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Resumen Finanzas — ${mes}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1a1a2e;background:#fff;padding:2rem;max-width:720px;margin:0 auto;font-size:13px}
    h1{font-size:22px;font-weight:800;margin-bottom:2px;color:#0d1b3e}
    .sub{color:#666;font-size:13px;margin-bottom:1.5rem}
    table{width:100%;border-collapse:collapse;margin-bottom:1.5rem}
    th{text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:4px 8px;border-bottom:2px solid #e5e7eb}
    td{padding:8px 8px;border-bottom:1px solid #f0f0f0}
    .amt{text-align:right;font-weight:600}
    .pos{color:#16a34a}.neg{color:#dc2626}.warn{color:#d97706}
    .total-row td{font-weight:700;border-top:2px solid #e5e7eb;padding-top:12px;font-size:14px}
    .section{font-size:14px;font-weight:700;margin:1.5rem 0 .5rem;color:#0d1b3e;border-bottom:1px solid #e5e7eb;padding-bottom:6px}
    @media print{body{padding:1rem}}
  </style></head><body>
  <h1>Mis Finanzas</h1>
  <div class="sub">Resumen — ${mes} · Generado ${new Date().toLocaleDateString('es-AR')}</div>
  <div class="section">Ingresos</div>
  <table><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr>
  <tr><td>Sueldo neto</td><td class="amt pos">${fmt(nv(state.sueldo))}</td></tr>
  ${state.extras.map(e=>`<tr><td>${esc(e.name)}</td><td class="amt pos">${fmt(e.amt)}</td></tr>`).join('')}
  <tr class="total-row"><td>Total ingresos</td><td class="amt pos">${fmt(ingresos)}</td></tr></table>
  <div class="section">Gastos</div>
  <table><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr>
  ${state.servicios.filter(s=>s.amt).map(s=>`<tr><td>${esc(s.name)}</td><td class="amt neg">−${fmt(s.amt)}</td></tr>`).join('')}
  ${superAmt?`<tr><td>Super / Mercado</td><td class="amt neg">−${fmt(superAmt)}</td></tr>`:''}
  ${state.gastosExtra.map(g=>`<tr><td>${esc(g.name)}</td><td class="amt neg">−${fmt(g.amt)}</td></tr>`).join('')}
  <tr class="total-row"><td>Total gastos fijos</td><td class="amt neg">−${fmt(servicios+superAmt+gastosExtra)}</td></tr></table>
  <div class="section">Tarjetas</div>
  <table><tr><th>Tarjeta</th><th style="text-align:right">Total</th><th style="text-align:right">Pagado</th><th style="text-align:right">Resto</th></tr>
  ${tarjetas.map((t,i)=>{const pag=nv(t.pagado)+t.extraPagos.reduce((s,p)=>s+p.amt,0);const r=Math.max(0,nv(t.total)-pag);return`<tr><td>${esc(tcName(t,i))}</td><td class="amt">${nv(t.total)?fmt(nv(t.total)):'—'}</td><td class="amt pos">${pag?fmt(pag):'—'}</td><td class="amt ${r>0?'warn':''}">${r?fmt(r):'✓'}</td></tr>`;}).join('')}
  <tr class="total-row"><td>Total tarjetas</td><td class="amt"></td><td class="amt">${fmt(tarjetasPagadas)}</td><td></td></tr></table>
  <div class="section">Balance</div>
  <table><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr>
  <tr><td>Ingresos totales</td><td class="amt pos">${fmt(ingresos)}</td></tr>
  <tr><td>Gastos fijos</td><td class="amt neg">−${fmt(servicios+superAmt+gastosExtra)}</td></tr>
  <tr><td>Tarjetas pagadas</td><td class="amt neg">−${fmt(tarjetasPagadas)}</td></tr>
  <tr class="total-row"><td>Disponible</td><td class="amt ${disponible>=0?'pos':'neg'}">${fmt(disponible)}</td></tr></table>
  </body></html>`);
  w.document.close();
  // Se imprime desde acá: la ventana nueva hereda la CSP, que no permite scripts inline
  w.onafterprint=()=>w.close();
  setTimeout(()=>{try{w.focus();w.print();}catch(e){}},250);
}

/* ══════════════════════════════════════════════
   PUNTO 5 — DRAG & DROP para reordenar tarjetas
   ══════════════════════════════════════════════ */
let dragSrcIdx=null;
function initDragDrop(){
  const grid=document.getElementById('tarjetas-container');
  grid.addEventListener('dragstart',e=>{
    const unit=e.target.closest('.tcard-unit');
    if(!unit)return;
    dragSrcIdx=Array.from(grid.children).filter(c=>c.classList.contains('tcard-unit')).indexOf(unit);
    unit.classList.add('dragging');
    e.dataTransfer.effectAllowed='move';
  });
  grid.addEventListener('dragend',e=>{
    document.querySelectorAll('.tcard-unit').forEach(u=>u.classList.remove('dragging','drag-over'));
    dragSrcIdx=null;
  });
  grid.addEventListener('dragover',e=>{
    e.preventDefault();
    const unit=e.target.closest('.tcard-unit');
    if(!unit||dragSrcIdx===null)return;
    document.querySelectorAll('.tcard-unit').forEach(u=>u.classList.remove('drag-over'));
    unit.classList.add('drag-over');
  });
  grid.addEventListener('drop',e=>{
    e.preventDefault();
    const unit=e.target.closest('.tcard-unit');
    if(!unit||dragSrcIdx===null)return;
    const units=Array.from(grid.children).filter(c=>c.classList.contains('tcard-unit'));
    const destIdx=units.indexOf(unit);
    if(destIdx<0||destIdx===dragSrcIdx)return;
    const [moved]=state.tarjetas.splice(dragSrcIdx,1);
    state.tarjetas.splice(destIdx,0,moved);
    save();renderTarjetas();
  });
}

/* ── Acciones de la interfaz ────────────────────────────────────────────────
   No hay JavaScript dentro del HTML (onclick="..."): los elementos dicen qué acción quieren con
   data-click / data-change / data-toggle y sus datos van en data-i, data-id, etc. Sólo se ejecutan
   las acciones de esta lista. Así la CSP puede prohibir scripts inline: aunque alguien lograra
   inyectar HTML, no se ejecutaría. */
const ACCIONES={
  click:{
    toggleDrawer:()=>toggleDrawer(), closeDrawer:()=>closeDrawer(),
    changeMonth:el=>changeMonth(Number(el.dataset.arg)), navTo:el=>navTo(el.dataset.arg),
    signIn:()=>signIn(), signOut:()=>signOut(), signOutDrawer:()=>{signOut();closeDrawer();},
    exportResumenPDF:()=>exportResumenPDF(),
    addExtra:()=>addExtra(), removeExtra:el=>removeExtra(+el.dataset.i),
    addTarjeta:()=>addTarjeta(), removeTarjeta:el=>removeTarjeta(+el.dataset.i),
    showHistorialTarjeta:el=>showHistorialTarjeta(+el.dataset.i), closeHist:el=>el.closest('.hist-modal')?.remove(),
    addExtraPago:el=>addExtraPago(+el.dataset.i), removeExtraPago:el=>removeExtraPago(+el.dataset.i,+el.dataset.j),
    pickFile:el=>document.getElementById('upl-'+(+el.dataset.i))?.click(), clearDetalle:el=>clearDetalle(+el.dataset.i),
    addServicio:()=>addServicio(), removeServicio:el=>removeServicio(el.dataset.id),
    openComprobante:el=>openComprobante(el.dataset.id,el.dataset.name,el.dataset.mes),
    verComprobantes:el=>verComprobantes(el.dataset.id,el.dataset.name,el.dataset.mes),
    uploadComprobante:el=>uploadComprobante(el.dataset.id,el.dataset.name,el.dataset.mes),
    closeCompModal:()=>{document.getElementById('comp-modal-area').innerHTML='';},
    addGastoExtra:()=>addGastoExtra(), removeGastoExtra:el=>removeGastoExtra(+el.dataset.i),
  },
  change:{
    setSueldo:el=>{state.sueldo=parseMoney(el.value);save();recalc();},
    setSuper:el=>{state.superAmt=parseMoney(el.value);save();recalc();},
    commitMoney:el=>commitT(+el.dataset.i,el.dataset.f,parseMoney(el.value)),
    commitRaw:el=>commitT(+el.dataset.i,el.dataset.f,el.value),
    renameTarjeta:el=>renameTarjeta(+el.dataset.i,el.value.trim()),
    handleFile:(el,ev)=>handleFile(ev,+el.dataset.i),
    updateServ:el=>updateServ(el.dataset.id,el.value),
  },
  toggle:{tcToggle:el=>tcToggle(el)},
};
const CAMPOS_TARJETA=['total','minimo','pagado','usdTotal','usdMinimo','tcambio'];
for(const tipo of Object.keys(ACCIONES)){
  // toggle no burbujea: se escucha en la fase de captura
  document.addEventListener(tipo,ev=>{
    const el=ev.target instanceof Element?ev.target.closest('[data-'+tipo+']'):null;if(!el)return;
    const nombre=el.getAttribute('data-'+tipo);
    if(!Object.prototype.hasOwnProperty.call(ACCIONES[tipo],nombre))return;
    if(el.dataset.f&&!CAMPOS_TARJETA.includes(el.dataset.f))return;
    ACCIONES[tipo][nombre](el,ev);
  },tipo==='toggle');
}

window.addEventListener('load',init);
