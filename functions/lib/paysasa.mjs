import { AppError } from './errors.mjs';
import { bytesEqual, trimText } from './util.mjs';
import { paysasaConfig } from './env.mjs';

const BASE = 'https://api.paysasa.com/api/v1';
const TIMEOUT_MS = 15000;

function requireConfig() {
  const config = paysasaConfig();
  if (!config.configured) {
    throw new AppError('service_not_configured', 503, 'Payouts are not connected yet. The organizer has not connected the payment account.');
  }
  return config;
}

async function call(path, { method = 'GET', body = null, headers = {} } = {}) {
  const config = requireConfig();
  const target = `${BASE}${path}`;
  let response;
  try {
    response = await fetch(target, {
      method,
      headers: {
        'x-api-key': config.apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError('payment_unavailable', 503, 'The payment provider could not be reached. Try again in a moment.');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const providerMessage = typeof payload?.error === 'string' ? payload.error
      : typeof payload?.message === 'string' ? payload.message : '';
    if (providerMessage) console.error('paysasa_refused', response.status, providerMessage);
    if (response.status === 401 || response.status === 403) {
      const error = new AppError('payment_not_configured', 503, 'The payment account is not authorized for this request.');
      error.providerStatus = response.status;
      error.providerMessage = providerMessage;
      throw error;
    }
    const error = new AppError('payment_unavailable', 503, 'The payment provider did not accept that request. Try again.');
    error.providerStatus = response.status;
    error.providerMessage = providerMessage;
    throw error;
  }
  if (!payload || typeof payload !== 'object') {
    throw new AppError('payment_unavailable', 503, 'The payment provider returned an unreadable response.');
  }
  return payload;
}

function amount(value) {
  const minor = Math.round(Number(value));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new AppError('invalid_input', 400, 'Enter a valid amount.');
  return minor;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:') return url.toString();
    // The local dev simulator serves its checkout over loopback http.
    const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'http:' && loopback ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function createCheckout({ amountMinor, description, metadata = {}, successUrl, cancelUrl, returnUrl }) {
  const config = requireConfig();
  const body = {
    amount: amount(amountMinor),
    currency: 'KES',
    business_id: config.businessId,
    description: trimText(description, 140) || 'THE WHEEL contribution',
    allow_methods: ['wallet', 'm_pesa'],
    metadata,
    use_split: false,
  };
  for (const [key, value] of Object.entries({ success_url: successUrl, cancel_url: cancelUrl, return_url: returnUrl })) {
    if (value) body[key] = value;
  }
  const payload = await call('/checkout/sessions', { method: 'POST', body });
  // The sandbox answers flat (`session_id`, `hosted_url`, …) while the read
  // endpoint nests the session; accept either shape.
  const session = payload.session && typeof payload.session === 'object' ? payload.session : payload;
  const sessionId = typeof session.id === 'string' ? session.id
    : typeof session.session_id === 'string' ? session.session_id : null;
  if (!sessionId) {
    throw new AppError('payment_unavailable', 503, 'The payment provider did not return a checkout session.');
  }
  const hosted = httpsUrl(session.hosted_url);
  if (!hosted) throw new AppError('payment_unavailable', 503, 'The payment provider returned an unusable checkout address.');
  const returnedAmount = Number(session.amount);
  if (Number.isFinite(returnedAmount) && returnedAmount !== body.amount) {
    throw new AppError('payment_unavailable', 503, 'The payment provider returned a mismatched checkout amount.');
  }
  return {
    id: sessionId,
    reference: typeof session.reference === 'string' ? session.reference : null,
    status: typeof session.status === 'string' ? session.status : 'pending',
    amountMinor: body.amount,
    hostedUrl: hosted,
    expiresAt: typeof session.expires_at === 'string' ? session.expires_at : null,
  };
}

function normalizeSession(session) {
  const id = typeof session?.id === 'string' ? session.id
    : typeof session?.session_id === 'string' ? session.session_id : null;
  if (!session || typeof session !== 'object' || !id) return null;
  const status = typeof session.status === 'string' ? session.status.toLowerCase() : 'pending';
  return {
    id,
    reference: typeof session.reference === 'string' ? session.reference : null,
    status,
    paid: status === 'paid' || status === 'completed',
    amountMinor: Number.isFinite(Number(session.amount)) ? Math.round(Number(session.amount)) : null,
    currency: typeof session.currency === 'string' ? session.currency : 'KES',
    metadata: session.metadata && typeof session.metadata === 'object' ? session.metadata : {},
  };
}

export async function probePaymentRail() {
  const config = paysasaConfig();
  if (config.simulated) return { mode: 'simulated', ok: true, message: 'The local checkout simulator is collecting payments.' };
  if (!config.configured) return { mode: 'unconfigured', ok: false, message: 'No payment account is connected on the server.' };
  if (/^apk_live/.test(String(config.apiKey || ''))) {
    return { mode: 'paysasa', keyKind: 'live', ok: false, code: 'probe_skipped', message: 'Rail checks create a session, so they run only with sandbox keys.' };
  }
  try {
    const session = await createCheckout({ amountMinor: 5000, description: 'THE WHEEL · rail check', metadata: { rail_check: '1' } });
    await cancelCheckoutSession({ sessionId: session.id, reason: 'Rail check' }).catch(() => {});
    return { mode: 'paysasa', keyKind: 'sandbox', ok: true, message: 'A checkout session was created and cancelled. Collections are open.', sessionId: session.id };
  } catch (error) {
    return {
      mode: 'paysasa',
      keyKind: 'sandbox',
      ok: false,
      code: error?.code || 'unknown',
      message: error?.providerMessage || error?.message || 'The provider refused the request.',
      providerStatus: error?.providerStatus || null,
    };
  }
}

export async function checkoutStatus({ sessionId }) {
  const id = trimText(sessionId, 140);
  if (!id) throw new AppError('invalid_input', 400, 'A checkout reference is required.');
  const payload = await call(`/checkout/sessions/${encodeURIComponent(id)}`);
  const session = normalizeSession(payload.session);
  if (!session) throw new AppError('payment_unavailable', 503, 'The payment provider did not return that checkout.');
  return session;
}

// Cashier-style STK push. The provider prompts the member's phone directly and
// the signed webhook still decides when the money actually landed.
export async function payCheckoutSession({ sessionId, phone, customerName, idempotencyKey }) {
  const id = trimText(sessionId, 140);
  const msisdn = String(phone || '').replace(/[^\d]/g, '').replace(/^0/, '254');
  if (!id) throw new AppError('invalid_input', 400, 'A checkout reference is required.');
  if (!/^2547\d{8}$/.test(msisdn)) throw new AppError('invalid_input', 400, 'Enter a valid M-PESA number.');
  const key = trimText(idempotencyKey, 80) || crypto.randomUUID();
  const payload = await call(`/checkout/sessions/${encodeURIComponent(id)}/pay`, {
    method: 'POST',
    body: {
      payment_method: 'm_pesa',
      phone: msisdn,
      ...(customerName ? { customer_name: trimText(customerName, 90) } : {}),
    },
    headers: { 'x-idempotency-key': key },
  });
  return {
    status: typeof payload.status === 'string' ? payload.status : 'processing',
    checkoutRequestId: typeof payload.checkout_request_id === 'string' ? payload.checkout_request_id : null,
  };
}

export async function cancelCheckoutSession({ sessionId, reason }) {
  const id = trimText(sessionId, 140);
  if (!id) throw new AppError('invalid_input', 400, 'A checkout reference is required.');
  const payload = await call(`/checkout/sessions/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: { reason: trimText(reason, 140) || 'Member left the checkout' },
  });
  return { status: typeof payload.status === 'string' ? payload.status : 'cancelled' };
}

function normalizeWithdrawal(payload) {
  const source = payload.withdrawal || payload.transaction || payload.waas_withdrawal || payload.data || payload;
  if (!source || typeof source !== 'object') return { transactionId: null, reference: null, status: 'processing' };
  return {
    transactionId: typeof source.transaction_id === 'string' ? source.transaction_id
      : typeof source.id === 'string' ? source.id : null,
    reference: typeof source.reference === 'string' ? source.reference : null,
    status: typeof source.status === 'string' ? source.status : 'processing',
    amountMinor: Number.isFinite(Number(source.amount)) ? Number(source.amount) : null,
  };
}

export async function withdrawToMpesa({ amountMinor, phone, reference, idempotencyKey }) {
  const config = requireConfig();
  const key = trimText(idempotencyKey, 80);
  if (!key) throw new AppError('invalid_input', 400, 'A withdrawal reference is required.');
  const body = {
    business_id: config.businessId,
    amount: amount(amountMinor),
    destination_type: 'mpesa',
    destination_phone: phone,
  };
  const source = String(config.virtualAccountId || '').trim();
  if (source.startsWith('va_')) body.virtual_account_id = source;
  else if (source) body.source_identifier = source;
  else throw new AppError('service_not_configured', 503, 'The payout account is missing its settlement source.');
  if (reference) body.reference = trimText(reference, 80);
  const payload = await call('/waas/withdraw', {
    method: 'POST',
    body,
    headers: { 'x-idempotency-key': key },
  });
  const result = normalizeWithdrawal(payload);
  if (!result.transactionId && !result.reference) {
    throw new AppError('payment_unavailable', 503, 'The payout was not acknowledged by the provider.');
  }
  return result;
}

export async function withdrawStatus({ transactionId, reference }) {
  const config = requireConfig();
  const query = new URLSearchParams({ business_id: config.businessId });
  if (transactionId) query.set('transaction_id', transactionId);
  else if (reference) query.set('reference', reference);
  else throw new AppError('invalid_input', 400, 'A withdrawal id is required.');
  const payload = await call(`/waas/withdraw/status?${query.toString()}`);
  return normalizeWithdrawal(payload);
}

export async function ensureVirtualAccount({ externalId, displayName, displayIdentifier }) {
  const config = requireConfig();
  const body = {
    business_id: config.businessId,
    external_id: trimText(externalId, 80),
  };
  if (!body.external_id) throw new AppError('invalid_input', 400, 'An account reference is required.');
  if (displayName) body.display_name = trimText(displayName, 80);
  if (displayIdentifier) body.display_identifier = trimText(displayIdentifier, 32);
  const payload = await call('/waas/virtual-accounts', { method: 'POST', body });
  const account = payload.virtual_account;
  if (!account || typeof account !== 'object') {
    throw new AppError('payment_unavailable', 503, 'The provider did not return a settlement account.');
  }
  return {
    id: typeof account.id === 'string' ? account.id : null,
    mpesaAccountNumber: typeof account.mpesa_account_number === 'string' ? account.mpesa_account_number : null,
    serialAccountNumber: typeof account.serial_account_number === 'string' ? account.serial_account_number : null,
    externalId: typeof account.external_id === 'string' ? account.external_id : body.external_id,
  };
}

function hexToBytes(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyWebhook(rawBody, signature) {
  const config = paysasaConfig();
  if (!config.webhookSecret) throw new AppError('service_not_configured', 503);
  const provided = hexToBytes(String(signature || '').replace(/^sha256=/i, ''));
  if (!provided || provided.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  return bytesEqual(expected, provided);
}

export function webhookEvent(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new AppError('invalid_input', 400, 'The webhook body is not valid JSON.');
  }
  if (!payload || typeof payload !== 'object') {
    throw new AppError('invalid_input', 400, 'The webhook event is incomplete.');
  }
  const name = typeof payload.event === 'string' ? payload.event
    : typeof payload.type === 'string' ? payload.type
      : typeof payload.event_type === 'string' ? payload.event_type : null;
  const data = payload.data ?? payload.payload;
  if (!name || !data || typeof data !== 'object') {
    throw new AppError('invalid_input', 400, 'The webhook event is incomplete.');
  }
  return { ...payload, event: name, data };
}

export function checkoutMetadata(data) {
  const meta = data?.metadata;
  if (!meta || typeof meta !== 'object') return {};
  const pick = (key) => (typeof meta[key] === 'string' ? meta[key] : null);
  return {
    contributionId: pick('contribution_id'),
    cycleId: pick('cycle_id'),
    groupId: pick('group_id'),
    userId: pick('user_id'),
    seatMembershipId: pick('seat_membership_id'),
    walletTopUpUserId: pick('wallet_topup'),
  };
}
