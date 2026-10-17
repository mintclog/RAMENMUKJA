begin;

create table public.shops (
  id text primary key default gen_random_uuid()::text,
  name text not null check (length(name) between 1 and 100),
  area text not null check (length(area) between 1 and 100),
  address text not null check (length(address) between 1 and 300),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  description text not null default '' check (length(description) <= 2000),
  hours text not null default '',
  source_url text not null default ''
);
create unique index shops_name_address_idx on public.shops(name, address);
create table public.menus (
  id text primary key default gen_random_uuid()::text,
  shop_id text not null references public.shops(id),
  name text not null check (length(name) between 1 and 100),
  price integer not null check (price between 0 and 10000000),
  tags text[] not null default '{}',
  image text,
  status text not null default 'active' check (status in ('active', 'ended')),
  description text not null default '' check (length(description) <= 2000),
  taste text[] not null default '{}'
);
create unique index menus_active_name_idx on public.menus(shop_id, name) where status = 'active';
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  menu_id text not null references public.menus(id),
  author text not null default '라멘 기록' check (length(author) between 1 and 40),
  rating integer not null check (rating between 1 and 5),
  body text not null default '' check (length(body) <= 2000),
  disclosure text not null check (disclosure in ('self', 'sponsored')),
  details jsonb not null default '{}',
  taste jsonb not null default '{}',
  photos jsonb not null default '[]' check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 5),
  hidden boolean not null default false,
  moderation_reason text not null default '' check (length(moderation_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, menu_id),
  check (rating <> 5 or length(btrim(body)) > 0)
);
create index reviews_menu_id_idx on public.reviews(menu_id);
create index reviews_updated_at_idx on public.reviews(updated_at desc);
create table public.saved_menus (
  user_id uuid not null references auth.users(id) on delete cascade,
  menu_id text not null references public.menus(id),
  primary key (user_id, menu_id)
);
create table public.user_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  version text not null,
  age_confirmed boolean not null check (age_confirmed),
  created_at timestamptz not null default now(),
  primary key (user_id, version)
);
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  review_id uuid not null references public.reviews(id) on delete cascade,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending','resolved')),
  created_at timestamptz not null default now(),
  unique (user_id, review_id)
);
create table public.registration_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  note text not null check (length(btrim(note)) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending','resolved')),
  created_at timestamptz not null default now()
);
create index requests_user_created_idx on public.registration_requests(user_id, created_at desc);

create function public.is_admin() returns boolean language sql stable
set search_path = '' as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
$$;

create function public.validate_review_record() returns trigger language plpgsql
set search_path = '' as $$
declare item text; value jsonb;
begin
  if jsonb_typeof(new.details) <> 'object' or jsonb_typeof(new.taste) <> 'object' then
    raise exception 'Invalid review details';
  end if;
  for item, value in select * from jsonb_each(new.details) loop
    if item not in ('broth','noodle','topping') or value::text not in ('1','2','3','4','5') then
      raise exception 'Invalid detail rating';
    end if;
  end loop;
  if length(new.taste::text) > 500 then raise exception 'Taste too long'; end if;
  for item in select jsonb_array_elements_text(new.photos) loop
    if item !~ ('^' || new.user_id::text || '/[0-9a-f-]{36}\.jpg$') then
      raise exception 'Invalid photo owner';
    end if;
  end loop;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger review_validation before insert or update on public.reviews
for each row execute function public.validate_review_record();

alter table public.shops enable row level security;
alter table public.menus enable row level security;
alter table public.reviews enable row level security;
alter table public.saved_menus enable row level security;
alter table public.user_consents enable row level security;
alter table public.reports enable row level security;
alter table public.registration_requests enable row level security;

create policy shops_read on public.shops for select using (true);
create policy shops_admin on public.shops for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy menus_read on public.menus for select using (true);
create policy menus_admin on public.menus for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy reviews_read on public.reviews for select using (not hidden or user_id = auth.uid() or public.is_admin());
create policy reviews_insert on public.reviews for insert to authenticated with check (user_id = auth.uid() and not hidden);
create policy reviews_update on public.reviews for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy reviews_delete on public.reviews for delete to authenticated using (user_id = auth.uid());
create policy saved_own on public.saved_menus for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy consents_read on public.user_consents for select to authenticated using (user_id = auth.uid());
create policy consents_insert on public.user_consents for insert to authenticated with check (user_id = auth.uid());
create policy reports_read on public.reports for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy reports_insert on public.reports for insert to authenticated with check (user_id = auth.uid() and status = 'pending');
create policy reports_admin on public.reports for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy requests_read on public.registration_requests for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy requests_insert on public.registration_requests for insert to authenticated with check (user_id = auth.uid() and status = 'pending');
create policy requests_admin on public.registration_requests for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.shops, public.menus, public.reviews, public.saved_menus, public.reports, public.registration_requests from anon, authenticated;
grant select on public.shops, public.menus, public.reviews to anon, authenticated;
grant insert, update on public.shops, public.menus to authenticated;
grant insert (user_id, menu_id, author, rating, body, disclosure, details, taste, photos) on public.reviews to authenticated;
grant update (author, rating, body, disclosure, details, taste, photos) on public.reviews to authenticated;
grant delete on public.reviews to authenticated;
grant select, insert, delete on public.saved_menus to authenticated;
revoke all on public.user_consents from anon, authenticated;
grant select on public.user_consents to authenticated;
grant insert (user_id, version, age_confirmed) on public.user_consents to authenticated;
grant select on public.reports, public.registration_requests to authenticated;
grant insert (user_id, review_id, reason) on public.reports to authenticated;
grant insert (user_id, name, note) on public.registration_requests to authenticated;
grant update (status) on public.reports, public.registration_requests to authenticated;

create function public.moderate_review(review_id uuid, hide boolean, reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Forbidden' using errcode = '42501'; end if;
  if length(btrim(reason)) not between 1 and 1000 then raise exception 'Reason required'; end if;
  update public.reviews set hidden = hide, moderation_reason = reason where id = review_id;
end $$;
revoke all on function public.moderate_review(uuid, boolean, text) from public, anon;
grant execute on function public.moderate_review(uuid, boolean, text) to authenticated;

-- Aggregate only public reviews; ownership-visible hidden reviews must not enter scores.
create view public.menu_stats with (security_invoker = true) as
select menu_id, count(*)::integer as count, avg(rating) as average,
  jsonb_build_object('broth',avg((details->>'broth')::numeric),'noodle',avg((details->>'noodle')::numeric),'topping',avg((details->>'topping')::numeric)) as details,
  jsonb_build_object('broth',count(details->>'broth'),'noodle',count(details->>'noodle'),'topping',count(details->>'topping')) as detail_counts,
  array[count(*) filter (where rating=1),count(*) filter (where rating=2),count(*) filter (where rating=3),count(*) filter (where rating=4),count(*) filter (where rating=5)] as distribution
from public.reviews where not hidden group by menu_id;
grant select on public.menu_stats to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-photos', 'review-photos', false, 1500000, array['image/jpeg']);
create policy photo_read on storage.objects for select using (
  bucket_id = 'review-photos' and (
    (storage.foldername(name))[1] = auth.uid()::text or public.is_admin() or exists (
      select 1 from public.reviews r where not r.hidden and r.photos ? name
    )
  )
);
create policy photo_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'review-photos' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy photo_delete on storage.objects for delete to authenticated using (
  bucket_id = 'review-photos' and (storage.foldername(name))[1] = auth.uid()::text
);

commit;
