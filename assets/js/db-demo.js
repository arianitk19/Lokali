/* Lokali — databaza demo (localStorage) */
'use strict';

/* =====================================================================
   DEMO DB — e njëjta logjikë si trigger-at në schema.sql,
   e ruajtur në localStorage dhe e sinkronizuar mes skedave.
   ===================================================================== */
function createDemoDB() {
  const KEY = 'lokali_demo_v1';
  const listeners = new Set();
  let s = null, bc = null;

  function doCreate(st, tid, items, shenime, ts, ev) {
    if (!Array.isArray(items) || !items.length) throw new Error('Porosia duhet të ketë të paktën një artikull');
    const tav = st.tavolinat.find((t) => t.id === tid);
    if (!tav) throw new Error('Tavolina nuk ekziston');
    const id = ++st.seq.p, iso = new Date(ts).toISOString();
    const o = { id, tavolina_id: tid, statusi: 'e_re', shenime: (shenime || '').trim() || null, totali: 0, krijuar_me: iso, perditesuar_me: iso };
    st.porosite.push(o);
    ev.push({ op: 'INSERT', table: 'porosite', d: `Porosia #${id} për tavolinën ${tav.numri}` });
    st.historiku.push({ id: st.seq.h++, porosia_id: id, statusi_vjeter: null, statusi_ri: 'e_re', ndryshuar_me: iso });
    tav.e_zene = true;
    ev.push({ op: 'TRIGGER', table: 'tavolinat', d: `trg_porosia_pas_insert: tavolina ${tav.numri} u shënua e zënë` });
    for (const it of items) {
      const p = st.produktet.find((x) => x.id === it.produkti_id);
      if (!p) throw new Error(`Produkti ${it.produkti_id} nuk ekziston`);
      if (!p.aktiv) throw new Error(`Produkti "${p.emri}" nuk është në dispozicion`);
      if (!(it.sasia >= 1 && it.sasia <= 50)) throw new Error('Sasia duhet të jetë nga 1 deri në 50');
      if (p.stoku < it.sasia) throw new Error(`Stok i pamjaftueshëm për "${p.emri}": kanë mbetur ${p.stoku}`);
      p.stoku -= it.sasia;
      const nt = Math.round(p.cmimi * it.sasia * 100) / 100;
      st.artikujt.push({ id: st.seq.a++, porosia_id: id, produkti_id: p.id, sasia: it.sasia, cmimi_njesi: p.cmimi, nentotali: nt });
      ev.push({ op: 'INSERT', table: 'porosi_artikujt', d: `${it.sasia}× ${p.emri}` });
      ev.push({ op: 'TRIGGER', table: 'produktet', d: `trg_artikulli_para_insert: stoku i "${p.emri}" → ${p.stoku}` });
    }
    o.totali = Math.round(st.artikujt.filter((a) => a.porosia_id === id).reduce((t, a) => t + a.nentotali, 0) * 100) / 100;
    ev.push({ op: 'TRIGGER', table: 'porosite', d: `trg_rillogarit_totalin: totali i #${id} = ${eur(o.totali)}` });
    return id;
  }

  function doStatus(st, id, statusi, ts, ev) {
    const o = st.porosite.find((x) => x.id === id);
    if (!o) throw new Error(`Porosia #${id} nuk u gjet`);
    if (!(TRANS[o.statusi] || []).includes(statusi)) throw new Error(`Kalim i palejuar statusi: ${o.statusi} → ${statusi}`);
    const old = o.statusi, iso = new Date(ts).toISOString();
    o.statusi = statusi; o.perditesuar_me = iso;
    ev.push({ op: 'UPDATE', table: 'porosite', d: `#${id}: ${STATUS[old]} → ${STATUS[statusi]}` });
    st.historiku.push({ id: st.seq.h++, porosia_id: id, statusi_vjeter: old, statusi_ri: statusi, ndryshuar_me: iso });
    ev.push({ op: 'TRIGGER', table: 'porosi_historiku', d: `trg_porosia_pas_update: u ruajt në historik` });
    if (statusi === 'e_anuluar') {
      st.artikujt.filter((a) => a.porosia_id === id).forEach((a) => {
        const p = st.produktet.find((x) => x.id === a.produkti_id); if (p) p.stoku += a.sasia;
      });
      ev.push({ op: 'TRIGGER', table: 'produktet', d: `Stoku u kthye për artikujt e #${id}` });
    }
    if (CLOSED.includes(statusi)) {
      const tav = st.tavolinat.find((t) => t.id === o.tavolina_id);
      tav.e_zene = st.porosite.some((x) => x.tavolina_id === tav.id && !CLOSED.includes(x.statusi));
      if (!tav.e_zene) ev.push({ op: 'TRIGGER', table: 'tavolinat', d: `Tavolina ${tav.numri} u lirua` });
    }
  }

  function seed() {
    const kategorite = [
      { id: 1, emri: 'Kafe & Çaj', renditja: 1 }, { id: 2, emri: 'Pije', renditja: 2 },
      { id: 3, emri: 'Ushqim', renditja: 3 }, { id: 4, emri: 'Ëmbëlsira', renditja: 4 }
    ];
    const P = (id, k, emri, cmimi, stoku) => ({ id, kategoria_id: k, emri, cmimi, stoku, aktiv: true });
    const produktet = [
      P(1, 1, 'Espresso', 1.0, 200), P(2, 1, 'Makiato', 1.2, 200), P(3, 1, 'Kapuçino', 1.5, 150),
      P(4, 1, 'Çaj i zi', 1.0, 120), P(5, 1, 'Çaj mali', 1.2, 80),
      P(6, 2, 'Ujë mineral', 0.8, 150), P(7, 2, 'Lëng portokalli i shtrydhur', 2.0, 40),
      P(8, 2, 'Coca-Cola', 1.5, 90), P(9, 2, 'Limonadë', 1.8, 60),
      P(10, 3, 'Sanduiç me pulë', 3.5, 30), P(11, 3, 'Pica Margarita', 5.0, 25),
      P(12, 3, 'Pasta Bolonjeze', 5.5, 20), P(13, 3, 'Sallatë Cezar', 4.0, 18), P(14, 3, 'Pite me spinaq', 2.5, 6),
      P(15, 4, 'Trileçe', 2.0, 24), P(16, 4, 'Bakllava', 2.0, 30), P(17, 4, 'Tortë me çokollatë', 2.5, 4)
    ];
    const cap = [2, 4, 4, 6, 2, 4, 8, 4, 2, 6];
    const tavolinat = cap.map((c, i) => ({ id: i + 1, numri: i + 1, kapaciteti: c, e_zene: false }));
    const st = { kategorite, produktet, tavolinat, porosite: [], artikujt: [], historiku: [], seq: { p: 100, a: 1, h: 1 } };
    const ev = [], now = Date.now(), sod = new Date(); sod.setHours(0, 5, 0, 0);
    const past = [
      [[1, 2], [16, 1]], [[3, 1], [15, 1]], [[11, 1], [8, 2]], [[2, 3]], [[12, 1], [13, 1], [6, 2]],
      [[10, 2], [9, 2]], [[1, 1], [4, 1]], [[11, 2], [7, 1]], [[3, 2], [15, 1]], [[13, 1], [6, 1]],
      [[2, 2], [15, 2]], [[10, 1], [8, 1]], [[3, 2], [16, 2]], [[11, 1], [9, 1]]
    ];
    const chain = ['ne_pergatitje', 'gati', 'e_sherbyer', 'e_paguar'];
    for (let i = past.length - 1; i >= 0; i--) {
      const t = Math.max(sod.getTime() + i * 60000, now - (i + 2) * 41 * 60000);
      const id = doCreate(st, (i % 10) + 1, past[i].map(([pid, q]) => ({ produkti_id: pid, sasia: q })), null, t, ev);
      chain.forEach((c, j) => doStatus(st, id, c, t + (j + 1) * 4 * 60000, ev));
    }
    const live = [
      { tav: 1, mins: 26, items: [[12, 1], [13, 1], [6, 2]], to: 'e_sherbyer', note: null },
      { tav: 5, mins: 14, items: [[11, 2], [8, 2]], to: 'gati', note: null },
      { tav: 7, mins: 9, items: [[10, 2], [9, 2], [14, 1]], to: 'ne_pergatitje', note: 'Njëri sanduiç pa majonezë' },
      { tav: 3, mins: 2, items: [[2, 3], [17, 1]], to: 'e_re', note: 'Makiatot pa sheqer' }
    ];
    live.forEach((o) => {
      const t = now - o.mins * 60000;
      const id = doCreate(st, o.tav, o.items.map(([pid, q]) => ({ produkti_id: pid, sasia: q })), o.note, t, ev);
      for (const c of chain) { if (o.to === 'e_re') break; doStatus(st, id, c, t + 60000, ev); if (c === o.to) break; }
    });
    return st;
  }

  function load() {
    try { const raw = lsGet(KEY); s = raw ? JSON.parse(raw) : null; } catch { s = null; }
    if (!s || !s.porosite) { s = seed(); persist(); }
  }
  function persist() { lsSet(KEY, JSON.stringify(s)); }
  function emit(events) { listeners.forEach((f) => f(events)); }
  function commit(events) {
    persist();
    try { bc && bc.postMessage({ events }); } catch {}
    emit(events);
  }
  try {
    bc = new BroadcastChannel('lokali');
    bc.onmessage = (m) => { load(); emit((m.data && m.data.events) || []); };
  } catch {}
  window.addEventListener('storage', (e) => { if (e.key === KEY && !bc) { load(); emit([]); } });
  load();

  const joinOrder = (o) => {
    const tav = s.tavolinat.find((t) => t.id === o.tavolina_id);
    return {
      ...o, tavolina: tav ? tav.numri : o.tavolina_id,
      artikujt: s.artikujt.filter((a) => a.porosia_id === o.id).map((a) => ({
        emri: (s.produktet.find((p) => p.id === a.produkti_id) || {}).emri || '?', sasia: a.sasia, nentotali: a.nentotali
      }))
    };
  };

  return {
    mode: 'demo',
    async menu() { return { kategorite: clone(s.kategorite).sort((a, b) => a.renditja - b.renditja), produktet: clone(s.produktet) }; },
    async tavolinat() { return clone(s.tavolinat).sort((a, b) => a.numri - b.numri); },
    async aktive() {
      return s.porosite.filter((o) => !CLOSED.includes(o.statusi)).map(joinOrder)
        .sort((a, b) => new Date(a.krijuar_me) - new Date(b.krijuar_me));
    },
    async raporti() {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      const today = s.porosite.filter((o) => new Date(o.krijuar_me) >= sod);
      const paid = today.filter((o) => o.statusi === 'e_paguar');
      const xhiro = paid.reduce((t, o) => t + o.totali, 0);
      const sot = {
        porosi_paguar: paid.length, xhiro, mesatarja: paid.length ? xhiro / paid.length : 0,
        aktive: today.filter((o) => !CLOSED.includes(o.statusi)).length,
        anuluar: today.filter((o) => o.statusi === 'e_anuluar').length
      };
      const agg = {};
      s.artikujt.forEach((a) => {
        const o = s.porosite.find((x) => x.id === a.porosia_id);
        if (!o || o.statusi === 'e_anuluar') return;
        const p = s.produktet.find((x) => x.id === a.produkti_id);
        const r = (agg[p.id] ||= { emri: p.emri, sasia: 0, te_ardhurat: 0 });
        r.sasia += a.sasia; r.te_ardhurat += a.nentotali;
      });
      const rows = Object.values(agg).sort((a, b) => b.sasia - a.sasia || a.emri.localeCompare(b.emri));
      rows.forEach((r) => { r.renditja = 1 + rows.filter((x) => x.sasia > r.sasia).length; });
      const ore = {};
      paid.forEach((o) => {
        const h = new Date(o.krijuar_me).getHours();
        const r = (ore[h] ||= { ora: h, porosi: 0, xhiro: 0 });
        r.porosi++; r.xhiro += o.totali;
      });
      return { sot, top: rows.slice(0, 6), ore: Object.values(ore) };
    },
    async createOrder(tid, items, shenime) {
      const draft = clone(s), ev = [];
      let id;
      try { id = doCreate(draft, tid, items, shenime, Date.now(), ev); }
      catch (e) { emit([{ op: 'ERROR', table: 'krijo_porosi', d: `${e.message} (ROLLBACK)` }]); throw e; }
      s = draft; commit(ev); return id;
    },
    async setStatus(id, statusi) {
      const draft = clone(s), ev = [];
      try { doStatus(draft, id, statusi, Date.now(), ev); }
      catch (e) { emit([{ op: 'ERROR', table: 'ndrysho_statusin', d: e.message }]); throw e; }
      s = draft; commit(ev);
    },
    reset() { s = seed(); commit([{ op: 'DELETE', table: 'demo', d: 'Të dhënat demo u rivendosën' }]); },
    subscribe(cb, onState) { listeners.add(cb); onState && onState('demo'); }
  };
}
