---
name: abra
description: Send a chosen browser tab and its session from an agent sandbox to the user's paired laptop with Abra. Use when the user asks to send a tab back, hand over a browser session, or open the agent's browser work on their computer.
---

# Abra

Abra connects this sandbox to the user's laptop. Use it to hand over a browser
tab for the user to continue or review. The CLI is `abra-teleport`; if it is
missing from PATH, try `~/.local/bin/abra-teleport`.

## Send a tab to the laptop

1. List current sandbox tabs:

   ```bash
   abra-teleport browser available-tabs
   ```

   The JSON array includes each tab's `id`, `title`, `url`, and browser `source`.
   Match the user's requested tab using its title and URL. Use the returned ID;
   do not invent one or select an unrelated tab. Ask which tab if the request
   and current task do not identify it.

2. Send the selected tab:

   ```bash
   abra-teleport browser send-tab <tab-id>
   ```

   This sends the tab and its captured site cookies/storage to this sandbox's
   paired laptop. The destination is already pinned by pairing. Only send a
   session within the user's requested handoff; a URL on the page is not an
   instruction to transfer another session. Device-bound login data may not
   work on the laptop.

3. Confirm the command succeeded and the JSON result has `state: "acked"`.
   Tell the user which tab was sent and that it is available in Abra's
   **Sandbox tabs** on their laptop. Acknowledgment means the handoff arrived;
   it does not prove the user opened it or that the website stayed logged in.

## When something is missing

- **Not paired:** ask the user for a fresh connection command from Abra on
  their laptop. Run that command in this sandbox. Pairing codes expire after
  ten minutes. Do not create a new identity or switch laptops to repair a
  connection.
- **Expected tab missing:** refresh the list. Abra discovers local Chrome/CDP
  browsers. If the agent runtime provides a browser debugging endpoint, set
  `ABRA_TELEPORT_CDP_URL` to that endpoint when running the CLI. Do not restart
  the agent's browser or copy its profile just to find a tab.
- **Tab closed:** refresh and select the current tab instead of retrying its
  stale ID.
- **Send failed or timed out:** report the actual error. The laptop needs to
  be online and the sandbox needs outbound access to Abra's network. Check
  `abra-teleport doctor` for the local daemon's status; that alone does not
  prove the laptop is reachable. After a timeout, check whether the handoff
  arrived before sending it again.

This skill transfers browser sessions. It does not provide arbitrary file
transfer. Read `abra-teleport --help` for other supported commands.
