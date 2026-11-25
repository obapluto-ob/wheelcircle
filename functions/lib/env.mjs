function env(name) {
  try {
    if (globalThis.Deno?.env?.get) return globalThis.Deno.env.get(name) ?? null;
  } catch { /* not permitted or absent */ }
  try {
    return globalThis.process?.env?.[name] ?? null;
  } catch {
    return null;
  }
}

export function publicOrigin(request) {
  const configured = env('PUBLIC_ORIGIN');
  const origin = configured ? configured.trim().replace(/\/+$/, '') : new URL(request.url).origin;
  return origin;
}

// Extra browser origins allowed alongside PUBLIC_ORIGIN. A quick tunnel gets a
// new hostname every run, so list it here instead of rewriting PUBLIC_ORIGIN
// and losing localhost.
export function trustedOrigins() {
  const raw = env('TRUSTED_ORIGINS');
  if (!raw) return [];
  return raw.split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// The origin the browser is actually on. WebAuthn RP IDs are origin-bound, so
// passkey options and checkout return URLs must follow the page, not the boot
// default. Same-origin GETs omit Origin, so Referer and the forwarded host are
// used before falling back to PUBLIC_ORIGIN.
export function requestOrigin(request) {
  const host = String(request.headers.get('host') || '').trim();
  if (!host) return new URL(request.url).origin;
  const forwarded = String(request.headers.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : 'http';
  return `${proto}://${host}`;
}

export function browserOrigin(request) {
  const canonical = publicOrigin(request);
  const allowed = new Set([canonical, ...trustedOrigins(), requestOrigin(request)]);
  const origin = request.headers.get('origin');
  if (origin && allowed.has(origin)) return origin;
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const fromReferer = new URL(referer).origin;
      if (allowed.has(fromReferer)) return fromReferer;
    } catch { /* malformed referer */ }
  }
  const host = request.headers.get('host');
  const proto = String(request.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
  if (host && (proto === 'http' || proto === 'https')) {
    const forwarded = `${proto}://${host}`;
    if (allowed.has(forwarded)) return forwarded;
  }
  return canonical;
}

export function rpId(origin) {
  return new URL(origin).hostname;
}

export function paysasaConfig() {
  const apiKey = env('PAYSASA_API_KEY');
  const businessId = env('PAYSASA_BUSINESS_ID');
  const webhookSecret = env('PAYSASA_WEBHOOK_SECRET');
  const virtualAccountId = env('PAYSASA_VIRTUAL_ACCOUNT_ID');
  const simulated = env('PAYSASA_SIMULATED') === '1';
  const sandbox = env('PAYSASA_SANDBOX') === '1';
  return {
    apiKey,
    businessId,
    webhookSecret,
    virtualAccountId,
    simulated,
    sandbox,
    configured: Boolean(apiKey && businessId && webhookSecret),
  };
}
