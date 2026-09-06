import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

// Chrome locks Favicons while running. Query a disposable copy, never its live database.
export async function cachedFavicons(urls: string[], profiles: string[]) {
  const icons = new Map<string, string>(), fallbacks = new Map<string, string>();
  const pages = [...new Set(urls)].flatMap(url => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return [];
      parsed.hash = '';
      return [{ url, page: parsed.href, origin: parsed.origin }];
    } catch { return []; }
  });
  if (!pages.length || !profiles.length) return icons;
  const { DatabaseSync } = await import('node:sqlite');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'abra-favicons-'));
  try {
    for (const [index, profile] of profiles.entries()) {
      let db: Database | undefined;
      try {
        const source = path.join(profile, 'Favicons'), copy = path.join(temporary, `Favicons-${index}`);
        await copyFile(source, copy);
        for (const suffix of ['-wal', '-journal']) {
          await copyFile(source + suffix, copy + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        db = new DatabaseSync(copy, { readOnly: true, timeout: 100 });
        const select = `SELECT b.image_data FROM icon_mapping m JOIN favicon_bitmaps b ON b.icon_id = m.icon_id
          WHERE length(b.image_data) BETWEEN 8 AND 262144 AND `;
        const order = ' ORDER BY (b.width >= 32) DESC, abs(b.width - 32), b.last_updated DESC LIMIT 1';
        const exact = db.prepare(select + 'm.page_url IN (?, ?)' + order);
        const origin = db.prepare(select + 'm.page_url >= ? AND m.page_url < ?' + order);
        const image = (row: ReturnType<typeof exact.get>) => {
          if (!(row?.image_data instanceof Uint8Array)) return undefined;
          const data = Buffer.from(row.image_data);
          return data.subarray(0, 8).equals(pngSignature) ? `data:image/png;base64,${data.toString('base64')}` : undefined;
        };
        for (const page of pages) {
          if (icons.has(page.url)) continue;
          const icon = image(exact.get(page.url, page.page));
          if (icon) icons.set(page.url, icon);
          else if (!fallbacks.has(page.url)) {
            const fallback = image(origin.get(page.origin + '/', page.origin + '0'));
            if (fallback) fallbacks.set(page.url, fallback);
          }
        }
      } catch { /* Missing, locked, or changing caches must not prevent tab discovery. */ }
      finally { db?.close(); }
    }
    for (const [url, icon] of fallbacks) if (!icons.has(url)) icons.set(url, icon);
    return icons;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
