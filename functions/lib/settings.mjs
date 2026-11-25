import { one, rows, nowIso } from './util.mjs';

export async function getSetting(db, key) {
  return one(await db.from('settings').select('*').eq('id', key).limit(1));
}

export async function setSetting(db, key, value) {
  const updatedAt = nowIso();
  const existing = await getSetting(db, key);
  if (existing) {
    rows(await db.from('settings').update({ value, updated_at: updatedAt }).eq('id', key).select('id'));
  } else {
    await db.from('settings')
      .insertIfAbsent({ id: key, value, created_at: updatedAt, updated_at: updatedAt }, { onConflict: 'id' })
      .select('id');
  }
  return { id: key, value, updated_at: updatedAt };
}
