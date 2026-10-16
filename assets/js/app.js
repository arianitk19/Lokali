/* Lokali — logjika e ndërfaqes: Salla, Kuzhina, Arka, Databaza */
'use strict';

/* =====================================================================
   APLIKACIONI
   ===================================================================== */
const state = {
  view: 'salla', cat: 0, q: '', sel: null, cart: {},
  menu: { kategorite: [], produktet: [] }, tables: [], orders: [], report: null,
  log: [], fresh: new Set(), confirm: null, loaded: false, busy: false
};

function readCfg() {
  try { const c = JSON.parse(lsGet('lokali_cfg') || 'null'); if (c && c.url && c.key) return c; } catch {}
  if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) return { url: CONFIG.SUPABASE_URL, key: CONFIG.SUPABASE_ANON_KEY };
  return null;
}

let db;
(function initDB() {
  const cfg = readCfg();
  if (cfg && window.supabase) {
    try { db = createSupaDB(cfg); return; } catch (e) { setTimeout(() => toast('Lidhja me Supabase dështoi: ' + e.message, 'bad'), 300); }
  } else if (cfg && !window.supabase) {
    setTimeout(() => toast('Libraria e Supabase nuk u ngarkua. Po punoj në demo.', 'bad'), 300);
  }
  db = createDemoDB();
})();

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'bad' ? ' bad' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 5200 : 3200);
}

function setConn(s) {
  const el = $('#conn'), txt = $('#conn-txt');
  el.classList.remove('is-live', 'is-err');
  if (s === 'demo') txt.textContent = 'Demo lokal';
  else if (s === 'live') { el.classList.add('is-live'); txt.textContent = 'Live · Supabase'; }
  else if (s === 'error') { el.classList.add('is-err'); txt.textContent = 'Realtime s’u lidh'; }
  else txt.textContent = 'Duke u lidhur…';
}

function pushLog(events) {
  const t = new Date();
  events.forEach((e) => state.log.unshift({ t, ...e }));
  state.log = state.log.slice(0, 80);
  renderLog();
}

let refreshTimer = null;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 160); }

async function refresh() {
  try {
    const [menu, tables, orders, report] = await Promise.all([db.menu(), db.tavolinat(), db.aktive(), db.raporti()]);
    if (state.loaded) {
      const known = new Set(state.orders.map((o) => o.id));
      orders.forEach((o) => { if (!known.has(o.id)) { state.fresh.add(o.id); setTimeout(() => state.fresh.delete(o.id), 1500); } });
    }
    Object.assign(state, { menu, tables, orders, report, loaded: true });
    render();
  } catch (e) {
    toast('Të dhënat nuk u ngarkuan: ' + e.message, 'bad');
    if (db.mode === 'live') setConn('error');
  }
}

/* ---------- Render ---------- */
function render() { renderCounts(); renderSalla(); renderKitchen(); renderArka(); }

function renderCounts() {
  const k = state.orders.filter((o) => o.statusi === 'e_re' || o.statusi === 'ne_pergatitje').length;
  const a = state.orders.filter((o) => o.statusi === 'gati' || o.statusi === 'e_sherbyer').length;
  const ck = $('#cnt-kuzhina'), ca = $('#cnt-arka');
  ck.textContent = k; ck.dataset.zero = String(k === 0);
  ca.textContent = a; ca.dataset.zero = String(a === 0);
}

function renderSalla() {
  const openBy = {};
  state.orders.forEach((o) => { openBy[o.tavolina_id] = (openBy[o.tavolina_id] || 0) + 1; });
  $('#tables').innerHTML = state.tables.map((t) => {
    const n = openBy[t.id] || 0, sel = t.id === state.sel;
    return `<button type="button" class="tbl ${sel ? 'is-sel' : ''} ${t.e_zene ? 'is-busy' : ''}" data-act="table" data-id="${t.id}" aria-pressed="${sel}">
      <span class="tbl-n">${t.numri}</span>
      <span class="tbl-meta">${t.kapaciteti} vende</span>
      <span class="tbl-state">${t.e_zene ? (n === 1 ? '1 porosi' : `${n || 1} porosi`) : 'E lirë'}</span>
    </button>`;
  }).join('');

  const cats = [{ id: 0, emri: 'Të gjitha' }, ...state.menu.kategorite];
  $('#cats').innerHTML = cats.map((c) => `<button type="button" class="chip" data-act="cat" data-id="${c.id}" aria-pressed="${state.cat === c.id}">${esc(c.emri)}</button>`).join('');

  const catName = Object.fromEntries(state.menu.kategorite.map((c) => [c.id, c.emri]));
  const q = state.q.trim().toLowerCase();
  const prods = state.menu.produktet.filter((p) => p.aktiv && (!state.cat || p.kategoria_id === state.cat) && (!q || p.emri.toLowerCase().includes(q)));
  $('#menu').innerHTML = prods.length ? prods.map((p) => {
    const inCart = state.cart[p.id] || 0, left = p.stoku - inCart;
    const stock = p.stoku === 0 ? '<span class="stock out">Mbaroi</span>' : p.stoku <= 6 ? `<span class="stock low">Edhe ${p.stoku}</span>` : '';
    return `<button type="button" class="prod" data-act="add" data-id="${p.id}" ${left <= 0 ? 'disabled' : ''} aria-label="Shto ${esc(p.emri)}, ${eur(p.cmimi)}">
      ${inCart ? `<span class="incart">${inCart}</span>` : ''}
      <span class="prod-cat">${esc(catName[p.kategoria_id] || '')}</span>
      <span class="prod-name">${esc(p.emri)}</span>
      <span class="prod-foot"><span class="prod-price">${eur(p.cmimi)}</span>${stock}</span>
    </button>`;
  }).join('') : '<p class="hint" style="grid-column:1/-1">Asnjë produkt nuk përputhet me kërkimin.</p>';

  renderBona();
  renderTableOrders();
}

function renderBona() {
  const tav = state.tables.find((t) => t.id === state.sel);
  $('#bona-title').textContent = tav ? `Tavolina ${tav.numri}` : 'Bonë e re';
  $('#bona-sub').textContent = tav ? (tav.e_zene ? 'Ka porosi të hapura' : 'E lirë') : 'Pa tavolinë';
  const lines = Object.entries(state.cart).map(([id, q]) => ({ p: state.menu.produktet.find((x) => x.id === Number(id)), q })).filter((l) => l.p);
  const total = lines.reduce((t, l) => t + l.p.cmimi * l.q, 0);
  $('#bona-items').innerHTML = lines.length ? lines.map(({ p, q }) => `
    <li class="bona-row">
      <span class="nm">${esc(p.emri)}<small>${eur(p.cmimi)} copa</small></span>
      <span class="qty">
        <button type="button" data-act="dec" data-id="${p.id}" aria-label="Pakëso ${esc(p.emri)}">−</button>
        <span>${q}</span>
        <button type="button" data-act="inc" data-id="${p.id}" aria-label="Shto ${esc(p.emri)}" ${q >= p.stoku ? 'disabled' : ''}>+</button>
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
        <div class="flex items-center gap-2 flex-wrap"><span class="num text-sm font-bold">#${o.id}</span><span class="pill st-${o.statusi}">${STATUS[o.statusi]}</span></div>
        <div class="hint truncate">${o.artikujt.map((a) => `${a.sasia}× ${esc(a.emri)}`).join(', ')}</div>
      </div>
      <span class="num font-bold">${eur(o.totali)}</span>
    </div>`).join('');
}

function minsAgo(iso) { return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)); }

function kitchenTicket(o) {
  const m = minsAgo(o.krijuar_me);
  const late = m >= 15 ? 'is-late' : m >= 8 ? 'is-warn' : '';
  const next = { e_re: ['ne_pergatitje', 'Fillo përgatitjen', 'btn-go'], ne_pergatitje: ['gati', 'Shëno gati', 'btn-ok'], gati: ['e_sherbyer', 'Shërbeje', 'btn-go'] }[o.statusi];
  const canCancel = o.statusi === 'e_re' || o.statusi === 'ne_pergatitje';
  const confirming = state.confirm === o.id;
  return `<article class="ticket k-ticket ${state.fresh.has(o.id) ? 'is-fresh' : ''}">
    <header class="tk-h"><span class="tk-no">#${o.id}</span><span class="tk-tab">Tav. ${o.tavolina}</span><span class="tk-time ${late}">${m < 1 ? 'tani' : m + ' min'}</span></header>
    <ul class="tk-items">${o.artikujt.map((a) => `<li><span class="q">${a.sasia}×</span><span>${esc(a.emri)}</span></li>`).join('')}</ul>
    ${o.shenime ? `<p class="tk-note">${esc(o.shenime)}</p>` : ''}
    <footer class="tk-f">
      ${canCancel ? `<button type="button" class="btn btn-sm btn-cancel ${confirming ? 'is-confirm' : ''}" data-act="cancel" data-id="${o.id}">${confirming ? 'Konfirmo anulimin' : 'Anulo'}</button>` : `<span class="hint num">${eur(o.totali)}</span>`}
      ${next ? `<button type="button" class="btn btn-sm ${next[2]}" data-act="status" data-id="${o.id}" data-to="${next[0]}">${next[1]}</button>` : ''}
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
  $('#kitchen-clock').textContent = new Date().toLocaleTimeString('sq-AL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

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
    const from = Math.min(now, ...(hrs.length ? hrs : [now])), to = Math.max(now, ...(hrs.length ? hrs : [now]));
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
        <div class="pay-items">${o.artikujt.map((a) => `${a.sasia}× ${esc(a.emri)}`).join(' · ')}</div>
      </div>
      <div class="pay-right"><span class="pay-amt">${eur(o.totali)}</span>
        <button type="button" class="btn btn-sm btn-primary" data-act="status" data-id="${o.id}" data-to="e_paguar">Paguaj</button></div>
    </div>`).join('') : '<p class="hint py-6 text-center">Nuk ka porosi që presin pagesën.</p>';
}

function renderLog() {
  $('#log').innerHTML = state.log.length ? state.log.map((e) => `
    <li><span class="t">${hhmm(e.t).slice(0, 8)}</span><span class="op op-${esc(e.op)}">${esc(e.op)}</span><span class="d"><b>${esc(e.table)}</b> ${esc(e.d)}</span></li>`).join('')
    : '<li style="display:block" class="hint">Ende pa ngjarje. Dërgo një porosi nga Salla ose ndrysho statusin në Kuzhinë.</li>';
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  ['salla', 'kuzhina', 'arka', 'databaza'].forEach((x) => { $('#view-' + x).hidden = x !== v; });
  try { if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v); } catch {}
  lsSet('lokali_view', v);
}

/* ---------- Veprimet ---------- */
async function sendOrder() {
  const items = Object.entries(state.cart).map(([id, q]) => ({ produkti_id: Number(id), sasia: q }));
  if (!state.sel || !items.length || state.busy) return;
  state.busy = true; renderBona();
  try {
    const id = await db.createOrder(state.sel, items, $('#notes').value);
    const tav = state.tables.find((t) => t.id === state.sel);
    toast(`Porosia #${id} për tavolinën ${tav ? tav.numri : ''} u dërgua në kuzhinë`);
    state.cart = {}; $('#notes').value = '';
    lsDel('lokali_draft');
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    state.busy = false; await refresh();
  }
}

async function changeStatus(id, to) {
  try {
    await db.setStatus(id, to);
    const msg = { ne_pergatitje: 'po përgatitet', gati: 'është gati', e_sherbyer: 'u shërbye', e_paguar: 'u pagua', e_anuluar: 'u anulua' }[to];
    toast(`Porosia #${id} ${msg}`);
  } catch (e) { toast(e.message, 'bad'); }
  state.confirm = null;
  await refresh();
}

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) { setView(tab.dataset.view); return; }
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const id = Number(b.dataset.id), act = b.dataset.act;
  if (act === 'table') { state.sel = state.sel === id ? null : id; renderSalla(); }
  else if (act === 'cat') { state.cat = id; renderSalla(); }
  else if (act === 'add' || act === 'inc') {
    if (act === 'add' && !state.sel) toast('Zgjidh fillimisht tavolinën');
    const p = state.menu.produktet.find((x) => x.id === id);
    const q = (state.cart[id] || 0) + 1;
    if (p && q <= p.stoku) state.cart[id] = q;
    renderSalla();
  }
  else if (act === 'dec') { const q = (state.cart[id] || 0) - 1; if (q <= 0) delete state.cart[id]; else state.cart[id] = q; renderSalla(); }
  else if (act === 'status') { changeStatus(id, b.dataset.to); }
  else if (act === 'cancel') {
    if (state.confirm === id) changeStatus(id, 'e_anuluar');
    else { state.confirm = id; renderKitchen(); setTimeout(() => { if (state.confirm === id) { state.confirm = null; renderKitchen(); } }, 4000); }
  }
});

$('#search').addEventListener('input', (e) => { state.q = e.target.value; renderSalla(); });
$('#btn-send').addEventListener('click', sendOrder);
$('#btn-clear').addEventListener('click', () => { state.cart = {}; $('#notes').value = ''; renderSalla(); });
$('#btn-clear-log').addEventListener('click', () => { state.log = []; renderLog(); });

/* ---------- Modal ---------- */
const modal = $('#modal');
function openModal() {
  const c = readCfg();
  $('#cfg-url').value = c ? c.url : '';
  $('#cfg-key').value = c ? c.key : '';
  $('#modal-mode').textContent = db.mode === 'live'
    ? 'Tani: i lidhur me Supabase. Të dhënat ndahen me të gjithë pajisjet.'
    : 'Tani: demo lokal. Të dhënat ruhen vetëm në këtë shfletues dhe sinkronizohen mes skedave.';
  $('#btn-demo-reset').hidden = db.mode !== 'demo';
  modal.hidden = false; $('#cfg-url').focus();
}
function closeModal() { modal.hidden = true; }
$('#btn-settings').addEventListener('click', openModal);
$('#btn-close-modal').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
$('#btn-save-cfg').addEventListener('click', () => {
  const url = $('#cfg-url').value.trim().replace(/\/+$/, ''), key = $('#cfg-key').value.trim();
  if (!/^https:\/\/.+/.test(url) || key.length < 20) { toast('Kontrollo URL-në (fillon me https://) dhe çelësin anon.', 'bad'); return; }
  lsSet('lokali_cfg', JSON.stringify({ url, key }));
  location.reload();
});
$('#btn-use-demo').addEventListener('click', () => { lsDel('lokali_cfg'); location.reload(); });
$('#btn-demo-reset').addEventListener('click', () => { db.reset(); closeModal(); toast('Të dhënat demo u rivendosën'); });

/* ---------- Nisja ---------- */
(function boot() {
  if (CONFIG.BUSINESS_NAME) $('#biz-name').textContent = CONFIG.BUSINESS_NAME + ' · porositë';
  const fromHash = (location.hash || '').slice(1);
  const v = ['salla', 'kuzhina', 'arka', 'databaza'].includes(fromHash) ? fromHash : (lsGet('lokali_view') || 'salla');
  setView(['salla', 'kuzhina', 'arka', 'databaza'].includes(v) ? v : 'salla');
  setConn(db.mode === 'demo' ? 'demo' : 'connecting');
  renderLog();
  db.subscribe((events) => { if (events && events.length) pushLog(events); scheduleRefresh(); }, setConn);
  refresh();
  setInterval(() => { if (state.view === 'kuzhina') renderKitchen(); }, 20000);
  setInterval(() => { if (db.mode === 'live') refresh(); }, 60000);
})();
