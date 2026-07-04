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

  /* ---------- пользовательские метки (user pins) ---------- */
  // bbox поляны + мягкий запас: за пределами — предупреждаем, но не запрещаем
  const FEST_BBOX = { latMin: 54.67, latMax: 54.70, lngMin: 35.05, lngMax: 35.10 };

  function pinKey(name) {
    // нормализованный ключ имени: «повторное имя = обновление»
    return String(name || '').trim().toLowerCase();
  }

  function parseCoordPairs(text) {
    // «54,68712 35,07934» (русская десятичная запятая), «54.687, 35.079»,
    // 4+ числа — попарно; целые без дробной части координатами не считаем.
    // Два прохода: сначала пары в окрестности поляны (постороннее число
    // вроде «5,5 км» не сбивает настоящие координаты), потом остальные.
    const norm = String(text || '').replace(/(\d),(\d)/g, '$1.$2');
    const nums = (norm.match(/-?\d{1,3}\.\d+/g) || []).map(Number);
    const used = new Array(nums.length).fill(false);
    const found = []; // {at, lat, lng} — соберём и вернём в порядке текста
    for (let i = 0; i + 1 < nums.length; i++) {
      if (used[i] || used[i + 1]) continue;
      if (!pinOutsideFest({ lat: nums[i], lng: nums[i + 1] })) {
        found.push({ at: i, lat: nums[i], lng: nums[i + 1] });
        used[i] = used[i + 1] = true;
        i++;
      }
    }
    // остаток — скользящим окном по валидным диапазонам (не по жёстким парам)
    const rest = [];
    nums.forEach((n, i) => { if (!used[i]) rest.push({ n, at: i }); });
    for (let i = 0; i + 1 < rest.length;) {
      const lat = rest[i].n, lng = rest[i + 1].n;
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        found.push({ at: rest[i].at, lat, lng });
        i += 2;
      } else i += 1; // мусорное число сдвигает окно, не съедая соседа
    }
    return found.sort((a, b) => a.at - b.at).map(({ lat, lng }) => ({ lat, lng }));
  }

  function pinFromHash(hashOrUrl) {
    // #pin=lat,lng,name,emoji — имя URL-кодировано; мусор -> null, не падаем
    const m = String(hashOrUrl || '').match(/#pin=([^#]+)/);
    if (!m) return null;
    const parts = m[1].split(',');
    // пустая строка через Number() даёт 0 («нулевой остров») — требуем цифры
    const NUM = /^-?\d{1,3}(\.\d+)?$/;
    const latS = (parts[0] || '').trim(), lngS = (parts[1] || '').trim();
    if (!NUM.test(latS) || !NUM.test(lngS)) return null;
    const lat = Number(latS), lng = Number(lngS);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    let name = '';
    try { name = decodeURIComponent(parts[2] || ''); } catch { name = parts[2] || ''; }
    let emoji = '';
    try { emoji = decodeURIComponent(parts[3] || ''); } catch { emoji = ''; }
    // лимиты как в редакторе: чужая ссылка не обходит ограничения полей
    return { lat, lng, name: name.trim().slice(0, 60), emoji: emoji.trim().slice(0, 8) };
  }

  function pinToHash(pin) {
    const lat = Number(pin.lat).toFixed(5), lng = Number(pin.lng).toFixed(5);
    return `#pin=${lat},${lng},${encodeURIComponent(pin.name || '')},${encodeURIComponent(pin.emoji || '')}`;
  }

  function parsePinsFromText(text) {
    // свободный текст: строки с парой координат -> метки; имя — СОСЕДНЯЯ
    // строка без координат (строго над, иначе строго под — пустая строка
    // рвёт соседство); geo:-URI и #pin= тоже понимаем
    const out = [];
    // несколько #pin= в одной строке (экспорт «одной строкой») — расклеиваем
    const lines = String(text || '').split(/\n/).flatMap(l => l.split(/(?=#pin=)/));
    const isCoordLine = lines.map(l => parseCoordPairs(l).length > 0);
    // строка-имя достаётся ровно ОДНОЙ координатной строке (формат
    // «координаты, под ними имя» не должен схлопывать метки при импорте)
    const usedName = new Set();
    const nameIdx = i => (lines[i] != null && !isCoordLine[i] && lines[i].trim() && !usedName.has(i)) ? i : -1;
    lines.forEach((line, i) => {
      const fromHash = pinFromHash(line);
      if (fromHash) { out.push(fromHash); return; }
      const geo = line.match(/geo:(-?\d{1,3}[.,]\d+)\s*,\s*(-?\d{1,3}[.,]\d+)/i);
      if (geo) {
        out.push({ lat: Number(geo[1].replace(',', '.')), lng: Number(geo[2].replace(',', '.')), name: '', emoji: '' });
        return;
      }
      const pairs = parseCoordPairs(line);
      if (!pairs.length) return;
      let ni = nameIdx(i - 1);
      if (ni < 0) ni = nameIdx(i + 1);
      const name = ni >= 0 ? lines[ni].trim() : '';
      if (ni >= 0) usedName.add(ni);
      pairs.forEach((p, k) => out.push({ ...p, name: pairs.length > 1 ? `${name} ${k + 1}`.trim() : name, emoji: '' }));
    });
    return out;
  }

  const PIN_LIMIT = 50;

  function upsertPin(pins, pin, limit = PIN_LIMIT) {
    // то же имя (без регистра/пробелов) -> обновить, не дублировать
    const key = pinKey(pin.name);
    const list = pins.slice();
    const i = list.findIndex(p => pinKey(p.name) === key);
    if (i >= 0) { list[i] = { ...list[i], ...pin }; return { ok: true, pins: list, updated: true }; }
    if (list.length >= limit) return { ok: false, pins, updated: false, reason: 'limit' };
    list.push(pin);
    return { ok: true, pins: list, updated: false };
  }

  function pinOutsideFest(pin, marginKm = 10) {
    // мягкое предупреждение: дальше ~10 км от поляны
    const dLat = marginKm / 111.32;
    const dLng = marginKm / (111.32 * Math.cos(54.68 * Math.PI / 180));
    return pin.lat < FEST_BBOX.latMin - dLat || pin.lat > FEST_BBOX.latMax + dLat ||
           pin.lng < FEST_BBOX.lngMin - dLng || pin.lng > FEST_BBOX.lngMax + dLng;
  }

  /* ---------- экспорт в календарь (iCalendar / RFC 5545) ----------
     Всё на клиенте, без сети. Время события — наивная МСК; момент берём
     через epochFromISO (НЕ клеим строку), печатаем в UTC с суффиксом Z —
     календарь сам покажет его в таймзоне устройства. */
  const ICS_DOMAIN = 'insonmia';
  const ICS_PRODID = '-//insonmia//Bessonnica 2026//RU';

  function icsEscape(s) {
    // RFC 5545 §3.3.11 (TEXT): экранируем \ ; , и переносы строк
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  function utf8Len(ch) {
    // длина одного код-пойнта в октетах UTF-8 (без зависимости от TextEncoder)
    const c = ch.codePointAt(0);
    if (c <= 0x7f) return 1;
    if (c <= 0x7ff) return 2;
    if (c <= 0xffff) return 3;
    return 4;
  }

  function icsFold(line) {
    // RFC 5545 §3.1: физическая строка ≤75 октетов; перенос — CRLF + пробел.
    // Складываем по код-пойнтам (кириллица = 2 байта), не рвём символ.
    let out = '';
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = utf8Len(ch);
      if (bytes + b > 75) {
        out += (out ? '\r\n' : '') + cur;
        cur = ' ' + ch; // ведущий пробел продолжения входит в лимит
        bytes = 1 + b;
      } else {
        cur += ch;
        bytes += b;
      }
    }
    return out + (out ? '\r\n' : '') + cur;
  }

  function icsStamp(ms) {
    // эпоха мс -> UTC-штамп YYYYMMDDTHHMMSSZ
    const d = new Date(ms);
    return d.getUTCFullYear().toString() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
      + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }

  function icsUid(e) {
    // стабильный UID: повторный импорт обновляет событие, а не дублирует
    return `${e.id}@${ICS_DOMAIN}`;
  }

  function icsVevent(e, dtstampMs, leadMin, withAlarm) {
    const start = e._startMs != null ? e._startMs : epochFromISO(e.startISO);
    if (start == null) return null; // без старта событие не запланировать
    let end = e._endMs != null ? e._endMs : epochFromISO(e.endISO);
    if (end == null || end <= start) end = start + 3600000; // нет конца → +1 час
    // напоминание за выбранное пользователем время (как в пушах приложения);
    // некорректное значение → 15 мин
    const lead = Number.isFinite(leadMin) && leadMin > 0 ? Math.round(leadMin) : 15;
    const descParts = [];
    if (e.description) descParts.push(e.description);
    else if (e.films && e.films.length) descParts.push('Фильмы: ' + e.films.join(', '));
    descParts.push('Бессонница 2026');
    const lines = [
      'BEGIN:VEVENT',
      'UID:' + icsUid(e),
      'DTSTAMP:' + icsStamp(dtstampMs),
      'DTSTART:' + icsStamp(start),
      'DTEND:' + icsStamp(end),
      'SUMMARY:' + icsEscape(e.title),
      'LOCATION:' + icsEscape(e.venue || ''),
      'DESCRIPTION:' + icsEscape(descParts.join('\n')),
    ];
    // VALARM только если явно попросили (осознанно выбранные события).
    // Полная выгрузка программы (700+) идёт БЕЗ будильников — иначе телефон
    // засыпет сотнями напоминаний.
    if (withAlarm) {
      lines.push(
        'BEGIN:VALARM',
        'TRIGGER:-PT' + lead + 'M',
        'ACTION:DISPLAY',
        'DESCRIPTION:' + icsEscape(e.title),
        'END:VALARM');
    }
    lines.push('END:VEVENT');
    return lines;
  }

  function buildICS(events, opts) {
    // events[] -> строка VCALENDAR с одним/несколькими VEVENT (CRLF, фолдинг)
    const o = opts || {};
    // dtstampMs — момент генерации (UTC); в тестах инжектируется для детерминизма
    const dtstampMs = o.dtstampMs != null ? o.dtstampMs
      : (typeof Date.now === 'function' ? Date.now() : 0);
    const leadMin = o.leadMin; // за сколько минут напомнить (VALARM); дефолт 15
    // withAlarm по умолчанию true (одиночное/избранное); полная выгрузка → false
    const withAlarm = o.withAlarm !== false;
    const head = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:' + ICS_PRODID,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    const body = [];
    (events || []).forEach(e => {
      const v = icsVevent(e, dtstampMs, leadMin, withAlarm);
      if (v) body.push(...v);
    });
    const all = head.concat(body, ['END:VCALENDAR']);
    return all.map(icsFold).join('\r\n') + '\r\n';
  }

  exports.icsEscape = icsEscape;
  exports.icsFold = icsFold;
  exports.icsStamp = icsStamp;
  exports.icsUid = icsUid;
  exports.buildICS = buildICS;

  exports.parseCoordPairs = parseCoordPairs;
  exports.parsePinsFromText = parsePinsFromText;
  exports.pinFromHash = pinFromHash;
  exports.pinToHash = pinToHash;
  exports.upsertPin = upsertPin;
  exports.pinOutsideFest = pinOutsideFest;
  exports.pinKey = pinKey;
  exports.PIN_LIMIT = PIN_LIMIT;
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
