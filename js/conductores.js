/* App de conductores Ringcon Go */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set, remove, onDisconnect, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { FIREBASE, API_URL } from './config.js';

const DRIVER_EMAIL_DOMAIN = 'conductores.ringcongo.app';
const HEARTBEAT = 30000;
const DOCS = [
  { id: 'dni_frente', t: 'DNI · frente', s: 'Con buena luz, que se lean los datos', em: '🪪', capture: 'environment' },
  { id: 'dni_dorso', t: 'DNI · dorso', s: 'Incluí el código de barras completo', em: '🔁', capture: 'environment' },
  { id: 'selfie', t: 'Selfie', s: 'Tu cara de frente, sin gorra ni anteojos', em: '🤳', capture: 'user' }
];

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const date = ms => ms ? new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const cleanDni = v => String(v || '').replace(/\D/g, '').slice(0, 8);
let toastT;
function toast(msg, type) { const t = $('#toast'); t.textContent = msg; t.className = 'on ' + (type || ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3800); }

if (FIREBASE.apiKey === 'COMPLETAR') {
  $('#app').innerHTML = '<main class="center"><div class="panel"><h1>Falta configurar</h1><p class="sub">Completá js/config.js con los datos de tu proyecto de Firebase.</p></div></main>';
  throw new Error('Falta completar js/config.js');
}
const fb = initializeApp(FIREBASE);
const auth = getAuth(fb), db = getDatabase(fb);
const call = name => async data => {
  const u = auth.currentUser;
  if (!u) throw new Error('Iniciá sesión para continuar.');
  let r;
  try {
    r = await fetch(API_URL + '/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await u.getIdToken() },
      body: JSON.stringify({ fn: name, data })
    });
  } catch { throw new Error('Sin conexión. Revisá tu internet.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Algo salió mal. Probá de nuevo.');
  return j.data;
};
const api = Object.fromEntries(['driverLookup', 'driverRegister', 'driverUploadDoc', 'driverSubmitDocs', 'driverAccept', 'driverAdvance', 'driverRelease'].map(n => [n, call(n)]));

const state = {
  step: 'loading', dni: '', lookup: null,
  uid: null, me: null, online: false, open: {}, activeId: null, active: null, settlements: {},
  shots: {}, busy: false, towns: {}
};
// Pedidos publicados para el pueblo del conductor (el tablero tiene los de todos los pueblos).
const myTownName = () => (state.me && state.towns[state.me.townId] && state.towns[state.me.townId].name) || 'tu pueblo';
const myOpen = () => Object.values(state.open || {}).filter(o => state.me && o.townId === state.me.townId);
let subs = [], activeSub = null, openSub = null, beatT = null, wake = null, seenOpen = null;
const brand = `<div class="brand"><svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#ff3b1f"/><g transform="translate(0 -12)" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"><path d="M200 220v-30a56 56 0 0 1 112 0v30" stroke-width="22"/><path d="M160 214H352L384 396H128Z" fill="#fff" stroke-width="36"/></g></svg><div>Ringcon Go<small>CONDUCTORES</small></div></div>`;
const progress = n => `<div class="progress">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
const page = html => { $('#app').innerHTML = `<main class="center"><div class="panel">${brand}${html}</div></main>`; };

/* ─────────── acceso por DNI ─────────── */
function render() {
  const s = state.step;
  if (s === 'loading') { $('#app').innerHTML = '<div class="loading">Cargando…</div>'; return; }
  if (s === 'dni') return page(`${progress(1)}
    <h1>Ingresá tu DNI</h1>
    <p class="sub">Lo buscamos en el padrón de conductores habilitados.</p>
    <form id="f-dni">
      <label class="field dni">Número de documento<input id="dni" inputmode="numeric" autocomplete="off" placeholder="30123456" maxlength="10" value="${esc(state.dni)}" required></label>
      <button class="btn primary" id="go">Buscar</button>
    </form>`);
  if (s === 'notfound') return page(`
    <div class="notice bad"><span>🔎</span><span><b>No encontramos el DNI ${esc(state.dni)}</b>No está en el padrón de conductores habilitados. Para sumarte, contactá a la administración de Ringcon Go con tu DNI, licencia y datos del vehículo.</span></div>
    <button class="btn ghost" data-act="restart">Probar con otro DNI</button>`);
  if (s === 'inactive') return page(`
    <div class="notice bad"><span>⛔</span><span><b>DNI deshabilitado</b>Tu registro en el padrón está dado de baja. Contactá a la administración.</span></div>
    <button class="btn ghost" data-act="restart">Volver</button>`);
  if (s === 'login') return page(`${progress(2)}
    <h1>Hola, ${esc(state.lookup.name)}</h1>
    <p class="sub">Ingresá tu contraseña para entrar al panel.</p>
    <form id="f-login">
      <input type="text" autocomplete="username" value="${esc(state.dni)}" hidden>
      <label class="field">Contraseña<input id="pw" type="password" autocomplete="current-password" required minlength="8"></label>
      <button class="btn primary" id="go">Entrar</button>
    </form>
    <p class="small mute" style="margin-top:16px">¿Olvidaste la contraseña? Pedile a la administración que la restablezca. · <button class="link" data-act="restart">Otro DNI</button></p>`);
  if (s === 'verify') return page(`${progress(2)}
    <h1>Verificá que sos vos</h1>
    <p class="sub">Encontramos a <b>${esc(state.lookup.name)}</b> en el padrón. Confirmá estos datos tal como figuran en tu DNI.</p>
    <form id="f-verify">
      <input type="text" autocomplete="username" value="${esc(state.dni)}" hidden>
      <label class="field">Apellido<input id="ap" autocomplete="family-name" required maxlength="60"></label>
      <label class="field">Fecha de nacimiento<input id="nac" type="date" required max="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field">Teléfono<input id="tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="299 123 4567" maxlength="20"></label>
      <label class="field">Creá una contraseña<input id="pw" type="password" autocomplete="new-password" required minlength="8" placeholder="Mínimo 8 caracteres"></label>
      <label class="field">Repetila<input id="pw2" type="password" autocomplete="new-password" required minlength="8"></label>
      <button class="btn primary" id="go">Verificar identidad</button>
    </form>
    <p class="small mute" style="margin-top:12px">Al crear tu cuenta aceptás los <a class="link" href="https://ringcon-go.vercel.app/privacidad.html" target="_blank" rel="noopener">Términos y Política de privacidad</a>.</p>
    <p class="small mute" style="margin-top:16px">Tenés 5 intentos por día. · <button class="link" data-act="restart">Otro DNI</button></p>`);
  if (s === 'driver') return renderDriver();
}

async function ensureAnon() { if (!auth.currentUser) await signInAnonymously(auth); }
function busy(on) { state.busy = on; const b = $('#go'); if (b) { b.disabled = on; if (on) b.dataset.label = b.textContent, b.innerHTML = '<span class="spin"></span>'; else if (b.dataset.label) b.textContent = b.dataset.label; } }

document.addEventListener('submit', async e => {
  e.preventDefault();
  if (state.busy) return;
  const id = e.target.id;
  busy(true);
  try {
    if (id === 'f-dni') {
      const dni = cleanDni($('#dni').value);
      if (dni.length < 7) { toast('El DNI tiene 7 u 8 números', 'err'); return; }
      state.dni = dni;
      await ensureAnon();
      const r = await api.driverLookup({ dni });
      state.lookup = r;
      state.step = !r.found ? 'notfound' : !r.active ? 'inactive' : r.claimed ? 'login' : 'verify';
      render();
    } else if (id === 'f-login') {
      await signInWithEmailAndPassword(auth, `${state.dni}@${DRIVER_EMAIL_DOMAIN}`, $('#pw').value);
    } else if (id === 'f-verify') {
      const pw = $('#pw').value;
      if (pw !== $('#pw2').value) { toast('Las contraseñas no coinciden', 'err'); return; }
      await ensureAnon();
      await api.driverRegister({ dni: state.dni, apellido: $('#ap').value, nacimiento: $('#nac').value, telefono: $('#tel').value, password: pw });
      await signInWithEmailAndPassword(auth, `${state.dni}@${DRIVER_EMAIL_DOMAIN}`, pw);
      toast('¡Identidad confirmada! Último paso: tus fotos');
    }
  } catch (err) {
    const m = /auth\/(invalid-credential|wrong-password|invalid-login)/.test(err.code || '') ? 'Contraseña incorrecta' :
      /too-many-requests/.test(err.code || '') ? 'Demasiados intentos. Esperá unos minutos.' : err.message;
    toast(m, 'err');
  } finally { busy(false); }
});

/* ─────────── panel del conductor ─────────── */
function renderDriver() {
  const d = state.me;
  if (!d) { $('#app').innerHTML = '<div class="loading">Cargando tu cuenta…</div>'; return; }
  if (d.status === 'docs_pendientes' || d.status === 'rechazado') return renderDocs(d);
  if (d.status === 'en_revision') return page(`${progress(3)}
    <h1>Estamos revisando tu identidad</h1>
    <p class="sub">Comparamos tus fotos con el padrón. Te habilitamos apenas terminemos; esta pantalla se actualiza sola.</p>
    ${idCard(d)}
    <div class="notice warn"><span>⏳</span><span><b>En revisión</b>Suele tardar menos de 24 horas.</span></div>
    <button class="btn ghost" data-act="logout">Cerrar sesión</button>`);
  if (d.status === 'suspendido') return page(`
    <div class="notice bad"><span>⛔</span><span><b>Cuenta suspendida</b>${esc(d.nota || 'Contactá a la administración de Ringcon Go.')}</span></div>
    <button class="btn ghost" data-act="logout">Cerrar sesión</button>`);
  renderPanel(d);
}

const idCard = d => `<div class="id-card"><small>Conductor</small><b>${esc(d.nombre)} ${esc(d.apellido)}</b>
  <div class="row2"><div><small>DNI</small><b>${esc(d.dni)}</b></div><div><small>Licencia vence</small><b>${date(d.licenciaVence)}</b></div></div>
  ${d.vehiculo || d.patente ? `<div class="row2" style="margin-top:10px"><div><small>Vehículo</small><b>${esc(d.vehiculo || '—')}</b></div><div><small>Patente</small><b>${esc(d.patente || '—')}</b></div></div>` : ''}</div>`;

function renderDocs(d) {
  const ready = DOCS.every(x => state.shots[x.id] && state.shots[x.id].done);
  page(`${progress(3)}
    <h1>Subí tus fotos</h1>
    <p class="sub">Las usamos solo para confirmar que sos la persona del padrón. Nadie más las ve. Más info en los <a class="link" href="https://ringcon-go.vercel.app/privacidad.html" target="_blank" rel="noopener">Términos y Política de privacidad</a>.</p>
    ${d.status === 'rechazado' ? `<div class="notice bad"><span>⚠️</span><span><b>Tenemos que verlas de nuevo</b>${esc(d.nota || 'Alguna foto no se veía bien.')}</span></div>` : ''}
    ${idCard(d)}
    <div class="shots">${DOCS.map(x => {
      const s = state.shots[x.id] || {};
      return `<label class="shot ${s.done ? 'done' : ''}">
        <span class="th" ${s.url ? `style="background-image:url('${s.url}')"` : ''}>${s.url ? '' : x.em}</span>
        <span><b>${x.t} ${s.done ? '✓' : ''}</b><small>${s.up ? 'Subiendo…' : s.done ? 'Listo · tocá para cambiarla' : x.s}</small></span>
        <input type="file" accept="image/*" capture="${x.capture}" data-doc="${x.id}">
      </label>`;
    }).join('')}</div>
    <button class="btn primary" id="go" data-act="submit-docs" ${ready ? '' : 'disabled'}>Enviar a revisión</button>
    <button class="btn ghost" data-act="logout">Cerrar sesión</button>`);
}

// Achica la foto a JPEG liviano: se guarda en la base y tiene que subir rápido con datos móviles.
async function compress(file) {
  const img = await createImageBitmap(file);
  for (const [side, q] of [[1400, 0.75], [1100, 0.65], [900, 0.55]]) {
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 850000) return url;
  }
  throw new Error('Foto muy pesada');
}

document.addEventListener('change', async e => {
  const doc = e.target.dataset && e.target.dataset.doc, f = e.target.files && e.target.files[0];
  if (!doc || !f) return;
  if (!/^image\//.test(f.type)) { toast('Elegí una foto', 'err'); return; }
  const prev = state.shots[doc];
  if (prev && prev.url) URL.revokeObjectURL(prev.url);
  state.shots[doc] = { up: true, url: URL.createObjectURL(f) }; renderDriver();
  try {
    await api.driverUploadDoc({ doc, image: await compress(f) });
    state.shots[doc] = { ...state.shots[doc], up: false, done: true };
  } catch { state.shots[doc] = { ...state.shots[doc], up: false, done: false }; toast('No pudimos subir la foto. Probá de nuevo.', 'err'); }
  renderDriver();
});

function todayStats() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const list = Object.values(state.settlements).filter(s => s.at >= from.getTime());
  const sum = k => list.reduce((a, s) => a + (s[k] || 0), 0);
  return { n: list.length, earning: sum('earning'), owe: sum('toPlatform') };
}

function renderPanel(d) {
  const expired = !(d.licenciaVence > Date.now()), st = todayStats();
  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <div class="who"><b>${esc(d.nombre)} ${esc(d.apellido)}</b><small>✓ Identidad verificada</small></div>
    <div class="toggle"><span id="on-label">${state.online ? 'EN LÍNEA' : 'OFFLINE'}</span>
      <button class="switch" role="switch" aria-checked="${state.online}" aria-label="En línea" data-act="toggle" ${expired ? 'disabled' : ''}></button></div>
    <button class="icon-btn" data-act="fullscreen" aria-label="Pantalla completa">⛶</button>
    <button class="icon-btn" data-act="logout" aria-label="Cerrar sesión">⎋</button>
  </div></header>
  <main class="wrap">
    ${expired ? `<div class="notice bad"><span>⛔</span><span><b>Licencia vencida (${date(d.licenciaVence)})</b>No podés ponerte en línea hasta actualizarla con la administración.</span></div>` : ''}
    ${d.townId ? '' : `<div class="notice warn"><span>📍</span><span><b>Tu cuenta todavía no tiene pueblo asignado</b>Avisale a la administración: hasta que te asignen uno no vas a ver pedidos.</span></div>`}
    <div class="stats">
      <div class="stat"><small>Entregas hoy</small><b>${st.n}</b></div>
      <div class="stat"><small>Ganancia hoy</small><b>${money(st.earning)}</b></div>
      <div class="stat"><small>A rendir hoy</small><b>${money(st.owe)}</b></div>
    </div>
    <div id="main">${state.active ? renderActive(state.active) : renderOpen()}</div>
  </main>`;
}

function renderOpen() {
  if (!state.online) return `<div class="empty"><span class="em">🛵</span>Ponete <b>EN LÍNEA</b> arriba para recibir pedidos en tiempo real.</div>`;
  if (!state.me.townId) return `<div class="empty"><span class="em">📍</span>Cuando la administración te asigne un pueblo, los pedidos van a aparecer acá.</div>`;
  const list = myOpen().sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) return `<div class="empty"><span class="pulse"></span>Buscando pedidos en ${esc(myTownName())}…</div>`;
  return `<h2 style="font-size:24px;margin-bottom:14px">Pedidos disponibles (${list.length})</h2>
  ${list.map(o => {
    const card = o.method === 'tarjeta';
    return `<div class="card">
      <span class="badge ${card ? 'ok' : 'wait'}">${card ? '💳 Pagado con tarjeta' : `💵 Cobrar ${money(o.total)} en efectivo`}</span>
      <h3>${esc(o.business.name)}</h3>
      <div class="kv"><span>Tu ganancia</span><b style="color:var(--ok)">${money(o.driverPay)}</b></div>
      <div class="kv"><span>Destino</span><b>${esc(o.address.text)}</b></div>
      <div class="kv"><span>Productos</span><b>${o.items}</b></div>
      <button class="btn primary" style="margin-top:14px" data-act="accept" data-id="${esc(o.id)}">Aceptar pedido</button>
    </div>`;
  }).join('')}`;
}

const NEXT = {
  aceptado: { to: 'en_local', label: 'Llegué al local', cls: 'primary' },
  en_local: { to: 'recogido', label: 'Retiré el pedido', cls: 'primary' },
  recogido: { to: 'entregado', label: 'Confirmar entrega', cls: 'success' }
};
const STEP_I = { aceptado: 1, en_local: 2, recogido: 3 };

function renderActive(o) {
  const card = o.payment.method === 'tarjeta', n = NEXT[o.status], t = o.totals;
  const townName = (state.towns[o.townId] && state.towns[o.townId].name) || myTownName();
  const maps = o.address.lat ? `https://www.google.com/maps/dir/?api=1&destination=${o.address.lat},${o.address.lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address.text + ', ' + townName)}`;
  const phone = String(o.customer.phone || '').replace(/[^\d+]/g, '');
  return `<h2 style="font-size:24px;margin-bottom:14px">Pedido en curso · #${esc(o.id.slice(-5).toUpperCase())}</h2>
  <div class="card active">
    <div class="steps">${[1, 2, 3].map(i => `<i class="${i <= STEP_I[o.status] ? 'on' : ''}"></i>`).join('')}</div>
    <h3>${esc(o.business.name)}</h3>
    ${card
      ? `<div class="notice ok"><span>💳</span><span><b>PAGADO CON TARJETA</b>El cliente ya pagó por Mercado Pago. <u>No le cobres nada</u> en la puerta. El local cobra por la plataforma.</span></div>`
      : `<div class="notice warn"><span>💵</span><span><b>COBRAR EN PUERTA</b><span class="big">${money(t.total)}</span>
          ${o.payment.cashWith ? `Paga con ${money(o.payment.cashWith)} → llevá ${money(o.payment.cashWith - t.total)} de cambio.` : 'Paga con el monto justo o no avisó.'}
          <span class="cash" style="margin-top:8px">
            <div><span>Pagás al local al retirar</span><b>${money(o.split.restaurant)}</b></div>
            <div><span>Tu ganancia (envío + propina)</span><b>${money(o.driverPay)}</b></div>
            <div><span>Rendís a Ringcon Go</span><b>${money(o.split.commission)}</b></div>
          </span></span></div>`}
    <div class="kv"><span>Cliente</span><b>${esc(o.customer.name)}</b></div>
    <div class="kv"><span>Teléfono</span><b>${phone ? `<a href="tel:${esc(phone)}">${esc(o.customer.phone)}</a>` : 'Sin teléfono'}</b></div>
    <div class="kv"><span>Entregar en</span><b><a href="${esc(maps)}" target="_blank" rel="noopener">${esc(o.address.text)} ↗</a>${o.address.ref ? `<br><span class="mute small">${esc(o.address.ref)}</span>` : ''}</b></div>
    ${o.notes ? `<div class="kv"><span>Notas</span><b>${esc(o.notes)}</b></div>` : ''}
    <div class="kv"><span>Pedido</span><b>${Object.values(o.items || {}).map(i => `${i.qty}× ${esc(i.name)}`).join('<br>')}</b></div>
    ${n ? `<button class="btn ${n.cls}" id="go" style="margin-top:16px" data-act="advance" data-id="${esc(o.id)}" data-to="${n.to}">${n.label}</button>` : ''}
    ${['aceptado', 'en_local'].includes(o.status) ? `<button class="btn ghost" data-act="release" data-id="${esc(o.id)}">No puedo hacerlo · liberar pedido</button>` : ''}
  </div>`;
}

function drawMain() { const m = $('#main'); if (m && state.me && state.me.status === 'aprobado') renderPanel(state.me); }

/* ─────────── en línea / heartbeat ─────────── */
const presRef = () => ref(db, `presence/${state.uid}`);
async function beat() { await set(presRef(), { online: true, lastSeen: serverTimestamp() }); }
async function goOnline() {
  try {
    await onDisconnect(presRef()).remove();
    await beat();
    clearInterval(beatT); beatT = setInterval(() => beat().catch(() => {}), HEARTBEAT);
    state.online = true; seenOpen = null; watchOpen();
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  } catch { state.online = false; toast('No pudimos ponerte en línea. Revisá tu conexión.', 'err'); }
  drawMain();
}
async function goOffline() {
  state.online = false; clearInterval(beatT);
  if (openSub) { openSub(); openSub = null; } state.open = {};
  try { await remove(presRef()); await onDisconnect(presRef()).cancel(); } catch {}
  try { await wake?.release(); } catch {} wake = null;
  drawMain();
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.online && !wake) { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
});

function ding() {
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(a.destination);
    g.gain.setValueAtTime(.25, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .6);
    o.start(); o.stop(a.currentTime + .6);
  } catch {}
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function watchOpen() {
  if (openSub) return;
  openSub = onValue(ref(db, 'openOrders'), s => {
    state.open = s.val() || {};
    const ids = myOpen().map(o => o.id);
    if (seenOpen && !state.active && ids.some(id => !seenOpen.has(id))) { ding(); toast('¡Nuevo pedido disponible!'); }
    seenOpen = new Set(ids);
    if (!state.active) drawMain();
  }, () => {});
}

/* ─────────── acciones ─────────── */
async function act(btn, fn, okMsg) {
  if (state.busy) return;
  state.busy = true; btn.disabled = true;
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  finally { state.busy = false; }
}
const A = {
  restart: () => { state.step = 'dni'; state.lookup = null; render(); },
  logout: async () => {
    if (state.active && !confirm('Tenés un pedido en curso. ¿Cerrar sesión igual?')) return;
    if (state.online) await goOffline();
    await signOut(auth);
  },
  toggle: () => state.online ? goOffline() : goOnline(),
  fullscreen: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}),
  'submit-docs': t => act(t, () => api.driverSubmitDocs(), 'Fotos enviadas. Te avisamos al aprobarte.'),
  accept: t => act(t, () => api.driverAccept({ orderId: t.dataset.id }), '¡Pedido aceptado! Andá al local'),
  advance: t => {
    if (t.dataset.to === 'entregado' && state.active && state.active.payment.method === 'efectivo' && !confirm(`¿Cobraste ${money(state.active.totals.total)} en efectivo?`)) return;
    act(t, () => api.driverAdvance({ orderId: t.dataset.id, to: t.dataset.to }), t.dataset.to === 'entregado' ? '¡Entrega confirmada! 🎉' : 'Listo');
  },
  release: t => { if (confirm('¿Liberar este pedido para que lo tome otro conductor?')) act(t, () => api.driverRelease({ orderId: t.dataset.id }), 'Pedido liberado'); }
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) { e.preventDefault(); f(t, e); } });

/* ─────────── sesión ─────────── */
function stopAll() {
  subs.forEach(u => u()); subs = [];
  if (activeSub) { activeSub(); activeSub = null; }
  if (openSub) { openSub(); openSub = null; }
  clearInterval(beatT);
  Object.assign(state, { uid: null, me: null, online: false, open: {}, activeId: null, active: null, settlements: {}, shots: {} });
}

onAuthStateChanged(auth, u => {
  stopAll();
  if (!u || u.isAnonymous) { state.step = state.step === 'driver' || state.step === 'loading' ? 'dni' : state.step; render(); return; }
  state.uid = u.uid; state.step = 'driver'; render();
  subs.push(onValue(ref(db, `drivers/${u.uid}`), s => {
    const was = state.me && state.me.status;
    state.me = s.val();
    if (!state.me) { signOut(auth); toast('Tu cuenta no tiene un perfil de conductor.', 'err'); return; }
    if (was && was !== 'aprobado' && state.me.status === 'aprobado') { ding(); toast('¡Fuiste aprobado! Ya podés ponerte en línea'); }
    if (state.me.status !== 'aprobado' && state.online) goOffline();
    render();
  }));
  subs.push(onValue(ref(db, `driverActive/${u.uid}`), s => {
    const id = s.val();
    if (id === state.activeId) return;
    if (activeSub) { activeSub(); activeSub = null; }
    state.activeId = id; state.active = null;
    if (id) activeSub = onValue(ref(db, `orders/${id}`), o => { state.active = o.val(); drawMain(); }, () => {});
    else drawMain();
  }, () => {}));
  subs.push(onValue(ref(db, `settlements/${u.uid}`), s => { state.settlements = s.val() || {}; drawMain(); }, () => {}));
  subs.push(onValue(ref(db, '.info/connected'), s => { if (s.val() && state.online) goOnline(); }));
});
// Pueblos (público, sin datos personales): sirve para mostrar el nombre del pueblo del conductor.
onValue(ref(db, 'towns'), s => { state.towns = s.val() || {}; drawMain(); }, () => {});
render();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
