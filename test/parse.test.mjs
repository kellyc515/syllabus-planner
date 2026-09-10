// Quick sanity checks for the heuristic parser. Run: node test/parse.test.mjs
import { parseSyllabus } from '../src/parse.js';
import { computePlan } from '../src/planner.js';
import { parseClaudeItems } from '../src/bridge.js';

const SAMPLE = `
BIO 201 - Course Schedule (Fall 2026)
Week 1: Aug 25 - Course intro
Sep 1 - Reading: Chapter 1-2 due
Sep 8 - Quiz 1 (covers Ch 1-3), 5%
Sep 15 - Homework 1 due
Sep 22 - Lab report 1 due
Sept 29 - Midterm Exam 1 (Ch 1-6), 20%
Oct 6 - Discussion post due
Oct 13 - Homework 2 due, 5%
Oct 20 - Quiz 2, 5%
Oct 27 - Research paper draft due
Nov 3 - Midterm Exam 2, 20%
Nov 17 - Group presentation, 10%
Nov 24 - Research paper final due, 15%
Dec 8 - Final Exam (cumulative), 25%
10/31/2026 Project milestone due
`;

const items = parseSyllabus(SAMPLE, { termStartKey: '2026-08-20' });
let fail = 0;
const want = {
  'Reading: Chapter 1-2': 'reading',
  'Quiz 1 (covers Ch 1-3)': 'quiz',
  'Homework 1': 'assignment',
  'Lab report 1': 'lab',
  'Midterm Exam 1 (Ch 1-6)': 'midterm',
  'Discussion post': 'discussion',
  'Quiz 2': 'quiz',
  'Research paper draft': 'paper',
  'Midterm Exam 2': 'midterm',
  'Group presentation': 'presentation',
  'Research paper final': 'paper',
  'Final Exam (cumulative)': 'final',
  'Project milestone': 'project',
};

for (const [title, type] of Object.entries(want)) {
  const found = items.find((i) => i.title === title || i.title.startsWith(title));
  if (!found) {
    console.log(`MISS   "${title}" — not extracted`);
    fail++;
  } else if (found.type !== type) {
    console.log(`WRONG  "${title}" got ${found.type}, want ${type} (${found.date})`);
    fail++;
  } else {
    console.log(`ok     ${found.date}  ${found.type.padEnd(12)} ${title}`);
  }
}

// OCR-style rows: leading "MMDD" token is the date, junk stripped from title
const messy = parseSyllabus(
  `MKTG 3000 Fall 2026
1020 Quiz 6 ~ The Marketing Plan ()
1027 Quiz 7 — Branding
1218 Group presentation`,
  { termStartKey: '2026-08-20' }
);
const m1 = messy.find((i) => i.title.startsWith('Quiz 6'));
console.log(m1 && m1.date === '2026-10-20' ? `ok     MMDD row -> ${m1.date} "${m1.title}"` : `WRONG  MMDD row: ${JSON.stringify(m1)}`);
if (!m1 || m1.date !== '2026-10-20' || /[()~]/.test(m1.title)) fail++;
const m3 = messy.find((i) => i.type === 'presentation');
console.log(m3 && m3.date === '2026-12-18' ? `ok     "1218 Group presentation" -> ${m3.date}` : `WRONG  ${JSON.stringify(m3)}`);
if (!m3 || m3.date !== '2026-12-18') fail++;

// Year inference: Jan should roll to 2027
const jan = parseSyllabus('Jan 20 - Homework due', { termStartKey: '2026-08-20' })[0];
console.log(jan?.date === '2027-01-20' ? 'ok     year rolled to 2027' : `WRONG  year: ${jan?.date}`);
if (jan?.date !== '2027-01-20') fail++;

// Planner: nothing should exceed the daily cap by much, and study blocks exist
const { dayLoad } = computePlan(items, { termStartKey: '2026-08-20', dailyCapHours: 4 }, []);
const over = Object.entries(dayLoad).filter(([, d]) => d.total > 4.01);
console.log(over.length ? `note   ${over.length} day(s) still over cap (expected if week is full)` : 'ok     no day over cap');

// Completed items drop out of the workload
const hw = items.find((i) => i.title === 'Homework 1');
const before = computePlan(items, { termStartKey: '2026-08-20' }, []).dayLoad[hw.date].total;
const after = computePlan(
  items.map((i) => (i.id === hw.id ? { ...i, done: true } : i)),
  { termStartKey: '2026-08-20' },
  []
).dayLoad[hw.date].total;
console.log(after < before ? `ok     completing an item drops its load (${before}h -> ${after}h)` : `WRONG  done load: ${before} -> ${after}`);
if (!(after < before)) fail++;

// --- Claude bridge: tolerant JSON parsing ---------------------------------
const claudeReplies = [
  '[{"type":"quiz","title":"Quiz 1","date":"2026-09-08","weightPct":5,"effortHours":2}]',
  'Here you go:\n```json\n[{"type":"final exam","title":"Final","date":"2026-12-08"}]\n```\nHope that helps!',
  '{"items":[{"type":"paper","title":"Case Analysis: Lululemon","date":"10/08/2026","weight":"15%"}]}',
];
for (const reply of claudeReplies) {
  try {
    const out = parseClaudeItems(reply, { courseId: 'c1', courseName: 'X', termStartKey: '2026-08-20' });
    const ok = out.length >= 1 && out[0].date && /^\d{4}-\d{2}-\d{2}$/.test(out[0].date);
    console.log(ok ? `ok     bridge parsed ${out.length} (${out[0].type} ${out[0].date})` : `WRONG  bridge: ${JSON.stringify(out)}`);
    if (!ok) fail++;
  } catch (e) {
    console.log(`WRONG  bridge threw: ${e.message}`);
    fail++;
  }
}
const finalType = parseClaudeItems(claudeReplies[1], { termStartKey: '2026-08-20' })[0].type;
if (finalType !== 'final') { console.log(`WRONG  "final exam" alias -> ${finalType}`); fail++; }
else console.log('ok     "final exam" normalized to final');

// --- graded vs class-day split -----------------------------------------
const split = parseClaudeItems(
  JSON.stringify([
    { category: 'graded', type: 'quiz', title: 'Quiz 1', date: '2026-09-08', weightPct: 1, effortHours: 1.5 },
    { category: 'class', type: 'discussion', title: 'Eli Lilly case discussion', date: '2026-09-17', note: 'Read the case' },
    { category: 'class', type: 'break', title: 'Thanksgiving', date: '2026-11-26' },
    { category: 'graded', type: 'exam', title: 'Exam 1', date: '2026-10-15', weightPct: 15 },
  ]),
  { termStartKey: '2026-08-20' }
);
const g = split.filter((x) => x.category === 'graded');
const c = split.filter((x) => x.category === 'class');
console.log(g.length === 2 && c.length === 2 ? `ok     split -> ${g.length} graded / ${c.length} class` : `WRONG  split: ${JSON.stringify(split.map(x=>x.category))}`);
if (g.length !== 2 || c.length !== 2) fail++;
const brk = c.find((x) => x.title === 'Thanksgiving');
if (!brk || brk.type !== 'break' || 'effortHours' in brk) { console.log(`WRONG  class item shape: ${JSON.stringify(brk)}`); fail++; }
else console.log('ok     class item has note/type, no effortHours');

// --- truncated / cut-off response is salvaged --------------------------
const truncated =
  '[\n {"category":"graded","type":"quiz","title":"Quiz 1","date":"2026-09-08","weightPct":1,"effortHours":1.5},\n {"category":"graded","type":"exam","title":"Exam 1","date":"2026-10-15","weightPct":15,"effortHours":6},\n {"category":"graded","type":"pa';
try {
  const salv = parseClaudeItems(truncated, { termStartKey: '2026-08-20' });
  console.log(salv.length === 2 ? `ok     salvaged ${salv.length} items from a cut-off response` : `WRONG  salvage: ${salv.length}`);
  if (salv.length !== 2) fail++;
} catch (e) {
  console.log(`WRONG  salvage threw: ${e.message}`);
  fail++;
}

console.log(fail ? `\n${fail} failure(s)` : '\nALL GOOD');
process.exit(fail ? 1 : 0);
