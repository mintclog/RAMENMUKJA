export const ratingLabels = [
  '', '크게 아쉬웠어요', '아쉬운 부분이 있었어요',
  '맛있게 먹었어요. 좋은 라멘입니다',
  '멀리서 찾아가서라도 다시 먹고 싶어요',
  '지금까지 먹은 라멘 중 손에 꼽는, 내 인생의 한 그릇입니다',
];

export function searchRelevance(menu, shop, query) {
  const terms = query.trim().toLocaleLowerCase('ko-KR').split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  const fields = [[menu.name, 8], [shop.name, 5], [shop.area, 3], [menu.tags.join(' '), 1]];
  let score = 0;
  for (const term of terms) {
    const matches = fields.map(([value, weight]) => {
      const text = value.toLocaleLowerCase('ko-KR');
      return text === term ? weight * 2 : text.includes(term) ? weight : 0;
    });
    if (!matches.some(Boolean)) return 0;
    score += Math.max(...matches);
  }
  return score;
}

export function summarize(reviews) {
  const visible = reviews.filter(review => !review.hidden && Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5);
  const distribution = [1, 2, 3, 4, 5].map(score => visible.filter(review => review.rating === score).length);
  const average = visible.length ? visible.reduce((sum, review) => sum + review.rating, 0) / visible.length : null;
  return { count: visible.length, average, distribution };
}

export function combineStats(items) {
  const count = items.reduce((sum, item) => sum + item.count, 0);
  return { count, average: count ? items.reduce((sum, item) => sum + (item.average || 0) * item.count, 0) / count : null };
}

export function validateReview(review) {
  if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) return '별점을 선택해주세요.';
  if (review.rating === 5 && !review.body?.trim()) return '인생의 한 그릇이었던 이유를 남겨주세요.';
  if ((review.body || '').length > 2000) return '리뷰는 2,000자 이내로 작성해주세요.';
  if (!['self', 'sponsored'].includes(review.disclosure)) return '식사 제공·협찬 여부를 선택해주세요.';
  for (const key of ['broth', 'noodle', 'topping']) {
    const value = review.details?.[key];
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 5)) return '세부 평가는 1~5점으로 선택해주세요.';
  }
  return null;
}

export function upsertReview(reviews, review, userId) {
  if (!userId) throw new Error('체험 모드를 먼저 시작해주세요.');
  const error = validateReview(review);
  if (error) throw new Error(error);
  const next = { ...review, userId, hidden: false };
  return [...reviews.filter(item => !(item.menuId === review.menuId && item.userId === userId)), next];
}

export function deleteReview(reviews, id, userId) {
  const review = reviews.find(item => item.id === id);
  if (!review || !userId || review.userId !== userId) throw new Error('본인의 리뷰만 삭제할 수 있습니다.');
  return reviews.filter(item => item.id !== id);
}

export function distanceKm(lat1, lng1, lat2, lng2) {
  const radians = value => value * Math.PI / 180;
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
