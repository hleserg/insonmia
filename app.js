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
  installPinged: 'insomnia.install_pinged', // пинг «установили» в телеграм — один раз
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

// нормализованный текущий запрос (регистр/ё→е/кавычки) — общий с картой
function nQuery() { return window.InsomniaCore.normalizeSearch(state.query); }
function eventMatchesQuery(e, q) {
  return window.InsomniaCore.matchesQuery(q,
    [e.title, e.venue, e.description, ...(e.films || [])]);
}
function filteredEvents() {
  let evs = state.program.events;
  if (state.type !== 'all') evs = evs.filter(e => e.type === state.type);
  // Воронка (ценз/локация) и поиск работают ПО И (пересечение), как и
  // тип-чип. День-фильтр — исключение: поиск идёт по всем дням (баг #33),
  // полоса дат при поиске заглушается в renderSchedule.
  evs = evs.filter(passesFilters);
  if (state.query) {
    const q = nQuery();
    evs = evs.filter(e => eventMatchesQuery(e, q));
  }
  return evs;
}

/* ---------- фильтры: возрастной ценз + локация ----------
   Мультивыбор через модалку-воронку. По умолчанию выбрано ВСЁ (фильтр
   неактивен). Состояние живёт только в памяти сессии — при новом запуске
   снова «всё» (в localStorage не храним). Ценз общий для «сейчас/программы/
   рядом», локация — только для «сейчас/программы». Семантика чипов —
   «показать выбранные», а не порог. */
const AGE_NA = '';   // пустой ценз/локация → чип «не указано»
function ageKey(e) { return (e.age || '').trim(); }
function venueKey(e) { return (e.venue || '').trim(); }
function cmpAge(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, 'ru');
}
// вселенная значений: отсортированные значения + «не указано» в конец (если есть)
function ageUniverse() {
  const s = new Set((state.program.events || []).map(ageKey));
  const vals = [...s].filter(Boolean).sort(cmpAge);
  if (s.has(AGE_NA)) vals.push(AGE_NA);
  return vals;
}
function venueUniverse() {
  const s = new Set((state.program.events || []).map(venueKey));
  const vals = [...s].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
  if (s.has(AGE_NA)) vals.push(AGE_NA);
  return vals;
}
// сброс к «всё выбрано» — при загрузке/обновлении/сбросе программы.
// ВАЖНО: не называть initFilters — так зовётся функция карты (GEO.filters)
// в map.js; app.js грузится позже и перекрыл бы её в общей области видимости.
function initEventFilters() {
  const ages = ageUniverse();
  const venues = venueUniverse();
  state.filters = { age: new Set(ages), venue: new Set(venues), _ages: ages, _venues: venues };
}
function ageFilterActive() { const f = state.filters; return !!f && f.age.size < f._ages.length; }
function venueFilterActive() { const f = state.filters; return !!f && f.venue.size < f._venues.length; }
// «активен хоть один» — для бейджа и развилки экспорта (в «рядом» — только ценз)
function anyFilterActive() { return ageFilterActive() || venueFilterActive(); }
function passesAge(e) { return !state.filters || state.filters.age.has(ageKey(e)); }
function passesVenue(e) { return !state.filters || state.filters.venue.has(venueKey(e)); }
function passesFilters(e) { return passesAge(e) && passesVenue(e); }

/* ---------- сохранение фильтров/дня/радиуса/поиска (sessionStorage) ----------
   Задача: рефреш (F5/свайп/тихий reload SW) НЕ должен сбрасывать настроенный
   фильтр. sessionStorage подходит идеально: переживает reload в рамках сессии,
   но чистится при закрытии вкладки/приложения → НОВЫЙ запуск открывается на
   «всё» (иначе юзер решит «событий нет», забыв про вчерашний фильтр). */
const FILT_KEY = 'insomnia.filters';

function saveFilterState() {
  try {
    const f = state.filters;
    const data = {
      type: state.type,
      view: state.view,       // вкладку тоже помним — тихий reload не должен бросать на «Сейчас»
      day: state.day || null,
      query: state.query || '',
      radius: (typeof GEO !== 'undefined' && GEO.nearby) ? GEO.nearby.radius : undefined,
    };
    // ценз/локацию пишем ТОЛЬКО когда сужены — иначе смена вселенной данных
    // потащила бы устаревшее сужение; «всё» = отсутствие ключа
    if (f && ageFilterActive()) data.age = [...f.age];
    if (f && venueFilterActive()) data.venue = [...f.venue];
    sessionStorage.setItem(FILT_KEY, JSON.stringify(data));
  } catch { /* приватный режим/квота — просто не переживёт рефреш, не критично */ }
}

// восстановление в boot ПОСЛЕ initEventFilters (у state.filters уже полные
// _ages/_venues от текущих данных); сужения пересекаем с актуальной вселенной —
// исчезнувшие после смены данных значения молча отбрасываем
function restoreFilterState() {
  let data;
  try { data = JSON.parse(sessionStorage.getItem(FILT_KEY) || 'null'); } catch { data = null; }
  if (!data) return;
  if (['all', 'program', 'animation'].includes(data.type)) {
    state.type = data.type;
    $$('#typeChips .chip[data-type]').forEach(c => c.classList.toggle('active', c.dataset.type === state.type));
  }
  const f = state.filters;
  // Пустой массив = юзер осознанно «снял всё» (показывает ничего) — восстанавливаем
  // как есть. Непустой массив, но НИ одно значение больше не существует в данных
  // (сменилась вселенная) — НЕ сужаем ложно, оставляем полный набор.
  if (f && Array.isArray(data.age)) {
    const valid = data.age.filter(a => f._ages.includes(a));
    if (data.age.length === 0 || valid.length) f.age = new Set(valid);
  }
  if (f && Array.isArray(data.venue)) {
    const valid = data.venue.filter(v => f._venues.includes(v));
    if (data.venue.length === 0 || valid.length) f.venue = new Set(valid);
  }
  if (data.query) {
    state.query = data.query;
    const inp = $('#searchInput'); if (inp) inp.value = data.query;
    const bar = $('#searchBar'); if (bar) bar.classList.remove('hidden');
  }
  if (data.day && state.program && state.program.events.some(e => e._festDay === data.day)) {
    state.day = data.day;
  }
  if (typeof GEO !== 'undefined' && GEO.nearby && Number.isFinite(data.radius)) {
    GEO.nearby.radius = data.radius;
  }
  if (['now', 'schedule', 'favorites', 'map', 'nearby'].includes(data.view)) {
    state.view = data.view; // render() ниже отрисует нужную вкладку
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === state.view));
  }
}

// смена вселенной данных (импорт нового файла / сброс к встроенной версии):
// полный сброс сужения к «всё» — устаревший тип/ценз/локация/поиск на новых
// данных мог бы дать пустой экран без объяснения (напр. фильтр «анимация» на
// файле только с дневной программой). Индикатор и сохранённое состояние тоже.
function resetFiltersToAll() {
  initEventFilters(); // ценз/локация → полные наборы новой вселенной
  state.type = 'all';
  $$('#typeChips .chip[data-type]').forEach(c => c.classList.toggle('active', c.dataset.type === 'all'));
  state.query = '';
  const si = $('#searchInput'); if (si) si.value = '';
  const sb = $('#searchBar'); if (sb) sb.classList.add('hidden');
  state.day = null;
  saveFilterState();
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
  // живой GPS-watch держим, пока открыт гео-раздел (карта ИЛИ «рядом») — обоим
  // нужен текущий фикс и статус «поиск спутников»; уход из обоих гасит и чистит
  if (state.view !== 'nearby' && state.view !== 'map') stopNearbyWatch();
  updateFilterButton();

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
    if (state.query) root.appendChild(queryEmptyState('🔍', 'Ничего не найдено'));
    else if (anyFilterActive()) root.appendChild(filterEmptyState('🌙', true));
    else root.appendChild(emptyState('🌙', '$ ps aux | grep событие → пусто. Спокойной ночи.'));
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
      root.appendChild(queryEmptyState('🔍', 'Ничего не найдено'));
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
  progExport.innerHTML = `
    <button class="btn ghost" id="btnProgramExport" aria-label="Выгрузить всю программу в календарь">📅 вся программа в календарь</button>
    <button class="btn ghost cal-dl" id="btnProgramDownload" aria-label="Скачать всю программу .ics">⬇️</button>`;
  progExport.querySelector('#btnProgramExport').addEventListener('click', () => openProgramExport('calendar'));
  progExport.querySelector('#btnProgramDownload').addEventListener('click', () => openProgramExport('download'));
  root.appendChild(progExport);

  const evs = filteredEvents()
    .filter(e => e._festDay === state.day)
    .sort(sortByStart);

  if (!evs.length) {
    root.appendChild(filterEmptyState('🔍', anyFilterActive()));
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
    <button class="btn ghost" id="routeShare" ${dis}>${window.InsomniaCore.shareIcon()} поделиться</button>
    <button class="btn ghost cal-dl" id="routeIcs" aria-label="Скачать весь маршрут .ics" ${dis}>⬇️</button>`;
  root.appendChild(routeActions);
  if (favs.length) {
    routeActions.querySelector('#routeCal').addEventListener('click', () => exportICS(favs, 'insomnia-favorites.ics'));
    routeActions.querySelector('#routeShare').addEventListener('click', () => exportICS(favs, 'insomnia-favorites.ics', { shareText: routeShareText(favs) }));
    routeActions.querySelector('#routeIcs').addEventListener('click', () => exportICS(favs, 'insomnia-favorites.ics', { forceDownload: true }));
  }

  // пустое состояние — только если избранного нет ВООБЩЕ:
  // одни сироты (size > 0, живых 0) должны показать плашку ниже.
  // ВАЖНО: «избранное пусто» и «не найдено по запросу» — разные сообщения.
  if (!state.favs.size) {
    root.appendChild(emptyState('☆', 'Пока ничего не выбрано. Нажмите ☆ у события, чтобы добавить и получить напоминание.'));
    return;
  }

  // Поиск фильтрует СПИСОК избранного (кнопки маршрута выше работают по
  // всему избранному — поиск сужает вид, а не сам маршрут).
  // ВАЖНО: «не найдено по запросу» — только когда живые избранные ЕСТЬ, но
  // запрос их скрыл. Если живых нет вовсе (все осиротели после обновления
  // данных), запрос ни при чём — проваливаемся ниже к плашке-сироте.
  const shown = state.query ? favs.filter(e => eventMatchesQuery(e, nQuery())) : favs;
  if (state.query && favs.length && !shown.length) {
    root.appendChild(queryEmptyState('🔍', 'В избранном ничего не найдено'));
    return;
  }

  const n = getNow();
  const showDivider = shown.some(e => e._startMs <= n) && shown.some(e => e._startMs > n);
  let lastDay = null;
  let injectedNow = false;
  shown.forEach(e => {
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
    else btn.addEventListener('click', () => { state.day = date; saveFilterState(); render(); });
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
function openDetail(id, restore) {
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
      <button class="btn ghost" id="detailShare" aria-label="Поделиться">${window.InsomniaCore.shareIcon()} поделиться</button>
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
    navEventToMap(e.id, btn.dataset.gid);
  }));
  if (restore) {
    // возврат с карты к описанию: слой описания уже лежит в стеке/истории —
    // просто показываем его БЕЗ нового pushState (иначе pushState внутри
    // popstate ненадёжен на Android и следующий «назад» проваливался мимо)
    const el = $('#sheet');
    const card = el.querySelector('.sheet-card'); if (card) card.scrollTop = 0;
    el.classList.remove('hidden');
  } else {
    showSheet('#sheet');
  }
}

/* ---------- модалки + перехват системного «назад» (History API) ----------
   Боль: на Android «назад» при открытом описании события выкидывал из приложения
   вместо закрытия. Решение: каждая открытая модалка = одна запись в истории.
   Аппаратный «назад»/свайп (popstate) закрывает ВЕРХНЮЮ модалку и остаётся в
   приложении; когда модалок нет — «назад» штатный (сворачивает PWA/уходит).
   Крестик/тап-вне закрывают ту же модалку и снимают её запись (history.go),
   чтобы «назад» потом не требовал лишних нажатий. Переход «закрыл A → открыл B»
   в один тик ПЕРЕИСПОЛЬЗУЕТ запись — без гонки back+push и без мусора в истории. */
const _sheetStack = [];        // селекторы открытых модалок (в порядке открытия)
let _histSelfPop = 0;          // ждём столько программных popstate (наш go) — проглотить
let _histTrimPending = 0;      // отложенно снять столько записей (микротаск)
let _histTrimScheduled = false;

function _scheduleHistTrim(n) {
  _histTrimPending += n;
  if (_histTrimScheduled) return;
  _histTrimScheduled = true;
  // микротаск: если в этом же тике откроют новую модалку, она «съест» pending
  // (переиспользует запись) — тогда триммить будет нечего или меньше
  queueMicrotask(() => {
    _histTrimScheduled = false;
    const k = _histTrimPending; _histTrimPending = 0;
    if (k > 0) { _histSelfPop++; history.go(-k); }
  });
}

function showSheet(sel) {
  const el = $(sel);
  if (!el) return;
  const wasHidden = el.classList.contains('hidden');
  el.classList.remove('hidden');
  if (!wasHidden) return;                        // уже открыт — историю не трогаем
  // свежее открытие переиспользуемой модалки → её скролл-контейнер в самый верх,
  // иначе описание нового события открывается прокрученным от прошлого (тот же
  // #sheet наполняется новым контентом, а scrollTop .sheet-card залипает).
  // При ре-открытии УЖЕ открытой модалки (напр. toggle ⭐ в описании) не трогаем.
  const card = el.querySelector('.sheet-card');
  if (card) card.scrollTop = 0;
  cancelExitWindow();                            // открыли модалку → это навигация, не выход
  if (_histTrimPending > 0) _histTrimPending--;  // переход A→B: переиспользуем запись
  else history.pushState({ sheet: sel }, '');
  _sheetStack.push(sel);
}

function _hideSheetEl(sel) {                      // синхронно скрыть + снять со стека
  const el = $(sel);
  if (!el || el.classList.contains('hidden')) return false;
  el.classList.add('hidden');
  const i = _sheetStack.lastIndexOf(sel);
  if (i !== -1) _sheetStack.splice(i, 1);
  return true;
}

function hideSheet(sel) {
  if (_hideSheetEl(sel)) _scheduleHistTrim(1);   // снять нашу запись из истории
}

function hideAllSheets() {
  // закрываем только МОДАЛКИ (строковые записи) сверху вниз; nav-шаги (объект
  // {onBack}, напр. «на карте от события») — не модалки, их не трогаем
  let n = 0;
  while (_sheetStack.length && typeof _sheetStack[_sheetStack.length - 1] === 'string') {
    const sel = _sheetStack.pop();
    const el = $(sel); if (el) el.classList.add('hidden');
    n++;
  }
  $$('.sheet').forEach(s => s.classList.add('hidden')); // визуально добить всё
  if (n > 0) _scheduleHistTrim(n);
}

// «событие → на карте»: описание НЕ теряется — заменяем его запись в стеке на
// «шаг назад = снова открыть ЭТО событие», переиспользуя ТУ ЖЕ запись истории
// (глубина не меняется). «Назад» с карты → вернёт описание; ещё «назад» → закроет
// его штатно. Пришли на карту не из события (вкладкой) → стек пуст → «назад»
// работает как обычная навигация. Синхронно с popstate-перехватом модалок.
function navEventToMap(eid, gid) {
  // вернуться в ТОТ вид, где было открыто описание — включая карту/«рядом»
  // (описание событий открывают и с карты через точку, и из «рядом»), иначе
  // «назад» выбросил бы на «Программу» вместо возврата к описанию на карте
  const fromView = state.view;
  // Модель [программа][описание][карта]: карту кладём ПОВЕРХ описания, запись
  // описания в истории СОХРАНЯЕМ. Тогда «назад» с карты вернёт описание (уже
  // существующий слой, без нового pushState внутри popstate), а следующее «назад»
  // закроет описание. applyView (не switchView) — карта здесь nav-слой ({onBack}),
  // а не вкладочный переход: отдельную tab-запись плодить не нужно.
  applyView('map');
  const el = $('#sheet'); if (el) el.classList.add('hidden'); // приспать описание (слой остаётся)
  // помечаем усыплённый слой объектом — чтобы уход с карты ВКЛАДКОЙ (dropNavSteps)
  // снял и его тоже (иначе «назад» позже воскресил бы описание поверх чужого экрана).
  // fromView несём в ОБОИХ слоях: уходя с карты-оверлея вкладкой, dropNavSteps
  // вернёт state.view к виду ПОД оверлеем — иначе map осталась бы «текущей
  // вкладкой» и switchView создал бы дубль {tab:map} → мёртвое «назад».
  if (_sheetStack[_sheetStack.length - 1] === '#sheet') {
    _sheetStack[_sheetStack.length - 1] = { suspended: '#sheet', eid, fromView };
  }
  // слой карты ПОВЕРХ описания — своя запись истории
  const step = { onBack: () => restoreDetailFromMap(eid, fromView), fromView };
  if (_histTrimPending > 0) _histTrimPending--; else history.pushState({ nav: 1 }, '');
  _sheetStack.push(step);
  setTimeout(() => highlightPoint(gid, { open: false }), 300);
}

// «назад» с карты, куда пришли из события: вернуть ТО ЖЕ описание. Запись описания
// в истории сохранена (усыплённый слой под картой) → показываем его БЕЗ pushState.
function restoreDetailFromMap(eid, fromView) {
  const i = _sheetStack.length - 1;
  if (_sheetStack[i] && _sheetStack[i].suspended === '#sheet') _sheetStack[i] = '#sheet'; // усыплённый → снова видимый слой
  applyView(fromView);    // вернуть вид ПОД описанием (не switchView — без tab-записи)
  openDetail(eid, true);  // restore: показать описание БЕЗ новой записи истории
}

// снять «висячие» nav-шаги (карта-из-события: {onBack}/{suspended}) сверху стека
// и их записи истории. Вызывается из switchView: явная смена вкладки делает шаг
// «вернуть описание» неактуальным. НЕ трогает tab-записи ({tab}) и модалки
// (строки) — они законные слои пути, «назад» их разматывает.
function dropNavSteps() {
  let n = 0, under = null;
  while (_sheetStack.length) {
    const top = _sheetStack[_sheetStack.length - 1];
    if (top && (top.onBack || top.suspended)) {
      if (top.fromView) under = top.fromView; // вид, что был ПОД картой-оверлеем
      _sheetStack.pop(); n++;
    } else break;
  }
  if (n > 0) {
    // уходя с карты-из-события ВКЛАДКОЙ, вернуть state.view к виду под оверлеем:
    // иначе switchView сочтёт map «текущей вкладкой» и создаст дубль {tab:map},
    // который переживёт схлопывание и даст мёртвое «назад» (баг verify #65).
    // Только bookkeeping — перерисует applyView внутри switchView следом.
    if (under) state.view = under;
    _scheduleHistTrim(n);
  }
}

// запись перехода между вкладками в ЕДИНЫЙ стек (зеркальна showSheet для модалок):
// «назад» вернёт на prevView. Переход A→B в один тик переиспользует запись.
function pushViewStep(prevView) {
  cancelExitWindow();                     // сменили вкладку → навигация, не выход
  if (_histTrimPending > 0) _histTrimPending--;
  else history.pushState({ tab: 1 }, '');
  _sheetStack.push({ tab: prevView });
}

// «страж выхода»: пока приложение на ДНЕ навигации (0 модалок и вкладочных слоёв),
// держим одну лишнюю запись истории над базой. Первое «назад» съедает стража —
// показываем тост «нажмите ещё раз» и НЕ возвращаем стража сразу (иначе выход
// требовал бы трёх нажатий). Второе «назад» в окне уходит на базу → платформа
// выходит/сворачивает PWA. Окно истекло — возвращаем стража (следующее «назад»
// снова покажет тост, а не молча выйдет). Восстановление — ТОЛЬКО в setTimeout,
// не внутри popstate: pushState в popstate ненадёжен на Android (см. фикс #64),
// а здесь синхронно он и не нужен. При флаки-пуше фича деградирует безопасно —
// в худшем случае второе «назад» просто выходит (это и так цель).
let _exitArmed = false;        // открыто окно «нажмите назад ещё раз, чтобы выйти»
let _exitGuard = false;        // страж лежит в истории (одна запись над базой на дне)
let _exitTimer = 0;
let _exitGuardScheduled = false;
const EXIT_WINDOW_MS = 2000;

function armExitGuardSoon() {
  if (_exitGuardScheduled) return;
  _exitGuardScheduled = true;
  setTimeout(() => {
    _exitGuardScheduled = false;
    if (_exitArmed) return;          // окно выхода открыто — стража быть НЕ должно
    if (_sheetStack.length) return;  // не на дне — слои сами буфер, страж не нужен
    if (_exitGuard) return;          // уже стоит
    // после полного рефреша / тихого reload приложение оказывается СТОЯЩИМ на
    // записи-страже (pushState-запись переживает reload, а флаг _exitGuard сброшен
    // свежим модулем) — усыновляем её, не плодя второго стража; иначе выход
    // требовал бы 3 нажатий, и стражи копились бы с каждым reload (verify #66 р2).
    if (history.state && history.state.exitGuard) { _exitGuard = true; return; }
    try { history.pushState({ exitGuard: 1 }, ''); _exitGuard = true; } catch { /* ignore */ }
  }, 0);
}

// закрыть окно «нажмите ещё раз»: пользователь после первого «назад» на дне не
// вышел, а СТАЛ НАВИГИРОВАТЬ (открыл модалку/сменил вкладку). Зовём при КАЖДОМ
// добавлении слоя (showSheet/pushViewStep/navEventToMap) — иначе _exitArmed завис
// бы true, и возврат на дно ушёл бы в выход одним «назад» без тоста (verify #66).
function cancelExitWindow() {
  if (!_exitArmed) return;
  _exitArmed = false;
  clearTimeout(_exitTimer);
}

// системный «назад»/свайп: снять ВЕРХНИЙ слой пути назад, не покидая приложение.
// Строковый слой = модалка (прячем); объект {onBack} = шаг навигации (напр. «на
// карте от события» → вернуть описание); {tab} = вкладка. Стек пуст → сработал
// страж выхода: первое «назад» = тост, второе в окне = выход.
window.addEventListener('popstate', () => {
  if (_histSelfPop > 0) {
    _histSelfPop--; // наш программный откат (закрытие крестиком/схлопывание) — уже скрыли
    // но если он приземлил нас на ДНО без стража (крестик/тап-вне съели запись
    // модалки, а страж был потрачен раньше) — восстановить стража, иначе следующее
    // «назад» молча выйдет (verify #66): end-check ниже сюда не доходит из-за return
    if (!_sheetStack.length) armExitGuardSoon();
    return;
  }
  const top = _sheetStack.pop(); // одна израсходованная запись = один слой
  if (typeof top === 'string') { const el = $(top); if (el) el.classList.add('hidden'); }
  else if (top && top.onBack) { try { top.onBack(); } catch { /* «назад» не должно падать */ } }
  else if (top && top.suspended) { const el = $(top.suspended); if (el) el.classList.add('hidden'); }
  else if (top && top.tab) { applyView(top.tab); } // вернуться на предыдущую вкладку (без записи)
  else {
    // стек пуст — «назад» на ДНЕ (страж съеден либо его не было)
    _exitGuard = false;
    if (_exitArmed) {
      // второе «назад» в окне — выпускаем: уже ушли на базу, платформа выйдет
      // (десктоп/Playwright: база→about:blank = выход; Android: первый entry →
      // ОС свернёт PWA). Стража НЕ возвращаем.
      clearTimeout(_exitTimer); _exitArmed = false;
      return;
    }
    // первое «назад» на дне — не выходим, просим подтвердить
    toast('Нажмите «назад» ещё раз, чтобы выйти', EXIT_WINDOW_MS);
    _exitArmed = true;
    clearTimeout(_exitTimer);
    _exitTimer = setTimeout(() => { _exitArmed = false; armExitGuardSoon(); }, EXIT_WINDOW_MS);
    return;
  }
  // вернулись на дно, но страж был съеден раньше (выход→взаимодействие→возврат)
  // и окно закрыто — восстановить стража, чтобы следующее «назад» не молча вышло
  if (!_sheetStack.length && !_exitGuard && !_exitArmed) armExitGuardSoon();
});

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
        if (err && err.name === 'AbortError') return; // осознанная отмена — тихо
        // Huawei и др.: canShare({files}) вернул true, но share() с файлом
        // отклонён (NotAllowedError). Текст самодостаточен — пробуем
        // поделиться ТОЛЬКО им (обычно проходит, где файловый шэр запрещён).
        if (data.files && shareText) {
          try {
            await navigator.share({ title: data.title, text: shareText });
            return;
          } catch (err2) {
            if (err2 && err2.name === 'AbortError') return;
          }
        }
        // и текстом не вышло / нечего текстом — честное скачивание с тостом
        await fallbackDownload(blob, filename, shareText, `Поделиться не вышло (${(err && err.name) || 'ошибка'}).`);
        return;
      }
    }
  }

  // сюда: принудительное скачивание, либо шэр недоступен/нечего шэрить
  const why = forceDownload ? ''
    : !navigator.share ? 'Функция «Поделиться» недоступна в этом браузере.'
    : 'Прямая отправка файла недоступна.';
  await fallbackDownload(blob, filename, shareText, why);
}

// Единый фолбэк: скачивание + (для «поделиться») текст в буфер, и КАЖДЫЙ
// путь показывает тост с причиной и подсказкой — никаких немых скачиваний.
async function fallbackDownload(blob, filename, shareText, why) {
  downloadBlob(blob, filename);
  const prefix = why ? why + ' ' : '';
  if (shareText && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(shareText);
      toast(prefix + 'Текст скопирован в буфер, файл .ics скачан — вставьте в мессенджер.', 5000);
      return;
    } catch { /* буфер недоступен (нет прав/insecure) — честно скажем ниже */ }
    toast(prefix + 'Буфер недоступен — файл .ics скачан в «Загрузки».', 5000);
    return;
  }
  toast(prefix + 'Файл .ics скачан — откройте его, чтобы добавить в календарь.', 5000);
}

// «Программа» → вся программа в календарь: сперва предупреждаем (нет
// напоминаний, разовый снимок), по подтверждению — ICS без VALARM.
// При активном фильтре — развилка: «всё» (игнор фильтра) или «только
// отфильтрованные N» (ценз/локация, все дни; день/поиск на выгрузку не влияют).
function funnelFilteredAll() {
  return (state.program.events || []).filter(e => e._startMs != null && passesFilters(e));
}
// режим финального действия модалки: 'calendar' (share/открыть в календаре)
// или 'download' (принудительно скачать .ics). Тексты/развилка кнопок общие.
let programExportMode = 'calendar';
function openProgramExport(mode) {
  programExportMode = mode === 'download' ? 'download' : 'calendar';
  const active = anyFilterActive();
  const all = (state.program.events || []).filter(e => e._startMs != null);
  const filtered = active ? all.filter(passesFilters) : all;
  $('#programExportHead').classList.toggle('hidden', active);
  $('#programExportFilterNote').classList.toggle('hidden', !active);
  $('#programExportFiltered').classList.toggle('hidden', !active);
  if (active) {
    $('#programExportFilterNote').textContent =
      `Сейчас включён фильтр, показано ${filtered.length} из ${all.length}. Что выгрузить?`;
    $('#programExportFiltered').textContent = `Только отфильтрованные (${filtered.length})`;
    $('#programExportGo').textContent = `Выгрузить всё (${all.length})`;
  } else {
    $('#programExportGo').textContent = 'Выгрузить всё';
  }
  showSheet('#programExport');
}
async function doProgramExport(filteredOnly) {
  hideSheet('#programExport');
  let list = (state.program.events || []).filter(e => e._startMs != null);
  if (filteredOnly) list = list.filter(passesFilters);
  if (!list.length) { toast('Нет событий для выгрузки'); return; }
  // формат/UID одинаковы; различается лишь финальный экшен — календарь
  // (share) или принудительное скачивание. Полная выгрузка — без VALARM.
  await exportICS(list, filteredOnly ? 'insomnia-filtered.ics' : 'insomnia-full-program.ics',
    { withAlarm: false, forceDownload: programExportMode === 'download' });
}

/* ---------- модалка фильтров ----------
   Работает на ЧЕРНОВИКЕ: правки применяются к state.filters только по «ОК».
   Любое иное закрытие (Отмена/крестик/светофор/бэкдроп) = откат. */
let filterDraft = null;
function openFilterSheet() {
  if (!state.filters) return;
  const nearby = state.view === 'nearby';
  filterDraft = { age: new Set(state.filters.age), venue: new Set(state.filters.venue) };
  // локация — только «сейчас/программа»; в «рядом» блок скрыт (фильтр по цензу)
  $('#filterVenueBlock').classList.toggle('hidden', nearby);
  $('#filterVenueSearch').value = '';
  renderFilterChips();
  showSheet('#filterSheet');
}
function filterChipLabel(val) { return val === '' ? 'не указано' : val; }
function buildFilterChips(host, universe, draftSet, q) {
  host.innerHTML = '';
  universe.forEach(val => {
    // поиск сужает список; «не указано» (пустое) при активном поиске прячем
    if (q && (val === '' || !val.toLowerCase().includes(q))) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fchip' + (draftSet.has(val) ? ' on' : '');
    b.textContent = filterChipLabel(val);
    b.setAttribute('aria-pressed', draftSet.has(val) ? 'true' : 'false');
    b.addEventListener('click', () => {
      if (draftSet.has(val)) draftSet.delete(val); else draftSet.add(val);
      const on = draftSet.has(val);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    host.appendChild(b);
  });
}
function renderFilterChips() {
  const q = ($('#filterVenueSearch').value || '').trim().toLowerCase();
  buildFilterChips($('#filterAgeChips'), state.filters._ages, filterDraft.age, '');
  buildFilterChips($('#filterVenueChips'), state.filters._venues, filterDraft.venue, q);
}
// «выбрать все»/«снять все» — ПО ГРУППАМ: ссылка действует только на свою
// группу (ценз или площадка), не трогая соседнюю
function filterGroupBulk(group, selectAll) {
  if (group === 'age') filterDraft.age = selectAll ? new Set(state.filters._ages) : new Set();
  else filterDraft.venue = selectAll ? new Set(state.filters._venues) : new Set();
  renderFilterChips();
}
function applyFilters() {
  state.filters.age = new Set(filterDraft.age);
  state.filters.venue = new Set(filterDraft.venue);
  saveFilterState();
  hideSheet('#filterSheet');
  render();
}
function resetFilters() {
  state.filters.age = new Set(state.filters._ages);
  state.filters.venue = new Set(state.filters._venues);
  saveFilterState();
  render();
}
// Кнопка-воронка живёт в ряду переключателей: в «сейчас/программа» — первой
// в #typeChips (виден только там: блок .filters скрыт в прочих видах); в
// «рядом» — первой в ряду радиусов (создаётся в renderNearby). Здесь только
// подсвечиваем индикатор активности на ВСЕХ таких кнопках; видимость даёт
// контейнер, поэтому «избранное/карта» кнопки не показывают автоматически.
function updateFilterButton() {
  const active = state.view === 'nearby' ? ageFilterActive() : anyFilterActive();
  $$('.filter-chip-btn').forEach(btn => {
    btn.classList.toggle('has-active', active);
    const dot = btn.querySelector('.filter-dot');
    if (dot) dot.classList.toggle('hidden', !active);
  });
}
// разметка кнопки-воронки для динамического ряда («рядом»)
function createFilterChipButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip filter-chip-btn';
  btn.title = 'Фильтры';
  btn.setAttribute('aria-label', 'Фильтры');
  btn.innerHTML = '<svg class="funnel-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 5h18l-7 9v5l-4 2v-7z" fill="currentColor"/></svg><span class="filter-dot hidden"></span>';
  btn.addEventListener('click', openFilterSheet);
  return btn;
}
// пустое состояние с кнопкой сброса, когда виноват именно фильтр
function filterEmptyState(icon, active) {
  const st = emptyState(icon, active ? 'Ничего не найдено по фильтрам.' : '$ grep: ничего не найдено по фильтру.');
  if (active) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = 'Сбросить фильтры';
    b.addEventListener('click', resetFilters);
    st.appendChild(b);
  }
  return st;
}
// Сквозной поиск: сброс запроса разом на ВСЕХ вкладках (крестик в поле и
// кнопки «Очистить поиск» в пустых состояниях зовут одно и то же).
function clearSearch() {
  $('#searchBar').classList.add('hidden');
  $('#searchInput').value = '';
  state.query = '';
  saveFilterState();
  render();
  window.scrollTo(0, 0);
}
// Пустое состояние из-за поиска: объясняем причину + даём выход, чтобы
// человек не решил, что вкладка сломана (текст запроса — экранируем).
function queryEmptyState(icon, prefix) {
  const st = emptyState(icon, `${prefix} по запросу «${state.query}».`);
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = 'Очистить поиск';
  b.addEventListener('click', clearSearch);
  st.appendChild(b);
  return st;
}
//* ---------- favorites ---------- */
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
  // ⭐ НЕ должна ронять прокрутку списка: toggle меняет только флаг у карточки,
  // число строк в «сейчас/программе» то же — сохраняем и возвращаем scroll, чтобы
  // событие осталось на месте (иначе render() пересобирает #content с нуля →
  // прыжок вверх). В «избранном» удаление строки укорачивает список — браузер
  // сам ограничит scrollTo разумным максимумом.
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
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
  resetFiltersToAll(); // вселенная сменилась → тип/ценз/локация/день/поиск → «всё»
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
    resetFiltersToAll(); // вернулись к встроенной версии → тип/ценз/локация/день/поиск → «всё»
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
  // был ли контроллер на момент загрузки: если нет — ПЕРВЫЙ controllerchange
  // это первая установка SW (перезагружать не надо, просто «теперь контроллер
  // есть»); все ПОСЛЕДУЮЩИЕ controllerchange = обновление кода → тихий reload
  let hasController = !!navigator.serviceWorker.controller;
  try {
    state.swReg = await navigator.serviceWorker.register('sw.js');
    setTimeout(checkOfflineReady, 2500); // прекэш к этому моменту обычно уже едет
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hasController) { hasController = true; return; } // первая установка
      armSilentReload();
    });
  } catch (err) { /* offline / unsupported */ }
}

/* ---------- тихое авто-обновление кода ----------
   Новый SW делает skipWaiting → берёт контроль → controllerchange. Мы
   перезагружаем страницу САМИ, но только в безопасный момент: без открытых
   модалок и после паузы без действий (чтобы не дёрнуть под пальцами).
   Избранное/метки живут в localStorage и переживают reload. */
let __reloadArmed = false;
let __reloadTimer = null;

function anyModalOpen() {
  // все модалки — .sheet; открытая = без класса hidden
  return [...document.querySelectorAll('.sheet')].some(s => !s.classList.contains('hidden'));
}

function armSilentReload() {
  if (window.__reloadingForUpdate) return;
  __reloadArmed = true;
  scheduleSilentReload();
}

function scheduleSilentReload() {
  if (!__reloadArmed || window.__reloadingForUpdate) return;
  clearTimeout(__reloadTimer);
  // перезагрузка только после паузы без действий И без открытых модалок
  __reloadTimer = setTimeout(() => {
    if (!__reloadArmed || window.__reloadingForUpdate) return;
    if (anyModalOpen()) return; // ждём: закрытие модалки — интеракция → перепланируем
    window.__reloadingForUpdate = true;
    location.reload();
  }, 2500);
}

// любое действие пользователя откладывает тихую перезагрузку (debounce);
// возвращение из фона — тоже подходящий момент проверить простой
function wireSilentReloadIdle() {
  const bump = () => { if (__reloadArmed) scheduleSilentReload(); };
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach(ev =>
    window.addEventListener(ev, bump, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && __reloadArmed) scheduleSilentReload();
  });
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

// в настройках: если приложение уже установлено (standalone) — прячем
// кнопку/инструкцию установки, чтобы не путать; показываем «✓ установлено».
// Индикатор офлайн-готовности (#offlineStatus) остаётся в любом случае.
function updateInstallSection() {
  const installed = isStandalone();
  // intro и кнопку переключаем в обе стороны
  ['#installIntro', '#btnInstall'].forEach(sel => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', installed);
  });
  // подсказку и браузер-варнинг только ПРЯЧЕМ при установке; показ ими
  // управляют свои места (iOS-инструкция, updateInstallBar)
  if (installed) {
    ['#installHint', '#browserWarn'].forEach(sel => { const el = $(sel); if (el) el.classList.add('hidden'); });
  }
  const note = $('#installedNote');
  if (note) note.classList.toggle('hidden', !installed);
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
  pingInstall(); // тихий счётчик установок в телеграм (если настроен)
});

// Одноразовый пинг «установили» в телеграм через мусорный бот. Токен и чат —
// НЕ в репозитории: их подставляет CI из секретов в config.js (window.APP_CONFIG),
// которого локально/в тестах нет → пинг молча выключен. Офлайн/ошибка — не беда:
// флаг ставим только по факту успешной отправки, чтобы не потерять и не спамить.
function pingInstall() {
  try {
    if (localStorage.getItem(LS.installPinged) === '1') return;
    const tg = (window.APP_CONFIG || {}).tg;
    if (!tg || !tg.token || !tg.chat) return; // не настроено — тихо выходим
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const text = `📲 «Бессонница 2026» установлена — ${when} UTC`;
    fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chat, text }),
    }).then(res => { if (res && res.ok) localStorage.setItem(LS.installPinged, '1'); })
      .catch(() => { /* офлайн — appinstalled не повторится, но и спама не будет */ });
  } catch { /* приватный режим/localStorage недоступен — не критично */ }
}

/* ---------- event wiring ---------- */
function wireUI() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
  // только чипы-типы (у кнопки-фильтра нет data-type — её не трогаем)
  $$('#typeChips .chip[data-type]').forEach(c => c.addEventListener('click', () => {
    $$('#typeChips .chip[data-type]').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    state.type = c.dataset.type;
    saveFilterState();
    render();
  }));

  // search
  $('#btnSearch').addEventListener('click', () => {
    $('#searchBar').classList.remove('hidden');
    $('#searchInput').focus();
  });
  $('#btnSearchClose').addEventListener('click', clearSearch);
  // Сквозной поиск: запрос общий для всех вкладок, применяется к данным
  // текущей (события / метки / радиус) — см. render каждого вида. Debounce
  // ~200мс, чтобы не дёргать перерисовку на каждой букве.
  let searchDebounce = null;
  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    saveFilterState();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      render();
      // размер выдачи скачет между нажатиями: без сброса скролла результат
      // (или пустое состояние) остаётся спрятанным за липкой шапкой
      window.scrollTo(0, 0);
    }, 200);
  });

  // settings sheet
  $('#btnSettings').addEventListener('click', () => { updateNotifStatus(); updateDataInfo(); showSheet('#settings'); });
  // закрывает СВОЙ шит (крестик/светофор/бэкдроп лежат внутри .sheet); идёт через
  // hideSheet, чтобы снять запись истории — крестик и «назад» дают одно и то же
  $$('[data-close]').forEach(el => el.addEventListener('click', () => {
    const sheet = el.closest('.sheet');
    if (sheet && sheet.id) hideSheet('#' + sheet.id);
    else if (sheet) sheet.classList.add('hidden');
  }));

  // подтверждение выгрузки всей программы (кнопка #btnProgramExport —
  // динамическая, навешана в renderSchedule)
  $('#programExportGo').addEventListener('click', () => doProgramExport(false));
  $('#programExportFiltered').addEventListener('click', () => doProgramExport(true));

  // фильтры-воронка
  $('#btnFilter').addEventListener('click', openFilterSheet);
  $('#filterApply').addEventListener('click', applyFilters);
  // групповые ссылки «выбрать все»/«снять все» — каждая на свою группу
  $('#ageSelectAll').addEventListener('click', () => filterGroupBulk('age', true));
  $('#ageClear').addEventListener('click', () => filterGroupBulk('age', false));
  $('#venueSelectAll').addEventListener('click', () => filterGroupBulk('venue', true));
  $('#venueClear').addEventListener('click', () => filterGroupBulk('venue', false));
  $('#filterVenueSearch').addEventListener('input', renderFilterChips);

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
  updateInstallSection();
  if (!isStandalone() && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
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

  // обновление приложения теперь тихое (без баннера) — см. armSilentReload;
  // здесь только навешиваем «простой»-детекторы для отложенной перезагрузки
  wireSilentReloadIdle();

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
  initEventFilters();
  noteDataVersion(state.program);
  restoreFilterState();          // фильтры/день/радиус/поиск переживают рефреш (sessionStorage)
  if (!state.day) state.day = pickDefaultDay(); // день не восстановили → дефолт
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
  armExitGuardSoon();  // защита от случайного выхода: «нажмите назад ещё раз»
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
