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
  nearby: { pos: null, posAt: 0, error: null, radius: 300 }, // watch — в core.createGeoWatcher
  mock: null,          // ?mockgeo=lat,lng
};

const CAT_META = {
  my:       { label: 'мои',         emoji: '📍', color: '#d29922' },
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
  drawPins(); // слой «мои» — до applyMapFilters, чтобы фильтр знал о группе
  applyMapFilters();

  // лонгтап (contextmenu на тач-устройствах) — новая метка в этом месте
  map.on('contextmenu', (e) => openPinEditor({ lat: e.latlng.lat, lng: e.latlng.lng }));

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
  cats.add('my'); // пользовательские метки включены по умолчанию
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
  mk('my', 'мои'); // первым — свои метки
  cats.forEach(c => mk(c, (CAT_META[c] || CAT_META.other).label));
  mk('roads-foot', 'тропы');
  mk('roads-auto', 'авто-дороги');
}

/* ---------- мои метки (user pins) ---------- */
const PIN_EMOJI = ['⛺', '🔥', '🚗', '💧', '🍲', '📍'];
const PIN_LIMIT = window.InsomniaCore.PIN_LIMIT;
const pinKey = window.InsomniaCore.pinKey;
const PIN_EDIT = { original: null }; // имя метки, которую правим (переименование без дубля)

// свободное автоимя вида «база», «база 2», «база 3»… среди текущих меток
function freePinName(pins, base) {
  if (!pins.some(p => pinKey(p.name) === pinKey(base))) return base;
  let n = 2;
  while (pins.some(p => pinKey(p.name) === pinKey(`${base} ${n}`))) n++;
  return `${base} ${n}`;
}

function pinIcon(emoji) {
  return L.divIcon({
    className: 'geo-marker',
    html: `<div class="pin-my">${escapeHtml(emoji || '📍')}</div>`,
    iconSize: [32, 32], iconAnchor: [16, 16],
  });
}

// перерисовать слой «мои» из state.pins (после любого изменения меток)
function drawPins() {
  if (!GEO.map) return;
  const g = GEO.layerGroups.my || (GEO.layerGroups.my = L.layerGroup());
  g.clearLayers();
  (state.pins || []).forEach(pin => {
    const mk = L.marker([pin.lat, pin.lng], { icon: pinIcon(pin.emoji) });
    mk.on('click', () => openPinCard(pin));
    g.addLayer(mk);
  });
}

function pinsChanged() {
  savePins();
  drawPins();
  updatePinsInfo();
  if (state.view === 'nearby') render();
}

function openPinCard(pin) {
  const body = $('#sheetBody');
  body.innerHTML = `
    <div class="detail-time">${escapeHtml(pin.emoji || '📍')} моя метка</div>
    <div class="detail-title">${escapeHtml(pin.name || 'без названия')}</div>
    ${pin.note ? `<p class="detail-desc">${escapeHtml(pin.note)}</p>` : ''}
    <div class="muted small">${(+pin.lat).toFixed(5)}, ${(+pin.lng).toFixed(5)}</div>
    ${window.InsomniaCore.pinOutsideFest(pin) ? '<div class="muted small">⚠️ далеко от поляны</div>' : ''}
    <div class="pin-actions">
      <button class="btn" id="pinCardShare">поделиться</button>
      <button class="btn ghost" id="pinCardEdit">редактировать</button>
      <button class="btn ghost danger" id="pinCardDel">удалить</button>
    </div>`;
  $('#pinCardShare').addEventListener('click', () => sharePin(pin));
  $('#pinCardEdit').addEventListener('click', () => { hideSheet('#sheet'); openPinEditor(pin); });
  $('#pinCardDel').addEventListener('click', () => {
    const key = pinKey(pin.name);
    state.pins = state.pins.filter(p => pinKey(p.name) !== key);
    pinsChanged();
    hideSheet('#sheet');
    toast('> метка удалена');
  });
  showSheet('#sheet');
}

function pinUrl(pin) {
  return location.origin + location.pathname + window.InsomniaCore.pinToHash(pin);
}

function sharePin(pin) {
  const url = pinUrl(pin);
  const text = `${pin.emoji || '📍'} ${pin.name} — метка на карте «Бессонницы»`;
  if (navigator.share) { navigator.share({ title: pin.name, text, url }).catch(() => {}); return; }
  const copy = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(url) : Promise.reject();
  copy.then(() => toast('> ссылка на метку скопирована'))
    .catch(() => {
      // буфер недоступен — отдаём ссылку в выделяемое поле, не в тост
      hideSheet('#sheet');
      hideSheet('#settings');
      $('#pinImportText').value = url;
      showSheet('#pinImport');
      toast('Буфер недоступен — ссылка в поле, скопируйте руками', 5000);
    });
}

function selectPinEmoji(emoji) {
  $$('#pinEmojiRow button').forEach(b => b.classList.toggle('active', b.dataset.emoji === emoji));
}
function selectedPinEmoji() {
  const b = document.querySelector('#pinEmojiRow button.active');
  return b ? b.dataset.emoji : '📍';
}

function openPinEditor(seed) {
  PIN_EDIT.original = seed && seed.name ? seed.name : null;
  $('#pinEditorTitle').textContent = PIN_EDIT.original ? '~/метки/править' : '~/метки/новая';
  $('#pinName').value = (seed && seed.name) || '';
  $('#pinNote').value = (seed && seed.note) || '';
  $('#pinCoords').value = seed && isFinite(seed.lat) && isFinite(seed.lng)
    ? `${(+seed.lat).toFixed(5)}, ${(+seed.lng).toFixed(5)}` : '';
  selectPinEmoji((seed && seed.emoji) || '📍');
  $('#pinWarn').classList.add('hidden');
  showSheet('#pinEditor');
  if (!$('#pinName').value) setTimeout(() => $('#pinName').focus(), 60);
}

function savePinFromEditor() {
  const core = window.InsomniaCore;
  const name = $('#pinName').value.trim();
  if (!name) { toast('Дайте метке название'); $('#pinName').focus(); return; }
  const pair = core.parseCoordPairs($('#pinCoords').value)[0];
  if (!pair) { toast('Координаты не распознаны — «54,68712 35,07934»'); $('#pinCoords').focus(); return; }
  const pin = { ...pair, name, emoji: selectedPinEmoji(), note: $('#pinNote').value.trim() };
  // переименование при правке: в занятое имя не даём (иначе две метки
  // молча схлопнутся в одну), свою старую запись убираем
  let pins = state.pins || [];
  if (PIN_EDIT.original && pinKey(PIN_EDIT.original) !== pinKey(name)) {
    if (pins.some(p => pinKey(p.name) === pinKey(name))) {
      toast('Это имя занято другой меткой — выберите другое');
      $('#pinName').focus();
      return;
    }
    pins = pins.filter(p => pinKey(p.name) !== pinKey(PIN_EDIT.original));
  }
  const r = core.upsertPin(pins, pin, PIN_LIMIT);
  if (!r.ok) { toast(`Лимит ${PIN_LIMIT} меток — удалите что-нибудь`); return; }
  state.pins = r.pins;
  pinsChanged();
  hideSheet('#pinEditor');
  const far = core.pinOutsideFest(pin);
  toast(far ? '⚠️ метка далеко от поляны — но сохранена' : (r.updated ? '> метка обновлена' : '> метка сохранена'), far ? 5000 : 2600);
  if (GEO.map) GEO.map.setView([pin.lat, pin.lng], Math.max(GEO.map.getZoom(), 16));
}

// «добавить из текста»: разбор свободного текста / экспортной строки
function parsePinImportText() {
  const raw = $('#pinImportText').value;
  const found = window.InsomniaCore.parsePinsFromText(raw);
  const box = $('#pinImportPreview');
  if (!found.length) {
    box.textContent = 'Координат не нашлось. Подойдут пары «54,68712 35,07934», geo:-ссылки или #pin=-ссылки.';
    $('#pinImportApply').classList.add('hidden');
    return;
  }
  box.innerHTML = found.slice(0, 50).map(p =>
    `<div class="pin-import-row">${escapeHtml(p.emoji || '📍')} ${escapeHtml(p.name || 'без названия')} · ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>`).join('');
  $('#pinImportApply').classList.remove('hidden');
  $('#pinImportApply').dataset.count = String(found.length);
}

function applyPinImport() {
  const core = window.InsomniaCore;
  const found = core.parsePinsFromText($('#pinImportText').value);
  let added = 0, updated = 0, rejected = 0;
  let pins = state.pins || [];
  found.forEach(p => {
    // автоимя не должно совпасть с существующей меткой (молчаливая перезапись)
    const pin = { ...p, name: p.name || freePinName(pins, 'метка') };
    const r = core.upsertPin(pins, pin, PIN_LIMIT);
    if (!r.ok) { rejected++; return; }
    pins = r.pins;
    if (r.updated) updated++; else added++;
  });
  state.pins = pins;
  pinsChanged();
  hideSheet('#pinImport');
  toast(`> метки: +${added}${updated ? `, обновлено ${updated}` : ''}${rejected ? `, отклонено ${rejected} (лимит ${PIN_LIMIT})` : ''}`, 5000);
}

function openPinImport() {
  hideSheet('#settings'); // не наслаиваем шиты: импорт открывается из настроек
  $('#pinImportText').value = '';
  $('#pinImportPreview').textContent = '';
  $('#pinImportApply').classList.add('hidden');
  showSheet('#pinImport');
  setTimeout(() => $('#pinImportText').focus(), 60);
}

function exportPinsLine() {
  const pins = state.pins || [];
  if (!pins.length) { toast('Меток пока нет'); return; }
  const line = pins.map(p => window.InsomniaCore.pinToHash(p)).join(' ');
  const copy = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(line) : Promise.reject();
  copy.then(() => toast(`> ${pins.length} мет. одной строкой — в буфере`))
    .catch(() => {
      hideSheet('#settings');
      $('#pinImportText').value = line;
      showSheet('#pinImport');
      toast('Буфер недоступен — строка в поле импорта, скопируйте руками', 5000);
    });
}

function updatePinsInfo() {
  const el = $('#pinsInfo');
  if (el) el.textContent = `Сохранено: ${(state.pins || []).length} из ${PIN_LIMIT}. Лонгтап по карте — новая метка.`;
}

// входящий диплинк #pin=… (открыли чужую ссылку)
function handleIncomingPin() {
  const core = window.InsomniaCore;
  const pin = core.pinFromHash(location.hash);
  if (!pin) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const body = $('#pinIncomingBody');
  body.innerHTML = `
    <div class="detail-title">${escapeHtml(pin.emoji || '📍')} ${escapeHtml(pin.name || 'метка без названия')}</div>
    <div class="muted small">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</div>
    ${core.pinOutsideFest(pin) ? '<div class="muted small">⚠️ далеко от поляны</div>' : ''}
    <button class="btn" id="pinIncomingAdd">Добавить в мои метки</button>
    <button class="btn ghost" id="pinIncomingView">Просто посмотреть</button>`;
  const showOnMap = (withPreview) => {
    switchView('map');
    setTimeout(() => {
      if (!GEO.map) return;
      GEO.map.setView([pin.lat, pin.lng], 17);
      // превью живёт в одном экземпляре и не остаётся навсегда:
      // сохранённую метку рисует слой «мои», дубль-фантом не нужен
      if (GEO.preview) { GEO.preview.remove(); GEO.preview = null; }
      if (withPreview) {
        GEO.preview = L.marker([pin.lat, pin.lng], { icon: pinIcon(pin.emoji) })
          .addTo(GEO.map).bindPopup(escapeHtml(pin.name || 'метка')).openPopup();
      }
    }, 300);
  };
  $('#pinIncomingAdd').addEventListener('click', () => {
    const name = pin.name || freePinName(state.pins || [], 'метка из ссылки');
    const r = window.InsomniaCore.upsertPin(state.pins || [], { ...pin, name }, PIN_LIMIT);
    if (!r.ok) { toast(`Лимит ${PIN_LIMIT} меток`); return; }
    state.pins = r.pins;
    pinsChanged();
    hideSheet('#pinIncoming');
    toast(r.updated ? '> метка обновлена' : '> метка добавлена');
    showOnMap(false);
  });
  $('#pinIncomingView').addEventListener('click', () => { hideSheet('#pinIncoming'); showOnMap(true); });
  showSheet('#pinIncoming');
  setTimeout(() => { const b = $('#pinIncomingAdd'); if (b) b.focus(); }, 60);
  return true;
}

// вешается из wireUI (app.js): редактор, импорт, экспорт, кнопка «➕»
function wirePinUI() {
  const row = $('#pinEmojiRow');
  PIN_EMOJI.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.emoji = e;
    b.textContent = e;
    b.addEventListener('click', () => selectPinEmoji(e));
    row.appendChild(b);
  });
  $('#btnAddPin').addEventListener('click', () => openPinEditor(null));
  $('#pinFromGps').addEventListener('click', async () => {
    if (await geoDenied()) { toast(geoErrorText({ code: 1 }), 8000); return; }
    try {
      const pos = await getPosition();
      $('#pinCoords').value = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
    } catch (err) { toast(geoErrorText(err), 8000); }
  });
  $('#pinCoords').addEventListener('input', () => {
    const pair = window.InsomniaCore.parseCoordPairs($('#pinCoords').value)[0];
    $('#pinWarn').classList.toggle('hidden', !(pair && window.InsomniaCore.pinOutsideFest(pair)));
  });
  $('#pinSave').addEventListener('click', savePinFromEditor);
  $('#pinImportGo').addEventListener('click', parsePinImportText);
  $('#pinImportApply').addEventListener('click', applyPinImport);
  $('#btnPinsExport').addEventListener('click', exportPinsLine);
  $('#btnPinsImport').addEventListener('click', openPinImport);
  updatePinsInfo();
}

/* ---------- геолокация ---------- */
const IS_IOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

// человеческий текст по коду GeolocationPositionError (1/2/3);
// код 1 — доступ не дан (в т.ч. Яндекс Браузер молча режет запрос в PWA);
// код 0 (наш) — geolocation-API в браузере нет вовсе
function geoErrorText(err) {
  if (err && err.code === 0) {
    return 'В этом браузере нет геолокации. Откройте приложение в Chrome или Safari — карта и «рядом» те же.';
  }
  if (err && err.code === 1) {
    return IS_IOS
      ? 'Браузер не дал доступ к геопозиции. Проверьте: Настройки → Конфиденциальность → Службы геолокации, и разрешение для вашего браузера.'
      : 'Браузер не дал доступ к геопозиции. Проверьте: настройки браузера → сайты → местоположение, и разрешение «Местоположение» у самого браузера в настройках Android.';
  }
  // 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT: GPS продолжает ловиться в фоне —
  // при первом же фиксе список появится сам, «повторить» лишь ускоряет
  return 'Не удалось получить GPS. Проверьте, что геолокация на телефоне включена, и вы не в ' +
    'помещении: первый захват спутников может занять минуту-две под открытым небом.';
}

// разрешение уже отклонено? (когда диалог точно не покажут — говорим об этом сразу)
async function geoDenied() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return false;
    const st = await navigator.permissions.query({ name: 'geolocation' });
    return st.state === 'denied';
  } catch { return false; }
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (GEO.mock) return resolve(GEO.mock);
    if (!navigator.geolocation) return reject({ code: 2 });
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(err),
      // GPS, не сетевое определение — оно без интернета не работает
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

async function locateMe() {
  if (await geoDenied()) { toast(geoErrorText({ code: 1 })); return; }
  try {
    const pos = await getPosition();
    if (!GEO.map) return;
    if (GEO.selfMarker) GEO.selfMarker.remove();
    GEO.selfMarker = L.marker([pos.lat, pos.lng], {
      icon: L.divIcon({ className: 'geo-marker', html: '<div class="geo-self"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(GEO.map);
    GEO.map.setView([pos.lat, pos.lng], Math.max(GEO.map.getZoom(), 16));
  } catch (err) {
    toast(geoErrorText(err), 8000); // текст длинный — даём время прочитать
  }
}

// сворачиваемая подсказка для «рядом» и карты; открытость переживает
// ререндеры (render() пересоздаёт DOM каждые ~10 с при живом GPS)
function geoHelpEl() {
  const d = document.createElement('details');
  d.className = 'geo-help';
  d.innerHTML = `
    <summary>Не работает геолокация?</summary>
    <ul>
      <li><b>Яндекс Браузер</b> капризен с GPS в установленных приложениях. Надёжнее всего
        поставить наше приложение из Chrome — метки, избранное и карта те же.</li>
      <li><b>На поляне:</b> GPS работает без интернета, но первый захват — до пары минут
        под открытым небом.</li>
    </ul>`;
  d.open = !!GEO.helpOpen;
  d.addEventListener('toggle', () => { GEO.helpOpen = d.open; });
  return d;
}

/* ---------- «рядом» ---------- */
const NEARBY_RADII = [150, 300, 600, 0]; // 0 = всё

const POS_FRESH_MS = 5 * 60000; // позиция старше — не «последняя известная», а вчерашняя

const nearbyWatcher = window.InsomniaCore.createGeoWatcher(
  typeof navigator !== 'undefined' ? navigator.geolocation : null,
  pos => {
    GEO.nearby.pos = pos;
    GEO.nearby.posAt = Date.now();
    GEO.nearby.error = null;
    if (state.view === 'nearby') render();
  }, 10000, Date.now,
  err => {
    // свежая позиция есть — молча работаем по ней
    if (GEO.nearby.pos && Date.now() - GEO.nearby.posAt < POS_FRESH_MS) return;
    GEO.nearby.pos = null; // позиция протухла — честно признаём, не рисуем старые метры
    // дедуп: та же ошибка уже на экране — не дёргаем render (не схлопывать подсказку)
    if (GEO.nearby.error && GEO.nearby.error.code === err.code) return;
    GEO.nearby.error = err;
    if (state.view === 'nearby') render();
  });

function startNearbyWatch() {
  if (GEO.mock) { GEO.nearby.pos = GEO.mock; GEO.nearby.posAt = Date.now(); return; }
  if (!(typeof navigator !== 'undefined' && navigator.geolocation)) {
    GEO.nearby.error = { code: 0 }; // API нет вовсе — не молчать вечным «gps --wait»
    return;
  }
  nearbyWatcher.start();
  // разрешение уже отклонено — диалога не будет, честно говорим сразу
  geoDenied().then(denied => {
    if (denied && !GEO.nearby.pos && !GEO.nearby.error) {
      GEO.nearby.error = { code: 1 };
      if (state.view === 'nearby') render();
    }
  });
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
    if (GEO.nearby.error) {
      st.innerHTML = `<span class="big">🛰</span>${escapeHtml(geoErrorText(GEO.nearby.error))}`;
      const retry = document.createElement('button');
      retry.className = 'btn';
      retry.textContent = 'повторить';
      retry.addEventListener('click', () => {
        GEO.nearby.error = null;
        stopNearbyWatch(); // новая подписка = новый запрос позиции
        render();
      });
      st.appendChild(retry);
    } else {
      st.innerHTML = '<span class="big">📡</span>$ gps --wait… Разрешите геолокацию — GPS работает без интернета.';
    }
    root.appendChild(st);
    root.appendChild(geoHelpEl());
    return;
  }

  const now = getNow();
  const items = getNearby(GEO.data.points.filter(p => p.category !== 'service'),
    state.program.events, GEO.nearby.pos, now, GEO.nearby.radius);

  // свои метки — первым блоком (лагерь/машина важнее чужих туалетов)
  const dM = window.InsomniaCore.distanceM;
  const myNear = (state.pins || [])
    .map(p => ({ ...p, dist: dM(GEO.nearby.pos, p) }))
    .filter(p => !GEO.nearby.radius || p.dist <= GEO.nearby.radius)
    .sort((a, b) => a.dist - b.dist);
  if (myNear.length) {
    const head = document.createElement('div');
    head.className = 'time-group-label';
    head.textContent = 'мои метки';
    root.appendChild(head);
    myNear.forEach(p => {
      const el = document.createElement('div');
      el.className = 'map-point';
      el.innerHTML = `
        <div class="map-point-name">
          <span><span class="pin-my pin-inline">${escapeHtml(p.emoji || '📍')}</span> ${escapeHtml(p.name || 'без названия')}</span>
          <span class="muted small">${p.dist} м ${bearingLabel(GEO.nearby.pos, p)}</span>
        </div>`;
      el.addEventListener('click', () => {
        switchView('map');
        setTimeout(() => {
          if (!GEO.map) return;
          GEO.map.setView([p.lat, p.lng], Math.max(GEO.map.getZoom(), 17));
          openPinCard(p);
        }, 250);
      });
      root.appendChild(el);
    });
  }

  if (!items.length) {
    if (!myNear.length) {
      const st = emptyState('🌾', 'В этом радиусе пусто. Расширьте круг или загляните в программу.');
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'к программе';
      btn.addEventListener('click', () => switchView('schedule'));
      st.appendChild(btn);
      root.appendChild(st);
    }
    root.appendChild(geoHelpEl());
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
  root.appendChild(geoHelpEl());
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
  GEO.preview = null;
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
