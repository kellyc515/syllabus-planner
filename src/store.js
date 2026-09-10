// App state + persistence. One localStorage key holds everything so the whole
// plan survives refreshes and can be exported/imported as a single JSON file.

import { DEFAULT_SETTINGS } from './planner.js';
import { cryptoId } from './parse.js';

const KEY = 'syllabus-planner:v1';

const BLANK = {
  courses: [], // { id, name, color }
  items: [], // see parse.js
  studyBlocks: [], // generated + user-locked
  settings: { ...DEFAULT_SETTINGS },
  ui: { view: 'upload', month: null, selectedDate: null, scheduleCourse: 'all' },
};

const COURSE_COLORS = [
  '#2563eb', '#db2777', '#16a34a', '#d97706',
  '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f',
];

let state = load();
const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function update(mutator) {
  mutator(state);
  save();
  for (const fn of listeners) fn(state);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(BLANK);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(BLANK),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      ui: { ...BLANK.ui, ...(parsed.ui || {}) },
    };
  } catch (err) {
    console.warn('Could not load saved plan:', err);
    return structuredClone(BLANK);
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save plan:', err);
  }
}

export function addCourse(name) {
  const course = {
    id: cryptoId(),
    name: name.trim() || `Course ${state.courses.length + 1}`,
    color: COURSE_COLORS[state.courses.length % COURSE_COLORS.length],
  };
  update((s) => s.courses.push(course));
  return course;
}

export function removeCourse(id) {
  update((s) => {
    s.courses = s.courses.filter((c) => c.id !== id);
    const name = (state.courses.find((c) => c.id === id) || {}).name;
    s.items = s.items.filter((it) => it.courseId !== id);
    s.studyBlocks = [];
    void name;
  });
}

export function courseById(id) {
  return state.courses.find((c) => c.id === id) || null;
}

export function courseColor(id) {
  return courseById(id)?.color || '#64748b';
}

export function mergeItems(newItems, courseId) {
  update((s) => {
    const existingKeys = new Set(
      s.items.map((it) => `${it.type}|${it.title.toLowerCase()}|${it.date}|${it.courseId}`)
    );
    for (const it of newItems) {
      it.courseId = courseId;
      const k = `${it.type}|${it.title.toLowerCase()}|${it.date}|${courseId}`;
      if (existingKeys.has(k)) continue;
      existingKeys.add(k);
      s.items.push(it);
    }
    s.items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  });
}

export function toggleDone(id) {
  update((s) => {
    const it = s.items.find((x) => x.id === id);
    if (it) it.done = !it.done;
  });
}

// Re-extraction: drop everything for this course, then add the new set —
// carrying over the "done" checkmarks for items that still match.
export function replaceCourseItems(newItems, courseId) {
  update((s) => {
    const doneKeys = new Set(
      s.items
        .filter((it) => it.courseId === courseId && it.done)
        .map((it) => `${it.type}|${(it.title || '').toLowerCase()}|${it.date}`)
    );
    s.items = s.items.filter((it) => it.courseId !== courseId);
    for (const it of newItems) {
      it.courseId = courseId;
      if (doneKeys.has(`${it.type}|${(it.title || '').toLowerCase()}|${it.date}`)) it.done = true;
      s.items.push(it);
    }
    s.items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    s.studyBlocks = s.studyBlocks.filter((b) => {
      const item = s.items.find((it) => it.id === b.itemId);
      return !!item;
    });
  });
}

export function itemCountForCourse(courseId) {
  return state.items.filter((it) => it.courseId === courseId).length;
}

export function exportJson() {
  // Never write the API key into an exported/shared plan file.
  const { anthropicKey, ...safeSettings } = state.settings;
  void anthropicKey;
  return JSON.stringify(
    { courses: state.courses, items: state.items, studyBlocks: state.studyBlocks, settings: safeSettings },
    null,
    2
  );
}

export function importJson(text) {
  const data = JSON.parse(text);
  update((s) => {
    const keepKey = s.settings.anthropicKey || '';
    s.courses = data.courses || [];
    s.items = data.items || [];
    s.studyBlocks = data.studyBlocks || [];
    s.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), anthropicKey: keepKey };
  });
}

export function resetAll() {
  update((s) => {
    s.courses = [];
    s.items = [];
    s.studyBlocks = [];
    s.settings = { ...DEFAULT_SETTINGS };
    s.ui = { view: 'upload', month: null, selectedDate: null };
  });
}
