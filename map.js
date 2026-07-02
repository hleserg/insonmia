/* Бессонница 2026 — офлайн-карта (Leaflet) и раздел «Рядом».
   Грузится ДО app.js (см. index.html); глобалы app.js (state, render, …)
   читает только в рантайме, когда оба скрипта уже исполнены. */
'use strict';

const GEO = {
  data: null,          // data/geo.json
  map: null,           // Leaflet instance
  layerGroups: {},     // category -> L.LayerGroup
  zoneById: {},        // geo id -> L.Polygon
  pointById: {},       // geo id -> {marker, point}
  highlight: null,
  selfMarker: null,
  filters: null,       // Set включённых категорий
  nearby: { pos: null, radius: 300 }, // жизненный цикл watch — в core.createGeoWatcher
  mock: null,          // ?mockgeo=lat,lng
};

const CAT_META = {
  screen:   { label: 'экраны',      emoji: '🎬', color: '#a371f7' },
  stage:    { label: 'сцены',       emoji: '🎤', color: '#a371f7' },
  venue:    { label: 'площадки',    emoji: '🎪', color: '#58a6ff' },
  food:     { label: 'еда',         emoji: '🍜', color: '#d29922' },
  wc:       { label: 'туалеты',     emoji: '🚻', color: '#8b949e' },
  art:      { label: 'арт',         emoji: '🗿', color: '#3fb950' },
  shower:   { label: 'души',        emoji: '🚿', color: '#58a6ff' },
  paid:     { label: 'кемпинги',    emoji: '⛺', color: '#d29922' },
  info:     { label: 'инфоцентр',   emoji: 'ℹ️', color: '#3fb950' },
  workshop: { label: 'мастерские',  emoji: '🛠️', color: '#58a6ff' },
  market:   { label: 'ярмарка',     emoji: '🛍️', color: '#d29922' },
  kids:     { label: 'детям',       emoji: '🧸', color: '#ffbd2e' },
  landmark: { label: 'ориентиры',   emoji: '🕊️', color: '#3fb950' },
  chill:    { label: 'чиллаут',     emoji: '🍵', color: '#3fb950' },
  med:      { label: 'медпункт',    emoji: '➕', color: '#f85149' },
  kpp:      { label: 'КПП',         emoji: '🛂', color: '#8b949e' },
  parking:  { label: 'парковки',    emoji: '🅿️', color: '#8b949e' },
  service:  { label: 'служебные',   emoji: '⚙️', color: '#8b949e' },
  place:    { label: 'прочее',      emoji: '📍', color: '#58a6ff' },
  other:    { label: 'другое',      emoji: '❓', color: '#8b949e' },
};
// по умолчанию выключены: служебные и авто-дороги
const DEFAULT_OFF = new Set(['service']);

async function loadGeo() {
  try {
    const res = await fetch('data/geo.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function loadBasemap() {
  try {
    const res = await fetch('data/basemap.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function initMockGeo() {
  if (typeof DEV === 'undefined' || !DEV) {
    try { sessionStorage.removeItem('insomnia.mockgeo'); } catch { /* ignore */ }
    return;
  }
  try {
    const q = new URLSearchParams(location.search).get('mockgeo');
    if (q) {
      const [lat, lng] = q.split(',').map(Number);
      if (isFinite(lat) && isFinite(lng)) {
        GEO.mock = { lat, lng };
        sessionStorage.setItem('insomnia.mockgeo', q);
        return;
      }
    }
    const saved = sessionStorage.getItem('insomnia.mockgeo');
    if (saved) {
      const [lat, lng] = saved.split(',').map(Number);
      if (isFinite(lat) && isFinite(lng)) GEO.mock = { lat, lng };
    }
  } catch { /* не критично */ }
}

/* ---------- геометрия: core.js ---------- */
const bearingLabel = (a, b) => window.InsomniaCore.bearingLabel(a, b);

/* ---------- Leaflet ---------- */
function markerIcon(cat) {
  const m = CAT_META[cat] || CAT_META.other;
  return L.divIcon({
    className: 'geo-marker',
    html: `<div class="geo-pin" style="border-color:${m.color}">${m.emoji}</div>`,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
}

function ensureMap() {
  if (GEO.map || !GEO.data || typeof L === 'undefined') return;
  const map = L.map('leafletMap', {
    zoomControl: true, attributionControl: true,
    minZoom: 13, maxZoom: 18,
  });
  // Подложка — собственная отрисовка данных Overpass (© OpenStreetMap
  // contributors, ODbL). Тайлы не используем: их массовое скачивание
  // блокируется политикой OSM, а данные легальны и в разы легче.
  map.attributionControl.addAttribution('данные © OpenStreetMap');
  if (GEO.basemap) {
    const bm = GEO.basemap;
    const style = {
      meadow:   { color: '#16240f', fillColor: '#141f0c', fillOpacity: 0.55, weight: 0 },
      forest:   { color: '#0f2416', fillColor: '#0e2012', fillOpacity: 0.75, weight: 0 },
      water:    { color: '#12395c', fillColor: '#0e2f4d', fillOpacity: 0.85, weight: 1 },
      building: { color: '#30363d', fillColor: '#21262d', fillOpacity: 0.9, weight: 1 },
    };
    ['meadow', 'forest', 'water', 'building'].forEach(kind => {
      (bm[kind] || []).forEach(poly =>
        L.polygon(poly, { ...style[kind], interactive: false }).addTo(map));
    });
    (bm.water_line || []).forEach(line =>
      L.polyline(line, { color: '#12395c', weight: 4, opacity: 0.8, interactive: false }).addTo(map));
    (bm.path || []).forEach(line =>
      L.polyline(line, { color: '#3a4149', weight: 1.2, opacity: 0.6, interactive: false }).addTo(map));
  }

  // зоны -> дороги -> точки (порядок отрисовки)
  const groups = {};
  const grp = cat => groups[cat] || (groups[cat] = L.layerGroup());

  GEO.data.zones.forEach(z => {
    const m = CAT_META[z.category] || CAT_META.other;
    const poly = L.polygon(z.polygon, {
      color: m.color, weight: 1, opacity: 0.6,
      fillColor: m.color, fillOpacity: 0.12,
    });
    poly.on('click', () => { const p = GEO.pointById[z.id]; openPointCard(p ? p.point : { id: z.id, name: z.name, category: z.category }); });
    GEO.zoneById[z.id] = poly;
    grp(z.category).addLayer(poly);
  });
  GEO.data.roads.forEach(r => {
    const line = L.polyline(r.line, r.type === 'auto'
      ? { color: '#8b949e', weight: 2.5, opacity: 0.55 }
      : { color: '#8b949e', weight: 2, opacity: 0.5, dashArray: '4 6' });
    grp(r.type === 'auto' ? 'roads-auto' : 'roads-foot').addLayer(line);
  });
  GEO.data.points.forEach(p => {
    const mk = L.marker([p.lat, p.lng], { icon: markerIcon(p.category) });
    mk.on('click', () => openPointCard(p));
    GEO.pointById[p.id] = { marker: mk, point: p };
    grp(p.category).addLayer(mk);
  });

  GEO.layerGroups = groups;
  GEO.map = map;
  initFilters();
  applyMapFilters();

  const lats = GEO.data.points.map(p => p.lat);
  const lngs = GEO.data.points.map(p => p.lng);
  map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [20, 20] });
}

function applyMapFilters() {
  if (!GEO.map) return;
  Object.entries(GEO.layerGroups).forEach(([cat, g]) => {
    if (GEO.filters.has(cat)) GEO.map.addLayer(g);
    else GEO.map.removeLayer(g);
  });
}

function highlightPoint(id, { open = false } = {}) {
  if (!GEO.map) return;
  const rec = GEO.pointById[id];
  const zone = GEO.zoneById[id];
  if (GEO.highlight) { GEO.highlight.setStyle({ weight: 1, fillOpacity: 0.12 }); GEO.highlight = null; }
  if (zone) { zone.setStyle({ weight: 3, fillOpacity: 0.3 }); GEO.highlight = zone; }
  if (rec) {
    GEO.map.setView([rec.point.lat, rec.point.lng], Math.max(GEO.map.getZoom(), 17));
    if (open) openPointCard(rec.point);
  } else if (zone) {
    GEO.map.fitBounds(zone.getBounds());
  }
}

/* ---------- карточка точки ---------- */
function venuesOfPoint(pointId) {
  // площадки программы, привязанные к точке карты (алиасы — мультиточки)
  const vp = (GEO.data && GEO.data.venuePoints) || {};
  return Object.keys(vp).filter(v => vp[v].includes(pointId));
}

function eventsAtPoint(pointId) {
  // события площадок, чей venuePoints содержит эту точку, на текущий фест-день
  const venues = venuesOfPoint(pointId);
  if (!venues.length) return [];
  const today = getFestivalDay(getNow());
  return state.program.events
    .filter(e => venues.includes(e.venue) && e._festDay === today)
    .sort(sortByStart);
}

// единый рендер строки события у точки: и в карточке точки, и в «рядом».
// «сейчас»/«скоро» — строго по statusOf (скоро = ≤30 мин, как во всём приложении)
function pointEventsHtml(events, max) {
  return events.slice(0, max).map(e => {
    const st = statusOf(e);
    const tag = st === 'live' ? '<span class="live-tag">сейчас</span>'
      : st === 'soon' ? '<span class="soon-tag">скоро</span>' : '';
    return `<div class="point-event" data-id="${e.id}">
      <span class="pe-time">${e.start}</span> ${escapeHtml(e.title)} ${tag}
    </div>`;
  }).join('');
}

function openPointCard(p) {
  const meta = CAT_META[p.category] || CAT_META.other;
  const evs = eventsAtPoint(p.id);
  const evHtml = pointEventsHtml(evs, 3);
  const body = $('#sheetBody');
  body.innerHTML = `
    <div class="detail-time">${meta.emoji} ${escapeHtml(meta.label)}</div>
    <div class="detail-title">${escapeHtml(p.name)}</div>
    ${evs.length ? `
      <div class="detail-section">
        <h4>события здесь сегодня (${evs.length})</h4>
        ${evHtml}
        ${evs.length > 3 ? `<button class="btn ghost" id="pointAllEvents">все события площадки</button>` : ''}
      </div>` : '<p class="muted small">Сегодня событий на этой точке нет в программе.</p>'}
  `;
  body.querySelectorAll('.point-event').forEach(el =>
    el.addEventListener('click', () => { hideSheet('#sheet'); openDetail(el.dataset.id); }));
  const allBtn = body.querySelector('#pointAllEvents');
  if (allBtn) allBtn.addEventListener('click', () => {
    hideSheet('#sheet');
    const venue = venuesOfPoint(p.id)[0];
    if (venue) {
      state.query = venue;
      $('#searchInput').value = venue;
      $('#searchBar').classList.remove('hidden');
      switchView('schedule');
    }
  });
  if (GEO.map) highlightPoint(p.id);
  showSheet('#sheet');
}

/* ---------- вид «карта» ---------- */
function initFilters() {
  if (GEO.filters || !GEO.data) return;
  // roads-auto сюда сознательно не входит: авто-дороги выключены по умолчанию
  const cats = new Set(GEO.data.points.map(p => p.category));
  cats.add('roads-foot');
  GEO.filters = new Set([...cats].filter(c => !DEFAULT_OFF.has(c)));
}

function renderMapView() {
  const wrap = $('#mapWrap');
  wrap.classList.remove('hidden');
  if (!GEO.data) {
    $('#mapStatus').textContent = 'карта не загружена — откройте приложение онлайн один раз';
    return;
  }
  $('#mapStatus').textContent = '';
  initFilters();
  buildMapChips();
  // Leaflet требует видимый контейнер
  requestAnimationFrame(() => { ensureMap(); if (GEO.map) GEO.map.invalidateSize(); });
}

function hideMapView() {
  $('#mapWrap').classList.add('hidden');
}

function buildMapChips() {
  const row = $('#mapChips');
  if (row.dataset.built) return;
  row.dataset.built = '1';
  const cats = [...new Set(GEO.data.points.map(p => p.category))];
  cats.sort((a, b) => (CAT_META[a]?.label || a).localeCompare(CAT_META[b]?.label || b));
  const mk = (cat, label) => {
    // buildMapChips зовётся только после initFilters (renderMapView) —
    // GEO.filters здесь гарантированно есть
    const b = document.createElement('button');
    b.className = 'chip' + (GEO.filters.has(cat) ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if (GEO.filters.has(cat)) GEO.filters.delete(cat); else GEO.filters.add(cat);
      b.classList.toggle('active');
      applyMapFilters();
    });
    row.appendChild(b);
  };
  cats.forEach(c => mk(c, (CAT_META[c] || CAT_META.other).label));
  mk('roads-foot', 'тропы');
  mk('roads-auto', 'авто-дороги');
}

/* ---------- геолокация ---------- */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (GEO.mock) return resolve(GEO.mock);
    if (!navigator.geolocation) return reject(new Error('нет геолокации'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(err), { enableHighAccuracy: true, timeout: 10000 });
  });
}

async function locateMe() {
  try {
    const pos = await getPosition();
    if (!GEO.map) return;
    if (GEO.selfMarker) GEO.selfMarker.remove();
    GEO.selfMarker = L.marker([pos.lat, pos.lng], {
      icon: L.divIcon({ className: 'geo-marker', html: '<div class="geo-self"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(GEO.map);
    GEO.map.setView([pos.lat, pos.lng], Math.max(GEO.map.getZoom(), 16));
  } catch {
    toast('> геолокация недоступна');
  }
}

/* ---------- «рядом» ---------- */
const NEARBY_RADII = [150, 300, 600, 0]; // 0 = всё

const nearbyWatcher = window.InsomniaCore.createGeoWatcher(
  typeof navigator !== 'undefined' ? navigator.geolocation : null,
  pos => {
    GEO.nearby.pos = pos;
    if (state.view === 'nearby') render();
  }, 10000);

function startNearbyWatch() {
  if (GEO.mock) { GEO.nearby.pos = GEO.mock; return; }
  nearbyWatcher.start();
}

function stopNearbyWatch() { nearbyWatcher.stop(); }

function getNearby(points, events, position, now, radiusM) {
  const vp = GEO.data ? GEO.data.venuePoints || {} : {};
  return window.InsomniaCore.getNearby(points, events, position, now, radiusM, vp);
}

function renderNearby(root) {
  const radRow = document.createElement('div');
  radRow.className = 'chip-row';
  NEARBY_RADII.forEach(r => {
    const b = document.createElement('button');
    b.className = 'chip' + (GEO.nearby.radius === r ? ' active' : '');
    b.textContent = r ? `${r} м` : 'всё';
    b.addEventListener('click', () => { GEO.nearby.radius = r; render(); });
    radRow.appendChild(b);
  });
  root.appendChild(radRow);

  if (!GEO.data) {
    root.appendChild(emptyState('🗺', 'Карта не загружена — откройте приложение онлайн один раз.'));
    return;
  }
  // (пере)запускаем слежение при каждом входе в раздел: покидание вкладки
  // делает clearWatch, а позиция должна обновляться при возвращении
  startNearbyWatch();
  if (!GEO.nearby.pos) {
    const st = document.createElement('div');
    st.className = 'empty';
    st.innerHTML = '<span class="big">📡</span>$ gps --wait… Разрешите геолокацию — GPS работает без интернета.';
    root.appendChild(st);
    return;
  }

  const now = getNow();
  const items = getNearby(GEO.data.points.filter(p => p.category !== 'service'),
    state.program.events, GEO.nearby.pos, now, GEO.nearby.radius);
  if (!items.length) {
    const st = emptyState('🌾', 'В этом радиусе пусто. Расширьте круг или загляните в программу.');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'к программе';
    btn.addEventListener('click', () => switchView('schedule'));
    st.appendChild(btn);
    root.appendChild(st);
    return;
  }
  items.slice(0, 40).forEach(p => {
    const meta = CAT_META[p.category] || CAT_META.other;
    const el = document.createElement('div');
    el.className = 'map-point';
    const evHtml = pointEventsHtml(p.events, 2);
    el.innerHTML = `
      <div class="map-point-name">
        <span>${meta.emoji} ${escapeHtml(p.name)}</span>
        <span class="muted small">${p.dist} м ${bearingLabel(GEO.nearby.pos, p)}</span>
      </div>
      ${evHtml}
    `;
    el.querySelectorAll('.point-event').forEach(pe =>
      pe.addEventListener('click', () => openDetail(pe.dataset.id)));
    el.querySelector('.map-point-name').addEventListener('click', () => {
      switchView('map');
      setTimeout(() => highlightPoint(p.id, { open: true }), 250);
    });
    root.appendChild(el);
  });
}

/* ---------- интеграция с app.js ---------- */
function switchView(view) {
  state.view = view;
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  render();
}

// гео-данные обновились (тихий рефреш): сбросить карту и чипсы,
// следующее открытие вкладки перерисует всё из свежего GEO.data
function resetMapLayers() {
  if (GEO.map) { GEO.map.remove(); GEO.map = null; }
  GEO.layerGroups = {};
  GEO.zoneById = {};
  GEO.pointById = {};
  GEO.highlight = null;
  GEO.selfMarker = null;
  GEO.filters = null;
  const row = $('#mapChips');
  if (row) { row.innerHTML = ''; delete row.dataset.built; }
}

// событие -> точки на карте (мультиточки беседки)
function eventGeoPoints(e) {
  if (!GEO.data || !GEO.data.venuePoints) return [];
  const ids = GEO.data.venuePoints[e.venue] || GEO.data.venuePoints[(e.venue || '').split(' / ')[0]] || [];
  // pointById живёт только после постройки карты; в данных — те же объекты
  return ids.map(id => GEO.data.points.find(p => p.id === id)).filter(Boolean);
}
