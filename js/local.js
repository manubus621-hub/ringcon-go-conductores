/* Panel del local Ringcon Go: los pedidos llegan en vivo, con alerta sonora, y el local marca cada paso. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { FIREBASE, API_URL } from './config.js';

const RING_EVERY = 4;   // segundos entre alertas mientras haya pedidos sin aceptar
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const hhmm = ms => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
const code = o => '#' + String(o.id).slice(-5).toUpperCase();
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
const api = { bizAdvance: call('bizAdvance'), bizSetOpen: call('bizSetOpen') };

const state = { step: 'loading', bizId: null, biz: null, orders: {}, connected: false, wasConnected: false, offset: 0 };
let subs = [], actx = null, wake = null, seen = null, secs = 0;

/* ─────────── pedidos por columna ─────────── */
const now = () => Date.now() + state.offset;   // hora del servidor, por si el reloj de la tablet está corrido
const OUT = ['recogido', 'entregado', 'cancelado'];
const list = () => Object.values(state.orders).sort((a, b) => a.at - b.at);
const pending = () => list().filter(o => o.kitchen === 'pendiente' && !OUT.includes(o.status));
const cooking = () => list().filter(o => ['aceptado', 'preparando'].includes(o.kitchen) && !OUT.includes(o.status));
const ready = () => list().filter(o => o.kitchen === 'listo' && !OUT.includes(o.status));
// El día del local empieza a las 5 de la mañana, para que el turno de la noche no se parta a las 12.
function done() {
  const d = new Date(now()); if (d.getHours() < 5) d.setDate(d.getDate() - 1); d.setHours(5, 0, 0, 0);
  return list().filter(o => OUT.includes(o.status) && (o.updatedAt || o.at) >= d.getTime()).reverse();
}

/* ─────────── alerta sonora ─────────── */
// Los navegadores no dejan sonar una página hasta que alguien la toca: por eso el aviso "Tocá para activar".
const soundOn = () => !!actx && actx.state === 'running';
async function enableSound() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state !== 'running') await actx.resume(); } catch {}
  try { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch {}
  if (state.step === 'board') render();
}
function beep() {
  if (!soundOn()) return;
  const t = actx.currentTime;
  [[0, 880], [0.22, 880], [0.44, 1175]].forEach(([at, hz]) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = hz; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.6, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.2);
    o.start(t + at); o.stop(t + at + 0.21);
  });
}
function alertNew() { beep(); if (navigator.vibrate) navigator.vibrate([300, 120, 300]); }
// Cada segundo: cuenta regresiva de los pedidos sin aceptar, y la alerta se repite hasta que alguien los atienda.
function tick() {
  secs++;
  const n = state.step === 'board' ? pending().length : 0, name = (state.biz && state.biz.name) || 'Ringcon Go';
  document.title = n ? `(${n}) ¡Pedido nuevo! · ${name}` : `${name} · Pedidos`;
  if (n && secs % RING_EVERY === 0) alertNew();
  document.querySelectorAll('[data-deadline]').forEach(el => {
    const left = Math.max(0, Math.round((Number(el.dataset.deadline) - now()) / 1000));
    el.querySelector('b').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('soon', left < 120);
  });
}
setInterval(tick, 1000);
document.addEventListener('pointerdown', () => { if (!soundOn()) enableSound(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && actx) enableSound(); });

/* ─────────── pantallas ─────────── */
function render() {
  if (state.step === 'loading') { $('#app').innerHTML = '<div class="loading">Cargando…</div>'; return; }
  if (state.step === 'login') {
    $('#app').innerHTML = `<main class="center"><div class="panel">
      <h1>Pedidos del local</h1><p class="sub">Entrá con el email y la contraseña que te dio Ringcon Go.</p>
      <form id="f-local">
        <label class="field">Email<input id="em" type="email" autocomplete="username" required></label>
        <label class="field">Contraseña<input id="pw" type="password" autocomplete="current-password" required></label>
        <button class="btn primary">Entrar</button>
      </form></div></main>`;
    return;
  }
  const b = state.biz || {}, open = b.open !== false, p = pending(), c = cooking(), r = ready(), d = done();
  const sold = d.filter(o => o.status !== 'cancelado');
  $('#app').innerHTML = `
  <header class="top"><div class="top-in wide">
    <div class="who"><b>${esc(b.name || 'Tu local')}</b><small>${state.connected ? '● Recibiendo pedidos en vivo' : 'Conectando…'}</small></div>
    <div class="toggle"><span>${open ? 'ABIERTO' : 'CERRADO'}</span>
      <button class="switch" role="switch" aria-checked="${open}" aria-label="Local abierto" data-act="open"></button></div>
    <button class="icon-btn" data-act="logout" aria-label="Cerrar sesión">⎋</button>
  </div></header>
  <main class="wrap wide">
    ${soundOn() ? '' : `<button class="notice warn" data-act="sound"><span>🔔</span><span><b>La alerta sonora está apagada</b>Tocá acá para que suene cuando entra un pedido. Dejá esta pantalla abierta y con volumen.</span></button>`}
    ${state.wasConnected && !state.connected ? `<div class="notice bad"><span>📡</span><span><b>Sin conexión a internet</b>Mientras no vuelva, no vas a recibir pedidos nuevos.</span></div>` : ''}
    ${open ? '' : `<div class="notice warn"><span>⏸️</span><span><b>Tu local figura cerrado</b>Los clientes no pueden pedirte. Activá el interruptor de arriba para abrir.</span></div>`}
    <div class="board">
      <section class="col"><h2>Nuevos <span class="count ${p.length ? 'on' : ''}">${p.length}</span></h2>${p.map(card).join('') || '<div class="none">Cuando entre un pedido va a sonar y aparecer acá.</div>'}</section>
      <section class="col"><h2>En cocina <span class="count">${c.length}</span></h2>${c.map(card).join('') || '<div class="none">Sin pedidos en preparación.</div>'}</section>
      <section class="col"><h2>Listos para retirar <span class="count">${r.length}</span></h2>${r.map(card).join('') || '<div class="none">Nada esperando al conductor.</div>'}</section>
    </div>
    <section class="done"><h2>Terminados hoy <span class="count">${d.length}</span></h2>
      ${sold.length ? `<p class="mute small" style="margin-bottom:8px">Vendiste ${money(sold.reduce((s, o) => s + o.subtotal, 0))} en ${sold.length} pedido${sold.length > 1 ? 's' : ''}.</p>` : ''}
      ${d.map(o => `<div class="done-row"><span><b>${code(o)}</b> · ${esc(o.customer)} · ${o.items.reduce((s, i) => s + i.qty, 0)} producto(s) · ${money(o.subtotal)}</span><span>${doneLabel(o)}</span></div>`).join('') || '<p class="mute small">Todavía no hay pedidos terminados.</p>'}
    </section>
  </main>`;
  tick(); secs--;
}

const doneLabel = o => o.status === 'entregado' ? 'Entregado ✓' : o.status === 'recogido' ? 'En camino al cliente'
  : o.kitchen === 'rechazado' ? 'Lo rechazaste' : o.kitchen === 'sin_respuesta' ? 'Cancelado: no se aceptó a tiempo' : 'Cancelado';
function payLine(o) {
  if (o.method === 'efectivo') return `💵 <b>El conductor te paga ${money(o.subtotal)}</b> en efectivo al retirar.`;
  return o.collector === 'local' ? `💳 <b>Pagado con tarjeta.</b> ${money(o.subtotal)} se acreditan en tu Mercado Pago. No le cobres al conductor.`
    : `💳 <b>Pagado con tarjeta.</b> Ringcon Go te liquida ${money(o.subtotal)}. No le cobres al conductor.`;
}
function driverLine(o) {
  if (o.driver) return `🛵 <b>${esc(o.driver.name)}</b>${o.driver.vehicle ? ` · ${esc(o.driver.vehicle)}` : ''}${o.status === 'en_local' ? ' · <b>ya está en el local</b>' : ' · viene a retirarlo'}`;
  return o.kitchen === 'pendiente' ? '' : '🛵 Buscando conductor…';
}
function card(o) {
  const k = o.kitchen, id = esc(o.id);
  const btn = (to, label, cls) => `<button class="btn ${cls}" data-act="adv" data-id="${id}" data-to="${to}">${label}</button>`;
  return `<article class="card order ${k === 'pendiente' ? 'ring' : ''}">
    <div class="o-head"><b>${code(o)}</b><span>${hhmm(o.at)}</span><span>${esc(o.customer)}</span></div>
    ${k === 'pendiente' && o.deadline ? `<div class="countdown" data-deadline="${Number(o.deadline)}">Si no lo aceptás se cancela en <b>–</b></div>` : ''}
    <ul class="items">${o.items.map(i => `<li><b>${i.qty}×</b> ${esc(i.name)}</li>`).join('')}</ul>
    ${o.notes ? `<p class="note">📝 ${esc(o.notes)}</p>` : ''}
    <p class="line">${payLine(o)}</p>
    ${driverLine(o) ? `<p class="line">${driverLine(o)}</p>` : ''}
    ${k === 'pendiente' ? btn('aceptado', 'Aceptar pedido', 'primary') + `<button class="btn ghost" data-act="reject" data-id="${id}">No puedo tomarlo</button>`
      : k === 'aceptado' ? btn('preparando', 'En preparación', 'primary') + btn('listo', 'Listo para despachar', 'ghost')
      : k === 'preparando' ? btn('listo', 'Listo para despachar', 'success') : ''}
  </article>`;
}

/* ─────────── acciones ─────────── */
async function advance(t, to, nota) {
  t.disabled = true;
  try { await api.bizAdvance({ orderId: t.dataset.id, to, ...(nota ? { nota } : {}) }); }
  catch (e) { toast(e.message, 'err'); t.disabled = false; }
}
const A = {
  sound: () => enableSound(),
  logout: () => signOut(auth),
  adv: t => advance(t, t.dataset.to),
  reject: t => {
    const nota = prompt('¿Por qué no podés tomarlo? El cliente lo va a leer.', 'Nos quedamos sin stock');
    if (nota === null) return;
    advance(t, 'rechazado', nota.trim());
  },
  open: async t => {
    const open = !(state.biz && state.biz.open !== false);
    if (!open && !confirm('¿Cerrar el local? Los clientes no van a poder pedirte hasta que lo abras de nuevo.')) return;
    t.disabled = true;
    try { await api.bizSetOpen({ open }); toast(open ? 'Local abierto' : 'Local cerrado'); }
    catch (e) { toast(e.message, 'err'); t.disabled = false; }
  }
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) f(t, e); });
document.addEventListener('submit', async e => {
  if (e.target.id !== 'f-local') return;
  e.preventDefault();
  try { await signInWithEmailAndPassword(auth, $('#em').value.trim(), $('#pw').value); }
  catch { toast('Email o contraseña incorrectos', 'err'); }
});

/* ─────────── datos en vivo ─────────── */
function onOrders() {
  const ids = pending().map(o => o.id);
  if (seen && ids.some(id => !seen.has(id))) { alertNew(); toast('¡Entró un pedido nuevo!'); }
  seen = new Set(ids);
}
function stop() { subs.forEach(u => u()); subs = []; seen = null; Object.assign(state, { bizId: null, biz: null, orders: {}, connected: false, wasConnected: false }); }

onAuthStateChanged(auth, u => {
  stop();
  if (!u || u.isAnonymous) { state.step = 'login'; render(); return; }
  state.step = 'loading'; render();
  subs.push(onValue(ref(db, `bizUsers/${u.uid}`), s => {
    const bizId = s.val();
    if (!bizId) { toast('Esta cuenta no es de un local.', 'err'); signOut(auth); return; }
    if (bizId === state.bizId) return;
    state.bizId = bizId;
    subs.push(onValue(ref(db, `catalog/${bizId}`), c => { state.biz = c.val() || {}; state.step = 'board'; render(); }));
    subs.push(onValue(ref(db, `bizOrders/${bizId}`), o => { state.orders = o.val() || {}; onOrders(); if (state.step === 'board') render(); },
      () => toast('No pudimos leer los pedidos. Volvé a entrar.', 'err')));
    subs.push(onValue(ref(db, '.info/connected'), c => { state.connected = c.val() === true; if (state.connected) state.wasConnected = true; if (state.step === 'board') render(); }));
    subs.push(onValue(ref(db, '.info/serverTimeOffset'), c => { state.offset = c.val() || 0; }));
  }, () => { toast('Esta cuenta no es de un local.', 'err'); signOut(auth); }));
});
render();
