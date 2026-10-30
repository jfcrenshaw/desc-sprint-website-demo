// Presentation mode: full-screen slides for the morning pitches and the closing wrap-ups.
import {
  h, setupThemeToggle, loadData, remember, zoneOptions, initialZone, wall, todayIn, fmtDay, sessionTimes, sessionTitle,
  sessionPlace, typeColor, chip, contactList, markdown,
} from './common.js';

const $ = id => document.getElementById(id);
const state = { config: null, sprints: [], slides: [], index: 0 };

function settings() {
  const form = new FormData($('setup-form'));
  const zone = zoneOptions(state.config).find(o => o.id === form.get('tz'));
  return { mode: form.get('mode'), day: form.get('day'), zone, unscheduled: form.get('unscheduled') === 'on' };
}

const firstOnDay = (sp, day, tz) => sp.sessions.find(s => day === 'all' || wall(s.start_utc, tz).date === day);

function buildSlides() {
  const { mode, day, zone, unscheduled } = settings();
  const tz = zone.tz;
  const byStart = (a, b) => firstOnDay(a, day, tz).start_utc.localeCompare(firstOnDay(b, day, tz).start_utc);
  let sprints, wrapups = [];
  if (mode === 'pitch') {
    sprints = state.sprints.filter(sp => firstOnDay(sp, day, tz)).sort(byStart);
    if (unscheduled) sprints = sprints.concat(state.sprints.filter(sp => !sp.sessions.length));
  } else {
    // One slide per wrap-up dated that day: sprints in the order their first wrap-up was
    // posted, and each sprint's wrap-ups oldest first.
    wrapups = state.sprints.flatMap(sp => sp.wrapups.filter(w => day === 'all' || w.date === day).map(w => ({ sp, w })))
      .sort((a, b) => a.w.created_at.localeCompare(b.w.created_at));
    const rank = new Map();
    for (const { sp } of wrapups) if (!rank.has(sp.number)) rank.set(sp.number, rank.size);
    wrapups.sort((a, b) => rank.get(a.sp.number) - rank.get(b.sp.number));
    sprints = [...rank.keys()].map(n => state.sprints.find(sp => sp.number === n));
  }
  const slides = [{ kind: 'title', mode, day, count: sprints.length, wrapups: wrapups.length }];
  if (mode === 'pitch' && day !== 'all') {
    const rows = sprints.flatMap(sp => sp.sessions.filter(s => wall(s.start_utc, tz).date === day).map(s => ({ sp, s })))
      .sort((a, b) => a.s.start_utc.localeCompare(b.s.start_utc));
    for (let i = 0; i < rows.length; i += 12) slides.push({ kind: 'agenda', rows: rows.slice(i, i + 12), day });
  }
  if (mode === 'pitch') {
    for (const sp of sprints) slides.push({ kind: 'pitch', sp });
  } else {
    for (const { sp, w } of wrapups) {
      const own = wrapups.filter(x => x.sp === sp);
      slides.push({ kind: 'wrapup', sp, w, part: own.indexOf(own.find(x => x.w === w)) + 1, parts: own.length });
    }
  }
  slides.push({ kind: 'end', mode });
  state.slides = slides;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('slide-count').textContent = mode === 'pitch'
    ? `${plural(sprints.length, 'sprint')}, ${plural(slides.length, 'slide')}`
    : `${plural(wrapups.length, 'wrap-up')} from ${plural(sprints.length, 'sprint')}, ${plural(slides.length, 'slide')}`;
  $('setup-list').replaceChildren(...(mode === 'pitch'
    ? sprints.map(sp => h('li', { text: sp.title }))
    : wrapups.map(({ sp, w }) => h('li', { text: `${sp.title} (by @${w.author})` }))));
  $('unscheduled-row').hidden = mode !== 'pitch';
  return slides;
}

// ---------------------------------------------------------------- slides

function times(s) {
  const { zone } = settings();
  const main = sessionTimes(s, zone.tz, state.config);
  const others = state.config.sites.filter(x => x.timezone !== zone.tz)
    .map(x => sessionTimes(s, x.timezone, state.config).text);
  return { main, others };
}

const siteUrl = () => (state.config.site_url || new URL('./', location.href).href).replace(/^https?:\/\//, '').replace(/\/$/, '');

function titleSlide({ mode, day, count, wrapups }) {
  const what = mode === 'pitch' ? 'Sprint pitches' : 'Sprint wrap-ups';
  const when = day === 'all' ? `${fmtDay(state.config.start_date)} – ${fmtDay(state.config.end_date)}` : fmtDay(day, 'long');
  return h('div', { class: 'slide title-slide' },
    h('p', { class: 'kicker', text: state.config.title }),
    h('h1', { text: what }),
    h('p', { class: 'big', text: when }),
    h('p', { class: 'muted', text: mode === 'pitch' ? `${count} sprint${count === 1 ? '' : 's'}` : `${wrapups} wrap-up${wrapups === 1 ? '' : 's'} from ${count} sprint${count === 1 ? '' : 's'}` }),
    h('p', { class: 'url' }, 'Schedule, rooms and Zoom links: ', h('strong', { text: siteUrl() })));
}

function agendaSlide({ rows, day }) {
  return h('div', { class: 'slide agenda-slide' },
    h('h1', { text: `Today's sessions · ${fmtDay(day)}` }),
    h('table', { class: 'agenda' }, h('tbody', {}, rows.map(({ sp, s }) =>
      h('tr', {},
        h('td', { class: 'agenda-time', text: times(s).main.text }),
        h('td', {}, h('span', { class: 'swatch', style: `background:${typeColor(sp, state.config)}` }), sessionTitle(sp, s)),
        h('td', { class: 'muted', text: sessionPlace(s) }))))));
}

function sprintHead(sp) {
  return [
    h('div', { class: 'slide-head' },
      h('span', { class: 'type', text: sp.type || 'Sprint' }),
      h('span', { class: 'chips' }, sp.tags.filter(t => t.kind === 'group').map(chip)),
      sp.new_contributor_friendly ? h('span', { class: 'badge good', text: 'New contributor friendly' }) : null),
    h('h1', { text: sp.title }),
    h('p', { class: 'people' }, '👤 ', contactList(sp)),
  ];
}

function sprintFoot(sp) {
  return h('footer', { class: 'slide-foot' },
    h('span', { text: `${siteUrl()}/#sprint/${sp.number}` }),
    h('span', { text: `GitHub issue #${sp.number}` }));
}

function pitchSlide({ sp }) {
  const { day } = settings();
  const shown = sp.sessions.filter(s => day === 'all' || wall(s.start_utc, settings().zone.tz).date === day);
  const later = sp.sessions.length - shown.length;
  return h('div', { class: 'slide sprint-slide', style: `--sprint:${typeColor(sp, state.config)}` },
    sprintHead(sp),
    h('div', { class: 'slide-body fit' },
      markdown(sp.pitch, state.config, 'md lead'),
      sp.goals ? h('div', { class: 'goals' }, h('h2', { text: 'Goals' }), markdown(sp.goals, state.config)) : null),
    h('div', { class: 'slide-sessions' },
      shown.length ? shown.map(s => {
        const t = times(s);
        return h('div', { class: 'slide-session' },
          h('strong', { text: `${fmtDay(t.main.day)} ${t.main.text}` }),
          t.others.length ? h('span', { class: 'muted', text: ` (${t.others.join(' · ')})` }) : null,
          h('span', { text: ` · ${s.label ? `${s.label}: ` : ''}${sessionPlace(s)}` }));
      }) : h('div', { class: 'slide-session unscheduled', text: 'Not scheduled yet: talk to the contacts if you are interested!' }),
      later > 0 ? h('div', { class: 'muted', text: `+ ${later} more session${later > 1 ? 's' : ''} during the week` }) : null),
    sprintFoot(sp));
}

function wrapupSlide({ sp, w, part, parts }) {
  const posted = new Date(w.created_at).toLocaleString('en-US', { timeZone: settings().zone.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return h('div', { class: 'slide sprint-slide', style: `--sprint:${typeColor(sp, state.config)}` },
    sprintHead(sp),
    h('p', { class: 'wrapup-by' }, `📝 Wrap-up by @${w.author} · posted ${posted}`, parts > 1 ? ` · ${part} of ${parts}` : ''),
    h('div', { class: 'slide-body fit' }, markdown(w.text, state.config, 'md wrapup-md')),
    sprintFoot(sp));
}

function endSlide({ mode }) {
  return h('div', { class: 'slide title-slide' },
    h('h1', { text: mode === 'pitch' ? 'Happy sprinting! 🚀' : 'Thank you! 🎉' }),
    h('p', { class: 'big' }, 'Everything is on ', h('strong', { text: siteUrl() })),
    h('p', { class: 'muted', text: mode === 'pitch'
      ? 'Join a sprint by commenting on its GitHub issue. Add sessions from the issue page.'
      : 'Add your wrap-up to your sprint’s GitHub issue so it is part of the record.' }));
}

const RENDER = { title: titleSlide, agenda: agendaSlide, pitch: pitchSlide, wrapup: wrapupSlide, end: endSlide };

/** Shrink text until the slide body fits (long wrap-ups, big images). */
function fit(slide) {
  const body = slide.querySelector('.fit');
  if (!body) return;
  let scale = 1;
  slide.style.setProperty('--scale', scale);
  while (body.scrollHeight > body.clientHeight + 2 && scale > 0.4) {
    scale = Math.round((scale - 0.05) * 100) / 100;
    slide.style.setProperty('--scale', scale);
  }
}

function show(i) {
  state.index = Math.max(0, Math.min(i, state.slides.length - 1));
  const spec = state.slides[state.index];
  const slide = RENDER[spec.kind](spec);
  $('slide').replaceChildren(slide);
  $('counter').textContent = `${state.index + 1} / ${state.slides.length}`;
  history.replaceState(null, '', `${location.pathname}${location.search}#${state.index + 1}`);
  requestAnimationFrame(() => fit(slide));
  for (const img of slide.querySelectorAll('img')) img.addEventListener('load', () => fit(slide), { once: true });
}

function start() {
  const resume = Number(location.hash.slice(1)) - 1 || 0;
  buildSlides();
  const s = settings();
  remember('tz', s.zone.id);
  const params = new URLSearchParams({ mode: s.mode, day: s.day, tz: s.zone.id, unscheduled: s.unscheduled ? '1' : '0' });
  history.replaceState(null, '', `?${params}`);
  $('setup').hidden = true;
  $('deck').hidden = false;
  show(resume);
}

function exit() {
  if (document.fullscreenElement) document.exitFullscreen();
  $('deck').hidden = true;
  $('setup').hidden = false;
  history.replaceState(null, '', location.pathname + location.search);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

async function main() {
  setupThemeToggle(document.getElementById('theme-toggle'));
  const data = await loadData();
  state.config = data.config;
  state.sprints = data.sprints;
  document.title = `${state.config.title} · Presenter`;
  $('setup-title').textContent = `Present: ${state.config.title}`;

  const params = new URLSearchParams(location.search);
  const daySel = $('day');
  for (const d of state.config.days) daySel.append(h('option', { value: d, text: fmtDay(d, 'long') }));
  daySel.append(h('option', { value: 'all', text: 'Whole week' }));
  const zone = initialZone(state.config);
  const tzSel = $('tz');
  for (const o of zoneOptions(state.config)) tzSel.append(h('option', { value: o.id, text: o.label }));
  tzSel.value = zone.id;
  const today = todayIn(zone.tz);
  daySel.value = params.get('day') || (state.config.days.includes(today) ? today : state.config.days[0]);
  if (params.get('mode')) $('setup-form').mode.value = params.get('mode');
  if (params.get('unscheduled') === '0') $('setup-form').unscheduled.checked = false;

  $('setup-form').addEventListener('change', e => {
    buildSlides();
  });
  $('setup-form').addEventListener('submit', e => { e.preventDefault(); start(); });
  $('prev').addEventListener('click', () => show(state.index - 1));
  $('next').addEventListener('click', () => show(state.index + 1));
  $('full').addEventListener('click', toggleFullscreen);
  $('exit').addEventListener('click', exit);
  $('slide').addEventListener('click', e => {
    if (e.target.closest('a')) return;
    show(state.index + (e.clientX > window.innerWidth / 3 ? 1 : -1));
  });
  document.addEventListener('keydown', e => {
    if ($('deck').hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    if (['ArrowRight', 'PageDown', ' ', 'Enter', 'n'].includes(e.key)) { e.preventDefault(); show(state.index + 1); }
    else if (['ArrowLeft', 'PageUp', 'Backspace', 'p'].includes(e.key)) { e.preventDefault(); show(state.index - 1); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(state.slides.length - 1);
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'Escape' && !document.fullscreenElement) exit();
  });
  window.addEventListener('resize', () => { const s = $('slide').firstElementChild; if (s) fit(s); });

  buildSlides();
  if (params.get('mode') && location.hash) start();
}

main();
