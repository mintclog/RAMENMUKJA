begin;

-- Additive migration: preserve existing menus, reviews and the original migration.
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (nickname ~ '^[[:alnum:]가-힣_ -]{2,20}$'),
  status text not null default 'active' check (status in ('active','withdrawing'))
);
create function public.create_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(user_id,nickname) values(new.id, case when coalesce(new.raw_user_meta_data->>'nickname','') ~ '^[[:alnum:]가-힣_ -]{2,20}$' then new.raw_user_meta_data->>'nickname' else '라멘산책_' || left(new.id::text,8) end);
  if new.raw_user_meta_data->>'age_confirmed'='true' and new.raw_user_meta_data->>'terms_version'='2026-10-17' then
    insert into public.user_consents(user_id,version,age_confirmed) values(new.id,'2026-10-17',true);
  end if;
  return new;
end $$;
create trigger auth_profile after insert on auth.users for each row execute function public.create_profile();
insert into public.profiles(user_id,nickname) select id,'라멘산책_' || left(id::text,8) from auth.users;
create function public.active_member() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u join public.profiles p on p.user_id=u.id
    where u.id=auth.uid() and u.email_confirmed_at is not null and p.status='active' and exists(select 1 from public.user_consents c where c.user_id=u.id and c.age_confirmed))
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((auth.jwt()->'app_metadata'->>'role')='admin',false) and exists(select 1 from auth.users u join public.profiles p on p.user_id=u.id where u.id=auth.uid() and u.email_confirmed_at is not null and p.status='active')
$$;
alter table public.profiles enable row level security;
create policy profiles_read on public.profiles for select to authenticated using(user_id=auth.uid() or public.is_admin());
grant select on public.profiles to authenticated;

alter table public.menus add column created_by uuid references auth.users(id) on delete set null;
alter table public.reviews alter column disclosure drop not null;
alter table public.reviews alter column user_id drop not null;
alter table public.reviews drop constraint reviews_user_id_fkey;
alter table public.reviews add constraint reviews_user_id_fkey foreign key(user_id) references auth.users(id) on delete set null;
alter table public.reviews add column options text not null default '' check(length(options)<=300);
alter table public.reviews add column privacy_pending boolean not null default false;
grant insert(options), update(options) on public.reviews to authenticated;

create or replace function public.validate_review_record() returns trigger language plpgsql set search_path = '' as $$
declare item text; value jsonb;
begin
  if jsonb_typeof(new.details)<>'object' then raise exception 'Invalid details'; end if;
  for item,value in select * from jsonb_each(new.details) loop
    if item not in ('broth','noodle','topping') or value::text not in ('1','2','3','4','5') then raise exception 'Invalid detail'; end if;
  end loop;
  for item in select jsonb_array_elements_text(new.photos) loop
    if new.user_id is not null and item !~ ('^' || new.user_id::text || '/[0-9a-f-]{36}\.jpg$') then raise exception 'Invalid photo owner'; end if;
  end loop;
  if new.user_id is not null then
    select nickname into new.author from public.profiles where user_id=new.user_id;
  end if;
  if tg_op='UPDATE' then
    new.created_at:=old.created_at;
    new.updated_at:=case when (new.rating,new.body,new.details,new.photos,new.options) is distinct from (old.rating,old.body,old.details,old.photos,old.options) then now() else old.updated_at end;
  end if;
  return new;
end $$;

create function public.change_nickname(value text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  update public.profiles set nickname=btrim(value) where user_id=auth.uid();
  update public.reviews set author=btrim(value) where user_id=auth.uid();
end $$;

-- Restrictive policies also guard direct PostgREST access, not just this app's API.
create policy member_review_insert on public.reviews as restrictive for insert to authenticated with check(public.active_member());
create policy member_review_update on public.reviews as restrictive for update to authenticated using(public.active_member()) with check(public.active_member());
create policy member_review_delete on public.reviews as restrictive for delete to authenticated using(public.active_member());
create policy member_saved on public.saved_menus as restrictive for all to authenticated using(public.active_member()) with check(public.active_member());
create policy member_report on public.reports as restrictive for all to authenticated using(public.active_member()) with check(public.active_member());
create policy member_request on public.registration_requests as restrictive for all to authenticated using(public.active_member()) with check(public.active_member());
create policy member_photo_insert on storage.objects as restrictive for insert to authenticated with check(bucket_id<>'review-photos' or public.active_member());
create policy member_photo_delete on storage.objects as restrictive for delete to authenticated using(bucket_id<>'review-photos' or public.active_member());

create table public.review_likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  review_id uuid not null references public.reviews(id) on delete cascade,
  primary key(user_id,review_id)
);
alter table public.review_likes enable row level security;
create policy likes_read on public.review_likes for select using(exists(select 1 from public.reviews r where r.id=review_id and not r.hidden and not r.privacy_pending));
create policy likes_insert on public.review_likes for insert to authenticated with check(user_id=auth.uid() and public.active_member() and exists(select 1 from public.reviews r where r.id=review_id and r.user_id is distinct from auth.uid() and not r.hidden and not r.privacy_pending));
create policy likes_delete on public.review_likes for delete to authenticated using(user_id=auth.uid() and public.active_member());
grant select on public.review_likes to anon,authenticated;
grant insert,delete on public.review_likes to authenticated;

create function public.review_metadata(menu_ids text[]) returns table(id uuid,likes bigint,liked boolean) language sql stable security definer set search_path = '' as $$
  select r.id,count(l.user_id),coalesce(bool_or(l.user_id=auth.uid()),false)
  from public.reviews r left join public.review_likes l on l.review_id=r.id
  where r.menu_id=any(menu_ids) and not r.hidden and not r.privacy_pending group by r.id
$$;
create function public.menu_photos(menu_ids text[]) returns table(menu_id text,photo text) language sql stable security definer set search_path = '' as $$
  select distinct on(r.menu_id) r.menu_id,r.photos->>0
  from public.reviews r left join public.review_likes l on l.review_id=r.id
  where r.menu_id=any(menu_ids) and not r.hidden and not r.privacy_pending and jsonb_array_length(r.photos)>0
  group by r.id order by r.menu_id,count(l.user_id) desc,r.created_at,r.id
$$;

create function public.valid_photos(photos jsonb) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(case when jsonb_typeof(photos)<>'array' then false else jsonb_array_length(photos)<=5 and not exists(
    select 1 from jsonb_array_elements_text(photos) p where p !~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}\.jpg$')
      or not exists(select 1 from storage.objects o where o.bucket_id='review-photos' and o.name=p)
  ) end,false)
$$;
create function public.add_menu(shop text,menu_name text,price_value integer,genre text,photos jsonb) returns public.menus
language plpgsql security definer set search_path = '' as $$
declare result public.menus;
begin
  if not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if not public.valid_photos(photos) or jsonb_array_length(photos)<1 or genre is null or genre not in ('돈코츠','시오','쇼유','미소','탄탄면','아부라소바','츠케멘','기타') then raise exception 'Menu fields required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(shop || lower(regexp_replace(btrim(menu_name),'\s','','g')),0));
  if exists(select 1 from public.menus m where m.shop_id=shop and lower(regexp_replace(m.name,'\s','','g'))=lower(regexp_replace(btrim(menu_name),'\s','','g'))) then raise exception 'Duplicate menu' using errcode='23505'; end if;
  insert into public.menus(shop_id,name,price,tags,created_by) values(shop,btrim(menu_name),price_value,array[genre],auth.uid()) returning * into result;
  return result;
end $$;

create function public.submit_review(menu text,score integer,content text,detail jsonb,photos jsonb,order_options text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; nick text;
begin
  if not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if not public.valid_photos(photos) then raise exception 'Invalid photos'; end if;
  select nickname into nick from public.profiles where user_id=auth.uid();
  insert into public.reviews(user_id,menu_id,author,rating,body,details,photos,options)
    values(auth.uid(),menu,nick,score,btrim(content),detail,photos,order_options)
    on conflict(user_id,menu_id) do update set rating=excluded.rating,body=excluded.body,details=excluded.details,photos=excluded.photos,options=excluded.options
    returning id into result;
  return result;
end $$;

alter table public.registration_requests add column area text not null default '' check(length(area)<=100);
alter table public.registration_requests add column address text not null default '' check(length(address)<=300);
alter table public.registration_requests add column lat double precision check(lat between -90 and 90);
alter table public.registration_requests add column lng double precision check(lng between -180 and 180);
alter table public.registration_requests add column shop_id text references public.shops(id);
alter table public.registration_requests add column reason text not null default '' check(length(reason)<=1000);
alter table public.registration_requests drop constraint registration_requests_status_check;
alter table public.registration_requests add constraint registration_requests_status_check check(status in ('pending','approved','rejected','resolved'));
grant insert(area,address,lat,lng) on public.registration_requests to authenticated;

create table public.review_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null references public.registration_requests(id) on delete cascade,
  data jsonb not null check(jsonb_typeof(data)='object' and length(data::text)<=15000),
  updated_at timestamptz not null default now(),
  unique(user_id,request_id)
);
alter table public.review_drafts enable row level security;
create policy drafts_own on public.review_drafts for all to authenticated using(user_id=auth.uid() and public.active_member())
  with check(user_id=auth.uid() and public.active_member() and exists(select 1 from public.registration_requests q where q.id=request_id and q.user_id=auth.uid()) and public.valid_photos(coalesce(data->'photos','[]'::jsonb)));
grant select,insert,update,delete on public.review_drafts to authenticated;

create function public.publish_draft(draft_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.review_drafts; q public.registration_requests; m public.menus; r uuid;
begin
  if not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into d from public.review_drafts where id=draft_id and user_id=auth.uid() for update;
  select * into q from public.registration_requests where id=d.request_id and user_id=auth.uid();
  if d.id is null or q.status is distinct from 'approved' or q.shop_id is null then raise exception 'Approved shop required'; end if;
  if length(coalesce(d.data->>'menuId',''))>0 then
    select * into m from public.menus where id=d.data->>'menuId' and shop_id=q.shop_id;
    if m.id is null then raise exception 'Invalid menu'; end if;
  else
    m:=public.add_menu(q.shop_id,d.data->>'name',(d.data->>'price')::integer,d.data->>'genre',d.data->'photos');
  end if;
  if exists(select 1 from public.reviews where user_id=auth.uid() and menu_id=m.id) then
    return jsonb_build_object('menuId',m.id,'existing',true);
  end if;
  r:=public.submit_review(m.id,(d.data->>'rating')::integer,d.data->>'body',coalesce(d.data->'details','{}'),d.data->'photos',coalesce(d.data->>'options',''));
  delete from public.review_drafts where id=draft_id;
  return jsonb_build_object('menuId',m.id,'reviewId',r,'existing',false);
end $$;

create function public.decide_registration(request uuid,decision text,reason_value text,existing_shop text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare q public.registration_requests; target text;
begin
  if not public.is_admin() or not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into q from public.registration_requests where id=request for update;
  if q.id is null or q.status<>'pending' then raise exception 'Request already processed'; end if;
  if decision='rejected' and length(btrim(reason_value))>0 then
    update public.registration_requests set status='rejected',reason=reason_value where id=request; return null;
  end if;
  if decision<>'approved' then raise exception 'Invalid decision'; end if;
  if existing_shop is not null then
    select id into target from public.shops where id=existing_shop;
    if target is null then raise exception 'Unknown shop'; end if;
  else
    if length(btrim(q.area))=0 or length(btrim(q.address))=0 or q.lat is null or q.lng is null then raise exception 'Location required'; end if;
    insert into public.shops(name,area,address,lat,lng) values(q.name,q.area,q.address,q.lat,q.lng) returning id into target;
  end if;
  update public.registration_requests set status='approved',shop_id=target,reason=reason_value where id=request;
  return target;
end $$;

-- Withdrawal is resumable; retained material stays hidden until human privacy review.
create table public.withdrawal_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  preserve boolean not null,
  photos jsonb not null,
  status text not null default 'processing' check(status in ('processing','detached'))
);
alter table public.withdrawal_jobs enable row level security;
create function public.begin_withdrawal(preserve_content boolean) returns public.withdrawal_jobs
language plpgsql security definer set search_path = '' as $$
declare job public.withdrawal_jobs; photo_list jsonb;
begin
  if auth.uid() is null then raise exception 'Forbidden' using errcode='42501'; end if;
  perform 1 from public.profiles where user_id=auth.uid() for update;
  select * into job from public.withdrawal_jobs where user_id=auth.uid();
  if job.id is not null then return job; end if;
  if not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select coalesce(jsonb_agg(distinct p),'[]'::jsonb) into photo_list from public.reviews r cross join lateral jsonb_array_elements_text(r.photos) p where r.user_id=auth.uid();
  insert into public.withdrawal_jobs(user_id,preserve,photos) values(auth.uid(),preserve_content,photo_list) returning * into job;
  update public.reviews set hidden=true,privacy_pending=true where user_id=auth.uid();
  update public.profiles set status='withdrawing' where user_id=auth.uid();
  delete from public.saved_menus where user_id=auth.uid();
  delete from public.review_drafts where user_id=auth.uid();
  return job;
end $$;
create function public.detach_withdrawal(job_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare job public.withdrawal_jobs;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into job from public.withdrawal_jobs where id=job_id for update;
  if job.id is null then raise exception 'Unknown job'; end if;
  if job.preserve then
    update public.reviews r set user_id=null,author='탈퇴한 회원',photos=(select coalesce(jsonb_agg(job.id::text || '/' || split_part(p,'/',2)),'[]'::jsonb) from jsonb_array_elements_text(r.photos) p),hidden=true,privacy_pending=true where user_id=job.user_id;
  else delete from public.reviews where user_id=job.user_id;
  end if;
  delete from public.registration_requests where user_id=job.user_id;
  delete from public.review_likes where user_id=job.user_id;
  delete from public.user_consents where user_id=job.user_id;
  update public.profiles set nickname='탈퇴한 회원' where user_id=job.user_id;
  update public.withdrawal_jobs set status='detached' where id=job_id;
end $$;
create function public.approve_retained_review(review_id uuid,reason text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() or not public.active_member() or length(btrim(reason))=0 then raise exception 'Forbidden' using errcode='42501'; end if;
  update public.reviews set privacy_pending=false,hidden=false,moderation_reason=reason where id=review_id and privacy_pending and user_id is null;
end $$;
create or replace function public.moderate_review(review_id uuid,hide boolean,reason text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() or not public.active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if length(btrim(reason)) not between 1 and 1000 then raise exception 'Reason required'; end if;
  update public.reviews set hidden=hide,moderation_reason=reason where id=review_id and not privacy_pending;
end $$;

-- Private retained photos can be inspected only by the operator until approved.
drop policy photo_read on storage.objects;
create policy photo_read on storage.objects for select using(bucket_id='review-photos' and (
  ((storage.foldername(name))[1]=auth.uid()::text and public.active_member()) or public.is_admin()
  or exists(select 1 from public.reviews r where not r.hidden and not r.privacy_pending and r.photos ? name)
  or exists(select 1 from public.review_drafts d where d.user_id=auth.uid() and d.data->'photos' ? name)
));

-- SECURITY DEFINER functions are not callable by PUBLIC by default.
revoke all on function public.create_profile(),public.active_member(),public.change_nickname(text),public.review_metadata(text[]),public.menu_photos(text[]),public.valid_photos(jsonb),public.add_menu(text,text,integer,text,jsonb),public.submit_review(text,integer,text,jsonb,jsonb,text),public.decide_registration(uuid,text,text,text),public.begin_withdrawal(boolean),public.detach_withdrawal(uuid),public.approve_retained_review(uuid,text) from public,anon,authenticated;
grant execute on function public.active_member() to anon,authenticated;
grant execute on function public.review_metadata(text[]),public.menu_photos(text[]) to anon,authenticated;
grant execute on function public.change_nickname(text),public.valid_photos(jsonb),public.add_menu(text,text,integer,text,jsonb),public.submit_review(text,integer,text,jsonb,jsonb,text),public.decide_registration(uuid,text,text,text),public.begin_withdrawal(boolean),public.approve_retained_review(uuid,text) to authenticated;
grant execute on function public.detach_withdrawal(uuid) to service_role;
revoke all on function public.publish_draft(uuid) from public,anon;
grant execute on function public.publish_draft(uuid) to authenticated;
grant all on public.withdrawal_jobs to service_role;
notify pgrst,'reload schema';
commit;
