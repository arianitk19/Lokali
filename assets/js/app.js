/* Lokali — ndërfaqja: hyrja, Salla, Kuzhina, Arka, Menaxhimi, Aktiviteti */
'use strict';

const state = {
  me: null, role: null, view: 'salla',
  cat: 0, q: '', sel: null, cart: {}, busy: false,
  settings: null, menu: { kategorite: [], produktet: [] }, tables: [], staff: [],
  orders: [], closed: [], report: null,
  log: [], fresh: new Set(), confirm: null, loaded: false,
  edit: { kat: null, prod: null, tav: null },
  authMode: 'login'
};

let db = null, unsubscribe = null, pendingTimer = null, currentUid = null;

// Ngjarjet e hyrjes përpunohen një nga një, që të mos hapet aplikacioni dy herë
let sessionQueue = Promise.resolve();
const queueSession = (s) => { sessionQueue = sessionQueue.then(() => handleSession(s)).catch(() => {}); return sessionQueue; };

/* =====================================================================
   NDIHMËS TË NDËRFAQES
   ===================================================================== */
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'bad' ? ' bad' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 5200 : 3200);
}

function showScreen(name) {
  ['auth', 'pending', 'nocfg', 'app'].forEach((s) => { $('#screen-' + s).hidden = s !== name; });
}

function setConn(s) {
  const el = $('#conn'), txt = $('#conn-txt');
  el.classList.remove('is-live', 'is-err');
  if (s === 'live') { el.classList.add('is-live'); txt.textContent = 'Live'; }
  else if (s === 'error') { el.classList.add('is-err'); txt.textContent = 'Pa lidhje live'; }
  else txt.textContent = 'Duke u lidhur…';
}

const can = (statusi) => !!state.role && STATUS_BY_ROLE[state.role].includes(statusi);
const views = () => (state.role ? VIEWS_BY_ROLE[state.role] : []);
const catName = () => Object.fromEntries(state.menu.kategorite.map((c) => [c.id, c.emri]));
const activeTables = () => state.tables.filter((t) => t.aktive);
const sellable = () => {
  const cats = new Set(state.menu.kategorite.map((c) => c.id));
  return state.menu.produktet.filter((p) => p.aktiv && cats.has(p.kategoria_id));
};
const stockLeft = (p) => (p.stoku == null ? Infinity : p.stoku - (state.cart[p.id] || 0));

// Butoni që kërkon klikim të dytë për konfirmim
function confirmBtn(key, label, act, id, extra = '') {
  const on = state.confirm === key;
  return `<button type="button" class="btn btn-sm btn-cancel ${on ? 'is-confirm' : ''}" data-act="${act}" data-id="${id}" data-key="${key}" ${extra}>${on ? 'Konfirmo' : label}</button>`;
}
function armConfirm(key) {
  state.confirm = key; render();
  setTimeout(() => { if (state.confirm === key) { state.confirm = null; render(); } }, 4000);
}

/* =====================================================================
   HYRJA
   ===================================================================== */
function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('#auth-tab-login').setAttribute('aria-selected', String(!signup));
  $('#auth-tab-signup').setAttribute('aria-selected', String(signup));
  $('#f-emri-wrap').hidden = !signup;
  $('#f-pass').autocomplete = signup ? 'new-password' : 'current-password';
  $('#btn-auth').textContent = signup ? 'Krijo llogarinë' : 'Hyr';
  authMsg('');
}

function authMsg(text, kind) {
  const el = $('#auth-msg');
  el.hidden = !text; el.textContent = text || '';
  el.classList.toggle('is-ok', kind === 'ok');
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $('#f-email').value.trim(), pass = $('#f-pass').value, emri = $('#f-emri').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Shkruaj një email të vlefshëm.');
  if (pass.length < 6) return authMsg('Fjalëkalimi duhet të ketë të paktën 6 karaktere.');
  if (state.authMode === 'signup' && !emri) return authMsg('Shkruaj emrin tënd.');
  const btn = $('#btn-auth'); btn.disabled = true;
  try {
    if (state.authMode === 'signup') {
      const r = await db.signUp(email, pass, emri);
      if (r.needsConfirm) authMsg('Llogaria u krijua. Hap emailin dhe kliko linkun e konfirmimit, pastaj hyr këtu.', 'ok');
    } else {
      await db.signIn(email, pass);
    }
    $('#f-pass').value = '';
  } catch (err) {
    authMsg(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function handleSession(session) {
  clearInterval(pendingTimer);
  const uid = session ? session.user.id : null;
  if (!uid) {
    currentUid = null; state.me = null; state.role = null;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    showScreen('auth');
    return;
  }
  let me = null;
  try {
    me = await db.me(uid);
    if (!me) { await new Promise((r) => setTimeout(r, 900)); me = await db.me(uid); }
  } catch (err) { toast(err.message, 'bad'); }

  if (!me || !me.aktiv) {
    state.me = me; state.role = null;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    $('#pending-email').textContent = session.user.email;
    showScreen('pending');
    pendingTimer = setInterval(async () => { queueSession(await db.session()); }, 15000);
    return;
  }

  const roleChanged = state.role !== me.roli;
  state.me = me; state.role = me.roli;
  if (currentUid !== uid || roleChanged) {
    currentUid = uid;
    enterApp();
  }
}

function enterApp() {
  showScreen('app');
  $('#me-name').textContent = state.me.emri;
  $('#me-role').textContent = ROLES[state.role];
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = !views().includes(t.dataset.view); });
  const fromHash = (location.hash || '').slice(1);
  const saved = lsGet('lokali_view');
  setView([fromHash, saved].find((v) => views().includes(v)) || views()[0]);

  if (unsubscribe) unsubscribe();
  setConn('connecting');
  unsubscribe = db.subscribe((events) => {
    if (events && events.length) pushLog(events);
    if (events.some((e) => e.table === 'stafi')) db.session().then(queueSession);
    scheduleRefresh();
  }, setConn);
  state.loaded = false;
  refresh();
}

/* =====================================================================
   NGARKIMI I TË DHËNAVE
   ===================================================================== */
let refreshTimer = null;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }

async function refresh() {
  if (!state.role) return;
  const money = state.role === 'admin' || state.role === 'kamarier';
  try {
    const [settings, menu, tables, orders, report, closed, staff] = await Promise.all([
      db.settings(), db.menu(), db.tavolinat(), db.aktive(),
      money ? db.raporti() : null,
      money ? db.mbyllurSot() : [],
      state.role === 'admin' ? db.stafi() : []
    ]);
    if (state.loaded) {
      const known = new Set(state.orders.map((o) => o.id));
      orders.forEach((o) => { if (!known.has(o.id)) { state.fresh.add(o.id); setTimeout(() => state.fresh.delete(o.id), 1500); } });
    }
    Object.assign(state, { settings, menu, tables, orders, report, closed, staff, loaded: true });
    // hiq nga bona produktet që s'shiten më
    const ok = new Set(sellable().map((p) => p.id));
    Object.keys(state.cart).forEach((id) => { if (!ok.has(Number(id))) delete state.cart[id]; });
    if (state.sel && !activeTables().some((t) => t.id === state.sel)) state.sel = null;
    render();
  } catch (e) {
    toast('Të dhënat nuk u ngarkuan: ' + e.message, 'bad');
  }
}

/* =====================================================================
   RENDER
   ===================================================================== */
function render() {
  if (!state.role) return;
  renderHeader(); renderCounts();
  if (views().includes('salla')) renderSalla();
  if (views().includes('kuzhina')) renderKitchen();
  if (views().includes('arka')) renderArka();
  if (views().includes('menaxhimi')) renderMgmt();
}

function renderHeader() {
  const s = state.settings;
  $('#biz-name').textContent = s ? s.emri_lokalit : 'Lokali';
  $('#biz-sub').textContent = (s && s.adresa) || 'Sistemi i porosive';
  document.title = (s ? s.emri_lokalit + ' · ' : '') + 'Lokali';
}

function renderCounts() {
  const k = state.orders.filter((o) => o.statusi === 'e_re' || o.statusi === 'ne_pergatitje').length;
  const a = state.orders.filter((o) => o.statusi === 'gati' || o.statusi === 'e_sherbyer').length;
  const p = state.staff.filter((s) => !s.aktiv).length;
  [['#cnt-kuzhina', k], ['#cnt-arka', a], ['#cnt-stafi', p]].forEach(([sel, n]) => {
    const el = $(sel); el.textContent = n; el.dataset.zero = String(n === 0);
  });
  $('#cnt-stafi').hidden = p === 0;
}

/* ---------- Salla ---------- */
function emptyState(text, cta) {
  return `<div class="empty">${text}${cta && state.role === 'admin' ? `<button type="button" class="btn btn-sm btn-go mt-3" data-act="goto" data-view="menaxhimi">${cta}</button>` : ''}</div>`;
}

function renderSalla() {
  const tables = activeTables();
  const openBy = {};
  state.orders.forEach((o) => { openBy[o.tavolina_id] = (openBy[o.tavolina_id] || 0) + 1; });
  $('#tables').innerHTML = tables.length ? tables.map((t) => {
    const n = openBy[t.id] || 0, sel = t.id === state.sel;
    return `<button type="button" class="tbl ${sel ? 'is-sel' : ''} ${n ? 'is-busy' : ''}" data-act="table" data-id="${t.id}" aria-pressed="${sel}">
      <span class="tbl-n">${t.numri}</span>
      <span class="tbl-meta">${t.kapaciteti} vende</span>
      <span class="tbl-state">${n ? (n === 1 ? '1 porosi' : n + ' porosi') : 'E lirë'}</span>
    </button>`;
  }).join('') : emptyState(state.role === 'admin' ? 'Ende s’ke shtuar tavolina.' : 'Administratori ende s’ka shtuar tavolina.', 'Shto tavolinat');

  const cats = [{ id: 0, emri: 'Të gjitha' }, ...state.menu.kategorite];
  $('#cats').innerHTML = state.menu.kategorite.length
    ? cats.map((c) => `<button type="button" class="chip" data-act="cat" data-id="${c.id}" aria-pressed="${state.cat === c.id}">${esc(c.emri)}</button>`).join('')
    : '';

  const names = catName(), q = state.q.trim().toLowerCase();
  const all = sellable();
  const prods = all.filter((p) => (!state.cat || p.kategoria_id === state.cat) && (!q || p.emri.toLowerCase().includes(q)));
  $('#menu').innerHTML = !all.length
    ? emptyState(state.role === 'admin' ? 'Menuja është bosh. Shto kategoritë dhe produktet me çmimet e tua.' : 'Administratori ende s’ka shtuar produkte.', 'Krijo menunë')
    : prods.length ? prods.map((p) => {
      const inCart = state.cart[p.id] || 0, left = stockLeft(p);
      const stock = p.stoku == null ? '' : p.stoku === 0 ? '<span class="stock out">Mbaroi</span>' : p.stoku <= 5 ? `<span class="stock low">Edhe ${p.stoku}</span>` : '';
      return `<button type="button" class="prod" data-act="add" data-id="${p.id}" ${left <= 0 ? 'disabled' : ''} aria-label="Shto ${esc(p.emri)}, ${eur(p.cmimi)}">
        ${inCart ? `<span class="incart">${inCart}</span>` : ''}
        <span class="prod-cat">${esc(names[p.kategoria_id] || '')}</span>
        <span class="prod-name">${esc(p.emri)}</span>
        <span class="prod-foot"><span class="prod-price">${eur(p.cmimi)}</span>${stock}</span>
      </button>`;
    }).join('') : '<p class="hint" style="grid-column:1/-1">Asnjë produkt nuk përputhet me kërkimin.</p>';

  renderBona();
  renderTableOrders();
}

function renderBona() {
  const tav = activeTables().find((t) => t.id === state.sel);
  const open = tav ? state.orders.filter((o) => o.tavolina_id === tav.id).length : 0;
  $('#bona-title').textContent = tav ? `Tavolina ${tav.numri}` : 'Bonë e re';
  $('#bona-sub').textContent = tav ? (open ? `${open} porosi të hapura` : 'E lirë') : 'Pa tavolinë';
  const lines = Object.entries(state.cart).map(([id, q]) => ({ p: state.menu.produktet.find((x) => x.id === Number(id)), q })).filter((l) => l.p);
  const total = lines.reduce((t, l) => t + l.p.cmimi * l.q, 0);
  $('#bona-items').innerHTML = lines.length ? lines.map(({ p, q }) => `
    <li class="bona-row">
      <span class="nm">${esc(p.emri)}<small>${eur(p.cmimi)} copa</small></span>
      <span class="qty">
        <button type="button" data-act="dec" data-id="${p.id}" aria-label="Pakëso ${esc(p.emri)}">−</button>
        <span>${q}</span>
        <button type="button" data-act="inc" data-id="${p.id}" aria-label="Shto ${esc(p.emri)}" ${stockLeft(p) <= 0 || q >= 50 ? 'disabled' : ''}>+</button>
      </span>
      <span class="num font-semibold text-sm" style="min-width:64px;text-align:right">${eur(p.cmimi * q)}</span>
    </li>`).join('')
    : `<li class="bona-empty">${tav ? 'Kliko produktet në menu për t’i shtuar në bonë.' : 'Zgjidh një tavolinë, pastaj shto produktet.'}</li>`;
  $('#bona-total').textContent = eur(total);
  $('#btn-send').disabled = !tav || !lines.length || state.busy;
  $('#btn-send').textContent = state.busy ? 'Duke dërguar…' : 'Dërgo në kuzhinë';
}

function renderTableOrders() {
  const panel = $('#table-orders-panel');
  const list = state.orders.filter((o) => o.tavolina_id === state.sel);
  panel.hidden = !list.length;
  if (!list.length) return;
  const tav = state.tables.find((t) => t.id === state.sel);
  $('#table-orders-title').textContent = `Porositë e hapura · Tavolina ${tav ? tav.numri : ''}`;
  $('#table-orders').innerHTML = list.map((o) => `
    <div class="flex items-center justify-between gap-3 py-1.5">
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap"><span class="num text-sm font-bold">#${o.id}</span><span class="pill st-${o.statusi}">${STATUS[o.statusi]}</span><span class="hint">${hm(o.krijuar_me)}</span></div>
        <div class="hint truncate">${o.artikujt.map((a) => `${a.sasia}× ${esc(a.emri)}`).join(', ')}</div>
      </div>
      <span class="num font-bold">${eur(o.totali)}</span>
    </div>`).join('');
}

/* ---------- Kuzhina ---------- */
function minsAgo(iso) { return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)); }

function kitchenTicket(o) {
  const m = minsAgo(o.krijuar_me);
  const late = m >= 15 ? 'is-late' : m >= 8 ? 'is-warn' : '';
  const next = { e_re: ['ne_pergatitje', 'Fillo përgatitjen', 'btn-go'], ne_pergatitje: ['gati', 'Shëno gati', 'btn-ok'], gati: ['e_sherbyer', 'Shërbeje', 'btn-go'] }[o.statusi];
  const showNext = next && can(next[0]);
  const canCancel = (o.statusi === 'e_re' || o.statusi === 'ne_pergatitje') && can('e_anuluar');
  return `<article class="ticket k-ticket ${state.fresh.has(o.id) ? 'is-fresh' : ''}">
    <header class="tk-h"><span class="tk-no">#${o.id}</span><span class="tk-tab">Tav. ${o.tavolina}</span><span class="tk-time ${late}">${m < 1 ? 'tani' : m + ' min'}</span></header>
    <ul class="tk-items">${o.artikujt.map((a) => `<li><span class="q">${a.sasia}×</span><span>${esc(a.emri)}</span></li>`).join('')}</ul>
    ${o.shenime ? `<p class="tk-note">${esc(o.shenime)}</p>` : ''}
    <footer class="tk-f">
      ${canCancel ? confirmBtn('cancel-' + o.id, 'Anulo', 'cancel', o.id) : `<span class="hint">${o.kamarieri ? esc(o.kamarieri) : ''}</span>`}
      ${showNext ? `<button type="button" class="btn btn-sm ${next[2]}" data-act="status" data-id="${o.id}" data-to="${next[0]}">${next[1]}</button>` : ''}
    </footer>
  </article>`;
}

function renderKitchen() {
  ['e_re', 'ne_pergatitje', 'gati'].forEach((st) => {
    const list = state.orders.filter((o) => o.statusi === st);
    $('#n-' + st).textContent = list.length;
    $('#col-' + st).innerHTML = list.length ? list.map(kitchenTicket).join('')
      : `<div class="col-empty">${st === 'e_re' ? 'Asnjë bonë e re' : st === 'ne_pergatitje' ? 'Asgjë në përgatitje' : 'Asgjë në pritje për shërbim'}</div>`;
  });
  $('#kitchen-clock').textContent = hm(new Date());
}

/* ---------- Arka ---------- */
function renderArka() {
  const r = state.report;
  if (r) {
    $('#k-xhiro').textContent = eur(r.sot.xhiro);
    $('#k-paguar').textContent = r.sot.porosi_paguar;
    $('#k-mes').textContent = eur(r.sot.mesatarja);
    $('#k-aktive').textContent = state.orders.length;

    const now = new Date().getHours();
    const byH = Object.fromEntries(r.ore.map((x) => [x.ora, x]));
    const hrs = r.ore.map((x) => x.ora);
    const to = Math.max(now, ...hrs);
    const from = Math.min(now, ...hrs);
    const start = Math.max(0, Math.min(from, to - 7));
    const max = Math.max(1, ...r.ore.map((x) => x.xhiro));
    let html = '';
    for (let h = start; h <= to; h++) {
      const v = byH[h] ? byH[h].xhiro : 0;
      const pct = Math.round((v / max) * 100);
      html += `<div class="hcol" title="${String(h).padStart(2, '0')}:00 · ${byH[h] ? byH[h].porosi : 0} porosi · ${eur(v)}">
        <span class="hval">${v ? Math.round(v) + '€' : ''}</span>
        <div class="hbar ${v ? '' : 'zero'}" style="height:${v ? Math.max(pct, 4) : 1.5}%"></div>
        <span class="hlbl">${String(h).padStart(2, '0')}</span></div>`;
    }
    $('#hours').innerHTML = html;

    const tmax = Math.max(1, ...r.top.map((x) => x.sasia));
    $('#top').innerHTML = r.top.length ? r.top.map((x) => `
      <div class="toprow">
        <span class="rk">${x.renditja}.</span>
        <div class="min-w-0"><div class="font-semibold truncate">${esc(x.emri)}</div><div class="meter"><i style="width:${(x.sasia / tmax) * 100}%"></i></div></div>
        <div class="text-right"><div class="num font-bold">${x.sasia} copë</div><div class="num hint" style="font-size:12px">${eur(x.te_ardhurat)}</div></div>
      </div>`).join('') : '<p class="hint">Ende pa shitje.</p>';
  }

  const pay = state.orders.filter((o) => o.statusi === 'gati' || o.statusi === 'e_sherbyer');
  $('#pay-list').innerHTML = pay.length ? pay.map((o) => `
    <div class="pay-row">
      <div class="min-w-0">
        <div class="pay-title"><span>Tavolina ${o.tavolina}</span><span class="num hint">#${o.id}</span><span class="pill st-${o.statusi}">${STATUS[o.statusi]}</span></div>
        <div class="pay-items">${o.artikujt.map((a) => `${a.sasia}× ${esc(a.emri)}`).join(' · ')}${o.kamarieri ? ' · ' + esc(o.kamarieri) : ''}</div>
      </div>
      <div class="pay-right"><span class="pay-amt">${eur(o.totali)}</span>
        ${can('e_paguar') ? `<button type="button" class="btn btn-sm btn-primary" data-act="status" data-id="${o.id}" data-to="e_paguar">Paguaj</button>` : ''}</div>
    </div>`).join('') : '<p class="hint py-6 text-center">Nuk ka porosi që presin pagesën.</p>';

  const closed = state.closed;
  const anul = closed.filter((o) => o.statusi === 'e_anuluar').length;
  $('#closed-sum').textContent = closed.length ? `${closed.length} porosi${anul ? ` · ${anul} të anuluara` : ''}` : '';
  $('#closed-list').innerHTML = closed.length ? closed.map((o) => `
    <div class="pay-row">
      <div class="min-w-0">
        <div class="pay-title"><span>Tavolina ${o.tavolina}</span><span class="num hint">#${o.id} · ${hm(o.perditesuar_me)}</span>${o.statusi === 'e_anuluar' ? '<span class="pill st-anul">E anuluar</span>' : ''}</div>
        <div class="pay-items">${o.artikujt.map((a) => `${a.sasia}× ${esc(a.emri)}`).join(' · ')}${o.kamarieri ? ' · ' + esc(o.kamarieri) : ''}</div>
      </div>
      <span class="pay-amt ${o.statusi === 'e_anuluar' ? 'is-void' : ''}">${eur(o.totali)}</span>
    </div>`).join('') : '<p class="hint py-6 text-center">Ende asnjë porosi e mbyllur sot.</p>';
}

/* ---------- Menaxhimi ---------- */
function rowActions(kind, id, editLabel = 'Ndrysho') {
  return `<span class="row-act"><button type="button" class="btn btn-sm btn-ghost" data-act="m-edit-${kind}" data-id="${id}">${editLabel}</button>${confirmBtn(`del-${kind}-${id}`, 'Fshi', `m-del-${kind}`, id)}</span>`;
}

function renderMgmt() {
  // Lokali (mos e prish formularin kur dikush po shkruan)
  const f = $('#form-lokali');
  if (state.settings && !f.contains(document.activeElement) && !f.dataset.dirty) {
    $('#m-lokali-emri').value = state.settings.emri_lokalit || '';
    $('#m-lokali-adresa').value = state.settings.adresa || '';
  }

  // Stafi
  $('#staff-list').innerHTML = state.staff.map((s) => {
    const self = s.user_id === state.me.user_id;
    return `<div class="mrow">
      <div class="min-w-0 grow">
        <div class="font-semibold truncate">${esc(s.emri)}${self ? ' <span class="hint">(ti)</span>' : ''}</div>
        <div class="hint truncate">${esc(s.email || '')}</div>
      </div>
      ${s.aktiv ? '' : '<span class="pill st-e_re">Pret aprovimin</span>'}
      <select class="inp inp-sm" data-staff-role="${s.user_id}" aria-label="Roli i ${esc(s.emri)}">
        ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${s.roli === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      ${s.aktiv
        ? (self ? '' : confirmBtn('staff-off-' + s.user_id, 'Çaktivizo', 'staff-off', s.user_id))
        : `<button type="button" class="btn btn-sm btn-ok" data-act="staff-on" data-id="${s.user_id}">Aprovo</button>`}
    </div>`;
  }).join('') || '<p class="hint">Asnjë llogari.</p>';

  // Tavolinat
  const tables = activeTables();
  const openBy = new Set(state.orders.map((o) => o.tavolina_id));
  $('#m-tables-count').textContent = tables.length ? `${tables.length} tavolina · ${tables.reduce((t, x) => t + x.kapaciteti, 0)} vende` : '';
  $('#m-tables').innerHTML = tables.length ? tables.map((t) => `
    <div class="mrow ${state.edit.tav === t.id ? 'is-editing' : ''}">
      <span class="num font-bold" style="min-width:44px">${t.numri}</span>
      <span class="grow hint">${t.kapaciteti} vende${openBy.has(t.id) ? ' · <b class="text-[color:var(--warn)]">e zënë</b>' : ''}</span>
      ${rowActions('tav', t.id)}
    </div>`).join('') : '<p class="hint">Shto tavolinat e lokalit me numrin dhe vendet.</p>';

  // Kategoritë
  const countBy = {};
  state.menu.produktet.forEach((p) => { countBy[p.kategoria_id] = (countBy[p.kategoria_id] || 0) + 1; });
  $('#m-cats').innerHTML = state.menu.kategorite.length ? state.menu.kategorite.map((c) => `
    <div class="mrow ${state.edit.kat === c.id ? 'is-editing' : ''}">
      <span class="grow font-semibold">${esc(c.emri)}</span>
      <span class="hint">${countBy[c.id] || 0} produkte</span>
      ${rowActions('kat', c.id)}
    </div>`).join('') : '<p class="hint">Fillo me kategoritë, p.sh. Kafe, Pije, Ushqim, Ëmbëlsira.</p>';

  // Produktet
  const sel = $('#m-prod-kat'), cur = sel.value;
  sel.innerHTML = state.menu.kategorite.length
    ? state.menu.kategorite.map((c) => `<option value="${c.id}">${esc(c.emri)}</option>`).join('')
    : '<option value="">Shto fillimisht një kategori</option>';
  if (cur && state.menu.kategorite.some((c) => String(c.id) === cur)) sel.value = cur;
  $('#m-prod-submit').disabled = !state.menu.kategorite.length;

  const prods = state.menu.produktet;
  const act = prods.filter((p) => p.aktiv).length;
  $('#m-prod-count').textContent = prods.length ? `${act} aktive${prods.length - act ? ` · ${prods.length - act} joaktive` : ''}` : '';
  $('#m-prods').innerHTML = prods.length ? state.menu.kategorite.map((c) => {
    const list = prods.filter((p) => p.kategoria_id === c.id);
    if (!list.length) return '';
    return `<div class="pgroup"><div class="label mb-1">${esc(c.emri)}</div>
      <div class="table-wrap"><table class="ptable"><tbody>
      ${list.map((p) => `<tr class="${p.aktiv ? '' : 'is-off'} ${state.edit.prod === p.id ? 'is-editing' : ''}">
        <td class="pt-name">${esc(p.emri)}${p.aktiv ? '' : ' <span class="pill st-anul">Joaktiv</span>'}</td>
        <td class="num">${eur(p.cmimi)}</td>
        <td class="num pt-stock">${p.stoku == null ? '<span class="hint">pa kufi</span>' : p.stoku === 0 ? '<span class="stock out">0</span>' : p.stoku <= 5 ? `<span class="stock low">${p.stoku}</span>` : p.stoku}</td>
        <td class="pt-act"><div class="pt-btns">
          <button type="button" class="btn btn-sm btn-ghost" data-act="m-toggle-prod" data-id="${p.id}">${p.aktiv ? 'Çaktivizo' : 'Aktivizo'}</button>
          ${rowActions('prod', p.id)}
        </div></td>
      </tr>`).join('')}
      </tbody></table></div></div>`;
  }).join('') : '<p class="hint">Asnjë produkt ende. Shto produktet me emrin dhe çmimin që ke në menu.</p>';
}

/* ---------- Aktiviteti ---------- */
function pushLog(events) {
  const t = new Date();
  events.forEach((e) => state.log.unshift({ t, ...e }));
  state.log = state.log.slice(0, 120);
  renderLog();
}
function renderLog() {
  $('#log').innerHTML = state.log.length ? state.log.map((e) => `
    <li><span class="t">${hhmm(e.t)}</span><span class="op op-${esc(e.op)}">${esc(e.op)}</span><span class="d"><b>${esc(e.table)}</b> ${esc(e.d)}</span></li>`).join('')
    : '<li style="display:block" class="hint">Ende pa ngjarje që kur u hap kjo faqe.</li>';
}

function setView(v) {
  if (!views().includes(v)) v = views()[0];
  state.view = v;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  ['salla', 'kuzhina', 'arka', 'menaxhimi', 'aktiviteti'].forEach((x) => { $('#view-' + x).hidden = x !== v; });
  try { if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v); } catch {}
  lsSet('lokali_view', v);
}

/* =====================================================================
   VEPRIMET
   ===================================================================== */
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.message, 'bad'); throw e; }
  finally { state.confirm = null; scheduleRefresh(); }
}

async function sendOrder() {
  const items = Object.entries(state.cart).map(([id, q]) => ({ produkti_id: Number(id), sasia: q }));
  if (!state.sel || !items.length || state.busy) return;
  state.busy = true; renderBona();
  const tav = state.tables.find((t) => t.id === state.sel);
  try {
    await run(() => db.createOrder(state.sel, items, $('#notes').value),
      (id) => `Porosia #${id} për tavolinën ${tav ? tav.numri : ''} u dërgua në kuzhinë`);
    state.cart = {}; $('#notes').value = '';
  } catch {} finally { state.busy = false; renderBona(); }
}

function changeStatus(id, to) {
  const msg = { ne_pergatitje: 'po përgatitet', gati: 'është gati', e_sherbyer: 'u shërbye', e_paguar: 'u pagua', e_anuluar: 'u anulua' }[to];
  return run(() => db.setStatus(id, to), `Porosia #${id} ${msg}`).catch(() => {});
}

function resetForm(kind) {
  state.edit[kind] = null;
  const map = {
    kat: ['#form-kategoria', '#m-kat-submit', '#m-kat-cancel'],
    prod: ['#form-produkti', '#m-prod-submit', '#m-prod-cancel'],
    tav: ['#form-tavolina', '#m-tav-submit', '#m-tav-cancel']
  }[kind];
  const keep = kind === 'prod' ? $('#m-prod-kat').value : null;
  $(map[0]).reset();
  if (keep) $('#m-prod-kat').value = keep;
  $(map[1]).textContent = 'Shto';
  $(map[2]).hidden = true;
  renderMgmt();
}

function startEdit(kind, id) {
  state.edit[kind] = id;
  if (kind === 'kat') {
    const c = state.menu.kategorite.find((x) => x.id === id); if (!c) return;
    $('#m-kat-emri').value = c.emri; $('#m-kat-rend').value = c.renditja;
    $('#m-kat-submit').textContent = 'Ruaj'; $('#m-kat-cancel').hidden = false; $('#m-kat-emri').focus();
  } else if (kind === 'prod') {
    const p = state.menu.produktet.find((x) => x.id === id); if (!p) return;
    $('#m-prod-emri').value = p.emri; $('#m-prod-kat').value = String(p.kategoria_id);
    $('#m-prod-cmimi').value = p.cmimi.toFixed(2); $('#m-prod-stoku').value = p.stoku == null ? '' : p.stoku;
    $('#m-prod-submit').textContent = 'Ruaj'; $('#m-prod-cancel').hidden = false;
    $('#form-produkti').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('#m-prod-emri').focus({ preventScroll: true });
  } else if (kind === 'tav') {
    const t = state.tables.find((x) => x.id === id); if (!t) return;
    $('#m-tav-numri').value = t.numri; $('#m-tav-vende').value = t.kapaciteti;
    $('#m-tav-submit').textContent = 'Ruaj'; $('#m-tav-cancel').hidden = false; $('#m-tav-numri').focus();
  }
  renderMgmt();
}

document.addEventListener('click', (ev) => {
  const authTab = ev.target.closest('[data-auth]');
  if (authTab) { setAuthMode(authTab.dataset.auth); return; }
  const tab = ev.target.closest('.tab');
  if (tab) { setView(tab.dataset.view); return; }
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act, raw = b.dataset.id, id = Number(raw);
  const key = b.dataset.key;
  // veprimet që kërkojnë konfirmim
  if (key && state.confirm !== key) { armConfirm(key); return; }

  switch (act) {
    case 'goto': setView(b.dataset.view); break;
    case 'table': state.sel = state.sel === id ? null : id; renderSalla(); break;
    case 'cat': state.cat = id; renderSalla(); break;
    case 'add': case 'inc': {
      if (act === 'add' && !state.sel) { toast('Zgjidh fillimisht tavolinën'); break; }
      const p = state.menu.produktet.find((x) => x.id === id);
      if (p && stockLeft(p) > 0 && (state.cart[id] || 0) < 50) state.cart[id] = (state.cart[id] || 0) + 1;
      renderSalla(); break;
    }
    case 'dec': { const q = (state.cart[id] || 0) - 1; if (q <= 0) delete state.cart[id]; else state.cart[id] = q; renderSalla(); break; }
    case 'status': changeStatus(id, b.dataset.to); break;
    case 'cancel': changeStatus(id, 'e_anuluar'); break;

    case 'm-edit-kat': startEdit('kat', id); break;
    case 'm-edit-prod': startEdit('prod', id); break;
    case 'm-edit-tav': startEdit('tav', id); break;
    case 'm-del-kat': run(() => db.deleteCategory(id), 'Kategoria u fshi').then(() => { if (state.edit.kat === id) resetForm('kat'); }).catch(() => {}); break;
    case 'm-del-prod': run(() => db.deleteProduct(id), (r) => r === 'caktivizuar'
      ? 'Produkti ka shitje të regjistruara, prandaj u çaktivizua për të ruajtur historikun'
      : 'Produkti u fshi').then(() => { if (state.edit.prod === id) resetForm('prod'); }).catch(() => {}); break;
    case 'm-del-tav': run(() => db.deleteTable(id), (r) => r === 'caktivizuar'
      ? 'Tavolina u hoq. Historiku i porosive të saj ruhet'
      : 'Tavolina u fshi').then(() => { if (state.edit.tav === id) resetForm('tav'); }).catch(() => {}); break;
    case 'm-toggle-prod': {
      const p = state.menu.produktet.find((x) => x.id === id); if (!p) break;
      run(() => db.saveProduct(p.id, p.kategoria_id, p.emri, p.cmimi, p.stoku, !p.aktiv),
        p.aktiv ? `"${p.emri}" nuk shfaqet më në menu` : `"${p.emri}" u kthye në menu`).catch(() => {});
      break;
    }
    case 'staff-on': {
      const s = state.staff.find((x) => x.user_id === raw); if (!s) break;
      run(() => db.setStaff(raw, s.roli, true), `${s.emri} u aprovua si ${ROLES[s.roli]}`).catch(() => {}); break;
    }
    case 'staff-off': {
      const s = state.staff.find((x) => x.user_id === raw); if (!s) break;
      run(() => db.setStaff(raw, s.roli, false), `${s.emri} u çaktivizua`).catch(() => {}); break;
    }
  }
});

document.addEventListener('change', (ev) => {
  const sel = ev.target.closest('[data-staff-role]');
  if (!sel) return;
  const uid = sel.dataset.staffRole, s = state.staff.find((x) => x.user_id === uid);
  if (!s) return;
  run(() => db.setStaff(uid, sel.value, s.aktiv), `${s.emri} tani është ${ROLES[sel.value]}`).catch(() => { sel.value = s.roli; });
});

/* ---------- Formularët e menaxhimit ---------- */
$('#form-lokali').addEventListener('input', (e) => { e.currentTarget.dataset.dirty = '1'; });
$('#form-lokali').addEventListener('submit', (e) => {
  e.preventDefault();
  const emri = $('#m-lokali-emri').value.trim();
  if (!emri) return toast('Shkruaj emrin e lokalit', 'bad');
  run(() => db.saveSettings(emri, $('#m-lokali-adresa').value.trim()), 'Të dhënat e lokalit u ruajtën')
    .then(() => { delete $('#form-lokali').dataset.dirty; }).catch(() => {});
});

$('#form-kategoria').addEventListener('submit', (e) => {
  e.preventDefault();
  const emri = $('#m-kat-emri').value.trim();
  if (!emri) return toast('Shkruaj emrin e kategorisë', 'bad');
  const editing = state.edit.kat;
  run(() => db.saveCategory(editing, emri, Number($('#m-kat-rend').value) || 0),
    editing ? 'Kategoria u ruajt' : `Kategoria "${emri}" u shtua`).then(() => resetForm('kat')).catch(() => {});
});
$('#m-kat-cancel').addEventListener('click', () => resetForm('kat'));

$('#form-produkti').addEventListener('submit', (e) => {
  e.preventDefault();
  const emri = $('#m-prod-emri').value.trim(), kat = Number($('#m-prod-kat').value);
  const cmimi = Number(String($('#m-prod-cmimi').value).replace(',', '.'));
  const sRaw = $('#m-prod-stoku').value.trim(), stoku = sRaw === '' ? null : Number(sRaw);
  if (!emri) return toast('Shkruaj emrin e produktit', 'bad');
  if (!kat) return toast('Zgjidh kategorinë', 'bad');
  if (!(cmimi > 0)) return toast('Çmimi duhet të jetë më i madh se 0', 'bad');
  if (stoku != null && !(Number.isInteger(stoku) && stoku >= 0)) return toast('Stoku duhet të jetë numër i plotë ≥ 0, ose bosh', 'bad');
  const editing = state.edit.prod;
  const prev = editing ? state.menu.produktet.find((p) => p.id === editing) : null;
  run(() => db.saveProduct(editing, kat, emri, Math.round(cmimi * 100) / 100, stoku, prev ? prev.aktiv : true),
    editing ? `"${emri}" u ruajt` : `"${emri}" u shtua në menu`).then(() => resetForm('prod')).catch(() => {});
});
$('#m-prod-cancel').addEventListener('click', () => resetForm('prod'));

$('#form-tavolina').addEventListener('submit', (e) => {
  e.preventDefault();
  const numri = Number($('#m-tav-numri').value), vende = Number($('#m-tav-vende').value);
  if (!(Number.isInteger(numri) && numri >= 1 && numri <= 999)) return toast('Numri i tavolinës: 1–999', 'bad');
  if (!(Number.isInteger(vende) && vende >= 1 && vende <= 30)) return toast('Vendet: 1–30', 'bad');
  const editing = state.edit.tav;
  run(() => db.saveTable(editing, numri, vende), editing ? `Tavolina ${numri} u ruajt` : `Tavolina ${numri} u shtua`)
    .then(() => { resetForm('tav'); if (!editing) { $('#m-tav-numri').value = numri + 1; $('#m-tav-vende').value = vende; $('#m-tav-numri').focus(); } })
    .catch(() => {});
});
$('#m-tav-cancel').addEventListener('click', () => resetForm('tav'));

/* ---------- Të tjera ---------- */
$('#search').addEventListener('input', (e) => { state.q = e.target.value; renderSalla(); });
$('#btn-send').addEventListener('click', sendOrder);
$('#btn-clear').addEventListener('click', () => { state.cart = {}; $('#notes').value = ''; renderSalla(); });
$('#btn-clear-log').addEventListener('click', () => { state.log = []; renderLog(); });
$('#form-auth').addEventListener('submit', submitAuth);
$('#btn-logout').addEventListener('click', () => db.signOut());
$('#btn-pending-logout').addEventListener('click', () => db.signOut());
$('#btn-pending-check').addEventListener('click', async () => queueSession(await db.session()));

/* =====================================================================
   NISJA
   ===================================================================== */
(async function boot() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) { showScreen('nocfg'); return; }
  db = createDB({ url: CONFIG.SUPABASE_URL, key: CONFIG.SUPABASE_ANON_KEY });
  renderLog();
  setAuthMode('login');

  db.settings().then((s) => { if (s) $('#auth-biz').textContent = s.emri_lokalit; }).catch(() => {});

  db.onAuth((event, session) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
      // jashtë callback-ut, që thirrjet e Supabase të mos bllokohen
      setTimeout(() => queueSession(session), 0);
    }
  });
  try { await queueSession(await db.session()); } catch (e) { showScreen('auth'); }

  setInterval(() => { if (state.view === 'kuzhina' && state.role) renderKitchen(); }, 20000);
  setInterval(() => { if (state.role) refresh(); }, 60000);
})();
