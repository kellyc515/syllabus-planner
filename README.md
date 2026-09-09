# Syllabus Planner

Drop in a class syllabus (PDF or a photo/screenshot). The app reads the text,
pulls out every assignment, quiz, test, project and paper with a due date, lays
them on a calendar, and builds a **workload‑balanced study plan** so prep work
gets spread across your lighter days instead of piling up.

Everything runs in your browser. No account, no server — your syllabi and plan
never leave your machine (stored in `localStorage`, exportable as JSON).

## Run it

```bash
cd syllabus-planner
npm install
npm run dev        # opens http://localhost:5173
```

Build a static version you can host anywhere (or just open locally):

```bash
npm run build      # outputs dist/
npm run preview
```

## How it works

| Step | What happens |
|------|--------------|
| **1. Add syllabus** | Drop in a PDF or photo, or paste text. |
| **2. Extract** | Three routes, best first: **(a) Automatic** — set an Anthropic API key in Settings and the file goes straight to Claude, which returns structured assignments. **(b) Claude bridge** — no key; the app builds a strict prompt you paste into claude.ai / Claude Code (attach the file for scans), then paste the JSON back. **(c) Quick parser** (`src/parse.js`) — a no‑network heuristic; fine for clean pasted text, weak on scans. |
| **3. Review** | Two editable tables — **Graded** (assignments, quizzes, exams, papers → weight + effort) and **Class days** (lectures, discussions, workshops, readings → topic + note). Each row has a Kind dropdown to re‑tag a mis‑classified item. Re‑extracting a class offers to replace its existing items. |
| **4. Calendar** | Month grid of **graded** work only. Each day shows what's due plus a load bar; days over your cap turn red and get flagged. |
| **5. Study plan** | For each exam / project / paper / presentation, estimated prep hours are spread backward from the due date onto your lightest available days, respecting per‑day caps, your available weekdays, and blackout dates (`src/planner.js`). |
| **6. Class schedule** | Separate tab: every class‑day topic, grouped by week, per class or all together. Purely informational — never affects the calendar or workload. |
| **7. Export** | Download the whole plan as JSON, or an `.ics` file of graded deadlines + study blocks. |

### Graded vs. class‑day

The extraction prompt asks Claude to tag every dated row as `category: "graded"` (something you hand in / sit for) or `category: "class"` (what happens in class that day). Graded items carry `weightPct` + `effortHours` and drive the calendar and planner; class items carry a `type` (`lecture`/`discussion`/`workshop`/`review`/`reading`/`break`) and a free‑text `note`, and only appear on the Class schedule tab. Items from before this split, or from the quick parser, default to `graded`.

### Automatic extraction (`src/aiExtract.js`)

Add an Anthropic API key in **Settings** (get one at
[console.anthropic.com](https://console.anthropic.com/settings/keys)). Then a
dropped PDF/photo is sent directly to the Messages API — no local OCR, no
copy‑paste — and the structured result loads into review. Model is selectable
(Opus 5 default, Sonnet 5 cheaper); cost is roughly 2–6¢ per syllabus and is
shown in Settings. The key lives only in this browser's `localStorage`, is
stripped from exported plans, and the `@anthropic-ai/sdk` chunk is lazy‑loaded
so it costs nothing until first use. If the call fails, the app falls back to the
manual bridge with the error shown.

### The Claude bridge (`src/bridge.js`)

No API key. `buildClaudePrompt()` produces a prompt pinned to an exact JSON
schema; `parseClaudeItems()` tolerantly reads Claude's reply — it strips ```json
fences, unwraps `{"items": [...]}`, normalises type aliases ("final exam" →
`final`) and date formats. Shared by the automatic path and the manual bridge.

## Settings that drive the balancing

- **Packed‑day threshold** (weekday / weekend) — hours of work before a day is flagged and the planner stops adding to it.
- **Available study days** — e.g. skip Fridays.
- **Blackout dates** — breaks, trips; nothing gets scheduled there.
- **Term start** — used to infer the year on dates written like "Jan 20".

## Tests

```bash
npm test           # parser + planner sanity checks
```

## Notes / limits

- For scanned or image‑heavy syllabi, use the **Claude bridge** — on‑device OCR
  mangles them ("Finance Exam" → "Finas ee exam") and the quick parser can't
  recover from that.
- The quick parser is heuristic — best on the pasted "Schedule" / "Important
  Dates" section. It recovers OCR‑dropped slashes in leading date tokens
  ("1027 Quiz 7" → Oct 27) but will still miss unusual layouts. The review table
  is the safety net.
- In some embedded/sandboxed contexts the "Copy prompt" button can't reach the
  clipboard; it then selects the full prompt so you can ⌘/Ctrl‑C it manually.
- Standalone app in a subfolder of another project; own `package.json`, moves to
  its own repo as‑is.
