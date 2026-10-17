import { shops as demoShops, menus as demoMenus, seedReviews as demoReviews } from './data.js';
import { legalDocuments as demoLegalDocuments, legalSources } from './legal.js';
import { createLiveLegal } from './live-legal.js';
import { request } from './service.js';
import { summarize, ratingLabels, validateReview, upsertReview, deleteReview, distanceKm, searchRelevance, combineStats } from './domain.js';

const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const toast = document.querySelector('#toast');
const storageKey = 'ramenmukja-demo-v1';
let shops = demoShops, menus = demoMenus, seedReviews = demoReviews;
let serviceMode = 'loading';
let legalDocuments = demoLegalDocuments;
let launchReady = false;
let user = null;
let remoteStats = new Map();
// shortcut: browser-only identity; replace with server sessions before multi-user operation.
const demoId = 'local-demo-user';
let state = { active: false, saved: [], reviews: [], reports: [], requests: [] };
let storageWarning = '';
let storageSnapshot = null;
try {
  storageSnapshot = localStorage.getItem(storageKey);
  const loaded = JSON.parse(storageSnapshot || 'null');
  if (loaded) {
    if (!Array.isArray(loaded.saved) || !Array.isArray(loaded.reviews) || !Array.isArray(loaded.reports) || !Array.isArray(loaded.requests)) throw new Error();
    const validReviews = loaded.reviews.filter(review => review && review.userId === demoId
      && typeof review.id === 'string' && typeof review.author === 'string'
      && typeof review.body === 'string' && typeof review.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(review.date)
      && Array.isArray(review.photos) && review.photos.length <= 5
      && menus.some(menu => menu.id === review.menuId) && !validateReview(review));
    state = { active: loaded.active === true, saved: loaded.saved.filter(id => menus.some(menu => menu.id === id)), reviews: validReviews, reports: loaded.reports, requests: loaded.requests };
  }
} catch { storageWarning = '브라우저 저장 데이터를 읽지 못했어요. 새 기록은 저장 시 다시 확인합니다.'; }

let coords = null;
let locationMessage = '';
let photoDraft = [];
let toastTimer;
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  tune: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  bowl: '<path d="M3 11h18c-1 7-4 10-9 10S4 18 3 11ZM8 23h8M8 7c-3-3 3-3 0-6M13 7c-3-3 3-3 0-6M18 7c-3-3 3-3 0-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.bowl}</svg>`;
const shopOf = menu => shops.find(shop => shop.id === menu.shopId);
const reviewsFor = id => [...seedReviews, ...state.reviews].filter(review => review.menuId === id && !review.hidden);
const statsFor = id => serviceMode === 'live' ? remoteStats.get(id) || summarize([]) : summarize(reviewsFor(id));
const score = value => value == null ? '—' : value.toFixed(1);
const price = value => `${value.toLocaleString('ko-KR')}원`;
const ownReview = id => state.reviews.find(review => review.menuId === id && review.userId === (user?.id || demoId));
const distanceTo = shop => coords && Number.isFinite(shop.lat) && Number.isFinite(shop.lng) ? distanceKm(coords.latitude, coords.longitude, shop.lat, shop.lng) : Infinity;
const photoSrc = value => typeof value === 'string' && (/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(value) || /^\/api\/photos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(value)) ? value : '';

async function refreshService() {
  const data = await request('bootstrap');
  shops = data.shops; menus = data.menus; seedReviews = [];
  user = data.user;
  remoteStats = new Map(data.stats.map(s => [s.menu_id, s]));
  state = { active: Boolean(user), saved: data.saved, reviews: data.reviews, reports: [], requests: [] };
}

async function start() {
  try {
    const status = await request('status');
    serviceMode = status.mode;
    launchReady = status.launchReady;
    if (serviceMode === 'live') legalDocuments = createLiveLegal(status.operator);
    if (serviceMode === 'unconfigured') throw new Error('운영 서비스 연결을 준비하고 있습니다. 잠시 후 다시 방문해주세요.');
    if (serviceMode === 'live') await refreshService();
    await render();
    if (storageWarning && serviceMode === 'demo') notify(storageWarning);
  } catch (error) {
    serviceMode = 'unavailable';
    shell(empty('서비스에 연결하지 못했어요', e(error.message), '/', '다시 시도'), 'none');
  }
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

function persist(next) {
  if (serviceMode !== 'demo') return false;
  try {
    if (localStorage.getItem(storageKey) !== storageSnapshot) {
      notify('다른 탭에서 기록이 바뀌었어요. 작성 내용을 보관한 뒤 새로고침해주세요.');
      return false;
    }
    const serialized = JSON.stringify(next);
    localStorage.setItem(storageKey, serialized);
    storageSnapshot = serialized;
    state = next;
    return true;
  } catch {
    notify('저장 공간을 사용할 수 없어요. 사진을 줄이거나 브라우저 설정을 확인해주세요.');
    return false;
  }
}

function navigate(url, replace = false) {
  if (modal.open) modal.close();
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.querySelector('#main')?.focus({ preventScroll: true });
}

function showModal(content) {
  modal.className = '';
  modal.innerHTML = `<button class="icon-button close-modal" data-action="close-modal" aria-label="닫기">${icon('close')}</button>${content}`;
  modal.showModal();
}

function requireDemo(returnTo = location.pathname + location.search) {
  if (state.active) return true;
  navigate(`/login?next=${encodeURIComponent(returnTo)}`);
  return false;
}

function ratingGuide() {
  showModal(`<span class="eyebrow">OUR RATING PROMISE</span><h2 id="modal-title">3점도 좋은 한 그릇입니다.</h2><p class="muted">점수보다 솔직한 취향이 모일 때, 믿을 수 있는 기록이 됩니다.</p><div class="guide-list">${ratingLabels.slice(1).map((label, i) => `<div><strong>${i + 1}<span>점</span></strong><p>${label}</p></div>`).join('')}</div><p class="note">5점에는 특별했던 이유를 함께 남겨주세요. 횟수 제한이나 숨겨진 점수 보정은 없습니다.</p>`);
}

function shell(content, active = 'explore') {
  const nav = (url, name, key) => `<a class="nav-link ${active === key ? 'active' : ''}" href="${url}" ${active === key ? 'aria-current="page"' : ''}>${name}</a>`;
  app.innerHTML = `${serviceMode === 'demo' ? '<div class="demo-banner">체험판 · 가게·메뉴·리뷰는 가상 데이터이며 기록은 이 브라우저에만 저장됩니다.</div>' : ''}
    <header class="site-header"><div class="header-inner"><a class="brand" href="/" aria-label="라멘묵자 홈">${icon('bowl')}<span>라멘묵자<span class="brand-dot">.</span></span></a>
    <nav class="desktop-nav" aria-label="주 메뉴">${nav('/explore', '라멘 탐색', 'explore')}${nav('/saved', '저장한 한 그릇', 'saved')}<button class="text-button" data-action="guide">별점 가이드</button></nav>
    <a class="account-link" href="${state.active ? '/me' : '/login'}">${icon('user')}<span>${state.active ? '내 기록' : serviceMode === 'live' ? '로그인' : '체험 시작'}</span></a></div></header>
    <main id="main" tabindex="-1" class="container">${content}</main>
    <footer class="site-footer"><div class="container footer-inner"><a href="/" class="brand small">${icon('bowl')}라멘묵자.</a><p>먹어본 한 그릇, 다음에 먹을 한 그릇.</p><div><button class="text-button" data-action="guide">별점 기준</button><button class="text-button" data-action="request">가게·메뉴 등록 요청</button>${user?.admin ? '<a class="text-button" href="/admin">운영 관리</a>' : ''}</div><nav class="footer-legal" aria-label="이용 안내"><a href="/terms">이용약관</a><a href="/privacy"><strong>개인정보처리방침</strong></a><a href="/community">리뷰 운영정책</a></nav><small>© 2026 RAMENMUKJA${serviceMode === 'demo' ? ' · LOCAL DEMO' : ''}</small></div></footer>
    <nav class="mobile-nav" aria-label="모바일 주 메뉴"><a href="/explore" ${active === 'explore' ? 'aria-current="page"' : ''}>${icon('search')}탐색</a><a href="/saved" ${active === 'saved' ? 'aria-current="page"' : ''}>${icon('bookmark')}저장</a><a href="/me" ${active === 'me' ? 'aria-current="page"' : ''}>${icon('user')}내 기록</a></nav>`;
  app.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.hidden = true; img.parentElement.classList.add('image-unavailable'); }, { once: true }));
}

function image(menu, cls = '') {
  return `<div class="food-image ${cls} ${menu.image ? '' : 'image-unavailable'}">${menu.image ? `<img src="${e(menu.image)}" alt="${e(menu.name)} ${serviceMode === 'demo' ? '분위기를 보여주는 참고 사진' : '메뉴 사진'}" loading="lazy">` : ''}<span class="image-placeholder">${icon('bowl')}사진 준비 중</span></div>`;
}

function card(menu) {
  const shop = shopOf(menu), stats = statsFor(menu.id);
  const saved = state.saved.includes(menu.id);
  const distance = Number.isFinite(distanceTo(shop)) ? ' · ' + distanceTo(shop).toFixed(1) + 'km' : '';
  return `<article class="menu-card"><div class="card-photo"><a href="/menus/${menu.id}" tabindex="-1" aria-hidden="true">${image(menu)}</a><span class="photo-label">${menu.status === 'ended' ? '판매 종료' : e(menu.tags[0])}</span><button class="save-button ${saved ? 'is-saved' : ''}" data-action="save" data-id="${menu.id}" aria-label="${e(menu.name)} ${saved ? '저장 취소' : '저장'}" aria-pressed="${saved}">${icon('bookmark')}</button></div><div class="card-body"><h3><a href="/menus/${menu.id}">${e(menu.name)}</a></h3><p class="shop-line">${shopLink(shop)} <span>· ${e(shop.area)}${distance}</span></p><div class="card-rating"><strong class="card-score"><span aria-hidden="true">★</span> ${score(stats.average)}</strong><span>${stats.count ? '평가 ' + stats.count + '명' : '아직 평가가 없어요'}</span>${stats.count > 0 && stats.count < 5 ? '<span class="low-count">평가가 적어요</span>' : ''}</div><div class="tags">${menu.tags.map(tag => '<span>' + e(tag) + '</span>').join('')}</div><div class="card-meta"><span>메뉴 가격</span><strong>${price(menu.price)}</strong></div></div></article>`;
}

function shopLink(shop) {
  return `<a class="shop-name" href="/shops/${e(shop.id)}">${e(shop.name)}</a>`;
}

function legalPage(key) {
  const doc = legalDocuments[key];
  document.title = `${doc.title} — 라멘묵자`;
  shell(`<div class="legal-layout"><aside class="legal-sidebar"><span class="eyebrow">이용 안내</span><nav aria-label="정책 문서">${Object.entries(legalDocuments).map(([id, item]) => `<a href="/${id}" ${id === key ? 'aria-current="page"' : ''}>${e(item.title)}</a>`).join('')}</nav></aside><article class="legal-document"><header><span class="eyebrow">RAMENMUKJA / ${e(key.toUpperCase())}</span><h1>${e(doc.title)}</h1><p>${e(doc.summary)}</p><span class="muted small-text">작성·적용일 2026.10.16 · ${serviceMode === 'live' ? '운영 서비스' : '로컬 체험판'} v1.0</span></header>${serviceMode === 'demo' ? '<p class="note"><strong>현재 체험판 기준의 문서입니다.</strong> 운영 전 운영자 정보와 실제 데이터 처리 환경을 확정해야 합니다.</p>' : !launchReady ? '<p class="note">운영 정보와 개인정보 안내를 준비 중이며 신규 로그인은 아직 열리지 않았습니다.</p>' : ''}<nav class="legal-toc" aria-label="문서 목차">${doc.sections.map(([title], i) => `<a href="#policy-${i + 1}">${String(i + 1).padStart(2, '0')}. ${e(title)}</a>`).join('')}</nav>${doc.sections.map(([title, body], i) => `<section id="policy-${i + 1}"><h2><span>${String(i + 1).padStart(2, '0')}</span> ${e(title)}</h2><p>${e(body)}</p></section>`).join('')}<details class="legal-sources"><summary>작성 기준과 공식 참고 자료</summary><p>2026년 10월 16일 확인. 판매·결제가 없는 리뷰 서비스의 기능에 맞춰 작성했습니다.</p><ul>${legalSources.map(([title, url]) => `<li><a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(title)} ↗</a></li>`).join('')}</ul></details></article></div>`, 'legal');
}

function reviewCard(review, showMenu = false) {
  const menu = menus.find(item => item.id === review.menuId);
  const own = state.active && review.userId === (user?.id || demoId);
  return `<article class="review-card"><div class="review-top"><span class="avatar">${e(review.author?.slice(0, 1) || '나')}</span><div><strong>${e(review.author || '나의 기록')}</strong><span class="review-date">${e(review.date)} · ${review.disclosure === 'sponsored' ? '식사 제공·협찬' : '직접 결제'}</span></div><span class="review-score" aria-label="${review.rating}점">★ ${review.rating}.0</span></div>
    ${showMenu ? `<a class="review-menu" href="/menus/${menu.id}">${e(menu.name)} ${icon('arrow')}</a>` : ''}<p class="review-body">${e(review.body || '별점으로 남긴 한 그릇의 기록입니다.')}</p>
    ${review.photos?.length ? `<div class="review-photos">${review.photos.filter(photoSrc).map(src => `<button class="photo-button" data-action="photo" data-review="${e(review.id)}" data-index="${review.photos.indexOf(src)}"><img src="${src}" alt="리뷰 음식 사진" loading="lazy"></button>`).join('')}</div>` : ''}
    ${review.taste ? `<div class="tags">${Object.values(review.taste).filter(Boolean).map(tag => `<span>${e(tag)}</span>`).join('')}</div>` : ''}
    ${review.hidden && own ? `<p class="note">운영 검토로 공개가 중단된 리뷰입니다. 사유: ${e(review.moderationReason || '운영자에게 문의해주세요')}</p>` : ''}<div class="review-actions">${own ? `<a href="/menus/${menu.id}/review">수정</a><button data-action="delete" data-id="${e(review.id)}">삭제</button>` : `<button data-action="report" data-id="${e(review.id)}">신고</button>`}</div></article>`;
}

function empty(title, text, link = '/explore', label = '라멘 둘러보기') {
  return `<div class="empty-state">${icon('bowl')}<h2>${title}</h2><p>${text}</p><a class="button primary" href="${link}">${label}${icon('arrow')}</a></div>`;
}

function home() {
  const selected = menus.filter(menu => menu.status === 'active').slice(0, 3);
  shell(`<section class="home-search"><span class="eyebrow">라멘묵자 · 취향으로 찾는 한 그릇</span><h1>오늘은 어떤 한 그릇?</h1><p class="muted">먹고 싶은 메뉴를 찾고, 먹어본 취향을 남겨보세요.</p><form class="search-box" id="search-form">${icon('search')}<input name="q" aria-label="지역, 가게 또는 메뉴 검색" placeholder="지역, 가게, 메뉴를 검색하세요" autocomplete="off"><button type="submit" aria-label="검색">${icon('arrow')}</button></form></section><section class="browse-section" aria-label="지역과 장르 탐색"><div class="category-list"><button class="category near" data-action="locate">${icon('pin')}<span>내 근처</span></button>${['돈코츠','시오','쇼유','탄탄면','아부라소바','츠케멘'].map(tag => '<a class="category" href="/explore?tag=' + encodeURIComponent(tag) + '">' + tag + '</a>').join('')}</div><div class="home-areas"><span>지역으로 찾기</span>${[...new Set(shops.map(shop => shop.area))].map(area => '<a href="/explore?area=' + encodeURIComponent(area) + '">' + e(area) + ' ' + icon('arrow') + '</a>').join('')}</div></section><section><div class="section-heading"><div><h2>${serviceMode === 'demo' ? '마포에서 만나는 한 그릇' : '살펴볼 메뉴'}</h2><p>${serviceMode === 'demo' ? '연남·합정·망원의 체험용 메뉴입니다.' : '평가와 취향을 함께 비교해보세요.'}</p></div><a class="subtle-link" href="/explore">전체 메뉴 ${icon('arrow')}</a></div>${selected.length ? `<div class="menu-grid">${selected.map(card).join('')}</div>` : empty('첫 메뉴를 준비하고 있어요', '가게와 메뉴 정보가 등록되면 여기에서 만날 수 있어요.')}</section><section class="taste-browse"><div class="section-heading"><h2>국물 취향으로 고르기</h2></div><div class="taste-links"><a href="/explore?tag=닭%20육수"><strong>맑고 담백하게</strong><span>닭 육수 메뉴 보기 ${icon('arrow')}</span></a><a href="/explore?tag=돼지%20육수"><strong>진하고 묵직하게</strong><span>돼지 육수 메뉴 보기 ${icon('arrow')}</span></a><a href="/explore?tag=국물%20없는"><strong>국물 없이 고소하게</strong><span>아부라소바 메뉴 보기 ${icon('arrow')}</span></a></div></section><section><div class="section-heading"><h2>최근 남긴 한 그릇의 기록</h2></div><div class="recent-grid">${[...seedReviews, ...state.reviews].filter(review => !review.hidden).sort((a,b) => b.date.localeCompare(a.date)).slice(0,3).map(review => reviewCard(review, true)).join('')}</div></section><section class="rating-promise"><span class="promise-mark">3<span>/ 5</span></span><div><h2>3점도 좋은 라멘입니다.</h2><p>5점은 특별한 한 그릇에. 솔직한 이유를 함께 남겨요.</p></div><button class="button outline" data-action="guide">별점 기준 ${icon('arrow')}</button></section>`);
}

function filteredMenus(params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const tag = params.get('tag') || '';
  const area = params.get('area') || '';
  const sort = params.get('sort') || 'relevant';
  const minimum = params.get('min') === '1' || (sort === 'rating' && !params.has('min'));
  const result = menus.filter(menu => {
    const shop = shopOf(menu);
    return menu.status === 'active' && (!q || searchRelevance(menu, shop, q) > 0) && (!tag || menu.tags.includes(tag)) && (!area || shop.area === area) && (!minimum || statsFor(menu.id).count >= 5);
  });
  return result.sort((a, b) => {
    if (sort === 'rating') return (statsFor(b.id).average ?? -1) - (statsFor(a.id).average ?? -1);
    if (sort === 'count') return statsFor(b.id).count - statsFor(a.id).count;
    if (sort === 'distance' && coords) {
      const sa = shopOf(a), sb = shopOf(b);
      return (distanceTo(sa) - distanceTo(sb)) || 0;
    }
    return searchRelevance(b, shopOf(b), q) - searchRelevance(a, shopOf(a), q);
  });
}

function explore() {
  const p = new URLSearchParams(location.search);
  if (p.get('sort') === 'distance' && !coords) { p.delete('sort'); history.replaceState({}, '', `/explore?${p}`); }
  if (p.get('sort') === 'rating' && !p.has('min')) { p.set('min', '1'); history.replaceState({}, '', '/explore?' + p); }
  const result = filteredMenus(p);
  const tags = ['', '돈코츠','시오','쇼유','탄탄면','아부라소바','츠케멘'];
  shell(`<section class="page-intro"><span class="eyebrow">FOLLOW YOUR TASTE</span><h1>나의 다음 한 그릇</h1><p>오늘 당기는 맛을 따라, 천천히 골라보세요.</p></section>
    <form class="search-box explore-search" id="search-form">${icon('search')}<input name="q" aria-label="지역, 가게 또는 메뉴 검색" value="${e(p.get('q') || '')}" placeholder="지역, 가게, 메뉴를 검색해보세요"><button type="submit" aria-label="검색">${icon('arrow')}</button></form>
    <div class="explore-filters"><div class="chip-row">${tags.map(tag => `<button class="chip ${tag === (p.get('tag') || '') ? 'selected' : ''}" data-action="tag" data-tag="${tag}" aria-pressed="${tag === (p.get('tag') || '')}">${tag || '모든 라멘'}</button>`).join('')}</div><button class="button outline filter-button" data-action="filter">${icon('tune')} 필터${p.get('area') ? ` · ${e(p.get('area'))}` : ''}</button></div>
    <div class="result-toolbar"><span><strong>${result.length}</strong>개의 한 그릇 ${serviceMode === 'demo' ? '<span class="muted">· 가상 데이터</span>' : ''}</span><div class="toolbar-controls"><button class="text-button" data-action="locate">${icon('pin')}${coords ? '위치 갱신' : '내 위치'}</button><label class="sr-only" for="sort">정렬</label><select id="sort"><option value="relevant">검색 관련도순</option><option value="count" ${p.get('sort') === 'count' ? 'selected' : ''}>평가 많은 순</option><option value="rating" ${p.get('sort') === 'rating' ? 'selected' : ''}>평점순</option>${coords ? `<option value="distance" ${p.get('sort') === 'distance' ? 'selected' : ''}>거리순</option>` : ''}</select><button class="text-button" data-action="map">${icon('pin')} 지도 안내</button></div></div>
    ${p.get('sort') === 'rating' ? `<label class="minimum"><input id="minimum" type="checkbox" ${p.get('min') === '1' ? 'checked' : ''}> 평가 5개 이상인 메뉴만 보기</label>` : ''}${locationMessage ? `<p role="status" class="note">${e(locationMessage)}</p>` : ''}
    ${result.length ? `<div class="menu-grid">${result.map(card).join('')}</div>` : empty('아직 찾지 못한 한 그릇', '검색어나 필터를 조금 바꿔보세요.', '/explore', '필터 초기화')}`);
}

function distribution(stats) {
  return `<div class="distribution" aria-label="별점 분포">${[5,4,3,2,1].map(n => `<div class="distribution-row"><span>${n}점</span><meter min="0" max="${Math.max(stats.count, 1)}" value="${stats.distribution[n - 1]}" aria-label="${n}점 ${stats.distribution[n - 1]}명"></meter><span>${stats.distribution[n - 1]}</span></div>`).join('')}</div>`;
}

function menuDetail(menu) {
  const shop = shopOf(menu), stats = statsFor(menu.id), reviews = reviewsFor(menu.id);
  const own = ownReview(menu.id);
  const details = [['broth','국물'],['noodle','면'],['topping','고명']].filter(([key]) => key !== 'broth' || !menu.tags.includes('아부라소바')).map(([key, label]) => {
    const values = reviews.map(review => review.details?.[key]).filter(value => Number.isInteger(value));
    if (serviceMode === 'live') return `<div><span>${label}</span><strong>${score(stats.details?.[key])}</strong><small>${stats.detail_counts?.[key] || 0}명 응답</small></div>`;
    return `<div><span>${label}</span><strong>${values.length ? score(values.reduce((a,b) => a+b,0) / values.length) : '—'}</strong><small>${values.length}명 응답</small></div>`;
  }).join('');
  shell(`<nav class="breadcrumb" aria-label="현재 위치"><a href="/explore">라멘 탐색</a><span>/</span><a href="/shops/${shop.id}">${e(shop.name)}</a><span>/</span><span>${e(menu.name)}</span></nav>
    <section class="menu-detail-top">${menu.image ? `<button class="menu-photo-button" data-action="menu-photo" data-id="${menu.id}" aria-label="${e(menu.name)} 참고 사진 원본 비율로 보기">${image(menu, 'detail-image')}<span>사진 크게 보기 ${icon('search')}</span></button>` : image(menu, 'detail-image')}<div class="menu-description"><span class="eyebrow">${menu.status === 'ended' ? '판매 종료 메뉴' : 'ONE BOWL, ONE STORY'}</span><a class="shop-detail-link shop-name" href="/shops/${shop.id}">${e(shop.name)} · ${e(shop.area)} ${icon('arrow')}</a><h1>${e(menu.name)}</h1><div class="tags">${menu.tags.map(tag => `<a href="/explore?tag=${encodeURIComponent(tag)}">${e(tag)}</a>`).join('')}</div><p>${e(menu.description)}</p><strong class="detail-price">${price(menu.price)}</strong>${serviceMode === 'demo' ? '<p class="small-text muted">가상 메뉴 · 사진은 메뉴와 다른 참고 이미지입니다.</p>' : ''}<div class="detail-buttons"><a class="button primary" href="/menus/${menu.id}/review">${own ? '내 리뷰 수정하기' : '이 한 그릇 기록하기'} ${icon('arrow')}</a><button class="button outline" data-action="save" data-id="${menu.id}" aria-pressed="${state.saved.includes(menu.id)}">${icon('bookmark')}${state.saved.includes(menu.id) ? '저장됨' : '저장'}</button></div></div></section>
    <div class="detail-layout"><section><div class="section-heading"><h2>한 그릇의 평가 <span class="muted">${stats.count}</span></h2><button class="text-button" data-action="guide">별점 기준 ${icon('arrow')}</button></div><div class="rating-panel"><div class="rating-total"><strong>${score(stats.average)}</strong><span>/ 5</span><p>${stats.count ? `${stats.count}명의 솔직한 기록` : '아직 평가가 없어요'}</p>${stats.count > 0 && stats.count < 5 ? '<small class="low-count">평가가 적어요</small>' : ''}</div>${distribution(stats)}</div><div class="detail-scores">${details}</div><h2 class="reviews-title">한 줄에 담긴 진심</h2>${serviceMode === 'live' ? '<p class="muted small-text">최근 공개 리뷰 최대 100개를 표시합니다. 평균과 분포는 전체 공개 리뷰 기준입니다.</p>' : ''}${reviews.length ? reviews.slice().sort((a,b) => b.date.localeCompare(a.date)).map(review => reviewCard(review)).join('') : empty('첫 기록을 기다리고 있어요', '나만의 솔직한 한 그릇을 남겨주세요.', `/menus/${menu.id}/review`, '리뷰 작성하기')}</section><aside class="detail-sidebar"><span class="eyebrow">TASTE NOTES</span><h3>이 한 그릇의 성격</h3>${menu.taste.map(taste => `<p>${icon('check')} ${e(taste)}</p>`).join('')}${serviceMode === 'demo' ? '<small class="muted">메뉴 소개용 샘플 정보입니다.</small>' : ''}<hr><strong>3점도 좋은 라멘입니다.</strong><p class="muted">완벽한 점수보다,<br>당신의 솔직한 취향을 들려주세요.</p><button class="text-button" data-action="guide">별점 가이드 읽기 ${icon('arrow')}</button></aside></div>`);
}

function shopDetail(shop) {
  const active = menus.filter(menu => menu.shopId === shop.id && menu.status === 'active');
  const ended = menus.filter(menu => menu.shopId === shop.id && menu.status === 'ended');
  const stats = serviceMode === 'live' ? combineStats(active.map(menu => statsFor(menu.id))) : summarize(active.flatMap(menu => reviewsFor(menu.id)));
  shell(`<nav class="breadcrumb"><a href="/explore">라멘 탐색</a><span>/</span>${e(shop.name)}</nav><section class="shop-intro"><span class="eyebrow">RAMEN SPOT · ${e(shop.area)}</span><h1 class="shop-title">${e(shop.name)}</h1><p>${e(shop.description)}</p><p class="muted">${icon('pin')} ${e(shop.address)}</p><div class="tags">${[...new Set(active.flatMap(menu => menu.tags))].map(tag => `<a href="/explore?tag=${encodeURIComponent(tag)}">${e(tag)}</a>`).join('')}</div>${serviceMode === 'demo' ? '<p class="note">체험용 가상 가게입니다. 실제 영업 정보나 길찾기를 제공하지 않습니다.</p>' : `<p class="muted">${e(shop.hours || '영업시간 미등록')}</p>${/^https:\/\//.test(shop.source_url || '') ? `<a class="text-button" href="${e(shop.source_url)}" target="_blank" rel="noopener noreferrer">공식 정보 출처 ↗</a>` : ''}`}</section><div class="section-heading"><h2>판매 중인 한 그릇</h2></div><div class="menu-grid">${active.map(card).join('')}</div><section class="shop-total"><h2>판매 중인 메뉴 종합</h2><p><strong>${score(stats.average)}</strong> · 평가 ${stats.count}명</p><p class="muted">판매 중인 메뉴의 공개 리뷰를 합산한 평균입니다. 메뉴별 평균의 단순 평균이 아닙니다.</p></section>${ended.length ? `<details class="ended-menus"><summary>판매 종료 메뉴 ${ended.length}개 보기</summary><div class="menu-grid">${ended.map(card).join('')}</div></details>` : ''}`);
}

function login() {
  if (serviceMode === 'live') return shell(`<section class="login-panel"><span class="eyebrow">나의 라멘 기록</span><h1>먹어본 한 그릇을<br>기록해보세요.</h1><p class="muted">카카오 계정으로 로그인하면 저장한 메뉴와 리뷰를 다른 기기에서도 볼 수 있어요.</p><p class="login-policies"><a href="/terms">이용약관</a>, <a href="/privacy">개인정보처리방침</a>, <a href="/community">리뷰 운영정책</a>을 확인해주세요.</p><label class="consent"><input id="accept-terms" type="checkbox"> 이용약관을 확인하고 동의합니다.</label><label class="consent"><input id="confirm-age" type="checkbox"> 만 14세 이상입니다.</label>${!launchReady ? '<p class="note">운영 정보를 준비 중입니다. 신규 로그인은 아직 열리지 않았습니다.</p>' : ''}<button class="button primary full" data-action="start-login" ${!launchReady ? 'disabled' : ''}>카카오로 로그인</button><a class="subtle-link" href="/explore">먼저 둘러보기</a></section>`, 'me');
  shell(`<section class="login-panel"><div class="login-symbol">${icon('bowl')}</div><span class="eyebrow">YOUR RAMEN JOURNAL</span><h1>나만의 한 그릇을<br>기록해보세요.</h1><p class="muted">먹고 싶은 라멘을 저장하고,<br>솔직한 취향을 한 줄씩 남겨보세요.</p><div class="note"><strong>현재는 로컬 체험 모드입니다.</strong><p>실제 회원가입이나 소셜 로그인이 아닙니다. 리뷰와 저장 목록은 이 브라우저에만 보관되며 다른 기기와 공유되지 않습니다.</p></div><p class="login-policies">시작 전에 <a href="/terms">이용약관</a>과 <a href="/privacy">개인정보처리방침</a>, <a href="/community">리뷰 운영정책</a>을 확인해주세요.</p><button class="button primary full" data-action="start-demo">브라우저 체험 시작하기 ${icon('arrow')}</button><a class="subtle-link" href="/explore">먼저 둘러볼게요</a></section>`, 'me');
}

async function adminPage() {
  if (serviceMode !== 'live') return shell(empty('운영 관리 연결이 필요합니다', '실서비스 연결 후 관리자 계정으로 이용할 수 있습니다.'));
  if (!user) { navigate('/login?next=%2Fadmin', true); return; }
  if (!user.admin) return shell(empty('접근 권한이 없습니다', '운영 관리자만 이용할 수 있습니다.'));
  try {
    const data = await request('admin');
    if (location.pathname !== '/admin') return;
    const queue = (items, type) => items.map(item => `<article class="admin-item"><strong>${e(item.name || item.review_id)}</strong><p>${e(item.note || item.reason)}</p><span class="muted">${e(item.status)}</span>${item.status === 'pending' ? `<button class="button outline" data-action="admin-resolve" data-type="${type}" data-id="${e(item.id)}">처리 완료</button>` : ''}</article>`).join('') || '<p class="muted">접수된 항목이 없습니다.</p>';
    shell(`<section class="page-intro"><h1>운영 관리</h1><p>신고만으로 리뷰를 자동 숨기지 않습니다. 내용을 검토하고 조치해주세요.</p></section><section><h2>신고 접수 · 최근 100개</h2>${queue(data.reports, 'report')}</section><section><h2>가게·메뉴 등록 요청 · 최근 100개</h2>${queue(data.requests, 'request')}</section><section><h2>리뷰 검토 · 최근 100개</h2>${data.reviews.map(r => `<article class="admin-item"><a class="shop-name" href="/menus/${e(r.menuId)}">메뉴 확인</a><p>${e(r.body || '본문 없음')} · ${r.rating}점</p><label class="field-label" for="reason-${e(r.id)}">조치 사유</label><input id="reason-${e(r.id)}" maxlength="1000" aria-label="조치 사유"><button class="button outline" data-action="admin-review" data-id="${e(r.id)}" data-hidden="${!r.hidden}">${r.hidden ? '다시 공개' : '숨김 처리'}</button></article>`).join('') || '<p>리뷰가 없습니다.</p>'}</section><section><h2>메뉴 판매 상태</h2>${menus.map(menu => `<article class="admin-item"><strong>${e(menu.name)}</strong> · ${e(shopOf(menu).name)}<button class="button outline" data-action="menu-status" data-id="${e(menu.id)}" data-status="${menu.status === 'active' ? 'ended' : 'active'}">${menu.status === 'active' ? '판매 종료로 변경' : '판매 재개'}</button></article>`).join('')}</section><section class="admin-forms"><form id="admin-shop-form"><h2>가게 등록</h2>${[['name','가게명'],['area','지역'],['address','주소'],['lat','위도'],['lng','경도'],['hours','영업시간'],['source_url','정보 출처 URL'],['description','소개']].map(([name,label]) => `<label class="field-label" for="shop-${name}">${label}</label><input id="shop-${name}" name="${name}" ${['name','area','address'].includes(name) ? 'required' : ''} ${['lat','lng'].includes(name) ? 'type="number" step="any"' : name === 'source_url' ? 'type="url"' : ''} maxlength="2000">`).join('')}<button type="submit" class="button primary">가게 등록</button></form><form id="admin-menu-form"><h2>메뉴 등록</h2><label class="field-label" for="menu-shop">소속 가게</label><select id="menu-shop" name="shop_id" required><option value="">가게 선택</option>${shops.map(shop => `<option value="${e(shop.id)}">${e(shop.name)} · ${e(shop.area)}</option>`).join('')}</select>${[['name','메뉴명'],['price','가격'],['tags','태그 (쉼표로 구분)'],['image','사용 권한이 있는 사진 URL'],['description','메뉴 소개']].map(([name,label]) => `<label class="field-label" for="menu-${name}">${label}</label><input id="menu-${name}" name="${name}" ${['name','price'].includes(name) ? 'required' : ''} ${name === 'price' ? 'type="number" min="0" max="10000000" step="1"' : name === 'image' ? 'type="url"' : ''} maxlength="2000">`).join('')}<label class="field-label" for="menu-status">판매 상태</label><select id="menu-status" name="status"><option value="active">판매 중</option><option value="ended">판매 종료</option></select><button type="submit" class="button primary">메뉴 등록</button></form></section>`, 'admin');
  } catch (error) { shell(empty('운영 정보를 불러오지 못했어요', e(error.message), '/admin', '다시 시도')); }
}

function profile() {
  if (!state.active) { login(); return; }
  const stats = summarize(state.reviews.filter(r => r.userId === (user?.id || demoId)));
  shell(`<section class="page-intro"><span class="eyebrow">MY RAMEN JOURNAL</span><h1>차곡차곡, 나의 라멘 기록</h1><p>${serviceMode === 'live' ? '내 계정으로 남긴 라멘 기록입니다.' : '이 브라우저에 남긴 나만의 취향입니다.'}</p></section><div class="profile-summary"><div><strong>${stats.count}</strong><span>기록한 한 그릇</span></div><div><strong>${state.saved.length}</strong><span>저장한 메뉴</span></div><div><strong>${score(stats.average)}</strong><span>내 평균 별점</span></div></div><section class="profile-distribution"><h2>나의 별점 분포</h2>${distribution(stats)}</section><div class="section-heading"><h2>내가 남긴 리뷰</h2><button class="text-button" data-action="logout">${serviceMode === 'live' ? '로그아웃' : '체험 종료'}</button></div>${state.reviews.some(r => r.userId === (user?.id || demoId)) ? `<div class="recent-grid">${state.reviews.filter(r => r.userId === (user?.id || demoId)).map(review => reviewCard(review, true)).join('')}</div>` : empty('아직 기록이 없어요', '기억에 남는 한 그릇을 찾아보세요.')}<p class="note">${serviceMode === 'live' ? '리뷰를 수정하거나 삭제할 수 있습니다. 계정 관련 문의는 개인정보처리방침의 연락처를 이용해주세요.' : '체험을 종료해도 기록은 이 브라우저에 남습니다. 사이트 저장 데이터를 지우면 기록이 삭제됩니다.'}</p>`, 'me');
}

function savedPage() {
  if (!state.active) { navigate('/login?next=%2Fsaved', true); return; }
  const saved = menus.filter(menu => state.saved.includes(menu.id));
  shell(`<section class="page-intro"><span class="eyebrow">SAVED FOR LATER</span><h1>다음에 만날 한 그릇</h1><p>먹고 싶은 마음을 모아두었어요. ${saved.length}개의 메뉴가 기다립니다.</p></section>${saved.length ? `<div class="menu-grid">${saved.map(card).join('')}</div>` : empty('먹고 싶은 한 그릇을 모아보세요', '메뉴의 책갈피 버튼을 누르면 여기에 저장됩니다.')}`, 'saved');
}

function reviewPage(menu) {
  if (!requireDemo()) return;
  const existing = ownReview(menu.id);
  photoDraft = (existing?.photos || []).filter(photoSrc);
  const rating = existing?.rating || 0;
  shell(`<div class="form-page"><a class="subtle-link" href="/menus/${menu.id}">← 메뉴로 돌아가기</a><span class="eyebrow">ONE HONEST NOTE</span><h1>한 그릇의 기억을 남겨요.</h1><div class="review-target">${image(menu)}<div><strong>${e(menu.name)}</strong><p>${shopLink(shopOf(menu))}</p></div></div><form id="review-form" data-menu="${menu.id}"><fieldset class="rating-field"><legend>어떤 한 그릇이었나요? <span class="required">필수</span></legend><div class="star-input">${[1,2,3,4,5].map(n => `<label class="star-label ${n <= rating ? 'filled' : ''}"><input type="radio" name="rating" value="${n}" required ${n === rating ? 'checked' : ''} aria-describedby="rating-description"><span aria-hidden="true">★</span><span class="sr-only">${n}점 · ${ratingLabels[n]}</span></label>`).join('')}</div><p id="rating-description" aria-live="polite">${rating ? ratingLabels[rating] : '별점을 선택하면 점수의 의미를 알려드려요.'}</p><button type="button" class="text-button" data-action="guide">3점도 좋은 라멘입니다. 별점 기준 보기</button></fieldset>
    <label class="field-label" for="review-body">한 줄에 담긴 진심 <span id="body-required">${rating === 5 ? '필수 · 5점의 특별한 이유' : '선택'}</span></label><textarea id="review-body" name="body" rows="5" maxlength="2000" placeholder="국물의 첫인상, 면의 식감, 기억에 남는 순간을 들려주세요." ${rating === 5 ? 'required' : ''}>${e(existing?.body || '')}</textarea><p class="field-help">5점은 인생의 한 그릇에. 특별했던 이유를 함께 남겨주세요.</p>
    <details class="optional-details"><summary>국물·면·고명도 기록하기 <span>선택</span></summary><p class="field-help">추가 토핑보다 기본 구성에 대해 평가해주세요. 전체 별점과 별도로 표시됩니다.</p><div class="detail-form-grid">${[['broth','국물'],['noodle','면'],['topping','고명']].filter(([key]) => key !== 'broth' || !menu.tags.includes('아부라소바')).map(([key,label]) => `<label>${label}<select name="${key}"><option value="">평가 안 함</option>${[1,2,3,4,5].map(n => `<option value="${n}" ${existing?.details?.[key] === n ? 'selected' : ''}>${n}점</option>`).join('')}</select></label>`).join('')}</div><div class="detail-form-grid">${[['intensity','진하기',['담백해요','적당해요','진해요']],['saltiness','짠맛',['싱거워요','적당해요','짭짤해요']],['texture','면 식감',['부드러워요','쫄깃해요','단단해요']]].filter(([key]) => key !== 'intensity' || !menu.tags.includes('아부라소바')).map(([key,label,options]) => `<label>${label}<select name="${key}"><option value="">선택 안 함</option>${options.map(value => `<option ${existing?.taste?.[key] === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`).join('')}</div></details>
    <label class="field-label" for="photos">사진 <span>선택 · 최대 5장</span></label><input type="file" id="photos" accept="image/jpeg,image/png,image/webp" multiple><p class="field-help">장당 10MB 이하. 저장 시 사진을 줄이고 위치 정보를 제거합니다.</p><div id="photo-drafts" class="photo-drafts"></div>
    <fieldset class="disclosure"><legend>식사 제공·협찬 여부 <span class="required">필수</span></legend><label><input type="radio" name="disclosure" value="self" required ${existing?.disclosure === 'self' ? 'checked' : ''}> 직접 결제했어요</label><label><input type="radio" name="disclosure" value="sponsored" required ${existing?.disclosure === 'sponsored' ? 'checked' : ''}> 식사 제공·협찬을 받았어요</label></fieldset><p id="form-error" class="form-error" role="alert"></p><p class="note">${serviceMode === 'live' ? '저장한 리뷰와 사진은 다른 이용자에게 공개됩니다. 개인정보를 포함하지 마세요.' : '로컬 체험 기록입니다. 이 브라우저에만 저장됩니다.'}</p><button type="submit" class="button primary full">${existing ? '리뷰 수정하기' : '한 그릇 기록하기'} ${icon('arrow')}</button></form></div>`);
  renderPhotoDrafts();
}

function renderPhotoDrafts() {
  const target = document.querySelector('#photo-drafts');
  if (target) target.innerHTML = photoDraft.map((src, i) => `<div><img src="${src}" alt="첨부 사진 ${i + 1}"><button type="button" class="icon-button" data-action="remove-photo" data-index="${i}" aria-label="첨부 사진 ${i + 1} 삭제">${icon('close')}</button></div>`).join('');
}

async function render() {
  if (!['demo','live'].includes(serviceMode)) return start();
  const route = location.pathname.replace(/\/$/, '') || '/';
  document.title = '라멘묵자 — 취향으로 찾는 한 그릇';
  if (route === '/') return home();
  if (route === '/explore') return explore();
  if (route === '/saved') return savedPage();
  if (route === '/me') return profile();
  if (route === '/login') return login();
  if (Object.hasOwn(legalDocuments, route.slice(1))) return legalPage(route.slice(1));
  if (route === '/admin') return adminPage();
  const menuRoute = route.match(/^\/menus\/([^/]+)(\/review)?$/);
  if (menuRoute) {
    const menu = menus.find(item => item.id === menuRoute[1]);
    if (menu) {
      document.title = `${menu.name} — 라멘묵자`;
      if (serviceMode === 'live' && !menuRoute[2]) {
        try { const reviews = await request('reviews?menu=' + encodeURIComponent(menu.id)); if (location.pathname.replace(/\/$/, '') !== route) return; const own = state.reviews.filter(r => r.menuId === menu.id && r.userId === user?.id); state.reviews = [...state.reviews.filter(r => r.menuId !== menu.id), ...new Map([...reviews, ...own].map(r => [r.id, r])).values()]; }
        catch (error) { return shell(empty('리뷰를 불러오지 못했어요', e(error.message), route, '다시 시도')); }
      }
      return menuRoute[2] ? reviewPage(menu) : menuDetail(menu);
    }
  }
  const shopRoute = route.match(/^\/shops\/([^/]+)$/);
  if (shopRoute) {
    const shop = shops.find(item => item.id === shopRoute[1]);
    if (shop) { document.title = `${shop.name} — 라멘묵자`; return shopDetail(shop); }
  }
  shell(empty('이 한 그릇을 찾을 수 없어요', '주소를 확인하거나 다른 메뉴를 둘러보세요.'));
}

function updateSearch(values) {
  const p = new URLSearchParams(location.pathname === '/explore' ? location.search : '');
  Object.entries(values).forEach(([key, value]) => value ? p.set(key, value) : p.delete(key));
  navigate(`/explore${p.size ? `?${p}` : ''}`);
}

function locate() {
  if (!navigator.geolocation) { locationMessage = '현재 브라우저는 위치 기능을 지원하지 않아요. 지역 필터를 이용해주세요.'; navigate('/explore'); return; }
  notify('현재 위치를 확인하고 있어요.');
  navigator.geolocation.getCurrentPosition(position => {
    coords = position.coords;
    locationMessage = `${serviceMode === 'live' ? '현재 위치에서 가게까지의 직선거리입니다. 실제 이동 거리와 다를 수 있습니다.' : '현재 위치에서 샘플 가게까지의 직선거리입니다. 실제 영업 정보가 아닙니다.'}`;
    updateSearch({ sort: 'distance' });
  }, () => {
    locationMessage = '위치를 확인하지 못했어요. 필터에서 지역을 직접 선택할 수 있습니다.';
    navigate('/explore');
  }, { timeout: 10000, maximumAge: 60000 });
}

document.addEventListener('click', async event => {
  const link = event.target.closest('a');
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0 && link.getAttribute('href')?.startsWith('/') && !link.target) {
    event.preventDefault(); navigate(link.getAttribute('href')); return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'close-modal') return modal.close();
  if (action === 'guide') return ratingGuide();
  if (action === 'locate') return locate();
  if (action === 'tag') return updateSearch({ tag: button.dataset.tag });
  if (action === 'start-login') {
    button.disabled = true;
    try { const result = await request('auth/login', 'POST', { next: new URLSearchParams(location.search).get('next'), agreed: document.querySelector('#accept-terms')?.checked === true, ageConfirmed: document.querySelector('#confirm-age')?.checked === true }); location.assign(result.url); }
    catch (error) { notify(error.message); button.disabled = false; }
    return;
  }
  if (action === 'menu-status') {
    try { await request('admin', 'POST', { type: 'menu-status', id, status: button.dataset.status }); await refreshService(); await adminPage(); } catch (error) { notify(error.message); }
    return;
  }
  if (action === 'admin-review' || action === 'admin-resolve') {
    button.disabled = true;
    try { await request('admin', 'POST', action === 'admin-review' ? { type: 'review', id, hidden: button.dataset.hidden === 'true', reason: document.querySelector('#reason-' + CSS.escape(id))?.value || '' } : { type: button.dataset.type, id }); await refreshService(); await adminPage(); }
    catch (error) { notify(error.message); button.disabled = false; }
    return;
  }
  if (action === 'save') {
    if (!requireDemo()) return;
    const saved = state.saved.includes(id);
    if (serviceMode === 'live') {
      button.disabled = true;
      try { await request('saved', 'POST', { menuId: id, saved: !saved }); await refreshService(); await render(); notify(saved ? '저장을 취소했어요.' : '메뉴를 저장했어요.'); }
      catch (error) { notify(error.message); button.disabled = false; }
      return;
    }
    if (persist({ ...state, saved: saved ? state.saved.filter(item => item !== id) : [...state.saved, id] })) { render(); notify(saved ? '저장을 취소했어요.' : '다음에 만날 한 그릇에 저장했어요.'); }
  }
  if (action === 'start-demo') {
    if (!persist({ ...state, active: true })) return;
    const next = new URLSearchParams(location.search).get('next');
    navigate(next && /^\/(?!\/)/.test(next) && !next.includes('\\') ? next : '/me');
    notify('이 브라우저에서 나만의 기록을 시작해요.');
  }
  if (action === 'logout' && serviceMode === 'live') {
    try { await request('auth/logout', 'POST', {}); await refreshService(); navigate('/'); } catch (error) { notify(error.message); }
    return;
  }
  if (action === 'logout' && persist({ ...state, active: false })) { navigate('/'); notify('체험을 종료했어요. 기록은 브라우저에 남아 있어요.'); }
  if (action === 'filter') {
    const p = new URLSearchParams(location.search);
    showModal(`<span class="eyebrow">FIND YOUR NEIGHBORHOOD</span><h2 id="modal-title">어디에서 먹을까요?</h2><form id="filter-form"><label class="field-label" for="area">지역</label><select name="area" id="area"><option value="">모든 지역</option>${[...new Set(shops.map(shop => shop.area))].map(area => `<option ${p.get('area') === area ? 'selected' : ''}>${e(area)}</option>`).join('')}</select>${serviceMode === 'demo' ? '<p class="note">초기 체험은 마포 지역의 가상 가게로 구성됩니다.</p>' : ''}<button class="button primary full">필터 적용</button></form>`);
    modal.classList.add('filter-sheet');
  }
  if (action === 'map') showModal(`<h2 id="modal-title">지도 연결을 준비하고 있어요.</h2><p>${serviceMode === 'live' ? '지도 공급자 연결을 준비 중입니다. 지역 필터와 가게 주소를 이용해주세요.' : '지도 공급자는 아직 정해지지 않았습니다. 현재는 가상 가게로 목록과 거리 탐색을 체험할 수 있어요.'}</p><p class="note">실제 가게 위치나 길찾기로 오해할 수 있는 샘플 지도는 제공하지 않습니다.</p><button class="button primary full" data-action="close-modal">목록으로 둘러보기</button>`);
  if (action === 'delete') showModal(`<h2 id="modal-title">이 기록을 삭제할까요?</h2><p>삭제한 리뷰는 이 브라우저에서 복구할 수 없습니다.</p><button class="button danger full" data-action="confirm-delete" data-id="${e(id)}">리뷰 삭제하기</button>`);
  if (action === 'confirm-delete') {
    try {
      if (serviceMode === 'live') { button.disabled = true; await request('reviews/' + encodeURIComponent(id), 'DELETE', {}); await refreshService(); modal.close(); await render(); notify('리뷰를 삭제했어요.'); return; }
      const reviews = deleteReview(state.reviews, id, state.active ? demoId : null);
      if (persist({ ...state, reviews })) { modal.close(); render(); notify('리뷰를 삭제하고 평가에 반영했어요.'); }
    } catch (error) { notify(error.message); button.disabled = false; }
  }
  if (action === 'remove-photo') { photoDraft.splice(Number(button.dataset.index), 1); renderPhotoDrafts(); }
  if (action === 'menu-photo') {
    const menu = menus.find(item => item.id === id);
    if (menu?.image) showModal(`<h2 id="modal-title">${e(menu.name)} 참고 사진</h2><img class="expanded-photo" src="${e(menu.image)}" alt="${e(menu.name)} 참고 사진"><p class="muted">실제 메뉴와 다른 참고 이미지입니다.</p>`);
  }
  if (action === 'photo') {
    const review = [...seedReviews, ...state.reviews].find(item => item.id === button.dataset.review);
    const src = photoSrc(review?.photos?.[Number(button.dataset.index)]);
    if (src) showModal(`<h2 id="modal-title" class="sr-only">리뷰 사진 크게 보기</h2><img class="expanded-photo" src="${src}" alt="리뷰 음식 사진">`);
  }
  if (action === 'report') {
    if (!requireDemo()) return;
    showModal(`<h2 id="modal-title">${serviceMode === 'live' ? '리뷰 신고' : '리뷰 신고 기록'}</h2><p class="note">${serviceMode === 'live' ? '신고 사유를 운영자가 검토합니다. 처리 결과는 운영 문의로 확인할 수 있습니다.' : '체험 기능입니다. 실제 운영자에게 전달되지 않으며 이 브라우저에만 기록됩니다.'}</p><form id="report-form" data-review="${e(id)}"><label class="field-label" for="reason">신고 사유</label><textarea id="reason" name="reason" required maxlength="500" rows="3" placeholder="확인이 필요한 내용을 알려주세요."></textarea><button class="button primary full">${serviceMode === 'live' ? '신고 접수하기' : '체험 신고 기록하기'}</button></form>`);
  }
  if (action === 'request') {
    if (!requireDemo()) return;
    showModal(`<h2 id="modal-title">가게·메뉴 등록 요청</h2><p class="note">${serviceMode === 'live' ? '등록 요청을 운영자에게 전달합니다. 검토 후 가게·메뉴가 등록됩니다.' : '이 브라우저에만 저장하는 체험 기능입니다. 실제 등록 요청은 전달되지 않습니다.'}</p><form id="request-form"><label class="field-label" for="request-name">가게·메뉴명</label><input id="request-name" name="name" maxlength="100" required><label class="field-label" for="request-note">지역과 추가 정보</label><textarea id="request-note" name="note" rows="3" maxlength="1000" required></textarea><button class="button primary full">${serviceMode === 'live' ? '등록 요청하기' : '체험 요청 저장하기'}</button></form>`);
  }
});

document.addEventListener('change', async event => {
  const target = event.target;
  if (target.id === 'sort') return updateSearch({ sort: target.value, min: target.value === 'rating' ? '1' : '' });
  if (target.id === 'minimum') return updateSearch({ min: target.checked ? '1' : '0' });
  if (target.name === 'rating') {
    const rating = Number(target.value);
    document.querySelectorAll('.star-label').forEach((label, i) => label.classList.toggle('filled', i < rating));
    document.querySelector('#rating-description').textContent = ratingLabels[rating];
    document.querySelector('#review-body').required = rating === 5;
    document.querySelector('#body-required').textContent = rating === 5 ? '필수 · 5점의 특별한 이유' : '선택';
  }
  if (target.id === 'photos') {
    const files = [...target.files];
    if (files.length + photoDraft.length > 5) { target.value = ''; return notify('사진은 최대 5장까지 첨부할 수 있어요.'); }
    const submit = document.querySelector('#review-form button[type="submit"]');
    target.disabled = true; submit.disabled = true;
    try {
      const converted = [];
      for (const file of files) {
        if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('JPG, PNG, WebP 사진을 장당 10MB 이하로 선택해주세요.');
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        converted.push(canvas.toDataURL('image/jpeg', .75));
      }
      photoDraft.push(...converted); renderPhotoDrafts();
    } catch (error) { notify(error.message || '사진을 읽지 못했어요. 다른 사진으로 다시 시도해주세요.'); }
    finally { target.value = ''; target.disabled = false; submit.disabled = false; }
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['search-form','filter-form','review-form','report-form','request-form','admin-shop-form','admin-menu-form'].includes(form.id)) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.id.startsWith('admin-')) {
    const submit = form.querySelector('button[type=submit]'); submit.disabled = true;
    const record = Object.fromEntries(data);
    if (form.id === 'admin-menu-form') { record.price = Number(record.price); record.tags = record.tags.split(',').map(x => x.trim()).filter(Boolean); record.taste = []; }
    else for (const field of ['lat','lng']) record[field] = record[field] === '' ? null : Number(record[field]);
    try { await request('admin', 'POST', { type: form.id === 'admin-shop-form' ? 'shop' : 'menu', record }); await refreshService(); await adminPage(); notify('등록했습니다.'); }
    catch (error) { notify(error.message); submit.disabled = false; }
    return;
  }
  if (form.id === 'search-form') return updateSearch({ q: String(data.get('q')).trim() });
  if (form.id === 'filter-form') return updateSearch({ area: data.get('area') });
  if (form.id === 'review-form') {
    if (!state.active) return notify(serviceMode === 'live' ? '로그인 상태를 확인해주세요. 입력 내용은 그대로 남아 있습니다.' : '체험 모드를 먼저 시작해주세요. 입력 내용은 그대로 남아 있습니다.');
    const menuId = form.dataset.menu, existing = ownReview(menuId);
    const details = Object.fromEntries(['broth','noodle','topping'].filter(key => data.get(key)).map(key => [key, Number(data.get(key))]));
    const taste = Object.fromEntries(['intensity','saltiness','texture'].filter(key => data.get(key)).map(key => [key, data.get(key)]));
    const review = { id: existing?.id || crypto.randomUUID(), menuId, rating: Number(data.get('rating')), body: String(data.get('body')).trim(), disclosure: data.get('disclosure'), details, taste, photos: [...photoDraft], author: '나의 라멘일기', date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) };
    const error = validateReview(review);
    if (error) { document.querySelector('#form-error').textContent = error; return; }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      if (serviceMode === 'live') {
        const photos = [];
        for (const photo of photoDraft) photos.push(photo.startsWith('/api/photos/') ? photo : (await request('photos', 'POST', { data: photo })).url);
        await request('reviews', 'PUT', { ...review, photos }); await refreshService(); navigate(`/menus/${menuId}`); notify('리뷰를 저장했어요.'); return;
      }
      const reviews = upsertReview(state.reviews, review, demoId);
      if (persist({ ...state, reviews })) { navigate(`/menus/${menuId}`); notify(existing ? '기록을 수정하고 평가에 반영했어요.' : '한 그릇의 기록을 남겼어요.'); }
    } catch (error) { document.querySelector('#form-error').textContent = error.message; }
    finally { submit.disabled = false; }
  }
  if (serviceMode === 'live' && ['report-form','request-form'].includes(form.id)) {
    const submit = form.querySelector('button'); submit.disabled = true;
    try { await request(form.id === 'report-form' ? 'reports' : 'requests', 'POST', form.id === 'report-form' ? { reviewId: form.dataset.review, reason: String(data.get('reason')).trim() } : { name: String(data.get('name')).trim(), note: String(data.get('note')).trim() }); modal.close(); notify('운영자에게 접수했어요.'); }
    catch (error) { notify(error.message); submit.disabled = false; }
    return;
  }
  if (form.id === 'report-form' && state.active) {
    if (!String(data.get('reason')).trim()) return;
    if (persist({ ...state, reports: [...state.reports, { reviewId: form.dataset.review, reason: String(data.get('reason')).trim() }] })) { modal.close(); notify('체험 신고를 이 브라우저에 기록했어요.'); }
  }
  if (form.id === 'request-form' && state.active) {
    if (!String(data.get('name')).trim() || !String(data.get('note')).trim()) return;
    if (persist({ ...state, requests: [...state.requests, { name: String(data.get('name')).trim(), note: String(data.get('note')).trim() }] })) { modal.close(); notify('체험 등록 요청을 이 브라우저에 저장했어요.'); }
  }
});

window.addEventListener('popstate', render);
window.addEventListener('storage', event => {
  if (serviceMode === 'demo' && event.key === storageKey) notify('다른 탭에서 기록이 변경됐어요. 작성 중인 내용을 보관하고 새로고침해주세요.');
});
start();
