import { paths } from './paths.js';
import { readJson, writeJson } from './util.js';

export async function loadState() {
  return readJson(paths().state, { version: 1, browser: {} });
}

export async function updateState(mutator) {
  const state = await loadState();
  await mutator(state);
  state.version = 1;
  await writeJson(paths().state, state);
  return state;
}
