// Calendar page: Today / Week / All sprints, filters, and the sprint details dialog.
import {
  h, setupThemeToggle, loadData, latestBuild, remember, recall, zoneOptions, initialZone, wall, currentOffset, todayIn, fmtDay, sessionTimes, tzAbbr,
  sessionTitle, sessionPlace, typeColor, inkFor, chip, contactList, scheduleUrl, editSessionUrl, addToCalendar,
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
      sp.wrapups.length ? 'Has a wrap-up' : null,
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
    // EventCalendar's day view jumps past validRange when hiddenDays is set; the weekend is outside the range anyway.
    hiddenDays: view === 'timeGridDay' ? [] : range.hidden,
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
  box.replaceChildren(...[ // (replaceChildren would turn null into the text "null")
    live.length ? h('div', {}, h('h2', { text: '🔴 Happening now' }), live.map(item)) : null,
    next.length ? h('div', {}, h('h2', { text: 'Up next today' }), next.map(item)) : null,
  ].filter(Boolean));
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
      sp.wrapups.length ? h('span', { class: 'badge good', text: sp.wrapups.length > 1 ? `${sp.wrapups.length} wrap-ups` : 'Wrap-up' }) : null),
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

/** Sprints of the Scheduled or Unscheduled tab that match the search and filters. */
function directoryList(kind) {
  const first = sp => sp.sessions[0]?.start_utc || '';
  const list = state.sprints.filter(matches).filter(sp => (kind === 'scheduled') === sp.sessions.length > 0);
  return kind === 'scheduled' ? list.sort((a, b) => first(a).localeCompare(first(b))) : list;
}

function renderDirectory(kind) {
  const list = directoryList(kind);
  const hint = kind === 'scheduled'
    ? 'Sprints with sessions on the calendar, in order of their first session.'
    : 'Proposed sprints still looking for a time (and for collaborators!).';
  $('directory').replaceChildren(
    h('p', { class: 'muted', text: hint }),
    list.length
      ? h('div', { class: 'cards' }, list.map(sprintCard))
      : h('p', { class: 'empty', text: state.q || [...state.active.values()].some(v => v.size) ? 'No sprints match your search or filters.' : 'None yet.' }),
  );
}

// ---------------------------------------------------------------- rooms view

const normRoom = s => String(s || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
const nextDay = date => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Sessions (and program items) booked in a room of `site`, keyed by normalized room name. */
function roomBookings(site) {
  const listed = new Set(site.rooms.map(r => normRoom(r.name)));
  const out = [];
  for (const sp of state.sprints) {
    for (const s of sp.sessions) if (s.site === site.name && s.location) out.push({ key: normRoom(s.location), sp, s });
  }
  for (const p of state.config.program) {
    if (p.site === site.name && listed.has(normRoom(p.location))) out.push({ key: normRoom(p.location), p, s: p });
  }
  return out;
}

/** Listed rooms in config order, then rooms people typed themselves. */
function roomColumns(site, bookings) {
  const cols = site.rooms.map(r => ({ id: normRoom(r.name), title: r.name, room: r }));
  for (const b of bookings) {
    if (!cols.some(c => c.id === b.key)) cols.push({ id: b.key, title: b.s.location, room: null });
  }
  return cols;
}

/** When a listed room can be used on `date`: null (all day), [] (not at all) or [{start, end}]. */
function openHours(room, date) {
  if (!room || !room.available) return null;
  const w = room.available.filter(x => x.date === date);
  return w.some(x => !x.start) ? null : w.map(x => ({ start: x.start, end: x.end }));
}

const hoursText = hours => hours === null ? 'open all day'
  : !hours.length ? 'not available'
  : `open ${hours.map(x => x.start === '00:00' ? `until ${x.end}` : x.end === '24:00' ? `from ${x.start}` : `${x.start}–${x.end}`).join(', ')}`;

function roomSites() {
  return state.config.sites.filter(site => site.rooms.length || roomBookings(site).length);
}

function renderRooms() {
  const sites = roomSites();
  if (!sites.length) {
    $('rooms-note').textContent = 'No rooms are listed in sprintweek.yaml yet.';
    return;
  }
  const site = sites.find(x => x.name === state.roomsSite) || sites.find(x => x.timezone === state.zone.tz) || sites[0];
  state.roomsSite = site.name;
  const today = todayIn(site.timezone);
  if (!state.config.days.includes(state.roomsDay)) state.roomsDay = state.config.days.includes(today) ? today : state.config.days[0];
  const day = state.roomsDay;
  const seg = (items, current, pick) => items.map(([value, label]) =>
    h('button', { type: 'button', class: value === current ? 'on' : '', 'aria-pressed': String(value === current), onclick: () => pick(value) }, label));
  $('rooms-sites').replaceChildren(...seg(sites.map(x => [x.name, x.name]), site.name, v => { state.roomsSite = v; remember('rooms-site', v); renderRooms(); }));
  $('rooms-days').replaceChildren(...seg(state.config.days.map(d => [d, fmtDay(d)]), day, v => { state.roomsDay = v; renderRooms(); }));
  $('rooms-note').textContent = `Times are ${site.name} time (${tzAbbr(site.timezone, `${day}T12:00:00Z`, state.config)}). `
    + 'Grey means the room is not available. Rooms can be shared: this shows what is booked, it does not stop anyone from booking.';

  const bookings = roomBookings(site);
  const cols = roomColumns(site, bookings);
  const local = b => ({ start: wall(b.s.start_utc, site.timezone), end: wall(b.s.end_utc, site.timezone) });
  const onDay = bookings.filter(b => local(b).start.date === day);

  if (narrow.matches) { // phones: one card per room
    $('rooms-cal').hidden = true;
    $('rooms-list').hidden = false;
    $('rooms-list').replaceChildren(...cols.map(c => {
      const mine = onDay.filter(b => b.key === c.id).sort((a, b) => a.s.start_utc.localeCompare(b.s.start_utc));
      return h('article', { class: 'room-card' },
        h('h3', {}, c.title, c.room ? null : h('span', { class: 'muted small', text: ' (not listed)' })),
        h('p', { class: 'muted small', text: c.room ? hoursText(openHours(c.room, day)) : 'typed in by a sprint' }),
        mine.length ? h('ul', {}, mine.map(b => h('li', {},
          h('strong', { text: `${local(b).start.time}–${local(b).end.time}` }), ' ',
          b.sp ? h('a', { href: `#sprint/${b.sp.number}`, text: sessionTitle(b.sp, b.s) }) : `${PROGRAM_ICONS[b.p.kind]} ${b.p.title}`)))
          : h('p', { class: 'small', text: 'Nothing booked.' }));
    }));
    return;
  }

  $('rooms-cal').hidden = false;
  $('rooms-list').hidden = true;
  const events = bookings.map(b => {
    const color = b.sp ? typeColor(b.sp, state.config) : PROGRAM_COLORS[b.p.kind];
    return {
      id: `room:${b.sp ? b.s.id : b.p.id}`,
      resourceIds: [b.key],
      start: local(b).start.iso,
      end: local(b).end.iso,
      title: b.sp ? sessionTitle(b.sp, b.s) : b.p.title,
      backgroundColor: color,
      textColor: inkFor(color),
      classNames: b.s.room_issue ? ['room-issue'] : [],
      extendedProps: b.sp ? { sprint: b.sp.number, session: b.s.id } : { program: b.p.id },
    };
  });
  // Grey out the hours when listed rooms are not available.
  for (const c of cols) {
    if (!c.room || !c.room.available) continue;
    for (const d of state.config.days) {
      const hours = openHours(c.room, d);
      if (hours === null) continue;
      let from = '00:00';
      const gaps = [];
      for (const w of [...hours].sort((a, b) => a.start.localeCompare(b.start))) {
        if (w.start > from) gaps.push([from, w.start]);
        if (w.end > from) from = w.end;
      }
      if (from < '24:00') gaps.push([from, '24:00']);
      for (const [a, b] of gaps) {
        events.push({
          start: `${d}T${a}:00`, end: b === '24:00' ? `${nextDay(d)}T00:00:00` : `${d}T${b}:00`,
          display: 'background', resourceIds: [c.id], classNames: ['unavailable'], backgroundColor: 'rgba(120, 120, 130, 0.28)',
        });
      }
    }
  }
  const hm = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const opts = {
    view: 'resourceTimeGridDay',
    date: day,
    resources: cols.map(c => ({ id: c.id, title: c.title, extendedProps: { listed: Boolean(c.room), hours: c.room ? hoursText(openHours(c.room, day)) : 'not listed' } })),
    events,
    timeZone: currentOffset(site.timezone),
    headerToolbar: { start: '', center: 'title', end: '' },
    titleFormat: { weekday: 'long', month: 'long', day: 'numeric' },
    allDaySlot: false,
    nowIndicator: true,
    slotDuration: '00:30',
    slotMinTime: '07:00',
    slotMaxTime: '20:00',
    flexibleSlotTimeLimits: true,
    scrollTime: '07:00',
    eventTimeFormat: hm,
    slotLabelFormat: hm,
    resourceLabelContent: ({ resource }) => ({
      domNodes: [h('div', { class: 'room-head' }, h('strong', { text: resource.title }), h('span', { class: 'muted small', text: resource.extendedProps.hours }))],
    }),
    eventContent: info => (info.event.display === 'background' ? { domNodes: [] } : {
      domNodes: [h('div', { class: 'ev-time', text: info.timeText }), h('div', { class: 'ev-title', text: info.event.title })],
    }),
    eventClick: info => {
      if (info.event.extendedProps.program) openProgram(info.event.extendedProps.program);
      else if (info.event.extendedProps.sprint) location.hash = `#sprint/${info.event.extendedProps.sprint}`;
    },
  };
  if (!state.roomsEc) state.roomsEc = window.EventCalendar.create($('rooms-cal'), opts);
  else for (const [k, v] of Object.entries(opts)) state.roomsEc.setOption(k, v);
}

// ---------------------------------------------------------------- site info pages

function renderInfo(slug) {
  const page = state.data.site_info.find(p => p.slug === slug);
  const box = $('info');
  if (!page) {
    box.replaceChildren(h('p', { class: 'empty', text: 'There is no information page for this site.' }));
    return;
  }
  const site = state.config.sites.find(s => s.name === page.site);
  const now = new Date();
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: site.timezone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  // The organizers' program at this site, one line per day, in the site's own time.
  const days = state.config.days.map(day => [day, state.config.program.filter(p => p.site === site.name && p.date === day)])
    .filter(([, items]) => items.length);
  box.replaceChildren(...[
    h('header', { class: 'info-head' },
      h('h1', { text: `${site.name} info` }),
      h('p', { class: 'muted', text: `Local time: ${clock} ${tzAbbr(site.timezone, now.toISOString(), state.config)} (${site.timezone.replace(/_/g, ' ')})` })),
    markdown(page.markdown, state.config, 'md info-md', page.base),
    site.rooms.length ? h('section', {},
      h('h2', { text: 'Rooms' }),
      h('ul', { class: 'room-list' }, site.rooms.map(r => h('li', {}, h('strong', { text: r.name }), ` · available ${r.summary}`)))) : null,
    days.length ? h('section', {},
      h('h2', { text: `Daily program at ${site.name}` }),
      h('table', { class: 'program' }, h('tbody', {}, days.map(([day, items]) => h('tr', {},
        h('th', { text: fmtDay(day) }),
        h('td', {}, items.map(p => h('div', { class: 'program-item' },
          h('span', { class: 'program-time', text: `${p.start}–${p.end}` }), ` ${PROGRAM_ICONS[p.kind]} ${p.title}`,
          p.location ? h('span', { class: 'muted', text: ` · ${p.location}` }) : null)))))))) : null,
    h('p', { class: 'muted small' }, 'This page is written in ',
      h('a', { href: `${state.config.repo_url}/blob/HEAD/${page.path}`, target: '_blank', rel: 'noopener' }, 'Markdown on GitHub'),
      '; rooms and the program come from sprintweek.yaml.'),
  ].filter(Boolean));
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
    addToCalendar({
      title: sessionTitle(sp, s),
      start_utc: s.start_utc,
      end_utc: s.end_utc,
      location: [sessionPlace(s), s.online].filter(Boolean).join(' · '),
      details: [preview(sp.pitch, 400), s.note, s.online ? `Join online: ${s.online}` : '', `Details: ${state.config.site_url}#sprint/${sp.number}`, `GitHub issue: ${sp.url}`].filter(Boolean).join('\n\n'),
      ics: `ics/session-${encodeURIComponent(s.id)}.ics`,
    }),
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
      p.note ? h('div', { class: 'note', text: p.note }) : null,
      addToCalendar({
        title: p.title,
        start_utc: p.start_utc,
        end_utc: p.end_utc,
        location: [[p.site, p.location].filter(Boolean).join(' – '), p.online].filter(Boolean).join(' · '),
        details: [p.note, p.online ? `Join online: ${p.online}` : '', `Schedule: ${state.config.site_url}`].filter(Boolean).join('\n\n'),
        ics: `ics/program-${encodeURIComponent(p.id)}.ics`,
      }))),
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
        sp.sessions.length > 1 ? h('a', { class: 'btn small', href: `ics/sprint-${sp.number}.ics` }, '🗓️ All sessions (.ics)') : null)),
    h('section', { class: 'wrapups' },
      h('h3', { text: sp.wrapups.length > 1 ? `Wrap-ups (${sp.wrapups.length})` : 'Wrap-up' }),
      sp.wrapups.length ? sp.wrapups.map(w => h('article', { class: 'wrapup' },
        h('p', { class: 'wrapup-meta' }, h('strong', { text: fmtDay(w.date, 'long') }), ` · by @${w.author} · `,
          h('a', { class: 'link small', href: w.url, target: '_blank', rel: 'noopener' }, 'view on GitHub')),
        w.date_note ? h('p', { class: 'room-warning', text: `⚠️ Date not understood: ${w.date_note}.` }) : null,
        markdown(w.text, state.config))) : h('p', { class: 'muted', text: 'No wrap-up yet.' }),
      h('p', { class: 'muted small' }, '📝 To add one, ',
        h('a', { href: `${sp.url}#new_comment_field`, target: '_blank', rel: 'noopener' }, 'comment on the GitHub issue'),
        ' starting with ', h('code', { text: '## Wrap-up' }), ' and, on the next line, ', h('code', { text: 'date: YYYY-MM-DD' }), '.')),
    md('Goals and deliverables', sp.goals),
    md('Prerequisites', sp.prerequisites),
    md('Communication channel and links', sp.links),
    md('More details', sp.details),
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
  const isCal = state.view === 'today' || state.view === 'week';
  const isDir = state.view === 'scheduled' || state.view === 'unscheduled';
  const isInfo = state.view.startsWith('info/');
  const isRooms = state.view === 'rooms';
  $('today-note').hidden = true;
  $('calendar-wrap').hidden = !isCal;
  $('directory').hidden = !isDir;
  $('info').hidden = !isInfo;
  $('rooms').hidden = !isRooms;
  $('toolbar').hidden = isInfo || isRooms;
  $('now-next').hidden = true;
  renderFacets();
  if (isCal) {
    renderCalendar();
    if (state.view === 'today') renderNowNext();
    const today = todayIn(state.zone.tz);
    $('today-note').hidden = state.view !== 'today' || state.config.days.includes(today);
    $('today-note').textContent = `${state.config.title} runs ${fmtDay(state.config.start_date)} – ${fmtDay(state.config.end_date)}; `
      + `today is not one of its days, so the first day is shown. Use the arrows to see the others.`;
  } else if (isDir) {
    renderDirectory(state.view);
  } else if (isRooms) {
    renderRooms();
  } else {
    renderInfo(state.view.slice(5));
  }
  state.viewChanged = false;
  $('count-scheduled').textContent = `(${directoryList('scheduled').length})`;
  $('count-unscheduled').textContent = `(${directoryList('unscheduled').length})`;
}

/** Hash -> view name: "today", "week", "scheduled", "unscheduled" or "info/<site>". */
function viewFor(hash) {
  if (hash === 'sprints') return 'scheduled'; // links from before the tabs were split
  if (['today', 'week', 'scheduled', 'unscheduled', 'rooms'].includes(hash)) return hash;
  const info = hash.match(/^info\/([\w-]+)$/);
  return info && state.data.site_info.some(p => p.slug === info[1]) ? hash : null;
}

function route() {
  const hash = location.hash.slice(1);
  const m = hash.match(/^sprint\/(\d+)$/);
  if (m) {
    openSprint(Number(m[1]));
    return;
  }
  if ($('sprint-dialog').open) $('sprint-dialog').close();
  const view = viewFor(hash) || state.view;
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

/** Make `data` (from data/sprints.json) the current schedule. */
function useData(data) {
  state.data = data;
  state.config = data.config;
  state.config.program = state.config.program || [];
  state.data.site_info = state.data.site_info || [];
  state.sprints = data.sprints;
  state.byNumber = new Map(state.sprints.map(sp => [sp.number, sp]));
  state.programById = new Map(state.config.program.map(p => [p.id, p]));
}

function renderFooter() {
  const { config } = state;
  const updated = new Date(state.data.generated_at);
  $('footer').replaceChildren(
    'Generated from the ', h('a', { href: `${config.repo_url}/issues`, target: '_blank', rel: 'noopener', text: 'GitHub issues' }),
    ` of ${config.repo} · updated ${updated.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · `,
    h('a', { href: config.new_sprint_url, target: '_blank', rel: 'noopener', text: 'Propose a sprint' }));
}

/**
 * Pages left open (a laptop, a screen in a room) pick up new sprints and sessions on their
 * own: every 2 minutes, while the tab is visible, compare the tiny data/version.json with
 * the build being shown, and reload the schedule in place if it changed.
 */
function keepFresh() {
  const check = async () => {
    if (document.visibilityState !== 'visible') return;
    const latest = await latestBuild();
    if (!latest || latest === state.data.generated_at) return;
    try {
      useData(await loadData());
    } catch {
      return;
    }
    render(); // keeps the view, the day shown, the time zone, the search and the filters
    renderFooter();
  };
  setInterval(check, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', check); // e.g. back to a laptop after lunch
}

async function main() {
  setupThemeToggle(document.getElementById('theme-toggle'));
  try {
    state.data = await loadData();
  } catch (err) {
    $('notice').hidden = false;
    $('notice').textContent = `Could not load the schedule: ${err.message}`;
    return;
  }
  useData(state.data);
  const { config } = state;
  state.zone = initialZone(config);
  state.roomsSite = recall('rooms-site');

  document.title = `${config.title} · Calendar`;
  if (config.notice) {
    $('banner').replaceChildren(markdown(config.notice, config, 'md'));
    $('banner').hidden = false;
  }
  $('event-title').textContent = config.title;
  const sites = config.sites.map(s => s.name).join(' · ');
  $('event-dates').textContent = `${fmtDay(config.start_date)} – ${fmtDay(config.end_date)}${sites ? ` · ${sites} · online` : ''}`;
  $('new-sprint').href = config.new_sprint_url;
  if (config.registration_url) {
    $('new-sprint').before(h('a', { class: 'btn', href: config.registration_url, target: '_blank', rel: 'noopener' }, 'Register'));
  }

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
  renderFooter();
  keepFresh();

  narrow.addEventListener('change', () => { state.viewChanged = true; render(); });
  window.addEventListener('hashchange', route);
  for (const p of state.data.site_info) {
    $('tabs').append(h('a', { href: `#info/${p.slug}`, 'data-view': `info/${p.slug}` }, `${p.site} info`));
  }
  const start = narrow.matches ? 'today' : 'week'; // a whole week is a long list on a phone
  state.view = viewFor(location.hash.slice(1)) || start;
  if (location.hash.startsWith('#sprint/')) {
    state.view = start;
    render();
  }
  route();
}

main();
