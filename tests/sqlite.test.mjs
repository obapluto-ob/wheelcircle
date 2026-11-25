import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSqliteDb } from '../dev/sqlite-db.mjs';

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wheel-sqlite-'));
  const file = path.join(dir, 'wheel.db');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the sqlite dev adapter persists rows across restarts', async () => {
  const { file, cleanup } = scratch();
  try {
    const db = createSqliteDb(file);
    const first = await db.from('users').insertIfAbsent({
      id: 'u1', name: 'Amina', phone: '+254700000001', trust_score: 50,
    }, { onConflict: 'phone' }).select('*');
    assert.equal(first.data.length, 1);
    const duplicate = await db.from('users').insertIfAbsent({
      id: 'u2', name: 'Other', phone: '+254700000001',
    }, { onConflict: 'phone' }).select('*');
    assert.equal(duplicate.data.length, 0);
    await db.from('users').insertIfAbsent({ id: 'u3', name: 'Brian', phone: '+254700000002' }, { onConflict: 'phone' }).select('*');
    await db.from('users').update({ trust_score: 72 }).eq('id', 'u3').select('id');
    db.close();

    assert.ok(existsSync(file));
    const reopened = createSqliteDb(file);
    const rows = (await reopened.from('users').select('*').order('phone', { ascending: true }).limit(2)).data;
    assert.deepEqual(rows.map((row) => row.name), ['Amina', 'Brian']);
    assert.equal(rows[1].trust_score, 72);
    const picked = (await reopened.from('users').select('name').eq('id', 'u3').limit(1)).data;
    assert.deepEqual(picked, [{ name: 'Brian' }]);
    assert.equal(reopened.table('users').length, 2);
    assert.equal(reopened.snapshot().users.length, 2);

    reopened.reset();
    assert.equal(reopened.table('users').length, 0);
    reopened.close();
  } finally {
    cleanup();
  }
});
