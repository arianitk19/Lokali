/* Lokali — funksione ndihmëse dhe konstantet e statuseve */
'use strict';

/* ---------- Ndihmës ---------- */
const $ = (s) => document.querySelector(s);
const fmt = new Intl.NumberFormat('sq-AL', { style: 'currency', currency: 'EUR' });
const eur = (n) => fmt.format(Number(n) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };
const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const hhmm = (d) => new Date(d).toLocaleTimeString('sq-AL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const STATUS = {
  e_re: 'E re', ne_pergatitje: 'Në përgatitje', gati: 'Gati',
  e_sherbyer: 'E shërbyer', e_paguar: 'E paguar', e_anuluar: 'E anuluar'
};
const TRANS = {
  e_re: ['ne_pergatitje', 'e_anuluar'],
  ne_pergatitje: ['gati', 'e_anuluar'],
  gati: ['e_sherbyer', 'e_paguar'],
  e_sherbyer: ['e_paguar']
};
const CLOSED = ['e_paguar', 'e_anuluar'];
