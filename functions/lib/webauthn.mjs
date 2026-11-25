import { AppError } from './errors.mjs';
import {
  b64u, b64uDecode, bytesEqual, concatBytes, randomBytes, readUint32, sha256Bytes,
} from './util.mjs';

const MAX_CREDENTIAL_ID = 2048;
const MIN_CREDENTIAL_ID = 16;
const MAX_CBOR_DEPTH = 16;

class CborReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new AppError('passkey_invalid', 400, 'The passkey data is incomplete.');
    return this.bytes[this.offset++];
  }

  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new AppError('passkey_invalid', 400, 'The passkey data is incomplete.');
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  uint(length) {
    if (this.offset + length > this.bytes.length) throw new AppError('passkey_invalid', 400);
    let value = 0;
    for (let i = 0; i < length; i += 1) value = value * 256 + this.bytes[this.offset + i];
    this.offset += length;
    return value;
  }

  length(add) {
    if (add < 24) return add;
    if (add === 24) return this.uint(1);
    if (add === 25) return this.uint(2);
    if (add === 26) return this.uint(4);
    if (add === 27) return this.uint(8);
    throw new AppError('passkey_invalid', 400, 'Unsupported passkey encoding.');
  }

  decode(depth = 0) {
    if (depth > MAX_CBOR_DEPTH) throw new AppError('passkey_invalid', 400, 'The passkey data is too deeply nested.');
    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 31;
    if (additional === 31) return this.indefinite(major, depth);
    const length = this.length(additional);
    switch (major) {
      case 0: return length;
      case 1: return -1 - length;
      case 2: return this.take(length);
      case 3: return new TextDecoder('utf-8', { fatal: true }).decode(this.take(length));
      case 4: {
        const list = [];
        for (let i = 0; i < length; i += 1) list.push(this.decode(depth + 1));
        return list;
      }
      case 5: {
        const map = {};
        for (let i = 0; i < length; i += 1) {
          const key = this.decode(depth + 1);
          map[String(key)] = this.decode(depth + 1);
        }
        return map;
      }
      case 6:
        this.decode(depth + 1);
        return null;
      case 7:
        return this.simple(additional);
      default:
        throw new AppError('passkey_invalid', 400);
    }
  }

  indefinite(major, depth) {
    if (major === 2 || major === 3) {
      const chunks = [];
      while (true) {
        if (this.offset >= this.bytes.length) throw new AppError('passkey_invalid', 400);
        if (this.bytes[this.offset] === 0xff) { this.offset += 1; break; }
        const chunk = this.decode(depth + 1);
        if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new AppError('passkey_invalid', 400);
        chunks.push(chunk);
      }
      if (major === 3) return chunks.join('');
      return concatBytes(...chunks);
    }
    if (major === 4) {
      const list = [];
      while (true) {
        if (this.offset >= this.bytes.length) throw new AppError('passkey_invalid', 400);
        if (this.bytes[this.offset] === 0xff) { this.offset += 1; break; }
        list.push(this.decode(depth + 1));
      }
      return list;
    }
    if (major === 5) {
      const map = {};
      while (true) {
        if (this.offset >= this.bytes.length) throw new AppError('passkey_invalid', 400);
        if (this.bytes[this.offset] === 0xff) { this.offset += 1; break; }
        const key = this.decode(depth + 1);
        map[String(key)] = this.decode(depth + 1);
      }
      return map;
    }
    if (major === 7) return null;
    throw new AppError('passkey_invalid', 400);
  }

  simple(additional) {
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    if (additional === 23) return undefined;
    if (additional === 25) {
      const half = this.uint(2);
      const sign = half & 0x8000 ? -1 : 1;
      const exponent = (half >> 10) & 0x1f;
      const fraction = half & 0x3ff;
      if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
      if (exponent === 31) return fraction ? NaN : sign * Infinity;
      return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
    }
    if (additional === 26) {
      if (this.offset + 4 > this.bytes.length) throw new AppError('passkey_invalid', 400);
      const value = this.view.getFloat32(this.offset);
      this.offset += 4;
      return value;
    }
    if (additional === 27) {
      if (this.offset + 8 > this.bytes.length) throw new AppError('passkey_invalid', 400);
      const value = this.view.getFloat64(this.offset);
      this.offset += 8;
      return value;
    }
    throw new AppError('passkey_invalid', 400);
  }
}

function cbor(bytes) {
  return new CborReader(bytes).decode();
}

export function parseClientData(encoded) {
  let data;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b64uDecode(encoded));
    data = JSON.parse(text);
  } catch {
    throw new AppError('passkey_invalid', 400, 'The security key response could not be read.');
  }
  if (!data || typeof data !== 'object' || typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') {
    throw new AppError('passkey_invalid', 400);
  }
  return data;
}

function checkClientData(data, expectedChallenge, expectedOrigin, type) {
  if (data.type !== type) throw new AppError('passkey_invalid', 400, 'The security key response has the wrong type.');
  if (data.challenge !== expectedChallenge) throw new AppError('passkey_challenge', 400, 'This passkey prompt has expired. Try again.');
  if (data.origin !== expectedOrigin) throw new AppError('passkey_origin', 403, 'The passkey was created for a different site.');
  if (data.crossOrigin === true) throw new AppError('passkey_origin', 403);
}

export function parseAuthData(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 37) throw new AppError('passkey_invalid', 400, 'The authenticator data is incomplete.');
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = readUint32(bytes, 33);
  let offset = 37;
  let credential = null;
  if (flags & 0x40) {
    if (bytes.length < offset + 18) throw new AppError('passkey_invalid', 400);
    const aaguid = bytes.slice(offset, offset + 16);
    offset += 16;
    const credentialLength = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (credentialLength < MIN_CREDENTIAL_ID || credentialLength > MAX_CREDENTIAL_ID || bytes.length < offset + credentialLength) {
      throw new AppError('passkey_invalid', 400, 'The credential ID is invalid.');
    }
    const credentialId = bytes.slice(offset, offset + credentialLength);
    offset += credentialLength;
    const reader = new CborReader(bytes.subarray(offset));
    const cose = reader.decode();
    offset += reader.offset;
    credential = { aaguid, credentialId, cose };
  }
  let extensions = null;
  if (flags & 0x80) {
    const reader = new CborReader(bytes.subarray(offset));
    extensions = reader.decode();
    offset += reader.offset;
  }
  return { rpIdHash, flags, signCount, credential, extensions };
}

function coseToJwk(cose) {
  if (!cose || typeof cose !== 'object') throw new AppError('passkey_invalid', 400, 'The public key is missing.');
  const kty = Number(cose[1]);
  const alg = Number(cose[3]);
  if (kty === 2) {
    const crv = Number(cose[-1]);
    if (crv !== 1) throw new AppError('passkey_unsupported', 400, 'Only P-256 passkeys are supported.');
    const x = cose[-2];
    const y = cose[-3];
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new AppError('passkey_invalid', 400);
    return { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y), alg: alg || -7, ext: true };
  }
  if (kty === 3) {
    const n = cose[-1];
    const e = cose[-2];
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new AppError('passkey_invalid', 400);
    return { kty: 'RSA', n: b64u(n), e: b64u(e), alg: alg || -257, ext: true };
  }
  throw new AppError('passkey_unsupported', 400, 'This passkey type is not supported. Use a device passkey.');
}

function readDerPart(bytes, offset) {
  let cursor = offset;
  if (bytes[cursor] !== 0x02) throw new AppError('passkey_invalid', 400);
  cursor += 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 2) throw new AppError('passkey_invalid', 400);
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[cursor++];
  }
  if (length < 1 || cursor + length > bytes.length) throw new AppError('passkey_invalid', 400);
  return { value: bytes.slice(cursor, cursor + length), next: cursor + length };
}

function derToRaw(signature) {
  if (signature[0] !== 0x30) throw new AppError('passkey_invalid', 400, 'The signature is malformed.');
  let cursor = 1;
  let length = signature[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 2) throw new AppError('passkey_invalid', 400);
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + signature[cursor++];
  }
  if (cursor + length > signature.length) throw new AppError('passkey_invalid', 400);
  let part = readDerPart(signature, cursor);
  let r = part.value;
  part = readDerPart(signature, part.next);
  let s = part.value;
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  if (r.length > 32 || s.length > 32) throw new AppError('passkey_invalid', 400);
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

async function verifySignature(jwk, data, signature) {
  const alg = Number(jwk?.alg);
  if (alg === -7 || jwk?.kty === 'EC') {
    let key;
    try {
      key = await crypto.subtle.importKey('jwk', {
        kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true,
      }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      throw new AppError('passkey_invalid', 400, 'The stored passkey key is invalid.');
    }
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), data);
  }
  if (alg === -257 || jwk?.kty === 'RSA') {
    let key;
    try {
      key = await crypto.subtle.importKey('jwk', {
        kty: 'RSA', n: jwk.n, e: jwk.e, ext: true,
      }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    } catch {
      throw new AppError('passkey_invalid', 400, 'The stored passkey key is invalid.');
    }
    return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data);
  }
  throw new AppError('passkey_unsupported', 400, 'This passkey uses an unsupported signature.');
}

export function registrationOptions({ challenge, webauthnUserId, name, rpId, excludeCredentials = [] }) {
  return {
    challenge,
    rp: { name: 'THE WHEEL', id: rpId },
    user: {
      id: b64u(new TextEncoder().encode(webauthnUserId)),
      name: webauthnUserId,
      displayName: name,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: 90000,
    attestation: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'preferred',
    },
  };
}

export function loginOptions({ challenge }) {
  return {
    challenge,
    rpId: undefined,
    timeout: 90000,
    userVerification: 'preferred',
    allowCredentials: [],
  };
}

export function newChallenge() {
  return b64u(randomBytes(32));
}

export function newWebauthnUserId() {
  return b64u(randomBytes(32));
}

export async function verifyRegistration({ credential, expectedChallenge, expectedOrigin, rpId }) {
  if (!credential || credential.type !== 'public-key') throw new AppError('passkey_invalid', 400, 'No passkey was returned.');
  const response = credential.response;
  if (!response || typeof response !== 'object') throw new AppError('passkey_invalid', 400);
  const clientData = parseClientData(response.clientDataJSON);
  checkClientData(clientData, expectedChallenge, expectedOrigin, 'webauthn.create');
  let attestation;
  try {
    attestation = cbor(b64uDecode(response.attestationObject));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('passkey_invalid', 400, 'The passkey attestation could not be read.');
  }
  if (!attestation || typeof attestation !== 'object') throw new AppError('passkey_invalid', 400);
  if (!(attestation.authData instanceof Uint8Array)) throw new AppError('passkey_invalid', 400);
  const authData = parseAuthData(attestation.authData);
  if (!(authData.flags & 0x01)) throw new AppError('passkey_invalid', 400, 'The authenticator did not confirm a user.');
  const expectedRpHash = await sha256Bytes(rpId);
  if (!bytesEqual(authData.rpIdHash, expectedRpHash)) throw new AppError('passkey_origin', 403, 'The passkey belongs to another site.');
  if (!authData.credential) throw new AppError('passkey_invalid', 400, 'The passkey did not include a public key.');
  const credentialId = typeof credential.id === 'string' ? credential.id : b64u(authData.credential.credentialId);
  if (!/^[A-Za-z0-9_-]{16,2048}$/.test(credentialId)) throw new AppError('passkey_invalid', 400);
  if (credential.rawId) {
    const rawId = b64uDecode(credential.rawId);
    if (!bytesEqual(rawId, authData.credential.credentialId) || !bytesEqual(rawId, b64uDecode(credentialId))) {
      throw new AppError('passkey_invalid', 400);
    }
  }
  const jwk = coseToJwk(authData.credential.cose);
  const allowedTransports = new Set(['usb', 'nfc', 'ble', 'hybrid', 'internal', 'smart-card']);
  const transports = Array.isArray(response.transports)
    ? [...new Set(response.transports.filter((item) => typeof item === 'string' && allowedTransports.has(item)))].slice(0, 6)
    : [];
  return {
    credentialId,
    publicKeyJwk: jwk,
    signCount: authData.signCount,
    transports,
    fmt: typeof attestation.fmt === 'string' ? attestation.fmt.slice(0, 32) : 'unknown',
    userVerified: Boolean(authData.flags & 0x04),
  };
}

export async function verifyAssertion({ credential, expectedChallenge, expectedOrigin, rpId, stored, expectedUserHandle }) {
  if (!credential || credential.type !== 'public-key') throw new AppError('passkey_invalid', 400);
  const response = credential.response;
  if (!response || typeof response !== 'object') throw new AppError('passkey_invalid', 400);
  const clientData = parseClientData(response.clientDataJSON);
  checkClientData(clientData, expectedChallenge, expectedOrigin, 'webauthn.get');
  const rawAuthData = b64uDecode(response.authenticatorData);
  const authData = parseAuthData(rawAuthData);
  if (!(authData.flags & 0x01)) throw new AppError('passkey_invalid', 400, 'The authenticator did not confirm a user.');
  const expectedRpHash = await sha256Bytes(rpId);
  if (!bytesEqual(authData.rpIdHash, expectedRpHash)) throw new AppError('passkey_origin', 403, 'The passkey belongs to another site.');
  const rawId = b64uDecode(credential.rawId || credential.id);
  if (!bytesEqual(rawId, b64uDecode(stored.credential_id))) throw new AppError('passkey_unknown', 401, 'That passkey is not registered.');
  if (Number(stored.sign_count) > 0 && authData.signCount > 0 && authData.signCount <= Number(stored.sign_count)) {
    throw new AppError('passkey_counter', 409, 'This passkey was used in an unexpected order. Sign in again.');
  }
  let jwk = stored.public_key_jwk;
  if (typeof jwk === 'string') {
    try { jwk = JSON.parse(jwk); } catch { throw new AppError('passkey_invalid', 400); }
  }
  const clientHash = await sha256Bytes(b64uDecode(response.clientDataJSON));
  const signed = concatBytes(rawAuthData, clientHash);
  let signature;
  try { signature = b64uDecode(response.signature); } catch { throw new AppError('passkey_invalid', 400); }
  const valid = await verifySignature(jwk, signed, signature);
  if (!valid) throw new AppError('passkey_signature', 401, 'The passkey could not be verified.');
  if (response.userHandle) {
    let handle;
    try { handle = new TextDecoder('utf-8', { fatal: true }).decode(b64uDecode(response.userHandle)); }
    catch { throw new AppError('passkey_invalid', 400); }
    if (expectedUserHandle && handle !== expectedUserHandle) throw new AppError('passkey_unknown', 401);
  }
  return { signCount: authData.signCount, userVerified: Boolean(authData.flags & 0x04) };
}
