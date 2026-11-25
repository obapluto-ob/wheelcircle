// KoraPay identity checks. The secret key lives only in server env; the browser
// never sees it. Sandbox mode answers from a fixed register so local and test
// circles can be onboarded without a key, and every response says so.
import { nowIso } from './util.mjs';

const BASE = 'https://api.korapay.com/merchant/api/v1';
const TIMEOUT_MS = 9000;

function env(name) {
  try {
    return globalThis.process?.env?.[name] ?? null;
  } catch {
    return null;
  }
}

export function koraKey() {
  return String(env('KORA_SECRET_KEY') || '').trim();
}

export function koraSimulated() {
  return env('KORA_SIMULATED') === '1';
}

export function koraConfigured() {
  return Boolean(koraKey()) || koraSimulated();
}

export function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

const SIM_REGISTER = {
  '12345678': { firstName: 'Amina', middleName: '', lastName: 'Wanjiru', dateOfBirth: '1996-04-12', gender: 'female', mobile: '254700000001' },
  '23456789': { firstName: 'Brian', middleName: 'Ochieng', lastName: 'Otieno', dateOfBirth: '1998-07-03', gender: 'male', mobile: '254700000002' },
  '34567890': { firstName: 'Cynthia', middleName: 'Akinyi', lastName: 'Achieng', dateOfBirth: '1997-11-21', gender: 'female', mobile: '254700000003' },
  '45678901': { firstName: 'David', middleName: 'Mbugua', lastName: 'Kimani', dateOfBirth: '1995-02-18', gender: 'male', mobile: '254700000004' },
  '56789012': { firstName: 'Esther', middleName: 'Wambui', lastName: 'Njeri', dateOfBirth: '1999-09-05', gender: 'female', mobile: '254700000005' },
  '67890123': { firstName: 'Faith', middleName: 'Nyambura', lastName: 'Muthoni', dateOfBirth: '2001-01-30', gender: 'female', mobile: '254700000099' },
  '25219766': { firstName: 'Josephine', middleName: 'Mary', lastName: 'Okunmu', dateOfBirth: '2002-06-03', gender: 'female', mobile: '254723818211' },
};

function simLookup({ idNumber }) {
  const entry = SIM_REGISTER[idNumber];
  if (!entry) return null;
  return {
    reference: `VR-SIM-${idNumber.slice(-4)}`,
    idNumber,
    firstName: entry.firstName,
    middleName: entry.middleName,
    lastName: entry.lastName,
    fullName: [entry.firstName, entry.middleName, entry.lastName].filter(Boolean).join(' '),
    dateOfBirth: entry.dateOfBirth,
    gender: entry.gender,
    mobile: entry.mobile,
  };
}

function sameText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function localPhone(phone) {
  const value = digits(phone);
  if (value.length === 12 && value.startsWith('254')) return `0${value.slice(3)}`;
  return value;
}

async function koraCall(path, body) {
  const key = koraKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'provider_unreachable' };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.status === false) {
    return {
      ok: false,
      reason: 'provider_error',
      status: response.status,
      message: typeof payload?.message === 'string' ? payload.message.slice(0, 160) : '',
    };
  }
  return { ok: true, data: payload.data || {} };
}

export async function lookupNationalId({ idNumber, legalName, dateOfBirth }) {
  const id = digits(idNumber);
  if (!id) return { ok: false, reason: 'invalid_input' };
  if (koraSimulated() && !koraKey()) {
    const found = simLookup({ idNumber: id });
    if (!found) return { ok: true, found: false, simulated: true };
    const { firstName, lastName } = splitName(legalName);
    const checks = {
      firstName: legalName ? { value: firstName, match: sameText(firstName, found.firstName) } : null,
      lastName: legalName ? { value: lastName, match: sameText(lastName, found.lastName) } : null,
      dateOfBirth: dateOfBirth ? { value: dateOfBirth, match: sameText(dateOfBirth, found.dateOfBirth) } : null,
    };
    return { ok: true, found: true, simulated: true, identity: found, checks, reference: found.reference };
  }
  if (!koraKey()) return { ok: false, reason: 'not_configured' };
  const { firstName, lastName } = splitName(legalName);
  const validation = {};
  if (firstName) validation.first_name = firstName;
  if (lastName) validation.last_name = lastName;
  if (dateOfBirth) validation.date_of_birth = dateOfBirth;
  const result = await koraCall('/identities/ke/national-id', {
    id,
    verification_consent: true,
    ...(Object.keys(validation).length ? { validation } : {}),
  });
  if (!result.ok) return result;
  const data = result.data;
  if (!data?.id && !data?.first_name) return { ok: true, found: false, simulated: false };
  const providerValidation = data.validation || {};
  const checks = {
    firstName: providerValidation.first_name
      ? { value: providerValidation.first_name.value, match: providerValidation.first_name.match === true }
      : null,
    lastName: providerValidation.last_name
      ? { value: providerValidation.last_name.value, match: providerValidation.last_name.match === true }
      : null,
    dateOfBirth: providerValidation.date_of_birth
      ? { value: providerValidation.date_of_birth.value, match: providerValidation.date_of_birth.match === true }
      : null,
    selfie: providerValidation.selfie
      ? { match: providerValidation.selfie.match === true, confidence: Number(providerValidation.selfie.confidence_rating || 0) }
      : null,
  };
  return {
    ok: true,
    found: true,
    simulated: false,
    reference: data.reference || null,
    identity: {
      firstName: data.first_name || '',
      middleName: data.middle_name || '',
      lastName: data.last_name || '',
      fullName: data.full_name || [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(' '),
      dateOfBirth: data.date_of_birth || '',
      gender: data.gender || '',
      mobile: digits(data.mobile_telephone_number || ''),
    },
    checks,
  };
}

export async function verifyPhoneOwner({ phone, idNumber }) {
  const number = localPhone(phone);
  if (!number) return { ok: false, reason: 'invalid_input' };
  if (koraSimulated() && !koraKey()) {
    const found = simLookup({ idNumber: digits(idNumber) });
    if (!found) return { ok: true, found: false, simulated: true };
    return {
      ok: true,
      found: true,
      simulated: true,
      reference: `VR-SIM-PHONE-${number.slice(-4)}`,
      fullName: found.fullName,
      dateOfBirth: found.dateOfBirth,
      mobile: found.mobile,
    };
  }
  if (!koraKey()) return { ok: false, reason: 'not_configured' };
  const result = await koraCall('/identities/ke/get-phone', {
    id: number,
    type: 'national_id',
    verification_consent: true,
  });
  if (!result.ok) return result;
  const data = result.data;
  return {
    ok: true,
    found: Boolean(data?.id || data?.full_name),
    simulated: false,
    reference: data?.reference || null,
    fullName: data?.full_name || [data?.first_name, data?.middle_name, data?.last_name].filter(Boolean).join(' '),
    dateOfBirth: data?.date_of_birth || '',
    mobile: digits(data?.mobile_telephone_number || data?.id || ''),
  };
}

export function identityCheckedAt() {
  return nowIso();
}
