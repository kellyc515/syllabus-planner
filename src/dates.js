// Small date helpers. Everything is stored as a local "YYYY-MM-DD" string so
// there are no timezone surprises when it round-trips through localStorage.

export const MS_DAY = 86400000;

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

export function daysBetween(aKey, bKey) {
  return Math.round((fromKey(bKey) - fromKey(aKey)) / MS_DAY);
}

export function weekday(key) {
  return fromKey(key).getDay(); // 0 = Sun
}

export function isWeekend(key) {
  const w = weekday(key);
  return w === 0 || w === 6;
}

const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function prettyDate(key, { withWeekday = false } = {}) {
  const d = fromKey(key);
  const base = `${MO_LONG[d.getMonth()]} ${d.getDate()}`;
  return withWeekday ? `${WD_LONG[d.getDay()]}, ${base}` : base;
}

export function prettyRange(aKey, bKey) {
  const a = fromKey(aKey);
  const b = fromKey(bKey);
  if (a.getMonth() === b.getMonth()) {
    return `${MO_LONG[a.getMonth()]} ${a.getDate()}–${b.getDate()}`;
  }
  return `${prettyDate(aKey)} – ${prettyDate(bKey)}`;
}

// Given a term-start key, pick the year that places month/day on or after the
// term start (so a "Jan 20" line in a Fall syllabus rolls into the next year).
function resolveYear(month, day, termStartKey) {
  const start = fromKey(termStartKey);
  let year = start.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate < new Date(year, start.getMonth(), start.getDate()) - MS_DAY * 30) {
    year += 1;
  }
  return year;
}

// Try hard to pull a real calendar date out of a chunk of syllabus text.
// Returns a "YYYY-MM-DD" key or null. termStartKey drives year inference.
export function parseDate(text, termStartKey, opts = {}) {
  if (!text) return null;
  const t = text.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');

  // 0) Optional: a leading 3–4 digit "MMDD" token (OCR dropped the slash), only
  //    when the caller opts in — common in "1027 Quiz 7" style schedule rows.
  if (opts.leadingMMDD) {
    const lm = t.match(/^\s*\(?\s*(1[0-2]|0?[1-9])([0-3]\d)\b(?!\s*[\/\-.]\d)/);
    if (lm) {
      const month = Number(lm[1]) - 1;
      const day = Number(lm[2]);
      if (day >= 1 && day <= 31) {
        const year = resolveYear(month, day, termStartKey);
        return toKey(new Date(year, month, day));
      }
    }
  }

  // 1) Month name + day:  "sept 12", "september 12, 2026", "12 september"
  const monthNames = Object.keys(MONTHS).join('|');
  let m =
    t.match(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`)) ||
    null;
  if (m) {
    const month = MONTHS[m[1]];
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : resolveYear(month, day, termStartKey);
    if (day >= 1 && day <= 31) return toKey(new Date(year, month, day));
  }
  m = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\.?(?:\\s*,?\\s*(\\d{4}))?`));
  if (m) {
    const month = MONTHS[m[2]];
    const day = Number(m[1]);
    const year = m[3] ? Number(m[3]) : resolveYear(month, day, termStartKey);
    if (day >= 1 && day <= 31) return toKey(new Date(year, month, day));
  }

  // 2) Numeric: "9/12", "9/12/2026", "09-12-26"
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (m) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    let year;
    if (m[3]) {
      year = Number(m[3]);
      if (year < 100) year += 2000;
    } else {
      year = resolveYear(month, day, termStartKey);
    }
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      return toKey(new Date(year, month, day));
    }
  }

  return null;
}

// Month grid (array of weeks, each 7 keys) covering the month that `anchorKey`
// falls in, padded with leading/trailing days to full weeks (weeks start Sun).
export function monthGrid(anchorKey) {
  const d = fromKey(anchorKey);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const weeks = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      row.push(toKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
    if (cursor.getMonth() !== d.getMonth() && w >= 3) break;
  }
  return weeks;
}

export function monthLabel(anchorKey) {
  const d = fromKey(anchorKey);
  return `${MO_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export function shiftMonth(anchorKey, delta) {
  const d = fromKey(anchorKey);
  return toKey(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}
