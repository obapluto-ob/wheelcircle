import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
await mkdir(new URL('web/dist/', root), { recursive: true });
await copyFile(new URL('functions/lib/rules.mjs', root), new URL('web/rules.mjs', root));
const files = (await readdir(new URL('web/', root), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(html|css|js|mjs|svg|webmanifest|png|webp)$/.test(entry.name))
  .map((entry) => entry.name);
for (const file of files) {
  const source = new URL(`web/${file}`, root);
  const output = new URL(`web/dist/${file}`, root);
  await copyFile(source, output);
  assert.deepEqual(await readFile(source), await readFile(output));
}
const studio = (await readdir(new URL('web/assets/studio/', root), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(jpe?g|png|webp)$/.test(entry.name))
  .map((entry) => entry.name);
await mkdir(new URL('web/dist/assets/studio/', root), { recursive: true });
for (const file of studio) {
  const source = new URL(`web/assets/studio/${file}`, root);
  const output = new URL(`web/dist/assets/studio/${file}`, root);
  await copyFile(source, output);
  assert.deepEqual(await readFile(source), await readFile(output));
}
console.log(`Built and verified ${files.length} static assets and ${studio.length} studio plates; practice uses the backend's pure rules.`);
