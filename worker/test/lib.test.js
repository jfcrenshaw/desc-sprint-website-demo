// Run with `npm test` (or `node --test`) in worker/. No dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSession, encodeSessionData, extractSessionData, renderSessionComment, renderCancelledComment, zonedToUtc,
  describeTimes, contactHandles, mdEscape, cleanText, sign, verify, pkcs1ToPkcs8, importPrivateKey, appJwt, fromB64url,
  isTimeZone, roomProblem, siteRooms,
} from '../src/lib.js';

const config = {
  days: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'],
  sites: [
    { name: 'SLAC', timezone: 'America/Los_Angeles', abbr: 'PDT', rooms: ['Redwood A'] },
    { name: 'Paris', timezone: 'Europe/Paris', abbr: 'CET', rooms: [] },
  ],
};
const form = { date: '2026-10-27', start: '14:00', end: '16:00', where: 'Paris', tz: 'Europe/Paris', location: 'Salle 3' };

test('time zone conversion handles daylight saving', () => {
  assert.equal(zonedToUtc('2026-10-27', '14:00', 'Europe/Paris').toISOString(), '2026-10-27T13:00:00.000Z'); // CET
  assert.equal(zonedToUtc('2026-10-23', '14:00', 'Europe/Paris').toISOString(), '2026-10-23T12:00:00.000Z'); // CEST
  assert.equal(zonedToUtc('2026-10-27', '09:00', 'America/Los_Angeles').toISOString(), '2026-10-27T16:00:00.000Z'); // PDT
  assert.equal(zonedToUtc('2026-11-02', '09:00', 'America/Los_Angeles').toISOString(), '2026-11-02T17:00:00.000Z'); // PST
  assert.equal(zonedToUtc('2026-10-27', '00:00', 'UTC').toISOString(), '2026-10-27T00:00:00.000Z');
});

test('describeTimes shows the other sites', () => {
  const { when, also } = describeTimes({ date: '2026-10-27', start: '08:00', end: '09:00', tz: 'Europe/Paris' }, config.sites);
  assert.match(when, /^Tuesday, October 27 · 08:00–09:00 CET$/);
  assert.deepEqual(also, ['00:00–01:00 PDT (SLAC)']);
  const early = describeTimes({ date: '2026-10-27', start: '06:00', end: '07:00', tz: 'Europe/Paris' }, config.sites);
  assert.deepEqual(early.also, ['22:00–23:00 PDT (SLAC, Mon)']);
});

test('valid sessions', () => {
  const { session, errors } = validateSession(form, config);
  assert.deepEqual(errors, {});
  assert.deepEqual(session, {
    date: '2026-10-27', start: '14:00', end: '16:00', tz: 'Europe/Paris', site: 'Paris', location: 'Salle 3', online: '', label: '', note: '',
  });
  const online = validateSession({ ...form, where: 'online', location: 'ignored', online: 'https://zoom.us/j/1' }, config).session;
  assert.equal(online.site, '');
  assert.equal(online.location, '');
});

test('invalid sessions', () => {
  const cases = [
    [{ date: '2026-11-15' }, 'date'],
    [{ start: '' }, 'start'],
    [{ end: '13:00' }, 'end'],
    [{ end: '14:00' }, 'end'],
    [{ where: 'Mars' }, 'where'],
    [{ tz: 'Not/AZone' }, 'tz'],
    [{ online: 'http://insecure' }, 'online'],
    [{ online: 'javascript:alert(1)' }, 'online'],
    [{ where: 'online', online: '' }, 'online'],
  ];
  for (const [change, field] of cases) {
    const { session, errors } = validateSession({ ...form, ...change }, config);
    assert.equal(session, null, JSON.stringify(change));
    assert.ok(errors[field], `${JSON.stringify(change)} -> ${JSON.stringify(errors)}`);
  }
  assert.ok(validateSession({ ...form, date: '2026-11-15' }, config, ['2026-11-15']).session, 'extra days are allowed');
});

test('text is cleaned and limited', () => {
  assert.equal(cleanText(' a\n\tb\u0000c  ', 10), 'a b c');
  assert.equal(cleanText('x'.repeat(500), 80).length, 80);
  assert.equal(validateSession({ ...form, note: 'n'.repeat(1000) }, config).session.note.length, 300);
});

test('hidden data matches the Python encoder byte for byte', () => {
  const session = {
    date: '2026-10-27', start: '14:00', end: '16:00', tz: 'Europe/Paris', site: 'Paris', location: 'Salle <3> & co',
    online: 'https://zoom.us/j/1', label: 'Kick-off', note: 'Ünïcode é', by: 'alice',
  };
  // Produced by sprintweek.sessions.encode_session_data with the same input.
  const python = '<!-- sprintweek:session {"v":1,"date":"2026-10-27","start":"14:00","end":"16:00","tz":"Europe/Paris","site":"Paris","location":"Salle \\u003c3\\u003e \\u0026 co","online":"https://zoom.us/j/1","label":"Kick-off","note":"Ünïcode é","by":"alice"} -->';
  assert.equal(encodeSessionData(session), python);
  assert.deepEqual(extractSessionData(`${python}\nrest`), { v: 1, ...session });
});

test('rendered comments', () => {
  const session = { ...validateSession({ ...form, note: 'ping @everyone', label: 'Kickoff' }, config).session, by: 'alice' };
  const body = renderSessionComment(session, { sites: config.sites, editUrl: 'https://bot.example/session/5', updatedBy: 'bob' });
  assert.ok(body.startsWith('<!-- sprintweek:session {'));
  assert.match(body, /\*\*When:\*\* Tuesday, October 27 · 14:00–16:00 CET/);
  assert.match(body, /= 06:00–08:00 PDT \(SLAC\)/);
  assert.match(body, /Scheduled by \[alice\]\(https:\/\/github.com\/alice\) · updated by \[bob\]/);
  assert.match(body, /\[✏️ Edit or cancel this session\]\(https:\/\/bot.example\/session\/5\)/);
  assert.ok(!body.split('-->')[1].includes('@everyone'), 'mentions are defanged');
  const cancelled = renderCancelledComment(session, { sites: config.sites, by: 'bob' });
  assert.ok(cancelled.startsWith('<!-- sprintweek:cancelled {'));
  assert.equal(extractSessionData(cancelled), null);
});

test('extractSessionData tolerates junk', () => {
  assert.equal(extractSessionData('hello'), null);
  assert.equal(extractSessionData('<!-- sprintweek:session {broken -->'), null);
  assert.equal(extractSessionData(null), null);
});

test('contact handles from the form and from old templates', () => {
  const body = '### Short pitch\n\nHi @notacontact\n\n### Contact person(s)\n\n@Alice, Bob (@bob-2) `@carol`\n\n### Goals\n\n@dave';
  assert.deepEqual([...contactHandles(body)], ['alice', 'bob-2', 'carol']);
  assert.deepEqual([...contactHandles('**Contacts**: @x @y\nDay/Time: @z')], ['x', 'y']);
  assert.deepEqual([...contactHandles('mail me at a@b.org')], []);
});

test('markdown escaping', () => {
  assert.equal(mdEscape('[x](javascript:1) <b>'), '\\[x\\]\\(javascript:1\\) \\<b\\>');
  assert.equal(mdEscape('@team'), '@​team');
});

test('time zone names', () => {
  assert.ok(isTimeZone('Europe/Paris'));
  assert.ok(isTimeZone('UTC'));
  assert.ok(!isTimeZone('Nowhere/Land'));
  assert.ok(!isTimeZone(''));
});

test('signed values', async () => {
  const token = await sign('secret', { login: 'alice' }, 60);
  assert.deepEqual(await verify('secret', token), { login: 'alice' });
  assert.equal(await verify('other', token), null);
  assert.equal(await verify('secret', `${token}x`), null);
  assert.equal(await verify('secret', token.replace(/^./, c => (c === 'a' ? 'b' : 'a'))), null);
  assert.equal(await verify('secret', await sign('secret', 'x', -1)), null, 'expired');
  assert.equal(await verify('secret', undefined), null);
});

/** Return the PKCS#1 key inside a PKCS#8 DER (what GitHub's "BEGIN RSA PRIVATE KEY" files contain). */
function unwrapPkcs8(der) {
  const len = i => (der[i] < 128 ? [der[i], 1] : [der.slice(i + 1, i + 1 + (der[i] & 127)).reduce((a, b) => a * 256 + b, 0), 1 + (der[i] & 127)]);
  let i = 1 + len(1)[1]; // outer SEQUENCE header
  i += 3; // INTEGER 0
  i += 1 + len(i + 1)[1] + len(i + 1)[0]; // AlgorithmIdentifier SEQUENCE
  const [n, l] = len(i + 1); // OCTET STRING
  return der.slice(i + 1 + l, i + 1 + l + n);
}

test('GitHub App private keys in PKCS#1 and PKCS#8 both sign JWTs', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pkcs1 = unwrapPkcs8(pkcs8);
  assert.deepEqual(pkcs1ToPkcs8(pkcs1), pkcs8, 'wrapping PKCS#1 gives back the PKCS#8 encoding');
  const pem = (label, der) => `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  for (const text of [pem('RSA PRIVATE KEY', pkcs1), pem('PRIVATE KEY', pkcs8), pem('RSA PRIVATE KEY', pkcs1).replace(/\n/g, '\\n')]) {
    const jwt = await appJwt(12345, await importPrivateKey(text));
    const [h, p, s] = jwt.split('.');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
    assert.ok(ok);
    assert.equal(JSON.parse(Buffer.from(fromB64url(p)).toString()).iss, '12345');
  }
});

const roomConfig = {
  ...config,
  sites: [
    {
      ...config.sites[0],
      rooms: [
        'Redwood C-D',
        { name: 'Redwood A', summary: 'Mon 26; Tue 27 13:00–17:00', available: [
          { date: '2026-10-26', start: '', end: '' }, { date: '2026-10-27', start: '13:00', end: '17:00' }] },
      ],
    },
    config.sites[1],
  ],
};
const slac = { date: '2026-10-27', start: '10:00', end: '12:00', where: 'SLAC', tz: 'America/Los_Angeles' };

test('room availability matches the Python checker', () => {
  // Produced by sprintweek.rooms.room_problem for the same room and session.
  const python = 'Redwood A is not available on Tue Oct 27 at 10:00–12:00 (available: Mon 26; Tue 27 13:00–17:00).';
  assert.equal(roomProblem({ site: 'SLAC', location: ' redwood  A ', date: '2026-10-27', start: '10:00', end: '12:00' }, roomConfig.sites), python);
});

test('room availability windows', () => {
  const check = (location, change = {}) => roomProblem({ site: 'SLAC', location, date: '2026-10-27', start: '13:00', end: '17:00', ...change }, roomConfig.sites);
  assert.equal(check('Redwood A'), '', 'exactly the window');
  assert.ok(check('Redwood A', { start: '12:30' }), 'starts too early');
  assert.ok(check('Redwood A', { end: '17:30' }), 'ends too late');
  assert.equal(check('Redwood A', { date: '2026-10-26', start: '08:00', end: '20:00' }), '', 'all day Monday');
  assert.ok(check('Redwood A', { date: '2026-10-28' }), 'not on Wednesday');
  assert.equal(check('Redwood C-D', { date: '2026-10-28' }), '', 'plain names are always available');
  assert.equal(check("Alice's office"), '', 'typed-in rooms are not checked');
  assert.equal(roomProblem({ site: 'Paris', location: 'Redwood A', ...slac }, roomConfig.sites), '', 'rooms belong to their site');
  assert.deepEqual(siteRooms({ rooms: ['X'] }), [{ name: 'X', available: null, summary: 'all week' }]);
});

test('the bot refuses unavailable rooms', () => {
  const bad = validateSession({ ...slac, location: 'Redwood A' }, roomConfig);
  assert.equal(bad.session, null);
  assert.match(bad.errors.location, /^Redwood A is not available on Tue Oct 27 at 10:00–12:00/);
  assert.ok(validateSession({ ...slac, location: 'Redwood A', start: '13:00', end: '15:00' }, roomConfig).session);
  assert.ok(validateSession({ ...slac, location: 'Redwood C-D' }, roomConfig).session);
});
