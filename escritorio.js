'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   VERSIÓN DE ESCRITORIO (desde 1024 px)
   Barra superior con pestañas, tema claro/oscuro, Resumen y Análisis propios, y extras de la
   página de Tarjetas. Usa los datos y funciones de app.js (state, calcMes, fmt, esc…).
   Todo el HTML que se arma acá escapa los textos con esc(); los montos salen de fmt() (sólo
   dígitos, $, puntos y signo). Los botones usan el mismo despachador data-click de app.js.
   ════════════════════════════════════════════════════════════════════════════ */
const DK = { pag: 'resumen', hb: null, ha: null, tcF: 'todas', tcQ: '', animKey: '' };
const DK_PAGS = ['resumen', 'ingresos', 'tarjetas', 'servicios', 'gastos', 'analisis'];
const DK_MC = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const dk$ = (id) => document.getElementById(id);
function dkActivo() { return document.body.classList.contains('dk'); }
function dkLeer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function dkGuardar(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
const dkReduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Montos: se pueden ocultar (ojo) y animar al entrar ── */
const DKM = (n) => '<span class="dkm" data-n="' + Math.round(n || 0) + '">' + fmt(n) + '</span>';
function dkPct(v, base) { return base > 0 ? Math.round(v / base * 100) : 0; }
function dkAnimar(raiz) {
  if (dkReduce()) return;
  const els = [...raiz.querySelectorAll('.dkm[data-n]')];
  if (!els.length) return;
  const t0 = performance.now(), ms = 900;
  const paso = (now) => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    els.forEach((el) => { if (el.isConnected) el.textContent = fmt(Number(el.dataset.n) * e); });
    if (k < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
  raiz.classList.remove('dk-entra'); void raiz.offsetWidth; raiz.classList.add('dk-entra');
  clearTimeout(raiz.__dkT); raiz.__dkT = setTimeout(() => raiz.classList.remove('dk-entra'), 1000);
}
function dkOcultar() {
  const on = !document.body.classList.contains('dk-ocultar');
  document.body.classList.toggle('dk-ocultar', on);
  dkGuardar('fin_ocultar', on ? '1' : null);
  document.querySelectorAll('[data-click="dkOcultar"]').forEach((b) => {
    b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Mostrar montos' : 'Ocultar montos');
    b.innerHTML = '<i class="ti ' + (on ? 'ti-eye-off' : 'ti-eye') + '" aria-hidden="true"></i>';
  });
}
if (dkLeer('fin_ocultar') === '1') document.body.classList.add('dk-ocultar');

/* ── Navegación ── */
function dkMostrar(p) {
  if (!DK_PAGS.includes(p)) p = 'resumen';
  DK.pag = p; dkCerrarMenu();
  const dash = p === 'resumen' || p === 'analisis';
  dk$('desktopDashboard').classList.toggle('visible', dash);
  dk$('appContent').style.display = dash ? 'none' : 'block';
  dk$('dkResumen').hidden = p !== 'resumen';
  dk$('dkAnalisis').hidden = p !== 'analisis';
  if (dash) renderDashboard(); else { renderAll(); showTab(p); }
  dkBarra();
  window.scrollTo(0, 0);
}
function dkBarra() {
  const m = dk$('dkMes'); if (m) m.textContent = MESES[curMonth] + ' ' + curYear;
  DK_PAGS.forEach((p) => {
    const b = dk$('dkt-' + p); if (!b) return;
    const on = p === DK.pag; b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const osc = document.documentElement.getAttribute('data-tema') === 'oscuro';
  dk$('dkTemaClaro')?.setAttribute('aria-pressed', String(!osc));
  dk$('dkTemaOscuro')?.setAttribute('aria-pressed', String(osc));
}
// Al cruzar los 1024 px se cambia de versión sin recargar
let dkEraEscritorio = isDesktop();
window.addEventListener('resize', () => {
  clearTimeout(window.__dkRs);
  window.__dkRs = setTimeout(() => {
    const ahora = isDesktop(); if (ahora === dkEraEscritorio) return; dkEraEscritorio = ahora;
    if (!document.body.classList.contains('con-sesion')) return;
    if (ahora) { const v = document.querySelector('.view.active'); DK.pag = v ? v.id.replace('view-', '') : 'resumen'; showApp(); }
    else { showApp(); showTab(DK.pag === 'analisis' ? 'resumen' : DK.pag); }
  }, 150);
});

/* ── Barra: nube, cuenta, avisos, menú ── */
function dkNube(est, late, txt) {
  const n = dk$('dkNube'); if (!n) return;
  const ic = { off: 'ti-cloud-off', ok: 'ti-cloud-check', err: 'ti-cloud-x' }[est] || 'ti-cloud';
  n.className = 'dk-nube ' + est + (late ? ' late' : '');
  n.innerHTML = '<i class="ti ' + ic + '" aria-hidden="true"></i>';
  n.title = txt; n.setAttribute('aria-label', txt);
  const ms = dk$('dkMenuSync'); if (ms) ms.textContent = txt;
}
function dkUsuario() {
  const n = (dk$('driveName')?.textContent || '').trim(), a = dk$('driveAvatar');
  const nb = dk$('dkNombre'); if (nb) nb.textContent = n || 'Tu cuenta';
  const mn = dk$('dkMenuNombre'); if (mn) mn.textContent = n || 'Tu cuenta';
  const av = dk$('dkAv'); if (av && a) { av.textContent = a.textContent || '?'; av.style.background = a.style.background || ''; }
}
function dkBadges(tc, sv) {
  const put = (id, n, txt) => { const b = dk$(id); if (!b) return; b.hidden = !n; b.textContent = n || ''; b.parentElement.setAttribute('aria-label', b.parentElement.textContent.replace(/\d+$/, '').trim() + (n ? ', ' + n + ' ' + txt : '')); };
  put('dkb-tarjetas', tc, tc === 1 ? 'con saldo pendiente' : 'con saldo pendiente');
  put('dkb-servicios', sv, 'sin monto');
}
function dkMenu() {
  const m = dk$('dkMenu'), b = dk$('dkCuentaBtn'); if (!m) return;
  const abrir = m.hidden; m.hidden = !abrir; b.setAttribute('aria-expanded', String(abrir));
  if (abrir) m.querySelector('[role=menuitem]')?.focus();
}
function dkCerrarMenu() { const m = dk$('dkMenu'); if (m && !m.hidden) { m.hidden = true; dk$('dkCuentaBtn')?.setAttribute('aria-expanded', 'false'); } }
document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.dk-cuenta')) dkCerrarMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dk$('dkMenu')?.hidden) { dkCerrarMenu(); dk$('dkCuentaBtn')?.focus(); } });

/* ── Tema claro / oscuro: el nuevo se abre en círculo desde el botón ── */
function dkTema(t, el) {
  t = t === 'oscuro' ? 'oscuro' : 'claro';
  const root = document.documentElement; if (root.getAttribute('data-tema') === t) return;
  const aplicar = () => { root.setAttribute('data-tema', t); dkGuardar('fin_tema', t); dkBarra(); };
  if (!document.startViewTransition || dkReduce() || !el) { aplicar(); return; }
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const fin = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const tr = document.startViewTransition(aplicar);
  tr.ready.then(() => root.animate({ clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + fin + 'px at ' + x + 'px ' + y + 'px)'] },
    { duration: 650, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
}

/* ── Datos ── */
function dkHist(n) { // últimos n meses (el actual al final); trae de Drive los que falten (ddMonthData)
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    let m = curMonth - i, y = curYear; while (m < 0) { m += 12; y--; }
    const d = ddMonthData(y, m), c = d ? calcMes(d) : null, has = !!c && (c.ing > 0 || c.pagos > 0);
    out.push({ y, m, lbl: DK_MC[m], nom: MESES[m], cur: i === 0, has, c, d });
  }
  return out;
}
function dkTarjetas(st) {
  return (st.tarjetas || []).map((t, i) => {
    const total = nv(t.total), pag = nv(t.pagado) + (t.extraPagos || []).reduce((a, p) => a + nv(p.amt), 0);
    const resta = Math.max(0, total - pag);
    const est = total <= 0 ? 'vacia' : pag >= total ? 'saldada' : pag > 0 ? 'parcial' : 'sinpagar';
    return { i, t, nom: ddName(tcName(t, i)), total, pag, resta, est };
  });
}
const DK_EST = { saldada: ['Saldada', 'ok'], parcial: ['Pago parcial', 'warn'], sinpagar: ['Sin pagar', 'bad'], vacia: ['Sin resumen', 'mute'] };
function dkIni(n) { const p = String(n || '').split(/[^0-9A-Za-zÀ-ÿ]+/).filter(Boolean); return (p.length >= 2 ? p[0][0] + p[1][0] : (p[0] || '?').slice(0, 2)).toUpperCase(); }
function dkChip(txt, cls) { return '<span class="dk-chip ' + cls + '">' + esc(txt) + '</span>'; }
function dkIco(ti, cls) { return '<span class="dk-ic ' + (cls || '') + '"><i class="ti ' + ti + '" aria-hidden="true"></i></span>'; }
function dkSmooth(pts) {
  let d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ',' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ',' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
  }
  return d;
}
function dkTope(v) { // escala "redonda" para los ejes
  if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => f <= x + 1e-9)) * e;
}
function dkCorto(n) { const a = Math.abs(n), s = n < 0 ? '−' : ''; return a >= 1e6 ? s + '$' + (a / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' M' : a >= 1e3 ? s + '$' + Math.round(a / 1e3) + ' mil' : s + '$' + Math.round(a); }

/* ════════ RESUMEN y ANÁLISIS ════════ */
function renderDashboard() {
  if (!dk$('desktopDashboard').classList.contains('visible')) return;
  dkUsuario(); dkBarra(); updateDrawerBadges();
  if (DK.pag === 'analisis') dkAnalisis(); else dkResumen();
  const key = DK.pag + curYear + '_' + curMonth, raiz = dk$(DK.pag === 'analisis' ? 'dkAnalisis' : 'dkResumen');
  if (DK.animKey !== key) { DK.animKey = key; dkAnimar(raiz); }
}

function dkResumen() {
  const M = calcMes(state), { ing, tcPag, sv, sup, gx, pagos, disp } = M, otros = sup + gx;
  const H = dkHist(7), prev = H[5], mesNom = MESES[curMonth], mesUp = (mesNom + ' ' + curYear).toUpperCase();
  const pd = dkPct(disp, ing), oculto = document.body.classList.contains('dk-ocultar');
  const tcs = dkTarjetas(state), conResumen = tcs.filter((x) => x.total > 0);
  const resta = tcs.reduce((a, x) => a + x.resta, 0), pend = tcs.filter((x) => x.resta > 0);

  // 1) Disponible
  const est = ing <= 0 && pagos <= 0 ? 'vacio' : disp < 0 ? 'neg' : pd < 15 ? 'warn' : 'ok';
  let linea;
  if (est === 'vacio') linea = 'Cargá tus ingresos y pagos para calcularlo.';
  else if (disp < 0) linea = '<b class="t-bad">Pagaste ' + fmt(-disp) + ' más</b> de lo que entró.';
  else if (ing <= 0) linea = 'Todavía no cargaste ingresos este mes.';
  else {
    linea = '<b class="t-' + (est === 'ok' ? 'ok' : 'warn') + '">' + pd + '% libre</b> de lo que entró';
    if (prev.has && prev.c.ing > 0) {
      const pp = dkPct(prev.c.disp, prev.c.ing), dif = pd - pp;
      linea += dif === 0 ? ' · igual que ' + esc(prev.nom.toLowerCase()) + '.' : ' · ' + (dif > 0 ? 'mejor' : 'peor') + ' que ' + esc(prev.nom.toLowerCase()) + ' (' + pp + '%).';
    } else linea += '.';
  }
  // Cuadritos: % libre de los últimos 7 meses (cada cuadrito ≈ 6 puntos, máximo 5)
  let sq = '';
  H.forEach((h, ci) => {
    const x = 4 + ci * 23;
    if (!h.has || h.c.ing <= 0) { sq += '<rect x="' + x + '" y="96" width="20" height="20" rx="4" class="q-0"></rect>'; }
    else {
      const p = h.c.disp / h.c.ing, n = p <= 0 ? 0 : Math.min(5, Math.max(1, Math.round(p * 100 / 6)));
      if (!n) sq += '<rect x="' + x + '" y="96" width="20" height="20" rx="4" class="q-neg"></rect>';
      for (let r = 0; r < n; r++) sq += '<rect x="' + x + '" y="' + (96 - r * 23) + '" width="20" height="20" rx="4" class="' + (h.cur ? (r === n - 1 ? 'q-l' : 'q-b4') : 'q-b' + Math.min(3, r + 1)) + '"></rect>';
    }
    sq += '<text x="' + (x + 10) + '" y="132" text-anchor="middle" class="tx-s' + (h.cur ? ' on' : '') + '">' + h.lbl[0] + '</text>';
  });
  const sqAria = 'Porcentaje libre por mes: ' + H.map((h) => h.nom + ' ' + (h.has && h.c.ing > 0 ? dkPct(h.c.disp, h.c.ing) + '%' : 'sin datos')).join(', ');
  const hero = '<section class="dk-card dk-hero ' + est + '" aria-label="' + (disp < 0 ? 'Déficit' : 'Disponible') + ' del mes">'
    + '<div class="dk-h">' + dkIco('ti-wallet', 'blue') + '<h2>' + (disp < 0 ? 'Déficit del mes' : 'Disponible del mes') + '</h2>'
    + '<span class="dk-pill">' + esc(mesUp) + '</span>'
    + '<button class="dk-ibtn" data-click="dkOcultar" aria-pressed="' + oculto + '" aria-label="' + (oculto ? 'Mostrar montos' : 'Ocultar montos') + '"><i class="ti ' + (oculto ? 'ti-eye-off' : 'ti-eye') + '" aria-hidden="true"></i></button></div>'
    + '<div class="dk-hero-mid"><div class="dk-hero-num"><div class="dk-big">' + DKM(disp) + '</div><p class="dk-linea">' + linea + '</p></div>'
    + '<svg class="dk-sq" width="166" height="138" viewBox="0 0 166 138" role="img" aria-label="' + esc(sqAria) + '">' + sq + '</svg></div>'
    + '<div class="dk-acciones"><button class="dk-btn primary" data-click="dkAgregarGasto"><i class="ti ti-plus" aria-hidden="true"></i>Agregar gasto</button>'
    + '<button class="dk-btn inv" data-click="exportResumenPDF"><i class="ti ti-file-export" aria-hidden="true"></i>Exportar resumen</button>'
    + '<button class="dk-btn soft" data-click="dkIr" data-arg="tarjetas"><i class="ti ti-file-upload" aria-hidden="true"></i>Cargar resumen de tarjeta</button></div></section>';

  // 2) Ingresos
  const sueldo = nv(state.sueldo), extras = (state.extras || []).reduce((a, e) => a + nv(e.amt), 0);
  let ingChip = '', ingTxt = 'Sueldo' + (extras > 0 ? ' más ingresos extra.' : '.');
  if (ing > 0 && prev.has && prev.c.ing > 0) {
    const d = ing - prev.c.ing, p = Math.round(d / prev.c.ing * 1000) / 10;
    ingChip = d === 0 ? dkChip('Igual que ' + prev.lbl.toLowerCase(), 'mute') : dkChip((d > 0 ? '+' : '−') + fmt(Math.abs(d)).replace('−', ''), d > 0 ? 'ok' : 'bad');
    ingTxt = d === 0 ? 'Igual que en ' + esc(prev.nom.toLowerCase()) + '.' : (d > 0 ? 'Subieron ' : 'Bajaron ') + '<b class="t-' + (d > 0 ? 'ok' : 'bad') + '">' + String(Math.abs(p)).replace('.', ',') + '%</b> respecto de ' + esc(prev.nom.toLowerCase()) + '.';
  } else if (ing <= 0) ingTxt = 'Todavía no cargaste ingresos.';
  const cIng = '<section class="dk-card" aria-label="Ingresos">'
    + '<div class="dk-h">' + dkIco('ti-arrow-down', 'green solid') + '<h2>Ingresos</h2><span class="dk-pill">' + esc(DK_MC[curMonth].toUpperCase() + ' ' + curYear) + '</span></div>'
    + '<div class="dk-mid">' + DKM(ing) + ingChip + '</div>'
    + '<p class="dk-nota">' + ingTxt + '</p>'
    + '<div class="dk-split"><div class="b-blue"><span>Sueldo</span><b>' + DKM(sueldo) + '</b></div><div class="b-lime"><span>Extras</span><b>' + DKM(extras) + '</b></div></div>'
    + '<button class="dk-link" data-click="dkIr" data-arg="ingresos">Ver ingresos</button></section>';

  // 3) Tarjetas por pagar
  const base = conResumen.reduce((a, x) => a + x.total, 0);
  const sPag = conResumen.reduce((a, x) => a + Math.min(x.pag, x.total), 0);
  const sParc = tcs.filter((x) => x.est === 'parcial').reduce((a, x) => a + x.resta, 0);
  const sSin = tcs.filter((x) => x.est === 'sinpagar').reduce((a, x) => a + x.resta, 0);
  let tcBody;
  if (base <= 0) tcBody = '<p class="dk-nota">Cargá el total de cada resumen para ver cuánto falta pagar.</p>';
  else {
    const w = (v) => (v / base * 100).toFixed(2);
    const destaca = sParc >= sSin && sParc > 0 ? { l: sPag, v: sParc, c: 'blue' } : sSin > 0 ? { l: sPag + sParc, v: sSin, c: 'lime' } : null;
    tcBody = '<div class="dk-seg">'
      + (destaca ? '<div class="dk-seg-hi ' + destaca.c + '" style="left:' + w(destaca.l) + '%;width:' + w(destaca.v) + '%"></div><span class="dk-seg-tag ' + destaca.c + '" style="left:' + Math.min(84, Math.max(16, (destaca.l + destaca.v / 2) / base * 100)).toFixed(1) + '%">' + DKM(destaca.v) + '</span>' : '')
      + '<div class="dk-seg-bar"><span class="s-ink" style="width:' + w(sPag) + '%"></span><span class="s-blue" style="width:' + w(sParc) + '%"></span><span class="s-lime" style="width:' + w(sSin) + '%"></span></div></div>'
      + '<div class="dk-ley"><span><i class="s-ink"></i>Pagado</span><span><i class="s-blue"></i>Resto de pagos parciales</span><span><i class="s-lime"></i>Sin pagar</span></div>';
  }
  const tcEstado = base <= 0 ? '' : pend.length ? '<div class="dk-estado"><span class="dot bad"></span><b class="t-bad">' + pend.length + (pend.length === 1 ? ' tarjeta' : ' tarjetas') + ' con saldo</b></div><p class="dk-nota sm">' + esc(pend.map((x) => x.nom).join(' · ')) + '</p>'
    : '<div class="dk-estado"><span class="dot ok"></span><b class="t-ok">Todo saldado</b></div>';
  const cTc = '<section class="dk-card" aria-label="Tarjetas por pagar">'
    + '<div class="dk-h">' + dkIco('ti-arrow-up', 'red solid') + '<h2>Tarjetas por pagar</h2></div>'
    + '<div class="dk-mid">' + DKM(resta) + '</div>' + tcEstado + tcBody
    + '<button class="dk-link" data-click="dkIr" data-arg="tarjetas">Ver tarjetas</button></section>';

  // 4) Gastado del mes (medidor) y en qué
  const f = ing > 0 ? Math.min(1, pagos / ing) : pagos > 0 ? 1 : 0, cx = 110, cy = 104, R = 82;
  const pt = (deg) => [cx + R * Math.cos(deg * Math.PI / 180), cy - R * Math.sin(deg * Math.PI / 180)];
  const a0 = pt(225), a1 = pt(-45), kk = pt(225 - 270 * f), arco = 'M' + a0[0].toFixed(1) + ',' + a0[1].toFixed(1) + ' A' + R + ',' + R + ' 0 1 1 ' + a1[0].toFixed(1) + ',' + a1[1].toFixed(1);
  const pctG = ing > 0 ? Math.round(pagos / ing * 100) : 0;
  const filas = [['Tarjetas pagadas', tcPag, 'blue'], ['Servicios', sv, 'lime'], ['Súper', sup, 'ink'], ['Gastos extra', gx, 'amber']].map((r) =>
    '<div class="dk-fila"><div class="dk-fila-t"><span>' + r[0] + '</span><span><b>' + DKM(r[1]) + '</b>' + (ing > 0 ? ' · ' + dkPct(r[1], ing) + '%' : '') + '</span></div><div class="dk-track"><div class="f-' + r[2] + '" style="width:' + (ing > 0 ? Math.min(100, r[1] / ing * 100) : 0).toFixed(1) + '%"></div></div></div>').join('');
  const cGauge = '<section class="dk-card" aria-label="Gastado del mes">'
    + '<div class="dk-h">' + dkIco('ti-target', 'blue') + '<h2>Gastado del mes</h2></div>'
    + '<div class="dk-dark"><div class="dk-dark-h"><span>Pagos de ' + esc(mesNom.toLowerCase()) + '</span><span class="dk-dark-pill">' + (ing > 0 ? pctG + '% de lo que entró' : 'Sin ingresos') + '</span></div>'
    + '<div class="dk-gauge"><svg width="220" height="196" viewBox="0 0 220 196" role="img" aria-label="' + (ing > 0 ? 'Pagaste el ' + pctG + '% de lo que entró' : 'Sin ingresos cargados') + '">'
    + '<path d="' + arco + '" class="g-track"></path><path d="' + arco + '" class="g-val' + (pagos > ing && ing > 0 ? ' over' : '') + '" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="' + (100 - f * 100).toFixed(2) + '"></path>'
    + '<circle cx="' + kk[0].toFixed(1) + '" cy="' + kk[1].toFixed(1) + '" r="9" class="g-knob"></circle></svg>'
    + '<div class="dk-gauge-c"><span>Pagado</span><b>' + DKM(pagos) + '</b><span>de ' + DKM(ing) + '</span></div></div></div>'
    + filas + '</section>';

  // 5) Pagos por mes (6 meses)
  const cBars = '<section class="dk-card" aria-label="Pagos por mes"><div class="dk-h">' + dkIco('ti-chart-bar', 'blue') + '<h2>Pagos por mes</h2><span class="dk-pill">6 MESES</span></div>'
    + '<div class="dk-ley"><span><i class="s-blue"></i>Tarjetas</span><span><i class="s-lime"></i>Servicios, súper y extras</span></div>'
    + '<div id="dkBars">' + dkBarras(H.slice(1)) + '</div></section>';

  // 6) Columna derecha: bot, pendientes, exportar
  const sinMonto = (state.servicios || []).filter((s) => !nv(s.amt));
  const nPend = pend.length + sinMonto.length;
  const tip = dkLeer('fin_dk_tip_bot') === '0' ? '' : '<section class="dk-card dk-tip" aria-label="Bot de Telegram"><svg class="dk-tip-deco" width="260" height="160" viewBox="0 0 260 160" aria-hidden="true"><path d="M40 160L160 0h40L80 160zM110 160L230 0h22L132 160z"></path></svg>'
    + '<div class="dk-tip-h"><button class="dk-ibtn sm" data-click="dkCerrarTip" aria-label="No mostrar más"><i class="ti ti-x" aria-hidden="true"></i></button></div>'
    + '<span class="dk-chip blue-solid">Bot de Telegram</span><div class="dk-tip-t">Cargá gastos desde el chat</div>'
    + '<p class="dk-nota">Escribí <b>/gasto 4500 café</b> o <b>/tarjeta visa 50000</b> y aparece acá. <b>/resumen</b> te manda el mes.</p></section>';
  const lp = pend.map((x) => '<li><span class="dk-av sm" style="background:' + avatarColor(x.nom) + '" aria-hidden="true">' + esc(dkIni(x.nom)) + '</span><span class="n">' + esc(x.nom) + '</span><b>' + DKM(x.resta) + '</b>' + dkChip(DK_EST[x.est][0], DK_EST[x.est][1]) + '</li>')
    .concat(sinMonto.map((x) => '<li><span class="dk-av sm" style="background:' + avatarColor(ddName(x.name)) + '" aria-hidden="true">' + esc(dkIni(x.name)) + '</span><span class="n">' + esc(ddName(x.name)) + '</span><b class="t-mute">—</b>' + dkChip('Sin monto', 'warn') + '</li>'));
  const cPend = '<section class="dk-card dk-pend" aria-label="Pendientes"><div class="dk-h">' + dkIco('ti-clock-exclamation', nPend ? 'red' : 'green') + '<h2>Pendientes</h2>' + (resta > 0 ? dkChip(fmt(resta), 'bad') : '') + '</div>'
    + (nPend ? '<ul class="dk-pend-l">' + lp.slice(0, 5).join('') + '</ul>' + (lp.length > 5 ? '<p class="dk-nota sm">Y ' + (lp.length - 5) + ' más.</p>' : '')
      : '<p class="dk-ok"><i class="ti ti-circle-check" aria-hidden="true"></i>Todo al día: tarjetas saldadas y servicios con monto.</p>')
    + '<div class="dk-pend-f">' + (pend.length ? '<button class="dk-btn line sm" data-click="dkIr" data-arg="tarjetas">Ver tarjetas</button>' : '') + (sinMonto.length ? '<button class="dk-btn line sm" data-click="dkIr" data-arg="servicios">Ver servicios</button>' : '') + '</div></section>';
  const cDer = '<div class="dk-col">' + tip + cPend + '</div>';

  // 7) Pagos del mes (tabla) y mayores pagos
  const filasT = [];
  tcs.filter((x) => x.total > 0 || x.pag > 0).forEach((x) => filasT.push({ c: x.nom, sub: x.total > 0 ? 'Resumen de ' + fmt(x.total) : '', tipo: ['Tarjeta', 'blue'], est: DK_EST[x.est], comp: '', m: x.pag }));
  (state.servicios || []).forEach((s) => {
    const n = compCount(s.name), a = nv(s.amt);
    filasT.push({ c: ddName(s.name), sub: '', tipo: ['Servicio', 'lime'], est: a > 0 ? ['Pagado', 'ok'] : ['Sin monto', 'warn'], comp: n === null ? '<span class="t-mute">—</span>' : n > 0 ? '<span class="t-ok"><i class="ti ti-check" aria-hidden="true"></i> ' + n + '</span>' : '<span class="t-bad">Falta</span>', m: a, sinM: !a });
  });
  if (sup > 0) filasT.push({ c: 'Súper / Mercado', sub: '', tipo: ['Súper', 'mute'], est: ['Pagado', 'ok'], comp: '', m: sup });
  (state.gastosExtra || []).forEach((g) => filasT.push({ c: ddName(g.name), sub: g.fecha ? String(g.fecha).slice(8, 10) + '/' + String(g.fecha).slice(5, 7) : '', tipo: ['Extra', 'warn'], est: ['Pagado', 'ok'], comp: '', m: nv(g.amt) }));
  const tabla = !filasT.length ? '<p class="dk-vacio">Todavía no hay pagos cargados en ' + esc(mesNom.toLowerCase()) + '.</p>'
    : '<div class="dk-tabla-w"><table class="dk-tabla"><thead><tr><th scope="col">Concepto</th><th scope="col">Tipo</th><th scope="col">Estado</th><th scope="col">Comprobante</th><th scope="col" class="r">Pagado</th></tr></thead><tbody>'
      + filasT.map((r) => '<tr><td><b>' + esc(r.c) + '</b>' + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</td><td>' + dkChip(r.tipo[0], r.tipo[1]) + '</td><td>' + dkChip(r.est[0], r.est[1]) + '</td><td>' + (r.comp || '') + '</td><td class="r"><b>' + (r.sinM ? '<span class="t-mute">—</span>' : DKM(r.m)) + '</b></td></tr>').join('')
      + '</tbody></table></div>';
  const cTabla = '<section class="dk-card" aria-label="Pagos del mes"><div class="dk-h">' + dkIco('ti-list-details', 'blue') + '<h2>Pagos de ' + esc(mesNom.toLowerCase()) + '</h2><button class="dk-btn line sm" data-click="dkIr" data-arg="servicios">Servicios</button><button class="dk-btn line sm" data-click="dkIr" data-arg="gastos">Gastos</button></div>' + tabla + '</section>';
  const ck = curYear + '-' + curMonth;
  if (accessToken && DK.compKey !== ck) { DK.compKey = ck; loadCompCounts().then(() => { if (DK.pag === 'resumen' && dkActivo()) renderDashboard(); }).catch(() => {}); }
  dk$('dkResumen').innerHTML = '<div class="dk-grid r1">' + hero + cIng + cTc + '</div>'
    + '<div class="dk-grid r2">' + cGauge + cBars + cDer + '</div>'
    + '<div class="dk-grid r3">' + cTabla + dkMayores(tcs, sup) + '</div>';
}

function dkMayores(tcs, sup) {
  const items = [];
  tcs.forEach((x) => { if (x.pag > 0) items.push([x.nom, x.pag]); });
  (state.servicios || []).forEach((s) => { if (nv(s.amt) > 0) items.push([ddName(s.name), nv(s.amt)]); });
  if (sup > 0) items.push(['Súper / Mercado', sup]);
  (state.gastosExtra || []).forEach((g) => { if (nv(g.amt) > 0) items.push([ddName(g.name), nv(g.amt)]); });
  items.sort((a, b) => b[1] - a[1]);
  const top = items.slice(0, 6), max = top.length ? top[0][1] : 1;
  return '<section class="dk-card" aria-label="Mayores pagos"><div class="dk-h">' + dkIco('ti-diamond', 'blue') + '<div><h2>Mayores pagos</h2><p class="dk-sub">Lo que más pesó este mes</p></div></div>'
    + (!top.length ? '<p class="dk-vacio">Sin pagos cargados.</p>' : top.map((r, i) => '<div class="dk-top"><div class="dk-top-h"><span class="dk-av sm" style="background:' + avatarColor(r[0]) + '" aria-hidden="true">' + esc(dkIni(r[0])) + '</span><span class="dk-top-n">' + esc(r[0]) + '</span><b>' + DKM(r[1]) + '</b></div><div class="dk-track thin"><div class="' + (i === 0 ? 'f-ink' : 'f-blue') + '" style="width:' + (r[1] / max * 100).toFixed(1) + '%"></div></div></div>').join(''))
    + '</section>';
}

function dkBarras(H) { // H: 6 meses, el último es el actual
  if (!H.some((h) => h.has)) return '<p class="dk-vacio alto">Todavía no hay meses con pagos cargados.</p>';
  const hi = DK.hb !== null && H[DK.hb] && H[DK.hb].has ? DK.hb : H.length - 1;
  const val = (h) => h.has ? { tc: h.c.tcPag, sv: h.c.sv + h.c.sup + h.c.gx } : { tc: 0, sv: 0 };
  const max = dkTope(Math.max(1, ...H.map((h) => { const v = val(h); return v.tc + v.sv; })) * 1.08);
  const W = 480, B0 = 270, BH = 200, y = (v) => B0 - BH * v / max, BW = 52, PASO = (W - 24) / 6, bx = (i) => 12 + i * PASO + (PASO - BW) / 2;
  let s = '';
  const h0 = H[hi], v0 = val(h0), top0 = y(v0.tc + v0.sv), x0 = bx(hi);
  if (h0.has) s += '<line x1="4" x2="' + (x0 + BW / 2).toFixed(1) + '" y1="' + top0.toFixed(1) + '" y2="' + top0.toFixed(1) + '" class="l-dash"></line>';
  H.forEach((h, i) => {
    const x = bx(i), v = val(h), tot = v.tc + v.sv;
    if (!h.has) s += '<rect x="' + x.toFixed(1) + '" y="' + (B0 - 40) + '" width="' + BW + '" height="40" rx="18" class="b-nd"></rect>';
    else if (i !== hi) { const hh = Math.max(40, B0 - y(tot)); s += '<rect x="' + x.toFixed(1) + '" y="' + (B0 - hh).toFixed(1) + '" width="' + BW + '" height="' + hh.toFixed(1) + '" rx="18" class="b-bg"></rect>'; }
    else {
      const hh = Math.max(40, B0 - y(tot)), hs = v.sv > 0 ? Math.max(36, B0 - y(v.sv)) : 0;
      s += '<rect x="' + x.toFixed(1) + '" y="' + (B0 - hh).toFixed(1) + '" width="' + BW + '" height="' + hh.toFixed(1) + '" rx="18" class="b-tc"></rect>';
      if (hs > 0) s += '<rect x="' + x.toFixed(1) + '" y="' + (B0 - hs).toFixed(1) + '" width="' + BW + '" height="' + hs.toFixed(1) + '" rx="18" class="b-sv"></rect>';
    }
    s += '<text x="' + (x + BW / 2).toFixed(1) + '" y="294" text-anchor="middle" class="tx-m' + (i === hi ? ' on' : '') + '">' + h.lbl + '</text>';
    s += '<rect x="' + (12 + i * PASO).toFixed(1) + '" y="20" width="' + PASO.toFixed(1) + '" height="262" class="hit" data-dk-bar="' + i + '" tabindex="0" role="img" aria-label="' + esc(h.nom + ' ' + h.y + (h.has ? ': tarjetas ' + fmt(v.tc) + ', servicios y gastos ' + fmt(v.sv) : ': sin datos')) + '"></rect>';
  });
  if (h0.has) {
    s += '<circle cx="' + (x0 + BW / 2).toFixed(1) + '" cy="' + top0.toFixed(1) + '" r="7" class="knob"></circle>';
    const TW = 212, tx = hi >= 3 ? Math.max(2, x0 - TW - 10) : Math.min(W - TW - 2, x0 + BW + 10), ty = Math.max(4, Math.min(top0 - 50, 150)), tt = h0.nom + ' ' + h0.y + (h0.cur ? ' · en curso' : '');
    s += '<g class="tip"><rect x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '" width="' + TW + '" height="96" rx="14" class="tip-bg"></rect>'
      + '<text x="' + (tx + 14).toFixed(1) + '" y="' + (ty + 24).toFixed(1) + '" class="tip-t">' + esc(tt) + '</text>'
      + '<circle cx="' + (tx + 18).toFixed(1) + '" cy="' + (ty + 50).toFixed(1) + '" r="4" class="d-blue"></circle><text x="' + (tx + 28).toFixed(1) + '" y="' + (ty + 54).toFixed(1) + '" class="tip-l">Tarjetas</text><text x="' + (tx + TW - 14).toFixed(1) + '" y="' + (ty + 54).toFixed(1) + '" text-anchor="end" class="tip-v dkm">' + fmt(v0.tc) + '</text>'
      + '<circle cx="' + (tx + 18).toFixed(1) + '" cy="' + (ty + 74).toFixed(1) + '" r="4" class="d-lime"></circle><text x="' + (tx + 28).toFixed(1) + '" y="' + (ty + 78).toFixed(1) + '" class="tip-l">Servicios y otros</text><text x="' + (tx + TW - 14).toFixed(1) + '" y="' + (ty + 78).toFixed(1) + '" text-anchor="end" class="tip-v dkm">' + fmt(v0.sv) + '</text></g>';
  }
  return '<svg class="dk-bars" viewBox="0 0 ' + W + ' 300" role="group" aria-label="Pagos por mes de los últimos 6 meses">' + s + '</svg>';
}

function dkAnalisis() {
  const M = calcMes(state), { ing, tcPag, sv, sup, gx, pagos, disp } = M;
  const H = dkHist(6), prev = H[4], mesNom = MESES[curMonth];
  const P = prev.has ? prev.c : null;
  const delta = (a, b, fmtF, invert) => { if (b === null || b === undefined) return ''; const d = a - b; if (Math.abs(d) < 0.05) return '<span class="t-mute">=</span>'; const bueno = invert ? d < 0 : d > 0; return '<span class="t-' + (bueno ? 'ok' : 'bad') + '">' + (d > 0 ? '▲ ' : '▼ ') + fmtF(Math.abs(d)) + '</span>'; };
  const pctTxt = (v) => String(Math.round(v * 10) / 10).replace('.', ',') + '%';
  const libre = ing > 0 ? disp / ing * 100 : null, libreP = P && P.ing > 0 ? P.disp / P.ing * 100 : null;
  const sinPrev = 'Sin datos de ' + esc(prev.nom.toLowerCase()) + ' para comparar';
  const k1 = '<article class="dk-card dk-kpi blue"><svg class="dk-kpi-deco" width="120" height="110" viewBox="0 0 120 110" aria-hidden="true"><path d="M30 110C40 60 70 25 110 12c-6 40-34 78-70 98z"></path></svg>'
    + '<div class="dk-kpi-h">' + dkIco('ti-receipt', 'onblue') + (P ? delta(pagos, P.pagos, (x) => dkPct(x, P.pagos || 1) + '%', true) : '') + '</div><b class="dk-kpi-v">' + DKM(pagos) + '</b><span>Pagado en ' + esc(mesNom.toLowerCase()) + (ing > 0 ? ' · ' + dkPct(pagos, ing) + '% de lo que entró' : '') + '</span></article>';
  const k2 = '<article class="dk-card dk-kpi"><div class="dk-kpi-h">' + dkIco('ti-arrow-down', 'soft') + (P && P.ing > 0 ? delta(ing, P.ing, (x) => pctTxt(x / P.ing * 100)) : '') + '</div><b class="dk-kpi-v">' + DKM(ing) + '</b><span>' + (P ? 'Ingresos · ' + esc(prev.nom.toLowerCase()) + ': ' + fmt(P.ing) : sinPrev) + '</span></article>';
  const k3 = '<article class="dk-card dk-kpi"><div class="dk-kpi-h">' + dkIco('ti-chart-pie', 'soft') + (libre !== null && libreP !== null ? delta(libre, libreP, (x) => String(Math.round(x * 10) / 10).replace('.', ',') + ' pts') : '') + '</div><b class="dk-kpi-v">' + (libre === null ? '—' : pctTxt(libre)) + '</b><span>Libre de lo que entró' + (libreP !== null ? ' · antes ' + pctTxt(libreP) : '') + '</span></article>';
  const k4 = '<article class="dk-card dk-kpi"><div class="dk-kpi-h">' + dkIco('ti-arrows-diff', 'soft') + '</div><b class="dk-kpi-v">' + (P ? DKM(disp - P.disp) : '—') + '</b><span>' + (P ? 'Disponible frente a ' + esc(prev.nom.toLowerCase()) + ' (' + fmt(P.disp) + ')' : sinPrev) + '</span></article>';

  // Disponible por mes (línea)
  const cLinea = '<section class="dk-card" aria-label="Disponible por mes"><div class="dk-h">' + dkIco('ti-trending-up', 'blue') + '<div><h2>Disponible por mes</h2><p class="dk-sub">Lo que quedó libre cada mes</p></div>'
    + '<div class="dk-ley right"><span><i class="s-blue"></i>Disponible</span><span><i class="s-ink line"></i>Ingresos</span></div></div><div id="dkLinea">' + dkLinea(H) + '</div></section>';

  // En qué se fue
  const cats = [['Tarjetas', tcPag, 'blue'], ['Servicios', sv, 'lime'], ['Súper', sup, 'ink'], ['Gastos extra', gx, 'amber']];
  let acc = 0, dona = '';
  const pcts = cats.map((c) => pagos > 0 ? c[1] / pagos * 100 : 0);
  cats.forEach((c, i) => { const len = Math.max(0, pcts[i] - (pcts[i] > 1.5 ? 1 : 0)); if (len > 0) dona += '<circle cx="68" cy="68" r="52" class="dn-' + c[2] + '" pathLength="100" stroke-dasharray="' + len.toFixed(2) + ' ' + (100 - len).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 68 68)"></circle>'; acc += pcts[i]; });
  const mayor = cats.map((c, i) => [c[0], pcts[i]]).sort((a, b) => b[1] - a[1])[0];
  const cDona = '<section class="dk-card" aria-label="En qué se fue"><div class="dk-h">' + dkIco('ti-chart-donut', 'blue') + '<div><h2>En qué se fue</h2><p class="dk-sub">Lo pagado en ' + esc(mesNom.toLowerCase()) + '</p></div></div>'
    + (pagos <= 0 ? '<p class="dk-vacio">Sin pagos cargados.</p>' : '<div class="dk-dona-w"><div class="dk-dona"><svg width="136" height="136" viewBox="0 0 136 136" role="img" aria-label="' + esc(cats.map((c, i) => c[0] + ' ' + Math.round(pcts[i]) + '%').join(', ')) + '"><circle cx="68" cy="68" r="52" class="dn-bg"></circle>' + dona + '</svg><div class="dk-dona-c"><b>' + Math.round(mayor[1]) + '%</b><span>' + esc(mayor[0].toLowerCase()) + '</span></div></div>'
      + '<div class="dk-dona-l">' + cats.map((c, i) => '<div><i class="s-' + c[2] + '"></i><span>' + c[0] + '</span><b>' + pctTxt(pcts[i]) + '</b><small class="dkm">' + fmt(c[1]) + '</small></div>').join('') + '</div></div>')
    + '</section>';

  // Del ingreso a lo libre
  const pasos = [['Ingresos', ing], ['− Servicios', ing - sv], ['− Tarjetas', ing - sv - tcPag], ['− Súper y extras', disp]];
  const cEmbudo = '<section class="dk-card" aria-label="Del ingreso a lo libre"><div class="dk-h">' + dkIco('ti-filter', 'blue') + '<div><h2>Del ingreso a lo libre</h2><p class="dk-sub">Qué queda después de cada bloque</p></div><div class="dk-h-r"><small>Libre</small><b class="' + (disp < 0 ? 't-bad' : '') + '">' + (libre === null ? '—' : pctTxt(libre)) + '</b></div></div>'
    + (ing <= 0 ? '<p class="dk-vacio">Cargá tus ingresos para ver el recorrido.</p>' : pasos.map((p, i) => { const w = Math.max(0, Math.min(100, p[1] / ing * 100)); return '<div class="dk-emb"><span>' + p[0] + '</span><div class="dk-emb-t"><div class="' + (p[1] < 0 ? 'f-red' : i === 3 ? 'f-lime' : 'f-blue') + '" style="width:' + (p[1] < 0 ? 100 : w).toFixed(1) + '%"><b class="dkm">' + fmt(p[1]) + '</b></div></div></div>'; }).join(''))
    + '</section>';

  const cComp = '<section class="dk-card dk-comp" aria-label="Comparación con el mes anterior"><div class="dk-h">' + dkIco('ti-arrows-left-right', 'blue') + '<h2>Comparación con ' + esc(prev.nom.toLowerCase()) + '</h2><div class="comp-months" id="dkcomp-month-labels"></div></div><div id="dkcomp-content"></div></section>';
  dk$('dkAnalisis').innerHTML = '<div class="dk-head"><div><h1>Análisis</h1><p>Cómo viene ' + esc(mesNom.toLowerCase()) + ' comparado con los meses anteriores</p></div><button class="dk-btn line" data-click="exportResumenPDF"><i class="ti ti-file-export" aria-hidden="true"></i>Exportar resumen</button></div>'
    + '<div class="dk-grid k4">' + k1 + k2 + k3 + k4 + '</div>'
    + '<div class="dk-grid a2">' + cLinea + cDona + '</div>'
    + '<div class="dk-grid a3">' + cEmbudo + cComp + '</div>';
  renderComparacion('dkcomp');
}

function dkLinea(H) {
  const pts = H.map((h, i) => ({ i, h, d: h.has ? h.c.disp : null, g: h.has ? h.c.ing : null }));
  const con = pts.filter((p) => p.d !== null);
  if (con.length < 2) return '<p class="dk-vacio alto">El historial aparece a medida que cargás meses: hace falta al menos un mes anterior con datos.</p>';
  const hi = DK.ha !== null && pts[DK.ha] && pts[DK.ha].d !== null ? DK.ha : con[con.length - 1].i;
  const maxR = Math.max(...con.map((p) => Math.max(p.d, p.g))), minR = Math.min(0, ...con.map((p) => p.d));
  const paso = dkTope((maxR - minR) / 4), minE = Math.floor(minR / paso) * paso, maxV = Math.max(minE + paso, Math.ceil(maxR * 1.02 / paso) * paso);
  const Y0 = 236, HH = 216, y = (v) => Y0 - HH * (v - minE) / (maxV - minE), x = (i) => 70 + i * (590 / (H.length - 1));
  let s = '';
  for (let v = minE; v <= maxV + paso / 2; v += paso) { const yy = y(v); s += '<line x1="62" x2="664" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '" class="l-grid"></line><text x="54" y="' + (yy + 4).toFixed(1) + '" text-anchor="end" class="tx-s">' + dkCorto(v) + '</text>'; }
  if (minE < 0) s += '<line x1="62" x2="664" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" class="l-zero"></line>';
  H.forEach((h, i) => { s += '<text x="' + x(i).toFixed(1) + '" y="268" text-anchor="middle" class="tx-m' + (i === hi ? ' on' : '') + '">' + h.lbl + '</text>'; });
  const pd = con.map((p) => [x(p.i), y(p.d)]), pg = con.map((p) => [x(p.i), y(p.g)]);
  const linea = dkSmooth(pd);
  s += '<path d="' + linea + ' L' + pd[pd.length - 1][0].toFixed(1) + ',' + y(Math.max(0, minE)).toFixed(1) + ' L' + pd[0][0].toFixed(1) + ',' + y(Math.max(0, minE)).toFixed(1) + ' Z" class="a-blue"></path>';
  s += '<path d="' + dkSmooth(pg) + '" class="l-ing"></path><path d="' + linea + '" class="l-blue"></path>';
  const p0 = pts[hi], tx = x(hi), ty = y(p0.d), bx = Math.max(64, Math.min(664 - 176, tx - 88)), by = ty - 92 < 4 ? ty + 16 : ty - 92;
  s += '<line x1="' + tx.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y1="' + ty.toFixed(1) + '" y2="' + Y0 + '" class="l-v"></line><circle cx="' + tx.toFixed(1) + '" cy="' + ty.toFixed(1) + '" r="6" class="knob"></circle>';
  s += '<g class="tip dark"><rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="176" height="78" rx="12" class="tip-bg"></rect>'
    + '<text x="' + (bx + 14).toFixed(1) + '" y="' + (by + 22).toFixed(1) + '" class="tip-t">' + esc(p0.h.nom + ' ' + p0.h.y) + '</text>'
    + '<text x="' + (bx + 14).toFixed(1) + '" y="' + (by + 44).toFixed(1) + '" class="tip-l">Disponible</text><text x="' + (bx + 162).toFixed(1) + '" y="' + (by + 44).toFixed(1) + '" text-anchor="end" class="tip-v dkm">' + fmt(p0.d) + '</text>'
    + '<text x="' + (bx + 14).toFixed(1) + '" y="' + (by + 64).toFixed(1) + '" class="tip-l">Ingresos</text><text x="' + (bx + 162).toFixed(1) + '" y="' + (by + 64).toFixed(1) + '" text-anchor="end" class="tip-v dkm">' + fmt(p0.g) + '</text></g>';
  pts.forEach((p) => { s += '<rect x="' + (x(p.i) - 49).toFixed(1) + '" y="8" width="98" height="240" class="hit" data-dk-pt="' + p.i + '" tabindex="0" role="img" aria-label="' + esc(p.h.nom + ' ' + p.h.y + (p.d !== null ? ': disponible ' + fmt(p.d) + ', ingresos ' + fmt(p.g) : ': sin datos')) + '"></rect>'; });
  return '<svg class="dk-linea" viewBox="0 0 680 280" role="group" aria-label="Disponible e ingresos de los últimos 6 meses">' + s + '</svg>';
}

// Pasar el mouse (o el foco) por los gráficos muestra el detalle de ese mes
function dkHover(e) {
  const t = e.target; if (!t || !t.getAttribute) return;
  const b = t.getAttribute('data-dk-bar'), p = t.getAttribute('data-dk-pt');
  if (b !== null && +b !== DK.hb) { DK.hb = +b; const c = dk$('dkBars'); if (c) c.innerHTML = dkBarras(dkHist(7).slice(1)); dkReenfocar(c, 'data-dk-bar', b, e); }
  if (p !== null && +p !== DK.ha) { DK.ha = +p; const c = dk$('dkLinea'); if (c) c.innerHTML = dkLinea(dkHist(6)); dkReenfocar(c, 'data-dk-pt', p, e); }
}
function dkReenfocar(c, attr, v, e) { if (e.type === 'focusin') c.querySelector('[' + attr + '="' + v + '"]')?.focus(); }
['mouseover', 'focusin'].forEach((ev) => document.addEventListener(ev, (e) => { if (dkActivo() && e.target.closest && e.target.closest('#desktopDashboard')) dkHover(e); }));

/* ════════ Extras de las páginas (encabezado, Tarjetas) ════════ */
function dkPaginaExtra() {
  const p = DK.pag, mes = MESES[curMonth] + ' ' + curYear, mesL = MESES[curMonth].toLowerCase();
  const head = (t, sub, extra) => '<div class="dk-head"><div><h1>' + t + '</h1><p>' + sub + '</p></div>' + (extra || '') + '</div>';
  if (p === 'ingresos') {
    const n = (state.extras || []).length;
    dk$('dkHead-ingresos').innerHTML = head('Ingresos', 'Sueldo' + (n ? ' y ' + n + (n === 1 ? ' ingreso extra' : ' ingresos extra') : '') + ' de ' + esc(mesL));
  } else if (p === 'servicios') {
    const s = state.servicios || [], c = s.filter((x) => nv(x.amt) > 0).length;
    dk$('dkHead-servicios').innerHTML = head('Servicios', esc(mes) + ': ' + c + ' de ' + s.length + ' con monto · se repiten todos los meses');
  } else if (p === 'gastos') {
    dk$('dkHead-gastos').innerHTML = head('Gastos', 'Súper y gastos fuera de tarjetas y servicios en ' + esc(mesL));
  } else if (p === 'tarjetas') dkTarjetasExtra(head, mesL);
}
function dkCuotas() { // compras en cuotas que siguen después de este resumen
  const v = new Map();
  (state.tarjetas || []).forEach((t) => (t.detalle || []).forEach((r) => { const ct = parseInt(r.cuotaTotal, 10), ca = parseInt(r.cuotaActual, 10); if (r.cuotas && ct > ca && ca >= 0 && ct <= 120) { const k = r.nombre + '|' + ct, f = ct - ca; if (!v.has(k) || v.get(k) < f) v.set(k, f); } }));
  const faltan = [...v.values()]; return { n: faltan.length, max: faltan.length ? Math.max(...faltan) : 0 };
}
function dkTarjetasExtra(head, mesL) {
  const tcs = dkTarjetas(state), total = tcs.reduce((a, x) => a + x.total, 0), pag = tcs.reduce((a, x) => a + Math.min(x.pag, x.total || x.pag), 0);
  const resta = tcs.reduce((a, x) => a + x.resta, 0), pend = tcs.filter((x) => x.resta > 0), cu = dkCuotas();
  let fin = ''; if (cu.n) { let m = curMonth + cu.max, y = curYear; while (m > 11) { m -= 12; y++; } fin = 'La última termina en ' + MESES[m].toLowerCase() + ' ' + y; }
  const k = (ic, cls, lbl, v, sub) => '<article class="dk-card dk-kpi sm">' + '<div class="dk-kpi-h">' + dkIco(ic, cls) + '<span class="dk-kpi-l">' + lbl + '</span></div><b class="dk-kpi-v">' + v + '</b><span>' + sub + '</span></article>';
  dk$('dkHead-tarjetas').innerHTML = head('Tarjetas', 'Resúmenes de ' + esc(mesL) + ': pagos, consumos y cuotas', '<button class="dk-btn primary" data-click="addTarjeta"><i class="ti ti-plus" aria-hidden="true"></i>Agregar tarjeta</button>')
    + '<div class="dk-grid k4">'
    + k('ti-credit-card', 'blue', 'Total de resúmenes', DKM(total), tcs.filter((x) => x.total > 0).length + ' de ' + tcs.length + ' con resumen cargado')
    + k('ti-check', 'green', 'Pagado', DKM(pag), total > 0 ? dkPct(pag, total) + '% del total' : 'Sin resúmenes')
    + k('ti-clock', 'red', 'Por pagar', DKM(resta), pend.length ? esc(pend.map((x) => x.nom).join(', ')) : 'Todo saldado')
    + k('ti-calendar-repeat', 'soft', 'Compras en cuotas', String(cu.n), cu.n ? esc(fin) : 'Sin cuotas pendientes en los resúmenes')
    + '</div>';
  dkConsumos(true);
}
function dkMovs() {
  const out = [];
  (state.tarjetas || []).forEach((t, i) => (t.detalle || []).forEach((r) => out.push({ i, tc: ddName(tcName(t, i)), t, r })));
  return out;
}
function dkConsumos(entero) {
  const sec = dk$('dkConsumos'); if (!sec) return;
  const movs = dkMovs(), tcs = (state.tarjetas || []).map((t, i) => ({ i, nom: ddName(tcName(t, i)), n: (t.detalle || []).length })).filter((x) => x.n > 0);
  if (DK.tcF !== 'todas' && !tcs.some((x) => String(x.i) === DK.tcF)) DK.tcF = 'todas';
  if (!movs.length) { sec.innerHTML = '<div class="dk-h">' + dkIco('ti-list-search', 'blue') + '<h2>Consumos del mes</h2></div><p class="dk-vacio">Subí el resumen de cada tarjeta (PDF o Excel, desde «Detalle del resumen») y acá vas a ver todos los consumos juntos, con buscador y filtro por tarjeta.</p>'; return; }
  if (entero || !dk$('dkBuscaTc')) {
    sec.innerHTML = '<div class="dk-h wrap">' + dkIco('ti-list-search', 'blue') + '<h2>Consumos del mes</h2>'
      + '<label class="dk-busca"><i class="ti ti-search" aria-hidden="true"></i><span class="sr">Buscar consumos</span><input id="dkBuscaTc" type="search" placeholder="Buscar consumos" autocomplete="off" data-input="dkBuscarTc"></label>'
      + '<div class="dk-filtros" role="group" aria-label="Filtrar por tarjeta" id="dkFiltrosTc"></div></div><div id="dkConsumosT"></div>';
    dk$('dkBuscaTc').value = DK.tcQ;
  }
  const chip = (id, lbl, n) => '<button class="dk-filtro' + (DK.tcF === id ? ' on' : '') + '" data-click="dkFiltroTc" data-arg="' + id + '" aria-pressed="' + (DK.tcF === id) + '">' + esc(lbl) + '<span>' + n + '</span></button>';
  dk$('dkFiltrosTc').innerHTML = chip('todas', 'Todas', movs.length) + tcs.map((x) => chip(String(x.i), x.nom, x.n)).join('');
  const q = DK.tcQ.trim().toLowerCase();
  const filas = movs.filter((m) => (DK.tcF === 'todas' || String(m.i) === DK.tcF) && (!q || String(m.r.nombre || '').toLowerCase().includes(q) || m.tc.toLowerCase().includes(q)));
  const TC_EST = (t) => { const total = nv(t.total), pag = nv(t.pagado) + (t.extraPagos || []).reduce((a, p) => a + nv(p.amt), 0); return total <= 0 ? DK_EST.vacia : pag >= total ? DK_EST.saldada : pag > 0 ? DK_EST.parcial : DK_EST.sinpagar; };
  dk$('dkConsumosT').innerHTML = !filas.length ? '<p class="dk-vacio">No hay consumos que coincidan con «' + esc(DK.tcQ) + '».</p>'
    : '<div class="dk-tabla-w"><table class="dk-tabla"><thead><tr><th scope="col">Consumo</th><th scope="col">Tarjeta</th><th scope="col">Cuota</th><th scope="col">Estado del resumen</th><th scope="col" class="r">Pesos</th><th scope="col" class="r">Dólares</th></tr></thead><tbody>'
      + filas.map((m) => { const n = ddName(String(m.r.nombre || '').toLowerCase()), e = TC_EST(m.t);
        return '<tr><td><div class="dk-cons"><span class="dk-av sm" style="background:' + avatarColor(n) + '" aria-hidden="true">' + esc(dkIni(n)) + '</span><div><b>' + esc(n) + '</b>' + (m.r.fecha ? '<small>' + esc(String(m.r.fecha)) + '</small>' : '') + '</div></div></td>'
          + '<td><div class="dk-cons">' + cardMiniIcon(m.t.name) + '<span>' + esc(m.tc) + '</span></div></td>'
          + '<td>' + (m.r.cuotas ? dkChip((parseInt(m.r.cuotaActual, 10) || '?') + ' de ' + (parseInt(m.r.cuotaTotal, 10) || '?'), 'blue') : dkChip('Contado', 'mute')) + '</td>'
          + '<td>' + dkChip(e[0], e[1]) + '</td>'
          + '<td class="r"><b>' + (nv(m.r.monto) ? DKM(nv(m.r.monto)) : '<span class="t-mute">—</span>') + '</b></td>'
          + '<td class="r">' + (nv(m.r.montoUSD) ? '<span class="dkm">' + esc(fmtUSD(m.r.montoUSD)) + '</span>' : '<span class="t-mute">—</span>') + '</td></tr>'; }).join('')
      + '</tbody></table></div><p class="dk-pie">' + filas.length + (filas.length === 1 ? ' consumo' : ' consumos') + ' · ' + fmt(filas.reduce((a, m) => a + nv(m.r.monto), 0)) + (filas.some((m) => nv(m.r.montoUSD)) ? ' + ' + esc(fmtUSD(filas.reduce((a, m) => a + nv(m.r.montoUSD), 0))) : '') + '</p>';
}

/* ── Acciones (mismo despachador que app.js) ── */
Object.assign(ACCIONES.click, {
  dkIr: (el) => navTo(el.dataset.arg),
  dkTema: (el) => dkTema(el.dataset.arg, el),
  dkMenu: () => dkMenu(),
  dkOcultar: () => dkOcultar(),
  dkCerrarTip: () => { dkGuardar('fin_dk_tip_bot', '0'); renderDashboard(); },
  dkFiltroTc: (el) => { DK.tcF = el.dataset.arg; dkConsumos(false); },
  dkAgregarGasto: () => { navTo('gastos'); setTimeout(() => dk$('gextra-name')?.focus(), 60); },
  signOutDk: () => { dkCerrarMenu(); signOut(); },
});
Object.assign(ACCIONES.input, {
  dkBuscarTc: (el) => { DK.tcQ = String(el.value || '').slice(0, 80); dkConsumos(false); },
});
