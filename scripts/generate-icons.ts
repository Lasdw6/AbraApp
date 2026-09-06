import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const svg = await readFile(new URL('desktop/assets/spoon.svg', root));
for (const directory of ['desktop/public', 'desktop/assets', 'docs']) {
  await mkdir(new URL(directory, root), { recursive: true });
}
const png = (size: number) => new Resvg(svg, {
  fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false },
}).render().asPng();

for (const file of ['desktop/public/spoon.svg', 'docs/spoon.svg']) {
  await writeFile(new URL(file, root), svg);
}
await writeFile(new URL('desktop/public/icon.png', root), png(512));

// ICO directory entries point to PNG images, preserving transparency at every size.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
images.forEach((bytes, index) => {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = sizes[index] % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(bytes.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
});
await writeFile(new URL('desktop/assets/icon.ico', root), Buffer.concat([directory, ...images]));

// Modern macOS ICNS entries contain PNGs at standard and Retina resolutions.
const chunks = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, size]) => {
  const bytes = png(Number(size));
  const header = Buffer.alloc(8);
  header.write(String(type));
  header.writeUInt32BE(8 + bytes.length, 4);
  return Buffer.concat([header, bytes]);
});
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(new URL('desktop/assets/icon.icns', root), Buffer.concat([header, ...chunks]));
