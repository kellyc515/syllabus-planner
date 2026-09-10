// "Claude bridge": no API key. We hand the student a ready-made prompt to paste
// into claude.ai or Claude Code (they can also just attach the original PDF/photo
// there), and parse the JSON array Claude returns back into our item shape.

import { TYPES, DEFAULT_EFFORT, cryptoId } from './parse.js';
import { parseDate, toKey } from './dates.js';

export const CLASS_TYPES = ['lecture', 'discussion', 'workshop', 'review', 'reading', 'break', 'other'];

export function buildClaudePrompt(text, { termLabel } = {}) {
  const hasText = text && text.trim().length > 40;
  return `I'm loading a class syllabus into a study planner. Read the whole syllabus — the schedule table AND the grading/assignments section — and return EVERY dated row, split into two kinds.

Return ONLY a JSON array — no explanation, no markdown fences.

GRADED — something the student hands in or sits for that earns points toward the final grade:
{
  "category": "graded",
  "type": one of ${JSON.stringify(TYPES)},
  "title": short clean name (e.g. "Midterm Exam 1", "Case Analysis: Lululemon", "5C Stage 3: Competitors"),
  "date": due date "YYYY-MM-DD",
  "weightPct": this item's own percent of the final grade (number) or null,
  "effortHours": estimated total prep/work hours (number)
}

CLASS DAY — what happens in class that day, NOT separately graded: lecture topic, in-class case discussion, workshop, guest speaker, exam review, assigned reading, break:
{
  "category": "class",
  "type": one of ${JSON.stringify(CLASS_TYPES)},
  "title": the topic (e.g. "Porter's Five Forces", "Eli Lilly case discussion", "Phase 2 Workshop: Survey Design"),
  "date": "YYYY-MM-DD",
  "note": readings / chapters / extra detail for that day, or ""
}

Rules:
- A quiz or exam HELD in class is ONE graded row on its date — not also a class-day row.
- weightPct is for the single item: "10 quizzes = 10%" -> 1 each; "5C Analysis 16%, 8 stages" -> 2 each; "Exams 30%, two exams" -> 15 each.
- If a graded item's weight isn't stated, use null.
- If only a week is given, use the stated due date else that week's first meeting.
- Fix obvious OCR errors in titles.
- Term: ${termLabel || 'infer from the syllabus'}. Resolve every month/day to the correct year.
- Include Thanksgiving / holidays as {"category":"class","type":"break"}.
- Sort by date. Output the JSON array only.

${
  hasText
    ? `SYLLABUS TEXT (rough auto-extraction — trust the syllabus structure over exact spelling):\n"""\n${text.trim()}\n"""`
    : `>> Attach the original syllabus PDF or photo to this message. <<`
}`;
}

// Pull a JSON array out of whatever Claude sent back (fenced, prefixed prose,
// an object wrapper like {"items": [...]}, or a response that got cut off before
// the closing "]").
function extractJsonArray(raw) {
  if (!raw) throw new Error('empty response');
  let s = raw.trim();
  // strip ```json ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // object wrapper?
  const objMatch = s.match(/"(?:items|assignments|events|data)"\s*:\s*\[/);
  const start = objMatch ? s.indexOf('[', objMatch.index) : s.indexOf('[');
  if (start === -1) throw new Error('no JSON array found in the response');

  const body = s.slice(start);
  const end = body.lastIndexOf(']');
  const candidates = [];
  if (end > 0) candidates.push(body.slice(0, end + 1));
  // salvage: truncated mid-array — keep up to the last complete object
  const lastObj = body.lastIndexOf('}');
  if (lastObj > 0) candidates.push(body.slice(0, lastObj + 1) + ']');

  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('the response was cut off before a complete list — try again');
}

function normalizeType(t, category) {
  const v = String(t || '').toLowerCase().trim();
  if (category === 'class') {
    if (CLASS_TYPES.includes(v)) return v;
    const cmap = { lab: 'workshop', 'case discussion': 'discussion', holiday: 'break', 'no class': 'break', topic: 'lecture' };
    return cmap[v] || 'lecture';
  }
  if (TYPES.includes(v)) return v;
  const alias = {
    test: 'exam',
    homework: 'assignment',
    hw: 'assignment',
    essay: 'paper',
    report: 'paper',
    problemset: 'assignment',
    'problem set': 'assignment',
    discussionpost: 'discussion',
    finalexam: 'final',
    'final exam': 'final',
    midtermexam: 'midterm',
  };
  return alias[v] || 'other';
}

function normalizeDate(d, termStartKey) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = parseDate(s, termStartKey || `${new Date().getFullYear()}-01-01`);
  return parsed;
}

export function parseClaudeItems(raw, { courseId, courseName, termStartKey } = {}) {
  const arr = JSON.parse(extractJsonArray(raw));
  if (!Array.isArray(arr)) throw new Error('response was not a JSON array');
  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const category = row.category === 'class' ? 'class' : 'graded';
    const type = normalizeType(row.type, category);
    const date = normalizeDate(row.date ?? row.due ?? row.dueDate, termStartKey);
    const title = String(row.title ?? row.name ?? '').trim();
    if (!date || !title) continue;
    if (category === 'class') {
      out.push({
        id: cryptoId(),
        category: 'class',
        type,
        title: title.length > 140 ? title.slice(0, 137) + '…' : title,
        date,
        note: String(row.note ?? row.readings ?? '').trim().slice(0, 300),
        courseId,
        course: courseName || '',
        source: 'Claude',
      });
      continue;
    }
    let weightPct = row.weightPct ?? row.weight ?? null;
    if (typeof weightPct === 'string') weightPct = parseFloat(weightPct) || null;
    let effortHours = Number(row.effortHours ?? row.hours);
    if (!effortHours || Number.isNaN(effortHours)) effortHours = DEFAULT_EFFORT[type] ?? 2;
    out.push({
      id: cryptoId(),
      category: 'graded',
      type,
      title: title.length > 120 ? title.slice(0, 117) + '…' : title,
      date,
      weightPct: weightPct == null ? null : Math.round(weightPct * 10) / 10,
      effortHours: Math.round(effortHours * 2) / 2,
      courseId,
      course: courseName || '',
      source: 'Claude',
      confirmed: false,
    });
  }
  if (!out.length) throw new Error('no usable items — check that Claude returned the JSON array');
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export { toKey };

// Rough cost estimate for the Settings/extract blurbs (syllabus ≈ 4K in + 1.5K out).
export function estCostCents(model) {
  const rates = {
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [2, 10],
  };
  const [inR, outR] = rates[model] || rates['claude-opus-5'];
  const cents = ((4000 / 1e6) * inR + (1500 / 1e6) * outR) * 100;
  return Math.max(1, Math.round(cents));
}
