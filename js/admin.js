/* Panel de administración Ringcon Go: padrón, verificación de conductores y pedidos */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set, update, remove, get, query, limitToLast } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { FIREBASE, API_URL } from './config.js';

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
const api = { getDriverDocs: call('getDriverDocs'), reviewDriver: call('reviewDriver'), cancelOrder: call('cancelOrder'), syncDriver: call('syncDriver'),
  ...Object.fromEntries(['getConfig', 'bizCreateUser', 'bizRemoveUser', 'mpConnectLink', 'mpDisconnect', 'mpInfo', 'settleDriver'].map(n => [n, call(n)])) };

const ST = { docs_pendientes: ['Sin fotos', 'wait'], en_revision: ['Para revisar', 'wait'], aprobado: ['Aprobado', 'ok'], rechazado: ['Rechazado', 'bad'], suspendido: ['Suspendido', 'bad'] };
const OS = { pago_pendiente: 'Esperando pago', nuevo: 'Buscando conductor', aceptado: 'Aceptado', en_local: 'En el local', recogido: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado' };
const state = { tab: 'solicitudes', drivers: {}, padron: {}, orders: {}, docs: {}, editing: null, catalog: {}, biz: null, item: null, towns: {}, town: null, staff: {}, split: null, mpLink: null, mpInfo: {}, settlements: {} };
// Pueblos: towns/{id} con name, lat, lon, km y order. Se cargan en la pestaña Pueblos.
const townName = id => (state.towns[id] && state.towns[id].name) || '—';
const townOpts = sel => {
  const list = Object.entries(state.towns).map(([id, t]) => ({ id, ...t })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return list.length ? list.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
    : '<option value="">Primero cargá un pueblo en la pestaña Pueblos</option>';
};
const byOrder = o => Object.entries(o || {}).map(([id, v]) => ({ ...v, id })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const slug = s => (String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x') + '-' + Math.random().toString(36).slice(2, 6);
const noTown = id => state.towns[id] ? '' : ' <span class="badge bad">Falta elegir pueblo</span>';
const townSlug = name => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
// Acepta lo que copia Google Maps: "-25.5978, -54.5736".
const coords = v => { const m = String(v).match(/(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)/); if (!m) return null; const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.')); return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null; };
const num = v => Math.max(0, Math.round(Number(String(v).replace(/[^\d]/g, '')) || 0));
let subs = [], watching = {};
// Pedidos y liquidaciones crecen sin techo: se piden recién al abrir su pestaña, y de pedidos solo los últimos.
const ORDERS_SHOWN = 300;
function lazy() {
  if (state.tab === 'pedidos' && !watching.orders) {
    watching.orders = true;
    subs.push(onValue(query(ref(db, 'orders'), limitToLast(ORDERS_SHOWN)), s => { state.orders = s.val() || {}; if (state.tab === 'pedidos') refresh(); }));
  }
  if (state.tab === 'liquidaciones' && !watching.settlements) {
    watching.settlements = true;
    subs.push(onValue(ref(db, 'settlements'), s => { state.settlements = s.val() || {}; if (state.tab === 'liquidaciones') refresh(); }, () => {}));
  }
}
// A qué cuenta de Mercado Pago quedó conectado un local.
async function loadMpInfo(id) {
  try { state.mpInfo[id] = await api.mpInfo({ bizId: id }); if (state.biz === id && state.tab === 'locales') refresh(); } catch {}
}

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
  const tabs = [['solicitudes', `Solicitudes${pend ? ` (${pend})` : ''}`], ['conductores', 'Conductores'], ['padron', 'Padrón'], ['locales', 'Locales'], ['pueblos', 'Pueblos'], ['pedidos', 'Pedidos'], ['liquidaciones', 'Liquidaciones']];
  $('#app').innerHTML = `
  <header class="top"><div class="top-in"><div class="who"><b>Ringcon Go · Admin</b><small>${esc(auth.currentUser.email)}</small></div>
    <button class="icon-btn" data-act="logout" aria-label="Cerrar sesión">⎋</button></div></header>
  <main class="wrap">
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${state.tab === k}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
    <section id="view">${({ solicitudes: vSolicitudes, conductores: vConductores, padron: vPadron, locales: vLocales, pueblos: vPueblos, pedidos: vPedidos, liquidaciones: vLiquidaciones })[state.tab]()}</section>
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
      <label class="field">Pueblo donde trabaja<select id="p-town" required>${townOpts(e.townId)}</select></label>
      <label class="field" style="display:flex;gap:10px;align-items:center"><input id="p-act" type="checkbox" style="width:auto;margin:0" ${e.activo === false ? '' : 'checked'}> Habilitado</label>
      <div class="actions"><button class="btn primary">Guardar</button>${state.editing ? '<button type="button" class="btn ghost" data-act="cancel-edit">Cancelar</button>' : ''}</div>
    </form>
    <p class="small mute" style="margin-top:12px">Cargá los datos exactamente como figuran en el DNI: el conductor tiene que confirmar apellido y fecha de nacimiento para crear su cuenta.</p>
  </div>
  ${list.length ? `<div class="card scroll"><table><thead><tr><th>DNI</th><th>Nombre</th><th>Licencia</th><th>Cuenta</th><th></th></tr></thead><tbody>
    ${list.map(([dni, p]) => `<tr><td>${esc(dni)}</td><td>${esc(p.apellido)}, ${esc(p.nombre)}${p.activo === false ? ' <span class="badge bad">baja</span>' : ''}<br><span class="mute small">${esc(townName(p.townId))}</span>${noTown(p.townId)}</td><td>${date(p.licenciaVence)}</td>
      <td>${p.uid ? '<span class="badge ok">Creada</span>' : '<span class="mute small">Sin cuenta</span>'}</td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-act="edit" data-dni="${esc(dni)}">Editar</button>${p.uid ? '' : ` <button class="btn ghost sm" data-act="del" data-dni="${esc(dni)}">Borrar</button>`}</td></tr>`).join('')}
  </tbody></table></div>` : ''}`;
}

function vPedidos() {
  const list = Object.values(state.orders).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  if (!list.length) return '<div class="empty"><span class="em">📦</span>Sin pedidos todavía.</div>';
  return `<p class="small mute" style="margin-bottom:10px">Se muestran los 100 pedidos más recientes.</p><div class="card scroll"><table><thead><tr><th>Pedido</th><th>Local</th><th>Cliente</th><th>Conductor</th><th>Total</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>
    ${list.map(o => `<tr><td>#${esc(o.id.slice(-5).toUpperCase())}<br><span class="mute small">${when(o.createdAt)}</span></td>
      <td>${esc(o.business.name)}</td><td>${esc(o.customer.name)}</td><td>${esc(o.driver ? o.driver.name : '—')}</td>
      <td>${money(o.totals.total)}</td><td>${o.payment.method === 'tarjeta' ? `💳 ${esc(o.payment.status)}` : '💵 efectivo'}${o.payment.flag ? ` <span class="badge bad">${esc(o.payment.flag)}</span>` : ''}</td>
      <td>${esc(OS[o.status] || o.status)}</td>
      <td>${['entregado', 'cancelado'].includes(o.status) ? '' : `<button class="btn ghost sm" data-act="cancel-order" data-id="${esc(o.id)}">Cancelar</button>`}</td></tr>`).join('')}
  </tbody></table></div>`;
}

/* ─────────── pueblos ─────────── */
function vPueblos() {
  const list = byOrder(state.towns), e = state.town && state.towns[state.town] ? { id: state.town, ...state.towns[state.town] } : null;
  const uses = id => ({ locales: Object.values(state.catalog).filter(b => b.townId === id).length, padron: Object.values(state.padron).filter(p => p.townId === id).length });
  return `<div class="card">
    <h3 style="margin-bottom:12px">${e ? 'Editar pueblo' : 'Agregar pueblo'}</h3>
    <form id="f-town">
      <div class="row2">
        <label class="field">Nombre<input id="t-name" required minlength="2" maxlength="60" value="${esc(e ? e.name : '')}" placeholder="Ej: Puerto Iguazú"></label>
        <label class="field">Radio de entrega (km)<input id="t-km" inputmode="decimal" required value="${esc(e ? e.km : '')}" placeholder="10"></label>
      </div>
      <label class="field">Centro del pueblo (latitud, longitud)<input id="t-center" required value="${e ? esc(`${e.lat}, ${e.lon}`) : ''}" placeholder="-25.5978, -54.5736"></label>
      <p class="small mute" style="margin:-6px 0 14px">En Google Maps, mantené apretado sobre el centro del pueblo (clic derecho en la computadora) y copiá las coordenadas. Se entrega hasta esa distancia del centro.</p>
      <div class="actions"><button class="btn primary">${e ? 'Guardar cambios' : 'Agregar pueblo'}</button>${e ? '<button type="button" class="btn ghost" data-act="town-cancel">Cancelar</button>' : ''}</div>
    </form>
  </div>
  ${list.length ? list.map(t => { const u = uses(t.id); return `<div class="card">
    <h3>📍 ${esc(t.name)}</h3>
    <div class="kv"><span>Centro</span><b>${esc(t.lat)}, ${esc(t.lon)} · <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.lat + ',' + t.lon)}">ver mapa</a></b></div>
    <div class="kv"><span>Radio de entrega</span><b>${esc(t.km)} km</b></div>
    <div class="kv"><span>Locales</span><b>${u.locales}</b></div>
    <div class="kv"><span>Conductores en el padrón</span><b>${u.padron}</b></div>
    <div class="actions">
      <button class="btn primary" data-act="town-edit" data-id="${esc(t.id)}">Editar</button>
      ${u.locales || u.padron ? '' : `<button class="btn ghost" data-act="town-del" data-id="${esc(t.id)}">Borrar</button>`}
    </div></div>`; }).join('') : '<div class="empty"><span class="em">📍</span>Todavía no hay pueblos. Agregá el primero para poder cargar locales y conductores.</div>'}`;
}

async function saveTown() {
  const name = $('#t-name').value.trim().replace(/\s+/g, ' '), c = coords($('#t-center').value), km = Number($('#t-km').value.replace(',', '.'));
  if (name.length < 2) { toast('Escribí el nombre del pueblo', 'err'); return; }
  if (!c) { toast('Pegá el centro como latitud, longitud. Ej: -25.5978, -54.5736', 'err'); return; }
  if (!(km > 0 && km <= 100)) { toast('El radio tiene que estar entre 1 y 100 km', 'err'); return; }
  const isNew = !state.town, id = isNew ? townSlug(name) : state.town;
  if (!id) { toast('El nombre tiene que tener letras o números', 'err'); return; }
  if (isNew && state.towns[id]) { toast('Ese pueblo ya está cargado', 'err'); return; }
  const order = isNew ? Object.values(state.towns).reduce((m, t) => Math.max(m, (t.order ?? 0) + 1), 0) : (state.towns[id].order ?? 0);
  try { await set(ref(db, `towns/${id}`), { name, lat: c.lat, lon: c.lon, km, order }); state.town = null; toast(isNew ? 'Pueblo agregado' : 'Guardado'); render(); }
  catch { toast('No se pudo guardar. Revisá los datos.', 'err'); }
}

/* ─────────── locales y productos ─────────── */
function vLocales() {
  if (state.biz) return vLocal();
  const list = byOrder(state.catalog);
  return `<div class="actions" style="margin:0 0 16px"><button class="btn primary" data-act="biz-new">+ Agregar local</button></div>
  ${list.length ? list.map(b => `<div class="card">
    <span class="badge ${b.open === false ? 'bad' : 'ok'}">${b.open === false ? 'Cerrado' : 'Abierto'}</span>
    <h3>${esc(b.emoji || '🏪')} ${esc(b.name)}</h3>
    <div class="kv"><span>Pueblo</span><b>${esc(townName(b.townId))}${noTown(b.townId)}</b></div>
    <div class="kv"><span>Rubro</span><b>${esc(b.cat || '—')}</b></div>
    <div class="kv"><span>Envío</span><b>${money(b.fee)}</b></div>
    <div class="kv"><span>Productos</span><b>${Object.keys(b.menu || {}).length}</b></div>
    <div class="actions">
      <button class="btn primary" data-act="biz-edit" data-id="${esc(b.id)}">Editar local y productos</button>
      <button class="btn ghost" data-act="biz-toggle" data-id="${esc(b.id)}">${b.open === false ? 'Abrir' : 'Cerrar'}</button>
    </div></div>`).join('') : '<div class="empty"><span class="em">🏪</span>Todavía no hay locales. Agregá el primero.</div>'}`;
}

function vLocal() {
  const isNew = state.biz === 'new', b = isNew ? { open: true, fee: 1500, eta: '25–35 min', emoji: '🍽️' } : (state.catalog[state.biz] || {});
  const items = byOrder(b.menu), it = state.item && state.item !== 'new' ? (b.menu || {})[state.item] || {} : { available: true };
  return `<button class="btn ghost sm" data-act="biz-back" style="margin-bottom:14px">← Volver a locales</button>
  <div class="card">
    <h3 style="margin-bottom:12px">${isNew ? 'Nuevo local' : 'Datos del local'}</h3>
    <form id="f-biz">
      <div class="row2">
        <label class="field">Nombre<input id="b-name" required maxlength="60" value="${esc(b.name || '')}" placeholder="Ej: Pizzería Don José"></label>
        <label class="field">Rubro<input id="b-cat" required maxlength="30" value="${esc(b.cat || '')}" placeholder="Ej: Pizza"></label>
      </div>
      <label class="field">Pueblo<select id="b-town" required>${townOpts(b.townId)}</select></label>
      <div class="row2">
        <label class="field">Emoji<input id="b-emoji" maxlength="4" value="${esc(b.emoji || '')}" placeholder="🍕"></label>
        <label class="field">Demora estimada<input id="b-eta" maxlength="20" value="${esc(b.eta || '')}" placeholder="25–35 min"></label>
      </div>
      <div class="row2">
        <label class="field">Costo de envío ($)<input id="b-fee" inputmode="numeric" required value="${esc(b.fee ?? '')}"></label>
        <label class="field">Orden en la lista<input id="b-order" inputmode="numeric" value="${esc(b.order ?? Object.keys(state.catalog).length)}"></label>
      </div>
      <label class="field" style="display:flex;gap:10px;align-items:center"><input id="b-open" type="checkbox" style="width:auto;margin:0" ${b.open === false ? '' : 'checked'}> Abierto (recibe pedidos)</label>
      <div class="actions"><button class="btn primary">${isNew ? 'Crear local' : 'Guardar cambios'}</button>
        ${isNew ? '' : '<button type="button" class="btn ghost" data-act="biz-del">Borrar local</button>'}</div>
    </form>
  </div>
  ${isNew ? '' : vAccess(b)}
  ${isNew ? '<p class="small mute">Creá el local y después vas a poder cargar sus productos.</p>' : `
  <div class="card">
    <h3 style="margin-bottom:12px">${state.item === 'new' ? 'Nuevo producto' : state.item ? 'Editar producto' : 'Agregar producto'}</h3>
    <form id="f-item">
      <div class="row2">
        <label class="field">Nombre<input id="i-name" required maxlength="60" value="${esc(it.name || '')}" placeholder="Ej: Muzzarella grande"></label>
        <label class="field">Precio ($)<input id="i-price" inputmode="numeric" required value="${esc(it.price ?? '')}" placeholder="12000"></label>
      </div>
      <div class="row2">
        <label class="field">Descripción<input id="i-desc" maxlength="120" value="${esc(it.desc || '')}" placeholder="Ej: 8 porciones"></label>
        <label class="field">Emoji<input id="i-emoji" maxlength="4" value="${esc(it.emoji || '')}" placeholder="🍕"></label>
      </div>
      <label class="field" style="display:flex;gap:10px;align-items:center"><input id="i-av" type="checkbox" style="width:auto;margin:0" ${it.available === false ? '' : 'checked'}> Disponible</label>
      <div class="actions"><button class="btn primary">${state.item && state.item !== 'new' ? 'Guardar producto' : 'Agregar producto'}</button>
        ${state.item ? '<button type="button" class="btn ghost" data-act="item-cancel">Cancelar</button>' : ''}</div>
    </form>
  </div>
  ${items.length ? `<div class="card scroll"><table><thead><tr><th>Producto</th><th>Precio</th><th>Estado</th><th></th></tr></thead><tbody>
    ${items.map(m => `<tr><td>${esc(m.emoji || '')} <b>${esc(m.name)}</b><br><span class="mute small">${esc(m.desc || '')}</span></td>
      <td>${money(m.price)}</td>
      <td>${m.available === false ? '<span class="badge bad">Sin stock</span>' : '<span class="badge ok">Disponible</span>'}</td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-act="item-edit" data-id="${esc(m.id)}">Editar</button>
        <button class="btn ghost sm" data-act="item-toggle" data-id="${esc(m.id)}">${m.available === false ? 'Hay stock' : 'Sin stock'}</button>
        <button class="btn ghost sm" data-act="item-del" data-id="${esc(m.id)}">Borrar</button></td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">Este local todavía no tiene productos.</div>'}`}`;
}

// Acceso del local a su panel de pedidos y conexión de su Mercado Pago.
function vAccess(b) {
  const id = state.biz, staff = Object.entries(state.staff[id] || {}), panelUrl = new URL('local.html', location.href).href, info = state.mpInfo[id];
  if (b.mp === true && !info) { state.mpInfo[id] = {}; loadMpInfo(id); }
  // El enlace se muestra hasta que la conexión cambia de estado (el dueño autorizó).
  const link = state.mpLink && state.mpLink.bizId === id && state.mpLink.was === (b.mp ?? null) ? state.mpLink.url : '';
  const wa = `Para cobrar con tarjeta en Ringcon Go, abrí este enlace con la cuenta de Mercado Pago de ${b.name} y tocá Autorizar: ${link}`;
  return `<div class="card">
    <h3 style="margin-bottom:6px">Panel de pedidos del local</h3>
    <p class="small mute" style="margin-bottom:12px">Con una cuenta, el local recibe cada pedido con alerta sonora y lo acepta desde <b>${esc(panelUrl)}</b>. Los conductores lo ven recién cuando el local acepta; si no responde en 10 minutos, se cancela solo. Sin cuentas, los pedidos van directo a los conductores.</p>
    ${staff.map(([uid, email]) => `<div class="kv"><span>${esc(email)}</span><b><button class="btn ghost sm" data-act="staff-del" data-uid="${esc(uid)}">Quitar</button></b></div>`).join('')}
    <form id="f-staff" style="margin-top:12px">
      <div class="row2">
        <label class="field">Email para el local<input id="s-email" type="email" required maxlength="120" autocomplete="off"></label>
        <label class="field">Contraseña (mínimo 8)<input id="s-pass" required minlength="8" maxlength="64" autocomplete="off"></label>
      </div>
      <div class="actions"><button class="btn primary">Crear acceso</button></div>
    </form>
  </div>
  <div class="card">
    <h3 style="margin-bottom:6px">Cobro con tarjeta (Mercado Pago)</h3>
    ${state.split === false ? '<p class="small mute">El cobro por local no está activado: faltan MP_CLIENT_ID y MP_CLIENT_SECRET en Vercel. Mientras tanto, la tarjeta la cobra la cuenta de la plataforma.</p>' : `
    <p class="small mute" style="margin-bottom:12px">El dueño del local autoriza una sola vez con su cuenta de Mercado Pago. Desde ahí cada pago con tarjeta entra a su cuenta y la parte de Ringcon Go (comisión, envío y propina) se acredita sola.</p>
    ${b.mp === true && info && info.account ? `<div class="kv"><span>Cuenta que cobra</span><b>${esc(info.account)}</b></div><p class="small mute" style="margin:6px 0 10px">Confirmá con el dueño que esa es su cuenta de Mercado Pago: ahí entran los pagos con tarjeta de este local.</p>` : ''}
    <div class="kv"><span>Estado</span><b>${b.mp === true ? '<span class="badge ok">Conectado</span>' : b.mp === false ? '<span class="badge bad">Se desconectó: hay que conectarlo de nuevo</span>' : '<span class="badge wait">Sin conectar: solo efectivo</span>'}</b></div>
    ${link ? `<label class="field" style="margin-top:12px">Enlace para el dueño del local (sirve 2 días y una sola vez)<input id="mp-link" readonly value="${esc(link)}"></label>
    <div class="actions"><button class="btn primary" data-act="mp-copy">Copiar enlace</button><a class="btn ghost" style="color:inherit;text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(wa)}">Enviar por WhatsApp</a></div>`
    : `<div class="actions"><button class="btn primary" data-act="mp-link">Generar enlace para ${b.mp == null ? 'conectar' : 'reconectar'}</button>${b.mp == null ? '' : '<button class="btn ghost" data-act="mp-off">Desconectar</button>'}</div>`}`}
  </div>`;
}

/* ─────────── liquidaciones de conductores ─────────── */
const owed = st => st.fromPlatform ?? (st.method === 'tarjeta' ? st.earning || 0 : 0);
function vLiquidaciones() {
  const rows = driversWithId().map(d => {
    const open = Object.values(state.settlements[d.uid] || {}).filter(st => !st.paidAt);
    const debe = open.reduce((t, st) => t + owed(st), 0), rinde = open.reduce((t, st) => t + (st.toPlatform || 0), 0);
    return { ...d, n: open.length, debe, rinde, net: debe - rinde };
  }).filter(r => r.n).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const intro = '<p class="small mute" style="margin-bottom:12px">Mercado Pago divide cada pago con tarjeta entre el local y Ringcon Go. La parte del conductor (envío y propina) queda acá como saldo a su favor, y se le descuenta la comisión de los pedidos que cobró en efectivo. Transferile el neto y marcá la liquidación.</p>';
  if (!rows.length) return intro + '<div class="empty"><span class="em">🧾</span>No hay entregas sin liquidar.</div>';
  return `${intro}<div class="card scroll"><table><thead><tr><th>Conductor</th><th>Entregas</th><th>A su favor (tarjeta)</th><th>Rinde (efectivo)</th><th>Neto</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r.nombre)} ${esc(r.apellido)}</b><br><span class="mute small">${esc(townName(r.townId))}</span></td>
      <td>${r.n}</td><td>${money(r.debe)}</td><td>${money(r.rinde)}</td>
      <td><b>${r.net >= 0 ? `Le transferís ${money(r.net)}` : `Te transfiere ${money(-r.net)}`}</b></td>
      <td><button class="btn ghost sm" data-act="settle" data-uid="${esc(r.uid)}">Marcar liquidado</button></td></tr>`).join('')}
  </tbody></table></div>`;
}

async function saveBiz() {
  const name = $('#b-name').value.trim(), cat = $('#b-cat').value.trim();
  if (name.length < 2 || !cat) { toast('Completá nombre y rubro', 'err'); return; }
  const townId = $('#b-town').value;
  if (!townId) { toast('Elegí el pueblo del local', 'err'); return; }
  const data = {
    name, cat, townId, emoji: $('#b-emoji').value.trim() || '🍽️', eta: $('#b-eta').value.trim() || '25–35 min',
    fee: num($('#b-fee').value), order: num($('#b-order').value), open: $('#b-open').checked
  };
  const isNew = state.biz === 'new', id = isNew ? slug(name) : state.biz;
  try { await update(ref(db, `catalog/${id}`), data); state.biz = id; toast(isNew ? 'Local creado. Ahora cargá sus productos.' : 'Guardado'); render(); }
  catch { toast('No se pudo guardar. Revisá los datos.', 'err'); }
}

async function saveItem() {
  const name = $('#i-name').value.trim(), price = num($('#i-price').value);
  if (name.length < 2 || !price) { toast('Completá nombre y precio', 'err'); return; }
  const menu = (state.catalog[state.biz] || {}).menu || {};
  const id = state.item && state.item !== 'new' ? state.item : slug(name);
  const data = {
    name, price, desc: $('#i-desc').value.trim(), emoji: $('#i-emoji').value.trim() || '🍽️',
    available: $('#i-av').checked, order: menu[id] ? menu[id].order ?? 0 : Object.keys(menu).length
  };
  try { await set(ref(db, `catalog/${state.biz}/menu/${id}`), data); state.item = null; toast('Producto guardado'); render(); }
  catch { toast('No se pudo guardar el producto.', 'err'); }
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
      townId: $('#p-town').value,
      ...(prev.uid ? { uid: prev.uid } : {})
    };
    if (!/^\d{7,8}$/.test(dni)) { toast('El DNI tiene 7 u 8 números', 'err'); return; }
    if (!p.townId) { toast('Elegí el pueblo donde trabaja', 'err'); return; }
    if (!state.editing && state.padron[dni]) { toast('Ese DNI ya está en el padrón', 'err'); return; }
    try { await set(ref(db, `padron/${dni}`), p); }
    catch { toast('No se pudo guardar. Revisá los datos.', 'err'); return; }
    state.editing = null; render();
    // Si ya tiene cuenta, el pueblo y la licencia del padrón pasan a su cuenta.
    if (!p.uid) { toast('Guardado'); return; }
    try { await api.syncDriver({ dni }); toast('Guardado. La cuenta del conductor ya está actualizada.'); }
    catch { toast('Guardado en el padrón, pero no se pudo actualizar la cuenta del conductor. Probá guardar de nuevo.', 'err'); }
  }
  if (e.target.id === 'f-town') await saveTown();
  if (e.target.id === 'f-staff') {
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try { await api.bizCreateUser({ bizId: state.biz, email: $('#s-email').value.trim(), password: $('#s-pass').value }); toast('Acceso creado. Pasale el email y la contraseña al local.'); render(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  }
  if (e.target.id === 'f-biz') await saveBiz();
  if (e.target.id === 'f-item') await saveItem();
});

const A = {
  logout: () => signOut(auth),
  tab: t => { state.tab = t.dataset.tab; lazy(); render(); },
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
  'staff-del': async t => {
    if (!confirm('¿Quitar este acceso? Esa cuenta deja de poder entrar al panel del local.')) return;
    t.disabled = true;
    try { await api.bizRemoveUser({ bizId: state.biz, uid: t.dataset.uid }); toast('Acceso quitado'); } catch (e) { toast(e.message, 'err'); t.disabled = false; }
  },
  'mp-link': async t => {
    t.disabled = true;
    try { state.mpLink = { bizId: state.biz, was: (state.catalog[state.biz] || {}).mp ?? null, url: (await api.mpConnectLink({ bizId: state.biz })).url }; render(); } catch (e) { toast(e.message, 'err'); t.disabled = false; }
  },
  'mp-copy': async () => {
    const i = $('#mp-link');
    try { await navigator.clipboard.writeText(i.value); toast('Enlace copiado'); } catch { i.select(); toast('Seleccionado: copialo con Ctrl+C o manteniéndolo apretado'); }
  },
  'mp-off': async t => {
    if (!confirm('¿Desconectar Mercado Pago de este local? Va a quedar solo con efectivo hasta que se conecte de nuevo.')) return;
    t.disabled = true;
    try { await api.mpDisconnect({ bizId: state.biz }); state.mpLink = null; delete state.mpInfo[state.biz]; toast('Mercado Pago desconectado'); } catch (e) { toast(e.message, 'err'); t.disabled = false; }
  },
  settle: async t => {
    if (!confirm('¿Ya hiciste (o recibiste) la transferencia? Las entregas de este conductor quedan marcadas como liquidadas.')) return;
    t.disabled = true;
    try { const r = await api.settleDriver({ uid: t.dataset.uid }); toast(`Liquidado: ${r.count} entrega(s)`); } catch (e) { toast(e.message, 'err'); t.disabled = false; }
  },
  'town-edit': t => { state.town = t.dataset.id; render(); scrollTo(0, 0); },
  'town-cancel': () => { state.town = null; render(); },
  'town-del': async t => {
    if (!confirm(`¿Borrar el pueblo ${townName(t.dataset.id)}?`)) return;
    try { await remove(ref(db, `towns/${t.dataset.id}`)); toast('Pueblo borrado'); } catch { toast('No se pudo borrar', 'err'); }
  },
  'cancel-edit': () => { state.editing = null; render(); },
  del: async t => { if (!confirm(`¿Borrar el DNI ${t.dataset.dni} del padrón?`)) return; try { await remove(ref(db, `padron/${t.dataset.dni}`)); } catch { toast('No se pudo borrar', 'err'); } },
  'cancel-order': async t => {
    if (!confirm('¿Cancelar este pedido? Si se pagó con tarjeta, se devuelve el dinero.')) return;
    try { await api.cancelOrder({ orderId: t.dataset.id }); toast('Pedido cancelado'); } catch (e) { toast(e.message, 'err'); }
  },
  'biz-new': () => { state.biz = 'new'; state.item = null; render(); scrollTo(0, 0); },
  'biz-edit': t => { state.biz = t.dataset.id; state.item = null; render(); scrollTo(0, 0); },
  'biz-back': () => { state.biz = null; state.item = null; render(); },
  'biz-toggle': async t => {
    const b = state.catalog[t.dataset.id];
    try { await update(ref(db, `catalog/${t.dataset.id}`), { open: b.open === false }); } catch { toast('No se pudo cambiar', 'err'); }
  },
  'biz-del': async () => {
    const b = state.catalog[state.biz];
    if (!confirm(`¿Borrar "${b.name}" y todos sus productos? No se puede deshacer.`)) return;
    try { await remove(ref(db, `catalog/${state.biz}`)); state.biz = null; toast('Local borrado'); render(); } catch { toast('No se pudo borrar', 'err'); }
  },
  'item-edit': t => { state.item = t.dataset.id; render(); scrollTo(0, 0); },
  'item-cancel': () => { state.item = null; render(); },
  'item-toggle': async t => {
    const m = state.catalog[state.biz].menu[t.dataset.id];
    try { await update(ref(db, `catalog/${state.biz}/menu/${t.dataset.id}`), { available: m.available === false }); } catch { toast('No se pudo cambiar', 'err'); }
  },
  'item-del': async t => {
    const m = state.catalog[state.biz].menu[t.dataset.id];
    if (!confirm(`¿Borrar "${m.name}"?`)) return;
    try { await remove(ref(db, `catalog/${state.biz}/menu/${t.dataset.id}`)); } catch { toast('No se pudo borrar', 'err'); }
  },
  zoom: t => { const z = document.createElement('div'); z.id = 'zoom'; z.innerHTML = `<img src="${t.src}" alt="">`; z.onclick = () => z.remove(); document.body.append(z); }
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) f(t, e); });

// Re-render sin pisar un formulario a medio completar.
const refresh = () => { if (document.activeElement && document.activeElement.closest('#f-padron, #f-biz, #f-item, #f-town, #f-staff')) return; render(); };

onAuthStateChanged(auth, async u => {
  subs.forEach(f => f()); subs = []; watching = {};
  if (!u || u.isAnonymous) { login(); return; }
  const ok = (await get(ref(db, `admins/${u.uid}`)).catch(() => null))?.val() === true;
  if (!ok) { await signOut(auth); toast('Esta cuenta no es administradora', 'err'); return; }
  render(); lazy();
  subs.push(onValue(ref(db, 'drivers'), s => { state.drivers = s.val() || {}; refresh(); }));
  subs.push(onValue(ref(db, 'padron'), s => { state.padron = s.val() || {}; refresh(); }));
  subs.push(onValue(ref(db, 'catalog'), s => { state.catalog = s.val() || {}; if (state.tab === 'locales') refresh(); }));
  subs.push(onValue(ref(db, 'towns'), s => { state.towns = s.val() || {}; refresh(); }));
  subs.push(onValue(ref(db, 'bizStaff'), s => { state.staff = s.val() || {}; if (state.tab === 'locales') refresh(); }, () => {}));
  api.getConfig().then(c => { state.split = !!c.split; if (state.tab === 'locales') refresh(); }).catch(() => {});
});
