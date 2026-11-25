import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, assertStatus } from './helpers.mjs';
import { TERMS_VERSION } from '../functions/lib/legal.mjs';
import { clientIp } from '../functions/lib/util.mjs';

test('registration issues the current Terms version and refuses an unaccepted one', async () => {
  const { handle } = await boot();
  const call = client(handle, null);

  const options = await call('/auth/register/options', {
    method: 'POST', body: { name: 'Consent Tester', phone: '0712000001', dateOfBirth: '1995-04-02' },
  });
  assertStatus(options, 200, 'options');
  assert.equal(options.data.termsVersion, TERMS_VERSION, 'the page is told which version to show');
  assert.ok(options.data.publicKey?.challenge, 'the passkey challenge is still issued');

  const missing = await call('/auth/register/verify', {
    method: 'POST', body: { challengeId: options.data.challengeId, credential: {} },
  });
  assertStatus(missing, 400, 'missing consent');
  assert.equal(missing.data.error, 'terms_required');

  const stale = await call('/auth/register/verify', {
    method: 'POST', body: { challengeId: options.data.challengeId, credential: {}, termsVersion: '2026-01-01' },
  });
  assertStatus(stale, 400, 'stale consent');
  assert.equal(stale.data.error, 'terms_required');
});

test('registration requires a date of birth and refuses under-18s', async () => {
  const { handle } = await boot();
  const call = client(handle, null);

  const missing = await call('/auth/register/options', {
    method: 'POST', body: { name: 'No Birthday', phone: '0712000002' },
  });
  assertStatus(missing, 400, 'no date of birth');
  assert.equal(missing.data.error, 'invalid_input');

  const underage = await call('/auth/register/options', {
    method: 'POST', body: { name: 'Too Young', phone: '0712000003', dateOfBirth: '2014-06-01' },
  });
  assertStatus(underage, 400, 'under 18');
  assert.match(underage.data.message, /18/, 'the rule is stated plainly');

  const malformed = await call('/auth/register/options', {
    method: 'POST', body: { name: 'Bad Date', phone: '0712000004', dateOfBirth: '02/04/1995' },
  });
  assertStatus(malformed, 400, 'not a calendar date');
  assert.equal(malformed.data.error, 'invalid_input');
});

test('API responses carry baseline security headers', async () => {
  const { handle } = await boot();
  const call = client(handle, null);
  const response = await call('/auth/login/options', { method: 'POST', body: {} });
  assertStatus(response, 200, 'login options');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
});

test('rate-limit address trusts the socket peer, then the edge, never a client claim', () => {
  const headers = (values) => new Headers(values);

  assert.equal(
    clientIp({ headers: headers({ 'x-wheel-peer': '203.0.113.9', 'cf-connecting-ip': '10.0.0.1' }) }),
    '203.0.113.9',
    'a direct peer is authoritative',
  );
  assert.equal(
    clientIp({ headers: headers({ 'x-wheel-peer': '127.0.0.1', 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }) }),
    '198.51.100.7',
    'the tunnel edge header wins over a forwarded chain',
  );
  assert.equal(
    clientIp({ headers: headers({ 'x-wheel-peer': '::1', 'x-forwarded-for': '9.9.9.9, 198.51.100.20' }) }),
    '198.51.100.20',
    'the closest proxy hop is used, not the caller-supplied first entry',
  );
  assert.equal(
    clientIp({ headers: headers({}) }),
    'unknown',
    'no address information stays explicit',
  );
});
