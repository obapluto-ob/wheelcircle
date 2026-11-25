import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, assertStatus,
} from './helpers.mjs';

process.env.KORA_SIMULATED = '1';

const AMINA = { name: 'Amina Wanjiru', phone: '+254700000001' };
const AMINA_ID = { idNumber: '12345678', dateOfBirth: '1996-04-12' };

test('the register peek needs consent and returns the registered name', async () => {
  const { handle } = await boot();
  const call = client(handle, null);
  const refused = await call('/identity/peek', { method: 'POST', body: { idNumber: AMINA_ID.idNumber } });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'consent_required');

  const found = await call('/identity/peek', { method: 'POST', body: { idNumber: AMINA_ID.idNumber, consent: true } });
  assertStatus(found, 200, 'peek a known ID');
  assert.equal(found.data.found, true);
  assert.equal(found.data.name, AMINA.name);
  assert.equal(found.data.dateOfBirth, AMINA_ID.dateOfBirth);
  assert.equal(found.data.simulated, true);

  const missing = await call('/identity/peek', { method: 'POST', body: { idNumber: '99999999', consent: true } });
  assertStatus(missing, 200, 'peek an unknown ID');
  assert.equal(missing.data.found, false);
});

test('registration with an ID number needs consent and refuses a claimed ID', async () => {
  const { db, handle } = await boot();
  const call = client(handle, null);
  const refused = await call('/auth/register/options', {
    method: 'POST',
    body: { name: AMINA.name, phone: AMINA.phone, ...AMINA_ID },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'consent_required');

  const accepted = await call('/auth/register/options', {
    method: 'POST',
    body: { name: AMINA.name, phone: AMINA.phone, ...AMINA_ID, verificationConsent: true },
  });
  assertStatus(accepted, 200, 'registration options with consent');
  assert.ok(accepted.data.challengeId);

  db.table('users').push({
    id: crypto.randomUUID(),
    name: 'Holder',
    phone: '+254700000123',
    identity_hash: await (await import('../functions/lib/util.mjs')).sha256Hex(`identity:${AMINA_ID.idNumber}`),
  });
  const claimed = await call('/auth/register/options', {
    method: 'POST',
    body: { name: 'Other Person', phone: '+254700000124', ...AMINA_ID, verificationConsent: true },
  });
  assert.equal(claimed.status, 409);
  assert.equal(claimed.data.error, 'identity_in_use');
});

test('a matched sandbox record verifies the account on the spot', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, AMINA);
  const call = client(handle, await signIn(db, user));
  const result = await call('/account/identity', {
    method: 'POST',
    body: {
      legalName: AMINA.name,
      idNumber: AMINA_ID.idNumber,
      dateOfBirth: AMINA_ID.dateOfBirth,
      phone: AMINA.phone,
      verificationConsent: true,
    },
  });
  assertStatus(result, 200, 'submit a matching ID');
  assert.equal(result.data.identityStatus, 'verified');
  assert.equal(result.data.review, false);
  const row = db.table('users').find((entry) => entry.id === user.id);
  assert.equal(row.identity_status, 'verified');
  assert.equal(row.identity_provider, 'kora');
  assert.equal(row.identity_dob_match, true);
  assert.equal(row.identity_phone_match, true);
  assert.equal(row.identity_source, 'provider');
  assert.match(String(row.identity_reference || ''), /^VR-SIM-/);
});

test('a wrong date of birth or phone keeps the ID in review', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, AMINA);
  const call = client(handle, await signIn(db, user));
  const wrongDob = await call('/account/identity', {
    method: 'POST',
    body: {
      legalName: AMINA.name,
      idNumber: AMINA_ID.idNumber,
      dateOfBirth: '1990-01-01',
      phone: AMINA.phone,
      verificationConsent: true,
    },
  });
  assertStatus(wrongDob, 200, 'submit a wrong date of birth');
  assert.equal(wrongDob.data.identityStatus, 'pending');
  assert.equal(wrongDob.data.review, true);
  const row = db.table('users').find((entry) => entry.id === user.id);
  assert.equal(row.identity_status, 'pending');
  assert.equal(row.identity_dob_match, false);

  const otherPhone = await addUser(db, { name: 'David Mbugua Kimani', phone: '+254700000005' });
  const otherCall = client(handle, await signIn(db, otherPhone));
  const wrongPhone = await otherCall('/account/identity', {
    method: 'POST',
    body: {
      legalName: 'David Mbugua Kimani',
      idNumber: '45678901',
      dateOfBirth: '1995-02-18',
      phone: '+254700000005',
      verificationConsent: true,
    },
  });
  assertStatus(wrongPhone, 200, 'submit someone else\'s phone');
  assert.equal(wrongPhone.data.identityStatus, 'pending');
  const phoneRow = db.table('users').find((entry) => entry.id === otherPhone.id);
  assert.equal(phoneRow.identity_phone_match, false);
});

test('identity submission needs consent and one ID holds one account', async () => {
  const { db, handle } = await boot();
  const first = await addUser(db, AMINA);
  const firstCall = client(handle, await signIn(db, first));
  const refused = await firstCall('/account/identity', {
    method: 'POST',
    body: { legalName: AMINA.name, idNumber: AMINA_ID.idNumber, dateOfBirth: AMINA_ID.dateOfBirth, phone: AMINA.phone },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'consent_required');

  assertStatus(await firstCall('/account/identity', {
    method: 'POST',
    body: { legalName: AMINA.name, idNumber: AMINA_ID.idNumber, dateOfBirth: AMINA_ID.dateOfBirth, phone: AMINA.phone, verificationConsent: true },
  }), 200, 'first account claims the ID');

  const second = await addUser(db, { name: 'Copycat', phone: '+254700000222' });
  const secondCall = client(handle, await signIn(db, second));
  const stolen = await secondCall('/account/identity', {
    method: 'POST',
    body: { legalName: 'Copycat', idNumber: AMINA_ID.idNumber, dateOfBirth: AMINA_ID.dateOfBirth, phone: '+254700000222', verificationConsent: true },
  });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.data.error, 'identity_in_use');
});

test('money cannot leave the circle before the ID is verified', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, { name: 'Unverified', phone: '+254700000333' });
  const call = client(handle, await signIn(db, user));
  const result = await call('/wallet/withdraw', {
    method: 'POST',
    body: { amountMinor: 500, phone: user.phone },
  });
  assert.equal(result.status, 403);
  assert.equal(result.data.error, 'identity_required');
});
