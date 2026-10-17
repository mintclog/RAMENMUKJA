let loading;

function load(key) {
  if (window.google?.maps?.marker) return Promise.resolve(window.google.maps);
  if (!loading) loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { loading = null; reject(new Error('지도 응답이 지연되고 있어요. 목록과 주소를 이용해주세요.')); }, 15000);
    window.ramenMapsReady = () => { clearTimeout(timer); resolve(window.google.maps); delete window.ramenMapsReady; };
    script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key, libraries: 'marker', callback: 'ramenMapsReady', v: 'weekly', language: 'ko' });
    script.async = true;
    script.onerror = () => { clearTimeout(timer); script.remove(); loading = null; reject(new Error('지도를 불러오지 못했어요.')); };
    document.head.append(script);
  });
  return loading;
}

export function directions(shop) {
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', destination: `${shop.lat},${shop.lng}` });
}

export async function renderMap(element, shops, config, { onSelect, onPlace } = {}) {
  if (!config.key || !config.mapId) { element.textContent = 'Google Maps 연결 설정이 필요합니다. 가게 주소와 외부 길찾기를 이용해주세요.'; return; }
  try {
    const api = await load(config.key);
    if (!element.isConnected) return;
    const points = shops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
    const map = new api.Map(element, { center: points.length ? { lat: points[0].lat, lng: points[0].lng } : { lat: 37.5665, lng: 126.978 }, zoom: 14, mapId: config.mapId, streetViewControl: false, mapTypeControl: false });
    const bounds = new api.LatLngBounds();
    for (const shop of points) {
      const position = { lat: shop.lat, lng: shop.lng };
      const marker = new api.marker.AdvancedMarkerElement({ map, position, title: shop.name });
      bounds.extend(position);
      marker.addListener('click', () => onSelect?.(shop));
    }
    if (points.length > 1) map.fitBounds(bounds);
    if (onPlace) {
      const marker = new api.marker.AdvancedMarkerElement({ map, title: '등록할 가게 위치' });
      map.addListener('click', event => { marker.position = event.latLng; onPlace(event.latLng.lat(), event.latLng.lng()); });
    }
  } catch (error) { if (element.isConnected) element.textContent = error.message; }
}
