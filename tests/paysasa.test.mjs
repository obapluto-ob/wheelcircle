import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckout, checkoutStatus } from '../functions/lib/paysasa.mjs';
import { configurePayments } from './helpers.mjs';

test('checkout parsing accepts the flat sandbox create shape and the nested read shape', async () => {
  configurePayments();
  const original = globalThis.fetch;
  const responses = [
    {
      session_id: 'cs_flat_1',
      reference: 'CHKOUT-1',
      hosted_url: 'https://app.paysasa.com/checkout/abc123',
      status: 'pending',
      expires_at: '2030-01-01T00:00:00.000Z',
    },
    { session: { id: 'cs_flat_1', amount: '10000', currency: 'KES', status: 'pending', metadata: {} } },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    const created = await createCheckout({
      amountMinor: 10000,
      description: 'stash top-up',
      metadata: { wallet_topup: 'user_1' },
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/no',
      returnUrl: 'https://example.com/ok',
    });
    assert.equal(created.id, 'cs_flat_1');
    assert.equal(created.hostedUrl, 'https://app.paysasa.com/checkout/abc123');

    const status = await checkoutStatus({ sessionId: 'cs_flat_1' });
    assert.equal(status.id, 'cs_flat_1');
    assert.equal(status.amountMinor, 10000);
    assert.equal(status.paid, false);
  } finally {
    globalThis.fetch = original;
  }
});
