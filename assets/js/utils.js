/* Lokali — funksione ndihmëse, statuset dhe rolet */
'use strict';

/* ---------- Ndihmës ---------- */
const $ = (s) => document.querySelector(s);
const fmt = new Intl.NumberFormat('sq-AL', { style: 'currency', currency: 'EUR' });
const eur = (n) => fmt.format(Number(n) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const hhmm = (d) => new Date(d).toLocaleTimeString('sq-AL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hm = (d) => new Date(d).toLocaleTimeString('sq-AL', { hour: '2-digit', minute: '2-digit', hour12: false });

/* ---------- Statuset e porosisë ---------- */
const STATUS = {
  e_re: 'E re', ne_pergatitje: 'Në përgatitje', gati: 'Gati',
  e_sherbyer: 'E shërbyer', e_paguar: 'E paguar', e_anuluar: 'E anuluar'
};
const CLOSED = ['e_paguar', 'e_anuluar'];

/* ---------- Rolet e stafit ---------- */
const ROLES = { admin: 'Administrator', kamarier: 'Kamarier', kuzhina: 'Kuzhinë' };

// Pamjet që sheh çdo rol
const VIEWS_BY_ROLE = {
  admin: ['salla', 'kuzhina', 'arka', 'menaxhimi', 'aktiviteti'],
  kamarier: ['salla', 'kuzhina', 'arka'],
  kuzhina: ['kuzhina']
};

// Statuset që mund të vendosë çdo rol (databaza e zbaton të njëjtin rregull)
const STATUS_BY_ROLE = {
  admin: ['ne_pergatitje', 'gati', 'e_sherbyer', 'e_paguar', 'e_anuluar'],
  kamarier: ['e_sherbyer', 'e_paguar', 'e_anuluar'],
  kuzhina: ['ne_pergatitje', 'gati', 'e_anuluar']
};
