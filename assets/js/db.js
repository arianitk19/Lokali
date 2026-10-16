/* Lokali — shtresa e të dhënave: Supabase (PostgreSQL + Auth + Realtime) */
'use strict';

function createDB(cfg) {
  const sb = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 10 } }
  });

  const AUTH_MSG = {
    'Invalid login credentials': 'Email ose fjalëkalim i gabuar.',
    'Email not confirmed': 'Konfirmo emailin (kontrollo kutinë postare), pastaj hyr.',
    'User already registered': 'Ky email është i regjistruar. Hyr me fjalëkalimin tënd.',
    'Password should be at least 6 characters.': 'Fjalëkalimi duhet të ketë të paktën 6 karaktere.',
    'Signup requires a valid password': 'Shkruaj një fjalëkalim.',
    'Unable to validate email address: invalid format': 'Email-i nuk është i vlefshëm.'
  };
  const fail = (err) => {
    const m = (err && err.message) || String(err);
    throw new Error(AUTH_MSG[m] || m);
  };
  const chk = (r) => { if (r.error) fail(r.error); return r.data; };
  const num = (o, keys) => { keys.forEach((k) => { if (o[k] != null) o[k] = Number(o[k]); }); return o; };
  const rpc = async (fn, args) => chk(await sb.rpc(fn, args));

  return {
    /* ---------- Hyrja ---------- */
    async session() { return (await sb.auth.getSession()).data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((event, session) => cb(event, session)); },
    async signIn(email, password) { chk(await sb.auth.signInWithPassword({ email, password })); },
    async signUp(email, password, emri) {
      const d = chk(await sb.auth.signUp({ email, password, options: { data: { emri } } }));
      return { needsConfirm: !d.session };
    },
    async signOut() { await sb.auth.signOut(); },
    async me(uid) { return chk(await sb.from('stafi').select('*').eq('user_id', uid).maybeSingle()); },

    /* ---------- Leximi ---------- */
    async settings() { return chk(await sb.from('cilesimet').select('*').eq('id', 1).maybeSingle()); },
    async menu() {
      const [k, p] = await Promise.all([
        sb.from('kategorite').select('*').order('renditja').order('emri'),
        sb.from('produktet').select('*').order('emri')
      ]);
      return { kategorite: chk(k), produktet: chk(p).map((x) => num(x, ['cmimi'])) };
    },
    async tavolinat() { return chk(await sb.from('tavolinat').select('*').order('numri')); },
    async stafi() { return chk(await sb.from('stafi').select('*').order('krijuar_me')); },
    async aktive() {
      return chk(await sb.from('v_porosite_aktive').select('*').order('krijuar_me'))
        .map((o) => ({ ...num(o, ['totali']), artikujt: (o.artikujt || []).map((a) => num(a, ['nentotali'])) }));
    },
    async mbyllurSot() {
      return chk(await sb.from('v_porosite_sot').select('*').order('perditesuar_me', { ascending: false }).limit(40))
        .map((o) => num(o, ['totali']));
    },
    async raporti() {
      const [a, b, c] = await Promise.all([
        sb.from('v_raporti_sot').select('*').single(),
        sb.from('v_produktet_top').select('*').order('renditja').order('emri').limit(6),
        sb.from('v_shitjet_ore').select('*').order('ora')
      ]);
      return {
        sot: num(chk(a), ['porosi_paguar', 'xhiro', 'mesatarja', 'aktive', 'anuluar']),
        top: chk(b).map((r) => num(r, ['sasia', 'te_ardhurat', 'renditja'])),
        ore: chk(c).map((r) => num(r, ['ora', 'porosi', 'xhiro']))
      };
    },

    /* ---------- Porositë ---------- */
    createOrder: (tid, items, shenime) => rpc('krijo_porosi', { p_tavolina: tid, p_artikujt: items, p_shenime: shenime || null }),
    setStatus: (id, statusi) => rpc('ndrysho_statusin', { p_id: id, p_statusi: statusi }),

    /* ---------- Menaxhimi ---------- */
    saveSettings: (emri, adresa) => rpc('ruaj_cilesimet', { p_emri: emri, p_adresa: adresa || null }),
    saveCategory: (id, emri, renditja) => rpc('ruaj_kategori', { p_id: id, p_emri: emri, p_renditja: renditja }),
    deleteCategory: (id) => rpc('fshi_kategori', { p_id: id }),
    saveProduct: (id, kat, emri, cmimi, stoku, aktiv) =>
      rpc('ruaj_produkt', { p_id: id, p_kategoria: kat, p_emri: emri, p_cmimi: cmimi, p_stoku: stoku, p_aktiv: aktiv }),
    deleteProduct: (id) => rpc('fshi_produkt', { p_id: id }),
    saveTable: (id, numri, vende) => rpc('ruaj_tavoline', { p_id: id, p_numri: numri, p_kapaciteti: vende }),
    deleteTable: (id) => rpc('fshi_tavoline', { p_id: id }),
    setStaff: (uid, roli, aktiv) => rpc('ndrysho_stafin', { p_user: uid, p_roli: roli, p_aktiv: aktiv }),

    /* ---------- Realtime ---------- */
    subscribe(cb, onState) {
      const describe = (t, p) => {
        const n = p.new || {}, o = p.old || {};
        switch (t) {
          case 'porosite':
            if (p.eventType === 'INSERT') return `Porosia #${n.id} u krijua`;
            if (p.eventType === 'UPDATE') return `#${n.id}: ${STATUS[n.statusi] || n.statusi} · ${eur(n.totali)}`;
            return `Porosia #${o.id} u fshi`;
          case 'porosi_artikujt': return `Artikull në porosinë #${n.porosia_id ?? o.porosia_id}`;
          case 'produktet': return p.eventType === 'DELETE' ? 'Një produkt u fshi' : `"${n.emri}" · ${eur(n.cmimi)}${n.stoku != null ? ' · stoku ' + n.stoku : ''}${n.aktiv === false ? ' · joaktiv' : ''}`;
          case 'tavolinat': return p.eventType === 'DELETE' ? 'Një tavolinë u fshi' : `Tavolina ${n.numri}: ${n.aktive === false ? 'e çaktivizuar' : n.e_zene ? 'e zënë' : 'e lirë'}`;
          case 'kategorite': return p.eventType === 'DELETE' ? 'Një kategori u fshi' : `Kategoria "${n.emri}"`;
          case 'stafi': return p.eventType === 'DELETE' ? 'Një llogari u fshi' : `${n.emri}: ${ROLES[n.roli] || n.roli}${n.aktiv ? '' : ' · pret aprovimin'}`;
          case 'cilesimet': return `Emri i lokalit: ${n.emri_lokalit}`;
          default: return t;
        }
      };
      const ch = sb.channel('lokali-' + Date.now());
      ['porosite', 'porosi_artikujt', 'produktet', 'tavolinat', 'kategorite', 'stafi', 'cilesimet'].forEach((t) => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table: t },
          (p) => cb([{ op: p.eventType, table: t, d: describe(t, p) }]));
      });
      ch.subscribe((status) => onState && onState(
        status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'error' : 'connecting'));
      return () => sb.removeChannel(ch);
    }
  };
}
