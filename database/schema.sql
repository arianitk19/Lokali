-- =====================================================================
--  LOKALI — Sistemi i porosive për gastronomi
--  Lënda: Sistemet e Avancuara të Bazave të të Dhënave
--  Databaza: PostgreSQL 15+ (Supabase)
--
--  Si ekzekutohet: Supabase → SQL Editor → New query → ngjit gjithë
--  këtë skedar → Run.
--
--  ⚠ KUJDES: skripta fillon duke FSHIRË tabelat ekzistuese. Ekzekutoje
--  vetëm herën e parë (ose kur do ta nisësh databazën nga zero).
--
--  Databaza fillon BOSH: menunë, tavolinat dhe stafin i shton vetë
--  administratori nga aplikacioni (tab-i "Menaxhimi").
--
--  Koncepte të avancuara:
--    1. ENUM types (statusi i porosisë, roli i stafit)
--    2. Kolonë e gjeneruar (GENERATED ALWAYS AS ... STORED)
--    3. CHECK, UNIQUE, çelësa të huaj me ON DELETE CASCADE / SET NULL
--    4. Trigger-a BEFORE / AFTER në PL/pgSQL, përfshirë trigger mbi auth.users
--    5. Funksione transaksionale (RPC) me SECURITY DEFINER
--    6. Kontroll konkurrence me SELECT ... FOR UPDATE
--    7. Kontroll qasjeje sipas rolit (RBAC) + Row Level Security
--    8. Fshirje e butë (soft delete) për të ruajtur historikun
--    9. View-a me JSON aggregate, FILTER dhe window functions (RANK, SUM OVER)
--   10. Indeks i pjesshëm (partial index)
--   11. Realtime (replikim logjik përmes publication)
-- =====================================================================

-- ---------- 0. Pastrimi -----------------------------------------------
drop trigger if exists trg_stafi_i_ri on auth.users;
drop view  if exists v_porosite_aktive, v_porosite_sot, v_raporti_sot, v_produktet_top,
                     v_shitjet_ore, v_shitjet_ditore cascade;
drop table if exists porosi_historiku, porosi_artikujt, porosite, tavolinat,
                     produktet, kategorite, stafi, cilesimet cascade;
drop function if exists krijo_porosi(int, jsonb, text) cascade;
drop function if exists ndrysho_statusin(bigint, text) cascade;
drop function if exists ruaj_kategori(int, text, int) cascade;
drop function if exists fshi_kategori(int) cascade;
drop function if exists ruaj_produkt(int, int, text, numeric, int, boolean) cascade;
drop function if exists fshi_produkt(int) cascade;
drop function if exists ruaj_tavoline(int, int, int) cascade;
drop function if exists fshi_tavoline(int) cascade;
drop function if exists ruaj_cilesimet(text, text) cascade;
drop function if exists ndrysho_stafin(uuid, text, boolean) cascade;
drop function if exists roli_im() cascade;
drop function if exists kerko_rolin(text[]) cascade;
drop function if exists fn_stafi_i_ri() cascade;
drop type  if exists statusi_porosise cascade;
drop type  if exists roli_stafit cascade;

-- ---------- 1. Tipet --------------------------------------------------
create type statusi_porosise as enum
  ('e_re', 'ne_pergatitje', 'gati', 'e_sherbyer', 'e_paguar', 'e_anuluar');

create type roli_stafit as enum ('admin', 'kamarier', 'kuzhina');

-- ---------- 2. Tabelat ------------------------------------------------

-- Të dhënat e lokalit (gjithmonë një rresht i vetëm)
create table cilesimet (
  id              int primary key default 1 check (id = 1),
  emri_lokalit    text not null default 'Lokali im' check (char_length(emri_lokalit) between 1 and 60),
  adresa          text check (char_length(adresa) <= 120),
  perditesuar_me  timestamptz not null default now()
);

-- Stafi: lidhet 1:1 me llogaritë e Supabase Auth
create table stafi (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  emri        text not null check (char_length(emri) between 1 and 60),
  email       text,
  roli        roli_stafit not null default 'kamarier',
  aktiv       boolean not null default false,       -- llogaritë e reja presin aprovimin
  krijuar_me  timestamptz not null default now()
);

create table kategorite (
  id        serial primary key,
  emri      text not null unique check (char_length(emri) between 1 and 40),
  renditja  int  not null default 0
);

create table produktet (
  id            serial primary key,
  kategoria_id  int  not null references kategorite(id) on delete restrict,
  emri          text not null unique check (char_length(emri) between 1 and 60),
  cmimi         numeric(8,2) not null check (cmimi > 0),
  stoku         int  check (stoku >= 0),             -- NULL = pa kufi stoku (p.sh. kafeja)
  aktiv         boolean not null default true
);

create table tavolinat (
  id          serial primary key,
  numri       int not null unique check (numri between 1 and 999),
  kapaciteti  int not null default 4 check (kapaciteti between 1 and 30),
  e_zene      boolean not null default false,
  aktive      boolean not null default true          -- soft delete
);

create table porosite (
  id              bigserial primary key,
  tavolina_id     int not null references tavolinat(id),
  statusi         statusi_porosise not null default 'e_re',
  shenime         text check (char_length(shenime) <= 300),
  totali          numeric(10,2) not null default 0 check (totali >= 0),
  krijuar_nga     uuid references stafi(user_id) on delete set null,
  krijuar_me      timestamptz not null default now(),
  perditesuar_me  timestamptz not null default now()
);

create table porosi_artikujt (
  id           bigserial primary key,
  porosia_id   bigint not null references porosite(id) on delete cascade,
  produkti_id  int    not null references produktet(id),
  sasia        int    not null check (sasia between 1 and 50),
  cmimi_njesi  numeric(8,2) not null,               -- vendoset nga trigger-i
  nentotali    numeric(10,2) generated always as (sasia * cmimi_njesi) stored
);

-- Auditimi: çdo ndryshim statusi, kush e bëri dhe kur
create table porosi_historiku (
  id              bigserial primary key,
  porosia_id      bigint not null references porosite(id) on delete cascade,
  statusi_vjeter  statusi_porosise,
  statusi_ri      statusi_porosise not null,
  ndryshuar_nga   uuid references stafi(user_id) on delete set null,
  ndryshuar_me    timestamptz not null default now()
);

-- ---------- 3. Indekset -----------------------------------------------
create index idx_porosite_aktive  on porosite(krijuar_me)
  where statusi not in ('e_paguar', 'e_anuluar');            -- indeks i pjesshëm
create index idx_porosite_krijuar on porosite(krijuar_me desc);
create index idx_porosite_tav     on porosite(tavolina_id);
create index idx_artikujt_porosia on porosi_artikujt(porosia_id);
create index idx_artikujt_prod    on porosi_artikujt(produkti_id);
create index idx_produktet_kat    on produktet(kategoria_id);
create index idx_historiku_por    on porosi_historiku(porosia_id);

insert into cilesimet(id) values (1);

-- ---------- 4. Rolet dhe qasja ----------------------------------------

-- Roli i përdoruesit aktual (NULL nëse s'është staf aktiv)
create or replace function roli_im()
returns roli_stafit
language sql stable security definer set search_path = public as $$
  select roli from stafi where user_id = auth.uid() and aktiv
$$;

-- Ndalon funksionin nëse përdoruesi s'ka një nga rolet e lejuara
create or replace function kerko_rolin(p_rolet text[])
returns roli_stafit
language plpgsql stable security definer set search_path = public as $$
declare r roli_stafit := roli_im();
begin
  if r is null then
    raise exception 'Duhet të jesh i kyçur si staf aktiv';
  end if;
  if not (r::text = any (p_rolet)) then
    raise exception 'Roli "%" nuk e ka këtë leje', r;
  end if;
  return r;
end $$;

-- Kur dikush regjistrohet: krijohet rreshti në stafi.
-- Llogaria e PARË bëhet administrator; të tjerat presin aprovimin.
create or replace function fn_stafi_i_ri()
returns trigger
language plpgsql security definer set search_path = public as $$
declare i_pari boolean;
begin
  i_pari := not exists (select 1 from stafi where roli = 'admin');
  insert into stafi(user_id, emri, email, roli, aktiv)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data->>'emri'), ''), split_part(new.email, '@', 1)),
          new.email,
          case when i_pari then 'admin'::roli_stafit else 'kamarier'::roli_stafit end,
          i_pari);
  return new;
end $$;

create trigger trg_stafi_i_ri
  after insert on auth.users
  for each row execute function fn_stafi_i_ri();

-- ---------- 5. Trigger-at e porosive ----------------------------------

-- 5.1 Para futjes së artikullit: kontrollon stokun, e ul dhe merr çmimin.
--     FOR UPDATE kyç rreshtin, që dy porosi njëkohësisht të mos e
--     shesin të njëjtën copë të fundit.
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
  if p.stoku is not null then
    if p.stoku < new.sasia then
      raise exception 'Stok i pamjaftueshëm për "%": kanë mbetur %', p.emri, p.stoku;
    end if;
    update produktet set stoku = stoku - new.sasia where id = p.id;
  end if;
  new.cmimi_njesi := p.cmimi;
  return new;
end $$;

create trigger trg_artikulli_para_insert
  before insert on porosi_artikujt
  for each row execute function fn_artikulli_para_insert();

-- 5.2 Pas çdo ndryshimi në artikuj: rillogarit totalin
create or replace function fn_rillogarit_totalin()
returns trigger language plpgsql as $$
declare pid bigint;
begin
  if tg_op = 'DELETE' then pid := old.porosia_id; else pid := new.porosia_id; end if;
  update porosite
     set totali = coalesce((select sum(nentotali) from porosi_artikujt where porosia_id = pid), 0)
   where id = pid;
  return null;
end $$;

create trigger trg_rillogarit_totalin
  after insert or update or delete on porosi_artikujt
  for each row execute function fn_rillogarit_totalin();

-- 5.3 Makina e gjendjeve: lejon vetëm kalime të vlefshme statusi
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

-- 5.4 Auditim, kthim stoku kur anulohet, gjendja e tavolinës
create or replace function fn_porosia_pas_ndryshimit()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into porosi_historiku(porosia_id, statusi_vjeter, statusi_ri, ndryshuar_nga)
    values (new.id, null, new.statusi, auth.uid());
    update tavolinat set e_zene = true where id = new.tavolina_id;

  elsif new.statusi is distinct from old.statusi then
    insert into porosi_historiku(porosia_id, statusi_vjeter, statusi_ri, ndryshuar_nga)
    values (new.id, old.statusi, new.statusi, auth.uid());

    if new.statusi = 'e_anuluar' then
      update produktet p
         set stoku = p.stoku + a.sasia
        from (select produkti_id, sum(sasia) as sasia
                from porosi_artikujt where porosia_id = new.id
               group by produkti_id) a
       where p.id = a.produkti_id and p.stoku is not null;
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

-- ---------- 6. Funksionet RPC: porositë --------------------------------

-- Krijon porosinë me të gjithë artikujt në NJË transaksion.
-- p_artikujt: [{"produkti_id": 1, "sasia": 2}, ...]
create or replace function krijo_porosi(p_tavolina int, p_artikujt jsonb, p_shenime text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; a jsonb;
begin
  perform kerko_rolin(array['admin', 'kamarier']);
  if p_artikujt is null or jsonb_typeof(p_artikujt) <> 'array' or jsonb_array_length(p_artikujt) = 0 then
    raise exception 'Porosia duhet të ketë të paktën një artikull';
  end if;
  if not exists (select 1 from tavolinat where id = p_tavolina and aktive) then
    raise exception 'Tavolina nuk ekziston';
  end if;

  insert into porosite(tavolina_id, shenime, krijuar_nga)
  values (p_tavolina, nullif(trim(p_shenime), ''), auth.uid())
  returning id into v_id;

  for a in select * from jsonb_array_elements(p_artikujt) loop
    insert into porosi_artikujt(porosia_id, produkti_id, sasia)
    values (v_id, (a->>'produkti_id')::int, (a->>'sasia')::int);
  end loop;
  return v_id;
end $$;

-- Ndryshon statusin. Kuzhina përgatit, kamarieri shërben dhe arkëton.
create or replace function ndrysho_statusin(p_id bigint, p_statusi text)
returns void
language plpgsql security definer set search_path = public as $$
declare r roli_stafit := kerko_rolin(array['admin', 'kamarier', 'kuzhina']);
begin
  if r = 'kuzhina'  and p_statusi not in ('ne_pergatitje', 'gati', 'e_anuluar') then
    raise exception 'Kuzhina nuk mund ta shënojë porosinë "%"', p_statusi;
  end if;
  if r = 'kamarier' and p_statusi not in ('e_sherbyer', 'e_paguar', 'e_anuluar') then
    raise exception 'Kamarieri nuk mund ta shënojë porosinë "%"', p_statusi;
  end if;
  update porosite set statusi = p_statusi::statusi_porosise where id = p_id;
  if not found then
    raise exception 'Porosia #% nuk u gjet', p_id;
  end if;
end $$;

-- ---------- 7. Funksionet RPC: menaxhimi (vetëm admin) ----------------

create or replace function ruaj_kategori(p_id int, p_emri text, p_renditja int default 0)
returns int
language plpgsql security definer set search_path = public as $$
declare v_id int;
begin
  perform kerko_rolin(array['admin']);
  if p_id is null then
    insert into kategorite(emri, renditja) values (trim(p_emri), coalesce(p_renditja, 0)) returning id into v_id;
  else
    update kategorite set emri = trim(p_emri), renditja = coalesce(p_renditja, 0) where id = p_id returning id into v_id;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'Ekziston tashmë një kategori "%"', trim(p_emri);
end $$;

create or replace function fshi_kategori(p_id int)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform kerko_rolin(array['admin']);
  if exists (select 1 from produktet where kategoria_id = p_id) then
    raise exception 'Kategoria ka produkte. Zhvendosi ose fshiji ato fillimisht.';
  end if;
  delete from kategorite where id = p_id;
end $$;

create or replace function ruaj_produkt(p_id int, p_kategoria int, p_emri text, p_cmimi numeric,
                                        p_stoku int default null, p_aktiv boolean default true)
returns int
language plpgsql security definer set search_path = public as $$
declare v_id int;
begin
  perform kerko_rolin(array['admin']);
  if p_id is null then
    insert into produktet(kategoria_id, emri, cmimi, stoku, aktiv)
    values (p_kategoria, trim(p_emri), p_cmimi, p_stoku, coalesce(p_aktiv, true)) returning id into v_id;
  else
    update produktet set kategoria_id = p_kategoria, emri = trim(p_emri), cmimi = p_cmimi,
                         stoku = p_stoku, aktiv = coalesce(p_aktiv, true)
     where id = p_id returning id into v_id;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'Ekziston tashmë një produkt "%"', trim(p_emri);
  when check_violation  then raise exception 'Kontrollo çmimin (> 0) dhe stokun (≥ 0)';
end $$;

-- Nëse produkti është shitur më parë, çaktivizohet (ruhet historiku)
create or replace function fshi_produkt(p_id int)
returns text
language plpgsql security definer set search_path = public as $$
begin
  perform kerko_rolin(array['admin']);
  if exists (select 1 from porosi_artikujt where produkti_id = p_id) then
    update produktet set aktiv = false where id = p_id;
    return 'caktivizuar';
  end if;
  delete from produktet where id = p_id;
  return 'fshire';
end $$;

create or replace function ruaj_tavoline(p_id int, p_numri int, p_kapaciteti int default 4)
returns int
language plpgsql security definer set search_path = public as $$
declare v_id int;
begin
  perform kerko_rolin(array['admin']);
  if p_id is null then
    -- nëse tavolina me këtë numër ishte fshirë më parë, riaktivizohet
    update tavolinat set aktive = true, kapaciteti = coalesce(p_kapaciteti, 4)
     where numri = p_numri and not aktive returning id into v_id;
    if v_id is null then
      insert into tavolinat(numri, kapaciteti) values (p_numri, coalesce(p_kapaciteti, 4)) returning id into v_id;
    end if;
  else
    update tavolinat set numri = p_numri, kapaciteti = coalesce(p_kapaciteti, 4) where id = p_id returning id into v_id;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'Tavolina % ekziston tashmë', p_numri;
  when check_violation  then raise exception 'Numri 1–999, vendet 1–30';
end $$;

create or replace function fshi_tavoline(p_id int)
returns text
language plpgsql security definer set search_path = public as $$
begin
  perform kerko_rolin(array['admin']);
  if exists (select 1 from porosite where tavolina_id = p_id and statusi not in ('e_paguar', 'e_anuluar')) then
    raise exception 'Tavolina ka porosi të hapura';
  end if;
  if exists (select 1 from porosite where tavolina_id = p_id) then
    update tavolinat set aktive = false where id = p_id;
    return 'caktivizuar';
  end if;
  delete from tavolinat where id = p_id;
  return 'fshire';
end $$;

create or replace function ruaj_cilesimet(p_emri text, p_adresa text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform kerko_rolin(array['admin']);
  update cilesimet set emri_lokalit = trim(p_emri), adresa = nullif(trim(p_adresa), ''),
                       perditesuar_me = now()
   where id = 1;
end $$;

-- Admini aprovon stafin dhe u cakton rolin
create or replace function ndrysho_stafin(p_user uuid, p_roli text, p_aktiv boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform kerko_rolin(array['admin']);
  if (p_roli <> 'admin' or not p_aktiv)
     and exists (select 1 from stafi where user_id = p_user and roli = 'admin' and aktiv)
     and (select count(*) from stafi where roli = 'admin' and aktiv) = 1 then
    raise exception 'Duhet të mbetet të paktën një administrator aktiv';
  end if;
  update stafi set roli = p_roli::roli_stafit, aktiv = p_aktiv where user_id = p_user;
end $$;

-- ---------- 8. View-at ------------------------------------------------

-- Porositë e hapura me artikujt si JSON (kuzhina, salla, arka)
create view v_porosite_aktive with (security_invoker = true) as
select o.id, o.tavolina_id, t.numri as tavolina, o.statusi, o.shenime, o.totali,
       o.krijuar_me, o.perditesuar_me, s.emri as kamarieri,
       coalesce(jsonb_agg(jsonb_build_object('emri', p.emri, 'sasia', a.sasia, 'nentotali', a.nentotali)
                          order by a.id) filter (where a.id is not null), '[]'::jsonb) as artikujt
  from porosite o
  join tavolinat t on t.id = o.tavolina_id
  left join stafi s on s.user_id = o.krijuar_nga
  left join porosi_artikujt a on a.porosia_id = o.id
  left join produktet p on p.id = a.produkti_id
 where o.statusi not in ('e_paguar', 'e_anuluar')
 group by o.id, t.numri, s.emri;

-- Porositë e mbyllura sot (për arkën)
create view v_porosite_sot with (security_invoker = true) as
select o.id, t.numri as tavolina, o.statusi, o.totali, o.perditesuar_me, s.emri as kamarieri,
       coalesce(jsonb_agg(jsonb_build_object('emri', p.emri, 'sasia', a.sasia) order by a.id)
                filter (where a.id is not null), '[]'::jsonb) as artikujt
  from porosite o
  join tavolinat t on t.id = o.tavolina_id
  left join stafi s on s.user_id = o.krijuar_nga
  left join porosi_artikujt a on a.porosia_id = o.id
  left join produktet p on p.id = a.produkti_id
 where o.statusi in ('e_paguar', 'e_anuluar')
   and o.krijuar_me >= (date_trunc('day', now() at time zone 'Europe/Belgrade') at time zone 'Europe/Belgrade')
 group by o.id, t.numri, s.emri;

-- Përmbledhja e ditës (agregime me FILTER)
create view v_raporti_sot with (security_invoker = true) as
select count(*) filter (where statusi = 'e_paguar')                            as porosi_paguar,
       coalesce(sum(totali) filter (where statusi = 'e_paguar'), 0)           as xhiro,
       coalesce(round(avg(totali) filter (where statusi = 'e_paguar'), 2), 0) as mesatarja,
       count(*) filter (where statusi not in ('e_paguar', 'e_anuluar'))       as aktive,
       count(*) filter (where statusi = 'e_anuluar')                          as anuluar
  from porosite
 where krijuar_me >= (date_trunc('day', now() at time zone 'Europe/Belgrade') at time zone 'Europe/Belgrade');

-- Produktet më të shitura (window functions)
create view v_produktet_top with (security_invoker = true) as
select p.emri, k.emri as kategoria,
       sum(a.sasia)::int as sasia,
       sum(a.nentotali)  as te_ardhurat,
       rank() over (order by sum(a.sasia) desc)                   as renditja,
       rank() over (partition by k.id order by sum(a.sasia) desc) as renditja_ne_kategori
  from porosi_artikujt a
  join porosite   o on o.id = a.porosia_id and o.statusi <> 'e_anuluar'
  join produktet  p on p.id = a.produkti_id
  join kategorite k on k.id = p.kategoria_id
 group by p.id, p.emri, k.id, k.emri;

-- Shitjet sipas orës, sot
create view v_shitjet_ore with (security_invoker = true) as
select extract(hour from krijuar_me at time zone 'Europe/Belgrade')::int as ora,
       count(*)::int as porosi, sum(totali) as xhiro
  from porosite
 where statusi = 'e_paguar'
   and krijuar_me >= (date_trunc('day', now() at time zone 'Europe/Belgrade') at time zone 'Europe/Belgrade')
 group by 1;

-- Shitjet ditore me total kumulativ (SUM OVER)
create view v_shitjet_ditore with (security_invoker = true) as
select (krijuar_me at time zone 'Europe/Belgrade')::date as dita,
       count(*)::int as porosi, sum(totali) as xhiro,
       sum(sum(totali)) over (order by (krijuar_me at time zone 'Europe/Belgrade')::date) as kumulative
  from porosite
 where statusi = 'e_paguar'
 group by (krijuar_me at time zone 'Europe/Belgrade')::date;

-- ---------- 9. Row Level Security -------------------------------------
-- Vetëm stafi aktiv lexon të dhënat. Askush nuk shkruan direkt në
-- tabela: çdo ndryshim kalon përmes funksioneve të mësipërme.
alter table cilesimet        enable row level security;
alter table stafi            enable row level security;
alter table kategorite       enable row level security;
alter table produktet        enable row level security;
alter table tavolinat        enable row level security;
alter table porosite         enable row level security;
alter table porosi_artikujt  enable row level security;
alter table porosi_historiku enable row level security;

create policy lexim_publik on cilesimet for select to anon, authenticated using (true);
create policy lexim_stafi  on stafi     for select to authenticated
  using (roli_im() is not null or user_id = auth.uid());
create policy lexim_stafi  on kategorite       for select to authenticated using (roli_im() is not null);
create policy lexim_stafi  on produktet        for select to authenticated using (roli_im() is not null);
create policy lexim_stafi  on tavolinat        for select to authenticated using (roli_im() is not null);
create policy lexim_stafi  on porosite         for select to authenticated using (roli_im() is not null);
create policy lexim_stafi  on porosi_artikujt  for select to authenticated using (roli_im() is not null);
create policy lexim_stafi  on porosi_historiku for select to authenticated using (roli_im() is not null);

-- Lejet: anon (pa hyrje) sheh vetëm emrin e lokalit
revoke all on cilesimet, stafi, kategorite, produktet, tavolinat, porosite, porosi_artikujt,
              porosi_historiku, v_porosite_aktive, v_porosite_sot, v_raporti_sot,
              v_produktet_top, v_shitjet_ore, v_shitjet_ditore from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on cilesimet to anon, authenticated;
grant select on stafi, kategorite, produktet, tavolinat, porosite, porosi_artikujt, porosi_historiku,
                v_porosite_aktive, v_porosite_sot, v_raporti_sot, v_produktet_top,
                v_shitjet_ore, v_shitjet_ditore
  to authenticated;

revoke all on function roli_im(), kerko_rolin(text[]), fn_stafi_i_ri(),
  krijo_porosi(int, jsonb, text), ndrysho_statusin(bigint, text),
  ruaj_kategori(int, text, int), fshi_kategori(int),
  ruaj_produkt(int, int, text, numeric, int, boolean), fshi_produkt(int),
  ruaj_tavoline(int, int, int), fshi_tavoline(int),
  ruaj_cilesimet(text, text), ndrysho_stafin(uuid, text, boolean)
  from public, anon;
grant execute on function roli_im(),
  krijo_porosi(int, jsonb, text), ndrysho_statusin(bigint, text),
  ruaj_kategori(int, text, int), fshi_kategori(int),
  ruaj_produkt(int, int, text, numeric, int, boolean), fshi_produkt(int),
  ruaj_tavoline(int, int, int), fshi_tavoline(int),
  ruaj_cilesimet(text, text), ndrysho_stafin(uuid, text, boolean)
  to authenticated;

-- ---------- 10. Realtime ----------------------------------------------
alter publication supabase_realtime
  add table cilesimet, stafi, kategorite, produktet, tavolinat, porosite, porosi_artikujt;

-- =====================================================================
--  11. PYETJE PËR PREZANTIM (në SQL Editor, pasi të keni të dhëna)
-- =====================================================================
-- a) Stafi dhe rolet:
--    select emri, email, roli, aktiv from stafi order by krijuar_me;
--
-- b) Historiku i auditimit, me emrin e kujt e ndryshoi:
--    select h.porosia_id, h.statusi_vjeter, h.statusi_ri, s.emri, h.ndryshuar_me
--      from porosi_historiku h left join stafi s on s.user_id = h.ndryshuar_nga
--     order by h.ndryshuar_me desc limit 20;
--
-- c) Window functions:
--    select * from v_produktet_top order by renditja;
--    select * from v_shitjet_ditore order by dita;
--
-- d) Plani i ekzekutimit me indeksin e pjesshëm:
--    explain analyze select * from porosite
--     where statusi not in ('e_paguar','e_anuluar') order by krijuar_me;
