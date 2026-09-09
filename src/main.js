import './style.css';
import {
  getState, subscribe, update, addCourse, removeCourse, courseById, courseColor,
  mergeItems, replaceCourseItems, itemCountForCourse, exportJson, importJson, resetAll,
} from './store.js';
import { extractText } from './extract.js';
import { parseSyllabus, guessTermStart, TYPES, DEFAULT_EFFORT, cryptoId } from './parse.js';
import { computePlan, summarize } from './planner.js';
import { CLASS_TYPES } from './bridge.js';
import {
  todayKey, toKey, fromKey, prettyDate, prettyRange, monthGrid, monthLabel, shiftMonth,
  addDays, daysBetween,
} from './dates.js';
import { buildIcs } from './ics.js';
import { buildClaudePrompt, parseClaudeItems, estCostCents } from './bridge.js';
// aiExtract pulls in the Anthropic SDK — load it only when actually used.

const app = document.getElementById('app');
let plan = { dayLoad: {}, studyBlocks: [], settings: {} };
let staged = null; // { courseId, items:[], text } during review of a fresh upload
let pending = null; // { courseId, text, isImage } waiting in the Claude bridge

// "class" items (lecture topics, discussions, workshops…) never touch the
// calendar workload or the study plan — only the graded ones do.
const isClass = (it) => it.category === 'class';
const gradedItems = (items = getState().items) => items.filter((it) => !isClass(it));
const classItems = (items = getState().items) => items.filter(isClass);

function recompute() {
  const s = getState();
  const locked = s.studyBlocks.filter((b) => b.locked);
  plan = computePlan(gradedItems(s.items), s.settings, locked);
}

subscribe(() => {
  recompute();
  render();
});

// ---------------------------------------------------------------- views

function render() {
  const s = getState();
  const view = s.ui.view;
  app.innerHTML = `
    ${header(view)}
    <main class="wrap">
      ${
        view === 'upload' ? uploadView()
        : view === 'bridge' ? bridgeView()
        : view === 'review' ? reviewView()
        : view === 'calendar' ? calendarView()
        : view === 'plan' ? planView()
        : view === 'schedule' ? scheduleView()
        : view === 'settings' ? settingsView()
        : uploadView()
      }
    </main>
    <footer class="foot">
      Your plan is stored only in this browser.${
        getState().settings.anthropicKey
          ? ' Syllabi you extract are sent to the Anthropic API (your key).'
          : ''
      } ·
      <button class="link" data-act="export-json">Export plan</button> ·
      <button class="link" data-act="import-json">Import</button> ·
      <button class="link" data-act="export-ics">Add to calendar (.ics)</button> ·
      <button class="link danger" data-act="reset">Reset all</button>
    </footer>
  `;
  wire();
}

function header(view) {
  const s = getState();
  const nGraded = gradedItems(s.items).length;
  const nClass = classItems(s.items).length;
  const tabs = [
    ['upload', 'Add syllabus', true],
    ['review', `Assignments${nGraded ? ` (${nGraded})` : ''}`, !!s.items.length],
    ['calendar', 'Calendar', !!nGraded],
    ['plan', 'Study plan', !!nGraded],
    ['schedule', `Class schedule${nClass ? ` (${nClass})` : ''}`, !!nClass],
    ['settings', 'Settings', true],
  ];
  return `
    <header class="topbar">
      <div class="brand">📅 Syllabus Planner</div>
      <nav>
        ${tabs
          .map(
            ([id, label, enabled]) =>
              `<button class="tab ${view === id ? 'on' : ''}" data-view="${id}" ${
                enabled ? '' : 'disabled'
              }>${label}</button>`
          )
          .join('')}
      </nav>
    </header>
  `;
}

// ---- upload -------------------------------------------------------

function uploadView() {
  const s = getState();
  return `
    <section class="card">
      <h1>Add a class syllabus</h1>
      <p class="muted">Upload the PDF or a photo/screenshot of the schedule.
      ${
        s.settings.anthropicKey
          ? 'Claude reads it automatically and fills in assignments, weights and due dates.'
          : 'Add an API key in Settings for automatic reading, or use the copy-paste bridge / quick parser.'
      }
      You review everything before it hits the calendar.</p>

      <label class="field">
        <span>Which class is this?</span>
        <div class="row">
          <select id="course-select">
            ${s.courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
            <option value="__new">+ New class…</option>
          </select>
          <input id="course-name" type="text" placeholder="e.g. BIO 201" class="${
            s.courses.length ? 'hidden' : ''
          }" />
        </div>
      </label>

      <div id="drop" class="dropzone">
        <input id="file" type="file" accept="application/pdf,image/*" multiple hidden />
        <div class="dz-inner">
          <strong>Drop a PDF or image here</strong>
          <span>or <button class="link" id="browse">browse files</button></span>
          <small>We pull out the raw text (OCR for scans/photos), then you pick how to extract assignments.</small>
        </div>
      </div>
      <div id="progress" class="progress hidden"><div class="bar"></div><span class="ptext"></span></div>

      ${
        s.courses.length
          ? `<div class="chips">${s.courses
              .map(
                (c) =>
                  `<span class="chip" style="--c:${c.color}">${escapeHtml(c.name)}
                    <button class="x" data-remove-course="${c.id}" title="Remove class">×</button></span>`
              )
              .join('')}</div>`
          : ''
      }

      ${
        s.items.length
          ? `<p class="muted">You have <strong>${s.items.length}</strong> items across
             ${s.courses.length} class(es). <button class="link" data-view="calendar">Open calendar →</button></p>`
          : ''
      }

      <details class="paste" ${s.courses.length ? '' : 'open'}>
        <summary>Or paste syllabus text instead</summary>
        <textarea id="paste-text" rows="8" placeholder="Paste the schedule / important dates section…"></textarea>
        <button class="btn" id="paste-go">Continue →</button>
      </details>
    </section>
  `;
}

// ---- Claude bridge --------------------------------------------

function bridgeView() {
  if (!pending) {
    return `<section class="card"><h1>Nothing to extract</h1>
      <p class="muted">Add a syllabus first.</p>
      <button class="btn" data-view="upload">Add syllabus</button></section>`;
  }
  const cName = courseById(pending.courseId)?.name || 'this class';
  const s = getState();
  const hasKey = !!s.settings.anthropicKey;
  const prompt = buildClaudePrompt(pending.text, { termLabel: termLabel() });

  if (pending.status === 'extracting') {
    return `
      <section class="card center">
        <div class="spinner"></div>
        <h1>Reading your syllabus…</h1>
        <p class="muted">Claude is pulling out assignments, weights and due dates for
        ${escapeHtml(cName)}. This usually takes 10–30 seconds.</p>
      </section>`;
  }

  const autoBlock = hasKey
    ? `
      <div class="autobox">
        <strong>✨ Automatic extraction</strong>
        <p class="muted small">Claude reads the ${
          pending.file ? 'file' : 'syllabus text'
        } directly and fills in everything. Model: ${escapeHtml(
        (s.settings.aiModel || 'claude-opus-5').replace('claude-', '')
      )} · ~${estCostCents(s.settings.aiModel)}¢.</p>
        ${pending.error ? `<div class="banner warn small">⚠️ ${escapeHtml(pending.error)}</div>` : ''}
        <button class="btn" data-act="run-ai">${
          pending.error ? 'Try again' : 'Extract with Claude'
        }</button>
      </div>`
    : `
      <div class="autobox">
        <strong>✨ Make this automatic</strong>
        <p class="muted small">Add an Anthropic API key in
          <button class="link" data-view="settings">Settings</button> (about 3 minutes, ~2–6¢
          per syllabus). Then uploading a syllabus reads the assignments, dates and weights
          for you — you land straight on the review table, no steps.</p>
      </div>`;

  const attachHint =
    pending.isImage || (pending.file && !pending.text)
      ? `Attach the file <strong>${escapeHtml(pending.file?.name || 'your PDF/photo')}</strong> to the message too.`
      : `Your syllabus text is already included in the prompt.`;

  return `
    <section class="card">
      <h1>Extract assignments for ${escapeHtml(cName)}</h1>
      ${autoBlock}

      ${
        hasKey && !pending.error
          ? ''
          : `<h2>${hasKey ? 'Or do it by hand' : 'No key? Do it once by hand'}</h2>
             <div class="steps">
               <div class="step"><span class="n">1</span><div>
                 <strong>Copy the prompt</strong>
                 <button class="btn" data-act="copy-prompt">📋 Copy prompt for Claude</button>
                 <span class="copied hidden" id="copied">Copied!</span>
                 <p class="muted small">${attachHint}</p>
               </div></div>
               <div class="step"><span class="n">2</span><div>
                 <strong>Paste it into <a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a></strong>
                 <p class="muted small">Send it, wait for the answer.</p>
               </div></div>
               <div class="step"><span class="n">3</span><div>
                 <strong>Paste Claude's answer here</strong>
                 <textarea id="claude-json" rows="5" placeholder="Paste what Claude replied"></textarea>
                 <button class="btn" data-act="load-claude">Load into review</button>
                 <span class="err hidden" id="claude-err"></span>
               </div></div>
             </div>
             <details class="manual">
               <summary>Advanced — see / edit the raw text &amp; prompt</summary>
               <label class="field"><span>Raw syllabus text (edit if it looks garbled, then re-copy)</span>
                 <textarea id="raw-text" rows="6">${escapeHtml(pending.text)}</textarea>
               </label>
               <button class="btn ghost" data-act="refresh-prompt">Update prompt from this text</button>
               <label class="field"><span>Full prompt</span>
                 <textarea id="prompt-preview" rows="8" readonly>${escapeHtml(prompt)}</textarea>
               </label>
             </details>`
      }

      <div class="row gap">
        <button class="btn ghost" data-act="quick-parse">Skip — try the offline parser</button>
        <button class="btn ghost" data-view="upload">Cancel</button>
      </div>
    </section>
  `;
}

// ---- review ------------------------------------------------------

function reviewView() {
  const s = getState();
  const list = staged ? staged.items : s.items;
  const isStaged = !!staged;
  const courseName = (id) => courseById(id)?.name || '—';

  if (!list.length && !isStaged) {
    return `<section class="card"><h1>No assignments yet</h1>
      <p class="muted">Add a syllabus first.</p>
      <button class="btn" data-view="upload">Add syllabus</button></section>`;
  }
  if (!list.length && isStaged) {
    return `<section class="card">
      <h1>Add items by hand</h1>
      <p class="muted">Nothing was auto-extracted. Add each assignment/test below, or go
      back and try the Claude route.</p>
      <div class="row gap">
        <button class="btn" data-act="add-row">+ Add row</button>
        <button class="btn ghost" data-view="bridge">← Back to Claude extract</button>
        <button class="btn ghost" data-act="discard-staged">Cancel</button>
      </div>
    </section>`;
  }

  const courseSelect = (it) =>
    isStaged
      ? escapeHtml(courseName(staged.courseId))
      : `<select data-f="courseId">${s.courses
          .map(
            (c) =>
              `<option value="${c.id}" ${c.id === it.courseId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
          )
          .join('')}</select>`;

  const kindSelect = (it) =>
    `<select data-f="category" class="kind">
       <option value="graded" ${!isClass(it) ? 'selected' : ''}>graded</option>
       <option value="class" ${isClass(it) ? 'selected' : ''}>class day</option>
     </select>`;

  const gradedRow = (it) => `
    <tr data-id="${it.id}">
      <td>${kindSelect(it)}</td>
      <td><select data-f="type">${TYPES.map(
        (t) => `<option ${t === it.type ? 'selected' : ''}>${t}</option>`
      ).join('')}</select></td>
      <td><input data-f="title" value="${escapeAttr(it.title)}" /></td>
      <td>${courseSelect(it)}</td>
      <td><input data-f="date" type="date" value="${it.date || ''}" /></td>
      <td><input data-f="weightPct" type="number" min="0" max="100" step="0.5" value="${
        it.weightPct ?? ''
      }" class="narrow" /></td>
      <td><input data-f="effortHours" type="number" min="0" step="0.5" value="${
        it.effortHours ?? ''
      }" class="narrow" /></td>
      <td><button class="x" data-del="${it.id}" title="Delete">🗑</button></td>
    </tr>`;

  const classRow = (it) => `
    <tr data-id="${it.id}">
      <td>${kindSelect(it)}</td>
      <td><select data-f="type">${CLASS_TYPES.map(
        (t) => `<option ${t === it.type ? 'selected' : ''}>${t}</option>`
      ).join('')}</select></td>
      <td><input data-f="title" value="${escapeAttr(it.title)}" /></td>
      <td>${courseSelect(it)}</td>
      <td><input data-f="date" type="date" value="${it.date || ''}" /></td>
      <td colspan="2"><input data-f="note" value="${escapeAttr(it.note || '')}" placeholder="readings / detail" /></td>
      <td><button class="x" data-del="${it.id}" title="Delete">🗑</button></td>
    </tr>`;

  const graded = list.filter((it) => !isClass(it));
  const cls = list.filter(isClass);

  return `
    <section class="card">
      <h1>${isStaged ? 'Check what we found' : 'All items'}</h1>
      <p class="muted">
        ${
          isStaged
            ? `Found <strong>${graded.length}</strong> graded item(s) and <strong>${cls.length}</strong>
               class-day item(s). Fix anything, switch a row's kind if it's mis-tagged, then add them.`
            : 'Edit anything here. Graded items drive the calendar and study plan; class-day items show on the Class schedule tab.'
        }
      </p>

      <h2>Graded — assignments, quizzes, exams, papers</h2>
      <div class="table-scroll"><table class="grid">
        <thead><tr><th>Kind</th><th>Type</th><th>Title</th><th>Class</th><th>Date</th><th>Weight %</th><th>Effort h</th><th></th></tr></thead>
        <tbody>${graded.map(gradedRow).join('') || `<tr><td colspan="8" class="muted">None.</td></tr>`}</tbody>
      </table></div>
      <button class="btn ghost" data-act="add-row">+ Add graded row</button>

      <h2>Class days — lectures, discussions, workshops, readings</h2>
      <div class="table-scroll"><table class="grid">
        <thead><tr><th>Kind</th><th>Type</th><th>Topic</th><th>Class</th><th>Date</th><th colspan="2">Note</th><th></th></tr></thead>
        <tbody>${cls.map(classRow).join('') || `<tr><td colspan="8" class="muted">None.</td></tr>`}</tbody>
      </table></div>
      <button class="btn ghost" data-act="add-class-row">+ Add class-day row</button>

      <div class="row gap" style="margin-top:1.25rem;">
        ${
          isStaged
            ? `${
                itemCountForCourse(staged.courseId)
                  ? `<label class="inline"><input type="checkbox" id="replace-course" checked /> Replace this class's existing ${itemCountForCourse(
                      staged.courseId
                    )} item(s)</label>`
                  : ''
              }
               <button class="btn" data-act="commit-staged">Add ${list.length} item(s)</button>
               <button class="btn ghost" data-act="discard-staged">Discard</button>`
            : `<button class="btn" data-view="calendar">Done → Calendar</button>`
        }
      </div>
    </section>
  `;
}

// ---- calendar --------------------------------------------------

function calendarView() {
  const s = getState();
  const month = s.ui.month || monthStartOfEarliest();
  const weeks = monthGrid(month);
  const sel = s.ui.selectedDate;
  const sum = summarize(gradedItems(s.items), plan.dayLoad);

  return `
    <section class="card">
      <div class="cal-head">
        <h1>${monthLabel(month)}</h1>
        <div class="row">
          <button class="btn ghost" data-month="-1">‹</button>
          <button class="btn ghost" data-month="today">Today</button>
          <button class="btn ghost" data-month="1">›</button>
        </div>
      </div>

      ${
        sum.packedDays.length
          ? `<div class="banner warn">⚠️ ${sum.packedDays.length} packed day(s) ahead:
             ${sum.packedDays.slice(0, 6).map((d) => prettyDate(d)).join(', ')}
             ${sum.packedDays.length > 6 ? '…' : ''}.
             The study plan already spreads prep to lighter days — tweak caps in Settings if it's still tight.</div>`
          : `<div class="banner ok">✅ No packed days ahead with current settings.</div>`
      }

      <div class="calendar">
        <div class="dow">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
          .map((d) => `<span>${d}</span>`)
          .join('')}</div>
        ${weeks
          .map(
            (week) => `<div class="week">${week
              .map((key) => dayCell(key, month, sel))
              .join('')}</div>`
          )
          .join('')}
      </div>

      ${sel ? dayPanel(sel) : `<p class="muted">Click a day for details.</p>`}
    </section>
  `;
}

function dayCell(key, month, sel) {
  const d = plan.dayLoad[key];
  const inMonth = fromKey(key).getMonth() === fromKey(month).getMonth();
  const isToday = key === todayKey();
  const cap = fromKey(key).getDay() === 0 || fromKey(key).getDay() === 6
    ? getState().settings.weekendCapHours
    : getState().settings.dailyCapHours;
  const total = d?.total || 0;
  const pct = Math.min(100, Math.round((total / Math.max(cap, 1)) * 100));
  const heavy = total > cap;
  const chips = (d?.items || [])
    .map(
      (it) =>
        `<span class="ev" style="--c:${courseColor(it.courseId)}" title="${escapeAttr(
          it.title
        )}">${iconFor(it.type)} ${escapeHtml(shorten(it.title, 16))}</span>`
    )
    .join('');
  const study = (d?.blocks || [])
    .map((b) => `<span class="ev study" title="${escapeAttr(b.label)}">📚 ${b.hours}h</span>`)
    .join('');

  return `
    <button class="day ${inMonth ? '' : 'dim'} ${isToday ? 'today' : ''} ${
    sel === key ? 'sel' : ''
  } ${heavy ? 'heavy' : ''}" data-day="${key}">
      <span class="dnum">${fromKey(key).getDate()}</span>
      ${total ? `<span class="load"><span class="load-bar" style="width:${pct}%"></span></span>` : ''}
      <span class="events">${chips}${study}</span>
      ${d?.flags?.length ? `<span class="flag" title="${escapeAttr(d.flags.join(' · '))}">!</span>` : ''}
    </button>
  `;
}

function dayPanel(key) {
  const d = plan.dayLoad[key] || { items: [], blocks: [], flags: [], total: 0 };
  return `
    <div class="panel">
      <div class="row between">
        <h2>${prettyDate(key, { withWeekday: true })}</h2>
        <span class="muted">${d.total || 0}h planned</span>
      </div>
      ${d.flags.map((f) => `<div class="banner warn small">⚠️ ${escapeHtml(f)}</div>`).join('')}
      ${
        d.items.length
          ? `<h3>Due</h3><ul class="plain">${d.items
              .map(
                (it) =>
                  `<li><span class="dot" style="--c:${courseColor(it.courseId)}"></span>
                   ${iconFor(it.type)} <strong>${escapeHtml(it.title)}</strong>
                   <span class="muted">${courseById(it.courseId)?.name || ''} · ${it.type}${
                    it.weightPct ? ` · ${it.weightPct}%` : ''
                  }</span></li>`
              )
              .join('')}</ul>`
          : ''
      }
      ${
        d.blocks.length
          ? `<h3>Suggested study blocks</h3><ul class="plain">${d.blocks
              .map(
                (b) => `<li>📚 ${escapeHtml(b.label)} —
                  <input class="narrow" type="number" min="0" step="0.5" value="${b.hours}"
                    data-block-hours="${b.id}" />h
                  <button class="link" data-block-lock="${b.id}">${
                  b.locked ? '🔒 locked' : 'lock'
                }</button></li>`
              )
              .join('')}</ul>`
          : ''
      }
      ${
        !d.items.length && !d.blocks.length
          ? `<p class="muted">Nothing scheduled. A free day 🎉</p>`
          : ''
      }
    </div>
  `;
}

// ---- study plan ----------------------------------------------

function planView() {
  const s = getState();
  const byItem = new Map();
  for (const b of plan.studyBlocks) {
    if (!byItem.has(b.itemId)) byItem.set(b.itemId, []);
    byItem.get(b.itemId).push(b);
  }
  const planned = s.items
    .filter((it) => byItem.has(it.id))
    .sort((a, b) => a.date.localeCompare(b.date));

  return `
    <section class="card">
      <h1>Study plan</h1>
      <p class="muted">
        Prep hours for each exam, project, paper and presentation, spread backward from the
        due date onto your lightest free days (respecting the daily caps in Settings).
        Edit hours on the Calendar day panel; lock a block to keep it when the plan regenerates.
      </p>
      <div class="row gap">
        <label class="inline"><input type="checkbox" data-act="toggle-planning" ${
          s.settings.planStudyBlocks ? 'checked' : ''
        }/> Generate study blocks</label>
        <button class="btn ghost" data-act="regen-plan">Regenerate (drop unlocked)</button>
      </div>

      ${
        !planned.length
          ? `<p class="muted">No exams/projects/papers with future due dates yet.</p>`
          : planned
              .map((it) => {
                const blocks = byItem.get(it.id).sort((a, b) => a.date.localeCompare(b.date));
                const total = blocks.reduce((n, b) => n + b.hours, 0);
                return `
              <div class="plan-item">
                <div class="row between">
                  <strong>${iconFor(it.type)} ${escapeHtml(it.title)}</strong>
                  <span class="muted">${courseById(it.courseId)?.name || ''} · due ${prettyDate(
                  it.date
                )} · ${Math.round(total * 10) / 10}h prep</span>
                </div>
                <div class="blocks">
                  ${blocks
                    .map(
                      (b) =>
                        `<span class="block ${b.locked ? 'locked' : ''}">${prettyDate(b.date)} ·
                         ${b.hours}h ${b.locked ? '🔒' : ''}</span>`
                    )
                    .join('')}
                </div>
              </div>`;
              })
              .join('')
      }
    </section>
  `;
}

// ---- class schedule -----------------------------------------

function scheduleView() {
  const s = getState();
  const all = classItems(s.items);
  if (!all.length) {
    return `<section class="card"><h1>Class schedule</h1>
      <p class="muted">Nothing here yet. Class-day topics (lectures, discussions, workshops,
      readings) show up once a syllabus is extracted.</p>
      <button class="btn" data-view="upload">Add syllabus</button></section>`;
  }
  const courses = [...new Set(all.map((it) => it.courseId))];
  const filter = s.ui.scheduleCourse && courses.includes(s.ui.scheduleCourse) ? s.ui.scheduleCourse : 'all';
  const now = todayKey();

  const rows = all
    .filter((it) => filter === 'all' || it.courseId === filter)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // group by ISO week (Mon-anchored) for a "week at a glance" feel
  const groups = [];
  for (const it of rows) {
    const wk = weekKey(it.date);
    let g = groups[groups.length - 1];
    if (!g || g.wk !== wk) {
      g = { wk, label: weekLabel(it.date), items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }

  return `
    <section class="card">
      <div class="cal-head">
        <h1>Class schedule</h1>
        ${
          courses.length > 1
            ? `<select data-act="schedule-course">
                 <option value="all" ${filter === 'all' ? 'selected' : ''}>All classes</option>
                 ${courses
                   .map(
                     (c) =>
                       `<option value="${c}" ${filter === c ? 'selected' : ''}>${escapeHtml(
                         courseById(c)?.name || '—'
                       )}</option>`
                   )
                   .join('')}
               </select>`
            : ''
        }
      </div>
      <p class="muted">What happens in class each day. These don't count toward your workload —
      graded work is on the <button class="link" data-view="calendar">Calendar</button>.</p>

      ${groups
        .map(
          (g) => `
        <div class="sched-week ${g.items.every((it) => it.date < now) ? 'past' : ''}">
          <h3>${escapeHtml(g.label)}</h3>
          <ul class="plain">
            ${g.items
              .map(
                (it) => `
              <li class="${it.date < now ? 'done' : ''}">
                <span class="sched-date">${prettyDate(it.date, { withWeekday: true }).replace(
                  /,.*/,
                  ''
                )} ${prettyDate(it.date)}</span>
                <span class="dot" style="--c:${courseColor(it.courseId)}"></span>
                <span class="sched-type">${classIcon(it.type)}</span>
                <strong>${escapeHtml(it.title)}</strong>
                ${courses.length > 1 && filter === 'all' ? `<span class="muted"> · ${escapeHtml(courseById(it.courseId)?.name || '')}</span>` : ''}
                ${it.note ? `<div class="sched-note">${escapeHtml(it.note)}</div>` : ''}
              </li>`
              )
              .join('')}
          </ul>
        </div>`
        )
        .join('')}
    </section>
  `;
}

function wireSchedule() {
  app.querySelector('[data-act="schedule-course"]')?.addEventListener('change', (e) =>
    update((s) => (s.ui.scheduleCourse = e.target.value))
  );
}

function weekKey(dateKey) {
  const d = fromKey(dateKey);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day);
  return toKey(d);
}
function weekLabel(dateKey) {
  const mon = fromKey(weekKey(dateKey));
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return prettyRange(toKey(mon), toKey(sun));
}
function classIcon(type) {
  return (
    {
      lecture: '📚', discussion: '💬', workshop: '🛠', review: '🔁',
      reading: '📖', break: '🌴', other: '•',
    }[type] || '📚'
  );
}

// ---- settings ------------------------------------------------

function settingsView() {
  const s = getState().settings;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `
    <section class="card">
      <h1>Settings</h1>

      <h2>Automatic extraction (Anthropic API key)</h2>
      <p class="muted small">With a key, dropping in a syllabus PDF or photo sends it straight
      to Claude and fills in assignments, weights and due dates — no copy-paste. The key is
      stored only in this browser and is never included in exported plans. Get one at
      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <label class="field">
        <span>Anthropic API key</span>
        <input type="password" autocomplete="off" placeholder="sk-ant-…"
          value="${escapeAttr(s.anthropicKey || '')}" data-set="anthropicKey" />
      </label>
      <label class="field">
        <span>Model — cost per syllabus is roughly ${estCostCents(s.aiModel)}¢</span>
        <select data-set="aiModel">
          <option value="claude-opus-5" ${
            (s.aiModel || 'claude-opus-5') === 'claude-opus-5' ? 'selected' : ''
          }>Opus 5 — most accurate</option>
          <option value="claude-sonnet-5" ${s.aiModel === 'claude-sonnet-5' ? 'selected' : ''}>Sonnet 5 — cheaper, fast</option>
        </select>
      </label>
      ${
        s.anthropicKey
          ? `<p class="muted small">✅ Key set. <button class="link" data-act="clear-key">Remove it</button></p>`
          : ''
      }

      <h2>Workload balancing</h2>
      <label class="field">
        <span>“Packed day” threshold — weekdays (hours of work before a day is flagged)</span>
        <input type="number" min="1" step="0.5" value="${s.dailyCapHours}" data-set="dailyCapHours" />
      </label>
      <label class="field">
        <span>Threshold — weekends</span>
        <input type="number" min="1" step="0.5" value="${s.weekendCapHours}" data-set="weekendCapHours" />
      </label>

      <div class="field">
        <span>Days you're available to study</span>
        <div class="row wrap">
          ${wd
            .map(
              (d, i) =>
                `<label class="inline"><input type="checkbox" data-weekday="${i}" ${
                  s.availableWeekdays.includes(i) ? 'checked' : ''
                }/> ${d}</label>`
            )
            .join('')}
        </div>
      </div>

      <label class="field">
        <span>Term start (used to guess the year on dates like “Jan 20”)</span>
        <input type="date" value="${s.termStartKey || ''}" data-set="termStartKey" />
      </label>

      <div class="field">
        <span>Blackout dates (no study scheduled — breaks, trips)</span>
        <div class="chips">
          ${s.blackoutDates
            .map((d) => `<span class="chip">${prettyDate(d)} <button class="x" data-unblackout="${d}">×</button></span>`)
            .join('')}
        </div>
        <div class="row"><input type="date" id="blackout-add" /><button class="btn ghost" data-act="add-blackout">Add</button></div>
      </div>

      <h2>Default effort per type (hours)</h2>
      <div class="row wrap">
        ${TYPES.filter((t) => t !== 'other')
          .map(
            (t) =>
              `<label class="inline sm">${t}
                 <input class="narrow" type="number" min="0" step="0.5"
                   value="${getState().settings.effort?.[t] ?? DEFAULT_EFFORT[t]}"
                   data-effort="${t}" /></label>`
          )
          .join('')}
      </div>
      <p class="muted">Changing a default only affects items you add later. Edit existing items on the Assignments tab.</p>
    </section>
  `;
}

// ---------------------------------------------------------------- events

function wire() {
  app.querySelectorAll('[data-view]').forEach((el) =>
    el.addEventListener('click', () => {
      if (el.disabled) return;
      update((s) => (s.ui.view = el.dataset.view));
    })
  );

  const v = getState().ui.view;
  if (v === 'upload') wireUpload();
  if (v === 'bridge') wireBridge();
  if (v === 'review') wireReview();
  if (v === 'calendar') wireCalendar();
  if (v === 'plan') wirePlan();
  if (v === 'schedule') wireSchedule();
  if (v === 'settings') wireSettings();

  // footer
  app.querySelector('[data-act="export-json"]')?.addEventListener('click', () =>
    download('syllabus-plan.json', exportJson(), 'application/json')
  );
  app.querySelector('[data-act="import-json"]')?.addEventListener('click', pickImport);
  app.querySelector('[data-act="export-ics"]')?.addEventListener('click', () => {
    const s = getState();
    const ics = buildIcs(gradedItems(s.items), plan.studyBlocks, (id) => courseById(id)?.name || '');
    download('syllabus-plan.ics', ics, 'text/calendar');
  });
  app.querySelector('[data-act="reset"]')?.addEventListener('click', () => {
    if (confirm('Delete all classes, assignments and study blocks?')) {
      staged = null;
      resetAll();
    }
  });
}

function wireUpload() {
  const sel = app.querySelector('#course-select');
  const nameInput = app.querySelector('#course-name');
  const s = getState();
  if (sel) {
    if (!s.courses.length) {
      sel.classList.add('hidden');
      nameInput?.classList.remove('hidden');
    }
    sel.addEventListener('change', () => {
      if (sel.value === '__new') nameInput.classList.remove('hidden');
      else nameInput.classList.add('hidden');
    });
  }

  app.querySelectorAll('[data-remove-course]').forEach((b) =>
    b.addEventListener('click', () => removeCourse(b.dataset.removeCourse))
  );

  const fileInput = app.querySelector('#file');
  app.querySelector('#browse')?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', () => handleFiles([...fileInput.files]));

  const drop = app.querySelector('#drop');
  ['dragover', 'dragenter'].forEach((e) =>
    drop?.addEventListener(e, (ev) => {
      ev.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((e) =>
    drop?.addEventListener(e, (ev) => {
      ev.preventDefault();
      drop.classList.remove('over');
    })
  );
  drop?.addEventListener('drop', (ev) => handleFiles([...ev.dataTransfer.files]));

  app.querySelector('#paste-go')?.addEventListener('click', () => {
    const text = app.querySelector('#paste-text').value;
    if (text.trim().length > 20) toBridge({ text, courseId: resolveCourseId() });
    else alert('Paste a bit more of the syllabus schedule first.');
  });
}

// Stash the syllabus and move to the extract step. If an API key is set, run
// the automatic extraction right away; otherwise show the manual bridge.
function toBridge({ text = '', courseId, isImage = false, files = null }) {
  const guessed = guessTermStart(text);
  if (!getState().settings.termStartKey && guessed) {
    update((st) => (st.settings.termStartKey = guessed));
  }
  const file = files && files.length === 1 ? files[0] : null;
  pending = { courseId, text: (text || '').trim(), isImage: !!isImage, file, status: 'idle', error: '' };
  update((st) => (st.ui.view = 'bridge'));
  if (getState().settings.anthropicKey) runAiExtract();
}

function termLabel() {
  const s = getState();
  const year = (s.settings.termStartKey || '').slice(0, 4) || `${new Date().getFullYear()}`;
  return `starts around ${s.settings.termStartKey || year}`;
}

async function runAiExtract() {
  if (!pending) return;
  const s = getState();
  pending.status = 'extracting';
  pending.error = '';
  render();
  try {
    const { aiExtract } = await import('./aiExtract.js');
    const { items } = await aiExtract(
      {
        apiKey: s.settings.anthropicKey,
        model: s.settings.aiModel || 'claude-opus-5',
        text: pending.text,
        file: pending.file,
      },
      {
        courseId: pending.courseId,
        courseName: courseById(pending.courseId)?.name || '',
        termLabel: termLabel(),
        termStartKey: s.settings.termStartKey || `${new Date().getFullYear()}-01-01`,
      }
    );
    staged = { courseId: pending.courseId, items };
    pending = null;
    update((st) => (st.ui.view = 'review'));
  } catch (err) {
    console.error(err);
    if (pending) {
      pending.status = 'idle';
      pending.error = err.message || String(err);
    }
    render();
    // Populate the manual fallback's text box if we only had a file so far.
    if (pending && pending.file && !pending.text) {
      try {
        const text = await extractText(pending.file, () => {});
        if (pending) {
          pending.text = (text || '').trim();
          if (getState().ui.view === 'bridge') render();
        }
      } catch {
        /* leave it empty; manual mode still lets them attach the file to Claude */
      }
    }
  }
}

function currentPrompt() {
  const s = getState();
  const year = (s.settings.termStartKey || '').slice(0, 4) || `${new Date().getFullYear()}`;
  const raw = app.querySelector('#raw-text');
  const text = raw ? raw.value : pending?.text || '';
  return buildClaudePrompt(text, {
    termLabel: `starts around ${s.settings.termStartKey || year}`,
  });
}

function wireBridge() {
  if (!pending) return;

  app.querySelector('[data-act="run-ai"]')?.addEventListener('click', () => runAiExtract());

  app.querySelector('[data-act="copy-prompt"]')?.addEventListener('click', async () => {
    const text = currentPrompt();
    const ok = await copyText(text);
    const tag = app.querySelector('#copied');
    if (ok) {
      tag.textContent = 'Copied!';
      tag?.classList.remove('hidden');
      setTimeout(() => tag?.classList.add('hidden'), 2000);
    } else {
      // last resort — reveal the prompt and select it for manual copy
      const pv = app.querySelector('#prompt-preview');
      if (pv) {
        pv.closest('details').open = true;
        pv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pv.focus();
        pv.select();
      }
      tag.textContent = 'Copy blocked — the full prompt is selected below, press ⌘/Ctrl-C';
      tag.classList.remove('hidden');
    }
  });

  app.querySelector('[data-act="refresh-prompt"]')?.addEventListener('click', () => {
    const pv = app.querySelector('#prompt-preview');
    if (pv) pv.value = currentPrompt();
    if (pending) pending.text = app.querySelector('#raw-text').value.trim();
  });

  app.querySelector('[data-act="load-claude"]')?.addEventListener('click', () => {
    const raw = app.querySelector('#claude-json').value;
    const err = app.querySelector('#claude-err');
    err.classList.add('hidden');
    try {
      const s = getState();
      const items = parseClaudeItems(raw, {
        courseId: pending.courseId,
        courseName: courseById(pending.courseId)?.name || '',
        termStartKey: s.settings.termStartKey || `${new Date().getFullYear()}-01-01`,
      });
      staged = { courseId: pending.courseId, items };
      pending = null;
      update((st) => (st.ui.view = 'review'));
    } catch (e) {
      err.textContent = `Couldn't read that: ${e.message}. Paste just the JSON array Claude produced.`;
      err.classList.remove('hidden');
    }
  });

  app.querySelector('[data-act="quick-parse"]')?.addEventListener('click', () => {
    const raw = app.querySelector('#raw-text');
    ingest(raw ? raw.value : pending.text, pending.courseId);
  });
}

function resolveCourseId() {
  const s = getState();
  const sel = app.querySelector('#course-select');
  const nameInput = app.querySelector('#course-name');
  if (!s.courses.length || !sel || sel.value === '__new') {
    const c = addCourse(nameInput?.value || '');
    return c.id;
  }
  return sel.value;
}

async function handleFiles(files) {
  if (!files.length) return;
  const courseId = resolveCourseId();
  const prog = app.querySelector('#progress');
  const bar = prog.querySelector('.bar');
  const ptext = prog.querySelector('.ptext');
  prog.classList.remove('hidden');

  // With an API key + a single file, skip local OCR entirely — send the file
  // straight to Claude, which reads it better anyway.
  if (getState().settings.anthropicKey && files.length === 1) {
    ptext.textContent = 'Sending to Claude…';
    toBridge({ text: '', courseId, isImage: files[0].type.startsWith('image/'), files });
    return;
  }

  let allText = '';
  try {
    let looksImage = false;
    for (const file of files) {
      ptext.textContent = `Reading ${file.name}…`;
      const name = (file.name || '').toLowerCase();
      if (file.type.startsWith('image/') || name.endsWith('.png') || name.endsWith('.jpg')) {
        looksImage = true;
      }
      const text = await extractText(file, (frac, label) => {
        bar.style.width = `${Math.round(frac * 100)}%`;
        ptext.textContent = `${file.name}: ${label}`;
      });
      allText += '\n\n' + text;
    }
    // If OCR produced very little / gibberish-dense text, treat it as an image.
    const dense = allText.replace(/\s/g, '');
    if (dense.length < 200) looksImage = true;
    toBridge({ text: allText, courseId, isImage: looksImage, files });
  } catch (err) {
    console.error(err);
    ptext.textContent = `Couldn't read that file: ${err.message}. Try "paste syllabus text instead" below.`;
  }
}

function ingest(text, courseId) {
  const cid = courseId || resolveCourseId();
  const s = getState();
  const guessed = guessTermStart(text);
  const termStartKey =
    s.settings.termStartKey || guessed || `${new Date().getFullYear()}-01-01`;
  const items = parseSyllabus(text, {
    termStartKey,
    defaultCourseName: courseById(cid)?.name || '',
  });
  if (!s.settings.termStartKey && guessed) {
    update((st) => (st.settings.termStartKey = guessed));
  }
  if (!items.length) {
    alert(
      "The quick parser couldn't find dated assignments in this text — this is exactly when the Claude route works better. Use steps 1–3 above, or add items by hand with “+ Add row” on the next screen."
    );
    staged = { courseId: cid, items: [] };
    update((st) => (st.ui.view = 'review'));
    return;
  }
  staged = { courseId: cid, items };
  update((st) => (st.ui.view = 'review'));
}

function wireReview() {
  const list = staged ? staged.items : getState().items;

  app.querySelectorAll('tr[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-f]').forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.dataset.f;
        let val = input.value;
        if (f === 'weightPct' || f === 'effortHours') val = val === '' ? null : Number(val);
        const apply = (it) => {
          if (!it) return;
          it[f] = val;
          if (f === 'category') {
            if (val === 'class') {
              if (!CLASS_TYPES.includes(it.type)) it.type = 'lecture';
              it.note = it.note || '';
            } else if (!TYPES.includes(it.type)) {
              it.type = 'assignment';
              it.effortHours = it.effortHours ?? DEFAULT_EFFORT.assignment;
            }
          }
        };
        if (staged) {
          apply(staged.items.find((x) => x.id === id));
          render();
        } else {
          update((s) => apply(s.items.find((x) => x.id === id)));
        }
      });
    });
    row.querySelector('[data-del]')?.addEventListener('click', () => {
      if (staged) {
        staged.items = staged.items.filter((x) => x.id !== id);
        render();
      } else {
        update((s) => (s.items = s.items.filter((x) => x.id !== id)));
      }
    });
  });

  const addRow = (kind) => {
    const cid = staged ? staged.courseId : getState().courses[0]?.id;
    const blank =
      kind === 'class'
        ? { id: cryptoId(), category: 'class', type: 'lecture', title: '', date: todayKey(), note: '', courseId: cid }
        : {
            id: cryptoId(),
            category: 'graded',
            type: 'assignment',
            title: '',
            date: todayKey(),
            weightPct: null,
            effortHours: DEFAULT_EFFORT.assignment,
            courseId: cid,
            confirmed: true,
          };
    if (staged) {
      staged.items.push(blank);
      render();
    } else {
      update((s) => s.items.push(blank));
    }
  };
  app.querySelector('[data-act="add-row"]')?.addEventListener('click', () => addRow('graded'));
  app.querySelector('[data-act="add-class-row"]')?.addEventListener('click', () => addRow('class'));

  app.querySelector('[data-act="commit-staged"]')?.addEventListener('click', () => {
    const clean = staged.items.filter((it) => it.title.trim() && it.date);
    const replace = app.querySelector('#replace-course')?.checked;
    if (replace) replaceCourseItems(clean, staged.courseId);
    else mergeItems(clean, staged.courseId);
    const goClass = !gradedItems(clean).length && classItems(clean).length;
    staged = null;
    update((s) => (s.ui.view = goClass ? 'schedule' : 'calendar'));
  });
  app.querySelector('[data-act="discard-staged"]')?.addEventListener('click', () => {
    staged = null;
    update((s) => (s.ui.view = 'upload'));
  });
}

function wireCalendar() {
  app.querySelectorAll('[data-month]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = getState();
      const cur = s.ui.month || monthStartOfEarliest();
      update((st) => {
        if (b.dataset.month === 'today') st.ui.month = toKey(new Date(fromKey(todayKey()).getFullYear(), fromKey(todayKey()).getMonth(), 1));
        else st.ui.month = shiftMonth(cur, Number(b.dataset.month));
      });
    })
  );
  app.querySelectorAll('[data-day]').forEach((b) =>
    b.addEventListener('click', () =>
      update((s) => (s.ui.selectedDate = s.ui.selectedDate === b.dataset.day ? null : b.dataset.day))
    )
  );
  app.querySelectorAll('[data-block-hours]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const id = inp.dataset.blockHours;
      const hours = Number(inp.value) || 0;
      lockBlock(id, hours);
    })
  );
  app.querySelectorAll('[data-block-lock]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const b = plan.studyBlocks.find((x) => x.id === btn.dataset.blockLock);
      if (b) lockBlock(b.id, b.hours, !b.locked);
    })
  );
}

function lockBlock(id, hours, locked = true) {
  const b = plan.studyBlocks.find((x) => x.id === id);
  if (!b) return;
  update((s) => {
    const idx = s.studyBlocks.findIndex((x) => x.id === id);
    const rec = { ...b, hours, locked };
    if (idx >= 0) s.studyBlocks[idx] = rec;
    else s.studyBlocks.push(rec);
  });
}

function wirePlan() {
  app.querySelector('[data-act="toggle-planning"]')?.addEventListener('change', (e) =>
    update((s) => (s.settings.planStudyBlocks = e.target.checked))
  );
  app.querySelector('[data-act="regen-plan"]')?.addEventListener('click', () =>
    update((s) => (s.studyBlocks = s.studyBlocks.filter((b) => b.locked)))
  );
}

function wireSettings() {
  app.querySelectorAll('[data-set]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const k = inp.dataset.set;
      let val = inp.value;
      if (k === 'dailyCapHours' || k === 'weekendCapHours') val = Number(val);
      if (k === 'termStartKey') val = val || null;
      if (k === 'anthropicKey') val = val.trim();
      update((s) => (s.settings[k] = val));
    })
  );
  app.querySelector('[data-act="clear-key"]')?.addEventListener('click', () =>
    update((s) => (s.settings.anthropicKey = ''))
  );
  app.querySelectorAll('[data-weekday]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const day = Number(cb.dataset.weekday);
      update((s) => {
        const set = new Set(s.settings.availableWeekdays);
        cb.checked ? set.add(day) : set.delete(day);
        s.settings.availableWeekdays = [...set];
      });
    })
  );
  app.querySelector('[data-act="add-blackout"]')?.addEventListener('click', () => {
    const val = app.querySelector('#blackout-add').value;
    if (!val) return;
    update((s) => {
      if (!s.settings.blackoutDates.includes(val)) s.settings.blackoutDates.push(val);
      s.settings.blackoutDates.sort();
    });
  });
  app.querySelectorAll('[data-unblackout]').forEach((b) =>
    b.addEventListener('click', () =>
      update((s) => (s.settings.blackoutDates = s.settings.blackoutDates.filter((d) => d !== b.dataset.unblackout)))
    )
  );
  app.querySelectorAll('[data-effort]').forEach((inp) =>
    inp.addEventListener('change', () =>
      update((s) => {
        s.settings.effort = s.settings.effort || {};
        s.settings.effort[inp.dataset.effort] = Number(inp.value);
      })
    )
  );
}

// ---------------------------------------------------------------- utils

function monthStartOfEarliest(items = gradedItems()) {
  const dates = items.map((it) => it.date).filter(Boolean).sort();
  const anchor = dates.find((d) => d >= todayKey()) || dates[0] || todayKey();
  const d = fromKey(anchor);
  return toKey(new Date(d.getFullYear(), d.getMonth(), 1));
}

function iconFor(type) {
  return (
    {
      final: '🎓', midterm: '📝', exam: '📝', quiz: '❓', assignment: '📄',
      project: '🛠', paper: '✍️', lab: '🧪', presentation: '🎤',
      reading: '📖', discussion: '💬', other: '•',
    }[type] || '•'
  );
}

function shorten(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
function download(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pickImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json';
  inp.onchange = async () => {
    try {
      const text = await inp.files[0].text();
      importJson(text);
      alert('Plan imported.');
    } catch (err) {
      alert('Could not import that file: ' + err.message);
    }
  };
  inp.click();
}

// ---------------------------------------------------------------- boot
recompute();
render();
