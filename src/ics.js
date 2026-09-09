// Export deadlines + study blocks as an .ics file for Google/Apple Calendar.

import { fromKey, pad } from './dates.js';

function dt(key) {
  const d = fromKey(key);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function esc(s) {
  return String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

function vevent({ uid, date, summary, description }) {
  const start = dt(date);
  const endD = fromKey(date);
  endD.setDate(endD.getDate() + 1);
  const end = `${endD.getFullYear()}${pad(endD.getMonth() + 1)}${pad(endD.getDate())}`;
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dt(new Date().toISOString().slice(0, 10))}T000000Z`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    'END:VEVENT',
  ]
    .filter(Boolean)
    .join('\r\n');
}

export function buildIcs(items, studyBlocks, courseName = (id) => id) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//syllabus-planner//EN',
    'CALSCALE:GREGORIAN',
  ];
  for (const it of items) {
    if (!it.date) continue;
    const c = courseName(it.courseId);
    lines.push(
      vevent({
        uid: `item-${it.id}@syllabus-planner`,
        date: it.date,
        summary: `${c ? c + ': ' : ''}${it.title} (${it.type}${it.weightPct ? `, ${it.weightPct}%` : ''})`,
        description: it.source || '',
      })
    );
  }
  for (const b of studyBlocks) {
    lines.push(
      vevent({
        uid: `study-${b.id}@syllabus-planner`,
        date: b.date,
        summary: `📚 ${b.label} — ${b.hours}h`,
        description: 'Suggested study block from Syllabus Planner',
      })
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
