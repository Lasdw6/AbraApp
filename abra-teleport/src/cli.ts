import { browserSendTab, sandboxBrowserTabs } from './browser.js';
import path from 'node:path';
import { abra, abraBinary, browserAdapterDirectory, daemonStatus, ensureDaemon, stopDaemon } from './abra.js';
import { browserClose, browserExec, browserPrepare, browserReceive, browserRevoke, browserSend, browserStatus } from './browser.js';
import { browserChromeTabs, browserCookieInventory, browserInventory, browserProfiles, browserTabInventory, browserTabPreviews } from './browser-source.js';
import { browserMode, ensureChrome } from './chrome.js';
import { paths } from './paths.js';
import { executableOnPath, parseArgs } from './util.js';

const HELP = `abra-teleport

Move browser sessions and monitor paired agent sandboxes.

Setup and pairing
  abra-teleport agent connect <ticket-or-code> [name]  (8-character pairing codes)
  abra-teleport agent ticket [--full]
  abra-teleport agent list
  abra-teleport setup
  abra-teleport doctor
  abra-teleport pair ticket
  abra-teleport pair add <ticket>
  abra-teleport peers
  abra-teleport inbox
  abra-teleport browser available-tabs
  abra-teleport browser send-tab <tab-id>
  abra-teleport daemon stop

Browser round trip
  abra-teleport browser profiles
  abra-teleport browser tabs
  abra-teleport browser tab-previews
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

Connection status
  abra-teleport agent health < request.json
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
  let browserAdapter;
  try { browserAdapter = await browserAdapterDirectory(); }
  catch (error) { browserAdapter = { error: error.message }; }
  return {
    node: process.version,
    abra: abraPath,
    browser_adapter: browserAdapter,
    app_home: paths().home,
    abra_root: paths().abraRoot,
    daemon: await daemonStatus()
  };
}

export async function main(argv) {
  const browserMutation = argv[0] === 'browser' && !['status', 'tabs', 'tab-previews', 'profiles'].includes(argv[1]);
  const sandboxMutation = argv[0] === 'sandbox' && !['status', 'connect', 'browser-incoming'].includes(argv[1]);
  if (browserMutation || sandboxMutation) {
    const { withBrowserLock } = await import('./browser-lock.js');
    return withBrowserLock(() => dispatch(argv));
  }
  return dispatch(argv);
}

async function dispatch(argv) {
  if (argv[0] === 'agent') {
    const { connectAgent, agentTicket, listAgents, agentRemote } = await import('./agent.js');
    if (argv[1] === 'connect') return output(await connectAgent(argv[2], argv[3]));
    if (argv[1] === 'ticket') return output(await agentTicket({ shortCode: !argv.includes('--full') }));
    if (argv[1] === 'health') {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 16384) throw new Error('Connection request is too large.');
      }
      return output(await (await import('./connection-health.js')).checkConnection(JSON.parse(input).config));
    }
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
    if (action === 'available-tabs') return output(await sandboxBrowserTabs());
    if (action === 'send-tab') return output(await browserSendTab(need(rest[0], 'browser send-tab needs a tab id')));
    if (action === 'profiles') return output(await browserProfiles());
    if (action === 'tabs') return output(await browserChromeTabs());
    if (action === 'tab-previews') return output(await browserTabPreviews());
    if (action === 'cookie-inventory') return output(await browserCookieInventory(need(flags.profile, 'browser cookie-inventory needs --profile'), need(flags.url, 'browser cookie-inventory needs --url'), flags.title, flags['tab-id']));
    if (action === 'tab-inventory') return output(await browserTabInventory(need(flags.profile, 'browser tab-inventory needs --profile'), need(flags.url, 'browser tab-inventory needs --url'), flags.title));
    if (action === 'prepare') return output(await browserPrepare(flags));
    if (action === 'inventory') return output(await browserInventory(need(rest[0], 'browser inventory needs a Chrome profile')));
    if (action === 'open') return output(await ensureChrome({ headless: browserMode(flags), proxy: flags.proxy }));
    if (action === 'up') return output(await browserSend(need(rest[0], 'browser up needs a peer id'), flags, 'up'));
    if (action === 'down') return output(await browserSend(rest[0], flags, 'down'));
    if (action === 'receive') return output(await browserReceive(rest[0], flags));
    if (action === 'revoke') return output(await browserRevoke(flags.session));
    if (action === 'status') return output(await browserStatus());
    if (action === 'close') return output(await browserClose(flags));
    throw new Error('browser needs open, up, receive, exec, down, revoke, status, or close');
  }

  throw new Error(`unknown command: ${[group, action].filter(Boolean).join(' ')}`);
}
