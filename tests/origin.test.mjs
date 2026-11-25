import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, assertStatus } from './helpers.mjs';

test('a trusted tunnel origin gets its own WebAuthn RP ID while localhost keeps working', async () => {
  const { handle } = await boot();
  const call = client(handle, null);

  assertStatus(await call('/auth/register/options', {
    method: 'POST', origin: 'https://tunnel.example', body: { name: 'Wrong Origin', phone: '0712345678', dateOfBirth: '1995-04-02' },
  }), 403, 'unlisted origin is refused');

  process.env.TRUSTED_ORIGINS = 'https://tunnel.example, https://second.example';
  try {
    const tunnel = await call('/auth/register/options', {
      method: 'POST', origin: 'https://tunnel.example', body: { name: 'Tunnel Tester', phone: '0712345679', dateOfBirth: '1995-04-02' },
    });
    assertStatus(tunnel, 200, 'trusted origin');
    assert.equal(tunnel.data.publicKey.rp.id, 'tunnel.example', 'RP ID follows the page');
    assert.equal(tunnel.data.publicKey.rp.name, 'THE WHEEL');

    const local = await call('/auth/register/options', {
      method: 'POST', body: { name: 'Local Tester', phone: '0712345680', dateOfBirth: '1995-04-02' },
    });
    assertStatus(local, 200, 'canonical origin still works');
    assert.equal(local.data.publicKey.rp.id, 'localhost', 'localhost keeps its own RP ID');

    assertStatus(await call('/auth/register/options', {
      method: 'POST', origin: 'https://evil.example', body: { name: 'Evil Tester', phone: '0712345681', dateOfBirth: '1995-04-02' },
    }), 403, 'unlisted origin stays refused');
  } finally {
    delete process.env.TRUSTED_ORIGINS;
  }
});
