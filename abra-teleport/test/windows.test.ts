import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestExit, windowsChromeCandidates, windowsRegistryChromeCandidates } from '../build/src/chrome.js';
import { assertManagedProfile, normalizeResolved } from '../build/src/profile-safety.js';
import { commandUsesProfile, executableOnPath, looksLikeElectron, processIdentity, processCommand, replaceFile, splitCommandLine } from '../build/src/util.js';

test('Windows Chrome lookup covers machine and per-user installations', () => {
  const env = { PROGRAMFILES: 'C:/Program Files', 'PROGRAMFILES(X86)': 'C:/Program Files (x86)', LOCALAPPDATA: 'C:/Users/Test User/AppData/Local' };
  assert.deepEqual(windowsChromeCandidates('win32', env), Object.values(env).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe')));
  assert.deepEqual(windowsChromeCandidates('linux', env), []);
  assert.deepEqual(windowsChromeCandidates('win32', {}), []);
});

test('Windows process lookup returns a stable creation time and command', { skip: process.platform !== 'win32' }, async () => {
  const identity = await processIdentity(process.pid);
  assert.ok(identity?.started_at);
  assert.ok(identity.command.includes('node'));
  assert.deepEqual(await processIdentity(process.pid), identity);
  assert.equal(await processCommand(process.pid), identity.command);
  assert.equal(await processIdentity(-1), null);
  assert.match(await executableOnPath('node.exe') || '', /node\.exe$/i);
  assert.equal(await executableOnPath('abra-not-an-installed-command-1234'), null);
});

test('managed profile ownership survives Windows command-line quoting and casing', () => {
  const profile = 'C:\\Users\\John Smith\\.abra-teleport\\chrome-profile';
  const quoted = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=${profile}" --remote-debugging-port=0 about:blank`;
  assert.deepEqual(splitCommandLine(quoted).slice(0, 2), ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', `--user-data-dir=${profile}`]);
  assert.equal(commandUsesProfile(quoted, profile), true);
  assert.equal(commandUsesProfile(`chrome.exe --user-data-dir="${profile}"`, profile), true);
  assert.equal(commandUsesProfile(quoted, 'C:\\Users\\John Smith\\.abra-teleport\\other-profile'), false);
  assert.equal(commandUsesProfile(undefined, profile), false);
  // Unquoted POSIX command lines from `ps` keep matching.
  assert.equal(commandUsesProfile('/usr/bin/google-chrome --user-data-dir=/home/a/.abra-teleport/chrome-profile', '/home/a/.abra-teleport/chrome-profile'), true);
  if (process.platform !== 'win32') return;
  assert.equal(commandUsesProfile(quoted, profile.toUpperCase()), true);
  assert.equal(commandUsesProfile(quoted, `${profile}\\`), true);
  assert.equal(commandUsesProfile(`chrome.exe "--user-data-dir=\\\\?\\${profile}"`, profile), true);
});

test('private state replacement retries the transient locks Windows reports', async () => {
  const codes = ['EPERM', 'EBUSY', 'EACCES'];
  let attempts = 0;
  const flaky = () => {
    if (attempts < codes.length) throw Object.assign(new Error('locked'), { code: codes[attempts++] });
    attempts++;
  };
  if (process.platform === 'win32') {
    await replaceFile('from', 'to', 10, flaky);
    assert.equal(attempts, 4);
    let always = 0;
    await assert.rejects(replaceFile('from', 'to', 3, () => { always++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }), /locked/);
    assert.equal(always, 3);
  } else {
    await assert.rejects(replaceFile('from', 'to', 10, flaky), /locked/);
    assert.equal(attempts, 1);
  }
  // A failure that is not a lock is never retried.
  let denied = 0;
  await assert.rejects(replaceFile('from', 'to', 10, () => { denied++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), /gone/);
  assert.equal(denied, 1);

  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-replace-'));
  try {
    const target = path.join(root, 'state.json'), temporary = path.join(root, 'state.json.tmp');
    await writeFile(target, 'old');
    await writeFile(temporary, 'new');
    await replaceFile(temporary, target);
    assert.equal(await readFile(target, 'utf8'), 'new');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolved profile paths ignore verbatim prefixes, trailing separators, and case', async () => {
  assert.equal(normalizeResolved('\\\\?\\C:\\Users\\John Smith\\Chrome\\', 'win32'), 'c:\\users\\john smith\\chrome');
  assert.equal(normalizeResolved('C:\\Users\\JOHN SMITH\\Chrome', 'win32'), 'c:\\users\\john smith\\chrome');
  assert.equal(normalizeResolved('\\\\?\\UNC\\server\\share\\Chrome', 'win32'), '\\\\server\\share\\chrome');
  assert.equal(normalizeResolved('C:\\', 'win32'), 'c:\\');
  assert.equal(normalizeResolved('/home/User/Chrome/', 'linux'), '/home/User/Chrome');
  if (process.platform !== 'win32') return;
  // A verbatim, differently cased spelling of the regular Chrome root is still
  // the regular Chrome root.
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-verbatim-'));
  try {
    const regular = path.join(root, 'User Data');
    await mkdir(regular);
    await assert.rejects(assertManagedProfile(`\\\\?\\${regular.toUpperCase()}\\Default`, [regular]), /regular Chrome/);
    await assertManagedProfile(path.join(root, 'Abra Profile'), [regular]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stopping managed Chrome asks it to close before ending its process tree', async () => {
  const calls: string[][] = [];
  const signals: [number, string][] = [];
  const ok = ((_command: string, args: string[]) => { calls.push([...args]); return { status: 0 }; }) as never;
  const signal = (pid: number, name: string) => { signals.push([pid, name]); };
  if (process.platform === 'win32') {
    assert.equal(await requestExit(4321, ok, signal), 'close');
    assert.deepEqual(calls, [['/PID', '4321']]);
    assert.ok(!calls[0].includes('/F'), 'the first attempt must not force-terminate Chrome');
    assert.deepEqual(signals, []);
    // taskkill failing outright still falls back to a signal instead of hanging.
    assert.equal(await requestExit(4321, (() => ({ status: 1 })) as never, signal), 'signal');
    assert.deepEqual(signals, [[4321, 'SIGTERM']]);
  } else {
    assert.equal(await requestExit(4321, ok, signal), 'signal');
    assert.deepEqual(calls, []);
    assert.deepEqual(signals, [[4321, 'SIGTERM']]);
  }
});

test('Windows Chrome discovery reads the App Paths registry entry first', () => {
  const answers: Record<string, string> = {
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe': '\r\nHKEY_LOCAL_MACHINE\\...\\chrome.exe\r\n    (Default)    REG_SZ    D:\\Portable Apps\\Chrome\\chrome.exe\r\n',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe': '\r\n    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe\r\n'
  };
  const reg = ((_command: string, args: string[]) =>
    answers[args[1]] ? { status: 0, stdout: answers[args[1]] } : { status: 1, stdout: '' }) as never;
  process.env.LOCALAPPDATA ??= 'C:\\Users\\Test\\AppData\\Local';
  assert.deepEqual(windowsRegistryChromeCandidates('win32', reg), [
    'D:\\Portable Apps\\Chrome\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
  ]);
  assert.deepEqual(windowsRegistryChromeCandidates('linux', reg), []);
  assert.deepEqual(windowsRegistryChromeCandidates('win32', (() => ({ status: 1, stdout: '' })) as never), []);
});

test('a daemon started from the packaged app always runs Electron as Node', () => {
  assert.equal(looksLikeElectron('C:\\Program Files\\Abra Teleport\\Abra Teleport.exe'), true);
  assert.equal(looksLikeElectron('/Applications/Abra Teleport.app/Contents/MacOS/Abra Teleport'), true);
  assert.equal(looksLikeElectron('node_modules/electron/dist/electron.exe'), true);
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    assert.equal(looksLikeElectron(process.execPath), Boolean(process.versions.electron));
    assert.equal(looksLikeElectron(undefined), Boolean(process.versions.electron));
  } finally { if (previous !== undefined) process.env.ELECTRON_RUN_AS_NODE = previous; }
});
