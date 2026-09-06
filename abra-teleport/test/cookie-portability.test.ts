import assert from 'node:assert/strict';
import test from 'node:test';
import { cookiePortability } from '../build/src/cookie-portability.js';
import { filterState, nonPortableCookieReasons } from '../../abra/adapters/browser-session/lib/util.js';

const cookie = (name: string, domain = 'example.com', secure = true, httpOnly = true) => ({ name, domain, secure, httpOnly, path: '/' });
const classify = (value: ReturnType<typeof cookie>) => cookiePortability(value, nonPortableCookieReasons(value));

test('preflight exclusions agree with the adapter transfer filter', () => {
  for (const value of [cookie('SID', '.google.com'), cookie('session', 'youtube.com'), cookie('device_bound_session'), cookie('__Host-dbsc'), cookie('user_session'), cookie('sid'), cookie('SID', 'google.com.example.com')]) {
    const included = filterState({ cookies: [value], origins: [], tabs: [] }).cookies.length === 1;
    assert.equal(classify(value).status === 'excluded', !included, `${value.domain}: ${value.name}`);
    assert.ok(classify(value).reasons.length);
  }
});

test('normal session names and security attributes are not treated as binding evidence', () => {
  for (const name of ['__Host-user_session_same_site', '__Host-csrf', 'session', 'sid', 'user_session', 'authorization']) {
    assert.equal(classify(cookie(name)).status, 'no-known-restriction', name);
  }
});

test('a weak binding hint stays selectable and is described as unconfirmed', () => {
  const value = cookie('device_hint', 'example.com', false, false);
  const result = classify(value);
  assert.equal(result.status, 'possible');
  assert.match(result.reasons.join(' '), /not confirmed/);
  assert.equal(filterState({ cookies: [value], origins: [], tabs: [] }).cookies.length, 1);
});

test('site-level URL-only policy marks every cookie excluded, including country Google domains', () => {
  const value = cookie('preferences', '.google.ca');
  const result = cookiePortability(value, nonPortableCookieReasons(value), true);
  assert.equal(result.status, 'excluded');
  assert.match(result.reasons.join(' '), /disrupt your session/);
});
