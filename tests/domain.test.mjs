import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, validateReview, upsertReview, deleteReview, distanceKm, searchRelevance, combineStats, representativePhoto, validateMenu, normalizeMenuName, validateNickname, optionTags, serializeOptions } from '../src/domain.js';

const review = { id: 'r1', menuId: 'm1', userId: 'u1', rating: 3, body: '', disclosure: 'self', details: {} };

test('option tags preserve old free text, spelling and internal spaces across edits', () => {
  assert.deepEqual(optionTags('곱빼기, 차슈 추가'), ['곱빼기', '차슈 추가']);
  assert.deepEqual(optionTags('기존 주문 옵션'), ['기존 주문 옵션']);
  const value = serializeOptions(['곱빼기', '차슈 추가', '차슈추가']);
  assert.equal(value, '#곱빼기 #차슈 추가 #차슈추가');
  assert.deepEqual(optionTags(value), ['곱빼기', '차슈 추가', '차슈추가']);
});

test('option tags accept multiple hashtags, ignore empty/duplicate tags and retain the storage limit', () => {
  assert.deepEqual(optionTags(' #곱빼기 ＃차슈추가, #곱빼기\n## '), ['곱빼기', '차슈추가']);
  assert.equal(serializeOptions([]), '');
  assert.deepEqual(optionTags(), []);
  assert.equal(validateReview({ ...review, options: serializeOptions(['가'.repeat(299)]) }), null);
  assert.ok(validateReview({ ...review, options: serializeOptions(['가'.repeat(300)]) }));
});

test('search ranks menu names first and supports terms across shop and menu fields', () => {
  const menu = { name: '특제 쇼유라멘', tags: ['쇼유', '닭 육수'] };
  const shop = { name: '멘야 하루', area: '연남' };
  assert.ok(searchRelevance(menu, shop, '연남 쇼유') > 0);
  assert.equal(searchRelevance(menu, shop, '연남 돈코츠'), 0);
  assert.equal(searchRelevance(menu, shop, '   '), 0);
  assert.ok(searchRelevance(menu, shop, '쇼유') > searchRelevance({ ...menu, name: '다른 메뉴' }, shop, '쇼유'));
  assert.ok(searchRelevance({ ...menu, name: 'SHOYU' }, shop, 'shoyu') > 0);
});

test('empty scores are null; hidden and invalid scores do not count', () => {
  assert.equal(summarize([]).average, null);
  const stats = summarize([{ ...review, rating: 5 }, review, { ...review, rating: 1, hidden: true }, { ...review, rating: 9 }]);
  assert.deepEqual(stats, { count: 2, average: 4, distribution: [0,0,1,0,1] });
});

test('five stars require a meaningful reason; lower ratings may omit text', () => {
  assert.equal(validateReview(review), null);
  assert.ok(validateReview({ ...review, rating: 5, body: '  ' }));
  assert.equal(validateReview({ ...review, rating: 5, body: '기억에 남는 국물과 면의 균형' }), null);
  assert.ok(validateReview({ ...review, rating: 0 }));
  assert.equal(validateReview({ ...review, disclosure: null }), null);
  assert.ok(validateReview({ ...review, options: 'x'.repeat(301) }));
  assert.ok(validateReview({ ...review, details: { invalid: 3 } }));
  assert.ok(validateReview({ ...review, details: { broth: 6 } }));
  assert.ok(validateReview({ ...review, body: 'a'.repeat(2001) }));
});

test('one effective review per user and menu; editing recomputes distribution', () => {
  const other = { ...review, id: 'r2', userId: 'u2', rating: 4 };
  const next = upsertReview([review, other], { ...review, rating: 5, body: '인생 라멘' }, 'u1');
  assert.equal(next.length, 2);
  assert.equal(summarize(next).average, 4.5);
  assert.deepEqual(summarize(next).distribution, [0,0,0,1,1]);
  assert.equal(next.find(item => item.id === 'r2').rating, 4);
  assert.throws(() => upsertReview([], review, null));
});

test('only own reviews can be deleted; remaining score updates', () => {
  const reviews = [review, { ...review, id: 'r2', userId: 'u2', rating: 4 }];
  assert.throws(() => deleteReview(reviews, 'r1', 'u2'));
  assert.throws(() => deleteReview(reviews, 'r1', null));
  assert.equal(summarize(deleteReview(reviews, 'r1', 'u1')).average, 4);
});

test('distance calculation returns actual straight-line distance', () => {
  assert.equal(distanceKm(37.5, 127, 37.5, 127), 0);
  assert.ok(Math.abs(distanceKm(0, 0, 1, 0) - 111.195) < .01);
});

test('shop aggregation weights menu averages by their public review counts', () => {
  assert.deepEqual(combineStats([{ average: 5, count: 1 }, { average: 3, count: 9 }, { average: null, count: 0 }]), { count: 10, average: 3.2 });
  assert.deepEqual(combineStats([]), { count: 0, average: null });
});


test('representative image uses likes, stable ties, and excludes private/deleted reviews', () => {
 const rows=[{id:'a',date:'2026-10-10',likes:2,photos:['first']},{id:'b',date:'2026-10-11',likes:2,photos:['second']},{id:'c',date:'2026-10-12',likes:99,photos:['hidden'],hidden:true},{id:'d',likes:100,photos:['draft'],draft:true},{id:'e',likes:200,photos:['private'],privacyPending:true}];
 assert.equal(representativePhoto(rows),'first');
 assert.equal(representativePhoto([...rows,{id:'f',likes:3,photos:['winner']}]),'winner');
 assert.equal(representativePhoto([{photos:[]}]),'');
});

test('menu creation requires all four fields and normalized duplicate names match', () => {
 const menu={name:'쇼유 라멘',price:10000,genre:'쇼유',photos:['photo']};
 assert.equal(validateMenu(menu),null);
 for(const fields of [{name:''},{price:NaN},{price:-1},{price:1.2},{genre:''},{photos:[]}]) assert.ok(validateMenu({...menu,...fields}));
 assert.equal(normalizeMenuName(' 쇼유 라멘 '),normalizeMenuName('쇼유라멘'));
 assert.equal(validateNickname('면산책_01'),null);
 assert.ok(validateNickname('<script>'));
});

test('editing preserves review identity, creation date, moderation and review count', () => {
 const prior={...review,id:'original',createdAt:'2026-10-01',hidden:true};
 const result=upsertReview([prior],{...review,id:'new',date:'2026-10-17'},'u1');
 assert.equal(result.length,1);assert.equal(result[0].id,'original');assert.equal(result[0].createdAt,'2026-10-01');assert.equal(result[0].updatedAt,'2026-10-17');assert.equal(result[0].hidden,true);
});
