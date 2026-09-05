import path from 'node:path';
import { abra, abraBinary, browserAdapterDirectory, daemonStatus, ensureDaemon, stopDaemon } from './abra.js';
import { appInspect, appStop } from './app.js';
import { browserClose, browserExec, browserPrepare, browserReceive, browserRevoke, browserSend, browserStatus } from './browser.js';
import { browserChromeTabs, browserCookieInventory, browserInventory, browserProfiles, browserTabInventory } from './browser-source.js';
import { ensureChrome } from './chrome.js';
import { codexHome, codexInspect, codexReceive, codexResume, codexRun, codexSend, codexSessions, codexStatus } from './codex.js';
import { paths } from './paths.js';
import { executableOnPath, parseArgs } from './util.js';

const HELP = `abra-teleport

Abra integration harness for round-trip browser and Codex demos.

Setup and pairing
  abra-teleport agent connect <pairing-ticket> [name]
  abra-teleport agent ticket
  abra-teleport agent list
  abra-teleport setup
  abra-teleport doctor
  abra-teleport pair ticket
  abra-teleport pair add <ticket>
  abra-teleport peers
  abra-teleport inbox
  abra-teleport daemon stop

Browser round trip
  abra-teleport browser profiles
  abra-teleport browser tabs
  abra-teleport browser cookie-inventory --profile Default --url https://example.com
  abra-teleport browser tab-inventory --profile Default --url https://example.com
  abra-teleport browser prepare --profile Default --url https://example.com --cookies <base64url-json>
  abra-teleport browser inventory <profile>
  abra-teleport browser open [--headless|--headed]
  abra-teleport browser up <peer> [--profile Default] --domains example.com
  abra-teleport browser receive [snapshot-id] [--allow example.com] [--proxy http://127.0.0.1:42000] [--headed]
  abra-teleport browser exec -- <agent-command>
  abra-teleport browser down [peer] --domains example.com
  abra-teleport browser revoke
  abra-teleport browser status
  abra-teleport browser close

Use --all-domains only when you intend to transfer every captured domain.

Codex round trip
  abra-teleport codex sessions
  abra-teleport codex inspect <uuid>
  abra-teleport codex up <peer> --session <uuid|last> --workspace <path> --confirm-workspace
  abra-teleport codex receive [snapshot-id] --workspace <path>
  abra-teleport codex run "task" --confirm-workspace [--return-to <peer>]
  abra-teleport codex resume [--return-to <peer>]
  abra-teleport codex down [peer] --confirm-workspace
  abra-teleport codex status

Codex up/down sends two Abra objects: a full workspace snapshot and a partial
Codex session adapter snapshot. Auth, config, OAuth files, and Codex databases
never enter the Codex adapter bundle. Use --allow-workspace-secrets only after
reviewing the local workspace scan.

Portable app
  abra-teleport app inspect
`;

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function need(value, message) {
  if (!value) throw new Error(message);
  return value;
}

async function doctor() {
  const abraPath = await abraBinary();
  const codexPath = process.env.CODEX_BIN || await executableOnPath('codex');
  let browserAdapter;
  try { browserAdapter = await browserAdapterDirectory(); }
  catch (error) { browserAdapter = { error: error.message }; }
  return {
    node: process.version,
    abra: abraPath,
    codex: codexPath || null,
    browser_adapter: browserAdapter,
    app_home: paths().home,
    abra_root: paths().abraRoot,
    codex_home: codexHome(),
    daemon: await daemonStatus()
  };
}

export async function main(argv) {
  if (argv[0] === 'agent') {
    const { connectAgent, agentTicket, listAgents, agentRemote } = await import('./agent.js');
    if (argv[1] === 'connect') return output(await connectAgent(argv[2], argv[3]));
    if (argv[1] === 'ticket') return output(await agentTicket());
    if (argv[1] === 'list') return output(await listAgents());
    if (argv[1] === 'remote') {
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      process.stdout.write(await agentRemote(request.config, request.argv)); return;
    }
    throw new Error('agent needs connect, ticket, list, or remote');
  }
  if (argv[0] === 'browser' && argv[1] === 'input') {
    const { handle } = await import('../scripts/sandbox-agent.js');
    return output(await handle({ ...JSON.parse(argv[2]), action: 'browser-input' }));
  }
  if (argv[0] === 'sandbox') {
    const { sandboxCommand } = await import('./sandbox.js');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('Sandbox request is too large.');
    }
    const request = JSON.parse(input);
    return output(await sandboxCommand(argv[1], request.config, request.payload));
  }
  if (argv[0] === 'browser' && argv[1] === 'exec') {
    const command = argv.slice(2);
    if (command[0] === '--') command.shift();
    return output(await browserExec(command));
  }
  const { positionals, flags } = parseArgs(argv);
  const [group, action, ...rest] = positionals;
  if (!group || group === 'help' || flags.help === true) {
    process.stdout.write(HELP);
    return;
  }

  if (group === 'setup') return output(await ensureDaemon());
  if (group === 'doctor') return output(await doctor());
  if (group === 'peers') { await ensureDaemon(); return output(await abra(['peers'])); }
  if (group === 'inbox') { await ensureDaemon(); return output(await abra(['inbox'])); }
  if (group === 'daemon' && action === 'stop') return output(await stopDaemon());
  if (group === 'pair') {
    await ensureDaemon();
    if (action === 'ticket') return output(await abra(['pair', 'ticket']));
    if (action === 'add') return output(await abra(['pair', 'add', need(rest[0], 'pair add needs a ticket')]));
    if (action === 'pending') return output(await abra(['pair', 'pending']));
    if (action === 'confirm') return output(await abra(['pair', 'confirm', need(rest[0], 'pair confirm needs a peer id')]));
    throw new Error('pair needs ticket, add, pending, or confirm');
  }

  if (group === 'browser') {
    if (action === 'profiles') return output(await browserProfiles());
    if (action === 'tabs') return output(await browserChromeTabs());
    if (action === 'cookie-inventory') return output(await browserCookieInventory(need(flags.profile, 'browser cookie-inventory needs --profile'), need(flags.url, 'browser cookie-inventory needs --url'), flags.title, flags['tab-id']));
    if (action === 'tab-inventory') return output(await browserTabInventory(need(flags.profile, 'browser tab-inventory needs --profile'), need(flags.url, 'browser tab-inventory needs --url'), flags.title));
    if (action === 'prepare') return output(await browserPrepare(flags));
    if (action === 'inventory') return output(await browserInventory(need(rest[0], 'browser inventory needs a Chrome profile')));
    if (action === 'open') return output(await ensureChrome({ headless: flags.headed === true ? false : flags.headless === true || process.platform !== 'darwin', proxy: flags.proxy }));
    if (action === 'up') return output(await browserSend(need(rest[0], 'browser up needs a peer id'), flags, 'up'));
    if (action === 'down') return output(await browserSend(rest[0], flags, 'down'));
    if (action === 'receive') return output(await browserReceive(rest[0], flags));
    if (action === 'revoke') return output(await browserRevoke());
    if (action === 'status') return output(await browserStatus());
    if (action === 'close') return output(await browserClose(flags));
    throw new Error('browser needs open, up, receive, exec, down, revoke, status, or close');
  }

  if (group === 'codex') {
    if (action === 'sessions') return output(await codexSessions());
    if (action === 'inspect') return output(await codexInspect(need(rest[0], 'codex inspect needs a session id')));
    if (action === 'up') return output(await codexSend(need(rest[0], 'codex up needs a peer id'), flags, 'up'));
    if (action === 'down') return output(await codexSend(rest[0], flags, 'down'));
    if (action === 'receive') return output(await codexReceive(rest[0], flags));
    if (action === 'run') return output(await codexRun(need(rest.join(' '), 'codex run needs a task'), flags));
    if (action === 'resume') return output(await codexResume(flags));
    if (action === 'status') return output(await codexStatus());
    throw new Error('codex needs sessions, up, receive, run, resume, down, or status');
  }

  if (group === 'app') {
    if (action === 'inspect') return output(await appInspect());
    if (action === 'stop') return output(await appStop());
    throw new Error('app needs inspect or stop');
  }

  throw new Error(`unknown command: ${[group, action].filter(Boolean).join(' ')}`);
}
