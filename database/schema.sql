-- =====================================================================
--  LOKALI — Sistemi i porosive për gastronomi
--  Lënda: Sistemet e Avancuara të Bazave të të Dhënave
--  Databaza: PostgreSQL (Supabase, plani falas)
--
--  Si ekzekutohet: Supabase → SQL Editor → New query → ngjit gjithë
--  këtë skedar → Run. Mund të ekzekutohet sërish: fillon duke fshirë
--  objektet ekzistuese.
--
--  Koncepte të avancuara që demonstrohen:
--    1. ENUM type për statuset
--    2. Kolonë e gjeneruar (GENERATED ALWAYS AS ... STORED)
--    3. CHECK constraints + çelësa të huaj (FK)
--    4. Trigger-a (BEFORE / AFTER, row-level) në PL/pgSQL
--    5. Funksione transaksionale (RPC) me SECURITY DEFINER
--    6. Kyçje rreshti (SELECT ... FOR UPDATE) kundër race condition
--    7. View-a me agregime, JSON aggregate dhe window functions (RANK)
--    8. Indekse, përfshirë indeks të pjesshëm (partial index)
--    9. Row Level Security (RLS)
--   10. Realtime (replikim logjik përmes publication)
-- =====================================================================

-- ---------- 0. Pastrimi (që skripta të mund të ekzekutohet sërish) ----
drop view  if exists v_porosite_aktive, v_raporti_sot, v_produktet_top,
                     v_shitjet_ore, v_shitjet_ditore cascade;
drop table if exists porosi_historiku, porosi_artikujt, porosite,
                     tavolinat, produktet, kategorite cascade;
drop function if exists krijo_porosi(int, jsonb, text) cascade;
drop function if exists ndrysho_statusin(bigint, text) cascade;
drop type  if exists statusi_porosise cascade;

-- ---------- 1. Tipet -------------------------------------------------
create type statusi_porosise as enum
  ('e_re', 'ne_pergatitje', 'gati', 'e_sherbyer', 'e_paguar', 'e_anuluar');

-- ---------- 2. Tabelat ----------------------------------------------
create table kategorite (
  id        serial primary key,
  emri      text not null unique,
  renditja  int  not null default 0
);

create table produktet (
  id            serial primary key,
  kategoria_id  int  not null references kategorite(id) on delete restrict,
  emri          text not null unique,
  cmimi         numeric(8,2) not null check (cmimi > 0),
  stoku         int  not null default 100 check (stoku >= 0),
  aktiv         boolean not null default true
);

create table tavolinat (
  id          serial primary key,
  numri       int not null unique,
  kapaciteti  int not null default 4 check (kapaciteti between 1 and 20),
  e_zene      boolean not null default false
);

create table porosite (
  id              bigserial primary key,
  tavolina_id     int not null references tavolinat(id),
  statusi         statusi_porosise not null default 'e_re',
  shenime         text check (char_length(shenime) <= 300),
  totali          numeric(10,2) not null default 0 check (totali >= 0),
  krijuar_me      timestamptz not null default now(),
  perditesuar_me  timestamptz not null default now()
);

create table porosi_artikujt (
  id           bigserial primary key,
  porosia_id   bigint not null references porosite(id) on delete cascade,
  produkti_id  int    not null references produktet(id),
  sasia        int    not null check (sasia between 1 and 50),
  cmimi_njesi  numeric(8,2) not null,           -- vendoset nga trigger-i
  nentotali    numeric(10,2) generated always as (sasia * cmimi_njesi) stored
);

-- Auditimi: çdo ndryshim statusi ruhet këtu nga trigger-i
create table porosi_historiku (
  id              bigserial primary key,
  porosia_id      bigint not null references porosite(id) on delete cascade,
  statusi_vjeter  statusi_porosise,
  statusi_ri      statusi_porosise not null,
  ndryshuar_me    timestamptz not null default now()
);

-- ---------- 3. Indekset ---------------------------------------------
-- Indeks i pjesshëm: kuzhina lexon vetëm porositë e hapura
create index idx_porosite_aktive  on porosite(krijuar_me)
  where statusi not in ('e_paguar', 'e_anuluar');
create index idx_porosite_krijuar on porosite(krijuar_me desc);
create index idx_porosite_tav     on porosite(tavolina_id);
create index idx_artikujt_porosia on porosi_artikujt(porosia_id);
create index idx_artikujt_prod    on porosi_artikujt(produkti_id);
create index idx_produktet_kat    on produktet(kategoria_id);
create index idx_historiku_por    on porosi_historiku(porosia_id);

-- ---------- 4. Trigger-at ---------------------------------------------

-- 4.1 Para futjes së artikullit: kontrollon stokun, e ul atë dhe
--     merr çmimin aktual. FOR UPDATE kyç rreshtin e produktit, që dy
--     porosi njëkohësisht të mos e shesin të njëjtën copë të fundit.
create or replace function fn_artikulli_para_insert()
returns trigger language plpgsql as $$
declare p produktet%rowtype;
begin
  select * into p from produktet where id = new.produkti_id for update;
  if not found then
    raise exception 'Produkti % nuk ekziston', new.produkti_id;
  end if;
  if not p.aktiv then
    raise exception 'Produkti "%" nuk është në dispozicion', p.emri;
  end if;
  if p.stoku < new.sasia then
    raise exception 'Stok i pamjaftueshëm për "%": kanë mbetur %', p.emri, p.stoku;
  end if;
  update produktet set stoku = stoku - new.sasia where id = p.id;
  new.cmimi_njesi := p.cmimi;
  return new;
end $$;

create trigger trg_artikulli_para_insert
  before insert on porosi_artikujt
  for each row execute function fn_artikulli_para_insert();

-- 4.2 Pas çdo ndryshimi në artikuj: rillogarit totalin e porosisë
create or replace function fn_rillogarit_totalin()
returns trigger language plpgsql as $$
declare pid bigint;
begin
  if tg_op = 'DELETE' then pid := old.porosia_id; else pid := new.porosia_id; end if;
  update porosite
     set totali = coalesce((select sum(nentotali) from porosi_artikujt
                             where porosia_id = pid), 0)
   where id = pid;
  return null;
end $$;

create trigger trg_rillogarit_totalin
  after insert or update or delete on porosi_artikujt
  for each row execute function fn_rillogarit_totalin();

-- 4.3 Para përditësimit të porosisë: lejon vetëm kalime të vlefshme
--     statusi (makinë gjendjesh) dhe vendos kohën e përditësimit.
create or replace function fn_porosia_para_update()
returns trigger language plpgsql as $$
begin
  if new.statusi is distinct from old.statusi then
    if not (
         (old.statusi = 'e_re'          and new.statusi in ('ne_pergatitje', 'e_anuluar'))
      or (old.statusi = 'ne_pergatitje' and new.statusi in ('gati', 'e_anuluar'))
      or (old.statusi = 'gati'          and new.statusi in ('e_sherbyer', 'e_paguar'))
      or (old.statusi = 'e_sherbyer'    and new.statusi = 'e_paguar')
    ) then
      raise exception 'Kalim i palejuar statusi: % → %', old.statusi, new.statusi;
    end if;
  end if;
  new.perditesuar_me := now();
  return new;
end $$;

create trigger trg_porosia_para_update
  before update on porosite
  for each row execute function fn_porosia_para_update();

-- 4.4 Pas krijimit / ndryshimit të statusit: auditim, kthim i stokut
--     kur anulohet, dhe përditësim i gjendjes së tavolinës.
create or replace function fn_porosia_pas_ndryshimit()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into porosi_historiku(porosia_id, statusi_vjeter, statusi_ri)
    values (new.id, null, new.statusi);
    update tavolinat set e_zene = true where id = new.tavolina_id;

  elsif new.statusi is distinct from old.statusi then
    insert into porosi_historiku(porosia_id, statusi_vjeter, statusi_ri)
    values (new.id, old.statusi, new.statusi);

    if new.statusi = 'e_anuluar' then
      update produktet p
         set stoku = p.stoku + a.sasia
        from (select produkti_id, sum(sasia) as sasia
                from porosi_artikujt where porosia_id = new.id
               group by produkti_id) a
       where p.id = a.produkti_id;
    end if;

    if new.statusi in ('e_paguar', 'e_anuluar') then
      update tavolinat t
         set e_zene = exists (select 1 from porosite o
                               where o.tavolina_id = t.id
                                 and o.statusi not in ('e_paguar', 'e_anuluar'))
       where t.id = new.tavolina_id;
    end if;
  end if;
  return null;
end $$;

create trigger trg_porosia_pas_insert
  after insert on porosite
  for each row execute function fn_porosia_pas_ndryshimit();

create trigger trg_porosia_pas_update
  after update of statusi on porosite
  for each row execute function fn_porosia_pas_ndryshimit();

-- ---------- 5. Funksionet RPC (thirren nga web app) -------------------

-- 5.1 Krijon një porosi me të gjithë artikujt në NJË transaksion.
--     Nëse një artikull dështon (p.sh. s'ka stok), gjithçka kthehet mbrapsht.
--     p_artikujt: [{"produkti_id": 1, "sasia": 2}, ...]
create or replace function krijo_porosi(p_tavolina int, p_artikujt jsonb, p_shenime text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; a jsonb;
begin
  if p_artikujt is null or jsonb_typeof(p_artikujt) <> 'array'
     or jsonb_array_length(p_artikujt) = 0 then
    raise exception 'Porosia duhet të ketë të paktën një artikull';
  end if;

  insert into porosite(tavolina_id, shenime)
  values (p_tavolina, nullif(trim(p_shenime), ''))
  returning id into v_id;

  for a in select * from jsonb_array_elements(p_artikujt) loop
    insert into porosi_artikujt(porosia_id, produkti_id, sasia)
    values (v_id, (a->>'produkti_id')::int, (a->>'sasia')::int);
  end loop;

  return v_id;
end $$;

-- 5.2 Ndryshon statusin (validimi bëhet nga trigger-i 4.3)
create or replace function ndrysho_statusin(p_id bigint, p_statusi text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update porosite set statusi = p_statusi::statusi_porosise where id = p_id;
  if not found then
    raise exception 'Porosia #% nuk u gjet', p_id;
  end if;
end $$;

-- ---------- 6. View-at ------------------------------------------------

-- 6.1 Porositë e hapura me artikujt si JSON (për kuzhinën dhe sallën)
create view v_porosite_aktive with (security_invoker = true) as
select o.id, o.tavolina_id, t.numri as tavolina, o.statusi, o.shenime,
       o.totali, o.krijuar_me, o.perditesuar_me,
       coalesce(
         jsonb_agg(jsonb_build_object('emri', p.emri, 'sasia', a.sasia,
                                      'nentotali', a.nentotali)
                   order by a.id) filter (where a.id is not null),
         '[]'::jsonb) as artikujt
  from porosite o
  join tavolinat t on t.id = o.tavolina_id
  left join porosi_artikujt a on a.porosia_id = o.id
  left join produktet p on p.id = a.produkti_id
 where o.statusi not in ('e_paguar', 'e_anuluar')
 group by o.id, t.numri;

-- 6.2 Përmbledhja e ditës (agregime me FILTER)
create view v_raporti_sot with (security_invoker = true) as
select count(*)    filter (where statusi = 'e_paguar')                     as porosi_paguar,
       coalesce(sum(totali) filter (where statusi = 'e_paguar'), 0)        as xhiro,
       coalesce(round(avg(totali) filter (where statusi = 'e_paguar'), 2), 0) as mesatarja,
       count(*)    filter (where statusi not in ('e_paguar', 'e_anuluar')) as aktive,
       count(*)    filter (where statusi = 'e_anuluar')                    as anuluar
  from porosite
 where krijuar_me >= (date_trunc('day', now() at time zone 'Europe/Belgrade')
                      at time zone 'Europe/Belgrade');

-- 6.3 Produktet më të shitura me WINDOW FUNCTIONS (RANK)
create view v_produktet_top with (security_invoker = true) as
select p.emri, k.emri as kategoria,
       sum(a.sasia)::int as sasia,
       sum(a.nentotali)  as te_ardhurat,
       rank() over (order by sum(a.sasia) desc)                      as renditja,
       rank() over (partition by k.id order by sum(a.sasia) desc)    as renditja_ne_kategori
  from porosi_artikujt a
  join porosite   o on o.id = a.porosia_id and o.statusi <> 'e_anuluar'
  join produktet  p on p.id = a.produkti_id
  join kategorite k on k.id = p.kategoria_id
 group by p.id, p.emri, k.id, k.emri;

-- 6.4 Shitjet sipas orës për sot
create view v_shitjet_ore with (security_invoker = true) as
select extract(hour from krijuar_me at time zone 'Europe/Belgrade')::int as ora,
       count(*)::int as porosi,
       sum(totali)   as xhiro
  from porosite
 where statusi = 'e_paguar'
   and krijuar_me >= (date_trunc('day', now() at time zone 'Europe/Belgrade')
                      at time zone 'Europe/Belgrade')
 group by 1;

-- 6.5 Shitjet ditore me total kumulativ (window SUM)
create view v_shitjet_ditore with (security_invoker = true) as
select (krijuar_me at time zone 'Europe/Belgrade')::date as dita,
       count(*)::int as porosi,
       sum(totali)   as xhiro,
       sum(sum(totali)) over (order by (krijuar_me at time zone 'Europe/Belgrade')::date) as kumulative
  from porosite
 where statusi = 'e_paguar'
 group by (krijuar_me at time zone 'Europe/Belgrade')::date;

-- ---------- 7. Row Level Security -------------------------------------
-- Publiku (çelësi anon) mund vetëm të LEXOJË. Shkrimi bëhet VETËM
-- përmes funksioneve RPC (security definer), që zbatojnë rregullat.
alter table kategorite       enable row level security;
alter table produktet        enable row level security;
alter table tavolinat        enable row level security;
alter table porosite         enable row level security;
alter table porosi_artikujt  enable row level security;
alter table porosi_historiku enable row level security;

create policy lexim_publik on kategorite       for select to anon, authenticated using (true);
create policy lexim_publik on produktet        for select to anon, authenticated using (true);
create policy lexim_publik on tavolinat        for select to anon, authenticated using (true);
create policy lexim_publik on porosite         for select to anon, authenticated using (true);
create policy lexim_publik on porosi_artikujt  for select to anon, authenticated using (true);
create policy lexim_publik on porosi_historiku for select to anon, authenticated using (true);

revoke all on function krijo_porosi(int, jsonb, text) from public;
revoke all on function ndrysho_statusin(bigint, text) from public;
grant execute on function krijo_porosi(int, jsonb, text) to anon, authenticated;
grant execute on function ndrysho_statusin(bigint, text) to anon, authenticated;

-- ---------- 8. Realtime -------------------------------------------------
-- Ndryshimet në këto tabela dërgohen live te të gjithë klientët.
alter publication supabase_realtime add table porosite, porosi_artikujt, produktet, tavolinat;

-- ---------- 9. Të dhënat fillestare -----------------------------------
insert into kategorite(emri, renditja) values
  ('Kafe & Çaj', 1), ('Pije', 2), ('Ushqim', 3), ('Ëmbëlsira', 4);

insert into produktet(kategoria_id, emri, cmimi, stoku) values
  (1, 'Espresso', 1.00, 200), (1, 'Makiato', 1.20, 200), (1, 'Kapuçino', 1.50, 150),
  (1, 'Çaj i zi', 1.00, 120), (1, 'Çaj mali', 1.20, 80),
  (2, 'Ujë mineral', 0.80, 150), (2, 'Lëng portokalli i shtrydhur', 2.00, 40),
  (2, 'Coca-Cola', 1.50, 90), (2, 'Limonadë', 1.80, 60),
  (3, 'Sanduiç me pulë', 3.50, 30), (3, 'Pica Margarita', 5.00, 25),
  (3, 'Pasta Bolonjeze', 5.50, 20), (3, 'Sallatë Cezar', 4.00, 18),
  (3, 'Pite me spinaq', 2.50, 6),
  (4, 'Trileçe', 2.00, 24), (4, 'Bakllava', 2.00, 30), (4, 'Tortë me çokollatë', 2.50, 4);

insert into tavolinat(numri, kapaciteti)
select n, (array[2,4,4,6,2,4,8,4,2,6])[n] from generate_series(1, 10) n;

-- Disa porosi shembull, që raportet të mos jenë bosh
do $$
declare id bigint;
begin
  id := krijo_porosi(2, '[{"produkti_id":1,"sasia":2},{"produkti_id":16,"sasia":1}]');
  perform ndrysho_statusin(id, 'ne_pergatitje'); perform ndrysho_statusin(id, 'gati');
  perform ndrysho_statusin(id, 'e_sherbyer');    perform ndrysho_statusin(id, 'e_paguar');

  id := krijo_porosi(4, '[{"produkti_id":11,"sasia":2},{"produkti_id":8,"sasia":2}]');
  perform ndrysho_statusin(id, 'ne_pergatitje'); perform ndrysho_statusin(id, 'gati');
  perform ndrysho_statusin(id, 'e_paguar');

  id := krijo_porosi(6, '[{"produkti_id":3,"sasia":2},{"produkti_id":15,"sasia":2}]');
  perform ndrysho_statusin(id, 'ne_pergatitje'); perform ndrysho_statusin(id, 'gati');
  perform ndrysho_statusin(id, 'e_sherbyer');    perform ndrysho_statusin(id, 'e_paguar');

  id := krijo_porosi(1, '[{"produkti_id":12,"sasia":1},{"produkti_id":13,"sasia":1},{"produkti_id":6,"sasia":2}]');
  perform ndrysho_statusin(id, 'ne_pergatitje'); perform ndrysho_statusin(id, 'gati');
  perform ndrysho_statusin(id, 'e_sherbyer');

  id := krijo_porosi(5, '[{"produkti_id":10,"sasia":2},{"produkti_id":9,"sasia":2}]');
  perform ndrysho_statusin(id, 'ne_pergatitje');

  perform krijo_porosi(3, '[{"produkti_id":2,"sasia":3},{"produkti_id":17,"sasia":1}]', 'Makiato pa sheqer');
end $$;

-- =====================================================================
--  10. PYETJE PËR PREZANTIM (ekzekutoji një nga një)
-- =====================================================================
-- a) Trigger-i e refuzon porosinë kur s'ka stok (transaksioni kthehet mbrapsht):
--    select krijo_porosi(1, '[{"produkti_id":17,"sasia":40}]');
--
-- b) Makina e gjendjeve e refuzon kalimin e gabuar:
--    select ndrysho_statusin((select max(id) from porosite), 'e_paguar');
--
-- c) Historiku i auditimit:
--    select * from porosi_historiku order by ndryshuar_me desc limit 20;
--
-- d) Window functions:
--    select * from v_produktet_top order by renditja;
--
-- e) Plani i ekzekutimit dhe përdorimi i indeksit të pjesshëm:
--    explain analyze select * from porosite
--     where statusi not in ('e_paguar','e_anuluar') order by krijuar_me;
