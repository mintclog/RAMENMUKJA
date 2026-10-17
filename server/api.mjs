import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { validateReview } from '../src/domain.js';
import { stripJpegMetadata } from './photos.mjs';

const photoPath = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;
const uuid = /^[0-9a-f-]{36}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const safeNext = value => typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\r\n]/.test(value) && !value.startsWith('/api/') ? value : '/me';

export function createApi({ env = process.env, fetcher = fetch } = {}) {
  const origin = env.APP_ORIGIN?.replace(/\/$/, '');
  const endpoint = env.SUPABASE_URL?.replace(/\/$/, '');
  const key = env.SUPABASE_ANON_KEY;
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
  const mapReview = r => ({ id: r.id, userId: r.user_id, menuId: r.menu_id, author: r.author, rating: r.rating, body: r.body, disclosure: r.disclosure, details: r.details, taste: r.taste, photos: r.photos.map(p => '/api/photos/' + p), hidden: r.hidden, moderationReason: r.moderation_reason, date: new Date(r.updated_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) });

  return async function handleApi(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, origin || 'http://localhost');
      const route = url.pathname.replace(/^\/api\//, '');
      const method = req.method;
      if (method === 'GET' && route === 'status') return send(200, { mode: configured ? 'live' : production ? 'unconfigured' : 'demo', launchReady, operator });
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
      const requireUser = () => { if (!user) throw fail(401, '로그인 후 이용해주세요.'); };
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
      if (route === 'auth/login' && method === 'POST') {
        if (!launchReady) throw fail(503, '운영 정보와 개인정보 안내를 준비 중입니다. 현재 신규 로그인은 열리지 않았습니다.');
        if (body.agreed !== true || body.ageConfirmed !== true) throw fail(400, '이용약관과 만 14세 이상 여부를 확인해주세요.');
        const verifier = randomBytes(32).toString('base64url');
        const state = randomBytes(24).toString('base64url');
        const callback = new URL('/api/auth/callback', origin); callback.searchParams.set('state', state);
        const authorize = new URL('/auth/v1/authorize', endpoint);
        authorize.search = new URLSearchParams({ provider: 'kakao', redirect_to: callback.href, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256' }).toString();
        res.setHeader('Set-Cookie', [cookie('rm-pkce', verifier, 600), cookie('rm-state', state, 600), cookie('rm-next', safeNext(body.next), 600)]);
        return send(200, { url: authorize.href });
      }
      if (route === 'auth/callback' && method === 'GET') {
        if (!cookies['rm-pkce'] || !cookies['rm-state'] || url.searchParams.get('state') !== cookies['rm-state'] || !url.searchParams.get('code')) throw fail(400, '로그인을 완료하지 못했어요. 다시 시작해주세요.');
        const session = await (await upstream('/auth/v1/token?grant_type=pkce', null, writeOptions('POST', { auth_code: url.searchParams.get('code'), code_verifier: cookies['rm-pkce'] }))).json();
        const verified = await (await upstream('/auth/v1/user', session.access_token)).json();
        await query('user_consents', session.access_token, { ...writeOptions('POST', { user_id: verified.id, version: '2026-10-16', age_confirmed: true }), headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' } });
        res.setHeader('Set-Cookie', [cookie('rm-access', session.access_token, session.expires_in), cookie('rm-refresh', session.refresh_token, 2592000), ...['rm-pkce','rm-state','rm-next'].map(name => cookie(name, '', 0))]);
        res.statusCode = 303; res.setHeader('Location', safeNext(cookies['rm-next'])); return res.end();
      }
      if (route === 'auth/logout' && method === 'POST') {
        if (user) await upstream('/auth/v1/logout', token, { method: 'POST' });
        res.setHeader('Set-Cookie', clearSession()); return send(200, { ok: true });
      }
      if (route === 'bootstrap' && method === 'GET') {
        const [shops, menus, stats, reviews, mine, saved] = await Promise.all([
          query('shops?select=*&order=name', token), query('menus?select=*&order=name', token), query('menu_stats?select=*', token),
          query('reviews?select=*&hidden=eq.false&order=updated_at.desc&limit=100', token),
          user ? query('reviews?select=*&user_id=eq.' + user.id + '&order=updated_at.desc', token) : [],
          user ? query('saved_menus?select=menu_id&user_id=eq.' + user.id, token) : [],
        ]);
        return send(200, { user: user ? { id: user.id, admin: user.app_metadata?.role === 'admin' } : null, shops, menus: menus.map(m => ({ ...m, shopId: m.shop_id })), stats, reviews: [...new Map([...reviews,...mine].map(r => [r.id, mapReview(r)])).values()], saved: saved.map(s => s.menu_id) });
      }
      if (route === 'reviews' && method === 'GET') {
        const menu = url.searchParams.get('menu');
        if (!menu || menu.length > 100) throw fail(400, '메뉴를 확인해주세요.');
        const rows = await query('reviews?select=*&menu_id=eq.' + encodeURIComponent(menu) + '&order=updated_at.desc&limit=100', token);
        return send(200, rows.map(mapReview));
      }
      if (route === 'reviews' && method === 'PUT') {
        requireUser();
        if (typeof body.body !== 'string' || typeof body.menuId !== 'string') throw fail(400, '메뉴와 본문을 확인해주세요.');
        const error = validateReview(body); if (error) throw fail(400, error);
        if (!Array.isArray(body.photos) || body.photos.length > 5 || body.photos.some(p => typeof p !== 'string' || !p.startsWith('/api/photos/' + user.id + '/') || !photoPath.test(p.slice(12)))) throw fail(400, '사진을 확인해주세요.');
        const prior = await query('reviews?select=id,photos&user_id=eq.' + user.id + '&menu_id=eq.' + encodeURIComponent(body.menuId), token);
        const record = { author: '라멘 기록', rating: body.rating, body: body.body.trim(), disclosure: body.disclosure, details: body.details || {}, taste: body.taste || {}, photos: body.photos.map(p => p.slice(12)) };
        if (prior.length) await query('reviews?id=eq.' + prior[0].id, token, writeOptions('PATCH', record));
        else await query('reviews', token, writeOptions('POST', { ...record, user_id: user.id, menu_id: body.menuId }));
        await cleanupPhotos(prior[0]?.photos || [], record.photos, token);
        return send(200, { ok: true });
      }
      if (/^reviews\/[0-9a-f-]{36}$/.test(route) && method === 'DELETE') {
        requireUser(); const id = route.slice(8);
        const rows = await query('reviews?select=photos&id=eq.' + id + '&user_id=eq.' + user.id, token);
        if (!rows.length) throw fail(403, '본인의 리뷰만 삭제할 수 있습니다.');
        await query('reviews?id=eq.' + id + '&user_id=eq.' + user.id, token, writeOptions('DELETE'));
        await cleanupPhotos(rows[0].photos, [], token); return send(200, { ok: true });
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
        requireUser(); if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 1000) throw fail(400, '등록 요청 내용을 확인해주세요.');
        await query('registration_requests', token, writeOptions('POST', { user_id: user.id, name: body.name.trim(), note: body.note.trim() })); return send(200, { ok: true });
      }
      if (route === 'admin' && method === 'GET') {
        requireAdmin(); const [reports, requests, reviews] = await Promise.all(['reports?order=created_at.desc&limit=100','registration_requests?order=created_at.desc&limit=100','reviews?order=updated_at.desc&limit=100'].map(p => query(p, token)));
        return send(200, { reports, requests, reviews: reviews.map(mapReview) });
      }
      if (route === 'admin' && method === 'POST') {
        requireAdmin();
        if (body.type === 'review' && uuid.test(body.id) && typeof body.hidden === 'boolean' && typeof body.reason === 'string' && body.reason.trim() && body.reason.length <= 1000) await query('rpc/moderate_review', token, writeOptions('POST', { review_id: body.id, hide: body.hidden, reason: body.reason.trim() }));
        else if (['report','request'].includes(body.type) && uuid.test(body.id)) await query((body.type === 'report' ? 'reports' : 'registration_requests') + '?id=eq.' + body.id, token, writeOptions('PATCH', { status: 'resolved' }));
        else if (body.type === 'menu-status' && typeof body.id === 'string' && ['active','ended'].includes(body.status)) await query('menus?id=eq.' + encodeURIComponent(body.id), token, writeOptions('PATCH', { status: body.status }));
        else if (body.type === 'shop' || body.type === 'menu') {
          const record = body.record;
          if (!record || typeof record.name !== 'string' || !record.name.trim()) throw fail(400, '이름을 확인해주세요.');
          const columns = body.type === 'shop' ? ['name','area','address','lat','lng','description','hours','source_url'] : ['shop_id','name','price','tags','image','status','description','taste'];
          if (record.image && !/^https:\/\//.test(record.image)) throw fail(400, '이미지는 HTTPS 주소를 사용해주세요.');
          await query(body.type === 'shop' ? 'shops' : 'menus', token, writeOptions('POST', Object.fromEntries(columns.filter(c => record[c] !== undefined).map(c => [c, record[c]]))));
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
    try { await upstream('/storage/v1/object/review-photos', token, writeOptions('DELETE', { prefixes: removed })); } catch { /* Orphan cleanup can be retried by the operator. */ }
  }
}
