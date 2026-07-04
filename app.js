/* Бессонница 2026 — офлайн-программа фестиваля.
   Vanilla PWA: no build step, works fully offline once cached.
   Чистая логика времени/гео — в core.js (грузится первым, тестируется в node). */
'use strict';

// DEV=true включает симуляцию времени (?now=) и мок-гео (?mockgeo=).
// В проде выключено: параметры игнорируются молча, плашки не существует.
const DEV = false;

const LS = {
  favs: 'insomnia.favs',
  lead: 'insomnia.leadMinutes',
  program: 'insomnia.program',      // imported/updated program JSON
  notified: 'insomnia.notified',    // ids already notified (in-app scheduler dedup)
  urlSrc: 'insomnia.updateUrl',
  pins: 'insomnia.pins',            // пользовательские метки на карте
  installBarHidden: 'insomnia.installBarHidden', // ✕ на плашке установки
  offlineReadyShown: 'insomnia.offlineReadyShown', // тост «офлайн готов» — один раз
};

const state = {
  program: null,
  view: 'now',
  day: null,          // ISO date string
  type: 'all',        // all | program | animation
  query: '',
  favs: new Set(),
  pins: [],           // пользовательские метки [{lat,lng,name,emoji,note}]
  lead: 15,
  deferredInstall: null,
  swReg: null,
  sim: null,          // {anchor, setAt} — симуляция времени (?now=)
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

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
const {
  DAY_CUTOFF, epochFromISO, mskOf,
} = window.InsomniaCore;
const pad2 = x => String(x).padStart(2, '0');

function getNow() {
  if (state.sim) return state.sim.anchor + (Date.now() - state.sim.setAt);
  return Date.now();
}
function getFestivalDay(ms) { return window.InsomniaCore.getFestivalDay(ms); }
function statusOf(e) { return window.InsomniaCore.statusOf(e, getNow()); }
function sortByStart(a, b) { return window.InsomniaCore.sortByStart(a, b); }
function nightInfo(e) { return window.InsomniaCore.nightInfo(e, WD); }

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

function loadPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.pins) || '[]');
    // строгий Number.isFinite: глобальный isFinite коэрсит null/''/[] в 0 —
    // битая запись превращалась бы в метку на «нулевом острове»
    state.pins = Array.isArray(raw)
      ? raw.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) : [];
  } catch { state.pins = []; }
}
function savePins() { localStorage.setItem(LS.pins, JSON.stringify(state.pins || [])); }

let simNotified = new Set(); // дедуп напоминаний в симуляции — только в памяти
function getNotified() {
  if (state.sim) return simNotified;
  try { return new Set(JSON.parse(localStorage.getItem(LS.notified) || '[]')); }
  catch { return new Set(); }
}
function setNotified(set) {
  // симулированное время НЕ отравляет реальный дедуп напоминаний
  if (state.sim) { simNotified = set; return; }
  localStorage.setItem(LS.notified, JSON.stringify([...set]));
}

/* ---------- data loading ---------- */
function decorateProgram(p) {
  window.InsomniaCore.decorateEvents(p.events || []);
  // дни пересчитываем из событий (фестивальный день вычисляется, не хранится)
  p._days = [...new Set((p.events || []).map(e => e._festDay).filter(Boolean))].sort();
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

function eventById(id) { return state.program.events.find(e => e.id === id); }

/* ---------- rendering ---------- */
function eventTypeLabel(t) { return t === 'animation' ? 'Анимация' : 'Программа'; }



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
  $('#filters').classList.toggle('hidden', state.view !== 'now' && state.view !== 'schedule');
  content.classList.toggle('hidden', state.view === 'map');
  if (state.view === 'map') { renderMapView(); }
  else { hideMapView(); }
  // watchPosition живёт только пока открыт раздел «рядом»
  if (state.view !== 'nearby') stopNearbyWatch();

  if (state.view === 'now') return renderNow(content);
  if (state.view === 'schedule') return renderSchedule(content);
  if (state.view === 'favorites') return renderFavorites(content);
  if (state.view === 'nearby') return renderNearby(content);
}

function renderNow(root) {
  // полоса дат в «сейчас» — индикатор ТЕКУЩИХ суток, не фильтр: вне дат
  // фестиваля (до/после) не подсвечиваем ничего — все дни заглушены
  const today = getFestivalDay(getNow());
  buildDayStrip(true, (state.program._days || []).includes(today) ? today : null);
  const n = getNow();
  const evs = filteredEvents().filter(e => e._startMs != null).sort(sortByStart);
  const live = window.InsomniaCore.getCurrent(evs, n);
  const upcoming = window.InsomniaCore.getUpcoming(evs, n); // без горизонта: все будущие

  // границы для баннеров «до старта»/«завершён» — по ВСЕЙ программе:
  // активный поиск/фильтр сужает evs и посреди феста давал ложное
  // «до старта 3 дн.» (единственный матч — событие через 3 дня)
  const all = state.program.events.filter(e => e._startMs != null);
  const first = all.length ? Math.min(...all.map(e => e._startMs)) : null;
  const last = all.length ? Math.max(...all.map(e => e._endMs || e._startMs)) : null;

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
  if (!state.day) state.day = pickDefaultDay(); // ДО полосы — иначе нет активного дня

  // Активный поиск — по ВСЕЙ программе, не только по выбранному дню:
  // иначе событие «теряется», если оно на другой дате. Полоса дат на время
  // поиска заглушена (день-фильтр не действует); state.day не трогаем —
  // после очистки запроса вернётся выбранный день.
  if (state.query) {
    buildDayStrip(true, null);
    const evs = filteredEvents().filter(e => e._startMs != null).sort(sortByStart);
    if (!evs.length) {
      root.appendChild(emptyState('🔍', '$ grep: ничего не найдено по фильтру.'));
      return;
    }
    let lastDay = null;
    evs.forEach(e => {
      if (e._festDay !== lastDay) { lastDay = e._festDay; root.appendChild(dayHeading(e._festDay)); }
      root.appendChild(eventCard(e));
    });
    return;
  }

  buildDayStrip();
  // «вся программа в календарь» — разовый снимок без напоминаний (модалка
  // предупредит); показываем всегда в «Программе», даже если день пуст
  const progExport = document.createElement('div');
  progExport.className = 'program-export';
  progExport.innerHTML = `<button class="btn ghost" id="btnProgramExport" aria-label="Выгрузить всю программу в календарь">📅 вся программа в календарь</button>`;
  progExport.querySelector('#btnProgramExport').addEventListener('click', openProgramExport);
  root.appendChild(progExport);

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

  // «весь маршрут в календарь» — один .ics со всеми VEVENT; всегда сверху,
  // при пустом избранном кнопки неактивны с подсказкой
  const routeActions = document.createElement('div');
  routeActions.className = 'route-actions';
  const dis = favs.length ? '' : 'disabled title="Сначала добавьте события в избранное"';
  routeActions.innerHTML = `
    <button class="btn ghost" id="routeCal" ${dis}>📅 в календарь</button>
    <button class="btn ghost" id="routeShare" ${dis}>🔗 поделиться</button>
    <button class="btn ghost cal-dl" id="routeIcs" aria-label="Скачать весь маршрут .ics" ${dis}>⬇️</button>`;
  root.appendChild(routeActions);
  if (favs.length) {
    routeActions.querySelector('#routeCal').addEventListener('click', () => exportICS(favs, 'insomnia-favorites.ics'));
    routeActions.querySelector('#routeShare').addEventListener('click', () => exportICS(favs, 'insomnia-favorites.ics', { shareText: routeShareText(favs) }));
    routeActions.querySelector('#routeIcs').addEventListener('click', () => exportICS(favs, 'insomnia-favorites.ics', { forceDownload: true }));
  }

  // пустое состояние — только если избранного нет ВООБЩЕ:
  // одни сироты (size > 0, живых 0) должны показать плашку ниже
  if (!state.favs.size) {
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
  info.textContent = notifGranted()
    ? `Напоминания включены: за ${state.lead} мин до начала.`
    : 'Включите уведомления в настройках, чтобы получать напоминания.';
  root.appendChild(info);
}


function groupLabel(text) {
  const d = document.createElement('div');
  d.className = 'time-group-label';
  d.textContent = text;
  return d;
}
// части даты 'YYYY-MM-DD' для подписей ({dow, day, mo}); полдень — вдали от границ суток
function dayParts(iso) {
  return mskOf(epochFromISO(iso + 'T12:00'));
}
function dayHeading(iso) {
  const d = document.createElement('div');
  d.className = 'time-group-label';
  const p = dayParts(iso);
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
// readonly-режим — для «сейчас»: полоса показывает ТЕКУЩИЕ фестивальные
// сутки (activeDay), остальные даты заглушены и некликабельны; выбор дня
// в «программе» (state.day) при этом не трогаем — вернётся как был
function buildDayStrip(readonly = false, activeDay = state.day) {
  const strip = $('#dayStrip');
  const keepScroll = strip.scrollLeft; // tick() перестраивает полосу каждые 30с
  strip.innerHTML = '';
  (state.program._days || []).forEach(date => {
    const p = dayParts(date);
    const btn = document.createElement('button');
    btn.className = 'day-btn' + (date === activeDay ? ' active' : '');
    btn.innerHTML = `<span class="dow">${WD[p.dow]}</span><span>${p.day} ${MON[p.mo]}</span>`;
    if (readonly) btn.disabled = true;
    else btn.addEventListener('click', () => { state.day = date; render(); });
    strip.appendChild(btn);
  });
  strip.scrollLeft = keepScroll;
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
  const p = dayParts(e._festDay);
  const dateStr = `${WD[p.dow]}, ${p.day} ${MON[p.mo]} 2026`;
  const geoPts = typeof eventGeoPoints === 'function' ? eventGeoPoints(e) : [];
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
      ${geoPts.map((p, i) => `<button class="tag geo-jump" data-gid="${p.id}">📍 ${geoPts.length > 1 ? escapeHtml(p.name) : 'на карте'}</button>`).join('')}
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
    <div class="detail-actions cal-row">
      <button class="btn ghost" id="detailCal" aria-label="Добавить в календарь">📅 в календарь</button>
      <button class="btn ghost" id="detailShare" aria-label="Поделиться">🔗 поделиться</button>
      <button class="btn ghost cal-dl" id="detailIcs" aria-label="Скачать .ics">⬇️</button>
    </div>
  `;
  $('#detailFav').addEventListener('click', () => {
    toggleFav(id);
    openDetail(id); // refresh button
  });
  const icsName = `insomnia-${e.id}.ics`;
  $('#detailCal').addEventListener('click', () => exportICS([e], icsName));
  $('#detailShare').addEventListener('click', () => exportICS([e], icsName, { shareText: eventShareText(e) }));
  $('#detailIcs').addEventListener('click', () => exportICS([e], icsName, { forceDownload: true }));
  body.querySelectorAll('.geo-jump').forEach(btn => btn.addEventListener('click', () => {
    hideSheet('#sheet');
    switchView('map');
    setTimeout(() => highlightPoint(btn.dataset.gid, { open: false }), 300);
  }));
  showSheet('#sheet');
}

function showSheet(sel) { $(sel).classList.remove('hidden'); }
function hideSheet(sel) { $(sel).classList.add('hidden'); }

/* ---------- экспорт в календарь (.ics, всё офлайн на клиенте) ---------- */
function downloadBlob(blob, filename) {
  // принудительное скачивание blob через <a download>
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // отзываем URL позже — Safari успевает начать скачивание
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// самодостаточный текст для «🔗 поделиться»: понятен и без вложения
function eventShareText(e) {
  const p = dayParts(e._festDay);
  const dateStr = `${WD[p.dow]}, ${p.day} ${MON[p.mo]}`;
  const timeStr = e.end ? `${e.start}–${e.end}` : e.start;
  // ночная пометка — как в карточке: без неё «00:30» на фест-сутках
  // читается двусмысленно тем, кто не знает про 06:00-границу
  const night = typeof nightInfo === 'function' ? nightInfo(e) : null;
  const when = `${dateStr}, ${timeStr} МСК` + (night ? ` (${night.marker})` : '');
  const parts = [e.title, when];
  if (e.venue) parts.push(`📍 ${e.venue}`);
  parts.push('— Бессонница 2026');
  return parts.join('\n');
}

// самодостаточный список маршрута для «🔗 поделиться маршрутом»:
// сгруппирован по фестивальным дням (_festDay из core), сорт по времени;
// ночные события (02:00) идут под своим фест-днём с маркером 🌙
function routeShareText(events) {
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const pad = n => String(n).padStart(2, '0');
  const evs = (events || []).filter(e => e._startMs != null).slice().sort(sortByStart);
  const lines = ['🌙 Мой маршрут на Бессоннице', ''];
  let lastDay = null;
  evs.forEach(e => {
    if (e._festDay !== lastDay) {
      lastDay = e._festDay;
      const p = dayParts(e._festDay);
      lines.push(`${cap(WD[p.dow])} ${pad(p.day)}.${pad(p.mo + 1)}`);
    }
    const night = typeof nightInfo === 'function' ? nightInfo(e) : null;
    const venue = e.venue ? ` — ${e.venue}` : '';
    lines.push(`• ${e.start}${night ? ' 🌙' : ''} ${e.title}${venue}`);
  });
  lines.push('', 'Сгенерено в приложении программы феста');
  return lines.join('\n');
}

async function exportICS(events, filename, opts = {}) {
  // forceDownload — принудительно качать; shareText — «поделиться» с текстом;
  // withAlarm — ставить ли VALARM (false для полной выгрузки программы)
  const { forceDownload = false, shareText = null, withAlarm = true } = opts;
  // filename — латиница: кириллица в именах файлов ломается на части систем
  const list = (events || []).filter(e => e && (e._startMs != null || e.startISO));
  if (!list.length) { toast('Нет событий для экспорта'); return; }
  let ics;
  // напоминание в календаре — за выбранное в настройках время (как пуши)
  try { ics = window.InsomniaCore.buildICS(list, { leadMin: state.lead, withAlarm }); }
  catch { toast('Не удалось собрать файл календаря'); return; }
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });

  // 1) share — приоритет на телефоне (iOS предлагает «Добавить в Календарь»);
  //    только когда это не «принудительно скачать»
  if (!forceDownload && navigator.share) {
    const file = (typeof File === 'function') ? new File([blob], filename, { type: 'text/calendar' }) : null;
    const canFiles = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const data = { title: 'Бессонница 2026' };
    if (shareText) data.text = shareText;
    if (canFiles) data.files = [file];
    // 🔗 «поделиться»: текст самодостаточен — шэрим даже без вложения;
    // 📅 «в календарь»: без файла шэрить нечего → уходим на скачивание
    if (canFiles || shareText) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        // осознанная отмена — уважаем, не навязываем скачивание;
        // любая иная ошибка → фолбэк на download ниже
        if (err && err.name === 'AbortError') return;
      }
    }
  }

  // 2) фолбэк/принудительно: скачивание в «Загрузки».
  //    На части устройств (Huawei и др.) шэр файлов не поддержан — тогда
  //    сюда попадает и кнопка «в календарь»; подсказываем, что делать дальше
  downloadBlob(blob, filename);
  // «поделиться» без Web Share: кладём текст в буфер, чтобы вставить в чат
  if (shareText && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(shareText);
      toast('Текст скопирован в буфер, файл .ics скачан', 4000);
      return;
    } catch { /* буфер недоступен — обычная подсказка ниже */ }
  }
  toast('Файл скачан — откройте его, чтобы добавить в календарь', 4000);
}

// «Программа» → вся программа в календарь: сперва предупреждаем (нет
// напоминаний, разовый снимок), по подтверждению — ICS без VALARM
function openProgramExport() { showSheet('#programExport'); }
async function doProgramExport() {
  hideSheet('#programExport');
  const all = (state.program.events || []).filter(e => e._startMs != null);
  if (!all.length) { toast('Программа не загружена'); return; }
  await exportICS(all, 'insomnia-full-program.ics', { withAlarm: false });
}
// перед открытием диплинк-шитов (#pin=, #import-pins) закрываем все прочие:
// иначе шиты наслаиваются и фокус уезжает в невидимое поле
function hideAllSheets() { $$('.sheet').forEach(s => s.classList.add('hidden')); }

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
// голый идентификатор Notification кидает ReferenceError там, где API нет
// (iOS Safari) — проверяем только через 'in window'
function notifGranted() {
  return 'Notification' in window && Notification.permission === 'granted';
}

// Если планирование OS-триггера хоть раз упало, до конца сессии страхует
// внутренний поллер — иначе напоминания молча исчезают.
let osTriggerBroken = false;

async function scheduleNotification(id) {
  if (!notifGranted()) return;
  const e = eventById(id);
  if (!e || e._startMs == null) return;
  const when = e._startMs - state.lead * 60000; // всегда реальное время события
  if (when <= Date.now()) return; // too late / already started
  const { title, body } = notifText(e);

  // Best case: OS-scheduled trigger that fires even when the app is closed.
  if (supportsTrigger() && !osTriggerBroken) {
    try {
      await state.swReg.showNotification(title, {
        body,
        tag: 'ev-' + id,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        showTrigger: new TimestampTrigger(when),
      });
      return;
    } catch (err) { osTriggerBroken = true; }
  }
  // Fallback handled by the in-app polling scheduler (runs while app is open).
}

async function cancelNotification(id) {
  if (!state.swReg) return;
  try {
    // includeTriggered: true — иначе ЗАПЛАНИРОВАННЫЙ (ещё не показанный)
    // OS-триггер не найдётся и его нельзя будет отменить
    const notes = await state.swReg.getNotifications({ tag: 'ev-' + id, includeTriggered: true });
    notes.forEach(n => n.close());
  } catch { /* ignore */ }
  const notified = getNotified();
  notified.delete(id);
  setNotified(notified);
}

// In-app safety-net scheduler: while the app is open, poll favorites and fire
// a notification when we cross the lead-time threshold. Deduped via LS.notified.
function pollNotifications() {
  if (!notifGranted()) return;
  if (supportsTrigger() && !osTriggerBroken) return; // OS triggers already cover it
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
        const p = state.swReg
          ? state.swReg.showNotification(title, { body, tag: 'ev-' + id, icon: 'icons/icon-192.png' })
          : (new Notification(title, { body, icon: 'icons/icon-192.png' }), null);
        // отметка «уведомлён» — только при успехе, иначе напоминание
        // молча теряется навсегда; при отказе попробуем на следующем тике
        if (p && p.catch) p.catch(() => {
          const n2 = getNotified(); n2.delete(id); setNotified(n2);
        });
        notified.add(id);
        changed = true;
      } catch { /* показ не удался — не помечаем, повторим через 30с */ }
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
  return `${p.day} ${MONTHS_GEN[p.mo]}, ${pad2(p.h)}:${pad2(p.mi)}`;
}

function noteDataVersion(p) {
  const v = p && p.meta && p.meta.version;
  const el = $('#dataVersion');
  if (el) el.textContent = v ? `от ${fmtDataVersion(v)}` : '';
  if (!v) return;
  // тост только при смене уже виденной версии; первый запуск тихий сам собой
  const seen = localStorage.getItem('insomnia.seenVersion');
  if (seen && seen !== v) toast('Расписание обновлено', 2000);
  if (seen !== v) localStorage.setItem('insomnia.seenVersion', v);
}

/* ---------- import / update ---------- */
// Normalize a parsed workbook (SheetJS) into our program shape.
// Mirrors scripts/convert_xlsx.py.
const EXPORT_URL = 'https://insomniafest.ru/export/program/2026';

// МСК-разложение и фестивальные сутки — единственный источник в core.js;
// эти обёртки лишь переводят unix-секунды экспорта в эпоху мс
function mskParts(ts) {
  const p = mskOf(Number(ts) * 1000);
  const hhmm = `${pad2(p.h)}:${pad2(p.mi)}`;
  return {
    y: p.y, mo: p.mo + 1, day: p.day, h: p.h, mi: p.mi, hhmm,
    iso: `${p.y}-${pad2(p.mo + 1)}-${pad2(p.day)}T${hhmm}:00`,
  };
}
function festDateOf(ts) {
  return getFestivalDay(Number(ts) * 1000);
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
    const date = festDateOf(startTs);
    const ev = {
      id: fnv1a([kind, date, s.hhmm, venue, title].join('|')),
      type: kind, date, start: s.hhmm,
      end: endD ? `${pad2(endD.getUTCHours())}:${pad2(endD.getUTCMinutes())}` : null,
      startISO: s.iso,
      endISO: endD ? `${endD.getUTCFullYear()}-${pad2(endD.getUTCMonth() + 1)}-${pad2(endD.getUTCDate())}T${pad2(endD.getUTCHours())}:${pad2(endD.getUTCMinutes())}:00` : null,
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
  const days = dates.map(d => {
    const [, m, dd] = d.split('-').map(Number);
    return { date: d, label: `${dd} ${MONTHS_GEN[m - 1]}` };
  });
  return {
    festival: 'Бессонница 2026', year: YEAR, source: EXPORT_URL, version: 2,
    meta: { version: new Date().toISOString().slice(0, 19) + 'Z', source: 'insomniafest.ru (direct)' },
    days, venues: [...new Set(events.map(e => e.venue).filter(Boolean))].sort(),
    venueInfo, events, importedAt: new Date().toISOString(),
  };
}

const MONTHS_RU = Object.fromEntries(MONTHS_GEN.map((m, i) => [m, i + 1])); // 'июля' -> 7
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
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
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
      const dateIso = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
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
          // +1 день строго по компонентам строки: new Date(наивный ISO)
          // парсится как локальное время, а toISOString() — UTC, что
          // сдвигало конец события на офсет таймзоны устройства
          const ms = Date.UTC(+endISO.slice(0, 4), +endISO.slice(5, 7) - 1, +endISO.slice(8, 10)) + 86400000;
          const nd = new Date(ms);
          endISO = `${nd.getUTCFullYear()}-${pad2(nd.getUTCMonth() + 1)}-${pad2(nd.getUTCDate())}${endISO.slice(10)}`;
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

// SheetJS (861 КБ) грузится лениво — только при реальном импорте Excel.
// Офлайн это тоже работает: vendor/xlsx.full.min.js лежит в прекэше SW.
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('модуль чтения Excel не загрузился'));
    document.head.appendChild(s);
  });
}

async function importFromFiles(fileList) {
  try {
    await ensureXLSX();
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
  } catch (err) {
    // битый/не-Excel файл не должен падать молча
    $('#importStatus').textContent = 'Ошибка импорта: ' + err.message;
    toast('Не удалось прочитать файл');
  }
}

async function importFromUrl(url) {
  $('#importStatus').textContent = 'Загрузка…';
  try {
    await ensureXLSX();
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
  if (notifGranted()) state.favs.forEach(scheduleNotification);
  $('#importStatus').textContent = msg;
  noteDataVersion(program);
  updateDataInfo();
  toast(msg);
  render();
}

async function refreshMapQuiet() {
  const g = await loadGeo();
  if (!g) return;
  GEO.data = g;
  resetMapLayers(); // уже отрисованная карта не должна показывать старые слои
  if (state.view === 'map' || state.view === 'nearby') render();
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
  }).catch(() => {
    // импорт уже удалён, а встроенная версия не поднялась — честно скажем
    toast('Не удалось загрузить встроенную версию — перезапустите приложение');
  });
}

function updateDataInfo() {
  checkOfflineReady(); // строка «офлайн готов N/N» в блоке установки
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
    setTimeout(checkOfflineReady, 2500); // прекэш к этому моменту обычно уже едет
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
      // Перезагружаемся ТОЛЬКО когда обновление запросил пользователь кнопкой.
      // Первая установка SW (clients.claim) тоже даёт controllerchange —
      // молча продолжаем без перезагрузки.
      if (!window.__wantReloadAfterUpdate || window.__reloadingForUpdate) return;
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

/* ---------- установка: плашка + кнопки, переживающие отказ ---------- */
function installInstructionText() {
  // iOS: у ярлыка на главном экране ОТДЕЛЬНОЕ хранилище от Safari — без
  // первого онлайн-запуска с ярлыка офлайн не заработает (серый экран)
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    ? 'iPhone: Safari → «Поделиться» → «На экран “Домой”». Потом ОБЯЗАТЕЛЬНО откройте приложение с ярлыка один раз с интернетом — иначе офлайн не заработает.'
    : 'Android: меню браузера (⋮) → «Установить приложение» или «Добавить на главный экран».';
}

// семейство браузера для честных предупреждений. Порядок важен: клоны
// Chromium (ЯБ, Edge, Opera, Samsung...) содержат «Chrome» в UA
function browserFamily() {
  const ua = navigator.userAgent;
  if (/YaBrowser/i.test(ua)) return 'yandex';
  // вебвью мессенджеров (Telegram/VK на Android — дефолтный системный WebView
  // с маркерами «; wv)» или «Version/x.x … Chrome/»): установка оттуда
  // невозможна вовсе — зовём открыть во внешнем браузере
  if (/;\s*wv\)/.test(ua) || (/Android/i.test(ua) && /Version\/\d+\.\d+/.test(ua) && /Chrome\//.test(ua))
      || /WhatsApp|Instagram|Telegram|VKAndroidApp|VkontakteAndroid/i.test(ua)) return 'webview';
  if (/EdgA?\/|EdgiOS\/|OPR\/|OPX\/|OPT\/|OPiOS\/|SamsungBrowser|MiuiBrowser|UCBrowser|HuaweiBrowser|Firefox\/|FxiOS|DuckDuckGo|Ddg\/|Vivaldi/i.test(ua)) return 'other';
  if (/CriOS\/|Chrome\//i.test(ua)) return 'chrome';
  if (/Safari/i.test(ua) && /iPhone|iPad|iPod|Macintosh/i.test(ua)) return 'safari';
  return 'other';
}

// текст-предупреждение по браузеру; Chrome и Safari — без страшилок
function browserSupportWarning() {
  const fam = browserFamily();
  if (fam === 'yandex') {
    return '<b class="yb-warn">Вы в Яндекс Браузере — в нём приложение работает нестабильно.</b> ' +
      'Полная работоспособность тестировалась только с Chrome: на время феста ' +
      'поставьте Chrome браузером по умолчанию.';
  }
  if (fam === 'webview') {
    return '<b class="yb-warn">Похоже, страница открыта внутри другого приложения.</b> ' +
      'Установка отсюда не работает: откройте ссылку во внешнем браузере ' +
      '(меню ⋮ → «Открыть в браузере» / «Открыть в Chrome»).';
  }
  if (fam === 'other') {
    return '<b class="yb-warn">Работоспособность в этом браузере не подтверждена.</b> ' +
      'Тестировалось в Chrome (Android) и Safari (iPhone) — надёжнее всего установить из Chrome.';
  }
  return '';
}

function updateInstallBar() {
  const bar = $('#installBar');
  if (!bar) return;
  const show = !isStandalone() && localStorage.getItem(LS.installBarHidden) !== '1';
  bar.classList.toggle('hidden', !show);
  if (show) {
    const warn = browserSupportWarning();
    if (warn) $('#installBarHint').innerHTML = warn;
  }
  // та же строка в настройках (пустая для Chrome/Safari — блок скрыт)
  const bw = $('#browserWarn');
  if (bw) {
    const warn = browserSupportWarning();
    bw.innerHTML = warn;
    bw.classList.toggle('hidden', !warn);
  }
}

// показать инструкцию по месту клика; кнопки при этом остаются живыми
function installShowInstruction(context) {
  const txt = installInstructionText();
  if (context === 'gate') {
    const h = $('#gateHint');
    h.textContent = txt;
    h.classList.remove('hidden');
  } else if (context === 'bar') {
    $('#installBarHint').textContent = txt;
    toast(txt, 8000);
  } else {
    const h = $('#installHint');
    h.textContent = txt;
    h.classList.remove('hidden');
  }
}

// единый флоу для плашки, гейта и настроек. Событие beforeinstallprompt
// одноразовое: тратим его, но при ЛЮБОМ исходе кроме established кнопки
// не хороним — показываем инструкцию; Chrome может выдать новое событие
// (слушатель вернёт быстрый путь сам)
async function promptInstall(context) {
  const ev = state.deferredInstall;
  if (!ev) { installShowInstruction(context); return; }
  state.deferredInstall = null;
  let outcome = 'exception';
  try {
    ev.prompt();
    const choice = await ev.userChoice;
    outcome = (choice && choice.outcome) || 'unknown';
  } catch { /* prompt уже потрачен или не разрешён жестом */ }
  if (DEV) console.log('[install] userChoice:', outcome);
  if (outcome === 'accepted') return; // остальное сделает appinstalled
  installShowInstruction(context);
}

/* «офлайн готов»: спрашиваем у SW, сколько файлов прекэша реально в кэше.
   Особенно важно на iOS: у ярлыка отдельное от Safari хранилище, и до
   первого онлайн-запуска с ярлыка офлайн не работает вовсе */
function checkOfflineReady() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage('OFFLINE_STATUS');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'OFFLINE_STATUS') return;
    const ready = d.have >= d.total;
    const el = $('#offlineStatus');
    if (el) {
      el.textContent = ready
        ? `Офлайн готов: ${d.have}/${d.total} файлов в кэше ✓`
        : `Офлайн готовится: ${d.have}/${d.total} файлов — не выключайте интернет`;
    }
    if (ready) {
      if (isStandalone() && localStorage.getItem(LS.offlineReadyShown) !== '1') {
        localStorage.setItem(LS.offlineReadyShown, '1');
        toast('✓ офлайн готов — приложение переживёт авиарежим', 5000);
      }
    } else {
      setTimeout(checkOfflineReady, 4000); // прекэш ещё докачивается
    }
  });
  // controller появляется после первой активации SW (первый запуск ярлыка)
  navigator.serviceWorker.addEventListener('controllerchange', () => setTimeout(checkOfflineReady, 1500));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstall = e;
  updateInstallBar();
});

// sticky-слои: вкладки и фильтры липнут ПОД шапкой — её высота динамична
// (safe-area, поиск), поэтому меряем и отдаём в CSS-переменные
function measureStickyOffsets() {
  const h = document.querySelector('.app-header');
  const t = document.querySelector('.tabs');
  if (h) document.documentElement.style.setProperty('--header-h', h.offsetHeight + 'px');
  if (t) document.documentElement.style.setProperty('--tabs-h', t.offsetHeight + 'px');
}
measureStickyOffsets();
window.addEventListener('resize', measureStickyOffsets);
if (window.ResizeObserver) {
  const hd = document.querySelector('.app-header');
  if (hd) new ResizeObserver(measureStickyOffsets).observe(hd);
}

// кнопки плашки вешаем СРАЗУ (не в wireUI): beforeinstallprompt может
// показать плашку до конца boot() — кнопки не должны быть мёртвыми
$('#installBarBtn').addEventListener('click', () => promptInstall('bar'));
$('#installBarClose').addEventListener('click', () => {
  localStorage.setItem(LS.installBarHidden, '1');
  $('#installBar').classList.add('hidden');
});

// скрываем установочный UI ТОЛЬКО по факту установки
window.addEventListener('appinstalled', () => {
  state.deferredInstall = null;
  localStorage.setItem(LS.installBarHidden, '1');
  const bar = $('#installBar');
  if (bar) bar.classList.add('hidden');
  hideSheet('#installGate');
  const h = $('#installHint');
  if (h) { h.textContent = 'Установлено ✅ Откройте приложение с главного экрана.'; h.classList.remove('hidden'); }
  toast('> установлено. Откройте с главного экрана 🎉', 6000);
  if (DEV) console.log('[install] appinstalled');
});

/* ---------- event wiring ---------- */
function wireUI() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
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
    window.scrollTo(0, 0);
  });
  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    // поиск из «сейчас» переводит на «программу» (switchView сам вызывает render)
    if (state.query && state.view === 'now') switchView('schedule');
    else render();
    // размер выдачи скачет между нажатиями: без сброса скролла результат
    // (или пустое состояние) остаётся спрятанным за липкой шапкой
    window.scrollTo(0, 0);
  });

  // settings sheet
  $('#btnSettings').addEventListener('click', () => { updateNotifStatus(); updateDataInfo(); showSheet('#settings'); });
  // закрывает СВОЙ шит (крестик/светофор/бэкдроп лежат внутри .sheet)
  $$('[data-close]').forEach(el => el.addEventListener('click', () => {
    const sheet = el.closest('.sheet');
    if (sheet) sheet.classList.add('hidden');
  }));

  // подтверждение выгрузки всей программы (кнопка #btnProgramExport —
  // динамическая, навешана в renderSchedule)
  $('#programExportGo').addEventListener('click', doProgramExport);

  // notifications
  $('#btnEnableNotif').addEventListener('click', requestNotifications);
  $('#leadSelect').addEventListener('change', (e) => {
    state.lead = parseInt(e.target.value, 10);
    localStorage.setItem(LS.lead, state.lead);
    // reschedule
    localStorage.removeItem(LS.notified);
    if (notifGranted()) {
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

  // установка: гейт и настройки (кнопки плашки навешаны на верхнем уровне)
  $('#gateLater').addEventListener('click', () => hideSheet('#installGate'));
  $('#gateInstall').addEventListener('click', () => promptInstall('gate'));
  $('#btnInstall').addEventListener('click', () => promptInstall('settings'));
  updateInstallBar();
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('#installHint').textContent = installInstructionText();
    $('#installHint').classList.remove('hidden');
  }

  // карта: «я где?» + подсказка под картой + мои метки
  $('#btnLocate').addEventListener('click', locateMe);
  if (typeof geoHelpEl === 'function') $('#mapWrap').appendChild(geoHelpEl());
  wirePinUI();

  // симуляция времени
  $('#simMinus').addEventListener('click', () => setSim(getNow() - 3600000));
  $('#simPlus').addEventListener('click', () => setSim(getNow() + 3600000));
  $('#simPlusDay').addEventListener('click', () => setSim(getNow() + 86400000));
  $('#simReset').addEventListener('click', clearSim);

  // обновление приложения
  $('#appUpdateBtn').addEventListener('click', () => {
    if (state.swReg && state.swReg.waiting) {
      window.__wantReloadAfterUpdate = true;
      state.swReg.waiting.postMessage('SKIP_WAITING');
    }
    $('#appUpdateBar').classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAllSheets(); });
}

/* ---------- симуляция времени (?now=2026-07-11T17:00, МСК) ---------- */
const SIM_KEY = 'insomnia.simNow';

function initSim() {
  if (!DEV) {
    // прод: ?now= игнорируется молча, хвосты сессии вычищаются
    try { sessionStorage.removeItem(SIM_KEY); } catch { /* ignore */ }
    return;
  }
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
  simNotified = new Set(); // симуляционный дедуп с чистого листа
  state.day = pickDefaultDay();
  updateSimBar();
  render();
}

function clearSim() {
  state.sim = null;
  simNotified = new Set();
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
  $('#brandClock').textContent = fmtClock(getNow()); // часы — сразу, не ждём tick
  if (!state.sim) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#simTime').textContent = fmtSim(getNow());
}

/* ---------- ticking ---------- */
function tick() {
  updateSimBar(); // заодно пишет #brandClock
  pollNotifications();
  if (state.view === 'now') render(); // keep "now" fresh
}

/* ---------- boot ---------- */
async function boot() {
  loadFavs();
  loadPins();
  state.lead = parseInt(localStorage.getItem(LS.lead) || '15', 10);
  const leadSel = $('#leadSelect'); if (leadSel) leadSel.value = String(state.lead);
  initSim();
  try {
    state.program = decorateProgram(await loadProgram());
  } catch (err) {
    $('#content').innerHTML = '<div class="empty"><span class="big">⚠️</span>Не удалось загрузить программу.</div>';
    return;
  }
  noteDataVersion(state.program);
  state.day = pickDefaultDay();
  initMockGeo();
  GEO.data = await loadGeo();
  GEO.basemap = await loadBasemap();
  wireUI();
  updateSimBar();
  render();
  tick();
  setInterval(tick, 30000);
  registerSW();
  updateNotifStatus();
  handleIncomingPin(); // открыли по чужой #pin=-ссылке — предложить добавить
  handleImportHash();  // гайд «связь на поляне» ведёт на форму импорта меток
  // ссылки могут прилетать и в уже открытое приложение (same-document навигация)
  window.addEventListener('hashchange', () => { handleIncomingPin() || handleImportHash(); });
}

// ./#import-pins (из mesh.html): открыть «добавить из текста» с фокусом в поле
function handleImportHash() {
  if (location.hash !== '#import-pins') return false;
  history.replaceState(null, '', location.pathname + location.search);
  openPinImport();
  return true;
}

document.addEventListener('DOMContentLoaded', () => boot().catch(err => {
  // любой необработанный сбой инициализации не должен оставлять вечный
  // экран «загрузка» без объяснения
  const c = $('#content');
  if (c) c.innerHTML = `<div class="empty"><span class="big">⚠️</span>Приложение не запустилось: ${escapeHtml(err && err.message || String(err))}. Закройте и откройте его заново.</div>`;
}));
