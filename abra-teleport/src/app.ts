import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { loadState } from './state.js';
import { run } from './util.js';
import { observe } from './observer.js';

function validRecipe(value) {
  return value && Array.isArray(value.argv) && value.argv.length > 0
    && value.argv.every(item => typeof item === 'string' && item.length <= 65536)
    && typeof value.cwd === 'string'
    && (!value.ports || value.ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function readRecipes(workspace) {
  return readFile(path.join(workspace, '.abra', 'recipes.json'), 'utf8')
    .then(value => JSON.parse(value))
    .then(value => Array.isArray(value) ? value.filter(validRecipe).sort((left, right) => recipeScore(right) - recipeScore(left)) : [])
    .catch(() => []);
}

async function readAfterObserverCycle(workspace) {
  if (process.platform !== 'linux') return { observer: null, recipes: await readRecipes(workspace) };
  const observation = await observe(workspace);
  try { return { observer: 'internal', recipes: await readRecipes(workspace) }; }
  finally { await observation?.cleanup(); }
}

function recipeScore(recipe) {
  const command = recipe.argv.join(' ');
  return Number(Boolean(recipe.ports?.length)) * 100
    + Number(/(?:vite|next|astro|node|python|cargo|npm|pnpm|yarn|bun)/i.test(command)) * 10;
}

export async function appInspect() {
  const state = await loadState();
  const workspace = state.codex.workspace;
  if (state.codex.location !== 'local' || !workspace) throw new Error('receive a Codex workspace before detecting its app server');
  const info = await stat(workspace).catch(error => { throw new Error(`workspace cannot be read: ${error.message}`); });
  if (!info.isDirectory()) throw new Error('Codex workspace is not a directory');
  const { observer, recipes } = await readAfterObserverCycle(workspace);
  return { workspace, observer, recipes, selected: recipes.find(recipe => recipe.ports?.length) || null };
}

export async function appStop() {
  if (process.platform !== 'linux') return { stopped: [] };
  const state = await loadState();
  if (!state.codex.workspace) throw new Error('no cloud workspace is active');
  const recipes = await readRecipes(state.codex.workspace);
  const ports = [...new Set(recipes.flatMap(recipe => recipe.ports || []))];
  for (const port of ports) await run('/usr/bin/fuser', ['-k', `${port}/tcp`]).catch(() => {});
  return { stopped: ports };
}
