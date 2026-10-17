import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { stripJpegMetadata } from '../server/photos.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const config = { APP_ORIGIN: 'https://example.test', SUPABASE_URL: 'https://database.test', SUPABASE_ANON_KEY: 'test-public-key', VERCEL: '1', ALLOW_PUBLIC_SIGNIN: 'true', PUBLIC_OPERATOR_NAME: 'Test Operator', PUBLIC_CONTACT_EMAIL: 'contact@example.test', PUBLIC_OPERATOR_ADDRESS: 'Test Address', PUBLIC_DATA_REGION: 'Test region', PUBLIC_RETENTION_POLICY: 'Test retention' };
async function start(t, env = config, fetcher = async () => { throw Error('Unexpected upstream request'); }) {
  const server = http.createServer(createApi({ env, fetcher }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, options);
}
const post = body => ({ method: 'POST', headers: { Origin: config.APP_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('deployment without configuration never falls back to fictional demo data', async t => {
  const call = await start(t, { VERCEL: '1' });
  assert.equal((await (await call('status')).json()).mode, 'unconfigured');
  assert.equal((await call('bootstrap')).status, 503);
});

test('local development retains explicit browser demo mode', async t => {
  const call = await start(t, {});
  assert.equal((await (await call('status')).json()).mode, 'demo');
});

test('writes require the configured origin and JSON body', async t => {
  const call = await start(t);
  assert.equal((await call('saved', { ...post({}), headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await call('saved', { method: 'POST', headers: { Origin: config.APP_ORIGIN }, body: 'x' })).status, 415);
  assert.equal((await call('saved', post({ menuId: 'm1', saved: true }))).status, 401);
});

test('OAuth uses PKCE and secure HTTP-only cookies and rejects unsafe callback state', async t => {
  const call = await start(t);
  const response = await call('auth/login', post({ next: '//attacker.test', agreed: true, ageConfirmed: true }));
  assert.equal(response.status, 200);
  const authorization = new URL((await response.json()).url);
  assert.equal(authorization.searchParams.get('provider'), 'kakao');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 's256');
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Lax')));
  assert.ok(cookies.some(cookie => cookie.startsWith('rm-next=%2Fme;')));
  const verifier = decodeURIComponent(cookies.find(cookie => cookie.startsWith('rm-pkce=')).split(';')[0].slice(8));
  assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal((await call('auth/callback?code=x&state=attacker')).status, 400);
});

test('public sign-in stays closed until operator policies are configured', async t => {
  const call = await start(t, { ...config, PUBLIC_CONTACT_EMAIL: '' });
  assert.equal((await (await call('status')).json()).launchReady, false);
  assert.equal((await call('auth/login', post({ agreed: true, ageConfirmed: true }))).status, 503);
});

test('regular users cannot call administrative operations', async t => {
  const call = await start(t, config, async url => {
    assert.equal(url, config.SUPABASE_URL + '/auth/v1/user');
    return Response.json({ id: userId, app_metadata: {} });
  });
  assert.equal((await call('admin', { headers: { Cookie: 'rm-access=test-token' } })).status, 403);
});

test('review ownership and author are derived from the verified session', async t => {
  let inserted;
  const call = await start(t, config, async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: userId, app_metadata: {} });
    if (options.method === 'POST') { inserted = JSON.parse(options.body); return Response.json([inserted]); }
    return Response.json([]);
  });
  const options = post({ menuId: 'm1', userId: 'attacker', author: 'forged', rating: 3, body: '', disclosure: 'self', photos: [], details: {}, taste: {} });
  options.method = 'PUT'; options.headers.Cookie = 'rm-access=test-token';
  assert.equal((await call('reviews', options)).status, 200);
  assert.equal(inserted.user_id, userId);
  assert.equal(inserted.author, '라멘 기록');
});

test('five-star validation and foreign photo paths are rejected before writes', async t => {
  const call = await start(t, config, async url => {
    assert.ok(url.endsWith('/auth/v1/user'));
    return Response.json({ id: userId });
  });
  for (const review of [{ rating: 5, photos: [] }, { rating: 3, photos: ['/api/photos/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.jpg'] }]) {
    const options = post({ menuId: 'm1', body: '', disclosure: 'self', ...review }); options.method = 'PUT'; options.headers.Cookie = 'rm-access=test-token';
    assert.equal((await call('reviews', options)).status, 400);
  }
});

test('JPEG metadata is removed and incomplete segments are rejected', () => {
  const jpeg = Buffer.from([255,216, 255,225,0,6,1,2,3,4, 255,218,0,2, 1,2,3, 255,217]);
  assert.deepEqual(stripJpegMetadata(jpeg), Buffer.from([255,216,255,218,0,2,1,2,3,255,217]));
  assert.throws(() => stripJpegMetadata(jpeg.subarray(0,10)));
  assert.throws(() => stripJpegMetadata(Buffer.from('not a JPEG')));
});

test('expired sessions rotate cookies and never expose provider profile or tokens', async t => {
  const call = await start(t, config, async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return options.headers.Authorization === 'Bearer expired'
      ? Response.json({}, { status: 401 })
      : Response.json({ id: userId, email: 'private@example.test', app_metadata: {} });
    if (url.includes('grant_type=refresh_token')) return Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 });
    return Response.json([]);
  });
  const response = await call('bootstrap', { headers: { Cookie: 'rm-access=expired; rm-refresh=refresh' } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.user, { id: userId, admin: false });
  assert.ok(!JSON.stringify(data).includes('private@example.test'));
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('rm-refresh=rotated;')));
});

test('deleting another user review is refused without issuing a delete', async t => {
  const call = await start(t, config, async (url, options) => {
    assert.notEqual(options.method, 'DELETE');
    return url.endsWith('/auth/v1/user') ? Response.json({ id: userId }) : Response.json([]);
  });
  const options = post({}); options.method = 'DELETE'; options.headers.Cookie = 'rm-access=test';
  assert.equal((await call('reviews/22222222-2222-4222-8222-222222222222', options)).status, 403);
});

test('OAuth callback records consent before issuing session cookies and redirects locally', async t => {
  let consent;
  const call = await start(t, config, async (url, options) => {
    if (url.includes('grant_type=pkce')) {
      assert.deepEqual(JSON.parse(options.body), { auth_code: 'one-use-code', code_verifier: 'verifier' });
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: userId });
    if (url.endsWith('/rest/v1/user_consents')) { consent = JSON.parse(options.body); return Response.json([consent]); }
    throw Error('Unexpected request');
  });
  const response = await call('auth/callback?state=expected&code=one-use-code', { redirect: 'manual', headers: { Cookie: 'rm-pkce=verifier; rm-state=expected; rm-next=%2Fmenus%2Fm1' } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/menus/m1');
  assert.deepEqual(consent, { user_id: userId, version: '2026-10-16', age_confirmed: true });
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('rm-access=access;')));
});
