import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cachedFavicons } from '../build/src/favicon-cache.js';

const png = (marker: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([marker])]);
async function cache(root: string, profile: string, rows: Array<[string, number, number]>) {
  const directory = path.join(root, profile);
  await mkdir(directory);
  const db = new DatabaseSync(path.join(directory, 'Favicons'));
  db.exec('CREATE TABLE icon_mapping(page_url TEXT, icon_id INTEGER); CREATE TABLE favicon_bitmaps(icon_id INTEGER, image_data BLOB, width INTEGER, last_updated INTEGER)');
  rows.forEach(([url, width, marker], id) => {
    db.prepare('INSERT INTO icon_mapping VALUES (?, ?)').run(url, id);
    db.prepare('INSERT INTO favicon_bitmaps VALUES (?, ?, ?, 0)').run(id, png(marker), width);
  });
  db.close();
  return directory;
}

test('cached icons prefer exact pages across profiles and choose a sharp small bitmap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-favicon-test-'));
  try {
    const first = await cache(root, 'Default', [['https://example.com/other', 32, 1], ['https://sizes.test/', 16, 2], ['https://sizes.test/', 32, 3], ['https://sizes.test/', 128, 4]]);
    const second = await cache(root, 'Profile 1', [['https://example.com/page', 32, 5]]);
    const before = await readFile(path.join(first, 'Favicons'));
    const icons = await cachedFavicons(['https://example.com/page#section', 'https://example.com/new', 'https://sizes.test/', 'https://absent.test/', 'file:///private'], [first, second]);
    assert.equal(icons.get('https://example.com/page#section'), 'data:image/png;base64,' + png(5).toString('base64'));
    assert.equal(icons.get('https://example.com/new'), 'data:image/png;base64,' + png(1).toString('base64'));
    assert.equal(icons.get('https://sizes.test/'), 'data:image/png;base64,' + png(3).toString('base64'));
    assert.equal(icons.size, 3);
    assert.deepEqual(await readFile(path.join(first, 'Favicons')), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing or damaged caches do not block icons from another profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-favicon-test-'));
  try {
    const damaged = path.join(root, 'damaged'); await mkdir(damaged); await writeFile(path.join(damaged, 'Favicons'), 'invalid sqlite');
    const valid = await cache(root, 'valid', [['https://example.com/', 32, 1]]);
    const icons = await cachedFavicons(['https://example.com/'], [path.join(root, 'missing'), damaged, valid]);
    assert.equal(icons.size, 1);
    const db = new DatabaseSync(path.join(valid, 'Favicons'));
    db.prepare('UPDATE favicon_bitmaps SET image_data = ?').run(Buffer.from('<svg>untrusted</svg>'));
    db.close();
    assert.equal((await cachedFavicons(['https://example.com/'], [valid])).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
