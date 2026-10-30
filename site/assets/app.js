// Calendar page: Today / Week / All sprints, filters, and the sprint details dialog.
import {
  h, loadData, remember, zoneOptions, initialZone, wall, currentOffset, todayIn, fmtDay, sessionTimes,
  sessionTitle, sessionPlace, typeColor, inkFor, chip, contactList, scheduleUrl, editSessionUrl,
  searchText, markdown, preview,
} from './common.js';

const $ = id => document.getElementById(id);
const narrow = matchMedia('(max-width: 720px)');
const state = { data: null, config: null, sprints: [], zone: null, view: 'today', q: '', active: new Map(), ec: null };

// ---------------------------------------------------------------- facets (filters)

const FACETS = [
  { id: 'type', label: 'Sprint type', values: sp => (sp.type ? [sp.type] : []) },
  { id: 'group', label: 'Working group', values: sp => sp.tags.filter(t => t.kind === 'group').map(t => t.name) },
  {
    id: 'label', label: 'Topic',
    values: sp => sp.tags.filter(t => t.kind === 'label' && !/^new contributor friendly$/i.test(t.name)).map(t => t.name),
  },
  {
    id: 'where', label: 'Where',
    values: sp => [...new Set(sp.sessions.flatMap(s => [s.site && s.mode !== 'online' ? s.site : null, s.online ? 'Online' : null]).filter(Boolean))],
  },
  {
    id: 'other', label: 'Other',
    values: sp => [
      sp.new_contributor_friendly || sp.tags.some(t => /^new contributor friendly$/i.test(t.name)) ? 'New contributor friendly' : null,
      sp.sessions.length ? null : 'Not yet scheduled',
      sp.wrapup ? 'Has a wrap-up' : null,
    ].filter(Boolean),
  },
];

function matches(sp) {
  if (state.q && !state.q.split(/\s+/).every(w => searchText(sp).includes(w))) return false;
  for (const [facet, wanted] of state.active) {
    if (!wanted.size) continue;
    const have = FACETS.find(f => f.id === facet).values(sp);
    if (!have.some(v => wanted.has(v))) return false;
  }
  return true;
}

function renderFacets() {
  const box = $('facets');
  box.replaceChildren();
  for (const facet of FACETS) {
    const counts = new Map();
    for (const sp of state.sprints) for (const v of facet.values(sp)) counts.set(v, (counts.get(v) || 0) + 1);
    if (!counts.size) continue;
    const selected = state.active.get(facet.id) || new Set();
    const tagColor = name => state.sprints.flatMap(sp => sp.tags).find(t => t.name === name)?.color;
    const buttons = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, n]) => {
      const btn = h('button', {
        type: 'button', class: `facet${selected.has(value) ? ' on' : ''}`, 'aria-pressed': String(selected.has(value)),
        onclick: () => toggleFacet(facet.id, value),
      }, value, h('span', { class: 'n', text: n }));
      const color = facet.id === 'type' ? state.config.type_colors[value] : tagColor(value);
      if (color) btn.style.setProperty('--chip', color);
      return btn;
    });
    box.append(h('div', { class: 'facet-group' }, h('h3', { text: facet.label }), h('div', { class: 'facet-buttons' }, buttons)));
  }
  const active = [...state.active].flatMap(([id, set]) => [...set].map(v => [id, v]));
  $('filter-count').textContent = active.length ? `(${active.length})` : '';
  $('active-filters').replaceChildren(...active.map(([id, v]) =>
    h('button', { type: 'button', class: 'pill', title: 'Remove filter', onclick: () => toggleFacet(id, v) }, v, ' ×')));
  if (active.length > 1) $('active-filters').append(h('button', { type: 'button', class: 'link', onclick: clearFilters }, 'Clear all'));
}

function toggleFacet(id, value) {
  const set = state.active.get(id) || new Set();
  set.has(value) ? set.delete(value) : set.add(value);
  state.active.set(id, set);
  render();
}

function clearFilters() {
  state.active.clear();
  state.q = '';
  $('q').value = '';
  render();
}

// ---------------------------------------------------------------- calendar

const PROGRAM_ICONS = { break: '☕', meal: '🍽️', plenary: '🎤', social: '🎉' };
const PROGRAM_COLORS = { plenary: '#3d4451', social: '#9a6700', break: 'rgba(138, 148, 166, 0.22)', meal: 'rgba(201, 162, 39, 0.22)' };
const isBand = p => p.kind === 'break' || p.kind === 'meal';

/** Does the clock of `tz` read the same as the item's own site clock (e.g. America/Vancouver vs. Los Angeles)? */
const sameClock = (p, tz) => ['start_utc', 'end_utc'].every(k => wall(p[k], tz).iso === wall(p[k], p.tz).iso);

/**
 * Organizers' program items to show. Plenaries and anything with an online link concern
 * everyone; breaks, meals and in-person socials only show when the displayed clock matches
 * their site's clock (or when filtering by that site).
 */
function programItems() {
  const where = state.active.get('where');
  return state.config.program.filter(p => {
    if (where && where.size) return where.has(p.site) || (Boolean(p.online) && where.has('Online'));
    return p.kind === 'plenary' || Boolean(p.online) || sameClock(p, state.zone.tz);
  });
}

function programEvents(listView) {
  const tz = state.zone.tz;
  return programItems().map(p => {
    const band = isBand(p) && !listView;
    return {
      id: `program:${p.id}`,
      start: wall(p.start_utc, tz).iso,
      end: wall(p.end_utc, tz).iso,
      title: p.title,
      display: band ? 'background' : 'auto',
      backgroundColor: PROGRAM_COLORS[p.kind],
      textColor: '#fff',
      classNames: ['prog', `prog-${p.kind}`],
      extendedProps: { program: p.id },
    };
  });
}

function events() {
  const tz = state.zone.tz;
  return state.sprints.filter(matches).flatMap(sp => sp.sessions.map(s => {
    const color = typeColor(sp, state.config);
    return {
      id: s.id,
      start: wall(s.start_utc, tz).iso,
      end: wall(s.end_utc, tz).iso,
      title: sessionTitle(sp, s),
      backgroundColor: color,
      textColor: inkFor(color),
      classNames: [`mode-${(s.mode || 'tba').replace(' ', '-')}`, s.room_issue ? 'room-issue' : ''].filter(Boolean),
      extendedProps: { sprint: sp.number, session: s.id },
    };
  }));
}

function eventContent(info) {
  if (info.event.extendedProps.program) {
    const p = state.programById.get(info.event.extendedProps.program);
    const label = `${PROGRAM_ICONS[p.kind]} ${p.title}`;
    if (info.event.display === 'background') return { domNodes: [h('div', { class: 'prog-label', text: label })] };
    if (info.event.end - info.event.start < 50 * 60 * 1000 && info.view.type.startsWith('timeGrid')) {
      return { domNodes: [h('div', { class: 'ev-line' }, h('span', { class: 'ev-time', text: info.timeText }), ' ', h('strong', { text: label }))] };
    }
    const place = [p.site, p.location].filter(Boolean).join(' – ') + (p.online ? ' + online' : '');
    return {
      domNodes: [
        h('div', { class: 'ev-time', text: info.timeText }),
        h('div', { class: 'ev-title', text: label }),
        place ? h('div', { class: 'ev-place', text: place }) : null,
      ].filter(Boolean),
    };
  }
  const { sprint, session } = info.event.extendedProps;
  const sp = state.byNumber.get(sprint);
  const s = sp.sessions.find(x => x.id === session);
  const icon = s.mode === 'online' ? '💻' : s.mode === 'hybrid' ? '📍💻' : '📍';
  if (info.event.end - info.event.start < 50 * 60 * 1000 && info.view.type.startsWith('timeGrid')) {
    return { domNodes: [h('div', { class: 'ev-line' }, h('span', { class: 'ev-time', text: info.timeText }), ' ', h('strong', { text: sessionTitle(sp, s) }))] };
  }
  return {
    domNodes: [
      h('div', { class: 'ev-time', text: info.timeText }),
      h('div', { class: 'ev-title', text: sessionTitle(sp, s) }),
      h('div', { class: 'ev-place', text: `${icon} ${sessionPlace(s)}` }),
    ],
  };
}

function weekRange() {
  // Visible days: the configured week, stretched if a time-zone shift pushes sessions outside it.
  const days = new Set(state.config.days);
  for (const sp of state.sprints) for (const s of sp.sessions) days.add(wall(s.start_utc, state.zone.tz).date);
  const sorted = [...days].sort();
  const end = new Date(`${sorted.at(-1)}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const weekdays = new Set(sorted.map(d => new Date(`${d}T12:00:00Z`).getUTCDay()));
  return { start: sorted[0], end: end.toISOString().slice(0, 10), hidden: [0, 6].filter(d => !weekdays.has(d)) };
}

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function slotLimits() {
  // Whole hours covering every session (not only filtered ones, so the grid does not jump).
  let lo = 8 * 60, hi = 18 * 60;
  const spans = [...state.sprints.flatMap(sp => sp.sessions), ...programItems()];
  {
    for (const s of spans) {
      const a = wall(s.start_utc, state.zone.tz), b = wall(s.end_utc, state.zone.tz);
      lo = Math.min(lo, Math.floor(minutes(a.time) / 60) * 60);
      hi = Math.max(hi, b.date > a.date ? 24 * 60 : Math.ceil(minutes(b.time) / 60) * 60);
    }
  }
  return { slotMinTime: hhmm(lo), slotMaxTime: hhmm(hi) };
}

function weekTitle() {
  const { start, end } = weekRange();
  const last = new Date(`${end}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  const a = new Date(`${start}T12:00:00Z`);
  const month = d => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(d);
  const tail = a.getUTCMonth() === last.getUTCMonth() ? '' : `${month(last)} `;
  return `${month(a)} ${a.getUTCDate()} – ${tail}${last.getUTCDate()}, ${last.getUTCFullYear()}`;
}

function calendarDate() {
  const today = todayIn(state.zone.tz);
  const { start, end } = weekRange();
  return today >= start && today < end ? today : state.config.days[0];
}

function calendarOptions() {
  const range = weekRange();
  const view = state.view === 'today' ? 'timeGridDay' : narrow.matches ? 'listWeek' : 'timeGridWeek';
  const hm = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return {
    view,
    date: calendarDate(),
    events: [...events(), ...programEvents(view.startsWith('list'))],
    timeZone: state.zone.id === 'local' ? 'local' : currentOffset(state.zone.tz),
    headerToolbar: { start: 'prev,next today', center: 'title', end: '' },
    buttonText: { today: 'Today' },
    firstDay: 1,
    hiddenDays: range.hidden,
    validRange: { start: range.start, end: range.end },
    allDaySlot: false,
    nowIndicator: true,
    slotDuration: '00:30',
    ...slotLimits(),
    scrollTime: '08:00',
    eventTimeFormat: hm,
    slotLabelFormat: hm,
    dayHeaderFormat: { weekday: 'short', month: 'short', day: 'numeric' },
    listDayFormat: { weekday: 'long' },
    listDaySideFormat: { month: 'short', day: 'numeric' },
    titleFormat: view === 'timeGridDay' ? { weekday: 'long', month: 'long', day: 'numeric' } : () => weekTitle(),
    eventContent,
    eventClick: info => {
      if (info.event.extendedProps.program) openProgram(info.event.extendedProps.program);
      else location.hash = `#sprint/${info.event.extendedProps.sprint}`;
    },
    noEventsContent: 'No sessions match your search or filters.',
  };
}

function renderCalendar() {
  const opts = calendarOptions();
  if (!state.ec) {
    state.ec = window.EventCalendar.create($('calendar'), opts);
    return;
  }
  const current = state.ec.getOption('view');
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'date' && current === opts.view && !state.viewChanged) continue; // keep the user's navigation
    state.ec.setOption(k, v);
  }
}

// ---------------------------------------------------------------- now / next

function renderNowNext() {
  const box = $('now-next');
  const now = new Date().toISOString();
  const today = todayIn(state.zone.tz);
  const rows = [
    ...state.sprints.filter(matches).flatMap(sp => sp.sessions.map(s => ({ sp, s }))),
    ...programItems().map(p => ({ p, s: p })),
  ];
  const live = rows.filter(r => r.s.start_utc <= now && now < r.s.end_utc);
  const next = rows.filter(r => r.s.start_utc > now && wall(r.s.start_utc, state.zone.tz).date === today)
    .sort((a, b) => a.s.start_utc.localeCompare(b.s.start_utc)).slice(0, 4);
  box.hidden = !(live.length || next.length);
  const item = ({ sp, p, s }) => h('a', {
    class: 'nn-item', href: sp ? `#sprint/${sp.number}` : '#',
    onclick: p ? e => { e.preventDefault(); openProgram(p.id); } : null,
  },
  h('span', { class: 'swatch', style: `background:${sp ? typeColor(sp, state.config) : PROGRAM_COLORS[p.kind]}` }),
  h('span', { class: 'nn-time', text: sessionTimes(s, state.zone.tz, state.config).text }),
  h('span', { class: 'nn-title', text: sp ? sessionTitle(sp, s) : `${PROGRAM_ICONS[p.kind]} ${p.title}` }),
  h('span', { class: 'nn-place', text: sp ? sessionPlace(s) : [p.site, p.location].filter(Boolean).join(' – ') || (p.online ? 'Online' : '') }));
  box.replaceChildren(
    live.length ? h('div', {}, h('h2', { text: '🔴 Happening now' }), live.map(item)) : null,
    next.length ? h('div', {}, h('h2', { text: 'Up next today' }), next.map(item)) : null,
  );
}

// ---------------------------------------------------------------- directory

function sprintCard(sp) {
  const color = typeColor(sp, state.config);
  const times = sp.sessions.map(s => {
    const t = sessionTimes(s, state.zone.tz, state.config);
    return h('li', {}, h('strong', { text: fmtDay(t.day) }), ` ${t.text} · ${sessionPlace(s)}`);
  });
  const sched = scheduleUrl(state.config, sp);
  return h('article', { class: 'card', style: `--sprint:${color}` },
    h('div', { class: 'card-top' },
      h('span', { class: 'type', text: sp.type || 'Sprint' }),
      sp.state === 'closed' ? h('span', { class: 'badge', text: 'Closed' }) : null,
      sp.wrapup ? h('span', { class: 'badge good', text: 'Wrap-up' }) : null),
    h('h3', {}, h('a', { href: `#sprint/${sp.number}`, text: sp.title })),
    h('p', { class: 'pitch', text: preview(sp.pitch) }),
    h('p', { class: 'people' }, '👤 ', contactList(sp)),
    times.length
      ? h('ul', { class: 'times' }, times)
      : h('p', { class: 'unscheduled' }, 'Not scheduled yet',
        sp.schedule_note ? h('span', { class: 'muted', text: ` · “${sp.schedule_note.split('\n')[0]}”` }) : null),
    h('div', { class: 'card-actions' },
      h('a', { class: 'btn small', href: `#sprint/${sp.number}` }, 'Details'),
      !sp.sessions.length && sched ? h('a', { class: 'btn small primary', href: sched, target: '_blank', rel: 'noopener' }, '📅 Schedule a session') : null,
      h('a', { class: 'btn small ghost', href: sp.url, target: '_blank', rel: 'noopener' }, `GitHub #${sp.number}`)),
  );
}

function renderDirectory() {
  const box = $('directory');
  const list = state.sprints.filter(matches);
  const first = sp => sp.sessions[0]?.start_utc || '9999';
  const unscheduled = list.filter(sp => !sp.sessions.length);
  const scheduled = list.filter(sp => sp.sessions.length).sort((a, b) => first(a).localeCompare(first(b)));
  const section = (title, items, hint) => items.length
    ? h('section', { class: 'dir-section' }, h('h2', {}, title, h('span', { class: 'count', text: ` ${items.length}` })),
      hint ? h('p', { class: 'muted', text: hint }) : null, h('div', { class: 'cards' }, items.map(sprintCard)))
    : null;
  box.replaceChildren(
    section('Not yet scheduled', unscheduled, 'Proposed sprints looking for a time (and for collaborators!).'),
    section('Scheduled', scheduled),
    list.length ? null : h('p', { class: 'empty', text: 'No sprints match your search or filters.' }),
  );
}

// ---------------------------------------------------------------- sprint dialog

function sessionItem(sp, s) {
  const zone = state.zone.tz;
  const t = sessionTimes(s, zone, state.config);
  const native = s.tz !== zone ? sessionTimes(s, s.tz, state.config) : null;
  const edit = editSessionUrl(state.config, s);
  return h('li', { class: 'session' },
    h('div', { class: 'when' }, h('strong', { text: fmtDay(t.day, 'long') }), ` · ${t.text}`,
      native ? h('span', { class: 'muted', text: ` (${native.text} local)` }) : null),
    s.label ? h('div', { class: 'label', text: s.label }) : null,
    h('div', { class: 'where' },
      s.mode !== 'online' ? `📍 ${[s.site, s.location].filter(Boolean).join(' – ') || 'Location to be announced'}` : null,
      s.online ? h('a', { class: 'join', href: s.online, target: '_blank', rel: 'noopener' }, '💻 Join online') : null),
    s.note ? h('div', { class: 'note', text: s.note }) : null,
    s.room_issue ? h('div', { class: 'room-warning', text: `⚠️ ${s.room_issue} The sprint team has been asked to pick another room.` }) : null,
    edit ? h('a', { class: 'link small', href: edit, target: '_blank', rel: 'noopener' }, 'Edit or cancel') : null,
  );
}

function openProgram(id) {
  const p = state.programById.get(id);
  const dlg = $('sprint-dialog');
  if (!p) return;
  const t = sessionTimes(p, state.zone.tz, state.config);
  const native = p.tz !== state.zone.tz ? sessionTimes(p, p.tz, state.config) : null;
  const kind = { break: 'Break', meal: 'Meal', plenary: 'Plenary', social: 'Social event' }[p.kind];
  dlg.replaceChildren(h('div', { class: 'dialog-body' },
    h('button', { class: 'close', 'aria-label': 'Close', onclick: () => dlg.close() }, '×'),
    h('div', { class: 'card-top' }, h('span', { class: 'type', text: `${kind} · organizers' program` })),
    h('h2', { id: 'sprint-dialog-title', text: `${PROGRAM_ICONS[p.kind]} ${p.title}` }),
    h('ul', { class: 'sessions-list' }, h('li', { class: 'session' },
      h('div', { class: 'when' }, h('strong', { text: fmtDay(t.day, 'long') }), ` · ${t.text}`,
        native ? h('span', { class: 'muted', text: ` (${native.text} local)` }) : null),
      h('div', { class: 'where' },
        p.site || p.location ? `📍 ${[p.site, p.location].filter(Boolean).join(' – ')}` : null,
        p.online ? h('a', { class: 'join', href: p.online, target: '_blank', rel: 'noopener' }, '💻 Join online') : null),
      p.note ? h('div', { class: 'note', text: p.note }) : null)),
  ));
  if (!dlg.open) dlg.showModal();
}

function openSprint(number) {
  const sp = state.byNumber.get(number);
  const dlg = $('sprint-dialog');
  if (!sp) return;
  const sched = scheduleUrl(state.config, sp);
  const md = (title, text, cls) => text ? h('section', { class: cls || '' }, h('h3', { text: title }), markdown(text, state.config)) : null;
  dlg.replaceChildren(h('div', { class: 'dialog-body', style: `--sprint:${typeColor(sp, state.config)}` },
    h('button', { class: 'close', 'aria-label': 'Close', onclick: () => dlg.close() }, '×'),
    h('div', { class: 'card-top' }, h('span', { class: 'type', text: sp.type || 'Sprint' }),
      sp.state === 'closed' ? h('span', { class: 'badge', text: 'Closed' }) : null),
    h('h2', { id: 'sprint-dialog-title', text: sp.title }),
    h('p', { class: 'people' }, '👤 ', contactList(sp)),
    h('div', { class: 'chips' }, sp.tags.filter(t => t.kind !== 'type').map(chip)),
    markdown(sp.pitch, state.config, 'md lead'),
    h('section', { class: 'sessions' },
      h('h3', { text: sp.sessions.length > 1 ? `Sessions (${sp.sessions.length})` : 'Session' }),
      sp.sessions.length
        ? h('ul', {}, sp.sessions.map(s => sessionItem(sp, s)))
        : h('p', { class: 'unscheduled' }, 'Not scheduled yet.',
          sp.schedule_note ? h('span', { class: 'muted', text: ` Notes from the issue: “${sp.schedule_note}”` }) : null),
      h('div', { class: 'row' },
        sched ? h('a', { class: 'btn small primary', href: sched, target: '_blank', rel: 'noopener' }, sp.sessions.length ? '＋ Add a session' : '📅 Schedule a session') : null,
        sp.sessions.length ? h('a', { class: 'btn small', href: `ics/sprint-${sp.number}.ics`, download: '' }, '🗓️ Add to my calendar') : null)),
    sp.wrapup ? h('section', { class: 'wrapup' }, h('h3', {}, '📝 Wrap-up ',
      sp.wrapup_url ? h('a', { class: 'link small', href: sp.wrapup_url, target: '_blank', rel: 'noopener' }, 'source') : null),
    markdown(sp.wrapup, state.config)) : null,
    md('Goals and deliverables', sp.goals),
    md('Prerequisites', sp.prerequisites),
    md('Communication channel and links', sp.links),
    md('Details', sp.details),
    sp.warnings.length ? h('p', { class: 'warning', text: `⚠️ ${sp.warnings.length} session entr${sp.warnings.length > 1 ? 'ies' : 'y'} on the issue could not be read and ${sp.warnings.length > 1 ? 'are' : 'is'} not shown.` }) : null,
    h('div', { class: 'row footer-row' },
      h('a', { class: 'btn primary', href: sp.url, target: '_blank', rel: 'noopener' }, `Open GitHub issue #${sp.number} →`),
      h('span', { class: 'muted small', text: 'Comment there to join; edit the issue to change the description.' })),
  ));
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}

// ---------------------------------------------------------------- routing & render

function render() {
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.view === state.view);
  const isCal = state.view !== 'sprints';
  $('calendar-wrap').hidden = !isCal;
  $('directory').hidden = isCal;
  $('now-next').hidden = true;
  renderFacets();
  if (isCal) {
    renderCalendar();
    if (state.view === 'today') renderNowNext();
  } else {
    renderDirectory();
  }
  state.viewChanged = false;
  const n = state.sprints.filter(matches).length;
  $('sprint-count').textContent = `(${n})`;
}

function route() {
  const hash = location.hash.slice(1);
  const m = hash.match(/^sprint\/(\d+)$/);
  if (m) {
    openSprint(Number(m[1]));
    return;
  }
  if ($('sprint-dialog').open) $('sprint-dialog').close();
  const view = ['today', 'week', 'sprints'].includes(hash) ? hash : state.view;
  state.viewChanged = view !== state.view || state.viewChanged;
  state.view = view;
  remember('view', view);
  render();
}

function setupSubscribe() {
  const feed = new URL('calendar.ics', location.href).href;
  const webcal = feed.replace(/^https?:/, 'webcal:');
  $('sub-url').value = feed;
  $('sub-webcal').href = webcal;
  $('sub-google').href = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  $('subscribe-btn').addEventListener('click', () => $('subscribe-dialog').showModal());
  $('sub-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(feed); $('sub-copy').textContent = 'Copied!'; } catch { $('sub-url').select(); }
  });
}

async function main() {
  try {
    state.data = await loadData();
  } catch (err) {
    $('notice').hidden = false;
    $('notice').textContent = `Could not load the schedule: ${err.message}`;
    return;
  }
  const { config } = state.data;
  state.config = config;
  state.sprints = state.data.sprints;
  state.byNumber = new Map(state.sprints.map(sp => [sp.number, sp]));
  config.program = config.program || [];
  state.programById = new Map(config.program.map(p => [p.id, p]));
  state.zone = initialZone(config);

  document.title = `${config.title} · Calendar`;
  $('event-title').textContent = config.title;
  const sites = config.sites.map(s => s.name).join(' · ');
  $('event-dates').textContent = `${fmtDay(config.start_date)} – ${fmtDay(config.end_date)}${sites ? ` · ${sites} · online` : ''}`;
  $('new-sprint').href = config.new_sprint_url;

  const tzSel = $('tz');
  for (const o of zoneOptions(config)) tzSel.append(h('option', { value: o.id, text: o.label }));
  tzSel.value = state.zone.id;
  tzSel.addEventListener('change', () => {
    state.zone = zoneOptions(config).find(o => o.id === tzSel.value);
    remember('tz', state.zone.id);
    render();
    if ($('sprint-dialog').open) route();
  });

  let timer;
  $('q').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); render(); }, 150);
  });

  $('sprint-dialog').addEventListener('close', () => {
    if (location.hash.startsWith('#sprint/')) history.replaceState(null, '', `#${state.view}`);
  });
  $('sprint-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('subscribe-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  setupSubscribe();

  $('legend').replaceChildren('Colors show the sprint type. ',
    h('span', { class: 'key key-solid' }), ' in person or hybrid  ', h('span', { class: 'key key-online' }), ' online only  ',
    h('span', { class: 'key key-band' }), ' breaks and meals (shown in their site\'s time)  ',
    h('span', { class: 'key key-plenary' }), ' plenaries and socials');
  const updated = new Date(state.data.generated_at);
  $('footer').replaceChildren(
    'Generated from the ', h('a', { href: `${config.repo_url}/issues`, target: '_blank', rel: 'noopener', text: 'GitHub issues' }),
    ` of ${config.repo} · updated ${updated.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · `,
    h('a', { href: config.new_sprint_url, target: '_blank', rel: 'noopener', text: 'Propose a sprint' }));

  narrow.addEventListener('change', () => { state.viewChanged = true; render(); });
  window.addEventListener('hashchange', route);
  const saved = ['today', 'week', 'sprints'].includes(location.hash.slice(1)) ? location.hash.slice(1) : null;
  state.view = saved || 'today';
  if (location.hash.startsWith('#sprint/')) {
    state.view = 'week';
    render();
  }
  route();
}

main();
