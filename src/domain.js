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

export function findShops(shops, query = '') {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
  const terms = String(query).trim().split(/\s+/).map(normalize).filter(Boolean);
  return shops.filter(shop => terms.every(term => [shop.name, shop.area, shop.address].some(value => normalize(value).includes(term))));
}

export function summarize(reviews) {
  const visible = reviews.filter(review => !review.hidden && !review.draft && !review.privacyPending && Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5);
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
  if (review.options != null && (typeof review.options !== 'string' || review.options.length > 300)) return '주문 옵션은 300자 이내로 입력해주세요.';
  if (review.details != null && (typeof review.details !== 'object' || Array.isArray(review.details))) return '세부 평가를 확인해주세요.';
  if (Object.keys(review.details || {}).some(key => !['broth', 'noodle', 'topping'].includes(key))) return '세부 평가를 확인해주세요.';
  for (const key of ['broth', 'noodle', 'topping']) {
    const value = review.details?.[key];
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 5)) return '세부 평가는 1~5점으로 선택해주세요.';
  }
  return null;
}

export function optionTags(value = '') {
  // Hashtags delimit new records; commas also support the previous free-text format.
  return [...new Set(String(value).split(/[#＃,，\n]+/).map(tag => tag.trim()).filter(Boolean))];
}

export function serializeOptions(tags) {
  return optionTags(tags.join(' #')).map(tag => '#' + tag).join(' ');
}

export function upsertReview(reviews, review, userId) {
  if (!userId) throw new Error('체험 모드를 먼저 시작해주세요.');
  const error = validateReview(review);
  if (error) throw new Error(error);
  const prior = reviews.find(item => item.menuId === review.menuId && item.userId === userId);
  const next = { ...review, id: prior?.id || review.id, userId, hidden: prior?.hidden || false, createdAt: prior?.createdAt || prior?.date || review.date, updatedAt: review.date, edited: Boolean(prior), likes: prior?.likes || 0 };
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

export const genres = ['돈코츠', '시오', '쇼유', '미소', '탄탄면', '아부라소바', '츠케멘', '기타'];

export function normalizeMenuName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
}

export function validateMenu(menu) {
  if (typeof menu.name !== 'string' || !menu.name.trim() || menu.name.trim().length > 100) return '메뉴 이름을 100자 이내로 입력해주세요.';
  if (!Number.isInteger(menu.price) || menu.price < 0 || menu.price > 10000000) return '가격을 0~10,000,000원 사이의 정수로 입력해주세요.';
  if (!genres.includes(menu.genre)) return '장르를 선택해주세요.';
  if (!Array.isArray(menu.photos) || !menu.photos.length || menu.photos.length > 5) return '새 메뉴에는 사진을 1~5장 첨부해주세요.';
  return null;
}

export function representativePhoto(reviews) {
  const candidates = reviews.filter(r => !r.hidden && !r.draft && !r.privacyPending && r.photos?.length);
  // Stable fallback while likes are tied: older review, then its first photo.
  candidates.sort((a, b) => (b.likes || 0) - (a.likes || 0) || String(a.createdAt || a.date).localeCompare(String(b.createdAt || b.date)) || String(a.id).localeCompare(String(b.id)));
  return candidates[0]?.photos[0] || '';
}

export function validateNickname(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_ -]{2,20}$/u.test(value.trim()) ? null : '닉네임은 글자·숫자·공백·밑줄·하이픈으로 2~20자 입력해주세요.';
}

export function generatedNickname() {
  return '라멘산책_' + crypto.randomUUID().slice(0, 8);
}
