/* Lokali — lidhja me Supabase (PostgreSQL + Realtime) */
'use strict';

/* =====================================================================
   SUPABASE DB — PostgreSQL në cloud + realtime
   ===================================================================== */
function createSupaDB(cfg) {
  const sb = window.supabase.createClient(cfg.url, cfg.key, { realtime: { params: { eventsPerSecond: 10 } } });
  const chk = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };
  const numify = (o, keys) => { keys.forEach((k) => { if (o[k] != null) o[k] = Number(o[k]); }); return o; };
  return {
    mode: 'live',
    async menu() {
      const [k, p] = await Promise.all([
        sb.from('kategorite').select('*').order('renditja'),
        sb.from('produktet').select('*').order('id')
      ]);
      return { kategorite: chk(k), produktet: chk(p).map((x) => numify(x, ['cmimi'])) };
    },
    async tavolinat() { return chk(await sb.from('tavolinat').select('*').order('numri')); },
    async aktive() {
      return chk(await sb.from('v_porosite_aktive').select('*').order('krijuar_me'))
        .map((o) => ({ ...numify(o, ['totali']), artikujt: (o.artikujt || []).map((a) => numify(a, ['nentotali'])) }));
    },
    async raporti() {
      const [a, b, c] = await Promise.all([
        sb.from('v_raporti_sot').select('*').single(),
        sb.from('v_produktet_top').select('*').order('renditja').order('emri').limit(6),
        sb.from('v_shitjet_ore').select('*').order('ora')
      ]);
      return {
        sot: numify(chk(a), ['porosi_paguar', 'xhiro', 'mesatarja', 'aktive', 'anuluar']),
        top: chk(b).map((r) => numify(r, ['sasia', 'te_ardhurat', 'renditja'])),
        ore: chk(c).map((r) => numify(r, ['ora', 'porosi', 'xhiro']))
      };
    },
    async createOrder(tid, items, shenime) {
      return chk(await sb.rpc('krijo_porosi', { p_tavolina: tid, p_artikujt: items, p_shenime: shenime || null }));
    },
    async setStatus(id, statusi) { chk(await sb.rpc('ndrysho_statusin', { p_id: id, p_statusi: statusi })); },
    reset() {},
    subscribe(cb, onState) {
      const describe = (p) => {
        const n = p.new || {}, o = p.old || {};
        if (p.table === 'porosite') {
          if (p.eventType === 'INSERT') return `Porosia #${n.id} u krijua`;
          if (p.eventType === 'UPDATE') return `#${n.id}: ${STATUS[n.statusi] || n.statusi} · totali ${eur(n.totali)}`;
          return `Porosia #${o.id} u fshi`;
        }
        if (p.table === 'porosi_artikujt') return `Artikull në porosinë #${n.porosia_id ?? o.porosia_id}: ${n.sasia ?? ''}× produkt ${n.produkti_id ?? ''}`;
        if (p.table === 'produktet') return `"${n.emri}" stoku → ${n.stoku}`;
        if (p.table === 'tavolinat') return `Tavolina ${n.numri}: ${n.e_zene ? 'e zënë' : 'e lirë'}`;
        return p.table;
      };
      const ch = sb.channel('lokali');
      ['porosite', 'porosi_artikujt', 'produktet', 'tavolinat'].forEach((t) => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table: t },
          (p) => cb([{ op: p.eventType, table: t, d: describe(p) }]));
      });
      ch.subscribe((status) => onState && onState(status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'error' : 'connecting'));
    }
  };
}
