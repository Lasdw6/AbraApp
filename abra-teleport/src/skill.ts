import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appRoot } from './paths.js';

export function readSkill() {
  return readFile(path.join(appRoot, 'skills/abra/SKILL.md'), 'utf8');
}

export async function installSkill(directory = process.env.ABRA_TELEPORT_SKILLS_DIR || path.join(os.homedir(), '.agents/skills'), force = false) {
  const content = await readSkill();
  const folder = path.resolve(directory, 'abra');
  const file = path.join(folder, 'SKILL.md');
  await mkdir(folder, { recursive: true });
  const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (info) {
    if (!info.isFile()) throw new Error(`Skill path is not a regular file: ${file}`);
    if (await readFile(file, 'utf8') === content) return { installed: true, changed: false, path: file };
    if (!force) throw new Error(`A different skill already exists at ${file}. Use --force to replace it, or --dir to choose another skills directory.`);
  }
  await writeFile(file, content, { flag: force ? 'w' : 'wx' });
  return { installed: true, changed: true, path: file };
}
