// Heuristic syllabus parser: raw text -> list of candidate items
// { type, title, date, weightPct, source }
//
// This is intentionally forgiving. It will miss things and mis-tag things —
// the app always shows the results in an editable review table before anything
// lands on the calendar.

import { parseDate } from './dates.js';

export const TYPES = [
  'final',
  'midterm',
  'exam',
  'quiz',
  'assignment',
  'project',
  'paper',
  'lab',
  'presentation',
  'reading',
  'discussion',
  'other',
];

// Default effort estimate (hours) used for calendar load + study planning.
export const DEFAULT_EFFORT = {
  final: 10,
  midterm: 6,
  exam: 5,
  quiz: 1.5,
  assignment: 3,
  project: 8,
  paper: 6,
  lab: 2,
  presentation: 4,
  reading: 1.5,
  discussion: 0.75,
  other: 2,
};

// How many days ahead we spread prep work for each type (0 = day-of only).
export const DEFAULT_LEAD_DAYS = {
  final: 10,
  midterm: 7,
  exam: 5,
  quiz: 2,
  assignment: 2,
  project: 14,
  paper: 10,
  lab: 1,
  presentation: 7,
  reading: 0,
  discussion: 0,
  other: 2,
};

// Order matters: more specific / noun-like categories are checked before the
// exam family so "research paper final" is a paper, not a final.
const TYPE_PATTERNS = [
  ['lab', /\b(lab report|lab\b|laboratory|prelab|post[-\s]?lab)\b/i],
  ['presentation', /\b(present(?:ation)?|slides deck)\b/i],
  ['project', /\bproject\b/i],
  ['paper', /\b(paper|essay|thesis|write[-\s]?up|book report|lab write)\b/i],
  ['discussion', /\b(discussion (?:post|board)|forum post|reflection post)\b/i],
  ['reading', /\b(reading|read chapter|chapter \d|pp?\.\s*\d)\b/i],
  ['quiz', /\bquiz(?:zes)?\b/i],
  ['final', /\bfinal\s+(exam|examination|test|assessment)\b|\bfinals\b/i],
  ['midterm', /\bmid[-\s]?term\b/i],
  ['exam', /\b(exam|examination|midsemester|\btest\b)\b/i],
  ['assignment', /\b(assignment|homework|hw\b|problem set|pset|worksheet|exercise|report)\b/i],
];

const DUE_HINT = /\b(due|deadline|submit|turn in|hand in|by \d|before class)\b/i;
const DATEISH =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}[\/\-.]\d{1,2}(?:[\/\-.]\d{2,4})?\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

function classify(line) {
  for (const [type, re] of TYPE_PATTERNS) {
    if (re.test(line)) return type;
  }
  return null;
}

function extractWeight(line) {
  const m = line.match(/(\d{1,2}(?:\.\d)?)\s*%/);
  if (m) return Number(m[1]);
  return null;
}

// Build a short human title from a line by trimming leading dates / bullets and
// trailing "due ..." / weight noise.
function makeTitle(line) {
  let s = line
    .replace(/^[\s•\-*·▪◦o]+/, '')
    .replace(/^\s*(week\s*\d+\s*[:.\-]?\s*)/i, '')
    .replace(/^\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*/i, '')
    .replace(DATEISH, '')
    // leading bare MMDD / MDD token that was really a date ("1020 Quiz 6")
    .replace(/^\s*\(?\s*(1[0-2]|0?[1-9])[0-3]\d\s*\)?[\s.\-–—:~]*/, '')
    .replace(/\b(due|deadline|submit(ted)?|turn in|hand in|by class)\b[:\s]*/gi, ' ')
    .replace(/\(?\s*\d{1,2}(?:\.\d)?\s*%\s*\)?/g, ' ')
    .replace(/\s+[~–—-]\s+/g, ' — ') // normalise mid-title separators
    .replace(/\(\s*\)/g, ' ') // empty parens left by removals
    .replace(/\s+([)\]])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:;,.\-–—()[\]]+|[\s:;,.\-–—([]+$/g, '')
    .replace(/\s+\)$/g, '')
    .trim();
  if (s.length > 90) s = s.slice(0, 87).trim() + '…';
  return s;
}

function titleCase(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Split into logical lines, then merge obvious wraps (a line with a date but no
// letters after it grabs the next line).
function toLines(text) {
  const raw = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);
  return raw;
}

export function parseSyllabus(text, { termStartKey, defaultCourseName } = {}) {
  const lines = toLines(text);
  const items = [];
  const seen = new Set();

  const tsk = termStartKey || `${new Date().getFullYear()}-01-01`;
  lines.forEach((line, idx) => {
    // Prefer a date on THIS line (incl. a leading OCR'd "MMDD" token).
    let date = parseDate(line, tsk, { leadingMMDD: true });
    // Otherwise borrow from the next line, but only if that line isn't its own
    // dated item (avoids one row stealing the next row's date).
    if (!date) {
      const next = lines[idx + 1] || '';
      const nextIsOwnItem = classify(next) && parseDate(next, tsk, { leadingMMDD: true });
      if (!nextIsOwnItem) date = parseDate(`${line} ${next}`, tsk);
    }
    if (!date) return;

    let type = classify(line) || classify(lines[idx - 1] || '');
    if (!type) {
      if (DUE_HINT.test(line)) type = 'assignment';
      else return; // a bare date with no assignment signal — skip
    }

    let title = makeTitle(line);
    // degenerate title (empty, all digits/punct, or a stray fragment) -> fall
    // back to the neighbouring line, then to a generic "<Type> — <date>".
    if (!title || title.length < 3 || !/[a-z]{2}/i.test(title)) {
      const alt = makeTitle(lines[idx - 1] || '') || makeTitle(lines[idx + 1] || '');
      title = alt && /[a-z]{2}/i.test(alt) ? alt : titleCase(type);
    }
    const key = `${type}|${title.toLowerCase()}|${date}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      id: cryptoId(),
      category: 'graded',
      type,
      title,
      date,
      weightPct: extractWeight(line),
      effortHours: DEFAULT_EFFORT[type] ?? 2,
      course: defaultCourseName || '',
      source: line.slice(0, 200),
      confirmed: false,
    });
  });

  items.sort((a, b) => a.date.localeCompare(b.date));
  return items;
}

export function cryptoId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2, 10);
}

// Best-effort guess of the term start from the text, used to seed settings.
// Returns a "YYYY-MM-DD" key string, or null.
export function guessTermStart(text) {
  const lines = toLines(text).slice(0, 60);
  let earliest = null;
  const yearNow = new Date().getFullYear();
  for (const l of lines) {
    const key = parseDate(l, `${yearNow}-01-01`);
    if (key && (!earliest || key < earliest)) earliest = key;
  }
  return earliest;
}
