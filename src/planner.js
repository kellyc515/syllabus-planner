// Workload model.
//
// Two outputs, both keyed by "YYYY-MM-DD":
//   dayLoad[date]  = { dueHours, studyHours, total, items:[], blocks:[], flags:[] }
//   studyBlocks[]  = { id, itemId, date, hours, label, type }
//
// The study planner walks each exam/project/paper backward from its due date and
// drops prep hours onto the lightest available days first, respecting a daily
// cap and the student's weekly availability / blackout dates.

import { addDays, daysBetween, fromKey, isWeekend, todayKey } from './dates.js';
import { DEFAULT_LEAD_DAYS, cryptoId } from './parse.js';

const PLAN_TYPES = new Set(['final', 'midterm', 'exam', 'project', 'paper', 'presentation']);

export const DEFAULT_SETTINGS = {
  termStartKey: null,
  dailyCapHours: 4, // "a packed day" threshold
  availableWeekdays: [1, 2, 3, 4, 5, 6, 0], // all days by default; 0 = Sun
  weekendCapHours: 5,
  blackoutDates: [], // ["2026-11-26", ...]
  planStudyBlocks: true,
  minBlockHours: 0.5,
  anthropicKey: '', // optional — enables automatic extraction (stored only in this browser)
  aiModel: 'claude-opus-5',
};

function capForDay(key, settings) {
  return isWeekend(key) ? settings.weekendCapHours : settings.dailyCapHours;
}

function isAvailable(key, settings) {
  if (settings.blackoutDates.includes(key)) return false;
  return settings.availableWeekdays.includes(fromKey(key).getDay());
}

export function computePlan(items, settings, existingBlocks = []) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const dayLoad = {};

  const touch = (key) => {
    if (!dayLoad[key]) {
      dayLoad[key] = { dueHours: 0, studyHours: 0, total: 0, items: [], blocks: [], flags: [] };
    }
    return dayLoad[key];
  };

  // 1) Place the deadlines themselves (day-of effort).
  for (const it of items) {
    if (!it.date) continue;
    const d = touch(it.date);
    const dayOf = PLAN_TYPES.has(it.type) ? Math.min(it.effortHours, 2) : it.effortHours;
    d.dueHours += dayOf;
    d.items.push(it);
  }

  // 2) Study blocks: keep any user-edited/locked blocks, regenerate the rest.
  const lockedByItem = new Map();
  for (const b of existingBlocks) {
    if (b.locked) {
      if (!lockedByItem.has(b.itemId)) lockedByItem.set(b.itemId, []);
      lockedByItem.get(b.itemId).push(b);
    }
  }

  const studyBlocks = [];
  if (s.planStudyBlocks) {
    const planItems = items
      .filter((it) => PLAN_TYPES.has(it.type) && it.date && it.date >= todayKey())
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const it of planItems) {
      const locked = lockedByItem.get(it.id) || [];
      for (const b of locked) {
        studyBlocks.push(b);
        touch(b.date).studyHours += b.hours;
      }
      const lockedHours = locked.reduce((n, b) => n + b.hours, 0);
      let remaining = Math.max(0, (it.effortHours || 0) - lockedHours - Math.min(it.effortHours, 2));
      if (remaining < s.minBlockHours) continue;

      const lead = DEFAULT_LEAD_DAYS[it.type] ?? 7;
      const windowStart = maxKey(addDays(it.date, -lead), todayKey());
      const candidates = [];
      for (let k = windowStart; k < it.date; k = addDays(k, 1)) {
        if (!isAvailable(k, s)) continue;
        candidates.push(k);
      }
      if (!candidates.length) continue;

      // Greedy fill: repeatedly add a slice to whichever candidate day is
      // currently least loaded and still under cap. Bias toward days closer to
      // the deadline when loads are equal (review-when-fresh).
      const slice = Math.max(s.minBlockHours, round1(remaining / candidates.length));
      let guard = 500;
      while (remaining >= s.minBlockHours && guard-- > 0) {
        let best = null;
        let bestLoad = Infinity;
        for (const k of candidates) {
          const load = touch(k).dueHours + touch(k).studyHours;
          const cap = capForDay(k, s);
          if (load >= cap) continue;
          if (load < bestLoad - 0.01) {
            bestLoad = load;
            best = k;
          }
        }
        if (!best) break; // every candidate day is at cap
        const room = capForDay(best, s) - (touch(best).dueHours + touch(best).studyHours);
        const add = round1(Math.min(slice, remaining, room));
        if (add < s.minBlockHours) break;
        const existing = studyBlocks.find((b) => b.itemId === it.id && b.date === best && !b.locked);
        if (existing) existing.hours = round1(existing.hours + add);
        else
          studyBlocks.push({
            id: cryptoId(),
            itemId: it.id,
            date: best,
            hours: add,
            label: `Prep: ${it.title}`,
            type: it.type,
            locked: false,
          });
        touch(best).studyHours += add;
        remaining = round1(remaining - add);
      }
      if (remaining >= s.minBlockHours) {
        // Couldn't fit everything — note it on the due day.
        touch(it.date).flags.push(`+${remaining}h prep couldn't be scheduled (week is full)`);
      }
    }
  }

  for (const b of studyBlocks) touch(b.date).blocks.push(b);

  // 3) Totals + flags.
  for (const [key, d] of Object.entries(dayLoad)) {
    d.dueHours = round1(d.dueHours);
    d.studyHours = round1(d.studyHours);
    d.total = round1(d.dueHours + d.studyHours);
    const cap = capForDay(key, s);
    if (d.total > cap) d.flags.push(`Packed: ${d.total}h planned (cap ${cap}h)`);
    const bigDue = d.items.filter((it) => ['final', 'midterm', 'exam'].includes(it.type));
    if (bigDue.length >= 2) d.flags.push(`${bigDue.length} exams same day`);
  }

  // 4) Cross-day crunch: 2+ exams within 3 days.
  const examDays = items
    .filter((it) => ['final', 'midterm', 'exam'].includes(it.type) && it.date)
    .map((it) => it.date)
    .sort();
  for (let i = 1; i < examDays.length; i++) {
    if (daysBetween(examDays[i - 1], examDays[i]) <= 3 && examDays[i - 1] !== examDays[i]) {
      touch(examDays[i]).flags.push('Exam crunch: another exam within 3 days');
    }
  }

  return { dayLoad, studyBlocks, settings: s };
}

export function summarize(items, dayLoad) {
  const now = todayKey();
  const upcoming = items
    .filter((it) => it.date && it.date >= now)
    .sort((a, b) => a.date.localeCompare(b.date));
  const packedDays = Object.entries(dayLoad)
    .filter(([k, d]) => k >= now && d.flags.some((f) => f.startsWith('Packed')))
    .map(([k]) => k)
    .sort();
  return {
    totalItems: items.length,
    upcomingCount: upcoming.length,
    next: upcoming[0] || null,
    packedDays,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function maxKey(a, b) {
  return a > b ? a : b;
}
