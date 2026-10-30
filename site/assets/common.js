// Shared helpers for the calendar (app.js) and presentation (present.js) pages.
// Everything shown on the page comes from GitHub issues, i.e. from people on the
// internet: plain text always goes through textContent, Markdown through DOMPurify.

/** Create an element. `attrs` may contain class, text, html (sanitized only!), on* handlers, data-*. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function loadData() {
  const res = await fetch('data/sprints.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load data/sprints.json (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------- storage

export function remember(key, value) {
  try { localStorage.setItem(`sprintweek:${key}`, value); } catch { /* private mode */ }
}
export function recall(key) {
  try { return localStorage.getItem(`sprintweek:${key}`); } catch { return null; }
}

// ---------------------------------------------------------------- time zones

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Time-zone choices: the viewer's own clock, every site, and UTC. */
export function zoneOptions(config) {
  const opts = [{ id: 'local', tz: LOCAL_TZ, label: `My time (${LOCAL_TZ.replace(/_/g, ' ')})` }];
  for (const s of config.sites) opts.push({ id: s.name, tz: s.timezone, label: `${s.name} time (${s.abbr})` });
  opts.push({ id: 'UTC', tz: 'UTC', label: 'UTC' });
  return opts;
}

/** The zone the viewer chose last time, else the configured default. */
export function initialZone(config) {
  const opts = zoneOptions(config);
  const wanted = new URLSearchParams(location.search).get('tz') || recall('tz') || config.default_timezone || 'local';
  return opts.find(o => o.id === wanted || o.tz === wanted) || opts[0];
}

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return partsCache.get(tz);
}

/** Wall-clock date and time of a UTC instant in `tz`: {date: 'YYYY-MM-DD', time: 'HH:MM', iso}. */
export function wall(utcIso, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(utcIso)).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, iso: `${date}T${time}:00` };
}

/** Short name of `tz` at an instant: site abbreviations first ("CET"), else what the browser offers. */
export function tzAbbr(tz, utcIso, config) {
  if (tz === 'UTC') return 'UTC';
  const site = config.sites.find(s => s.timezone === tz);
  if (site) {
    // The configured abbreviation is for the start of the event; recompute if the offset differs.
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(utcIso)).find(p => p.type === 'timeZoneName')?.value;
    return name && !name.startsWith('GMT') ? name : site.abbr;
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(utcIso)).find(p => p.type === 'timeZoneName')?.value || tz;
}

/** UTC offset of `tz` right now as "+HH:MM", for EventCalendar's timeZone option. */
export function currentOffset(tz) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] || '00'}` : '+00:00';
}

export const todayIn = tz => wall(new Date().toISOString(), tz).date;

/** "Tue, Oct 27" for a YYYY-MM-DD date. */
export function fmtDay(date, style = 'short') {
  const opts = style === 'long'
    ? { weekday: 'long', month: 'long', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

/** Start/end of a session in `tz`: {day, start, end, abbr, text: "14:00–16:00 CET"}. */
export function sessionTimes(session, tz, config) {
  const s = wall(session.start_utc, tz);
  const e = wall(session.end_utc, tz);
  const abbr = tzAbbr(tz, session.start_utc, config);
  const end = e.date === s.date ? e.time : `${e.time} (+1)`;
  return { day: s.date, start: s.time, end: e.time, abbr, text: `${s.time}–${end} ${abbr}` };
}

// ---------------------------------------------------------------- sprints

export const sessionTitle = (sprint, session) => session.label ? `${sprint.title} — ${session.label}` : sprint.title;

export function sessionPlace(session) {
  const place = [session.site, session.location].filter(Boolean).join(' – ');
  if (place && session.online) return `${place} + online`;
  if (session.online) return 'Online';
  return place || 'Location to be announced';
}

export function typeColor(sprint, config) {
  return config.type_colors[sprint.type] || sprint.tags.find(t => t.kind === 'type')?.color || '#5c6773';
}

/** Black or white text, whichever reads better on `hex`. */
export function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1b1f24' : '#fff';
}

export function chip(tag) {
  const el = h('span', { class: 'chip', text: tag.name });
  if (tag.color) {
    el.style.setProperty('--chip', tag.color);
    el.classList.add('colored');
  }
  return el;
}

/** Contacts as profile links (or plain names). */
export function contactList(sprint) {
  const out = [];
  sprint.contacts.forEach((c, i) => {
    if (i) out.push(', ');
    if (c.login) {
      out.push(h('a', { href: `https://github.com/${encodeURIComponent(c.login)}`, target: '_blank', rel: 'noopener' }, c.name ? `${c.name} (@${c.login})` : `@${c.login}`));
    } else {
      out.push(c.name);
    }
  });
  return out;
}

export function scheduleUrl(config, sprint) {
  return config.scheduler_url ? `${config.scheduler_url}/schedule?sprint=${sprint.number}` : '';
}

export function editSessionUrl(config, session) {
  return config.scheduler_url ? `${config.scheduler_url}/session/${encodeURIComponent(session.id)}` : '';
}

/** Lowercased text used by the search box. */
export function searchText(sprint) {
  if (!sprint._search) {
    sprint._search = [
      sprint.title, sprint.pitch, sprint.contacts_md, sprint.author, sprint.type, sprint.goals,
      ...sprint.tags.map(t => t.name),
      ...sprint.contacts.map(c => `${c.login || ''} ${c.name || ''}`),
      ...sprint.sessions.map(s => `${s.label} ${s.site} ${s.location} ${s.note}`),
      `#${sprint.number}`,
    ].join(' ').toLowerCase();
  }
  return sprint._search;
}

// ---------------------------------------------------------------- markdown

const FORBID_TAGS = ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'svg', 'math'];

/**
 * Render untrusted GitHub-flavored Markdown into a sanitized <div>.
 * Links open in a new tab, @mentions and #123 become GitHub links, task-list boxes are inert.
 */
export function markdown(md, config, className = 'md', base = '') {
  const div = h('div', { class: className });
  if (!md) return div;
  const html = window.marked.parse(md, { gfm: true, breaks: true, async: false });
  div.innerHTML = window.DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR: ['style', 'class', 'id'],
    ALLOW_DATA_ATTR: false,
  });
  if (base) {
    // Relative links and images (e.g. "slac-map.png" next to site-info/slac.md) resolve from `base`.
    const relative = u => u && !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(u);
    for (const el of div.querySelectorAll('a[href], img[src]')) {
      const attr = el.tagName === 'A' ? 'href' : 'src';
      if (relative(el.getAttribute(attr))) el.setAttribute(attr, base + el.getAttribute(attr));
    }
  }
  for (const a of div.querySelectorAll('a[href]')) {
    if (a.getAttribute('href').startsWith('#')) continue;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
  }
  for (const img of div.querySelectorAll('img')) {
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
  }
  for (const input of div.querySelectorAll('input')) {
    if (input.type === 'checkbox') input.disabled = true;
    else input.remove();
  }
  linkify(div, config);
  return div;
}

/** Turn "@login" and "#12" in text nodes into links, like GitHub does. */
function linkify(root, config) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = /(^|[^\w@/.`])(@([A-Za-z0-9][A-Za-z0-9-]{0,38})|#(\d{1,6}))\b/g;
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index + m[1].length;
      frag.append(text.slice(last, start));
      const href = m[3] ? `https://github.com/${m[3]}` : `${config.repo_url}/issues/${m[4]}`;
      frag.append(h('a', { href, target: '_blank', rel: 'noopener' }, m[2]));
      last = start + m[2].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Short plain-text preview of Markdown (for cards). */
export function preview(md, limit = 220) {
  const tpl = document.createElement('template'); // inert: images inside are not fetched
  tpl.innerHTML = window.DOMPurify.sanitize(window.marked.parse(md || '', { async: false }));
  let text = tpl.content.textContent.replace(/\s+/g, ' ').trim();
  if (text.length > limit) text = `${text.slice(0, limit).replace(/\s\S*$/, '')}…`;
  return text;
}
