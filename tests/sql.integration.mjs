import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
// Optional integration runner: supply a temporary PGlite installation, never a production DB.
if (!process.argv[2]) { console.error('Usage: node tests/sql.integration.mjs /absolute/path/to/pglite/dist/index.js'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
try {
 await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,primary key(bucket_id,name));
 alter table storage.objects enable row level security;
 create function storage.foldername(name text) returns text[] language sql as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 grant usage on schema public,auth,storage to anon,authenticated,service_role;
 grant execute on all functions in schema auth,storage to anon,authenticated,service_role;
 grant select,insert,delete on storage.objects to anon,authenticated,service_role;
 `);
 for(const name of ['202610160001_initial.sql','202610170002_product_flows.sql']) {
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  console.log('Migration applied:',name);
 }
 const uid='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',photo=uid+'/33333333-3333-4333-8333-333333333333.jpg';
 await db.query(`insert into auth.users(id,email_confirmed_at,raw_user_meta_data) values($1,now(),'{"nickname":"면산책","terms_version":"2026-10-17","age_confirmed":true}'),($2,now(),'{"terms_version":"2026-10-17","age_confirmed":true}')`,[uid,other]);
 await db.exec(`insert into public.shops(id,name,area,address,lat,lng) values('shop','가게','서울','주소',37.5,127);`);
 await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['review-photos',photo]);
 const identity=async(id,role='authenticated',admin=false)=>{
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false),set_config('request.jwt.claims',$3,false)",[id,role,JSON.stringify({app_metadata:admin?{role:'admin'}:{}})]);
  await db.exec('set role '+role);
 };
 await identity(uid);
 const created=await db.query('select * from public.add_menu($1,$2,$3,$4,$5::jsonb)',['shop','쇼유 라멘',10000,'쇼유',JSON.stringify([photo])]);
 const menu=created.rows[0].id;
 await assert.rejects(()=>db.query('select public.add_menu($1,$2,$3,$4,$5::jsonb)',['shop','사진 없는 메뉴',10000,'쇼유',null]),/fields required/);
 await assert.rejects(()=>db.query('select public.add_menu($1,$2,$3,$4,$5::jsonb)',['shop','장르 없는 메뉴',10000,null,JSON.stringify([photo])]),/fields required/);
 await assert.rejects(()=>db.query('select public.add_menu($1,$2,$3,$4,$5::jsonb)',['shop','쇼유라멘',10000,'쇼유',JSON.stringify([photo])]),/Duplicate/);
 assert.equal((await db.query("update public.menus set name='변경' where id=$1",[menu])).affectedRows,0);
 const review=async(score)=>db.query('select public.submit_review($1,$2,$3,$4::jsonb,$5::jsonb,$6) as id',[menu,score,score===5?'인생 라멘':'리뷰','{}',JSON.stringify([photo]),'곱빼기']);
 const first=(await review(3)).rows[0].id;assert.equal((await review(5)).rows[0].id,first);
 assert.equal((await db.query('select count(*)::int n from public.reviews')).rows[0].n,1);
 assert.equal((await db.query('select author from public.reviews')).rows[0].author,'면산책');
 await assert.rejects(()=>db.query('insert into public.review_likes(user_id,review_id) values($1,$2)',[uid,first]),/row-level/);
 await identity(other);await db.query('insert into public.review_likes(user_id,review_id) values($1,$2)',[other,first]);
 assert.equal((await db.query('select * from public.review_metadata($1::text[])',[[menu]])).rows[0].likes,1);
 await assert.rejects(()=>db.query('insert into public.review_likes(user_id,review_id) values($1,$2)',[other,first]),/duplicate/);
 assert.equal((await db.query('select * from public.menu_photos($1::text[])',[[menu]])).rows[0].photo,photo);
 await identity(uid);
 const q=(await db.query("insert into public.registration_requests(user_id,name,note,area,address,lat,lng) values($1,'새 가게','주소','서울','주소2',37,127) returning id",[uid])).rows[0].id;
 await db.query("insert into public.review_drafts(user_id,request_id,data) values($1,$2,$3)",[uid,q,JSON.stringify({photos:[photo],body:'비공개 초안'})]);
 await identity(other);assert.equal((await db.query('select * from public.review_drafts')).rows.length,0);
 await assert.rejects(()=>db.query('select public.decide_registration($1,$2,$3,$4)',[q,'approved','확인',null]),/Forbidden/);
 await identity(uid,'authenticated',true);await db.query('select public.decide_registration($1,$2,$3,$4)',[q,'approved','확인','shop']);
 assert.equal((await db.query('select * from public.review_drafts')).rows.length,1);
 assert.equal((await db.query('select count(*)::int n from public.reviews')).rows[0].n,1,'approval must not publish draft');
 await identity(uid);
 const draftId=(await db.query('select id from public.review_drafts where request_id=$1',[q])).rows[0].id;
 await db.query('update public.review_drafts set data=$1 where id=$2',[JSON.stringify({menuId:menu,photos:[photo],rating:3,body:'기존 리뷰를 덮어쓰지 않음'}),draftId]);
 assert.equal((await db.query('select public.publish_draft($1) result',[draftId])).rows[0].result.existing,true);
 assert.equal((await db.query('select rating from public.reviews where id=$1',[first])).rows[0].rating,5);
 const draftData={name:'검증 시오',price:11000,genre:'시오',photos:[photo],rating:5,body:''};
 await db.query('update public.review_drafts set data=$1 where id=$2',[JSON.stringify(draftData),draftId]);
 await assert.rejects(()=>db.query('select public.publish_draft($1)',[draftId]),/check constraint/);
 assert.equal((await db.query("select count(*)::int n from public.menus where name='검증 시오'")).rows[0].n,0,'failed publish must roll back menu creation');
 await db.query('update public.review_drafts set data=$1 where id=$2',[JSON.stringify({...draftData,body:'특별한 국물과 면'}),draftId]);
 assert.equal((await db.query('select public.publish_draft($1) result',[draftId])).rows[0].result.existing,false);
 assert.equal((await db.query('select * from public.review_drafts where id=$1',[draftId])).rows.length,0);
 const job=(await db.query('select * from public.begin_withdrawal(true)')).rows[0];
 assert.equal((await db.query('select public.active_member() ok')).rows[0].ok,false);
 await identity(other);assert.equal((await db.query('select * from public.menu_stats')).rows.length,0);
 await identity('','service_role');await db.query('select public.detach_withdrawal($1)',[job.id]);
 await db.exec('reset role');
 const retained=(await db.query('select * from public.reviews where id=$1',[first])).rows[0];
 assert.equal(retained.user_id,null);assert.equal(retained.author,'탈퇴한 회원');assert.equal(retained.hidden,true);assert.equal(retained.privacy_pending,true);assert.ok(retained.photos[0].startsWith(job.id+'/'));
 console.log('PASS: migrations, ownership, nickname, review upsert, likes, representatives, private drafts, approval and withdrawal isolation');
} catch(error) { console.error('SQL CHECK FAILED:', error.message, error.detail || '', error.hint || '', error.position || '', error.where || ''); process.exitCode=1; } finally { await db.close(); }
