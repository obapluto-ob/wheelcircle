const boot = document.getElementById('boot');

(() => {
  const root = document.documentElement;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  root.dataset.display = standalone ? 'standalone' : 'browser';
  const ua = navigator.userAgent;
  root.dataset.platform = /iPad|iPhone|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();

const caps = (() => {
  const secure = Boolean(window.isSecureContext);
  const webcrypto = Boolean(globalThis.crypto?.subtle);
  const webauthn = Boolean(secure && webcrypto && window.PublicKeyCredential && navigator.credentials);
  const result = { secure, webcrypto, webauthn, checkedAt: Date.now() };
  try { localStorage.setItem('wheel.caps.v1', JSON.stringify(result)); } catch { /* storage may be unavailable */ }
  document.documentElement.dataset.caps = webauthn ? 'passkey' : 'limited';
  return result;
})();

globalThis.__wheelCaps = caps;

function fail(message) {
  if (!boot) return;
  boot.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = 'THE WHEEL could not start';
  title.style.color = '#eef1e6';
  title.style.font = '600 14px/1.3 sans-serif';
  title.style.letterSpacing = '0';
  title.style.textTransform = 'none';
  const copy = document.createElement('span');
  copy.textContent = message;
  copy.style.maxWidth = '320px';
  copy.style.font = '500 11px/1.6 sans-serif';
  copy.style.letterSpacing = '0';
  copy.style.textTransform = 'none';
  copy.style.color = '#9aa694';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Reload';
  retry.style.marginTop = '4px';
  retry.style.padding = '9px 16px';
  retry.style.border = '1px solid #ff8a3d';
  retry.style.borderRadius = '999px';
  retry.style.background = '#ff8a3d';
  retry.style.color = '#0a0c08';
  retry.style.font = '600 11px/1 sans-serif';
  retry.style.cursor = 'pointer';
  retry.addEventListener('click', () => location.reload());
  boot.append(title, copy, retry);
}

const timer = setTimeout(() => {
  if (!document.body.classList.contains('is-ready')) {
    fail('The app is taking longer than expected. Check your connection and reload.');
  }
}, 12000);

import('./app.js')
  .then((module) => {
    clearTimeout(timer);
    if (typeof module.start !== 'function') throw new Error('missing start');
    module.start();
  })
  .catch((error) => {
    clearTimeout(timer);
    console.error(error);
    fail('A required part of the app did not load. Reload to try again.');
  });
