// National-ID verification through KoraPay (KE national ID + phone owner).
// Legacy generic URL support stays for other providers. The key lives only in
// server env, never in the browser. Without a provider every typed ID goes to
// admin review.
import { koraConfigured, lookupNationalId, verifyPhoneOwner, digits } from './kora.mjs';

function legacyConfigured() {
  return Boolean(String(process.env.IDENTITY_VERIFY_URL || '').trim() && String(process.env.IDENTITY_VERIFY_KEY || '').trim());
}

export function identityProviderConfigured() {
  return koraConfigured() || legacyConfigured();
}

export function identityProviderName() {
  if (koraConfigured()) return 'kora';
  if (legacyConfigured()) return 'custom';
  return null;
}

function providerUrl() {
  try {
    const url = new URL(String(process.env.IDENTITY_VERIFY_URL || '').trim());
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

async function verifyWithLegacyProvider({ idNumber, legalName, phone }) {
  if (!legacyConfigured() || !providerUrl()) return { status: 'review', reason: 'no_provider' };
  try {
    const response = await fetch(providerUrl(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.IDENTITY_VERIFY_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ idNumber, legalName, phone }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: 'review', reason: 'provider_error' };
    const data = await response.json().catch(() => ({}));
    const matched = data.match === true || data.matched === true || data.verified === true || data.status === 'verified';
    return matched
      ? { status: 'verified', reason: 'provider_match', provider: 'custom' }
      : { status: 'review', reason: 'provider_no_match', provider: 'custom' };
  } catch {
    return { status: 'review', reason: 'provider_unreachable', provider: 'custom' };
  }
}

export async function verifyIdentityWithProvider({ idNumber, legalName, phone, dateOfBirth }) {
  if (!koraConfigured()) return verifyWithLegacyProvider({ idNumber, legalName, phone });
  const lookup = await lookupNationalId({ idNumber, legalName, dateOfBirth });
  if (!lookup.ok) {
    return { status: 'review', reason: lookup.reason || 'provider_error', provider: 'kora', simulated: lookup.simulated === true };
  }
  if (!lookup.found) {
    return { status: 'review', reason: 'not_found', provider: 'kora', simulated: lookup.simulated === true };
  }
  const checks = lookup.checks || {};
  const nameMatched = (!checks.firstName || checks.firstName.match) && (!checks.lastName || checks.lastName.match);
  const dobMatched = !checks.dateOfBirth || checks.dateOfBirth.match;
  const dataMatch = Boolean(nameMatched && dobMatched);
  let phoneMatch = null;
  if (phone) {
    const owner = await verifyPhoneOwner({ phone, idNumber });
    phoneMatch = Boolean(owner.ok && owner.found && digits(owner.mobile).slice(-9) === digits(phone).slice(-9));
  }
  const verified = dataMatch && phoneMatch !== false;
  return {
    status: verified ? 'verified' : 'review',
    reason: verified ? 'provider_match' : 'provider_no_match',
    provider: 'kora',
    simulated: lookup.simulated === true,
    reference: lookup.reference || null,
    checks: {
      firstName: checks.firstName || null,
      lastName: checks.lastName || null,
      dateOfBirth: checks.dateOfBirth || null,
      phone: phoneMatch === null ? null : { match: phoneMatch },
    },
    identityName: lookup.identity.fullName,
  };
}
