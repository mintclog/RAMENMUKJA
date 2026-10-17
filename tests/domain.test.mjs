import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, validateReview, upsertReview, deleteReview, distanceKm, searchRelevance, combineStats } from '../src/domain.js';

const review = { id: 'r1', menuId: 'm1', userId: 'u1', rating: 3, body: '', disclosure: 'self', details: {} };

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
  assert.ok(validateReview({ ...review, disclosure: null }));
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
