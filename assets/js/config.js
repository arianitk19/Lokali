/* =====================================================================
   Lokali — KONFIGURIMI
   Lidhja me databazën (Supabase → Project Settings → API Keys).
   Çelësi "publishable" është publik nga natyra: siguria bëhet nga
   Row Level Security dhe rolet në databazë (database/schema.sql).
   Emri i lokalit, menuja, tavolinat dhe stafi menaxhohen nga
   aplikacioni (tab-i "Menaxhimi"), jo këtu.
   ===================================================================== */

const CONFIG = {
  SUPABASE_URL: 'https://yrpqaicvzpfrszsjjmqh.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_KzcR7wWHuSyDlPMRU75Bmw_2ka1Pq28'
};
