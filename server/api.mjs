import { createHash, randomUUID } from 'node:crypto';
import { validateReview, validateMenu, validateNickname } from '../src/domain.js';
import { stripJpegMetadata } from './photos.mjs';

const photoPath = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;
const uuid = /^[0-9a-f-]{36}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const safeNext = value => typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\r\n]/.test(value) && !value.startsWith('/api/') ? value : '/me';

export function createApi({ env = process.env, fetcher = fetch } = {}) {
  const origin = env.APP_ORIGIN?.replace(/\/$/, '');
  const endpoint = env.SUPABASE_URL?.replace(/\/$/, '');
  const key = env.SUPABASE_ANON_KEY;
  const adminKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const configured = Boolean(origin && endpoint && key);
  const operator = { name: env.PUBLIC_OPERATOR_NAME || '', email: env.PUBLIC_CONTACT_EMAIL || '', address: env.PUBLIC_OPERATOR_ADDRESS || '', region: env.PUBLIC_DATA_REGION || '', retention: env.PUBLIC_RETENTION_POLICY || '' };
  const launchReady = Boolean(configured && env.ALLOW_PUBLIC_SIGNIN === 'true' && Object.values(operator).every(Boolean));
  const production = env.VERCEL === '1' || env.NODE_ENV === 'production';
  const secure = origin?.startsWith('https:') ? '; Secure' : '';
  const cookie = (name, value, age) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
  const clearSession = () => ['rm-access', 'rm-refresh'].map(name => cookie(name, '', 0));

  async function upstream(path, token, options = {}) {
    const response = await fetcher(endpoint + path, {
      ...options, signal: AbortSignal.timeout(15000),
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, ...options.headers },
    });
    if (!response.ok) {
      if (response.status === 401 || (response.status === 400 && path.startsWith('/auth/v1/token'))) throw fail(401, '로그인이 만료됐어요. 다시 로그인해주세요.');
      if (response.status === 403) throw fail(403, '이 작업의 권한이 없습니다.');
      if (response.status === 429) throw fail(429, '요청이 많습니다. 잠시 후 다시 시도해주세요.');
      if (response.status === 422 || (response.status === 400 && path.startsWith('/auth/'))) throw fail(400, '이메일·비밀번호 또는 인증 링크를 확인해주세요.');
      if (response.status === 409) throw fail(409, '이미 등록된 기록이거나 다른 변경과 충돌했어요.');
      throw fail(502, '데이터를 처리하지 못했어요. 잠시 후 다시 시도해주세요.');
    }
    return response;
  }
  async function query(path, token, options) {
    const response = await upstream('/rest/v1/' + path, token, options);
    return response.status === 204 ? null : response.json();
  }
  const writeOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const rpc = (name, token, body) => query('rpc/' + name, token, writeOptions('POST', body));
  const one = value => Array.isArray(value) ? value[0] : value;
  const mapReview = r => ({ id: r.id, userId: r.user_id, menuId: r.menu_id, author: r.author, rating: r.rating, body: r.body, options: r.options || '', details: r.details, photos: (r.photos || []).map(p => '/api/photos/' + p), hidden: r.hidden, privacyPending: r.privacy_pending, moderationReason: r.moderation_reason, createdAt: r.created_at, updatedAt: r.updated_at, edited: r.updated_at !== r.created_at, date: new Date(r.updated_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) });
  const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
  const authSession = session => [cookie('rm-access', session.access_token, session.expires_in), cookie('rm-refresh', session.refresh_token, 2592000)];
  async function adminCall(path, options = {}) {
    if (!adminKey) throw fail(503, '계정 삭제를 위한 서버 관리 설정이 필요합니다.');
    const response = await fetcher(endpoint + path, { ...options, signal: AbortSignal.timeout(15000), headers: { apikey: adminKey, Authorization: 'Bearer ' + adminKey, ...options.headers } });
    if (!response.ok && !(response.status === 409 && path === '/storage/v1/object/copy')) throw fail(503, '계정 정리를 완료하지 못했습니다. 다시 시도해주세요.');
    return response;
  }
  async function enrich(rows, token) {
    if (!rows.length) return [];
    const meta = await rpc('review_metadata', token, { menu_ids: [...new Set(rows.map(r => r.menu_id))] });
    const lookup = new Map(meta.map(r => [r.id, r]));
    return rows.map(r => ({ ...mapReview(r), likes: Number(lookup.get(r.id)?.likes || 0), liked: lookup.get(r.id)?.liked || false }));
  }


  return async function handleApi(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, origin || 'http://localhost');
      const route = url.pathname.replace(/^\/api\//, '');
      const method = req.method;
      if (method === 'GET' && route === 'status') return send(200, { mode: configured ? 'live' : production ? 'unconfigured' : 'demo', launchReady, operator, maps: { key: env.GOOGLE_MAPS_API_KEY || '', mapId: env.GOOGLE_MAPS_MAP_ID || '' }, withdrawalReady: Boolean(adminKey) });
      if (!configured) return send(503, { error: '서비스 연결 설정이 아직 완료되지 않았습니다.' });
      if (!origin.startsWith('https://') && production) throw fail(503, 'HTTPS 운영 주소 설정이 필요합니다.');
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) throw fail(405, '지원하지 않는 요청입니다.');
      if (method !== 'GET') {
        if (req.headers.origin !== origin) throw fail(403, '요청 출처를 확인할 수 없습니다.');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'JSON 요청만 허용합니다.');
      }
      const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(part => part.includes('=')).map(part => { const at = part.indexOf('='); return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))]; }));
      let token = cookies['rm-access'];
      let user = null;
      if (token || cookies['rm-refresh']) {
        try {
          if (token) user = await (await upstream('/auth/v1/user', token)).json();
          else throw fail(401, 'Expired');
        } catch (error) {
          if (error.status !== 401) throw error;
          if (cookies['rm-refresh']) {
            try {
              const session = await (await upstream('/auth/v1/token?grant_type=refresh_token', null, writeOptions('POST', { refresh_token: cookies['rm-refresh'] }))).json();
              token = session.access_token;
              user = await (await upstream('/auth/v1/user', token)).json();
              res.setHeader('Set-Cookie', [cookie('rm-access', token, session.expires_in), cookie('rm-refresh', session.refresh_token, 2592000)]);
            } catch (refreshError) {
              if (refreshError.status !== 401) throw refreshError;
              token = undefined; res.setHeader('Set-Cookie', clearSession());
            }
          } else { token = undefined; res.setHeader('Set-Cookie', clearSession()); }
        }
      }
      let profile = user ? one(await query('profiles?user_id=eq.' + user.id, token)) : null;
      const requireUser = (allowClosing = false) => {
        if (!user) throw fail(401, '로그인 후 이용해주세요.');
        if (!user.email_confirmed_at) throw fail(403, '이메일 인증을 완료해주세요.');
        if (!profile || (!allowClosing && profile.status !== 'active')) throw fail(403, '계정 정리 중입니다. 내 기록에서 탈퇴를 다시 시도해주세요.');
      };
      const requireAdmin = () => { requireUser(); if (user.app_metadata?.role !== 'admin') throw fail(403, '관리자만 이용할 수 있습니다.'); };
      let body;
      if (method !== 'GET') {
        const chunks = []; let size = 0;
        if (req.body === undefined) for await (const chunk of req) { size += chunk.length; if (size > 2100000) throw fail(413, '요청 크기가 너무 큽니다.'); chunks.push(chunk); }
        try {
          const raw = req.body !== undefined ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : Buffer.concat(chunks).toString('utf8');
          if (Buffer.byteLength(raw) > 2100000) throw fail(413, '요청 크기가 너무 큽니다.');
          body = JSON.parse(raw);
        } catch (error) { if (error.status) throw error; throw fail(400, '입력 형식을 확인해주세요.'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') throw fail(400, '입력 형식을 확인해주세요.');
      }
      if (['auth/login','auth/signup','auth/recover','auth/resend'].includes(route) && method === 'POST') {
        if (!launchReady) throw fail(503, '운영 정보와 개인정보 안내를 준비 중입니다.');
        if (!validEmail(body.email)) throw fail(400, '이메일 주소를 확인해주세요.');
        if (route === 'auth/login' || route === 'auth/signup') {
          if (!validPassword(body.password)) throw fail(400, '비밀번호는 12~128자로 입력해주세요.');
        }
        if (route === 'auth/signup') {
          if (body.agreed !== true || body.ageConfirmed !== true) throw fail(400, '이용약관과 만 14세 이상 여부를 확인해주세요.');
          if (validateNickname(body.nickname)) throw fail(400, validateNickname(body.nickname));
          await upstream('/auth/v1/signup', null, writeOptions('POST', { email: body.email.trim(), password: body.password, data: { nickname: body.nickname.trim(), terms_version: '2026-10-17', age_confirmed: true } }));
          return send(200, { message: '가입 가능한 이메일이면 인증 메일을 보냈습니다. 받은 편지함을 확인해주세요.' });
        }
        if (route === 'auth/recover' || route === 'auth/resend') {
          await upstream(route === 'auth/recover' ? '/auth/v1/recover' : '/auth/v1/resend', null, writeOptions('POST', { email: body.email.trim(), ...(route === 'auth/resend' ? { type: 'signup' } : {}) }));
          return send(200, { message: '해당 이메일로 진행할 수 있다면 메일을 보냈습니다. 받은 편지함을 확인해주세요.' });
        }
        const session = await (await upstream('/auth/v1/token?grant_type=password', null, writeOptions('POST', { email: body.email.trim(), password: body.password }))).json();
        const verified = await (await upstream('/auth/v1/user', session.access_token)).json();
        if (!verified.email_confirmed_at) throw fail(403, '이메일 인증을 완료해주세요.');
        res.setHeader('Set-Cookie', authSession(session));
        return send(200, { next: safeNext(body.next) });
      }
      if (route === 'auth/verify' && method === 'POST') {
        if (!launchReady) throw fail(503, '가입을 준비하고 있습니다.');
        if (typeof body.tokenHash !== 'string' || !/^[a-zA-Z0-9_-]{20,256}$/.test(body.tokenHash) || !['signup','recovery','email'].includes(body.type)) throw fail(400, '인증 링크를 확인해주세요.');
        const session = await (await upstream('/auth/v1/verify', null, writeOptions('POST', { token_hash: body.tokenHash, type: body.type }))).json();
        const verified = await (await upstream('/auth/v1/user', session.access_token)).json();
        if (!verified.email_confirmed_at) throw fail(403, '이메일 인증을 완료해주세요.');
        const sessionCookies = authSession(session);
        if (body.type === 'recovery') sessionCookies.push(cookie('rm-recovery', createHash('sha256').update(session.access_token).digest('hex'), 600));
        res.setHeader('Set-Cookie', sessionCookies);
        return send(200, { next: body.type === 'recovery' ? '/login?mode=reset' : '/me' });
      }
      if (route === 'auth/password' && method === 'POST') {
        requireUser(true);
        if (!token || cookies['rm-recovery'] !== createHash('sha256').update(token).digest('hex')) throw fail(403, '비밀번호 재설정 메일에서 다시 시작해주세요.');
        if (!validPassword(body.password)) throw fail(400, '비밀번호는 12~128자로 입력해주세요.');
        await upstream('/auth/v1/user', token, writeOptions('PUT', { password: body.password }));
        res.setHeader('Set-Cookie', cookie('rm-recovery', '', 0));
        return send(200, { ok: true });
      }
      if (route === 'profile' && method === 'PATCH') {
        requireUser(); if (validateNickname(body.nickname)) throw fail(400, validateNickname(body.nickname));
        await rpc('change_nickname', token, { value: body.nickname.trim() }); return send(200, { ok: true });
      }
      if (route === 'auth/logout' && method === 'POST') {
        if (user) await upstream('/auth/v1/logout', token, { method: 'POST' });
        res.setHeader('Set-Cookie', [...clearSession(), cookie('rm-recovery', '', 0)]); return send(200, { ok: true });
      }
      if (route === 'bootstrap' && method === 'GET') {
        const [shops, menus, stats, reviews, mine, saved, requests, drafts] = await Promise.all([
          query('shops?select=*&order=name', token), query('menus?select=*&order=name', token), query('menu_stats?select=*', token),
          query('reviews?select=*&hidden=eq.false&order=updated_at.desc&limit=100', token),
          user ? query('reviews?select=*&user_id=eq.' + user.id + '&order=updated_at.desc', token) : [],
          user ? query('saved_menus?select=menu_id&user_id=eq.' + user.id, token) : [],
          user ? query('registration_requests?user_id=eq.' + user.id + '&order=created_at.desc', token) : [],
          user ? query('review_drafts?user_id=eq.' + user.id, token) : [],
        ]);
        const photos = await rpc('menu_photos', token, { menu_ids: menus.map(m => m.id) });
        const images = new Map(photos.map(p => [p.menu_id, '/api/photos/' + p.photo]));
        return send(200, { user: user ? { id: user.id, admin: user.app_metadata?.role === 'admin', nickname: profile?.nickname, status: profile?.status } : null, shops, menus: menus.map(m => ({ ...m, shopId: m.shop_id, image: images.get(m.id) || '', taste: [] })), stats, reviews: await enrich([...new Map([...reviews,...mine].map(r => [r.id,r])).values()], token), saved: saved.map(s => s.menu_id), requests, drafts });
      }
      if (route === 'reviews' && method === 'GET') {
        const menu = url.searchParams.get('menu');
        if (!menu || menu.length > 100) throw fail(400, '메뉴를 확인해주세요.');
        const rows = await query('reviews?select=*&menu_id=eq.' + encodeURIComponent(menu) + '&order=updated_at.desc&limit=100', token);
        return send(200, await enrich(rows, token));
      }
      if (route === 'reviews' && method === 'PUT') {
        requireUser();
        if (typeof body.body !== 'string' || typeof body.menuId !== 'string') throw fail(400, '메뉴와 본문을 확인해주세요.');
        const error = validateReview(body); if (error) throw fail(400, error);
        if (!Array.isArray(body.photos) || body.photos.length > 5 || body.photos.some(p => typeof p !== 'string' || !p.startsWith('/api/photos/' + user.id + '/') || !photoPath.test(p.slice(12)))) throw fail(400, '사진을 확인해주세요.');
        const prior = await query('reviews?select=id,photos&user_id=eq.' + user.id + '&menu_id=eq.' + encodeURIComponent(body.menuId), token);
        await rpc('submit_review', token, { menu: body.menuId, score: body.rating, content: body.body, detail: body.details || {}, photos: body.photos.map(p => p.slice(12)), order_options: body.options || '' });
        await cleanupPhotos(prior[0]?.photos || [], body.photos.map(p => p.slice(12)), token);
        return send(200, { ok: true });
      }
      if (/^reviews\/[0-9a-f-]{36}$/.test(route) && method === 'DELETE') {
        requireUser(); const id = route.slice(8);
        const rows = await query('reviews?select=photos&id=eq.' + id + '&user_id=eq.' + user.id, token);
        if (!rows.length) throw fail(403, '본인의 리뷰만 삭제할 수 있습니다.');
        await query('reviews?id=eq.' + id + '&user_id=eq.' + user.id, token, writeOptions('DELETE'));
        await cleanupPhotos(rows[0].photos, [], token); return send(200, { ok: true });
      }
      if (route === 'menus' && method === 'POST') {
        requireUser(); const error = validateMenu(body); if (error) throw fail(400, error);
        if (typeof body.shopId !== 'string' || body.photos.some(p => typeof p !== 'string' || !p.startsWith('/api/photos/' + user.id + '/') || !photoPath.test(p.slice(12)))) throw fail(400, '가게와 사진을 확인해주세요.');
        const menu = one(await rpc('add_menu', token, { shop: body.shopId, menu_name: body.name, price_value: body.price, genre: body.genre, photos: body.photos.map(p => p.slice(12)) }));
        return send(200, { ...menu, shopId: menu.shop_id });
      }
      if (route === 'likes' && method === 'POST') {
        requireUser(); if (!uuid.test(body.reviewId) || typeof body.liked !== 'boolean') throw fail(400, '리뷰를 확인해주세요.');
        if (body.liked) await query('review_likes', token, { ...writeOptions('POST', { user_id: user.id, review_id: body.reviewId }), headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' } });
        else await query('review_likes?user_id=eq.' + user.id + '&review_id=eq.' + body.reviewId, token, writeOptions('DELETE'));
        return send(200, { ok: true });
      }
      if (route === 'drafts/publish' && method === 'POST') {
        requireUser(); if (!uuid.test(body.id)) throw fail(400, '초안을 확인해주세요.');
        return send(200, await rpc('publish_draft', token, { draft_id: body.id }));
      }
      if (route === 'drafts' && method === 'PUT') {
        requireUser();
        const data = body.data;
        if (!uuid.test(body.requestId) || !data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 15000 || !Array.isArray(data.photos) || data.photos.length > 5 || data.photos.some(p => typeof p !== 'string' || !photoPath.test(p) || !p.startsWith(user.id + '/'))) throw fail(400, '초안 내용을 확인해주세요.');
        const rows = await query('review_drafts?on_conflict=user_id,request_id', token, { ...writeOptions('POST', { user_id: user.id, request_id: body.requestId, data, updated_at: new Date().toISOString() }), headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' } });
        return send(200, one(rows));
      }
      if (/^drafts\/[0-9a-f-]{36}$/.test(route) && method === 'DELETE') {
        requireUser(); await query('review_drafts?id=eq.' + route.slice(7) + '&user_id=eq.' + user.id, token, writeOptions('DELETE')); return send(200, { ok: true });
      }
      if (route === 'account/withdraw' && method === 'POST') {
        requireUser(true);
        const deadline = Date.now() + 20000;
        const checkDeadline = () => { if (Date.now() > deadline) throw fail(503, '계정 정리를 나누어 진행하고 있습니다. 같은 선택으로 다시 시도해주세요.'); };
        if (!adminKey) throw fail(503, '계정 삭제 설정을 준비 중입니다.');
        if (typeof body.preserve !== 'boolean' || typeof body.password !== 'string') throw fail(400, '보존 선택과 현재 비밀번호를 확인해주세요.');
        await upstream('/auth/v1/token?grant_type=password', null, writeOptions('POST', { email: user.email, password: body.password }));
        const job = one(await rpc('begin_withdrawal', token, { preserve_content: body.preserve }));
        if (job.preserve !== body.preserve) throw fail(409, `이전 선택인 '${job.preserve ? '개인정보 점검 후 보존 요청' : '내 리뷰·사진 삭제'}'로 정리 중입니다. 같은 선택으로 다시 시도해주세요.`);
        if (job.preserve && job.status === 'processing') for (const source of job.photos) {
          checkDeadline();
          await adminCall('/storage/v1/object/copy', writeOptions('POST', { bucketId: 'review-photos', sourceKey: source, destinationKey: job.id + '/' + source.split('/')[1] }));
          job.photos = job.photos.filter(p => p !== source);
          await adminCall('/rest/v1/withdrawal_jobs?id=eq.' + job.id, writeOptions('PATCH', { photos: job.photos }));
        }
        if (job.status === 'processing') await adminCall('/rest/v1/rpc/detach_withdrawal', writeOptions('POST', { job_id: job.id }));
        // API deletion removes actual objects too; never delete storage metadata with SQL.
        async function removeOwned(prefix) {
          for (;;) {
            checkDeadline();
            const response = await adminCall('/storage/v1/object/list/review-photos', writeOptions('POST', { prefix, limit: 100, offset: 0 }));
            const objects = await response.json();
            if (!objects.length) break;
            const files = [];
            for (const object of objects) {
              if (!object.name || object.name.includes('/') || ['.','..'].includes(object.name)) throw fail(503, '사진 경로를 확인하지 못했습니다. 운영자에게 문의해주세요.');
              if (object.id === null) await removeOwned(prefix + object.name + '/');
              else files.push(prefix + object.name);
            }
            if (files.length) await adminCall('/storage/v1/object/review-photos', writeOptions('DELETE', { prefixes: files }));
          }
        }
        await removeOwned(user.id + '/');
        await adminCall('/auth/v1/admin/users/' + user.id, { method: 'DELETE' });
        let cleanupPending = false;
        try { await adminCall('/rest/v1/withdrawal_jobs?id=eq.' + job.id, writeOptions('DELETE')); } catch { cleanupPending = true; }
        // The Auth account is already deleted; a failed housekeeping step cannot be retried by signing in.
        res.setHeader('Set-Cookie', [...clearSession(), cookie('rm-recovery', '', 0)]);
        return send(200, { ok: true, cleanupPending });
      }
      if (route === 'saved' && method === 'POST') {
        requireUser(); if (typeof body.menuId !== 'string' || typeof body.saved !== 'boolean') throw fail(400, '메뉴를 확인해주세요.');
        if (body.saved) await query('saved_menus', token, { ...writeOptions('POST', { user_id: user.id, menu_id: body.menuId }), headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' } });
        else await query('saved_menus?user_id=eq.' + user.id + '&menu_id=eq.' + encodeURIComponent(body.menuId), token, writeOptions('DELETE'));
        return send(200, { ok: true });
      }
      if (route === 'photos' && method === 'POST') {
        requireUser();
        if (typeof body.data !== 'string' || !/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(body.data)) throw fail(400, 'JPEG 사진만 업로드할 수 있습니다.');
        const bytes = Buffer.from(body.data.split(',')[1], 'base64');
        if (bytes.length > 1500000 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw fail(400, '사진 크기 또는 형식을 확인해주세요.');
        const name = user.id + '/' + randomUUID() + '.jpg';
        let clean;
        try { clean = stripJpegMetadata(bytes); } catch { throw fail(400, '사진 형식을 확인해주세요.'); }
        await upstream('/storage/v1/object/review-photos/' + name, token, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: clean });
        return send(200, { url: '/api/photos/' + name });
      }
      if (route.startsWith('photos/') && method === 'GET') {
        const name = route.slice(7); if (!photoPath.test(name)) throw fail(404, '사진을 찾을 수 없습니다.');
        const response = await upstream('/storage/v1/object/authenticated/review-photos/' + name, token);
        res.setHeader('Content-Type', 'image/jpeg'); return res.end(Buffer.from(await response.arrayBuffer()));
      }
      if (route === 'reports' && method === 'POST') {
        requireUser();
        if (!uuid.test(body.reviewId) || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw fail(400, '신고 사유를 확인해주세요.');
        await query('reports', token, writeOptions('POST', { user_id: user.id, review_id: body.reviewId, reason: body.reason.trim() })); return send(200, { ok: true });
      }
      if (route === 'requests' && method === 'POST') {
        requireUser();
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.area !== 'string' || !body.area.trim() || body.area.length > 100 || typeof body.address !== 'string' || !body.address.trim() || body.address.length > 300 || !Number.isFinite(body.lat) || Math.abs(body.lat) > 90 || !Number.isFinite(body.lng) || Math.abs(body.lng) > 180) throw fail(400, '가게명·지역·주소·지도 위치를 확인해주세요.');
        const rows = await query('registration_requests', token, writeOptions('POST', { user_id: user.id, name: body.name.trim(), area: body.area.trim(), address: body.address.trim(), lat: body.lat, lng: body.lng, note: body.address.trim() }));
        return send(200, one(rows));
      }
      if (route === 'admin' && method === 'GET') {
        requireAdmin(); const [reports, requests, reviews] = await Promise.all(['reports?order=created_at.desc&limit=100','registration_requests?order=created_at.desc&limit=100','reviews?order=updated_at.desc&limit=100'].map(p => query(p, token)));
        return send(200, { reports, requests, reviews: reviews.map(mapReview) });
      }
      if (route === 'admin' && method === 'POST') {
        requireAdmin();
        if (body.type === 'review' && uuid.test(body.id) && typeof body.hidden === 'boolean' && typeof body.reason === 'string' && body.reason.trim() && body.reason.length <= 1000) await query('rpc/moderate_review', token, writeOptions('POST', { review_id: body.id, hide: body.hidden, reason: body.reason.trim() }));
        else if (body.type === 'registration' && uuid.test(body.id) && ['approved','rejected'].includes(body.decision) && typeof body.reason === 'string' && body.reason.length <= 1000) await rpc('decide_registration', token, { request: body.id, decision: body.decision, reason_value: body.reason, existing_shop: body.shopId || null });
        else if (body.type === 'privacy' && uuid.test(body.id) && body.checked === true && typeof body.reason === 'string' && body.reason.trim()) await rpc('approve_retained_review', token, { review_id: body.id, reason: body.reason });
        else if (body.type === 'report' && uuid.test(body.id)) await query((body.type === 'report' ? 'reports' : 'registration_requests') + '?id=eq.' + body.id, token, writeOptions('PATCH', { status: 'resolved' }));
        else if (body.type === 'menu-status' && typeof body.id === 'string' && ['active','ended'].includes(body.status)) await query('menus?id=eq.' + encodeURIComponent(body.id), token, writeOptions('PATCH', { status: body.status }));
        else if (body.type === 'menu') {
          const record=body.record; const error=validateMenu(record || {}); if(error)throw fail(400,error);
          if(typeof record.shop_id !== 'string' || record.photos.some(p=>typeof p !== 'string' || !p.startsWith('/api/photos/'+user.id+'/') || !photoPath.test(p.slice(12)))) throw fail(400,'가게와 사진을 확인해주세요.');
          const menu=one(await rpc('add_menu',token,{shop:record.shop_id,menu_name:record.name,price_value:record.price,genre:record.genre,photos:record.photos.map(p=>p.slice(12))}));
          return send(200,{menu});
        }
        else if (body.type === 'shop') {
          const record = body.record;
          if (!record || typeof record.name !== 'string' || !record.name.trim()) throw fail(400, '이름을 확인해주세요.');
          const columns = ['name','area','address','lat','lng','description','hours','source_url'];
          if (record.image && !/^https:\/\//.test(record.image)) throw fail(400, '이미지는 HTTPS 주소를 사용해주세요.');
          await query('shops', token, writeOptions('POST', Object.fromEntries(columns.filter(c => record[c] !== undefined).map(c => [c, record[c]]))));
        } else throw fail(400, '작업을 확인해주세요.');
        return send(200, { ok: true });
      }
      throw fail(404, '요청을 찾을 수 없습니다.');
    } catch (error) { send(error.status || 503, { error: error.status ? error.message : '서비스에 연결하지 못했어요. 잠시 후 다시 시도해주세요.' }); }
  };

  async function cleanupPhotos(previous, current, token) {
    const removed = previous.filter(p => !current.includes(p));
    if (!removed.length) return;
    // A failed storage cleanup must not turn a committed review write into a failed save.
    try {
      const unreferenced = [];
      for (const path of removed) {
        const contains = encodeURIComponent(JSON.stringify([path]));
        const [reviews, drafts] = await Promise.all([
          query('reviews?select=id&photos=cs.' + contains + '&limit=1', token),
          query('review_drafts?select=id&data->photos=cs.' + contains + '&limit=1', token),
        ]);
        if (!reviews.length && !drafts.length) unreferenced.push(path);
      }
      if (unreferenced.length) await upstream('/storage/v1/object/review-photos', token, writeOptions('DELETE', { prefixes: unreferenced }));
    } catch { /* Keep the file if reference checks fail; operator cleanup can retry. */ }
  }
}
