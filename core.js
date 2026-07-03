/* Бессонница 2026 — чистая логика времени и гео.
   Ни DOM, ни состояния: все функции принимают now/position параметрами.
   Грузится и в браузере (до app.js/map.js), и в node (для автотестов). */
(function (exports) {
  'use strict';

  /* ---------- время: московская модель ----------
     Всё расписание — МСК (UTC+3, без DST). Сравнения только по эпохам
     (мс UTC): результат не зависит от таймзоны устройства. */
  const MSK_MS = 3 * 3600 * 1000;
  const DAY_CUTOFF = 6; // фестивальные сутки: 06:00 -> 05:59 следующего дня
  const pad2 = x => String(x).padStart(2, '0');

  function epochFromISO(iso) {
    // наивная московская ISO-строка -> эпоха мс
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

  function getFestivalDay(nowMs) {
    // 02:00 ночи пн — ещё фестивальное «вс»; граница 06:00
    const p = mskOf(nowMs - DAY_CUTOFF * 3600 * 1000);
    return `${p.y}-${pad2(p.mo + 1)}-${pad2(p.day)}`;
  }

  function statusOf(e, nowMs) {
    // все случаи nowMs >= start уже разобраны первыми тремя ветками
    const s = e._startMs, en = e._endMs;
    if (s != null && en != null && nowMs >= s && nowMs < en) return 'live';
    if (s != null && en != null && nowMs >= en) return 'past';
    if (s != null && en == null && nowMs >= s) return 'past';
    const mins = s != null ? (s - nowMs) / 60000 : Infinity;
    if (mins > 0 && mins <= 30) return 'soon';
    return 'upcoming';
  }

  function sortByStart(a, b) {
    return (a._startMs ?? Infinity) - (b._startMs ?? Infinity)
      || (a.venue || '').localeCompare(b.venue || '');
  }

  function nightInfo(e, WD) {
    // «после полуночи» (00:00–05:59 мск) — ночь предыдущего фест-дня
    if (e._startMs == null) return null;
    const p = mskOf(e._startMs);
    if (p.h >= DAY_CUTOFF) return null;
    return { marker: `🌙 ночь на ${(WD || ['вс','пн','вт','ср','чт','пт','сб'])[p.dow]}`, dow: p.dow };
  }

  function decorateEvents(events, fallbackFestDay) {
    events.forEach(e => {
      e._startMs = epochFromISO(e.startISO);
      e._endMs = epochFromISO(e.endISO);
      e._festDay = e._startMs != null ? getFestivalDay(e._startMs)
        : (fallbackFestDay ? fallbackFestDay(e) : e.date);
    });
    return events;
  }

  function getCurrent(events, nowMs) {
    return events.filter(e => statusOf(e, nowMs) === 'live').sort(sortByStart);
  }

  function getUpcoming(events, nowMs, horizonMin) {
    const horizon = horizonMin != null ? nowMs + horizonMin * 60000 : Infinity;
    return events
      .filter(e => e._startMs != null && e._startMs > nowMs && e._startMs <= horizon)
      .sort(sortByStart);
  }

  /* ---------- гео ---------- */
  function distanceM(a, b) {
    // хаверсин, метры
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(s)));
  }

  function bearingLabel(from, to) {
    const rad = Math.PI / 180;
    const y = Math.sin((to.lng - from.lng) * rad) * Math.cos(to.lat * rad);
    const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) -
      Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lng - from.lng) * rad);
    const brng = (Math.atan2(y, x) / rad + 360) % 360;
    const dirs = ['севернее', 'северо-восточнее', 'восточнее', 'юго-восточнее',
                  'южнее', 'юго-западнее', 'западнее', 'северо-западнее'];
    return dirs[Math.round(brng / 45) % 8];
  }

  function getNearby(points, events, position, nowMs, radiusM, venuePoints) {
    // точки в радиусе + события «идёт / скоро 60 мин» на них;
    // сортировка: по дистанции; события внутри точки: идёт раньше скоро
    const vp = venuePoints || {};
    const withDist = points
      .map(p => ({ ...p, dist: distanceM(position, p) }))
      .filter(p => !radiusM || p.dist <= radiusM)
      .sort((a, b) => a.dist - b.dist);
    return withDist.map(p => {
      const venues = Object.keys(vp).filter(v => vp[v].includes(p.id));
      const evs = events
        .filter(e => venues.includes(e.venue))
        .filter(e => {
          if (e._startMs == null) return false;
          const live = e._endMs != null
            ? (nowMs >= e._startMs && nowMs < e._endMs) : false;
          const soon = e._startMs > nowMs && e._startMs - nowMs <= 60 * 60000;
          return live || soon;
        })
        .sort((a, b) => {
          const liveA = a._startMs <= nowMs ? 0 : 1;
          const liveB = b._startMs <= nowMs ? 0 : 1;
          return liveA - liveB || a._startMs - b._startMs;
        });
      return { ...p, events: evs };
    });
  }

  function createGeoWatcher(geolocation, onFix, throttleMs = 10000, clock = Date.now, onError = null) {
    // жизненный цикл watchPosition c троттлингом; clearWatch ровно один раз;
    // clock инжектируется — тесты проверяют троттлинг детерминированно.
    // enableHighAccuracy заставляет браузер дёргать именно GPS: сетевое
    // определение (дефолт Яндекс Браузера) без интернета не работает вовсе
    let watchId = null;
    let lastAt = -Infinity;
    return {
      start() {
        if (!geolocation || watchId != null) return;
        watchId = geolocation.watchPosition(pos => {
          const t = clock();
          if (t - lastAt < throttleMs) return;
          lastAt = t;
          onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        }, err => { if (onError) onError(err); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
      },
      stop() {
        if (watchId != null && geolocation) {
          geolocation.clearWatch(watchId);
          watchId = null;
        }
      },
      get active() { return watchId != null; },
    };
  }

  exports.MSK_MS = MSK_MS;
  exports.DAY_CUTOFF = DAY_CUTOFF;
  exports.epochFromISO = epochFromISO;
  exports.mskOf = mskOf;
  exports.getFestivalDay = getFestivalDay;
  exports.statusOf = statusOf;
  exports.sortByStart = sortByStart;
  exports.nightInfo = nightInfo;
  exports.decorateEvents = decorateEvents;
  exports.getCurrent = getCurrent;
  exports.getUpcoming = getUpcoming;
  exports.distanceM = distanceM;
  exports.bearingLabel = bearingLabel;
  exports.getNearby = getNearby;
  exports.createGeoWatcher = createGeoWatcher;
})(typeof module !== 'undefined' && module.exports
   ? module.exports
   : (window.InsomniaCore = {}));
