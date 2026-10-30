// Sprint Week scheduling bot (Cloudflare Worker).
//
//   GET  /schedule?sprint=N   form for a new session        POST: create it
//   GET  /session/<comment>   form for an existing session  POST: save or cancel it
//   GET  /login, /callback, /logout                         "Sign in with GitHub"
//
// People sign in with GitHub only so we know who they are; their GitHub token is
// discarded immediately. All writes are made by the GitHub App ("the bot"), which is
// installed on the sprint repository with Issues: read & write.
//
// Configuration (wrangler.toml [vars]): REPO, SITE_URL.
// Secrets (`npx wrangler secret put NAME`): GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
// GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET.

import {
  esc, contactHandles, validateSession, extractSessionData, renderSessionComment, renderCancelledComment,
  describeTimes, sign, verify, hmac, parseCookies, randomToken, b64url, importPrivateKey, appJwt, isLogin,
  TRUSTED_ASSOCIATIONS, CANCELLED_MARKER,
} from './lib.js';

const SESSION_COOKIE = '__Host-sw_session';
const OAUTH_COOKIE = '__Host-sw_oauth';
const SESSION_TTL = 8 * 3600;

class HttpError extends Error {
  constructor(status, title, message) {
    super(message);
    this.status = status;
    this.title = title;
  }
}

// ---------------------------------------------------------------- GitHub API

async function github(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sprintweek-scheduler',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function githubJson(path, token, opts) {
  const res = await github(path, token, opts);
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'GitHub error', `GitHub answered ${res.status} for ${path}.`);
  return res.json();
}

let appCache = null; // per isolate: { token, expires, slug }

/** Short-lived installation token for the sprint repository, plus the bot's login. */
async function app(env) {
  if (appCache && appCache.expires > Date.now() + 5 * 60 * 1000) return appCache;
  const jwt = await appJwt(env.GITHUB_APP_ID, await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY));
  const [meta, installation] = await Promise.all([githubJson('/app', jwt), githubJson(`/repos/${env.REPO}/installation`, jwt)]);
  const tok = await githubJson(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST',
    body: { repositories: [env.REPO.split('/')[1]] },
  });
  appCache = { token: tok.token, expires: Date.parse(tok.expires_at), login: `${meta.slug}[bot]` };
  return appCache;
}

let configCache = null;

/** The website's published configuration (days, sites, rooms, organization). */
async function siteConfig(env) {
  if (configCache && configCache.expires > Date.now()) return configCache.data;
  const res = await fetch(new URL('data/config.json', env.SITE_URL), { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new HttpError(502, 'Calendar unavailable', 'Could not load the calendar configuration.');
  configCache = { data: await res.json(), expires: Date.now() + 60 * 1000 };
  return configCache.data;
}

async function getSprint(env, token, number) {
  const res = await github(`/repos/${env.REPO}/issues/${number}`, token);
  if (res.status === 404) throw new HttpError(404, 'Sprint not found', `There is no issue #${number} in ${env.REPO}.`);
  if (!res.ok) throw new HttpError(502, 'GitHub error', `GitHub answered ${res.status}.`);
  const issue = await res.json();
  if (issue.pull_request) throw new HttpError(404, 'Sprint not found', `#${number} is a pull request.`);
  return issue;
}

async function isCollaborator(env, token, login) {
  const res = await github(`/repos/${env.REPO}/collaborators/${encodeURIComponent(login)}/permission`, token);
  if (!res.ok) return false;
  const { permission } = await res.json();
  return ['admin', 'maintain', 'write'].includes(permission);
}

async function isOrgMember(token, org, login) {
  if (!org) return false;
  const res = await github(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`, token);
  return res.status === 204;
}

/**
 * May `login` change this sprint's sessions? Its author, assignees, @mentioned contacts,
 * the session's creator and repository collaborators may; organization members may
 * also add new sessions.
 */
async function permission(env, token, config, login, issue, { creator = '', creating = false } = {}) {
  const me = login.toLowerCase();
  const people = new Set([issue.user.login, ...(issue.assignees || []).map(a => a.login), creator].filter(Boolean).map(s => s.toLowerCase()));
  for (const h of contactHandles(issue.body)) people.add(h);
  if (people.has(me)) return true;
  if (await isCollaborator(env, token, login)) return true;
  return creating && isOrgMember(token, config.org, login);
}

// ---------------------------------------------------------------- pages

function page(title, body, { status = 200, nonce = '', headers = {} } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce || 'none'}'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function messagePage(title, html, { status = 200, links = [] } = {}) {
  const buttons = links.map(([href, label, primary]) => `<a class="btn${primary ? ' primary' : ''}" href="${esc(href)}">${esc(label)}</a>`).join(' ');
  return page(title, `<h1>${esc(title)}</h1>${html}<p class="row">${buttons}</p>`, { status });
}

function header(config, issue, user) {
  return `<p class="muted small"><a href="${esc(config.site_url)}">← ${esc(config.title)} calendar</a>
    · signed in as <strong>${esc(user)}</strong> · <a href="/logout">sign out</a></p>
    <p class="kicker">Sprint #${issue.number}</p>
    <h1><a class="plain" href="${esc(issue.html_url)}">${esc(issue.title)}</a></h1>`;
}

// Exported so the form can be rendered locally for previews.
export function formPage({ config, issue, user, values, errors = {}, mode, action, csrf, status = 200 }) {
  const nonce = randomToken(16);
  const err = k => (errors[k] ? `<p class="error">${esc(errors[k])}</p>` : '');
  const days = [...config.days];
  if (values.date && !days.includes(values.date)) days.push(values.date);
  const dayOptions = days.map(d => {
    const label = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
    return `<label class="pick"><input type="radio" name="date" value="${esc(d)}" ${values.date === d ? 'checked' : ''} required><span>${esc(label)}</span></label>`;
  }).join('');
  const where = values.where || (values.site || (values.online && !values.location ? 'online' : config.sites[0]?.name || 'online'));
  const whereOptions = [...config.sites.map(s => [s.name, `📍 ${s.name}`]), ['online', '💻 Online only']]
    .map(([v, l]) => `<label class="pick"><input type="radio" name="where" value="${esc(v)}" ${where === v ? 'checked' : ''} required><span>${esc(l)}</span></label>`).join('');
  const zones = [...new Set([...config.sites.map(s => s.timezone), values.tz, 'UTC'].filter(Boolean))];
  const zoneLabel = tz => {
    const site = config.sites.find(s => s.timezone === tz);
    return site ? `${site.name} time (${tz})` : tz;
  };
  const tz = values.tz || config.sites.find(s => s.name === where)?.timezone || zones[0];
  const zoneOptions = zones.map(z => `<option value="${esc(z)}" ${z === tz ? 'selected' : ''}>${esc(zoneLabel(z))}</option>`).join('');
  const editing = mode === 'edit';
  const body = `${header(config, issue, user)}
  <h2>${editing ? 'Edit session' : 'Schedule a session'}</h2>
  ${Object.keys(errors).length ? '<p class="error box">Please fix the highlighted fields.</p>' : ''}
  <form method="post" action="${esc(action)}" id="f">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <fieldset><legend>Day</legend><div class="picks">${dayOptions}</div>${err('date')}</fieldset>
    <fieldset><legend>Time</legend>
      <div class="row"><label>Start <input type="time" name="start" value="${esc(values.start || '')}" step="300" required></label>
      <label>End <input type="time" name="end" value="${esc(values.end || '')}" step="300" required></label>
      <label>in <select name="tz" id="tz">${zoneOptions}</select></label></div>
      ${err('start')}${err('end')}${err('tz')}
      <p class="muted small" id="preview"></p>
    </fieldset>
    <fieldset><legend>Where</legend><div class="picks">${whereOptions}</div>${err('where')}
      <label id="room-row">Room <input name="location" list="rooms" maxlength="200" value="${esc(values.location || '')}" placeholder="e.g. Redwood C-D (leave blank if not known yet)"></label>
      <datalist id="rooms"></datalist>
      <p class="error" id="room-hint" hidden></p>${err('location')}
      <label>Online link <input type="url" name="online" maxlength="500" value="${esc(values.online || '')}" placeholder="https://…zoom.us/j/… (optional for in-person sessions)"></label>${err('online')}
    </fieldset>
    <fieldset><legend>Optional</legend>
      <label>Session name <input name="label" maxlength="80" value="${esc(values.label || '')}" placeholder="e.g. Kickoff, Hands-on, Daily planning"></label>
      <label>Note <input name="note" maxlength="300" value="${esc(values.note || '')}" placeholder="e.g. Breakout room 5 · Bring a laptop"></label>
    </fieldset>
    <p class="row">
      <button class="btn primary" type="submit" name="action" value="save">${editing ? 'Save changes' : 'Schedule session'}</button>
      ${editing ? '<button class="btn danger" type="submit" name="action" value="cancel" id="cancel" formnovalidate>Cancel this session</button>' : ''}
    </p>
    <p class="muted small">The session is posted as a comment on the <a href="${esc(issue.html_url)}">GitHub issue</a> and appears on the calendar a minute or two later.</p>
  </form>
  <script type="application/json" id="sites">${JSON.stringify(config.sites).replace(/</g, '\\u003c')}</script>
  <script nonce="${nonce}">${FORM_SCRIPT}</script>`;
  return page(editing ? 'Edit session' : 'Schedule a session', body, { nonce, status });
}

// Live preview of the time in other sites' zones, and site-dependent defaults.
const FORM_SCRIPT = `
const f = document.getElementById('f'), sites = JSON.parse(document.getElementById('sites').textContent);
const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (local && ![...f.tz.options].some(o => o.value === local)) f.tz.add(new Option(local + ' (your time)', local));
function wall(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: p.year + '-' + p.month + '-' + p.day, time: (p.hour % 24 === 0 ? '00' : p.hour) + ':' + p.minute, weekday: p.weekday };
}
function toUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number), guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = t => { const w = wall(new Date(t), tz); const [a, b, c] = w.date.split('-').map(Number); const [h, mi] = w.time.split(':').map(Number); return Date.UTC(a, b - 1, c, h, mi) - t; };
  return new Date(guess - off(guess - off(guess)));
}
function update(e) {
  const where = f.where.value, site = sites.find(s => s.name === where);
  if (e && e.target.name === 'where') f.tz.value = site ? site.timezone : (local && [...f.tz.options].some(o => o.value === local) ? local : f.tz.value);
  document.getElementById('room-row').hidden = !site;
  const date = (f.querySelector('input[name=date]:checked') || {}).value, s = f.start.value, en = f.end.value, tz = f.tz.value;
  const rooms = (site ? site.rooms : []).map(r => typeof r === 'string' ? { name: r, available: null } : r);
  // Suggest the rooms open on the chosen day, with their hours when they are not open all day.
  document.getElementById('rooms').replaceChildren(...rooms.flatMap(r => {
    if (!r.available) return [new Option(r.name, r.name)];
    const w = date ? r.available.filter(x => x.date === date) : r.available;
    if (!w.length) return [];
    const o = new Option(r.name, r.name);
    if (date && !w.some(x => !x.start)) o.label = 'open ' + w.map(x => x.start + '–' + x.end).join(', ');
    return [o];
  }));
  const norm = t => String(t || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const room = rooms.find(r => norm(r.name) === norm(f.location.value));
  const hint = document.getElementById('room-hint');
  const ok = !room || !room.available || !date || !s || !en || room.available.some(x => x.date === date && (!x.start || (x.start <= s && en <= x.end)));
  hint.hidden = ok;
  hint.textContent = ok ? '' : room.name + ' is not available then (available: ' + room.summary + ').';
  const out = document.getElementById('preview');
  if (!date || !s || !en) { out.textContent = ''; return; }
  const a = toUtc(date, s, tz), b = toUtc(date, en, tz);
  out.textContent = sites.filter(x => x.timezone !== tz).map(x => { const p = wall(a, x.timezone), q = wall(b, x.timezone); return '= ' + p.time + '–' + q.time + ' ' + x.name + ' time' + (p.date !== date ? ' (' + p.weekday + ')' : ''); }).join(' · ');
}
f.addEventListener('change', update); f.addEventListener('input', update); update();
const c = document.getElementById('cancel');
if (c) c.addEventListener('click', e => { if (!confirm('Cancel this session? It will be removed from the calendar.')) e.preventDefault(); });
`;

const CSS = `
:root { --bg:#f6f7f9; --surface:#fff; --text:#1b1f24; --muted:#5b6573; --border:#d9dee5; --accent:#4a3bb5; --ink:#fff; --soft:#ebe8fb; --bad:#cf222e; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --surface:#171b21; --text:#e6e9ee; --muted:#9aa4b2; --border:#2d343e; --accent:#a497ff; --ink:#12101f; --soft:#272143; --bad:#ff7b72; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 20px 16px 48px; }
a { color: var(--accent); } a.plain { color: inherit; text-decoration: none; }
h1 { font-size: 1.5rem; margin: 0 0 12px; line-height: 1.25; } h2 { font-size: 1.15rem; margin: 18px 0 8px; }
.kicker { margin: 16px 0 2px; color: var(--muted); font-weight: 600; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
.muted { color: var(--muted); } .small { font-size: .88rem; }
form { display: grid; gap: 14px; }
fieldset { border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 12px 14px 14px; margin: 0; display: grid; gap: 10px; }
legend { font-weight: 700; padding: 0 4px; }
label { display: grid; gap: 4px; font-weight: 550; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.row label { flex: 1 1 140px; }
input:not([type=radio]), select { font: inherit; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); width: 100%; min-width: 0; }
.picks { display: flex; flex-wrap: wrap; gap: 8px; }
.pick { display: block; } .pick input { position: absolute; opacity: 0; }
.pick span { display: inline-block; padding: 8px 14px; border: 1px solid var(--border); border-radius: 999px; cursor: pointer; background: var(--bg); font-weight: 550; }
.pick input:checked + span { background: var(--soft); border-color: var(--accent); }
.pick input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn { display: inline-block; font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--ink); }
.btn.danger { color: var(--bad); border-color: var(--bad); background: transparent; }
.error { color: var(--bad); margin: 0; font-size: .9rem; } .error.box { padding: 8px 12px; border: 1px solid var(--bad); border-radius: 8px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
[hidden] { display: none !important; }
`;

// ---------------------------------------------------------------- auth

async function currentUser(request, env) {
  return verify(env.SESSION_SECRET, parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE]);
}

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function safeNext(next) {
  return /^\/(schedule|session)(\/|\?|$)/.test(next || '') ? next : '/';
}

async function login(request, env, url) {
  const state = randomToken(24);
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const next = safeNext(url.searchParams.get('next'));
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'false',
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      'Set-Cookie': cookie(OAUTH_COOKIE, await sign(env.SESSION_SECRET, { state, verifier, next }, 600), 600),
    },
  });
}

async function callback(request, env, url) {
  const saved = await verify(env.SESSION_SECRET, parseCookies(request.headers.get('Cookie'))[OAUTH_COOKIE]);
  const code = url.searchParams.get('code');
  if (!saved || !code || url.searchParams.get('state') !== saved.state) {
    throw new HttpError(400, 'Sign-in expired', 'Please start again from the scheduling link.');
  }
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'sprintweek-scheduler' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
      code_verifier: saved.verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new HttpError(400, 'Sign-in failed', 'GitHub did not confirm the sign-in. Please try again.');
  const user = await githubJson('/user', data.access_token);
  // We only needed the user's name: revoke their token right away (best effort).
  await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sprintweek-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: data.access_token }),
  }).catch(() => {});
  const headers = new Headers({ Location: saved.next });
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, await sign(env.SESSION_SECRET, user.login, SESSION_TTL), SESSION_TTL));
  headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

const csrfFor = (env, request) => hmac(env.SESSION_SECRET, `csrf:${parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE]}`);

async function readForm(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Not allowed', 'This form must be submitted from the scheduling page.');
  const form = Object.fromEntries(await request.formData());
  if (form.csrf !== (await csrfFor(env, request))) throw new HttpError(403, 'Form expired', 'Please reload the page and try again.');
  return form;
}

// ---------------------------------------------------------------- handlers

function notAllowed(config, issue, user) {
  return messagePage('Only the sprint’s team can do this', `
    <p>Signed in as <strong>${esc(user)}</strong>.
    Sessions of <a href="${esc(issue.html_url)}">${esc(issue.title)}</a> can be scheduled and edited by its author,
    assignees and contacts listed in the issue, and by repository collaborators${config.org ? `; members of ${esc(config.org)} can also add new sessions` : ''}.</p>
    <p>Ask one of the contacts, or leave a comment on the issue.</p>`,
  { status: 403, links: [[issue.html_url, 'Open the GitHub issue', true], ['/logout', 'Sign in as someone else']] });
}

function donePage(config, issue, session, { cancelled = false } = {}) {
  const { when, also } = describeTimes(session, config.sites);
  return messagePage(cancelled ? 'Session cancelled' : 'Session saved ✅', `
    <div class="card"><p><strong>${esc(issue.title)}</strong>${session.label ? ` — ${esc(session.label)}` : ''}</p>
    <p>${cancelled ? '<s>' : ''}${esc(when)}${cancelled ? '</s>' : ''}${also.length ? `<br><span class="muted small">= ${esc(also.join(' · '))}</span>` : ''}</p>
    ${cancelled ? '' : `<p>${esc([session.site, session.location].filter(Boolean).join(' – ') || 'Online')}${session.online ? ' · online' : ''}</p>`}</div>
    <p>The ${cancelled ? 'change is' : 'session is'} on the GitHub issue now and the calendar updates in a minute or two.</p>`,
  { links: [[`/schedule?sprint=${issue.number}`, 'Schedule another session'], [issue.html_url, 'View on GitHub'], [config.site_url, 'Back to the calendar', true]] });
}

async function scheduleHandler(request, env, url, user) {
  const number = Number(url.searchParams.get('sprint'));
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Which sprint?', 'Use the “Schedule a session” link on a sprint’s page or GitHub issue.');
  const [config, bot] = await Promise.all([siteConfig(env), app(env)]);
  const issue = await getSprint(env, bot.token, number);
  if (!(await permission(env, bot.token, config, user, issue, { creating: true }))) return notAllowed(config, issue, user);
  const action = `/schedule?sprint=${number}`;
  const csrf = await csrfFor(env, request);
  if (request.method === 'GET') return formPage({ config, issue, user, values: {}, mode: 'create', action, csrf });

  const form = await readForm(request, env, url);
  const { session, errors } = validateSession(form, config);
  if (!session) return formPage({ config, issue, user, values: form, errors, mode: 'create', action, csrf, status: 400 });
  session.by = user;
  const created = await githubJson(`/repos/${env.REPO}/issues/${number}/comments`, bot.token, {
    method: 'POST', body: { body: renderSessionComment(session, { sites: config.sites }) },
  });
  // The edit link needs the comment's id, which only exists now.
  await githubJson(`/repos/${env.REPO}/issues/comments/${created.id}`, bot.token, {
    method: 'PATCH', body: { body: renderSessionComment(session, { sites: config.sites, editUrl: `${url.origin}/session/${created.id}` }) },
  });
  return donePage(config, issue, session);
}

async function sessionHandler(request, env, url, user, commentId) {
  const [config, bot] = await Promise.all([siteConfig(env), app(env)]);
  const comment = await githubJson(`/repos/${env.REPO}/issues/comments/${commentId}`, bot.token);
  const number = Number(comment.issue_url.split('/').pop());
  const issue = await getSprint(env, bot.token, number);
  if (comment.body?.includes(CANCELLED_MARKER)) {
    return messagePage('Already cancelled', '<p>This session was cancelled.</p>', { links: [[`/schedule?sprint=${number}`, 'Schedule a new session', true], [issue.html_url, 'View on GitHub']] });
  }
  const data = extractSessionData(comment.body);
  const trusted = comment.user.login === bot.login || TRUSTED_ASSOCIATIONS.includes(comment.author_association);
  if (!data || !trusted) throw new HttpError(404, 'Not a session', 'This comment is not a scheduled session.');
  const creator = isLogin(data.by) ? data.by : '';
  if (!(await permission(env, bot.token, config, user, issue, { creator }))) return notAllowed(config, issue, user);

  const action = `/session/${commentId}`;
  const csrf = await csrfFor(env, request);
  const current = { ...data, where: data.site || (data.online ? 'online' : '') };
  if (request.method === 'GET') return formPage({ config, issue, user, values: current, mode: 'edit', action, csrf });

  const form = await readForm(request, env, url);
  if (form.action === 'cancel') {
    const old = { ...data, by: creator };
    await githubJson(`/repos/${env.REPO}/issues/comments/${commentId}`, bot.token, {
      method: 'PATCH', body: { body: renderCancelledComment(old, { sites: config.sites, by: user }) },
    });
    return donePage(config, issue, old, { cancelled: true });
  }
  const { session, errors } = validateSession(form, config, [data.date]);
  if (!session) return formPage({ config, issue, user, values: form, errors, mode: 'edit', action, csrf, status: 400 });
  session.by = creator || user;
  await githubJson(`/repos/${env.REPO}/issues/comments/${commentId}`, bot.token, {
    method: 'PATCH', body: { body: renderSessionComment(session, { sites: config.sites, editUrl: `${url.origin}${action}`, updatedBy: user }) },
  });
  return donePage(config, issue, session);
}

/** Setup check for organizers: is the bot configured and installed? Reveals no secrets. */
async function status(env) {
  const result = { repo: env.REPO, site: env.SITE_URL, bot: null, installed: false, calendar_config: false };
  try {
    const bot = await app(env);
    result.bot = bot.login;
    result.installed = true;
  } catch (err) {
    result.error = err instanceof HttpError ? err.message : 'GitHub App authentication failed';
  }
  try {
    result.calendar_config = Boolean((await siteConfig(env)).days);
  } catch { /* reported as false */ }
  return new Response(JSON.stringify(result, null, 1), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/login') return login(request, env, url);
  if (path === '/callback') return callback(request, env, url);
  if (path === '/status') return status(env);
  if (path === '/logout') {
    return new Response(null, { status: 302, headers: { Location: env.SITE_URL, 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) } });
  }
  const session = path.match(/^\/session\/(\d{1,20})$/);
  if (path !== '/schedule' && !session) {
    return path === '/' ? Response.redirect(env.SITE_URL, 302) : new Response('Not found', { status: 404 });
  }
  if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const user = await currentUser(request, env);
  if (!user) {
    if (request.method !== 'GET') throw new HttpError(401, 'Signed out', 'Your sign-in expired. Please open the link again.');
    return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(path + url.search)}`, 302);
  }
  return session ? sessionHandler(request, env, url, user, session[1]) : scheduleHandler(request, env, url, user);
}

export default {
  async fetch(request, env) {
    for (const name of ['REPO', 'SITE_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET']) {
      if (!env[name]) return messagePage('Not configured yet', `<p>The scheduling bot is missing the <code>${name}</code> setting.</p>`, { status: 503 });
    }
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return messagePage(err.title, `<p>${esc(err.message)}</p>`, { status: err.status, links: [[env.SITE_URL, 'Back to the calendar']] });
      console.error(err);
      return messagePage('Something went wrong', '<p>The bot hit an unexpected error. Please try again in a minute, or tell the organizers.</p>', { status: 500 });
    }
  },
};
