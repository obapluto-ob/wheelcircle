import { AppError } from './lib/errors.mjs';
import {
  json, jsonBody, rows, one, nowIso, uuid, randomInt, sha256Hex, trimText, WEBHOOK_LIMIT, readText, randomToken,
} from './lib/util.mjs';
import { paysasaConfig, browserOrigin, rpId } from './lib/env.mjs';
import { TERMS_VERSION } from './lib/legal.mjs';
import {
  cookieHeaders, requireOrigin, requireCsrf, createSession, validateSession, requireSession,
  revokeDigest, revokeAllSessions, rateLimit, ipRateKey, normalizePhone,
  hashRecoveryCode, issueRecoveryCodes, normalizeRecoveryCode,
} from './lib/auth.mjs';
import {
  registrationOptions, loginOptions, newChallenge, newWebauthnUserId, verifyRegistration, verifyAssertion,
} from './lib/webauthn.mjs';
import { RULES, HOUR, bondBpsForTrust, validateDiscount, scheduledTurnAt, groupCadence, minSettlementTime } from './lib/rules.mjs';
import { walletFor, insertLedger } from './lib/ledger.mjs';
import {
  groupDetail, groupById, membershipFor, membersOf, currentCircle, groupList, serializeGroup,
  accountPayload, userPayload, ledgerFor, rulesPayload, groupRecapPayload, WITHDRAWAL_BLOCKER,
} from './lib/read.mjs';
import {
  ensureContributionRows, contributionForMember, contributionAmount, latestCycle, assertCurrentCycle,
  markContributionPaid, coverContribution, fundCycleIfComplete, recordCheckout, releaseBondOnPayment,
} from './lib/funding.mjs';
import { settleCycle } from './lib/settle.mjs';
import {
  createCheckout, verifyWebhook, webhookEvent, checkoutMetadata,
  checkoutStatus, payCheckoutSession, cancelCheckoutSession, probePaymentRail,
} from './lib/paysasa.mjs';
import {
  identityState, identityGate, saveIdentity, prepareIdentity, openCircleList, reserveOpenSeat, markSeatPaid,
  leaveOpenGroup, unpaidSeats, applySeatCredits, sweepSeats, SEAT_HOLD_MS, validateDateOfBirth,
} from './lib/open-circles.mjs';
import { requireAdmin, identityQueue, decideIdentity, unlockAdminPanel, adminOverview } from './lib/admin.mjs';
import {
  TOPUP_MIN_MINOR, TOPUP_MAX_MINOR, TOPUP_CHIPS_MINOR,
  recordWalletTopUp, creditWalletTopUp, closeWalletTopUp, walletTopUpHistory,
} from './lib/wallet.mjs';
import { createSeatSwap, respondSeatSwap } from './lib/swaps.mjs';
import { identityProviderConfigured, identityProviderName } from './lib/identity-provider.mjs';
import { koraSimulated, lookupNationalId } from './lib/kora.mjs';
import { getSetting, setSetting } from './lib/settings.mjs';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIN_WITHDRAW_MINOR = 100;

function fail(code, status, message) {
  throw new AppError(code, status, message);
}

function assertUuid(value, message = 'That identifier is malformed.') {
  if (!uuid(value)) fail('invalid_input', 400, message);
  return value;
}

function deviceLabel(value) {
  return trimText(value, 90) || 'This device';
}

function isConfigured() {
  return Boolean(paysasaConfig().configured);
}

async function configPayload(db) {
  const paysasa = paysasaConfig();
  return {
    paymentsConfigured: isConfigured(),
    paymentsProvider: isConfigured() ? (paysasa.simulated ? 'simulated' : 'paysasa') : null,
    webhookPath: '/functions/v1/app/payments/paysasa/webhook',
    withdrawalsConfigured: false,
    withdrawalBlocker: WITHDRAWAL_BLOCKER,
    identityProvider: identityProviderConfigured(),
    identityProviderName: identityProviderName(),
    identityProviderSimulated: koraSimulated(),
    identityReview: !identityProviderConfigured(),
    topUpChipsMinor: TOPUP_CHIPS_MINOR,
    testApprovals: await testApprovalState(db),
    currency: 'KES',
    timezone: 'Africa/Nairobi',
    rules: rulesPayload(),
  };
}

/* Sandbox test approvals: a cancelled or failed sandbox STK books the top-up so
   the wallet and circle flows can be exercised without real money. Server-gated,
   never honoured on a live key, and every booked row is marked. */
const TEST_APPROVAL_KEY = 'payment.test_approvals';
const CHECKOUT_DEAD_STATUSES = new Set([
  'cancelled', 'canceled', 'failed', 'declined', 'expired', 'timeout', 'timed_out',
]);

// Never a guess from the key shape: a live key refuses outright, and a real key
// only counts as sandbox when the operator declares it in server env.
function testApprovalsAvailable() {
  const config = paysasaConfig();
  if (config.simulated) return true;
  if (!config.configured) return false;
  if (/^apk_live/i.test(String(config.apiKey || ''))) return false;
  return config.sandbox === true;
}

async function testApprovalState(db) {
  const available = testApprovalsAvailable();
  const row = await getSetting(db, TEST_APPROVAL_KEY);
  return { available, enabled: available && row?.value?.enabled === true };
}

// Books a sandbox top-up only when the operator switched approvals on and the
// session belongs to a pending top-up row we created. The stored amount is the
// only amount, so an event can never invent a credit.
async function testApproveWalletTopUp(db, session, ownerId = null) {
  const topUp = one(await db.from('wallet_topups').select('*').eq('session_id', session.id).limit(1));
  if (!topUp || topUp.status === 'paid') return null;
  if (ownerId && topUp.user_id !== ownerId) return null;
  const state = await testApprovalState(db);
  if (!state.enabled) return null;
  const amount = Math.round(Number(topUp.amount_minor) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const result = await creditWalletTopUp(db, {
    userId: topUp.user_id,
    amountMinor: amount,
    sessionId: topUp.session_id,
    testApproved: true,
  });
  return result.credited ? { amountMinor: amount } : null;
}

async function authPayload(db, user, extra = {}) {
  const [groups, wallet] = [await groupList(db, user.id), await walletFor(db, user.id)];
  return { user: userPayload(user), groups, wallet, ...extra };
}

async function pendingRegistration(db, challengeId) {
  assertUuid(challengeId, 'The registration challenge is malformed.');
  const pending = one(await db.from('pending_registrations').select('*').eq('id', challengeId).limit(1));
  if (!pending) fail('challenge_unknown', 400, 'Start the account setup again.');
  if (pending.status !== 'open') fail('challenge_used', 409, 'That setup step was already used. Start again.');
  if (Date.parse(pending.expires_at) <= Date.now()) fail('challenge_expired', 409, 'The passkey prompt expired. Start again.');
  return pending;
}

async function challengeRow(db, challengeId, kind) {
  assertUuid(challengeId, 'The sign-in challenge is malformed.');
  const challenge = one(await db.from('auth_challenges').select('*').eq('id', challengeId).limit(1));
  if (!challenge || challenge.kind !== kind) fail('challenge_unknown', 400, 'Start again.');
  if (challenge.status !== 'open') fail('challenge_used', 409, 'That sign-in step was already used. Try again.');
  if (Date.parse(challenge.expires_at) <= Date.now()) fail('challenge_expired', 409, 'The passkey prompt expired. Try again.');
  return challenge;
}

async function claimChallenge(db, challengeId, kind) {
  const claimed = rows(await db.from('auth_challenges').update({ status: 'used', used_at: nowIso() })
    .eq('id', challengeId).eq('kind', kind).eq('status', 'open').select('id'));
  if (!claimed.length) fail('challenge_used', 409, 'That step was already completed. Try again.');
}

async function newSession(db, request, userId, label) {
  const session = await createSession(db, userId, request, label);
  return { session, headers: cookieHeaders(request, { token: session.token, csrf: session.csrf }) };
}

/* ---------------- authentication ---------------- */

async function registerOptions(db, request) {
  await rateLimit(db, await ipRateKey(request, 'reg-opt'), 10, 15 * 60 * 1000);
  const body = await jsonBody(request);
  const name = trimText(body.name, 80);
  const phone = normalizePhone(body.phone);
  if (name.length < 2) fail('invalid_input', 400, 'Enter your full name.');
  if (!phone) fail('invalid_input', 400, 'Enter a valid Kenyan phone number.');
  const idNumber = String(body.idNumber || '').replace(/\s/g, '');
  const verificationConsent = body.verificationConsent === true;
  if (idNumber && !verificationConsent) {
    fail('consent_required', 400, 'Tick the consent box so we can check your ID and phone against the national register.');
  }
  const legalName = trimText(body.legalName, 80) || name;
  const dateOfBirth = validateDateOfBirth(body.dateOfBirth, { required: true });
  if (idNumber && !/^\d{7,8}$/.test(idNumber)) {
    fail('invalid_input', 400, 'Enter the 7 or 8 digits of your national ID, or leave it blank and add it later.');
  }
  if (idNumber) {
    const held = one(await db.from('users').select('id')
      .eq('identity_hash', await sha256Hex(`identity:${idNumber}`)).limit(1));
    if (held) fail('identity_in_use', 409, 'That ID is already attached to another account. One ID can hold only one account.');
  }
  await rateLimit(db, `reg-phone:${phone}`, 5, 15 * 60 * 1000);
  const existing = one(await db.from('users').select('id').eq('phone', phone).limit(1));
  if (existing) fail('account_exists', 409, 'An account already exists for that phone. Sign in with a passkey or use a recovery code.');
  const origin = browserOrigin(request);
  const id = crypto.randomUUID();
  const challenge = newChallenge();
  const webauthnUserId = newWebauthnUserId();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  rows(await db.from('pending_registrations').insertIfAbsent({
    id,
    name,
    phone,
    legal_name: legalName,
    id_number: idNumber || null,
    date_of_birth: dateOfBirth,
    verification_consent: verificationConsent,
    webauthn_user_id: webauthnUserId,
    challenge,
    rp_id: rpId(origin),
    status: 'open',
    expires_at: expiresAt,
    created_at: nowIso(),
  }, { onConflict: 'id' }).select('id'));
  return json({
    challengeId: id,
    termsVersion: TERMS_VERSION,
    publicKey: registrationOptions({ challenge, webauthnUserId, name, rpId: rpId(origin) }),
  });
}

async function registerVerify(db, request) {
  await rateLimit(db, await ipRateKey(request, 'reg-verify'), 20, 15 * 60 * 1000);
  const body = await jsonBody(request);
  const pending = await pendingRegistration(db, body.challengeId);
  if (body.termsVersion !== TERMS_VERSION) {
    fail('terms_required', 400, 'Review and accept the current Terms and Privacy Notice to create an account.');
  }
  const origin = browserOrigin(request);
  const rp = rpId(origin);
  if (pending.rp_id !== rp) fail('passkey_origin', 403, 'This app is served from a different address now. Start again.');
  const verified = await verifyRegistration({
    credential: body.credential,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    rpId: rp,
  });
  const claimed = rows(await db.from('pending_registrations').update({ status: 'consumed', consumed_at: nowIso() })
    .eq('id', pending.id).eq('status', 'open').select('id'));
  if (!claimed.length) fail('challenge_used', 409, 'That setup step was already used. Start again.');
  const userId = crypto.randomUUID();
  const createdAt = nowIso();
  let identity = null;
  if (pending.id_number) {
    identity = await prepareIdentity(db, {
      accountName: pending.name,
      accountPhone: pending.phone,
      legalName: pending.legal_name || pending.name,
      idNumber: pending.id_number,
      dateOfBirth: pending.date_of_birth,
    });
  }
  const createdUser = rows(await db.from('users').insertIfAbsent({
    id: userId,
    name: pending.name,
    phone: pending.phone,
    date_of_birth: pending.date_of_birth || null,
    webauthn_user_id: pending.webauthn_user_id,
    trust_score: 50,
    terms_version: TERMS_VERSION,
    terms_accepted_at: createdAt,
    terms_accepted_origin: origin,
    verification_consent_at: pending.verification_consent ? createdAt : null,
    created_at: createdAt,
    updated_at: createdAt,
    ...(identity?.patch || {}),
  }, { onConflict: 'phone' }).select('*'));
  if (!createdUser.length || createdUser[0].id !== userId) {
    fail('account_exists', 409, 'An account already exists for that phone. Sign in instead.');
  }
  // The account keeps only the ID hash and last four digits; scrub the raw digits
  // from the sign-up row so they are not retained anywhere.
  rows(await db.from('pending_registrations').update({ id_number: null }).eq('id', pending.id).select('id'));
  const existingKey = one(await db.from('passkeys').select('id').eq('credential_id', verified.credentialId).limit(1));
  if (existingKey) fail('passkey_exists', 409, 'That passkey is already registered.');
  rows(await db.from('passkeys').insertIfAbsent({
    id: crypto.randomUUID(),
    user_id: userId,
    credential_id: verified.credentialId,
    public_key_jwk: verified.publicKeyJwk,
    rp_id: rp,
    sign_count: verified.signCount,
    transports: verified.transports,
    label: 'Passkey',
    created_at: createdAt,
    last_used_at: createdAt,
  }, { onConflict: 'credential_id' }).select('id'));
  rows(await db.from('wallets').insertIfAbsent({
    id: crypto.randomUUID(),
    user_id: userId,
    balance_minor: 0,
    updated_at: createdAt,
  }, { onConflict: 'user_id' }).select('id'));
  const recoveryCodes = await issueRecoveryCodes(db, userId);
  const user = one(await db.from('users').select('*').eq('id', userId).limit(1));
  const { headers } = await newSession(db, request, userId, deviceLabel(body.deviceLabel));
  return json(await authPayload(db, user, { recoveryCodes }), 200, headers);
}

async function loginOptionsRoute(db, request) {
  await rateLimit(db, await ipRateKey(request, 'login-opt'), 40, 5 * 60 * 1000);
  const challenge = newChallenge();
  const id = crypto.randomUUID();
  rows(await db.from('auth_challenges').insertIfAbsent({
    id,
    kind: 'login',
    user_id: null,
    challenge,
    rp_id: rpId(browserOrigin(request)),
    status: 'open',
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    created_at: nowIso(),
  }, { onConflict: 'id' }).select('id'));
  return json({ challengeId: id, publicKey: loginOptions({ challenge }) });
}

async function loginVerify(db, request) {
  await rateLimit(db, await ipRateKey(request, 'login-verify'), 40, 5 * 60 * 1000);
  const body = await jsonBody(request);
  const challenge = await challengeRow(db, body.challengeId, 'login');
  const credentialId = typeof body.credential?.id === 'string' ? body.credential.id : '';
  const passkey = one(await db.from('passkeys').select('*').eq('credential_id', credentialId).limit(1));
  if (!passkey) fail('passkey_unknown', 401, 'That passkey is not registered here.');
  const user = one(await db.from('users').select('*').eq('id', passkey.user_id).limit(1));
  if (!user) fail('passkey_unknown', 401);
  const origin = browserOrigin(request);
  const rp = rpId(origin);
  const result = await verifyAssertion({
    credential: body.credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    rpId: rp,
    stored: passkey,
    expectedUserHandle: user.webauthn_user_id,
  });
  await claimChallenge(db, challenge.id, 'login');
  if (Number(result.signCount) > Number(passkey.sign_count)) {
    rows(await db.from('passkeys').update({ sign_count: result.signCount, last_used_at: nowIso() })
      .eq('id', passkey.id).select('id'));
  } else {
    rows(await db.from('passkeys').update({ last_used_at: nowIso() }).eq('id', passkey.id).select('id'));
  }
  const { headers } = await newSession(db, request, user.id, deviceLabel(body.deviceLabel));
  return json(await authPayload(db, user), 200, headers);
}

async function recoveryLogin(db, request) {
  await rateLimit(db, await ipRateKey(request, 'recovery'), 12, 15 * 60 * 1000);
  const body = await jsonBody(request);
  const phone = normalizePhone(body.phone);
  const code = normalizeRecoveryCode(body.code);
  if (!phone || code.length !== 10) fail('invalid_credentials', 401, 'That phone and recovery code did not match.');
  await rateLimit(db, `recovery-phone:${phone}`, 8, 15 * 60 * 1000);
  const user = one(await db.from('users').select('*').eq('phone', phone).limit(1));
  if (!user) fail('invalid_credentials', 401, 'That phone and recovery code did not match.');
  const digest = await hashRecoveryCode(code, user.id);
  const codes = rows(await db.from('recovery_codes')
    .select('id,code_hash,status').eq('user_id', user.id).eq('status', 'active').limit(40));
  const match = codes.find((entry) => entry.code_hash === digest);
  if (!match) fail('invalid_credentials', 401, 'That phone and recovery code did not match.');
  const used = rows(await db.from('recovery_codes').update({ status: 'used', used_at: nowIso() })
    .eq('id', match.id).eq('status', 'active').select('id'));
  if (!used.length) fail('invalid_credentials', 401, 'That recovery code was already used.');
  const { headers } = await newSession(db, request, user.id, deviceLabel(body.deviceLabel));
  return json(await authPayload(db, user), 200, headers);
}

async function passkeyOptions(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `passkey:${user.id}`, 8, 60 * 60 * 1000);
  const keys = rows(await db.from('passkeys')
    .select('credential_id,transports').eq('user_id', user.id).limit(24));
  const challenge = newChallenge();
  const id = crypto.randomUUID();
  rows(await db.from('auth_challenges').insertIfAbsent({
    id,
    kind: 'passkey',
    user_id: user.id,
    challenge,
    rp_id: rpId(browserOrigin(request)),
    status: 'open',
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    created_at: nowIso(),
  }, { onConflict: 'id' }).select('id'));
  return json({
    challengeId: id,
    publicKey: registrationOptions({
      challenge,
      webauthnUserId: user.webauthn_user_id,
      name: user.name,
      rpId: rpId(browserOrigin(request)),
      excludeCredentials: keys.map((key) => ({
        type: 'public-key',
        id: key.credential_id,
        transports: Array.isArray(key.transports) ? key.transports : [],
      })),
    }),
  });
}

async function passkeyVerify(db, request) {
  const { user } = await requireSession(db, request);
  const body = await jsonBody(request);
  const challenge = await challengeRow(db, body.challengeId, 'passkey');
  if (challenge.user_id !== user.id) fail('challenge_unknown', 400);
  const origin = browserOrigin(request);
  const rp = rpId(origin);
  const verified = await verifyRegistration({
    credential: body.credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    rpId: rp,
  });
  const existing = one(await db.from('passkeys').select('id,user_id').eq('credential_id', verified.credentialId).limit(1));
  if (existing) {
    if (existing.user_id !== user.id) fail('passkey_exists', 409, 'That passkey is already registered.');
    await claimChallenge(db, challenge.id, 'passkey');
    return json({ ok: true });
  }
  rows(await db.from('passkeys').insertIfAbsent({
    id: crypto.randomUUID(),
    user_id: user.id,
    credential_id: verified.credentialId,
    public_key_jwk: verified.publicKeyJwk,
    rp_id: rp,
    sign_count: verified.signCount,
    transports: verified.transports,
    label: 'Passkey',
    created_at: nowIso(),
    last_used_at: nowIso(),
  }, { onConflict: 'credential_id' }).select('id'));
  await claimChallenge(db, challenge.id, 'passkey');
  return json({ ok: true });
}

async function regenerateRecovery(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `recovery-regen:${user.id}`, 3, 60 * 60 * 1000);
  rows(await db.from('recovery_codes').update({ status: 'replaced' })
    .eq('user_id', user.id).eq('status', 'active').select('id'));
  const codes = await issueRecoveryCodes(db, user.id);
  return json({ codes });
}

async function me(db, request) {
  const session = await validateSession(db, request);
  if (!session) fail('invalid_credentials', 401, 'Sign in to continue.');
  return json(await authPayload(db, session.user, { config: await configPayload(db) }));
}

async function logout(db, request) {
  const session = await validateSession(db, request).catch(() => null);
  if (session) await revokeDigest(db, session.digest);
  return json({ ok: true }, 200, cookieHeaders(request, { clear: true }));
}

async function logoutAll(db, request) {
  const { user } = await requireSession(db, request);
  await revokeAllSessions(db, user.id);
  return json({ ok: true }, 200, cookieHeaders(request, { clear: true }));
}

async function account(db, request) {
  const { user, session } = await requireSession(db, request);
  return json(await accountPayload(db, user.id, session.id));
}

async function revokeSession(db, request, sessionId) {
  const { user, session } = await requireSession(db, request);
  assertUuid(sessionId, 'That device id is malformed.');
  const target = one(await db.from('sessions').select('id,user_id').eq('id', sessionId).limit(1));
  if (!target || target.user_id !== user.id) fail('not_found', 404, 'That device is not on this account.');
  rows(await db.from('sessions').update({ revoked_at: nowIso() }).eq('id', sessionId).select('id'));
  const headers = sessionId === session.id ? cookieHeaders(request, { clear: true }) : undefined;
  return json({ ok: true }, 200, headers);
}

/* ---------------- groups ---------------- */

async function inviteCode(db) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let code = '';
    for (let index = 0; index < 7; index += 1) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
    const exists = one(await db.from('groups').select('id').eq('invite_code', code).limit(1));
    if (!exists) return code;
  }
  throw new AppError('invite_unavailable', 503, 'Could not create an invite code. Try again.');
}

async function createGroup(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `create-group:${user.id}`, 6, 60 * 60 * 1000);
  const body = await jsonBody(request);
  const name = trimText(body.name, 60);
  const contributionMinor = Number(body.contributionMinor);
  const maxMembers = Number(body.maxMembers);
  const organizerFeeBps = Number(body.organizerFeeBps);
  const cadence = body.cadence === undefined ? 'weekly' : body.cadence;
  if (!['weekly', 'fortnightly', 'monthly'].includes(cadence)) {
    fail('invalid_input', 400, 'Choose weekly, fortnightly, or calendar-month contributions.');
  }
  const visibility = body.visibility === undefined ? 'private' : body.visibility;
  if (!['private', 'open'].includes(visibility)) {
    fail('invalid_input', 400, 'Choose a private circle or an open circle.');
  }
  if (name.length < 2 || /[\u0000-\u001f\u007f]/.test(name)) fail('invalid_input', 400, 'Give the circle a name.');
  if (!Number.isSafeInteger(contributionMinor) || contributionMinor < RULES.minContributionMinor || contributionMinor > RULES.maxContributionMinor) {
    fail('invalid_input', 400, 'The contribution must be between KES 200 and KES 5,000.');
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers < RULES.minMembers || maxMembers > RULES.maxMembers) {
    fail('invalid_input', 400, 'Choose between 5 and 12 members.');
  }
  if (!Number.isSafeInteger(organizerFeeBps) || organizerFeeBps < 0 || organizerFeeBps > RULES.maxOrganizerBps) {
    fail('invalid_input', 400, 'The organizer fee must be between 0% and 1.5%.');
  }
  const userId = user.id;
  const code = await inviteCode(db);
  const groupId = crypto.randomUUID();
  const createdAt = nowIso();
  const inserted = rows(await db.from('groups').insertIfAbsent({
    id: groupId,
    name,
    organizer_id: userId,
    contribution_minor: contributionMinor,
    max_members: maxMembers,
    organizer_fee_bps: organizerFeeBps,
    bid_window_minutes: RULES.bidWindowMinutes,
    contribution_window_hours: RULES.contributionWindowHours,
    cycle_days: { weekly: 7, fortnightly: 14, monthly: 0 }[cadence],
    cadence,
    visibility,
    invite_code: code,
    status: 'forming',
    created_at: createdAt,
  }, { onConflict: 'invite_code' }).select('*'));
  if (!inserted.length) fail('invite_unavailable', 503, 'Could not create the circle. Try again.');
  const trust = Number(user.trust_score ?? 50);
  rows(await db.from('memberships').insertIfAbsent({
    id: crypto.randomUUID(),
    group_id: groupId,
    user_id: userId,
    seat_no: 1,
    display_name: user.name,
    role: 'organizer',
    status: 'active',
    bond_bps: bondBpsForTrust(trust),
    trust_score: trust,
    ontime_cycles: 0,
    late_cycles: 0,
    defaults: 0,
    has_won: false,
    accepted_round: 0,
    current_circle_id: null,
    kyc_status: 'verified',
    verified_at: createdAt,
    joined_at: createdAt,
  }, { onConflict: 'group_id,user_id' }).select('id'));
  const group = inserted[0] || (await groupById(db, groupId));
  return json({ group: serializeGroup(group, 1, true, null) }, 201);
}

async function seatMember(db, group, user) {
  const existing = await membershipFor(db, group.id, user.id);
  if (existing) return existing;
  const before = await membersOf(db, group.id);
  if (before.length >= Number(group.max_members)) fail('group_full', 409, 'This circle is full.');
  const taken = new Set(before.map((member) => Number(member.seat_no)));
  for (let seat = 2; seat <= Number(group.max_members); seat += 1) {
    if (taken.has(seat)) continue;
    try {
      const inserted = rows(await db.from('memberships').insertIfAbsent({
        id: crypto.randomUUID(),
        group_id: group.id,
        user_id: user.id,
        seat_no: seat,
        display_name: user.name,
        role: 'member',
        status: 'active',
        bond_bps: bondBpsForTrust(user.trust_score),
        trust_score: Number(user.trust_score ?? 50),
        ontime_cycles: 0,
        late_cycles: 0,
        defaults: 0,
        has_won: false,
        accepted_round: 0,
        current_circle_id: null,
        kyc_status: 'pending',
        joined_at: nowIso(),
      }, { onConflict: 'group_id,seat_no' }).select('*'));
      if (inserted.length) return inserted[0];
    } catch {
      const again = await membershipFor(db, group.id, user.id);
      if (again) fail('seats_closed', 409, 'That account is already attached to this circle.');
      continue;
    }
    const again = await membershipFor(db, group.id, user.id);
    if (again) fail('seats_closed', 409, 'That account is already attached to this circle.');
  }
  const again = await membershipFor(db, group.id, user.id);
  if (again) fail('seats_closed', 409, 'That account is already attached to this circle.');
  fail('group_full', 409, 'This circle is full.');
}

async function joinGroup(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `join:${user.id}`, 12, 60 * 60 * 1000);
  const body = await jsonBody(request);
  const code = trimText(body.inviteCode, 12).toUpperCase();
  if (!/^[A-Z2-9]{4,12}$/.test(code)) fail('invalid_invite', 400, 'Enter a valid invite code.');
  const group = one(await db.from('groups').select('*').eq('invite_code', code).limit(1));
  if (!group) fail('invalid_invite', 404, 'That invite code is not active.');
  if (group.visibility === 'open') {
    fail('seat_payment_required', 409, 'Open circles take seats through the open list so the seat payment is recorded. Open the circle there and pay for the seat.');
  }
  const existing = await membershipFor(db, group.id, user.id);
  if (existing) {
    if (existing.status !== 'active') fail('seats_closed', 409, 'That account already used a seat in this circle.');
    const members = await membersOf(db, group.id);
    return json({ group: serializeGroup(group, members.length, existing.role === 'organizer', await currentCircle(db, group.id)) });
  }
  if (group.status !== 'forming' || await currentCircle(db, group.id)) {
    fail('seats_closed', 409, 'Seats are locked after the first round is formed. Repeat rounds keep the same roster.');
  }
  const member = await seatMember(db, group, user);
  const after = await groupById(db, group.id);
  if (after.status !== 'forming' || await currentCircle(db, group.id)) {
    rows(await db.from('memberships').update({ status: 'removed' }).eq('id', member.id).select('id'));
    fail('seats_closed', 409, 'The circle started while you were joining. Ask the organizer for the next circle.');
  }
  const members = await membersOf(db, group.id);
  return json({ group: serializeGroup(after, members.length, false, null) }, 201);
}

async function groupDetailRoute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  await sweepSeats(db);
  return json(await groupDetail(db, { groupId, userId: user.id, paymentsConfigured: isConfigured() }));
}

async function identityRoute(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `identity:${user.id}`, 5, 60 * 60 * 1000);
  const body = await jsonBody(request);
  if (body.verificationConsent !== true) {
    fail('consent_required', 400, 'Tick the consent box so we can check your ID and phone against the national register.');
  }
  return json(await saveIdentity(db, user, body));
}

// Pre-account lookup: the ID number alone fetches the registered name and date
// of birth so the form can autofill. Consent is required and nothing is stored.
async function identityPeek(db, request) {
  await rateLimit(db, await ipRateKey(request, 'id-peek'), 15, 15 * 60 * 1000);
  const body = await jsonBody(request);
  if (body.consent !== true) {
    fail('consent_required', 400, 'Tick the consent box so we can check that ID against the national register.');
  }
  const idNumber = String(body.idNumber || '').replace(/\s/g, '');
  if (!/^\d{7,8}$/.test(idNumber)) {
    fail('invalid_input', 400, 'Enter the 7 or 8 digits of your national ID.');
  }
  await rateLimit(db, `id-peek:${(await sha256Hex(`id-lookup:${idNumber}`)).slice(0, 24)}`, 6, 15 * 60 * 1000);
  const lookup = await lookupNationalId({ idNumber });
  if (!lookup.ok) {
    return json({ ok: true, found: false, available: lookup.reason !== 'not_configured', simulated: false });
  }
  if (!lookup.found) return json({ ok: true, found: false, available: true, simulated: lookup.simulated === true });
  return json({
    ok: true,
    found: true,
    available: true,
    simulated: lookup.simulated === true,
    name: lookup.identity.fullName,
    dateOfBirth: lookup.identity.dateOfBirth,
    gender: lookup.identity.gender,
  });
}

async function adminPaymentsProbeRoute(db, request) {
  const { user } = await requireSession(db, request);
  requireAdmin(user);
  await rateLimit(db, `admin:rail:${user.id}`, 10, 60 * 60 * 1000);
  return json({ probe: await probePaymentRail(), checkedAt: nowIso() });
}

async function adminTestApprovalsRead(db, request) {
  const { user } = await requireSession(db, request);
  requireAdmin(user);
  return json(await testApprovalState(db));
}

async function adminTestApprovalsWrite(db, request) {
  const { user } = await requireSession(db, request);
  requireAdmin(user);
  await rateLimit(db, `admin:test-approvals:${user.id}`, 40, 60 * 60 * 1000);
  const body = await jsonBody(request);
  if (typeof body.enabled !== 'boolean') fail('invalid_input', 400, 'Choose on or off.');
  if (!testApprovalsAvailable()) {
    fail('test_approvals_unavailable', 409,
      'Sandbox test approvals need a simulated or sandbox account. They never run with a live key.');
  }
  await setSetting(db, TEST_APPROVAL_KEY, {
    enabled: body.enabled,
    updated_by: user.id,
    updated_by_name: user.name,
    updated_at: nowIso(),
  });
  return json(await testApprovalState(db));
}

async function adminIdentityRoute(db, request) {
  const { user } = await requireSession(db, request);
  requireAdmin(user);
  const url = new URL(request.url);
  return json(await identityQueue(db, url.searchParams.get('status') || 'pending'));
}

async function adminIdentityDecisionRoute(db, request, userId) {
  const { user } = await requireSession(db, request);
  requireAdmin(user);
  assertUuid(userId);
  await rateLimit(db, `admin:identity:${user.id}`, 240, 60 * 60 * 1000);
  const body = await jsonBody(request);
  return json(await decideIdentity(db, user, userId, body));
}

async function adminOverviewRoute(db, request) {
  const { user } = await requireSession(db, request);
  requireAdmin(user);
  return json(await adminOverview(db));
}

async function adminUnlockRoute(db, request) {
  const { user } = await requireSession(db, request);
  const body = await jsonBody(request);
  return json(await unlockAdminPanel(db, user, body.pin));
}

async function groupRecapRoute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  return json(await groupRecapPayload(db, { groupId, userId: user.id }));
}

async function openCirclesRoute(db, request) {
  const { user } = await requireSession(db, request);
  return json({ circles: await openCircleList(db, user.id), now: nowIso() });
}

async function seatCheckoutRoute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  await rateLimit(db, `seat:${user.id}`, 12, 60 * 60 * 1000);
  const body = await jsonBody(request);
  if (body.acceptRules !== true) fail('rules_required', 400, 'Accept the circle rules and the identity pledge to take a seat.');
  const group = await groupById(db, groupId);
  if (!group || group.visibility !== 'open') fail('group_not_found', 404, 'That open circle is not available.');
  if (group.status !== 'forming' || await currentCircle(db, groupId)) {
    fail('seats_closed', 409, 'Seats lock as soon as the round forms. Pick a circle that has not started.');
  }
  identityGate(db, user);
  await sweepSeats(db);
  const existing = await membershipFor(db, groupId, user.id);
  let membership;
  if (existing) {
    if (existing.status !== 'active') fail('seats_closed', 409, 'That seat was released. Pick another open circle.');
    if ((existing.seat_status || 'none') === 'paid') {
      fail('seat_already_paid', 409, 'Your seat in this circle is already paid. Turn 1 is covered.');
    }
    if (existing.role === 'organizer') fail('already_seated', 409, 'The organizer already holds seat 1.');
    membership = existing;
  } else {
    membership = await reserveOpenSeat(db, group, user);
  }
  const origin = browserOrigin(request);
  try {
    const checkout = await createCheckout({
      amountMinor: Number(membership.seat_due_minor || group.contribution_minor),
      description: `THE WHEEL · seat in ${group.name}`,
      metadata: {
        seat_membership_id: membership.id,
        group_id: group.id,
        user_id: user.id,
      },
      successUrl: `${origin}/#/open`,
      cancelUrl: `${origin}/#/open`,
      returnUrl: `${origin}/#/open`,
    });
    const holdExpiresAt = new Date(Date.now() + SEAT_HOLD_MS).toISOString();
    rows(await db.from('memberships').update({
      seat_provider_ref: checkout.id,
      seat_checkout_url: checkout.hostedUrl,
      seat_checkout_expires_at: checkout.expiresAt,
      seat_expires_at: holdExpiresAt,
    }).eq('id', membership.id).select('id'));
    return json({
      checkoutUrl: checkout.hostedUrl,
      sessionId: checkout.id,
      expiresAt: checkout.expiresAt,
      holdExpiresAt,
      membershipId: membership.id,
      seatMinor: Number(membership.seat_due_minor || group.contribution_minor),
    }, 201);
  } catch (error) {
    rows(await db.from('memberships').update({
      status: 'removed', seat_status: 'expired', removed_at: nowIso(),
    }).eq('id', membership.id).eq('seat_status', 'pending').select('id'));
    throw error;
  }
}

async function seatSwapRoute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  await rateLimit(db, `swap:${user.id}`, 30, 60 * 60 * 1000);
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only active members can swap seats.');
  const body = await jsonBody(request);
  assertUuid(body.targetMembershipId, 'Choose the member you want to trade seats with.');
  const swap = await createSeatSwap(db, {
    group, membership: me, targetMembershipId: body.targetMembershipId, note: body.note,
  });
  return json({ ok: true, swap }, 201);
}

async function seatSwapRespondRoute(db, request, groupId, swapId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  assertUuid(swapId, 'That swap offer is malformed.');
  await rateLimit(db, `swap:${user.id}`, 60, 60 * 60 * 1000);
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only active members can answer a swap.');
  const body = await jsonBody(request);
  return json(await respondSeatSwap(db, {
    group, membership: me, swapId, action: String(body.action || '').toLowerCase(),
  }));
}

async function leaveGroupRoute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me) fail('not_a_member', 403, 'You do not hold a seat in this circle.');
  return json(await leaveOpenGroup(db, { group, membership: me }));
}

async function acceptRound(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  const body = await jsonBody(request);
  if (!Number.isSafeInteger(body.roundNumber) || body.roundNumber < 1
    || Object.keys(body).some((key) => key !== 'roundNumber')) {
    fail('invalid_input', 400, 'Accept only your own current round using its round number.');
  }
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only active members can accept a round.');
  const circle = await currentCircle(db, groupId);
  const roundNumber = Number(circle?.number || 1);
  if (body.roundNumber !== roundNumber) fail('stale_round', 409, 'That is not the current round. Refresh its terms.');
  if (group.status !== 'forming' || (circle && circle.status !== 'forming')) {
    fail('round_not_forming', 409, 'Acceptance is only open while a round is forming.');
  }
  rows(await db.from('memberships').update({ accepted_round: roundNumber })
    .eq('id', me.id).eq('status', 'active').select('id'));
  return json({ ok: true, roundNumber, roundAccepted: true });
}

async function proposeRound(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  const body = await jsonBody(request);
  assertUuid(body.previousCircleId, 'Choose the completed round.');
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active' || me.role !== 'organizer') fail('forbidden', 403, 'Only the organizer can propose the next round.');
  const previous = one(await db.from('circles').select('*').eq('id', body.previousCircleId).eq('group_id', groupId).limit(1));
  let circle = await currentCircle(db, groupId);
  if (!previous || !circle) fail('stale_round', 409, 'Choose the latest completed round.');
  const number = Number(previous.number) + 1;
  const duplicate = circle.id !== previous.id && Number(circle.number) === number && circle.status === 'forming';
  if (circle.id !== previous.id && !duplicate) fail('stale_round', 409, 'A newer round already exists.');
  // A retry may only finish an interrupted hand-off: the open round must be the
  // direct successor of this completed one, with the same roster, not started.
  if (duplicate && (group.status === 'active'
    || Number(circle.member_count) !== Number(previous.member_count)
    || Number(circle.turns_total) !== Number(previous.turns_total))) {
    fail('stale_round', 409, 'The open round does not match this round. Refresh and try again.');
  }
  const cycles = rows(await db.from('cycles').select('id,status').eq('circle_id', previous.id).limit(RULES.maxMembers));
  if (previous.status !== 'completed' || cycles.length !== Number(previous.turns_total)
    || cycles.some((cycle) => cycle.status !== 'settled')
    || (!duplicate && group.status !== 'completed')) {
    fail('round_incomplete', 409, 'Complete every turn before proposing another round.');
  }
  for (const cycle of cycles) {
    const settlement = one(await db.from('settlements').select('id').eq('cycle_id', cycle.id).limit(1));
    if (!settlement) fail('round_incomplete', 409, 'Every turn needs its settlement receipt.');
    const bond = one(await db.from('bonds').select('held_minor,status').eq('settlement_id', settlement.id).limit(1));
    if (bond && (Number(bond.held_minor) > 0 || bond.status !== 'released')) {
      fail('bonds_unreleased', 409, 'Release the previous round’s bonds before proposing another round.');
    }
  }
  if (!duplicate) {
    const inserted = rows(await db.from('circles').insertIfAbsent({
      id: crypto.randomUUID(), group_id: groupId, number,
      member_count: Number(previous.member_count), turns_total: Number(previous.turns_total),
      status: 'forming', started_at: nowIso(),
    }, { onConflict: 'group_id,number' }).select('*'));
    circle = inserted[0] || await currentCircle(db, groupId);
  }
  if (!circle || Number(circle.number) !== number || circle.status !== 'forming') {
    fail('stale_round', 409, 'The round changed. Refresh and try again.');
  }
  // Insertion is unique by round number; retry also repairs an interrupted group update.
  rows(await db.from('groups').update({ status: 'forming', completed_at: null })
    .eq('id', groupId).eq('status', 'completed').eq('completed_at', group.completed_at).select('id'));
  return json({ ok: true, circleId: circle.id, roundNumber: number });
}

async function startGroup(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  let group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active' || me.role !== 'organizer') fail('forbidden', 403, 'Only the organizer can start the circle.');
  if (group.status === 'completed') fail('group_completed', 409, 'Propose the next round first.');
  let members = (await membersOf(db, groupId)).filter((member) => member.status === 'active');
  if (members.length < RULES.minMembers) fail('not_enough_members', 409, 'A circle needs at least five members to start.');
  if (members.length > Math.min(RULES.maxMembers, Number(group.max_members))) fail('invalid_state', 409, 'The circle has more members than its seats.');
  let circle = await currentCircle(db, groupId);
  let cycle = circle ? one(await db.from('cycles').select('*').eq('circle_id', circle.id).eq('number', 1).limit(1)) : null;
  // A retry must never reset winners, including legacy already-open rounds.
  if (group.status === 'active' && circle?.status === 'active' && cycle) {
    await ensureContributionRows(db, cycle, members);
    return json({ ok: true, circleId: circle.id, cycleId: cycle.id });
  }
  const roundNumber = Number(circle?.number || 1);
  if (group.status === 'forming' && group.visibility === 'open') {
    const unpaid = unpaidSeats(members);
    if (unpaid.length) {
      fail('seat_payment_required', 409, `${unpaid.length} open-circle seat${unpaid.length === 1 ? ' has' : 's have'} not paid yet. Waiting seats expire in 15 minutes.`);
    }
  }
  if (members.some((member) => Number(member.accepted_round || 0) !== roundNumber)) {
    fail('round_acceptance_required', 409, 'Every active member, including the organizer, must accept this round.');
  }
  if (circle && (Number(circle.member_count) !== members.length || circle.status === 'completed')) {
    fail('invalid_state', 409, 'The round roster must stay unchanged.');
  }
  if (!circle) {
    const inserted = rows(await db.from('circles').insertIfAbsent({
      id: crypto.randomUUID(), group_id: groupId, number: 1,
      member_count: members.length, turns_total: members.length,
      status: 'forming', started_at: nowIso(),
    }, { onConflict: 'group_id,number' }).select('*'));
    circle = inserted[0] || await currentCircle(db, groupId);
  }
  if (!circle) fail('write_conflict', 409, 'The round could not be opened. Try again.');
  if (group.status === 'forming') {
    rows(await db.from('groups').update({ status: 'active', started_at: nowIso() })
      .eq('id', groupId).eq('status', 'forming').select('id'));
    group = await groupById(db, groupId);
  }
  if (group.status !== 'active') fail('write_conflict', 409, 'The round changed while starting.');
  members = (await membersOf(db, groupId)).filter((member) => member.status === 'active');
  if (members.length !== Number(circle.member_count)
    || members.some((member) => Number(member.accepted_round || 0) !== roundNumber)) {
    rows(await db.from('groups').update({ status: 'forming' }).eq('id', groupId).eq('status', 'active').select('id'));
    fail('round_acceptance_required', 409, 'The roster changed. Every member must accept before starting.');
  }
  for (const member of members) {
    if (member.current_circle_id === circle.id) continue;
    let update = db.from('memberships').update({ has_won: false, current_circle_id: circle.id }).eq('id', member.id);
    // The comparison prevents a delayed start retry from resetting a new winner.
    if (member.current_circle_id !== undefined) update = update.eq('current_circle_id', member.current_circle_id);
    rows(await update.select('id'));
  }
  rows(await db.from('circles').update({ status: 'active', started_at: nowIso() })
    .eq('id', circle.id).eq('status', 'forming').select('id'));
  cycle = one(await db.from('cycles').select('*').eq('circle_id', circle.id).eq('number', 1).limit(1));
  if (!cycle) {
    const createdAt = nowIso();
    const inserted = rows(await db.from('cycles').insertIfAbsent({
      id: crypto.randomUUID(), circle_id: circle.id, group_id: groupId, number: 1,
      member_count: members.length, contribution_minor: Number(group.contribution_minor),
      pot_expected_minor: Number(group.contribution_minor) * members.length, pot_captured_minor: 0,
      status: 'contributing', is_final: false,
      contribution_due_at: new Date(Date.parse(createdAt) + Number(group.contribution_window_hours) * HOUR).toISOString(),
      scheduled_settle_at: scheduledTurnAt(createdAt, groupCadence(group)),
      created_at: createdAt,
    }, { onConflict: 'circle_id,number' }).select('*'));
    cycle = inserted[0] || one(await db.from('cycles').select('*').eq('circle_id', circle.id).eq('number', 1).limit(1));
  }
  if (!cycle) fail('write_conflict', 409, 'The first turn could not be opened. Try again.');
  await ensureContributionRows(db, cycle, members);
  // A prepaid open seat is turn 1 already paid; the pot then opens whole when everyone has paid.
  await applySeatCredits(db, { group, members, cycle });
  await fundCycleIfComplete(db, cycle, members, group.bid_window_minutes);
  return json({ ok: true, circleId: circle.id, cycleId: cycle.id });
}

async function nextCycle(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.role !== 'organizer') fail('forbidden', 403, 'Only the organizer can open the next turn.');
  if (group.status === 'completed') fail('group_completed', 409, 'This circle is complete.');
  if (group.status !== 'active') fail('group_not_started', 409, 'Start the circle first.');
  const circle = await currentCircle(db, groupId);
  if (!circle || circle.status !== 'active') fail('circle_complete', 409, 'There is no active circle.');
  const latest = one(await db.from('cycles').select('*').eq('circle_id', circle.id).order('number', { ascending: false }).limit(1));
  if (!latest) fail('cycle_missing', 409, 'Start the circle first.');
  if (latest.status !== 'settled') fail('turn_open', 409, 'Settle the current turn before opening another.');
  const nextNumber = Number(latest.number) + 1;
  if (nextNumber > Number(circle.turns_total)) fail('circle_complete', 409, 'Every member has taken the pot.');
  const members = (await membersOf(db, groupId)).filter((member) => member.status === 'active');
  const isFinal = nextNumber === Number(circle.turns_total);
  if (isFinal) {
    const eligible = members.filter((member) => !member.has_won);
    if (eligible.length !== 1) fail('invalid_state', 409, 'The final turn does not have exactly one waiting member. Review the roster.');
  }
  const existing = one(await db.from('cycles').select('*').eq('circle_id', circle.id).eq('number', nextNumber).limit(1));
  if (existing) {
    await ensureContributionRows(db, existing, members);
    return json({ ok: true, cycleId: existing.id });
  }
  const createdAt = nowIso();
  const dueAt = new Date(Date.parse(createdAt) + Number(group.contribution_window_hours) * HOUR).toISOString();
  const inserted = rows(await db.from('cycles').insertIfAbsent({
    id: crypto.randomUUID(),
    circle_id: circle.id,
    group_id: groupId,
    number: nextNumber,
    member_count: members.length,
    contribution_minor: Number(group.contribution_minor),
    pot_expected_minor: Number(group.contribution_minor) * members.length,
    pot_captured_minor: 0,
    status: 'contributing',
    is_final: isFinal,
    contribution_due_at: dueAt,
    scheduled_settle_at: scheduledTurnAt(createdAt, groupCadence(group)),
    created_at: createdAt,
  }, { onConflict: 'circle_id,number' }).select('*'));
  const cycle = inserted[0] || one(await db.from('cycles').select('*').eq('circle_id', circle.id).eq('number', nextNumber).limit(1));
  if (!cycle) fail('write_conflict', 409, 'The next turn could not be opened. Try again.');
  await ensureContributionRows(db, cycle, members);
  return json({ ok: true, cycleId: cycle.id });
}

async function closeCycle(db, request, groupId, cycleId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  assertUuid(cycleId);
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only members can settle a turn.');
  const cycle = one(await db.from('cycles').select('*').eq('id', cycleId).limit(1));
  if (!cycle || cycle.group_id !== groupId) fail('cycle_not_found', 404);
  const circle = one(await db.from('circles').select('*').eq('id', cycle.circle_id).limit(1));
  if (!circle) fail('cycle_not_found', 404);
  const members = await membersOf(db, groupId);
  // The turn clock is part of the deal. Once the pot is whole, the scheduled
  // seat takes it at the window close; the organizer or the member due that
  // seat may close early. Nobody else can pull the turn forward.
  if (cycle.status === 'funded' && !cycle.is_final) {
    const closesAt = Date.parse(cycle.auction_closes_at || '');
    if (Number.isFinite(closesAt) && closesAt > Date.now()) {
      const due = members.find((member) => member.status === 'active'
        && !member.has_won && Number(member.seat_no) === Number(cycle.number));
      if (me.role !== 'organizer' && (!due || due.id !== me.id)) {
        fail('turn_window_open', 409, 'This turn settles when its window closes. The organizer or the member holding this seat can close it early.');
      }
    }
  }
  const result = await settleCycle(db, { group, circle, cycle, members });
  return json({ ok: true, settlementId: result.settlement.id });
}

async function coverShortfall(db, request, groupId, cycleId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  assertUuid(cycleId);
  await rateLimit(db, `cover:${user.id}`, 30, 60 * 60 * 1000);
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const organizer = await membershipFor(db, groupId, user.id);
  if (!organizer || organizer.role !== 'organizer') fail('forbidden', 403, 'Only the organizer can cover a shortfall.');
  const cycle = one(await db.from('cycles').select('*').eq('id', cycleId).limit(1));
  if (!cycle || cycle.group_id !== groupId) fail('cycle_not_found', 404);
  await assertCurrentCycle(db, cycle);
  if (cycle.status !== 'contributing' && cycle.status !== 'funded') fail('cycle_closed', 409, 'This turn is already settled.');
  const body = await jsonBody(request);
  assertUuid(body.membershipId, 'Choose a member.');
  const source = String(body.source || '');
  if (!['fund', 'wallet', 'guarantor'].includes(source)) fail('invalid_input', 400, 'Choose the fund, your wallet, or the guarantor.');
  const target = one(await db.from('memberships').select('*').eq('id', body.membershipId).limit(1));
  if (!target || target.group_id !== groupId || target.status !== 'active') fail('not_found', 404, 'That member is not active in this circle.');
  if (target.id === organizer.id) fail('invalid_input', 400, 'Cover another member, not yourself.');
  const contribution = await contributionForMember(db, cycleId, target.id);
  if (!contribution) fail('not_found', 404, 'That contribution is not on this turn.');
  if (contribution.status === 'paid') fail('contribution_already_paid', 409, 'That contribution is already in.');
  const result = await coverContribution(db, {
    group,
    cycle,
    contribution,
    member: target,
    organizerMembership: organizer,
    source,
  });
  const members = await membersOf(db, groupId);
  await fundCycleIfComplete(db, cycle, members, group.bid_window_minutes);
  return json({ ok: true, source: result.source, amountMinor: result.amountMinor });
}

async function contributionCheckout(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  await rateLimit(db, `checkout:${user.id}`, 15, 60 * 60 * 1000);
  const body = await jsonBody(request);
  assertUuid(body.cycleId, 'Choose the turn.');
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only active members can fund this circle.');
  const cycle = one(await db.from('cycles').select('*').eq('id', body.cycleId).limit(1));
  if (!cycle || cycle.group_id !== groupId) fail('cycle_not_found', 404);
  const latest = await latestCycle(db, groupId);
  if (!latest || latest.id !== cycle.id) fail('stale_turn', 409, 'That turn is no longer open.');
  if (cycle.status !== 'contributing') fail('contributions_closed', 409, 'Contributions are closed for this turn.');
  const contribution = await contributionForMember(db, cycle.id, me.id);
  if (!contribution) fail('contribution_missing', 409, 'Refresh and try again.');
  if (contribution.status === 'paid') fail('already_paid', 409, 'Your contribution for this turn is already in.');
  if (contribution.checkout_url && contribution.checkout_expires_at && Date.parse(contribution.checkout_expires_at) > Date.now()) {
    return json({
      checkoutUrl: contribution.checkout_url,
      sessionId: contribution.provider_ref,
      expiresAt: contribution.checkout_expires_at,
    });
  }
  const due = contributionAmount(cycle, contribution);
  const origin = browserOrigin(request);
  const checkout = await createCheckout({
    amountMinor: due.dueMinor,
    description: `THE WHEEL · ${group.name} · turn ${cycle.number}`,
    metadata: {
      contribution_id: contribution.id,
      cycle_id: cycle.id,
      group_id: groupId,
      user_id: user.id,
    },
    successUrl: `${origin}/#/g`,
    cancelUrl: `${origin}/#/g`,
    returnUrl: `${origin}/#/g`,
  });
  const saved = await recordCheckout(db, contribution, {
    providerRef: checkout.id,
    checkoutUrl: checkout.hostedUrl,
    expiresAt: checkout.expiresAt,
  });
  if (!saved) fail('already_paid', 409, 'Your contribution was already settled.');
  return json({
    checkoutUrl: checkout.hostedUrl,
    sessionId: checkout.id,
    expiresAt: checkout.expiresAt,
    amountMinor: due.dueMinor,
  });
}

/* ---------------- savings wallet ---------------- */

const MIN_TOPUP_MINOR = TOPUP_MIN_MINOR;
const MAX_TOPUP_MINOR = TOPUP_MAX_MINOR;

function kesLabel(minor) {
  return `KES ${(Number(minor) / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}

async function walletTopUp(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `topup:${user.id}`, 10, 60 * 60 * 1000);
  const body = await jsonBody(request);
  const amountMinor = Number(body.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < MIN_TOPUP_MINOR || amountMinor > MAX_TOPUP_MINOR) {
    fail('invalid_input', 400, `Add between ${kesLabel(MIN_TOPUP_MINOR)} and ${kesLabel(MAX_TOPUP_MINOR)} at a time.`);
  }
  const origin = browserOrigin(request);
  const checkout = await createCheckout({
    amountMinor,
    description: 'THE WHEEL · stash top-up',
    metadata: { wallet_topup: user.id },
    successUrl: `${origin}/#/settings`,
    cancelUrl: `${origin}/#/settings`,
    returnUrl: `${origin}/#/settings`,
  });
  await recordWalletTopUp(db, { userId: user.id, amountMinor, sessionId: checkout.id, expiresAt: checkout.expiresAt });
  return json({
    checkoutUrl: checkout.hostedUrl,
    sessionId: checkout.id,
    expiresAt: checkout.expiresAt,
    amountMinor,
  }, 201);
}

async function walletTopUpsRead(db, request) {
  const { user } = await requireSession(db, request);
  const wallet = await walletFor(db, user.id);
  return json({
    chipsMinor: TOPUP_CHIPS_MINOR,
    savedMinor: wallet.availableMinor,
    pendingMinor: wallet.pendingMinor,
    topUps: await walletTopUpHistory(db, user.id),
  });
}

async function refundStashDebit(db, { contribution, cycle, userId, membershipId, amountMinor }) {
  await insertLedger(db, {
    ref: `savings_pay_return:${contribution.id}`,
    groupId: cycle.group_id,
    cycleId: cycle.id,
    userId,
    membershipId,
    kind: 'savings_return',
    amountMinor,
    walletEffect: amountMinor,
    availableAt: nowIso(),
    memo: 'Stash returned · the contribution could not be posted',
  });
}

async function payContributionFromSavings(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  await rateLimit(db, `savings:${user.id}`, 20, 60 * 60 * 1000);
  const body = await jsonBody(request);
  assertUuid(body.cycleId, 'Choose the turn.');
  const group = await groupById(db, groupId);
  if (!group) fail('group_not_found', 404);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only active members can fund this circle.');
  const cycle = one(await db.from('cycles').select('*').eq('id', body.cycleId).limit(1));
  if (!cycle || cycle.group_id !== groupId) fail('cycle_not_found', 404);
  const latest = await latestCycle(db, groupId);
  if (!latest || latest.id !== cycle.id) fail('stale_turn', 409, 'That turn is no longer open.');
  if (cycle.status !== 'contributing') fail('contributions_closed', 409, 'Contributions are closed for this turn.');
  const contribution = await contributionForMember(db, cycle.id, me.id);
  if (!contribution) fail('contribution_missing', 409, 'Refresh and try again.');
  if (contribution.status === 'paid') fail('already_paid', 409, 'Your contribution for this turn is already in.');
  const due = contributionAmount(cycle, contribution);
  const wallet = await walletFor(db, user.id);
  if (wallet.availableMinor < due.dueMinor) {
    fail('wallet_short', 409,
      `Your stash holds ${kesLabel(wallet.availableMinor)}. Add ${kesLabel(due.dueMinor - wallet.availableMinor)} to cover this turn.`);
  }
  const debit = await insertLedger(db, {
    ref: `savings_pay:${contribution.id}`,
    groupId,
    cycleId: cycle.id,
    userId: user.id,
    membershipId: me.id,
    kind: 'savings_contribution',
    amountMinor: due.dueMinor,
    walletEffect: -due.dueMinor,
    availableAt: nowIso(),
    memo: `Turn ${cycle.number} contribution paid from stash`,
  });
  if (!debit.inserted) {
    fail('already_paid', 409, 'That contribution is already settled.');
  }
  try {
    const paid = await markContributionPaid(db, {
      contribution,
      cycle,
      membership: me,
      amountMinor: Number(contribution.amount_minor),
      lateFeeMinor: due.lateFeeMinor,
      method: 'savings',
      providerRef: `savings:${contribution.id}`,
      paidAt: nowIso(),
      chargeTrust: true,
    });
    if (paid?.alreadyPaid) {
      // Another rail already funded this turn; the stash must not stay debited.
      await refundStashDebit(db, { contribution, cycle, userId: user.id, membershipId: me.id, amountMinor: due.dueMinor });
      return json({ ok: true, alreadyPaid: true, amountMinor: due.dueMinor });
    }
  } catch (error) {
    const current = one(await db.from('contributions').select('status').eq('id', contribution.id).limit(1));
    // Only return the stash when nothing posted. A paid row means the debit is
    // the payment, and refunding it here would spend the same money twice.
    if (current?.status === 'paid') {
      return json({ ok: true, alreadyPaid: false, amountMinor: due.dueMinor });
    }
    await refundStashDebit(db, { contribution, cycle, userId: user.id, membershipId: me.id, amountMinor: due.dueMinor });
    throw error;
  }
  const members = await membersOf(db, groupId);
  const funded = await fundCycleIfComplete(db, cycle, members, group.bid_window_minutes);
  if (funded && funded.status === 'funded') {
    const circle = one(await db.from('circles').select('*').eq('id', funded.circle_id).limit(1));
    if (circle) {
      try {
        await settleCycle(db, { group, circle, cycle: funded, members });
      } catch (error) {
        console.error('savings_auto_settle_failed', error?.message);
      }
    }
  }
  const fresh = await latestCycle(db, groupId);
  return json({
    ok: true,
    amountMinor: due.dueMinor,
    cycleStatus: fresh?.status || cycle.status,
  });
}

/* ---------------- checkout sessions ---------------- */

async function ownedCheckout(db, sessionId, user) {
  const contribution = one(await db.from('contributions').select('*').eq('provider_ref', sessionId).limit(1));
  if (contribution) {
    const member = one(await db.from('memberships').select('id,user_id,group_id').eq('id', contribution.membership_id).limit(1));
    if (!member || member.user_id !== user.id) fail('checkout_not_found', 404, 'That checkout is not yours.');
    return { kind: 'contribution', contribution, member };
  }
  const seat = one(await db.from('memberships').select('*').eq('seat_provider_ref', sessionId).limit(1));
  if (seat) {
    if (seat.user_id !== user.id) fail('checkout_not_found', 404, 'That checkout is not yours.');
    return { kind: 'seat', seat };
  }
  const topUp = one(await db.from('wallet_topups').select('*').eq('session_id', sessionId).limit(1));
  if (topUp) {
    if (topUp.user_id !== user.id) fail('checkout_not_found', 404, 'That checkout is not yours.');
    return { kind: 'wallet', topUp };
  }
  fail('checkout_not_found', 404, 'That checkout is not on your account.');
}

async function checkoutStatusRoute(db, request, sessionId) {
  const { user } = await requireSession(db, request);
  await ownedCheckout(db, sessionId, user);
  await rateLimit(db, `checkout-status:${user.id}`, 240, 60 * 60 * 1000);
  const session = await checkoutStatus({ sessionId });
  return json({
    sessionId: session.id,
    status: session.status,
    paid: session.paid,
    amountMinor: session.amountMinor,
  });
}

async function checkoutPayRoute(db, request, sessionId) {
  const { user } = await requireSession(db, request);
  await ownedCheckout(db, sessionId, user);
  await rateLimit(db, `checkout-pay:${user.id}`, 20, 60 * 60 * 1000);
  const result = await payCheckoutSession({
    sessionId,
    phone: user.phone,
    customerName: user.name,
    idempotencyKey: randomToken(24),
  });
  return json({ ok: true, status: result.status, prompt: 'Check your phone for the M-PESA prompt.' });
}

async function checkoutCancelRoute(db, request, sessionId) {
  const { user } = await requireSession(db, request);
  const owned = await ownedCheckout(db, sessionId, user);
  await rateLimit(db, `checkout-cancel:${user.id}`, 40, 60 * 60 * 1000);
  const result = await cancelCheckoutSession({ sessionId, reason: 'Member left the checkout' });
  if (owned.kind === 'contribution') {
    rows(await db.from('contributions').update({ checkout_url: null, checkout_expires_at: null })
      .eq('id', owned.contribution.id).eq('status', 'pending').select('id'));
  } else if (owned.kind === 'seat') {
    rows(await db.from('memberships').update({
      seat_checkout_url: null, seat_checkout_expires_at: null,
    }).eq('id', owned.seat.id).eq('seat_status', 'pending').select('id'));
  } else {
    await closeWalletTopUp(db, sessionId, 'cancelled');
  }
  return json({ ok: true, status: result.status });
}

// Reconciliation for delayed webhooks: asks Paysasa for the truth, then applies
// the same idempotent event path the webhook uses.
async function checkoutSyncRoute(db, request, sessionId) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `checkout-sync:${user.id}`, 60, 60 * 60 * 1000);
  const session = await checkoutStatus({ sessionId });
  const ownsWalletTopUp = session.metadata?.wallet_topup === user.id;
  if (!ownsWalletTopUp) await ownedCheckout(db, sessionId, user);
  if (!session.paid) {
    if (CHECKOUT_DEAD_STATUSES.has(session.status)) {
      const approved = await testApproveWalletTopUp(db, session, user.id);
      if (approved) {
        return json({ ok: true, status: 'paid', paid: true, testApproved: true, amountMinor: approved.amountMinor });
      }
      await closeWalletTopUp(db, session.id, ['cancelled', 'canceled'].includes(session.status) ? 'cancelled' : 'expired');
      return json({ ok: true, status: session.status, paid: false, closed: true });
    }
    return json({ ok: true, status: session.status, paid: false });
  }
  const result = await ingestPaysasaEvent(db, {
    event: 'checkout.session.completed',
    data: {
      session_id: session.id,
      reference: session.reference,
      amount: session.amountMinor,
      currency: session.currency,
      metadata: session.metadata,
    },
  });
  return json({ ok: true, status: 'paid', paid: true, ...result });
}

async function verifyMember(db, request, groupId, membershipId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  assertUuid(membershipId);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.role !== 'organizer') fail('forbidden', 403, 'Only the organizer can verify members.');
  const target = one(await db.from('memberships').select('*').eq('id', membershipId).limit(1));
  if (!target || target.group_id !== groupId) fail('not_found', 404, 'That member is not in this circle.');
  if (target.role === 'organizer') return json({ ok: true });
  if (target.kyc_status !== 'verified') {
    rows(await db.from('memberships').update({ kyc_status: 'verified', verified_at: nowIso() })
      .eq('id', target.id).select('id'));
  }
  return json({ ok: true });
}

async function setGuarantee(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.role !== 'organizer') fail('forbidden', 403, 'Only the organizer can record guarantees.');
  const body = await jsonBody(request);
  assertUuid(body.membershipId, 'Choose the member.');
  assertUuid(body.guarantorId, 'Choose the guarantor.');
  if (body.membershipId === body.guarantorId) fail('invalid_input', 400, 'A member cannot guarantee themselves.');
  const member = one(await db.from('memberships').select('*').eq('id', body.membershipId).limit(1));
  const guarantor = one(await db.from('memberships').select('*').eq('id', body.guarantorId).limit(1));
  if (!member || member.group_id !== groupId || member.status !== 'active') fail('not_found', 404, 'That member is not active.');
  if (!guarantor || guarantor.group_id !== groupId || guarantor.status !== 'active') fail('not_found', 404, 'That guarantor is not active.');
  const reciprocal = one(await db.from('guarantees')
    .select('id').eq('member_membership_id', guarantor.id).eq('guarantor_membership_id', member.id).eq('status', 'active').limit(1));
  if (reciprocal) fail('guarantee_cycle', 409, 'Two members cannot guarantee each other.');
  const counts = rows(await db.from('guarantees')
    .select('id').eq('guarantor_membership_id', guarantor.id).eq('status', 'active').limit(3));
  const existing = one(await db.from('guarantees')
    .select('*').eq('member_membership_id', member.id).limit(1));
  if (existing) {
    if (existing.status === 'active' && existing.guarantor_membership_id === guarantor.id) return json({ ok: true });
    if (existing.guarantor_membership_id !== guarantor.id && counts.length >= 2) {
      fail('guarantor_limit', 409, 'That guarantor already covers two members.');
    }
    rows(await db.from('guarantees').update({
      guarantor_membership_id: guarantor.id,
      status: 'active',
      created_at: nowIso(),
      called_at: null,
    }).eq('id', existing.id).select('id'));
    return json({ ok: true });
  }
  if (counts.length >= 2) fail('guarantor_limit', 409, 'That guarantor already covers two members.');
  const inserted = rows(await db.from('guarantees').insertIfAbsent({
    id: crypto.randomUUID(),
    group_id: groupId,
    member_membership_id: member.id,
    guarantor_membership_id: guarantor.id,
    status: 'active',
    created_at: nowIso(),
  }, { onConflict: 'member_membership_id' }).select('id'));
  if (!inserted.length) fail('write_conflict', 409, 'The guarantee changed while saving. Try again.');
  return json({ ok: true }, 201);
}

async function openDispute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  await rateLimit(db, `dispute:${user.id}`, 8, 60 * 60 * 1000);
  const me = await membershipFor(db, groupId, user.id);
  if (!me || me.status !== 'active') fail('forbidden', 403, 'Only members can report an issue.');
  const body = await jsonBody(request);
  const reason = trimText(body.reason, 1000);
  if (reason.length < 8) fail('invalid_input', 400, 'Describe the issue in a little more detail.');
  let against = null;
  if (body.againstMembershipId !== undefined && body.againstMembershipId !== null) {
    assertUuid(body.againstMembershipId, 'That member is malformed.');
    const target = one(await db.from('memberships').select('id,group_id,user_id').eq('id', body.againstMembershipId).limit(1));
    if (!target || target.group_id !== groupId) fail('not_found', 404, 'That member is not in this circle.');
    against = target.user_id;
  }
  let cycleId = null;
  if (body.cycleId !== undefined && body.cycleId !== null) {
    assertUuid(body.cycleId, 'That turn is malformed.');
    const cycle = one(await db.from('cycles').select('id,group_id').eq('id', body.cycleId).limit(1));
    if (!cycle || cycle.group_id !== groupId) fail('not_found', 404, 'That turn is not in this circle.');
    cycleId = cycle.id;
  }
  const id = crypto.randomUUID();
  rows(await db.from('disputes').insertIfAbsent({
    id,
    group_id: groupId,
    cycle_id: cycleId,
    raised_by: user.id,
    against_user_id: against,
    reason,
    status: 'open',
    created_at: nowIso(),
  }, { onConflict: 'id' }).select('id'));
  return json({ ok: true, disputeId: id }, 201);
}

async function groupLedgerRoute(db, request, groupId) {
  const { user } = await requireSession(db, request);
  assertUuid(groupId);
  return json(await ledgerFor(db, groupId, user.id));
}

/* ---------------- wallet ---------------- */

async function restoreWithdrawal(db, payout, memo) {
  await insertLedger(db, {
    ref: `withdrawal_refund:${payout.id}`,
    groupId: payout.group_id,
    cycleId: null,
    userId: payout.user_id,
    membershipId: payout.membership_id,
    kind: 'withdrawal_refund',
    amountMinor: payout.amount_minor,
    walletEffect: payout.amount_minor,
    availableAt: nowIso(),
    memo: memo || 'Withdrawal returned to wallet',
  });
  rows(await db.from('payouts').update({ status: 'failed' }).eq('id', payout.id).select('id'));
}

async function withdraw(db, request) {
  const { user } = await requireSession(db, request);
  await rateLimit(db, `withdraw:${user.id}`, 8, 60 * 60 * 1000);
  const body = await jsonBody(request);
  const amountMinor = Number(body.amountMinor);
  if (body.idempotencyKey !== undefined) assertUuid(body.idempotencyKey, 'The withdrawal reference is malformed.');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < MIN_WITHDRAW_MINOR) fail('invalid_input', 400, 'Enter a valid amount.');
  const phone = normalizePhone(body.phone);
  if (!phone) fail('invalid_input', 400, 'Enter a valid M-PESA number.');
  if (phone !== user.phone) fail('phone_mismatch', 409, 'Withdrawals go to the M-PESA number on your account.');
  if (user.identity_status !== 'verified') {
    fail('identity_required', 403, 'Verify your national ID in Account before money can leave the circle. This is what keeps fake accounts out.');
  }
  const memberships = rows(await db.from('memberships')
    .select('id,group_id,kyc_status,status').eq('user_id', user.id).limit(24));
  const verified = memberships.find((member) => member.kyc_status === 'verified' && member.status === 'active');
  if (!verified) fail('kyc_required', 403, 'The organizer must verify your identity before your first payout.');
  // Provider quote units, execution-bound fee caps and refunds are not verified.
  // Never reserve funds, submit a payout, or refund an unknown submission here.
  fail('payout_terms_unverified', 503, WITHDRAWAL_BLOCKER);
}

/* ---------------- Paysasa webhook ---------------- */

// `checkout.paid` is the dev simulator; Paysasa itself reports a paid checkout
// as `checkout.session.completed` and repeats it as `payment.completed`.
const PAID_EVENTS = new Set(['checkout.paid', 'checkout.session.completed', 'payment.completed']);
const CHECKOUT_CLOSED_EVENTS = new Set(['checkout.expired', 'checkout.cancelled', 'checkout.session.expired']);
const WITHDRAWAL_EVENTS = new Set(['payout.completed', 'payout.failed', 'waas.withdrawal.success', 'waas.withdrawal.failed']);

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

// Paysasa sends the same checkout as flat fields on some events and nested
// session/payment objects on others, so read every known shape up front.
function paysasaEventRecord(event) {
  const data = firstObject(event.data) || {};
  const session = firstObject(data.session, data.checkout_session, data.checkout);
  const payment = firstObject(data.payment, data.transaction);
  const rawAmount = [data.amount, data.amount_minor, session?.amount, payment?.amount]
    .find((value) => value !== undefined && value !== null && value !== '');
  const numericAmount = Number(rawAmount);
  return {
    sessionId: firstString(
      data.session_id, data.sessionId, data.checkout_session_id, data.checkoutSessionId,
      session?.id, session?.session_id,
    ),
    transactionId: firstString(data.transaction_id, data.transactionId, payment?.transaction_id, payment?.id),
    reference: firstString(data.reference, session?.reference, payment?.reference),
    currency: firstString(data.currency, session?.currency, payment?.currency),
    metadata: firstObject(data.metadata, session?.metadata, payment?.metadata) || {},
    amountMinor: rawAmount === undefined ? null : (Number.isFinite(numericAmount) ? Math.round(numericAmount) : null),
  };
}

function paidAmount(value, fallback) {
  const paid = value === null ? Math.round(Number(fallback)) : value;
  if (!Number.isSafeInteger(paid) || paid <= 0) {
    throw new AppError('event_mismatch', 409, 'The paid amount could not be read.');
  }
  return paid;
}

async function processPaysasaEvent(db, event) {
  const eventName = event.event;
  const record = paysasaEventRecord(event);
  const meta = checkoutMetadata({ metadata: record.metadata });
  if (record.currency && record.currency !== 'KES') {
    throw new AppError('event_mismatch', 409, 'Currency mismatch.');
  }
  if (PAID_EVENTS.has(eventName)) {
    let topUp = null;
    if (meta.walletTopUpUserId && uuid(meta.walletTopUpUserId)) {
      if (!record.sessionId) throw new AppError('event_unmatched', 409, 'That top-up has no session.');
      topUp = one(await db.from('wallet_topups').select('*').eq('session_id', record.sessionId).limit(1));
      if (!topUp) throw new AppError('event_unmatched', 409, 'No top-up matches this session.');
      if (topUp.user_id !== meta.walletTopUpUserId) {
        throw new AppError('event_mismatch', 409, 'That top-up belongs to another account.');
      }
    } else if (record.sessionId) {
      // Payment events often drop the session metadata; the session id still
      // identifies a top-up we created.
      topUp = one(await db.from('wallet_topups').select('*').eq('session_id', record.sessionId).limit(1));
    }
    if (topUp) {
      const paid = paidAmount(record.amountMinor, topUp.amount_minor);
      if (Number(topUp.amount_minor) !== paid) {
        throw new AppError('event_mismatch', 409, 'The paid amount does not match this top-up.');
      }
      if (topUp.status === 'paid') return;
      await creditWalletTopUp(db, { userId: topUp.user_id, amountMinor: paid, sessionId: topUp.session_id });
      return;
    }
    // The checkout we created is the source of truth: a session id or reference
    // must match the row it paid for. Metadata ids are only a fallback for
    // events that omit the session, and only with an explicit amount.
    let seat = null;
    if (record.sessionId) {
      seat = one(await db.from('memberships').select('*').eq('seat_provider_ref', record.sessionId).limit(1));
    }
    if (!seat && record.reference) {
      seat = one(await db.from('memberships').select('*').eq('seat_provider_ref', record.reference).limit(1));
    }
    if (!seat && meta.seatMembershipId && uuid(meta.seatMembershipId)) {
      if (record.amountMinor === null) {
        throw new AppError('event_mismatch', 409, 'That payment has no amount to check.');
      }
      seat = one(await db.from('memberships').select('*').eq('id', meta.seatMembershipId).limit(1));
    }
    if (seat) {
      let expected = seat.seat_due_minor;
      if (!expected) {
        const group = one(await db.from('groups').select('id,contribution_minor').eq('id', seat.group_id).limit(1));
        expected = group?.contribution_minor;
      }
      await markSeatPaid(db, seat, {
        amountMinor: paidAmount(record.amountMinor, expected || 0),
        providerRef: record.reference,
        sessionId: record.sessionId,
      });
      return;
    }
    let contribution = null;
    if (record.sessionId) {
      contribution = one(await db.from('contributions').select('*').eq('provider_ref', record.sessionId).limit(1));
    }
    if (!contribution && record.reference) {
      contribution = one(await db.from('contributions').select('*').eq('provider_ref', record.reference).limit(1));
    }
    if (!contribution && meta.contributionId && uuid(meta.contributionId)) {
      if (record.amountMinor === null) {
        throw new AppError('event_mismatch', 409, 'That payment has no amount to check.');
      }
      contribution = one(await db.from('contributions').select('*').eq('id', meta.contributionId).limit(1));
    }
    if (!contribution) {
      if (meta.seatMembershipId) throw new AppError('event_unmatched', 409, 'The seat this payment was for no longer exists.');
      throw new AppError('event_unmatched', 409, 'No contribution matches this payment.');
    }
    if (contribution.status === 'paid') return;
    const base = Number(contribution.amount_minor);
    const paid = paidAmount(record.amountMinor, base);
    const maxLate = Math.floor((base * RULES.lateCapBps) / 10000);
    if (paid < base || paid > base + maxLate) {
      throw new AppError('event_mismatch', 409, 'The paid amount does not match this contribution.');
    }
    const cycle = one(await db.from('cycles').select('*').eq('id', contribution.cycle_id).limit(1));
    if (!cycle) throw new AppError('event_unmatched', 409);
    if (cycle.status === 'settled') throw new AppError('event_mismatch', 409, 'That turn is already settled.');
    const member = one(await db.from('memberships').select('*').eq('id', contribution.membership_id).limit(1));
    const group = await groupById(db, contribution.group_id);
    if (!member || !group) throw new AppError('event_unmatched', 409);
    await markContributionPaid(db, {
      contribution,
      cycle,
      membership: member,
      amountMinor: base,
      lateFeeMinor: paid - base,
      method: 'paysasa',
      providerRef: record.reference || record.sessionId,
      paidAt: nowIso(),
      chargeTrust: true,
    });
    const members = await membersOf(db, contribution.group_id);
    const funded = await fundCycleIfComplete(db, cycle, members, group.bid_window_minutes);
    // A whole pot pays out immediately; the client retries if this attempt races.
    if (funded && funded.status === 'funded') {
      const circle = one(await db.from('circles').select('*').eq('id', funded.circle_id).limit(1));
      if (circle) {
        try {
          await settleCycle(db, { group, circle, cycle: funded, members });
        } catch (error) {
          console.error('auto_settle_failed', error?.message);
        }
      }
    }
    return;
  }
  if (CHECKOUT_CLOSED_EVENTS.has(eventName)) {
    if (record.sessionId) {
      rows(await db.from('contributions').update({ checkout_url: null, checkout_expires_at: null })
        .eq('provider_ref', record.sessionId).eq('status', 'pending').select('id'));
      rows(await db.from('memberships').update({ seat_checkout_url: null, seat_checkout_expires_at: null })
        .eq('seat_provider_ref', record.sessionId).eq('seat_status', 'pending').select('id'));
      await testApproveWalletTopUp(db, {
        id: record.sessionId,
        status: 'cancelled',
        amountMinor: record.amountMinor,
      });
      await closeWalletTopUp(db, record.sessionId, eventName === 'checkout.cancelled' ? 'cancelled' : 'expired');
    }
    return;
  }
  if (WITHDRAWAL_EVENTS.has(eventName)) {
    const { transactionId, reference } = record;
    let payout = null;
    if (transactionId) payout = one(await db.from('payouts').select('*').eq('provider_ref', transactionId).limit(1));
    if (!payout && reference) payout = one(await db.from('payouts').select('*').eq('provider_ref', reference).limit(1));
    if (!payout && reference) payout = one(await db.from('payouts').select('*').eq('idempotency_key', reference).limit(1));
    if (!payout) throw new AppError('event_unmatched', 409, 'No withdrawal matches this event.');
    const failed = eventName === 'payout.failed' || eventName === 'waas.withdrawal.failed';
    if (failed) {
      if (payout.status === 'paid' || payout.status === 'failed') return;
      await restoreWithdrawal(db, payout, 'M-PESA payout returned to wallet');
      return;
    }
    if (payout.status === 'paid') return;
    rows(await db.from('payouts').update({
      status: 'paid',
      paid_at: nowIso(),
      provider_ref: payout.provider_ref || transactionId || reference,
    }).eq('id', payout.id).select('id'));
    return;
  }
  // Every other Paysasa domain (escrow, lengo, deni, subscription, …) is not
  // part of THE WHEEL; acknowledging it stops the provider retrying.
}

async function ingestPaysasaEvent(db, event) {
  const record = paysasaEventRecord(event);
  const identity = record.sessionId || record.transactionId || record.reference
    || (await sha256Hex(JSON.stringify(event))).slice(0, 40);
  const eventId = `${event.event}:${identity}`.slice(0, 180);
  const eventRowId = crypto.randomUUID();
  const inserted = rows(await db.from('payment_events').insertIfAbsent({
    id: eventRowId,
    provider: 'paysasa',
    event_id: eventId,
    event_type: event.event,
    payload: event,
    processed_at: null,
    created_at: nowIso(),
  }, { onConflict: 'event_id' }).select('*'));
  let row = inserted[0];
  if (!row) row = one(await db.from('payment_events').select('*').eq('event_id', eventId).limit(1));
  if (!row) return { received: true };
  if (row.processed_at) return { received: true, duplicate: true };
  try {
    await processPaysasaEvent(db, event);
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      rows(await db.from('payment_events').update({ processed_at: nowIso() }).eq('id', row.id).select('id'));
      return { received: true, ignored: true };
    }
    throw error;
  }
  rows(await db.from('payment_events').update({ processed_at: nowIso() }).eq('id', row.id).select('id'));
  return { received: true };
}

async function paysasaWebhook(db, request) {
  const raw = await readText(request, WEBHOOK_LIMIT);
  const signature = request.headers.get('x-paysasa-signature') || '';
  let verified = false;
  try {
    verified = await verifyWebhook(raw, signature);
  } catch {
    verified = false;
  }
  if (!verified) return json({ error: 'invalid_signature', message: 'Signature verification failed.' }, 401);
  return json(await ingestPaysasaEvent(db, webhookEvent(raw)));
}

/* ---------------- router ---------------- */

function errorResponse(error) {
  if (error instanceof AppError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  try {
    console.error('wheel_error', String(error?.name || 'Error'), String(error?.message || '').slice(0, 300));
  } catch { /* logging is best effort */ }
  return json({ error: 'server_error', message: 'Something went wrong. Try again.' }, 500);
}

async function route(db, request) {
  const url = new URL(request.url);
  const matched = url.pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
  if (!matched) return json({ error: 'not_found', message: 'Not found.' }, 404);
  const path = matched[1] || '/';
  const method = request.method.toUpperCase();
  const mutate = method !== 'GET' && method !== 'HEAD';

  if (path === '/payments/paysasa/webhook') {
    if (method !== 'POST') return json({ error: 'method_not_allowed', message: 'Use POST.' }, 405);
    return paysasaWebhook(db, request);
  }
  if (path === '/config' && method === 'GET') return json(await configPayload(db));

  if (path === '/identity/peek') {
    if (method !== 'POST') return json({ error: 'method_not_allowed', message: 'Use POST.' }, 405);
    requireOrigin(request);
    return identityPeek(db, request);
  }

  if (path.startsWith('/auth/')) {
    if (method !== 'POST' && !(path === '/auth/me' && method === 'GET')) {
      return json({ error: 'method_not_allowed', message: 'Use POST.' }, 405);
    }
    if (method === 'POST') requireOrigin(request);
    if (path === '/auth/register/options') return registerOptions(db, request);
    if (path === '/auth/register/verify') return registerVerify(db, request);
    if (path === '/auth/login/options') return loginOptionsRoute(db, request);
    if (path === '/auth/login/verify') return loginVerify(db, request);
    if (path === '/auth/recovery') return recoveryLogin(db, request);
    if (path === '/auth/me' && method === 'GET') return me(db, request);
  }

  if (method === 'GET') {
    if (path === '/account') return account(db, request);
    if (path === '/open-circles') return openCirclesRoute(db, request);
    if (path === '/admin/identity') return adminIdentityRoute(db, request);
    if (path === '/admin/overview') return adminOverviewRoute(db, request);
    if (path === '/admin/payments/test-approvals') return adminTestApprovalsRead(db, request);
    if (path === '/wallet/topups') return walletTopUpsRead(db, request);
    if (path === '/auth/me') return me(db, request);
    const checkoutGet = path.match(/^\/payments\/checkouts\/([A-Za-z0-9_-]{3,140})$/);
    if (checkoutGet) return checkoutStatusRoute(db, request, checkoutGet[1]);
    const groupGet = path.match(/^\/groups\/([0-9a-f-]{36})$/);
    if (groupGet) return groupDetailRoute(db, request, groupGet[1]);
    const recapGet = path.match(/^\/groups\/([0-9a-f-]{36})\/recap$/);
    if (recapGet && method === 'GET') return groupRecapRoute(db, request, recapGet[1]);
    const ledgerGet = path.match(/^\/groups\/([0-9a-f-]{36})\/ledger$/);
    if (ledgerGet) return groupLedgerRoute(db, request, ledgerGet[1]);
  }

  if (mutate) {
    requireOrigin(request);
    requireCsrf(request);
    if (method !== 'POST') return json({ error: 'method_not_allowed', message: 'Use POST.' }, 405);
    if (path === '/auth/logout') return logout(db, request);
    if (path === '/auth/logout-all') return logoutAll(db, request);
    if (path === '/auth/passkeys/options') return passkeyOptions(db, request);
    if (path === '/auth/passkeys/verify') return passkeyVerify(db, request);
    if (path === '/auth/recovery/regenerate') return regenerateRecovery(db, request);
    const revoke = path.match(/^\/sessions\/([0-9a-f-]{36})\/revoke$/);
    if (revoke) return revokeSession(db, request, revoke[1]);
    if (path === '/groups' && method === 'POST') return createGroup(db, request);
    if (path === '/groups/join' && method === 'POST') return joinGroup(db, request);
    if (path === '/account/identity' && method === 'POST') return identityRoute(db, request);
    if (path === '/admin/unlock') return adminUnlockRoute(db, request);
    if (path === '/admin/payments/probe') return adminPaymentsProbeRoute(db, request);
    if (path === '/admin/payments/test-approvals') return adminTestApprovalsWrite(db, request);
    const adminIdentity = path.match(/^\/admin\/identity\/([0-9a-f-]{36})$/);
    if (adminIdentity) return adminIdentityDecisionRoute(db, request, adminIdentity[1]);
    const groupRoot = path.match(/^\/groups\/([0-9a-f-]{36})$/);
    if (groupRoot && method === 'POST') return json({ error: 'method_not_allowed', message: 'Use GET.' }, 405);
    const seat = path.match(/^\/groups\/([0-9a-f-]{36})\/seat-checkout$/);
    if (seat) return seatCheckoutRoute(db, request, seat[1]);
    const leave = path.match(/^\/groups\/([0-9a-f-]{36})\/leave$/);
    if (leave) return leaveGroupRoute(db, request, leave[1]);
    const swapRoot = path.match(/^\/groups\/([0-9a-f-]{36})\/seat-swaps$/);
    if (swapRoot) return seatSwapRoute(db, request, swapRoot[1]);
    const swapAnswer = path.match(/^\/groups\/([0-9a-f-]{36})\/seat-swaps\/([0-9a-f-]{36})$/);
    if (swapAnswer) return seatSwapRespondRoute(db, request, swapAnswer[1], swapAnswer[2]);
    const accept = path.match(/^\/groups\/([0-9a-f-]{36})\/round\/accept$/);
    if (accept) return acceptRound(db, request, accept[1]);
    const rounds = path.match(/^\/groups\/([0-9a-f-]{36})\/rounds$/);
    if (rounds) return proposeRound(db, request, rounds[1]);
    const start = path.match(/^\/groups\/([0-9a-f-]{36})\/start$/);
    if (start) return startGroup(db, request, start[1]);
    const cycles = path.match(/^\/groups\/([0-9a-f-]{36})\/cycles$/);
    if (cycles) return nextCycle(db, request, cycles[1]);
    const contribution = path.match(/^\/groups\/([0-9a-f-]{36})\/contributions$/);
    if (contribution) return contributionCheckout(db, request, contribution[1]);
    const savingsPay = path.match(/^\/groups\/([0-9a-f-]{36})\/contributions\/savings$/);
    if (savingsPay) return payContributionFromSavings(db, request, savingsPay[1]);
    const checkoutAction = path.match(/^\/payments\/checkouts\/([A-Za-z0-9_-]{3,140})\/(pay|cancel|sync)$/);
    if (checkoutAction) {
      const [, sessionId, action] = checkoutAction;
      if (action === 'pay') return checkoutPayRoute(db, request, sessionId);
      if (action === 'cancel') return checkoutCancelRoute(db, request, sessionId);
      return checkoutSyncRoute(db, request, sessionId);
    }
    const close = path.match(/^\/groups\/([0-9a-f-]{36})\/cycles\/([0-9a-f-]{36})\/close$/);
    if (close) return closeCycle(db, request, close[1], close[2]);
    const cover = path.match(/^\/groups\/([0-9a-f-]{36})\/cycles\/([0-9a-f-]{36})\/cover$/);
    if (cover) return coverShortfall(db, request, cover[1], cover[2]);
    const verify = path.match(/^\/groups\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})\/verify$/);
    if (verify) return verifyMember(db, request, verify[1], verify[2]);
    const guarantee = path.match(/^\/groups\/([0-9a-f-]{36})\/guarantees$/);
    if (guarantee) return setGuarantee(db, request, guarantee[1]);
    const dispute = path.match(/^\/groups\/([0-9a-f-]{36})\/disputes$/);
    if (dispute) return openDispute(db, request, dispute[1]);
    if (path === '/wallet/topups') return walletTopUp(db, request);
    if (path === '/wallet/withdraw') return withdraw(db, request);
  }

  if (path === '/auth/me' || path === '/auth/register/options' || path === '/auth/login/options') {
    return json({ error: 'method_not_allowed', message: 'Use the documented method.' }, 405);
  }
  return json({ error: 'not_found', message: 'Not found.' }, 404);
}

export function application({ db }) {
  return async function handle(context) {
    const request = context?.request instanceof Request ? context.request : context;
    try {
      if (!(request instanceof Request)) return json({ error: 'server_error', message: 'Malformed request.' }, 500);
      return await route(db, request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
