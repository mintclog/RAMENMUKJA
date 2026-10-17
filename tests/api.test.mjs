import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { stripJpegMetadata } from '../server/photos.mjs';

const uid='11111111-1111-4111-8111-111111111111',rid='22222222-2222-4222-8222-222222222222';
const config={APP_ORIGIN:'https://example.test',SUPABASE_URL:'https://database.test',SUPABASE_ANON_KEY:'test-public-key',VERCEL:'1',ALLOW_PUBLIC_SIGNIN:'true',PUBLIC_OPERATOR_NAME:'Test Operator',PUBLIC_CONTACT_EMAIL:'contact@example.test',PUBLIC_OPERATOR_ADDRESS:'Test Address',PUBLIC_DATA_REGION:'Test region',PUBLIC_RETENTION_POLICY:'Test retention'};
const verified={id:uid,email:'member@example.test',email_confirmed_at:'2026-10-17',app_metadata:{}};
const json=body=>Response.json(body);
const post=(body,method='POST',loggedIn=false)=>({method,headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/json',...(loggedIn?{Cookie:'rm-access=test-token'}:{})},body:JSON.stringify(body)});
async function start(t,handler=()=>undefined,env=config){
 const server=http.createServer(createApi({env,fetcher:async(url,options={})=>{
  const result=await handler(url,options);if(result)return result;
  if(url.endsWith('/auth/v1/user'))return json(verified);
  if(url.includes('/rest/v1/profiles?'))return json([{user_id:uid,nickname:'면산책',status:'active'}]);
  throw Error('Unexpected upstream request: '+url);
 }}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 return(path,options)=>fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,options);
}

test('unconfigured production never serves fictional demo data',async t=>{
 const call=await start(t,undefined,{VERCEL:'1'});
 assert.equal((await(await call('status')).json()).mode,'unconfigured');assert.equal((await call('bootstrap')).status,503);
});
test('unconfigured local development keeps explicit demo mode',async t=>{
 const call=await start(t,undefined,{});assert.equal((await(await call('status')).json()).mode,'demo');
});
test('writes require matching origin, JSON and a verified session',async t=>{
 const call=await start(t);
 assert.equal((await call('saved',{...post({}),headers:{Origin:'https://attacker.test','Content-Type':'application/json'}})).status,403);
 assert.equal((await call('saved',{method:'POST',headers:{Origin:config.APP_ORIGIN},body:'x'})).status,415);
 assert.equal((await call('saved',post({menuId:'m1',saved:true})) ).status,401);
});
test('email password login sets secure cookies and clamps return URL without exposing tokens',async t=>{
 let credential;
 const call=await start(t,(url,opts)=>{if(url.includes('grant_type=password')){credential=JSON.parse(opts.body);return json({access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600});}});
 const response=await call('auth/login',post({email:'member@example.test',password:'long-password-123',next:'//attacker.test'}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{next:'/me'});assert.equal(credential.email,'member@example.test');
 assert.ok(response.headers.getSetCookie().every(c=>c.includes('HttpOnly')&&c.includes('Secure')&&c.includes('SameSite=Lax')));
});
test('signup sends nickname and consent metadata, and never returns an auth session',async t=>{
 let input;
 const call=await start(t,(url,opts)=>{if(url.endsWith('/auth/v1/signup')){input=JSON.parse(opts.body);return json({id:uid});}});
 const response=await call('auth/signup',post({email:'new@example.test',password:'long-password-123',nickname:'새로운면',agreed:true,ageConfirmed:true}));
 assert.equal(response.status,200);assert.equal(input.data.nickname,'새로운면');assert.equal(input.data.terms_version,'2026-10-17');assert.equal(input.data.age_confirmed,true);assert.equal(response.headers.getSetCookie().length,0);
});
test('public login and signup remain closed until operator policies are configured',async t=>{
 const call=await start(t,undefined,{...config,PUBLIC_CONTACT_EMAIL:''});
 for(const route of ['auth/login','auth/signup'])assert.equal((await call(route,post({}))).status,503);
});
test('signup rejects missing agreement and invalid nicknames/passwords before upstream writes',async t=>{
 const call=await start(t);const base={email:'new@example.test',password:'long-password-123',nickname:'면산책',agreed:true,ageConfirmed:true};
 for(const fields of [{agreed:false},{ageConfirmed:false},{nickname:'<script>'},{password:'short'},{email:'invalid'}])assert.equal((await call('auth/signup',post({...base,...fields}))).status,400);
});
test('verification is explicit POST; recovery proof is bound to the issued access token',async t=>{
 const access='recovery-access';
 const call=await start(t,(url,opts)=>{
  if(url.endsWith('/auth/v1/verify')){assert.equal(JSON.parse(opts.body).type,'recovery');return json({access_token:access,refresh_token:'refresh',expires_in:3600});}
  if(url.endsWith('/auth/v1/user')&&opts.method==='PUT')return json({id:uid});
 });
 assert.equal((await call('auth/verify?token_hash=not-consumed')).status,404);
 const response=await call('auth/verify',post({tokenHash:'x'.repeat(40),type:'recovery'}));
 assert.equal(response.status,200);assert.equal((await response.json()).next,'/login?mode=reset');
 const proof=createHash('sha256').update(access).digest('hex');
 assert.ok(response.headers.getSetCookie().some(c=>c.startsWith('rm-recovery='+proof)));
 const options=post({password:'updated-password-123'});options.headers.Cookie='rm-access='+access+'; rm-recovery='+proof;
 assert.equal((await call('auth/password',options)).status,200);
 options.headers.Cookie='rm-access=another-token; rm-recovery='+proof;assert.equal((await call('auth/password',options)).status,403);
});
test('unverified and closing accounts cannot write reviews',async t=>{
 const unverified=await start(t,url=>url.endsWith('/auth/v1/user')?json({...verified,email_confirmed_at:null}):undefined);
 assert.equal((await unverified('reviews',post({menuId:'m1',body:'',rating:3,photos:[]},'PUT',true))).status,403);
 const closing=await start(t,url=>url.includes('/rest/v1/profiles?')?json([{status:'withdrawing'}]):undefined);
 assert.equal((await closing('saved',post({menuId:'m1',saved:true},'POST',true))).status,403);
});
test('regular users cannot access admin or unknown menu mutation endpoints',async t=>{
 const call=await start(t);assert.equal((await call('admin',{headers:{Cookie:'rm-access=x'}})).status,403);
 assert.equal((await call('menus/m1',post({name:'forged'},'PATCH',true))).status,404);
});
test('review ownership is derived in DB RPC and removed inputs are never forwarded',async t=>{
 let inserted;
 const call=await start(t,(url,opts)=>{
  if(url.includes('reviews?'))return json([]);
  if(url.endsWith('/rpc/submit_review')){inserted=JSON.parse(opts.body);return json(rid);}
 });
 const response=await call('reviews',post({menuId:'m1',body:'',rating:3,photos:[],details:{broth:3},options:'곱빼기',userId:'attacker',author:'forged',taste:{saltiness:'x'},disclosure:'sponsored'},'PUT',true));
 assert.equal(response.status,200);assert.deepEqual(inserted,{menu:'m1',score:3,content:'',detail:{broth:3},photos:[],order_options:'곱빼기'});
});
test('five-star reason, unknown detail keys and foreign photo paths are rejected before writes',async t=>{
 const call=await start(t);const base={menuId:'m1',body:'',rating:3,photos:[]};
 for(const fields of [{rating:5},{details:{unknown:3}},{photos:['/api/photos/'+rid+'/'+rid+'.jpg']}])assert.equal((await call('reviews',post({...base,...fields},'PUT',true))).status,400);
});
test('menu creation requires four fields and validates upload ownership',async t=>{
 let input;const call=await start(t,(url,opts)=>{if(url.endsWith('/rpc/add_menu')){input=JSON.parse(opts.body);return json({id:'new',shop_id:'shop'});}});
 const base={shopId:'shop',name:'쇼유 라멘',price:10000,genre:'쇼유',photos:['/api/photos/'+uid+'/'+rid+'.jpg']};
 for(const fields of [{photos:[]},{price:null},{genre:''},{photos:['/api/photos/'+rid+'/'+rid+'.jpg']}])assert.equal((await call('menus',post({...base,...fields},'POST',true))).status,400);
 assert.equal((await call('menus',post(base,'POST',true))).status,200);assert.deepEqual(input.photos,[uid+'/'+rid+'.jpg']);
});
test('drafts reject another account photos and accept only private owner-scoped rows',async t=>{
 let draft;
 const call=await start(t,(url,opts)=>{if(url.includes('/review_drafts?')){draft=JSON.parse(opts.body);return json([draft]);}});
 assert.equal((await call('drafts',post({requestId:rid,data:{photos:[rid+'/'+rid+'.jpg']}},'PUT',true))).status,400);
 assert.equal((await call('drafts',post({requestId:rid,user_id:'attacker',data:{body:'비공개',photos:[]}},'PUT',true))).status,200);assert.equal(draft.user_id,uid);
});
test('structured shop requests reject invalid coordinates',async t=>{
 const call=await start(t);assert.equal((await call('requests',post({name:'가게',area:'서울',address:'주소',lat:91,lng:127},'POST',true))).status,400);
});
test('likes bind ownership to session and support cancellation',async t=>{
 const calls=[];const call=await start(t,(url,opts)=>{if(url.includes('review_likes')){calls.push({url,opts});return json([]);}});
 assert.equal((await call('likes',post({reviewId:rid,liked:true,user_id:'attacker'},'POST',true))).status,200);
 assert.equal(JSON.parse(calls[0].opts.body).user_id,uid);
 assert.equal((await call('likes',post({reviewId:rid,liked:false},'POST',true))).status,200);assert.equal(calls[1].opts.method,'DELETE');
});
test('deleting another user review is refused before storage or DB deletion',async t=>{
 const call=await start(t,(url,opts)=>{assert.notEqual(opts.method,'DELETE');if(url.includes('reviews?'))return json([]);});
 assert.equal((await call('reviews/'+rid,post({},'DELETE',true))).status,403);
});
test('expired sessions rotate cookies without exposing profile email or tokens',async t=>{
 // Use an actual 401 to exercise rotation, rather than a successful empty profile.
 const call2=await start(t,(url,opts)=>{
  if(url.endsWith('/auth/v1/user')&&opts.headers.Authorization==='Bearer expired')return Response.json({}, {status:401});
  if(url.includes('grant_type=refresh_token'))return json({access_token:'fresh',refresh_token:'rotated',expires_in:3600});
  if(url.includes('/rest/v1/')&&!url.includes('profiles?'))return json([]);
 });
 const response=await call2('bootstrap',{headers:{Cookie:'rm-access=expired; rm-refresh=refresh'}});assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.user.nickname,'면산책');assert.ok(!JSON.stringify(data).includes('member@example.test'));assert.ok(response.headers.getSetCookie().some(c=>c.startsWith('rm-refresh=rotated;')));
});
test('withdrawal is unavailable without a server-only key and performs no mutations',async t=>{
 const call=await start(t);assert.equal((await call('account/withdraw',post({preserve:true,password:'long-password-123'},'POST',true))).status,503);
});
test('withdrawal copies retained photos, detaches reviews, removes source objects, then deletes auth user',async t=>{
 const log=[];let listed=false;
 const call=await start(t,(url,opts)=>{
  if(url.includes('grant_type=password'))return json({access_token:'reauth'});
  if(url.endsWith('/rpc/begin_withdrawal'))return json({id:rid,preserve:true,status:'processing',photos:[uid+'/'+rid+'.jpg']});
  if(opts.headers.apikey==='server-only-test-key'){
   log.push(url);
   if(url.includes('/object/list/')){if(listed)return json([]);listed=true;return json([{name:rid+'.jpg'}]);}
   return json({});
  }
 },{...config,SUPABASE_SERVICE_ROLE_KEY:'server-only-test-key'});
 const response=await call('account/withdraw',post({preserve:true,password:'long-password-123'},'POST',true));assert.equal(response.status,200);
 assert.ok(log.findIndex(x=>x.endsWith('/object/copy'))<log.findIndex(x=>x.endsWith('/rpc/detach_withdrawal')));
 assert.ok(log.findIndex(x=>x.endsWith('/rpc/detach_withdrawal'))<log.findIndex(x=>x.endsWith('/auth/v1/admin/users/'+uid)));
 assert.ok(response.headers.getSetCookie().some(c=>c.includes('Max-Age=0')));
});
test('JPEG metadata is stripped and malformed images fail',()=>{
 const jpeg=Buffer.from([255,216,255,225,0,6,1,2,3,4,255,218,0,2,1,2,3,255,217]);
 assert.deepEqual(stripJpegMetadata(jpeg),Buffer.from([255,216,255,218,0,2,1,2,3,255,217]));assert.throws(()=>stripJpegMetadata(jpeg.subarray(0,10)));
});

test('removing a review never deletes photos still referenced by another review or draft',async t=>{
 const path=uid+'/'+rid+'.jpg';let storageDeleted=false;
 const call=await start(t,(url,opts)=>{
  if(url.includes('/reviews?select=photos'))return json([{photos:[path]}]);
  if(url.includes('/reviews?')&&opts.method==='DELETE')return json([]);
  if(url.includes('/reviews?select=id&photos='))return json([{id:'another-reference'}]);
  if(url.includes('/review_drafts?select=id'))return json([]);
  if(url.includes('/storage/')&&opts.method==='DELETE'){storageDeleted=true;return json({});}
 });
 assert.equal((await call('reviews/'+rid,post({},'DELETE',true))).status,200);
 assert.equal(storageDeleted,false);
});
