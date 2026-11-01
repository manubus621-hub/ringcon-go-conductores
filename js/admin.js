/* Panel de administración Ringcon Go: padrón, verificación de conductores y pedidos */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set, remove, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { FIREBASE, REGION } from './config.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const date = ms => ms ? new Date(ms).toLocaleDateString('es-AR') : '—';
const when = ms => ms ? new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
let toastT;
function toast(msg, type) { const t = $('#toast'); t.textContent = msg; t.className = 'on ' + (type || ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3800); }

if (FIREBASE.apiKey === 'COMPLETAR') {
  $('#app').innerHTML = '<main class="center"><div class="panel"><h1>Falta configurar</h1><p class="sub">Completá js/config.js con los datos de tu proyecto de Firebase.</p></div></main>';
  throw new Error('Falta completar js/config.js');
}
const fb = initializeApp(FIREBASE);
const auth = getAuth(fb), db = getDatabase(fb), fns = getFunctions(fb, REGION);
const call = name => async data => {
  try { return (await httpsCallable(fns, name)(data)).data; }
  catch (e) { throw new Error(e.message && !/^internal$/i.test(e.message) ? e.message : 'Algo salió mal.'); }
};
const api = { getDriverDocs: call('getDriverDocs'), reviewDriver: call('reviewDriver'), cancelOrder: call('cancelOrder') };

const ST = { docs_pendientes: ['Sin fotos', 'wait'], en_revision: ['Para revisar', 'wait'], aprobado: ['Aprobado', 'ok'], rechazado: ['Rechazado', 'bad'], suspendido: ['Suspendido', 'bad'] };
const OS = { pago_pendiente: 'Esperando pago', nuevo: 'Buscando conductor', aceptado: 'Aceptado', en_local: 'En el local', recogido: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado' };
const state = { tab: 'solicitudes', drivers: {}, padron: {}, orders: {}, docs: {}, editing: null };
let subs = [];

function login() {
  $('#app').innerHTML = `<main class="center"><div class="panel">
    <h1>Administración</h1><p class="sub">Solo cuentas autorizadas.</p>
    <form id="f-admin">
      <label class="field">Email<input id="em" type="email" autocomplete="username" required></label>
      <label class="field">Contraseña<input id="pw" type="password" autocomplete="current-password" required></label>
      <button class="btn primary">Entrar</button>
    </form></div></main>`;
}

function render() {
  const pend = Object.values(state.drivers).filter(d => d.status === 'en_revision').length;
  const tabs = [['solicitudes', `Solicitudes${pend ? ` (${pend})` : ''}`], ['conductores', 'Conductores'], ['padron', 'Padrón'], ['pedidos', 'Pedidos']];
  $('#app').innerHTML = `
  <header class="top"><div class="top-in"><div class="who"><b>Ringcon Go · Admin</b><small>${esc(auth.currentUser.email)}</small></div>
    <button class="icon-btn" data-act="logout" aria-label="Cerrar sesión">⎋</button></div></header>
  <main class="wrap">
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${state.tab === k}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
    <section id="view">${({ solicitudes: vSolicitudes, conductores: vConductores, padron: vPadron, pedidos: vPedidos })[state.tab]()}</section>
  </main>`;
}

const driversWithId = () => Object.entries(state.drivers).map(([uid, d]) => ({ uid, ...d }));

function vSolicitudes() {
  const list = driversWithId().filter(d => d.status === 'en_revision').sort((a, b) => a.submittedAt - b.submittedAt);
  if (!list.length) return '<div class="empty"><span class="em">✅</span>No hay identidades para revisar.</div>';
  return list.map(d => {
    const p = state.padron[d.dni] || {}, docs = state.docs[d.uid];
    return `<div class="card">
      <span class="badge wait">Enviado ${when(d.submittedAt)}</span>
      <h3>${esc(d.nombre)} ${esc(d.apellido)}</h3>
      <div class="kv"><span>DNI</span><b>${esc(d.dni)}</b></div>
      <div class="kv"><span>Nacimiento (padrón)</span><b>${esc(p.nacimiento || '—')}</b></div>
      <div class="kv"><span>Vehículo</span><b>${esc([d.vehiculo, d.patente].filter(Boolean).join(' · ') || '—')}</b></div>
      <div class="kv"><span>Licencia vence</span><b>${date(d.licenciaVence)}${d.licenciaVence > Date.now() ? '' : ' ⚠️ vencida'}</b></div>
      <div class="kv"><span>Teléfono</span><b>${esc(d.telefono || '—')}</b></div>
      ${docs ? `<div class="docs">${[['dni_frente', 'DNI frente'], ['dni_dorso', 'DNI dorso'], ['selfie', 'Selfie']].map(([k, l]) =>
        `<figure>${docs[k] ? `<img src="${docs[k]}" alt="${l}" data-act="zoom">` : '<div class="empty">Falta</div>'}<figcaption>${l}</figcaption></figure>`).join('')}</div>
        <p class="small mute">Revisá que el nombre, el DNI y la fecha de nacimiento de la foto coincidan con el padrón, y que la selfie sea la misma persona.</p>`
      : `<button class="btn ghost" style="margin-top:12px" data-act="docs" data-uid="${esc(d.uid)}">Ver fotos</button>`}
      <div class="actions">
        <button class="btn success" data-act="review" data-uid="${esc(d.uid)}" data-a="aprobar" ${docs ? '' : 'disabled'}>Aprobar</button>
        <button class="btn ghost" data-act="review" data-uid="${esc(d.uid)}" data-a="rechazar">Pedir fotos de nuevo</button>
      </div>
    </div>`;
  }).join('');
}

function vConductores() {
  const list = driversWithId().sort((a, b) => (a.apellido || '').localeCompare(b.apellido || ''));
  if (!list.length) return '<div class="empty"><span class="em">🛵</span>Todavía no hay conductores registrados.</div>';
  return `<div class="card scroll"><table><thead><tr><th>Conductor</th><th>DNI</th><th>Licencia</th><th>Estado</th><th></th></tr></thead><tbody>
    ${list.map(d => { const [l, c] = ST[d.status] || [d.status, 'wait']; return `<tr>
      <td><b>${esc(d.nombre)} ${esc(d.apellido)}</b><br><span class="mute small">${esc([d.vehiculo, d.patente].filter(Boolean).join(' · '))}</span></td>
      <td>${esc(d.dni)}</td><td>${date(d.licenciaVence)}</td><td><span class="badge ${c}">${l}</span></td>
      <td>${d.status === 'aprobado' ? `<button class="btn ghost sm" data-act="review" data-uid="${esc(d.uid)}" data-a="suspender">Suspender</button>`
        : d.status === 'suspendido' ? `<button class="btn ghost sm" data-act="review" data-uid="${esc(d.uid)}" data-a="aprobar">Reactivar</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function vPadron() {
  const e = state.editing ? { dni: state.editing, ...state.padron[state.editing] } : {};
  const lic = e.licenciaVence ? new Date(e.licenciaVence).toISOString().slice(0, 10) : '';
  const list = Object.entries(state.padron).sort((a, b) => (a[1].apellido || '').localeCompare(b[1].apellido || ''));
  return `<div class="card">
    <h3 style="margin-bottom:12px">${state.editing ? 'Editar' : 'Agregar'} conductor habilitado</h3>
    <form id="f-padron">
      <div class="row2">
        <label class="field">DNI<input id="p-dni" inputmode="numeric" required pattern="[0-9]{7,8}" maxlength="8" value="${esc(e.dni || '')}" ${state.editing ? 'readonly' : ''}></label>
        <label class="field">Fecha de nacimiento<input id="p-nac" type="date" required value="${esc(e.nacimiento || '')}"></label>
      </div>
      <div class="row2">
        <label class="field">Nombre(s)<input id="p-nom" required maxlength="60" value="${esc(e.nombre || '')}"></label>
        <label class="field">Apellido(s)<input id="p-ape" required maxlength="60" value="${esc(e.apellido || '')}"></label>
      </div>
      <div class="row2">
        <label class="field">Vehículo<input id="p-veh" maxlength="40" placeholder="Moto Honda Wave" value="${esc(e.vehiculo || '')}"></label>
        <label class="field">Patente<input id="p-pat" maxlength="10" placeholder="A123BCD" value="${esc(e.patente || '')}"></label>
      </div>
      <div class="row2">
        <label class="field">Teléfono<input id="p-tel" type="tel" maxlength="20" value="${esc(e.telefono || '')}"></label>
        <label class="field">Licencia vence<input id="p-lic" type="date" required value="${lic}"></label>
      </div>
      <label class="field" style="display:flex;gap:10px;align-items:center"><input id="p-act" type="checkbox" style="width:auto;margin:0" ${e.activo === false ? '' : 'checked'}> Habilitado</label>
      <div class="actions"><button class="btn primary">Guardar</button>${state.editing ? '<button type="button" class="btn ghost" data-act="cancel-edit">Cancelar</button>' : ''}</div>
    </form>
    <p class="small mute" style="margin-top:12px">Cargá los datos exactamente como figuran en el DNI: el conductor tiene que confirmar apellido y fecha de nacimiento para crear su cuenta.</p>
  </div>
  ${list.length ? `<div class="card scroll"><table><thead><tr><th>DNI</th><th>Nombre</th><th>Licencia</th><th>Cuenta</th><th></th></tr></thead><tbody>
    ${list.map(([dni, p]) => `<tr><td>${esc(dni)}</td><td>${esc(p.apellido)}, ${esc(p.nombre)}${p.activo === false ? ' <span class="badge bad">baja</span>' : ''}</td><td>${date(p.licenciaVence)}</td>
      <td>${p.uid ? '<span class="badge ok">Creada</span>' : '<span class="mute small">Sin cuenta</span>'}</td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-act="edit" data-dni="${esc(dni)}">Editar</button>${p.uid ? '' : ` <button class="btn ghost sm" data-act="del" data-dni="${esc(dni)}">Borrar</button>`}</td></tr>`).join('')}
  </tbody></table></div>` : ''}`;
}

function vPedidos() {
  const list = Object.values(state.orders).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  if (!list.length) return '<div class="empty"><span class="em">📦</span>Sin pedidos todavía.</div>';
  return `<div class="card scroll"><table><thead><tr><th>Pedido</th><th>Local</th><th>Cliente</th><th>Conductor</th><th>Total</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>
    ${list.map(o => `<tr><td>#${esc(o.id.slice(-5).toUpperCase())}<br><span class="mute small">${when(o.createdAt)}</span></td>
      <td>${esc(o.business.name)}</td><td>${esc(o.customer.name)}</td><td>${esc(o.driver ? o.driver.name : '—')}</td>
      <td>${money(o.totals.total)}</td><td>${o.payment.method === 'tarjeta' ? `💳 ${esc(o.payment.status)}` : '💵 efectivo'}${o.payment.flag ? ` <span class="badge bad">${esc(o.payment.flag)}</span>` : ''}</td>
      <td>${esc(OS[o.status] || o.status)}</td>
      <td>${['entregado', 'cancelado'].includes(o.status) ? '' : `<button class="btn ghost sm" data-act="cancel-order" data-id="${esc(o.id)}">Cancelar</button>`}</td></tr>`).join('')}
  </tbody></table></div>`;
}

document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'f-admin') {
    try { await signInWithEmailAndPassword(auth, $('#em').value.trim(), $('#pw').value); }
    catch { toast('Email o contraseña incorrectos', 'err'); }
  }
  if (e.target.id === 'f-padron') {
    const dni = $('#p-dni').value.replace(/\D/g, ''), prev = state.padron[dni] || {};
    const p = {
      nombre: $('#p-nom').value.trim(), apellido: $('#p-ape').value.trim(), nacimiento: $('#p-nac').value,
      telefono: $('#p-tel').value.trim(), vehiculo: $('#p-veh').value.trim(), patente: $('#p-pat').value.trim().toUpperCase(),
      licenciaVence: new Date($('#p-lic').value + 'T23:59:59').getTime(), activo: $('#p-act').checked,
      ...(prev.uid ? { uid: prev.uid } : {})
    };
    if (!/^\d{7,8}$/.test(dni)) { toast('El DNI tiene 7 u 8 números', 'err'); return; }
    if (!state.editing && state.padron[dni]) { toast('Ese DNI ya está en el padrón', 'err'); return; }
    try { await set(ref(db, `padron/${dni}`), p); state.editing = null; toast('Guardado'); render(); }
    catch { toast('No se pudo guardar. Revisá los datos.', 'err'); }
  }
});

const A = {
  logout: () => signOut(auth),
  tab: t => { state.tab = t.dataset.tab; render(); },
  docs: async t => {
    t.disabled = true; t.textContent = 'Cargando fotos…';
    try { state.docs[t.dataset.uid] = await api.getDriverDocs({ uid: t.dataset.uid }); render(); }
    catch (e) { toast(e.message, 'err'); t.disabled = false; t.textContent = 'Ver fotos'; }
  },
  review: async t => {
    const a = t.dataset.a;
    let nota = '';
    if (a !== 'aprobar') { nota = prompt(a === 'rechazar' ? '¿Qué tiene que corregir? (lo ve el conductor)' : 'Motivo de la suspensión (lo ve el conductor)') ?? null; if (nota === null) return; }
    t.disabled = true;
    try { await api.reviewDriver({ uid: t.dataset.uid, action: a, nota }); delete state.docs[t.dataset.uid]; toast('Listo'); }
    catch (e) { toast(e.message, 'err'); t.disabled = false; }
  },
  edit: t => { state.editing = t.dataset.dni; render(); scrollTo(0, 0); },
  'cancel-edit': () => { state.editing = null; render(); },
  del: async t => { if (!confirm(`¿Borrar el DNI ${t.dataset.dni} del padrón?`)) return; try { await remove(ref(db, `padron/${t.dataset.dni}`)); } catch { toast('No se pudo borrar', 'err'); } },
  'cancel-order': async t => {
    if (!confirm('¿Cancelar este pedido? Si se pagó con tarjeta, se devuelve el dinero.')) return;
    try { await api.cancelOrder({ orderId: t.dataset.id }); toast('Pedido cancelado'); } catch (e) { toast(e.message, 'err'); }
  },
  zoom: t => { const z = document.createElement('div'); z.id = 'zoom'; z.innerHTML = `<img src="${t.src}" alt="">`; z.onclick = () => z.remove(); document.body.append(z); }
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) f(t, e); });

// Re-render sin pisar un formulario a medio completar.
const refresh = () => { if (state.tab === 'padron' && document.activeElement && document.activeElement.closest('#f-padron')) return; render(); };

onAuthStateChanged(auth, async u => {
  subs.forEach(f => f()); subs = [];
  if (!u || u.isAnonymous) { login(); return; }
  const ok = (await get(ref(db, `admins/${u.uid}`)).catch(() => null))?.val() === true;
  if (!ok) { await signOut(auth); toast('Esta cuenta no es administradora', 'err'); return; }
  render();
  subs.push(onValue(ref(db, 'drivers'), s => { state.drivers = s.val() || {}; refresh(); }));
  subs.push(onValue(ref(db, 'padron'), s => { state.padron = s.val() || {}; refresh(); }));
  subs.push(onValue(ref(db, 'orders'), s => { state.orders = s.val() || {}; if (state.tab === 'pedidos') refresh(); }));
});
