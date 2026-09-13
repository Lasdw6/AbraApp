import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Native Windows support (named-pipe cadabra transport, `.py`/`.js` adapter
// dispatch, Windows Chrome discovery) lives upstream in the pinned `abra/`
// submodule. `crates/cadabra/src/local.rs` is the first file that commit adds,
// so its presence is the cheapest reliable marker that the pin is new enough.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const windowsMarker = path.join(repoRoot, 'abra', 'crates', 'cadabra', 'src', 'local.rs');
export const pinMessage = 'abra submodule pin lacks native Windows support; bump abra/ to a commit that contains crates/cadabra/src/local.rs';

export function abraPinSupportsWindows(marker: string = windowsMarker) {
  return existsSync(marker);
}

export function requireAbraPin(marker: string = windowsMarker) {
  if (abraPinSupportsWindows(marker)) return;
  console.error(pinMessage);
  process.exit(1);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) requireAbraPin();
