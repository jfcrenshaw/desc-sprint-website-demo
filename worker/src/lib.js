// Pure helpers for the scheduling bot: no network access, so they are easy to test
// (`node --test` in worker/). The session comment format must stay identical to
// sprintweek/sessions.py, which reads it back when building the website.

export const SESSION_MARKER = 'sprintweek:session';
export const CANCELLED_MARKER = 'sprintweek:cancelled';
const DATA_RE = /<!--\s*sprintweek:session\s*(\{[\s\S]*?\})\s*-->/;
const HANDLE_RE = /(?<![\w.@/`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g;
export const LIMITS = { location: 200, online: 500, label: 80, note: 300 };
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

// ---------------------------------------------------------------- text

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** One line of plain text: no control characters, collapsed whitespace, length-limited. */
export function cleanText(value, limit) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** Escape Markdown and defang @mentions in user text placed in a GitHub comment. */
export function mdEscape(text) {
  return String(text).replace(/([\\`*_{}[\]<>()#+!|~])/g, '\\$1').replace(/@/g, '@\u200b');
}

export const isLogin = s => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s || '');

/** GitHub handles listed in the "Contact person(s)" section (or an old-style "Contacts:" line). */
export function contactHandles(body) {
  const out = new Set();
  let inSection = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /^contact/i.test(heading[1].trim());
      continue;
    }
    const legacy = line.match(/^[\s*_]*contacts?[\s*_]*:(.*)$/i);
    const text = inSection ? line : legacy ? legacy[1] : null;
    if (text) for (const m of text.replace(/`/g, '').matchAll(HANDLE_RE)) out.add(m[1].toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------- time zones

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz === 'UTC' || tz.includes('/');
  } catch {
    return false;
  }
}

function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour % 24 === 0 ? '00' : p.hour}:${p.minute}`,
  };
}

const offsetMinutes = (date, tz) => {
  const p = parts(date, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 60000);
};

/** The instant at which the wall clock in `tz` shows `date` (YYYY-MM-DD) `time` (HH:MM). */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMinutes(new Date(guess), tz);
  const second = offsetMinutes(new Date(guess - first * 60000), tz);
  return new Date(guess - second * 60000);
}

/** "CET", "PDT", "UTC"... Browsers and Workers only know some abbreviations, so sites can supply theirs. */
export function tzAbbr(date, tz, sites = []) {
  if (tz === 'UTC') return 'UTC';
  for (const locale of ['en-US', 'en-GB']) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date).find(p => p.type === 'timeZoneName')?.value;
    if (name && !/^(GMT|UTC)[+-]/.test(name)) return name;
  }
  const site = sites.find(s => s.timezone === tz);
  return site?.abbr || new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || tz;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Tuesday, October 27 · 14:00–16:00 CET" plus conversions to the other sites' zones. */
export function describeTimes(session, sites = []) {
  const start = zonedToUtc(session.date, session.start, session.tz);
  const end = zonedToUtc(session.date, session.end, session.tz);
  const s = parts(start, session.tz);
  const when = `${s.weekday}, ${MONTHS[s.month - 1]} ${s.day} · ${session.start}–${session.end} ${tzAbbr(start, session.tz, sites)}`;
  const also = sites.filter(x => x.timezone !== session.tz).map(x => {
    const a = parts(start, x.timezone);
    const b = parts(end, x.timezone);
    const day = a.date !== s.date ? `, ${a.weekday.slice(0, 3)}` : '';
    return `${a.time}–${b.time} ${tzAbbr(start, x.timezone, sites)} (${x.name}${day})`;
  });
  return { when, also, start, end };
}

// ---------------------------------------------------------------- rooms

const normName = s => String(s || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');

/** A site's rooms as objects (configs published before room availability used plain names). */
export function siteRooms(site) {
  return (site?.rooms || []).map(r => (typeof r === 'string' ? { name: r, available: null, summary: 'all week' } : r));
}

const fits = (s, w) => w.date === s.date && (!w.start || (w.start <= s.start && s.end <= w.end));

/**
 * Why a session's room is unavailable, or '' if it is fine. Mirrors room_problem in
 * sprintweek/rooms.py: only configured rooms of the session's site are checked.
 */
export function roomProblem(session, sites) {
  const site = (sites || []).find(x => x.name === session.site);
  const wanted = normName(session.location);
  if (!site || !wanted) return '';
  const room = siteRooms(site).find(r => normName(r.name) === wanted);
  if (!room || !room.available || room.available.some(w => fits(session, w))) return '';
  const d = new Date(`${session.date}T12:00:00Z`);
  const part = opt => new Intl.DateTimeFormat('en-US', { ...opt, timeZone: 'UTC' }).format(d);
  return `${room.name} is not available on ${part({ weekday: 'short' })} ${part({ month: 'short' })} ${d.getUTCDate()} at ${session.start}–${session.end} (available: ${room.summary}).`;
}

/**
 * Sessions already booked in rooms, from the website's data/sprints.json, for the form's
 * "already in this room" hint. Dates and times are in each site's local time.
 */
export function roomBookings(data, sites, exceptId = '') {
  const out = [];
  for (const sp of data?.sprints || []) {
    for (const s of sp.sessions || []) {
      const site = sites.find(x => x.name === s.site);
      if (!site || !s.location || String(s.id) === String(exceptId)) continue;
      const a = parts(new Date(s.start_utc), site.timezone);
      const b = parts(new Date(s.end_utc), site.timezone);
      out.push({
        site: site.name, room: normName(s.location), date: a.date, start: a.time, end: b.time,
        start_utc: s.start_utc, end_utc: s.end_utc, title: s.label ? `${sp.title} — ${s.label}` : sp.title,
      });
    }
  }
  return out.sort((x, y) => x.start_utc.localeCompare(y.start_utc));
}

// ---------------------------------------------------------------- sessions

/**
 * Validate the scheduling form.
 * @param {Record<string,string>} form  Submitted fields: date, start, end, where (site name or "online"), tz, location, online, label, note.
 * @param {object} config  Published website configuration (data/config.json).
 * @param {string[]} extraDays  Dates accepted besides the Sprint Week (e.g. the current date of an edited session).
 * @returns {{session: object|null, errors: Record<string,string>}}
 */
export function validateSession(form, config, extraDays = []) {
  const errors = {};
  const date = String(form.date || '');
  if (![...config.days, ...extraDays].includes(date)) errors.date = 'Pick one of the Sprint Week days.';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  // The form sends hour and minute dropdowns (start_h, start_m); "start" itself is also accepted.
  const hm = which => String(form[which] || (form[`${which}_h`] && form[`${which}_m`] ? `${form[`${which}_h`]}:${form[`${which}_m`]}` : '')).slice(0, 5);
  const start = hm('start');
  const end = hm('end');
  if (!time.test(start)) errors.start = 'Enter a start time.';
  if (!time.test(end)) errors.end = 'Enter an end time.';
  if (!errors.start && !errors.end && end <= start) errors.end = 'The session must end after it starts.';

  const where = String(form.where || '');
  const site = config.sites.find(s => s.name === where);
  if (!site && where !== 'online') errors.where = 'Choose where the session happens.';
  const tz = String(form.tz || site?.timezone || '');
  if (!isTimeZone(tz)) errors.tz = 'Choose a time zone.';

  const online = cleanText(form.online, LIMITS.online);
  if (online && !/^https:\/\/[^\s<>"'\\]+$/.test(online)) errors.online = 'The link must start with https://';
  if (where === 'online' && !online) errors.online = 'Add the meeting link for an online-only session.';

  const session = {
    date, start, end, tz,
    site: site ? site.name : '',
    location: site ? cleanText(form.location, LIMITS.location) : '',
    online,
    label: cleanText(form.label, LIMITS.label),
    note: cleanText(form.note, LIMITS.note),
  };
  if (!Object.keys(errors).length) {
    const problem = roomProblem(session, config.sites);
    if (problem) errors.location = `${problem} Please choose another room or time.`;
  }
  return { session: Object.keys(errors).length ? null : session, errors };
}

const FIELDS = ['date', 'start', 'end', 'tz', 'site', 'location', 'online', 'label', 'note', 'by'];

/** The hidden data line. Matches `encode_session_data` in sprintweek/sessions.py byte for byte. */
export function encodeSessionData(session, marker = SESSION_MARKER) {
  const payload = { v: 1 };
  for (const k of FIELDS) payload[k] = session[k] ?? '';
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!-- ${marker} ${json} -->`;
}

/** Session data from a comment body, or null if there is none (or it is not valid JSON). */
export function extractSessionData(body) {
  const m = DATA_RE.exec(body || '');
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

const profile = login => `[${login}](https://github.com/${login})`;

/** The comment the bot posts for a session (layout mirrors render_session_comment in Python). */
export function renderSessionComment(session, { sites = [], editUrl = '', updatedBy = '' } = {}) {
  const { when, also } = describeTimes(session, sites);
  const lines = [
    encodeSessionData(session),
    `📅 **Session scheduled${session.label ? `: ${mdEscape(session.label)}` : ''}**`,
    '',
    `**When:** ${when}`,
  ];
  if (also.length) lines.push(`<sub>= ${also.join(' · ')}</sub>`);
  const where = [];
  const place = [session.site, session.location].filter(Boolean).map(mdEscape);
  if (place.length) where.push(`📍 ${place.join(' – ')}`);
  if (session.online) where.push(`💻 [Join online](${session.online})`);
  lines.push(`**Where:** ${where.length ? where.join(' · ') : 'to be announced'}`);
  if (session.note) lines.push(`**Note:** ${mdEscape(session.note)}`);
  const footer = [];
  if (isLogin(session.by)) footer.push(`Scheduled by ${profile(session.by)}`);
  if (isLogin(updatedBy) && updatedBy !== session.by) footer.push(`updated by ${profile(updatedBy)}`);
  if (editUrl) footer.push(`[✏️ Edit or cancel this session](${editUrl})`);
  if (footer.length) lines.push('', `<sub>${footer.join(' · ')}</sub>`);
  return `${lines.join('\n')}\n`;
}

/** What a session comment becomes when it is cancelled: kept for the record, ignored by the calendar. */
export function renderCancelledComment(session, { sites = [], by = '' } = {}) {
  const { when } = describeTimes(session, sites);
  return [
    encodeSessionData(session, CANCELLED_MARKER),
    `❌ **Session cancelled${session.label ? `: ${mdEscape(session.label)}` : ''}** ~~${when}~~`,
    '',
    `<sub>Cancelled${isLogin(by) ? ` by ${profile(by)}` : ''}.</sub>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- signed values (cookies)

const encoder = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmac(secret, text) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(text)));
}

/** Sign a JSON value with an expiry (seconds from now). */
export async function sign(secret, value, ttlSeconds) {
  const body = b64url(encoder.encode(JSON.stringify({ v: value, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${await hmac(secret, body)}`;
}

/** Verify a value from `sign`; returns the value, or null if tampered with or expired. */
export async function verify(secret, token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(mac), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const { v, exp } = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return exp > Date.now() / 1000 ? v : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------- GitHub App key

function derLength(n) {
  if (n < 128) return [n];
  const bytes = [];
  for (; n > 0; n >>= 8) bytes.unshift(n & 255);
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 RSA key ("BEGIN RSA PRIVATE KEY", what GitHub downloads) as PKCS#8 for WebCrypto. */
export function pkcs1ToPkcs8(pkcs1) {
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [0x02, 0x01, 0x00, ...rsaAlgorithm, ...octets];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

export async function importPrivateKey(pem) {
  const text = String(pem).replace(/\\n/g, '\n');
  const b64 = text.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  let der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (text.includes('BEGIN RSA PRIVATE KEY')) der = pkcs1ToPkcs8(der);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** A JSON Web Token identifying the GitHub App (valid for 9 minutes). */
export async function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const part = obj => b64url(encoder.encode(JSON.stringify(obj)));
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}
