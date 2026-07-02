/* Бессонница 2026 — офлайн-программа фестиваля.
   Vanilla PWA: no build step, works fully offline once cached. */
'use strict';

const LS = {
  favs: 'insomnia.favs',
  lead: 'insomnia.leadMinutes',
  program: 'insomnia.program',      // imported/updated program JSON
  notified: 'insomnia.notified',    // ids already notified (in-app scheduler dedup)
  urlSrc: 'insomnia.updateUrl',
};

const state = {
  program: null,
  map: null,          // data/map.json: слои карты + матчинг площадок
  view: 'now',
  day: null,          // ISO date string
  type: 'all',        // all | program | animation
  query: '',
  favs: new Set(),
  lead: 15,
  deferredInstall: null,
  swReg: null,
  sim: null,          // {anchor, setAt} — симуляция времени (?now=)
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/* ---------- helpers ---------- */
function fnv1a(str) {
  const bytes = new TextEncoder().encode(str);
  let h = 2166136261;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ---------- время: единая модель ----------
   Всё расписание — в московском времени (UTC+3, без DST). Сравнения — только
   по эпохам (мс UTC), никогда по локальным строкам часов: телефон может быть
   в любой таймзоне. getNow() — единственный источник «сейчас» (поддерживает
   симуляцию ?now=). Фестивальные сутки: 06:00 → 05:59 следующего дня. */
const MSK_MS = 3 * 3600 * 1000;
const DAY_CUTOFF = 6;
const pad2 = x => String(x).padStart(2, '0');

function epochFromISO(iso) {
  // наивная московская ISO-строка -> эпоха
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - MSK_MS;
}
function mskOf(ms) {
  // компоненты московского времени для эпохи
  const d = new Date(ms + MSK_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(),
           h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
function getNow() {
  if (state.sim) return state.sim.anchor + (Date.now() - state.sim.setAt);
  return Date.now();
}
function getFestivalDay(ms) {
  const p = mskOf(ms - DAY_CUTOFF * 3600 * 1000);
  return `${p.y}-${pad2(p.mo + 1)}-${pad2(p.day)}`;
}
function fmtClock(ms) {
  const p = mskOf(ms);
  return `${WD[p.dow]} ${p.day} ${MON[p.mo]} · ${pad2(p.h)}:${pad2(p.mi)} мск`;
}
function fmtSim(ms) {
  const p = mskOf(ms);
  return `${p.day} ${MON[p.mo]}, ${pad2(p.h)}:${pad2(p.mi)}`;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function loadFavs() {
  try { state.favs = new Set(JSON.parse(localStorage.getItem(LS.favs) || '[]')); }
  catch { state.favs = new Set(); }
}
function saveFavs() { localStorage.setItem(LS.favs, JSON.stringify([...state.favs])); }

function getNotified() {
  try { return new Set(JSON.parse(localStorage.getItem(LS.notified) || '[]')); }
  catch { return new Set(); }
}
function setNotified(set) { localStorage.setItem(LS.notified, JSON.stringify([...set])); }

/* ---------- data loading ---------- */
function decorateProgram(p) {
  (p.events || []).forEach(e => {
    e._startMs = epochFromISO(e.startISO);
    e._endMs = epochFromISO(e.endISO);
    e._festDay = e._startMs != null ? getFestivalDay(e._startMs) : e.date;
  });
  // дни пересчитываем из событий (фестивальный день вычисляется, не хранится)
  const days = [...new Set((p.events || []).map(e => e._festDay).filter(Boolean))].sort();
  p._days = days;
  return p;
}

async function loadProgram() {
  // Prefer a user-imported/updated program, else the bundled file.
  const stored = localStorage.getItem(LS.program);
  if (stored) {
    try {
      const p = JSON.parse(stored);
      if (p && Array.isArray(p.events) && p.events.length) return p;
    } catch { /* fall through */ }
  }
  const res = await fetch('data/program.json', { cache: 'no-cache' });
  return res.json();
}

async function loadMap() {
  try {
    const res = await fetch('data/map.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function eventById(id) { return state.program.events.find(e => e.id === id); }
function venuePoint(venue) {
  return state.map && state.map.venuePoints ? state.map.venuePoints[venue] : null;
}
function gmapsUrl(pt) {
  return `https://www.google.com/maps/search/?api=1&query=${pt.lat},${pt.lng}`;
}

/* ---------- rendering ---------- */
function eventTypeLabel(t) { return t === 'animation' ? 'Анимация' : 'Программа'; }

function statusOf(e) {
  const s = e._startMs, en = e._endMs;
  const n = getNow();
  if (s != null && en != null && n >= s && n < en) return 'live';
  if (s != null && en != null && n >= en) return 'past';
  if (s != null && en == null && n >= s) return 'past';
  const mins = s != null ? (s - n) / 60000 : Infinity;
  if (mins > 0 && mins <= 30) return 'soon';
  if (s != null && n >= s) return 'past';
  return 'upcoming';
}

function nightInfo(e) {
  // событие «после полуночи» (00:00–05:59 мск) — ночь предыдущего фест-дня
  if (e._startMs == null) return null;
  const p = mskOf(e._startMs);
  if (p.h >= DAY_CUTOFF) return null;
  return { marker: `🌙 ночь на ${WD[p.dow]}` };
}

function eventCard(e) {
  const st = statusOf(e);
  const fav = state.favs.has(e.id);
  const el = document.createElement('div');
  el.className = `event type-${e.type} ${st === 'live' ? 'is-live' : ''} ${st === 'past' ? 'is-past' : ''}`;
  el.dataset.id = e.id;

  const timeStr = e.end ? `${e.start}–${e.end}` : e.start;
  const night = nightInfo(e);
  let tag = '';
  if (st === 'live') tag = '<span class="live-tag">сейчас</span>';
  else if (st === 'soon') {
    const mins = Math.max(1, Math.round((e._startMs - getNow()) / 60000));
    tag = `<span class="soon-tag">через ${mins} мин</span>`;
  }
  if (night) tag += ` <span class="night-tag">${night.marker}</span>`;

  const desc = e.description || (e.films && e.films.length ? e.films.join(', ') : '');
  el.innerHTML = `
    <div class="event-main">
      <div class="event-time">${timeStr} ${tag}</div>
      <div class="event-title">${escapeHtml(e.title)}</div>
      <div class="event-meta">
        <span class="venue-pill">📍 ${escapeHtml(e.venue || '—')}</span>
        ${e.age ? `<span class="age-pill">${escapeHtml(e.age)}</span>` : ''}
        <span class="type-pill muted">${eventTypeLabel(e.type)}</span>
      </div>
      ${desc ? `<div class="event-desc-preview">${escapeHtml(desc)}</div>` : ''}
    </div>
    <button class="fav-btn ${fav ? 'on' : ''}" aria-label="В избранное">${fav ? '★' : '☆'}</button>
  `;
  el.querySelector('.event-main').addEventListener('click', () => openDetail(e.id));
  el.querySelector('.fav-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleFav(e.id);
  });
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function filteredEvents() {
  let evs = state.program.events;
  if (state.type !== 'all') evs = evs.filter(e => e.type === state.type);
  if (state.query) {
    const q = state.query.toLowerCase();
    evs = evs.filter(e =>
      e.title.toLowerCase().includes(q) ||
      (e.venue || '').toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q) ||
      (e.films || []).some(f => f.toLowerCase().includes(q))
    );
  }
  return evs;
}

function liveFavCount() {
  // считаем только избранное, которое существует в текущей программе —
  // после обновления данных часть id может осиротеть
  let n = 0;
  state.program.events.forEach(e => { if (state.favs.has(e.id)) n++; });
  return n;
}

function render() {
  $('#favBadge').textContent = liveFavCount();
  const content = $('#content');
  content.innerHTML = '';
  $('#filters').classList.toggle('hidden', state.view === 'favorites' || state.view === 'map');

  if (state.view === 'now') return renderNow(content);
  if (state.view === 'schedule') return renderSchedule(content);
  if (state.view === 'favorites') return renderFavorites(content);
  if (state.view === 'map') return renderMap(content);
}

function renderMap(root) {
  if (!state.map || !state.map.layers || !state.map.layers.length) {
    root.appendChild(emptyState('🗺', 'Карта ещё не загружена. Обновите программу онлайн — и она появится офлайн.'));
    return;
  }
  const q = state.query.toLowerCase();
  const head = document.createElement('div');
  head.className = 'update-banner';
  head.innerHTML = `<span>🗺 ${escapeHtml(state.map.title || 'Карта фестиваля')}</span>`;
  const openBtn = document.createElement('a');
  openBtn.className = 'map-link';
  openBtn.href = state.map.mapUrl;
  openBtn.target = '_blank';
  openBtn.rel = 'noopener';
  openBtn.textContent = 'открыть в Google Maps';
  head.appendChild(openBtn);
  root.appendChild(head);

  let shown = 0;
  state.map.layers.forEach(layer => {
    let pts = layer.points;
    if (q) pts = pts.filter(p => p.name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q));
    if (!pts.length) return;
    shown += pts.length;
    const wrap = document.createElement('div');
    wrap.className = 'map-layer';
    wrap.appendChild(groupLabel(`${layer.name} (${pts.length})`));
    // туалеты и прочие безымянные дубли — компактно нумеруем
    const nameCount = {};
    pts.forEach(p => { nameCount[p.name] = (nameCount[p.name] || 0) + 1; });
    const seen = {};
    pts.forEach(p => {
      let label = p.name;
      if (nameCount[p.name] > 1) {
        seen[p.name] = (seen[p.name] || 0) + 1;
        label = `${p.name} №${seen[p.name]}`;
      }
      const el = document.createElement('div');
      el.className = 'map-point';
      el.innerHTML = `
        <div class="map-point-name">
          <span>${escapeHtml(label)}</span>
          <a class="map-link" target="_blank" rel="noopener" href="${gmapsUrl(p)}">📍 маршрут</a>
        </div>
        ${p.desc ? `<div class="map-point-desc">${escapeHtml(p.desc)}</div>` : ''}
      `;
      wrap.appendChild(el);
    });
    root.appendChild(wrap);
  });
  if (!shown) root.appendChild(emptyState('🔍', '$ grep: на карте ничего не найдено.'));
}

function renderNow(root) {
  const n = getNow();
  const evs = filteredEvents().filter(e => e._startMs != null).sort(sortByStart);
  const live = evs.filter(e => statusOf(e) === 'live');
  const upcoming = evs.filter(e => e._startMs > n);

  const first = evs[0] ? evs[0]._startMs : null;
  const lastEv = evs[evs.length - 1];
  const last = lastEv ? (lastEv._endMs || lastEv._startMs) : null;

  if (first && n < first) {
    const days = Math.ceil((first - n) / 86400000);
    root.appendChild(banner(`$ sleep ${days}d && ./фестиваль — до старта ${days} дн. 🌙`));
  } else if (last && n > last) {
    root.appendChild(banner('Фестиваль завершён. Спасибо, что были с нами! ✨'));
  }

  if (live.length) {
    root.appendChild(groupLabel(`🔴 Идёт сейчас (${live.length})`));
    live.forEach(e => root.appendChild(eventCard(e)));
  }

  const soon = upcoming.slice(0, 40);
  if (soon.length) {
    root.appendChild(groupLabel('⏭ Далее'));
    let lastDay = null;
    soon.forEach(e => {
      if (e._festDay !== lastDay) { lastDay = e._festDay; root.appendChild(dayHeading(e._festDay)); }
      root.appendChild(eventCard(e));
    });
  }

  if (!live.length && !soon.length) {
    root.appendChild(emptyState('🌙', '$ ps aux | grep событие → пусто. Спокойной ночи.'));
  }
}

function renderSchedule(root) {
  buildDayStrip();
  if (!state.day) state.day = pickDefaultDay();
  const evs = filteredEvents()
    .filter(e => e._festDay === state.day)
    .sort(sortByStart);

  if (!evs.length) {
    root.appendChild(emptyState('🔍', '$ grep: ничего не найдено по фильтру.'));
    return;
  }

  const n = getNow();
  // Разделитель «сейчас» — только если день реально пересекает момент.
  const hasPast = evs.some(e => e._startMs <= n);
  const hasFuture = evs.some(e => e._startMs > n);
  const showDivider = hasPast && hasFuture;
  let injectedNow = false;
  let injectedNight = false;
  evs.forEach(e => {
    if (!injectedNight && nightInfo(e)) {
      root.appendChild(nightDivider());
      injectedNight = true;
    }
    if (showDivider && !injectedNow && e._startMs > n) {
      root.appendChild(nowDivider());
      injectedNow = true;
    }
    root.appendChild(eventCard(e));
  });
}

function renderFavorites(root) {
  const favs = state.program.events
    .filter(e => state.favs.has(e.id) && e._startMs != null)
    .sort(sortByStart);

  if (!favs.length && state.favs.size === favs.length) {
    root.appendChild(emptyState('☆', 'Пока ничего не выбрано. Нажмите ☆ у события, чтобы добавить и получить напоминание.'));
    return;
  }

  const n = getNow();
  const showDivider = favs.some(e => e._startMs <= n) && favs.some(e => e._startMs > n);
  let lastDay = null;
  let injectedNow = false;
  favs.forEach(e => {
    if (e._festDay !== lastDay) { lastDay = e._festDay; root.appendChild(dayHeading(e._festDay)); }
    if (showDivider && !injectedNow && e._startMs > n) { root.appendChild(nowDivider()); injectedNow = true; }
    root.appendChild(eventCard(e));
  });

  // осиротевшее избранное: события исчезли/изменились при обновлении программы
  const orphanCount = state.favs.size - favs.length;
  if (orphanCount > 0) {
    const orphanNote = document.createElement('div');
    orphanNote.className = 'update-banner';
    orphanNote.innerHTML = `<span>⚠️ ${orphanCount} отмеченных событий больше нет в программе (расписание обновилось).</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Убрать';
    btn.addEventListener('click', () => {
      const ids = new Set(state.program.events.map(e => e.id));
      state.favs = new Set([...state.favs].filter(id => ids.has(id)));
      saveFavs();
      render();
    });
    orphanNote.appendChild(btn);
    root.appendChild(orphanNote);
  }

  const info = document.createElement('p');
  info.className = 'muted small center';
  info.style.marginTop = '16px';
  info.textContent = Notification && Notification.permission === 'granted'
    ? `Напоминания включены: за ${state.lead} мин до начала.`
    : 'Включите уведомления в настройках, чтобы получать напоминания.';
  root.appendChild(info);
}

function sortByStart(a, b) {
  return (a._startMs ?? Infinity) - (b._startMs ?? Infinity) || (a.venue || '').localeCompare(b.venue || '');
}

function groupLabel(text) {
  const d = document.createElement('div');
  d.className = 'time-group-label';
  d.textContent = text;
  return d;
}
function dayHeading(iso) {
  const d = document.createElement('div');
  d.className = 'time-group-label';
  const p = mskOf(epochFromISO(iso + 'T12:00') );
  d.textContent = `${WD[p.dow]}, ${p.day} ${MON[p.mo]}`;
  return d;
}
function nightDivider() {
  const d = document.createElement('div');
  d.className = 'now-divider night';
  d.textContent = '🌙 после полуночи';
  return d;
}
function nowDivider() {
  const d = document.createElement('div');
  d.className = 'now-divider';
  d.textContent = 'сейчас';
  return d;
}
function banner(text) {
  const d = document.createElement('div');
  d.className = 'update-banner';
  d.innerHTML = `<span>${escapeHtml(text)}</span>`;
  return d;
}
function emptyState(icon, text) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = `<span class="big">${icon}</span>${escapeHtml(text)}`;
  return d;
}

/* ---------- day strip ---------- */
function buildDayStrip() {
  const strip = $('#dayStrip');
  strip.innerHTML = '';
  (state.program._days || []).forEach(date => {
    const p = mskOf(epochFromISO(date + 'T12:00'));
    const btn = document.createElement('button');
    btn.className = 'day-btn' + (date === state.day ? ' active' : '');
    btn.innerHTML = `<span class="dow">${WD[p.dow]}</span><span>${p.day} ${MON[p.mo]}</span>`;
    btn.addEventListener('click', () => { state.day = date; render(); });
    strip.appendChild(btn);
  });
}

function pickDefaultDay() {
  // активный фестивальный день: в 02:00 ночи пн это ещё «вс»
  const today = getFestivalDay(getNow());
  const days = state.program._days || [];
  if (days.includes(today)) return today;
  const future = days.find(d => d >= today);
  return future || days[0];
}

/* ---------- detail sheet ---------- */
function openDetail(id) {
  const e = eventById(id);
  if (!e) return;
  const fav = state.favs.has(id);
  const night = nightInfo(e);
  const timeStr = (e.end ? `${e.start}–${e.end}` : e.start) + (night ? ` · ${night.marker}` : '');
  const p = mskOf(epochFromISO(e._festDay + 'T12:00'));
  const dateStr = `${WD[p.dow]}, ${p.day} ${MON[p.mo]} 2026`;
  const pt = venuePoint(e.venue);
  const vinfo = state.program.venueInfo
    ? state.program.venueInfo[e.venue] || state.program.venueInfo[(e.venue || '').split(' / ')[0]]
    : null;
  const filmItems = (e.filmDetails && e.filmDetails.length)
    ? e.filmDetails.map(f => `<li><div class="film-title">${escapeHtml(f.title)}</div>${f.plot ? `<div class="film-plot">${escapeHtml(f.plot)}</div>` : ''}</li>`).join('')
    : (e.films || []).map(f => `<li><div class="film-title">${escapeHtml(f)}</div></li>`).join('');
  const body = $('#sheetBody');
  body.innerHTML = `
    <div class="detail-time">${dateStr} · ${timeStr}</div>
    <div class="detail-title">${escapeHtml(e.title)}</div>
    <div class="detail-meta">
      <span class="tag">📍 ${escapeHtml(e.venue || '—')}</span>
      ${e.age ? `<span class="tag">${escapeHtml(e.age)}</span>` : ''}
      <span class="tag">${eventTypeLabel(e.type)}</span>
      ${pt ? `<a class="tag" target="_blank" rel="noopener" href="${gmapsUrl(pt)}">🧭 на карте</a>` : ''}
    </div>
    ${e.description ? `<div class="detail-desc">${escapeHtml(e.description)}</div>` : ''}
    ${filmItems ? `
      <div class="detail-section detail-films">
        <h4>ls фильмы/ (${(e.filmDetails || e.films).length})</h4>
        <ul>${filmItems}</ul>
      </div>` : ''}
    ${e.participants && e.participants.length ? `
      <div class="detail-section">
        <h4>кто ведёт</h4>
        ${e.participants.map(p => `<div class="participant"><div class="p-name">${escapeHtml(p.name)}</div>${p.bio ? `<div class="p-bio">${escapeHtml(p.bio)}</div>` : ''}</div>`).join('')}
      </div>` : ''}
    ${vinfo ? `
      <div class="detail-section">
        <h4>о площадке</h4>
        <div class="venue-about">${escapeHtml(vinfo)}</div>
      </div>` : ''}
    <div class="detail-actions">
      <button class="btn ${fav ? 'ghost' : ''}" id="detailFav">${fav ? '★ В избранном' : '☆ Напомнить и добавить'}</button>
    </div>
  `;
  $('#detailFav').addEventListener('click', () => {
    toggleFav(id);
    openDetail(id); // refresh button
  });
  showSheet('#sheet');
}

function showSheet(sel) { $(sel).classList.remove('hidden'); }
function hideSheet(sel) { $(sel).classList.add('hidden'); }

/* ---------- favorites ---------- */
function isStandalone() {
  // тот же детект, что и для установочной логики: PWA с главного экрана
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function showInstallGate() {
  $('#gateHint').classList.add('hidden');
  showSheet('#installGate');
}

function toggleFav(id) {
  // во вкладке браузера избранное не сохраняем — зовём к установке:
  // офлайн на поле работает только у установленного приложения
  if (!isStandalone()) { showInstallGate(); return; }
  if (state.favs.has(id)) {
    state.favs.delete(id);
    cancelNotification(id);
    toast('> seat released.');
  } else {
    state.favs.add(id);
    toast('> seat acquired. напомним за ' + state.lead + ' мин ⏰');
    scheduleNotification(id);
  }
  saveFavs();
  render();
}

/* ---------- notifications ---------- */
function notifText(e) {
  return {
    title: `Скоро: ${e.title}`,
    body: `${e.start} · ${e.venue || ''}`.trim(),
  };
}

async function requestNotifications() {
  if (!('Notification' in window)) { toast('Уведомления не поддерживаются'); return false; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  updateNotifStatus();
  if (perm === 'granted') {
    // (re)schedule all current favorites
    state.favs.forEach(scheduleNotification);
    toast('> уведомления: ok ✅');
    return true;
  }
  toast('Уведомления отклонены');
  return false;
}

function supportsTrigger() {
  return 'Notification' in window && 'showTrigger' in Notification.prototype && !!state.swReg;
}

async function scheduleNotification(id) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const e = eventById(id);
  if (!e || e._startMs == null) return;
  const when = e._startMs - state.lead * 60000; // всегда реальное время события
  if (when <= Date.now()) return; // too late / already started
  const { title, body } = notifText(e);

  // Best case: OS-scheduled trigger that fires even when the app is closed.
  if (supportsTrigger()) {
    try {
      await state.swReg.showNotification(title, {
        body,
        tag: 'ev-' + id,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        data: { id, url: './' },
        showTrigger: new TimestampTrigger(when),
      });
      return;
    } catch (err) { /* fall back to in-app timer */ }
  }
  // Fallback handled by the in-app polling scheduler (runs while app is open).
}

async function cancelNotification(id) {
  if (!state.swReg) return;
  try {
    const notes = await state.swReg.getNotifications({ tag: 'ev-' + id, includeTriggered: false });
    notes.forEach(n => n.close());
  } catch { /* ignore */ }
  const notified = getNotified();
  notified.delete(id);
  setNotified(notified);
}

// In-app safety-net scheduler: while the app is open, poll favorites and fire
// a notification when we cross the lead-time threshold. Deduped via LS.notified.
function pollNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (supportsTrigger()) return; // OS triggers already cover it
  const notified = getNotified();
  const t = getNow(); // симуляция позволяет тестировать напоминания
  let changed = false;
  state.favs.forEach(id => {
    if (notified.has(id)) return;
    const e = eventById(id);
    if (!e || e._startMs == null) return;
    const start = e._startMs;
    const fireAt = start - state.lead * 60000;
    if (t >= fireAt && t < start) {
      const { title, body } = notifText(e);
      try {
        if (state.swReg) state.swReg.showNotification(title, { body, tag: 'ev-' + id, icon: 'icons/icon-192.png' });
        else new Notification(title, { body, icon: 'icons/icon-192.png' });
      } catch { /* ignore */ }
      notified.add(id);
      changed = true;
    } else if (t >= start) {
      notified.add(id); // missed window; don't fire late
      changed = true;
    }
  });
  if (changed) setNotified(notified);
}

function updateNotifStatus() {
  const el = $('#notifStatus');
  if (!('Notification' in window)) { el.textContent = 'Браузер не поддерживает уведомления.'; return; }
  const p = Notification.permission;
  const bg = supportsTrigger() ? ' Работают и в фоне (по расписанию ОС).' : ' Работают, пока приложение открыто/свёрнуто.';
  el.textContent = p === 'granted' ? 'Разрешены.' + bg
    : p === 'denied' ? 'Запрещены в настройках браузера.' : 'Не запрошены.';
  $('#btnEnableNotif').textContent = p === 'granted' ? 'Уведомления включены ✓' : 'Разрешить уведомления';
}

/* ---------- версия данных ---------- */
function fmtDataVersion(iso) {
  const ms = Date.parse(iso);
  if (!ms) return iso || '—';
  const p = mskOf(ms);
  return `${p.day} ${['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][p.mo]}, ${pad2(p.h)}:${pad2(p.mi)}`;
}

function noteDataVersion(p, { quietFirstRun = false } = {}) {
  const v = p && p.meta && p.meta.version;
  const el = $('#dataVersion');
  if (el) el.textContent = v ? `от ${fmtDataVersion(v)}` : '';
  if (!v) return;
  const seen = localStorage.getItem('insomnia.seenVersion');
  if (seen && seen !== v && !quietFirstRun) toast('Расписание обновлено', 2000);
  if (!seen || seen !== v) localStorage.setItem('insomnia.seenVersion', v);
}

/* ---------- import / update ---------- */
// Normalize a parsed workbook (SheetJS) into our program shape.
// Mirrors scripts/convert_xlsx.py.
const EXPORT_URL = 'https://insomniafest.ru/export/program/2026';
const MSK_OFFSET = 3 * 3600;      // фестиваль живёт по Москве (UTC+3)
const ROLLOVER = DAY_CUTOFF;      // фестивальные сутки: 06:00 -> 05:59

function mskParts(ts) {
  const d = new Date((Number(ts) + MSK_OFFSET) * 1000);
  const pad = x => String(x).padStart(2, '0');
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(),
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`,
    utcms: d.getTime(),
  };
}
function festDateOf(ts) {
  const d = new Date((Number(ts) + MSK_OFFSET - ROLLOVER * 3600) * 1000);
  const pad = x => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function unescapeHtmlEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = String(s || '');
  return el.value;
}
function cleanText(v) {
  return normalizeText(unescapeHtmlEntities(v));
}

// Зеркало convert_export() из scripts/scrape_site.py — чтобы кнопка
// «Обновить программу» могла разобрать экспорт сайта прямо в браузере.
function exportToProgram(data) {
  const events = [];
  const venueInfo = {};
  const mkEnd = (startTs, endTs) => {
    if (!String(endTs || '').match(/^\d+$/)) return null;
    const s = mskParts(startTs);
    const e = mskParts(endTs);
    // время конца привязываем к дате начала (+1 день для послеполуночных)
    let endMs = Date.UTC(s.y, s.mo - 1, s.day, e.h, e.mi);
    const startMs = Date.UTC(s.y, s.mo - 1, s.day, s.h, s.mi);
    if (endMs <= startMs) endMs += 86400000;
    if (endMs - startMs > 16 * 3600000) return null;
    return new Date(endMs);
  };
  const pushEvent = (kind, title, venue, startTs, endTs, extra) => {
    title = cleanText(title);
    venue = cleanText(venue);
    if (!title || !String(startTs || '').match(/^\d+$/)) return;
    const s = mskParts(startTs);
    const endD = mkEnd(startTs, endTs);
    const pad = x => String(x).padStart(2, '0');
    const date = festDateOf(startTs);
    const ev = {
      id: fnv1a([kind, date, s.hhmm, venue, title].join('|')),
      type: kind, date, start: s.hhmm,
      end: endD ? `${pad(endD.getUTCHours())}:${pad(endD.getUTCMinutes())}` : null,
      startISO: s.iso,
      endISO: endD ? `${endD.getUTCFullYear()}-${pad(endD.getUTCMonth() + 1)}-${pad(endD.getUTCDate())}T${pad(endD.getUTCHours())}:${pad(endD.getUTCMinutes())}:00` : null,
      venue, title,
      description: extra.description || '', films: extra.films || [], age: cleanText(extra.age),
    };
    if (extra.filmDetails) ev.filmDetails = extra.filmDetails;
    if (extra.participants) ev.participants = extra.participants;
    events.push(ev);
  };
  (data.places || []).forEach(place => {
    const base = normalizeVenue(unescapeHtmlEntities(place.placeName));
    const pdesc = cleanText(place.placeDescription);
    // ключ — как итоговый event.venue (двойной unescape), паритет с Python
    if (base && pdesc) venueInfo[cleanText(base)] = pdesc;
    (place.placeEvents || []).forEach(e => {
      const loc = cleanText(e.eventLocationPlace);
      const venue = loc && loc.toLowerCase() !== 'none' ? `${base} / ${loc}` : base;
      const participants = Array.isArray(e.eventParticipants)
        ? e.eventParticipants.map(p => ({ name: cleanText(p.participantName), bio: cleanText(p.participantBio) })).filter(p => p.name)
        : [];
      pushEvent('program', e.eventTitle, venue, e.eventStart, e.eventEnd, {
        description: cleanText(e.eventDescription), age: e.eventAge,
        participants: participants.length ? participants : undefined,
      });
    });
  });
  (data.screens || []).forEach(screen => {
    const sname = normalizeVenue(unescapeHtmlEntities(screen.screenName));
    (screen.screenPrograms || []).forEach(pr => {
      const films = [];
      const filmDetails = [];
      (Array.isArray(pr.programFilms) ? pr.programFilms : []).forEach(f => {
        const t = cleanText(f.title);
        if (!t) return;
        films.push(t);
        filmDetails.push({ title: t, plot: cleanText(f.plot) });
      });
      pushEvent('animation', pr.programTitle, sname, pr.programStart, pr.programEnd, {
        age: pr.programAge, films, filmDetails: filmDetails.length ? filmDetails : undefined,
      });
    });
  });
  events.sort((a, b) => (a.startISO || '').localeCompare(b.startISO || '') || a.venue.localeCompare(b.venue));
  const dates = [...new Set(events.map(e => e.date))].sort();
  const monthsGen = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const days = dates.map(d => {
    const dt = new Date(d + 'T00:00:00');
    return { date: d, label: `${dt.getDate()} ${monthsGen[dt.getMonth()]}` };
  });
  return {
    festival: 'Бессонница 2026', year: YEAR, source: EXPORT_URL, version: 2,
    meta: { version: new Date().toISOString().slice(0, 19) + 'Z', source: 'insomniafest.ru (direct)' },
    days, venues: [...new Set(events.map(e => e.venue).filter(Boolean))].sort(),
    venueInfo, events, importedAt: new Date().toISOString(),
  };
}

const MONTHS_RU = { 'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,'июля':7,'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12 };
const NIGHT_ROLLOVER_HOUR = DAY_CUTOFF;
const YEAR = 2026;

function parseSheetDate(sheetName, titleCell) {
  const text = `${sheetName} ${titleCell || ''}`.toLowerCase();
  const m = text.match(/(\d{1,2})\s+([а-яё]+)/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MONTHS_RU[m[2]];
  if (!mon) return null;
  return new Date(YEAR, mon - 1, day);
}
function parseTimeRange(raw) {
  if (!raw) return [null, null];
  const s = String(raw).replace(/[–—]/g, '-');
  const times = (s.match(/\d{1,2}:\d{2}/g) || []).map(t => {
    const [h, m] = t.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  });
  return [times[0] || null, times[1] || null];
}
function toISO(base, hhmm) {
  if (!hhmm) return null;
  const h = parseInt(hhmm.slice(0, 2), 10), m = parseInt(hhmm.slice(3), 10);
  const d = new Date(base.getTime());
  d.setHours(h, m, 0, 0);
  if (h < NIGHT_ROLLOVER_HOUR) d.setDate(d.getDate() + 1);
  const pad = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function normalizeText(v) {
  // зеркалит clean_text() из scripts/scrape_site.py — иначе id разойдутся
  return String(v || '')
    .replace(/\ufeff/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2028/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0085/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function normalizeVenue(v) {
  const s = normalizeText(v);
  const letters = s.toLowerCase().replace(/[^а-яёa-z]/g, '');
  if (letters && [...letters].every(ch => 'тсц'.includes(ch))) return 'Сцена (уточняется)';
  return s;
}
function detectKind(titleCell) {
  const t = (titleCell || '').toLowerCase();
  if (t.includes('неанимац')) return 'program';
  if (t.includes('анимац')) return 'animation';
  return null;
}

function workbookToProgram(workbooks) {
  // workbooks: array of {wb, fallbackKind}
  const events = [];
  const daysMap = {};
  for (const { wb, fallbackKind } of workbooks) {
    wb.SheetNames.forEach(sheetName => {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rows.length) return;
      const titleCell = (rows[0] && rows[0][0]) ? String(rows[0][0]) : '';
      const kind = detectKind(titleCell) || fallbackKind;
      const base = parseSheetDate(sheetName, titleCell);
      if (!base) return;
      const pad = x => String(x).padStart(2, '0');
      const dateIso = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
      daysMap[dateIso] = { date: dateIso, label: sheetName.trim() };
      for (let i = 2; i < rows.length; i++) {
        const r = rows[i] || [];
        const timeRaw = normalizeText(r[0]);
        const place = normalizeVenue(r[1]);
        const title = normalizeText(r[2]);
        const desc = normalizeText(r[3]);
        const age = normalizeText(r[4]);
        const [start, end] = parseTimeRange(timeRaw);
        if (!start || !title) continue;
        const startISO = toISO(base, start);
        let endISO = end ? toISO(base, end) : null;
        if (endISO && startISO && endISO <= startISO) {
          const d = new Date(endISO); d.setDate(d.getDate() + 1);
          endISO = d.toISOString().slice(0, 19);
        }
        const films = kind === 'animation' ? desc.split(',').map(x => x.trim()).filter(Boolean) : [];
        const description = kind === 'animation' ? '' : desc;
        events.push({
          id: fnv1a([kind, dateIso, start, place, title].join('|')),
          type: kind, date: dateIso, start, end,
          startISO, endISO, venue: place, title, description, films, age,
        });
      }
    });
  }
  events.sort((a, b) => (a.startISO || '').localeCompare(b.startISO || '') || a.venue.localeCompare(b.venue));
  const days = Object.values(daysMap).sort((a, b) => a.date.localeCompare(b.date));
  const venues = [...new Set(events.map(e => e.venue).filter(Boolean))].sort();
  return { festival: 'Бессонница 2026', year: YEAR, version: (state.program?.version || 1) + 1, days, venues, events, importedAt: new Date().toISOString() };
}

async function importFromFiles(fileList) {
  if (!window.XLSX) { toast('Библиотека чтения Excel не загрузилась'); return; }
  const files = Array.from(fileList);
  const workbooks = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    // guess a fallback kind from filename
    const name = f.name.toLowerCase();
    const fallbackKind = name.includes('неанима') || name.includes('nonanim') || name.includes('program') ? 'program'
      : name.includes('анима') || name.includes('anim') ? 'animation' : null;
    workbooks.push({ wb, fallbackKind });
  }
  const program = workbookToProgram(workbooks);
  applyImportedProgram(program, `Загружено ${program.events.length} событий из ${files.length} файла(ов)`);
}

async function importFromUrl(url) {
  $('#importStatus').textContent = 'Загрузка…';
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const program = workbookToProgram([{ wb, fallbackKind: null }]);
    localStorage.setItem(LS.urlSrc, url);
    applyImportedProgram(program, `Обновлено по ссылке: ${program.events.length} событий`);
  } catch (err) {
    $('#importStatus').textContent = 'Ошибка: ' + err.message + '. Возможно, сайт блокирует загрузку (CORS) — скачайте файл и загрузите вручную.';
  }
}

function applyImportedProgram(program, msg, persist = true) {
  if (!program.events || !program.events.length) { $('#importStatus').textContent = 'В файле не найдено событий.'; return; }
  // persist=false — данные пришли из встроенного data/program.json (сервер),
  // локальная импорт-копия больше не нужна и не должна его перекрывать.
  if (persist) localStorage.setItem(LS.program, JSON.stringify(program));
  else localStorage.removeItem(LS.program);
  state.program = decorateProgram(program);
  // избранное НЕ чистим: осиротевшие отметки живут в плашке «избранного»
  // и переживают откат/повтор обновления данных
  state.day = null;
  localStorage.removeItem(LS.notified);
  if (Notification && Notification.permission === 'granted') state.favs.forEach(scheduleNotification);
  $('#importStatus').textContent = msg;
  noteDataVersion(program);
  updateDataInfo();
  toast(msg);
  render();
}

async function refreshMapQuiet() {
  const m = await loadMap();
  if (m) { state.map = m; if (state.view === 'map') render(); }
}

function resetData() {
  localStorage.removeItem(LS.program);
  localStorage.removeItem(LS.notified);
  loadProgram().then(p => {
    state.program = decorateProgram(p);
    const ids = new Set(p.events.map(e => e.id));
    state.favs = new Set([...state.favs].filter(id => ids.has(id)));
    saveFavs();
    state.day = null;
    updateDataInfo();
    toast('Возвращена встроенная версия');
    render();
  });
}

function updateDataInfo() {
  const p = state.program;
  const src = localStorage.getItem(LS.program) ? 'обновлённая (импорт)' : 'встроенная';
  const when = p.importedAt ? new Date(p.importedAt).toLocaleString('ru-RU') : '—';
  $('#dataInfo').innerHTML = `Событий: <b>${p.events.length}</b> · дней: ${p.days.length}<br>Источник: ${src}${p.importedAt ? ' · ' + when : ''}`;
  const savedUrl = localStorage.getItem(LS.urlSrc);
  if (savedUrl) $('#urlInput').value = savedUrl;
}

/* ---------- service worker & install ---------- */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    state.swReg = await navigator.serviceWorker.register('sw.js');
    state.swReg.addEventListener('updatefound', () => {
      const nw = state.swReg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          showAppUpdateBanner();
        }
      });
    });
    if (state.swReg.waiting && navigator.serviceWorker.controller) showAppUpdateBanner();
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (window.__reloadingForUpdate) return;
      window.__reloadingForUpdate = true;
      location.reload();
    });
  } catch (err) { /* offline / unsupported */ }
}

function showAppUpdateBanner() {
  const bar = $('#appUpdateBar');
  if (!bar) return;
  bar.classList.remove('hidden');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstall = e;
  $('#btnInstall').disabled = false;
});

/* ---------- event wiring ---------- */
function wireUI() {
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    state.view = t.dataset.view;
    render();
  }));
  $$('#typeChips .chip').forEach(c => c.addEventListener('click', () => {
    $$('#typeChips .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    state.type = c.dataset.type;
    render();
  }));

  // search
  $('#btnSearch').addEventListener('click', () => {
    $('#searchBar').classList.remove('hidden');
    $('#searchInput').focus();
  });
  $('#btnSearchClose').addEventListener('click', () => {
    $('#searchBar').classList.add('hidden');
    $('#searchInput').value = '';
    state.query = '';
    render();
  });
  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    if (state.query && state.view === 'now') {
      state.view = 'schedule';
      $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === 'schedule'));
    }
    render();
  });

  // settings sheet
  $('#btnSettings').addEventListener('click', () => { updateNotifStatus(); updateDataInfo(); showSheet('#settings'); });
  $$('[data-close]').forEach(el => el.addEventListener('click', () => {
    hideSheet('#sheet'); hideSheet('#settings'); hideSheet('#installGate');
  }));

  // notifications
  $('#btnEnableNotif').addEventListener('click', requestNotifications);
  $('#leadSelect').addEventListener('change', (e) => {
    state.lead = parseInt(e.target.value, 10);
    localStorage.setItem(LS.lead, state.lead);
    // reschedule
    localStorage.removeItem(LS.notified);
    if (Notification && Notification.permission === 'granted') {
      // cancel & reschedule triggers
      state.favs.forEach(async id => { await cancelNotification(id); scheduleNotification(id); });
    }
    toast(`> напомним за ${state.lead} мин`);
    if (state.view === 'favorites') render();
  });

  // обновление: сайт напрямую (если CORS пустит) -> сервер приложения
  $('#btnUpdateFromSite').addEventListener('click', async () => {
    const st = $('#importStatus');
    st.textContent = '$ curl insomniafest.ru/export… ';
    let done = false;
    try {
      const res = await fetch(EXPORT_URL, { cache: 'no-cache' });
      if (res.ok) {
        const program = exportToProgram(await res.json());
        const nProg = program.events.filter(e => e.type === 'program').length;
        const nAnim = program.events.filter(e => e.type === 'animation').length;
        // тот же sanity-гейт, что у CI: урезанный экспорт не затирает данные
        if (nProg >= 50 && nAnim >= 10) {
          applyImportedProgram(program, `> обновлено с сайта: ${program.events.length} событий`);
          done = true;
        }
      }
    } catch { /* CORS или офлайн — падаем на сервер приложения */ }
    if (done) { refreshMapQuiet(); return; }
    st.textContent = '$ сайт недоступен напрямую → пробую сервер приложения…';
    try {
      const res = await fetch('data/program.json?fresh=1', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const p = await res.json();
      applyImportedProgram({ ...p, importedAt: new Date().toISOString() },
        `> обновлено с сервера: ${p.events.length} событий`, false);
      refreshMapQuiet();
    } catch {
      st.textContent = '> офлайн: обновить не вышло, показываю сохранённую программу.';
    }
  });

  // import
  $('#btnImportFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    if (e.target.files.length) importFromFiles(e.target.files);
    e.target.value = '';
  });
  $('#btnImportUrl').addEventListener('click', () => {
    const url = $('#urlInput').value.trim();
    if (url) importFromUrl(url);
  });
  $('#btnResetData').addEventListener('click', resetData);

  // install gate
  $('#gateLater').addEventListener('click', () => hideSheet('#installGate'));
  $('#gateInstall').addEventListener('click', async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      const choice = await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      $('#btnInstall').disabled = true;
      if (choice && choice.outcome === 'accepted') hideSheet('#installGate');
      return;
    }
    // beforeinstallprompt не случился — показываем инструкцию по ОС
    const hint = $('#gateHint');
    hint.textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
      ? 'iPhone/iPad: кнопка «Поделиться» → «На экран “Домой”».'
      : 'Android: меню браузера (⋮) → «Установить приложение» или «Добавить на главный экран».';
    hint.classList.remove('hidden');
  });

  // install
  $('#btnInstall').addEventListener('click', async () => {
    if (!state.deferredInstall) { toast('В этом браузере: меню → «Добавить на главный экран»'); return; }
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $('#btnInstall').disabled = true;
  });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('#installHint').textContent = 'На iPhone: кнопка «Поделиться» → «На экран Домой».';
  }

  // симуляция времени
  $('#simMinus').addEventListener('click', () => setSim(getNow() - 3600000));
  $('#simPlus').addEventListener('click', () => setSim(getNow() + 3600000));
  $('#simPlusDay').addEventListener('click', () => setSim(getNow() + 86400000));
  $('#simReset').addEventListener('click', clearSim);

  // обновление приложения
  $('#appUpdateBtn').addEventListener('click', () => {
    if (state.swReg && state.swReg.waiting) state.swReg.waiting.postMessage('SKIP_WAITING');
    $('#appUpdateBar').classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideSheet('#sheet'); hideSheet('#settings'); hideSheet('#installGate'); } });
}

/* ---------- симуляция времени (?now=2026-07-11T17:00, МСК) ---------- */
const SIM_KEY = 'insomnia.simNow';

function initSim() {
  try {
    const q = new URLSearchParams(location.search).get('now');
    if (q) {
      const anchor = epochFromISO(q.length === 16 ? q + ':00' : q);
      if (anchor != null) {
        state.sim = { anchor, setAt: Date.now() };
        sessionStorage.setItem(SIM_KEY, JSON.stringify(state.sim));
        return;
      }
    }
    const saved = sessionStorage.getItem(SIM_KEY);
    if (saved) {
      const s = JSON.parse(saved);
      if (s && typeof s.anchor === 'number') state.sim = s;
    }
  } catch { /* симуляция не критична */ }
}

function setSim(anchor) {
  state.sim = { anchor, setAt: Date.now() };
  sessionStorage.setItem(SIM_KEY, JSON.stringify(state.sim));
  localStorage.removeItem(LS.notified); // дать напоминаниям сработать заново
  state.day = pickDefaultDay();
  updateSimBar();
  render();
}

function clearSim() {
  state.sim = null;
  sessionStorage.removeItem(SIM_KEY);
  // убрать ?now= из адреса, чтобы перезагрузка не вернула симуляцию
  try {
    const url = new URL(location.href);
    url.searchParams.delete('now');
    history.replaceState(null, '', url.pathname + url.search);
  } catch { /* ignore */ }
  state.day = pickDefaultDay();
  updateSimBar();
  render();
}

function updateSimBar() {
  const bar = $('#simBar');
  if (!bar) return;
  if (!state.sim) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#simTime').textContent = fmtSim(getNow());
}

/* ---------- ticking ---------- */
function tick() {
  $('#brandClock').textContent = fmtClock(getNow());
  updateSimBar();
  pollNotifications();
  if (state.view === 'now') render(); // keep "now" fresh
}

/* ---------- boot ---------- */
async function boot() {
  loadFavs();
  state.lead = parseInt(localStorage.getItem(LS.lead) || '15', 10);
  const leadSel = $('#leadSelect'); if (leadSel) leadSel.value = String(state.lead);
  initSim();
  try {
    state.program = decorateProgram(await loadProgram());
  } catch (err) {
    $('#content').innerHTML = '<div class="empty"><span class="big">⚠️</span>Не удалось загрузить программу.</div>';
    return;
  }
  noteDataVersion(state.program, { quietFirstRun: !localStorage.getItem('insomnia.seenVersion') });
  state.day = pickDefaultDay();
  state.map = await loadMap();
  wireUI();
  updateSimBar();
  render();
  tick();
  setInterval(tick, 30000);
  registerSW();
  updateNotifStatus();
}

document.addEventListener('DOMContentLoaded', boot);
