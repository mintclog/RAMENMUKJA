// All shops, menus and reviews are fictional demonstration data.
export const shops = [
  { id: 's1', name: '멘야 하루', area: '연남', address: '서울 마포구 연남동 · 가상 가게', lat: 37.5625, lng: 126.9235, description: '맑게 우린 닭 육수에 정성을 담는 작은 라멘집. 한 그릇을 천천히 즐겨보세요.' },
  { id: 's2', name: '라멘 온기', area: '합정', address: '서울 마포구 합정동 · 가상 가게', lat: 37.5495, lng: 126.914, description: '진한 돼지 육수와 가는 면의 조화. 따뜻하고 든든한 한 끼를 만듭니다.' },
  { id: 's3', name: '츠케멘 모리', area: '망원', address: '서울 마포구 망원동 · 가상 가게', lat: 37.555, lng: 126.903, description: '쫄깃한 굵은 면과 진한 찍먹 국물을 선보이는 츠케멘 전문점입니다.' },
  { id: 's4', name: '면의 계절', area: '연남', address: '서울 마포구 연남동 · 가상 가게', lat: 37.565, lng: 126.925, description: '계절의 재료와 매일의 정성을 한 그릇에 담습니다.' },
];

const photo = (id, width = 900) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=85`;
export const menus = [
  { id: 'm1', shopId: 's1', name: '특제 쇼유라멘', price: 12000, tags: ['쇼유', '닭 육수', '가는 면'], image: photo('photo-1569718212165-3a8278d5f624'), status: 'active', description: '맑고 깊은 닭 육수에 간장의 향을 더했어요. 부드러운 차슈와 반숙 계란이 함께 나옵니다.', taste: ['맑고 담백한', '보통 짠맛', '단단한 면'] },
  { id: 'm2', shopId: 's2', name: '쿠로 돈코츠라멘', price: 11500, tags: ['돈코츠', '돼지 육수', '가는 면'], image: photo('photo-1557872943-16a5ac26437e'), status: 'active', description: '오래 끓여낸 돼지 육수에 마늘 향을 입힌 한 그릇. 깊은 풍미와 가는 면을 함께 즐겨보세요.', taste: ['진하고 묵직한', '진한 간', '단단한 면'] },
  { id: 'm3', shopId: 's3', name: '특제 교카이 츠케멘', price: 14000, tags: ['츠케멘', '해산물', '굵은 면'], image: photo('photo-1617093727343-374698b1b08d'), status: 'active', description: '해산물의 감칠맛을 담은 진한 국물에 굵은 면을 찍어 먹는 츠케멘입니다.', taste: ['진하고 묵직한', '진한 간', '쫄깃한 면'] },
  { id: 'm4', shopId: 's4', name: '유자 시오라멘', price: 11000, tags: ['시오', '닭 육수', '가는 면'], image: photo('photo-1569718212165-3a8278d5f624'), status: 'active', description: '맑은 닭 육수에 은은한 유자 향이 퍼지는 담백한 시오라멘입니다.', taste: ['맑고 담백한', '은은한 간', '부드러운 면'] },
  { id: 'm5', shopId: 's2', name: '매콤 참깨 탄탄면', price: 12500, tags: ['탄탄면', '돼지 육수', '매콤한'], image: photo('photo-1557872943-16a5ac26437e'), status: 'active', description: '고소한 참깨와 매콤한 향신료가 어우러지는 따뜻한 탄탄면입니다.', taste: ['고소하고 진한', '매콤한', '쫄깃한 면'] },
  { id: 'm6', shopId: 's4', name: '차슈 아부라소바', price: 10500, tags: ['아부라소바', '국물 없는', '굵은 면'], image: photo('photo-1617093727343-374698b1b08d'), status: 'active', description: '차슈와 향미유를 면에 골고루 비벼 즐기는 국물 없는 한 그릇입니다.', taste: ['고소한 풍미', '보통 짠맛', '쫄깃한 면'] },
  { id: 'm7', shopId: 's1', name: '여름 한정 냉라멘', price: 12000, tags: ['시오', '한정 메뉴'], image: null, status: 'ended', description: '판매가 종료된 계절 한정 메뉴입니다.', taste: ['산뜻한'] },
];

const names = ['면을찾아서', '국물산책', '라멘일기', '한그릇더', '차슈좋아', '퇴근후라멘', '면식생활', '느린점심'];
const bodies = ['첫 입보다 마지막 한 입이 더 좋았어요. 면과 국물의 균형이 잘 맞는 한 그릇입니다.', '맛있게 먹었습니다. 다음에는 다른 메뉴도 먹어보고 싶어요.', '면 식감이 특히 기억에 남아요. 취향에 잘 맞았습니다.', '재료 하나하나가 잘 어우러져요. 차분하게 즐기기 좋았습니다.'];
const scores = [[4,4,3,4,4,3,4,5], [3,4,3,4,3,4], [4,5,4,4,3,4,4], [3,4,3], [3,4,3,3,4], []];
export const seedReviews = scores.flatMap((ratings, index) => ratings.map((rating, i) => ({
  id: `seed-${index}-${i}`, menuId: `m${index + 1}`, userId: `seed-user-${i}`, author: names[i], rating,
  body: rating === 5 ? '여러 라멘을 먹어봤지만 국물과 면이 이렇게 잘 어우러지는 한 그릇은 드물었어요. 오래 기억할 인생의 한 그릇입니다.' : bodies[i % bodies.length],
  date: `2026-10-${String(15 - i).padStart(2, '0')}`, disclosure: 'self',
  details: { ...(index === 5 ? {} : { broth: rating }), noodle: Math.min(5, rating + (i % 2)), topping: Math.max(1, rating - (i % 2)) },
  taste: { intensity: i % 2 ? '진해요' : '담백해요', saltiness: '적당해요', texture: '단단해요' }, photos: [],
})));
