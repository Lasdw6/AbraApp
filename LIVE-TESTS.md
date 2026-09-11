# Live tests — September 5, 2026

## Grokbot: passed

The installed Grok Bot app ran the published installer inside its Debian 13 x64 sandbox, then paired with an isolated laptop identity over Abra's iroh transport. The sandbox had Node 20 and Chrome 151; the installer supplied its own compatible Node runtime. Grokbot's download approval was completed by the user.

All eight live checks passed with the current app-side CLI and the published agent CLI: authenticated connection health, browser send, remote preview, synthetic cookie return, localStorage return, tab return, connection health after the transfer, and detection of the stopped remote daemon. The test used an isolated Chrome profile and synthetic state at example.com. No personal browser credentials were transferred.

The local integration suite also verifies connection loss and recovery by stopping and restarting a paired daemon, retains the last successful contact time, and checks migration away from the removed adapter. Token monitoring is out of scope; the UI reports connection health only.

The temporary local and remote Abra daemons were stopped afterward. The Grokbot CLI remains installed for future pairing.

Reports: `/Users/vividh/Desktop/abra-test-results/grokbot-20260905/`.

## Existing Grokbot browser and session revocation: functional checks passed; browser exit unresolved

The updated CLI automatically reused Grokbot's visible Chrome on display `:4` (CDP port `9226`), including its nested logging launcher. Discovery stays scoped to the agent's display; another agent's browser on `:5` was not selected.

Ten live checks passed: connection health, browser send, reuse of the existing browser, a screenshot through the CLI, synthetic cookie return, localStorage return, tab return, connection after transfer, session revocation, and repeated revocation. The test used only synthetic example.com state and an isolated Abra identity. Revocation removed the imported browser context; it does not invalidate the website's login token globally. The user's separate active X handoff was left untouched.

After the second revocation, Grokbot’s provider Chrome on port `9226` exited. A direct probe returned curl exit 7 (connection refused), and its original PID was gone. The adapter uses `Target.disposeBrowserContext` for external-browser revocation; its process-kill path applies only to owned local profiles. The Chrome log ended with crashpad diagnostics at the revocation timestamp but did not identify a cause. Browser survival after revocation on this Grokbot runtime is therefore **not verified**. The local integration test preserves provider tabs/cookies after revocation, but that does not resolve this live discrepancy. The real X browser on display `:5` stayed running, and both isolated test daemons were stopped.

The app no longer embeds a browser preview or remote input controls. It shows connection and session details with Bring back and Revoke session. Reports are in `visible-browser-result.json` and `visible-remote-preview.png` under the Grokbot report directory above. These changes were tested from local source and patched into the test CLI; at the time of that test, the public installer still served `v0.3.0-rc.1`.

## Desktop UI refresh: passed

Fable 5.1 improved the frontend from the prompt “Improve this apps UI.” Its Electron mock renders covered the tab picker, cookie selection, active sandbox session, first-run pairing, agent menu, and generated command. An additional offline render verified the unreachable status. The installed Mac app was then checked against the real connection: the agent was connected and the existing X handoff was preserved, with Bring back and Revoke session visible and no embedded browser.

The 13 CLI tests and two desktop startup tests passed, including live-browser integration. Type checks, the Mac app build, and the Windows/WSL package build passed. The Windows package was not run on Windows during this pass. The installed Mac copy was updated with a backup of the previous app. No commit, push, or release was made during that UI-only pass.

## Multiple sessions and sandbox tab transfer: passed

The browser integration test now sends two independent sessions, rejects ambiguous return/revoke requests, revokes one without affecting the other, and returns the remaining session. It also lists and pulls a sandbox tab, receives a tab sent by the agent CLI, and verifies synthetic cookies and storage while preserving the original provider tab. A cross-process test verifies serialization of concurrent browser operations and recovery after a killed CLI. All 14 CLI tests and two desktop tests passed across the final suite and targeted lock test.

Electron mock renders covered the multiple-session navigation and sandbox tab screen, including incoming tabs. The installed Mac app was updated and verified connected with the existing X handoff preserved; Send another tab reopened the picker without ending that handoff. Type checks and the Mac and Windows/WSL builds passed. Grokbot’s installed CLI was then updated to preview 2. A live read-only check confirmed multiple-session support, preserved the active handoff, and listed two tabs across two sandbox Chrome instances. The new pull/send flows have integration coverage but have not been exercised against those personal live tabs. The Windows package still needs first-run testing on Windows.

## Sandbox tabs through the adapter inventory: passed (September 11, 2026)

Sandbox tab listing now calls `abra-teleport inventory` on the agent. That runs
`abra inventory --adapter dev.abra.browser-session` and passes the browsers the
sandbox already has (its attached or owned Chrome, the configured endpoint, and
any found on the agent's desktop) as the adapter's `cdp_urls` option. The
adapter lists their tabs itself and marks them transferable. Pulling one sends
the item's `source` object unchanged, so the agent no longer captures a separate
local selection first. An agent whose CLI, Abra build, or adapter lacks the
inventory verb falls back to `browser available-tabs` and the old
`send-tab <target-id>` path.

The local browser integration suite ran against Abra core `20c818a` with real
Chrome and two isolated daemons. The handoff test listed the provider tab
through the inventory, pulled it, received a tab sent by the agent CLI, and
preserved the original provider tab and cookies. 35 of 38 CLI tests passed with
two Windows tests skipped. The one failure, the manual cookie override round
trip, predates this work: the browser adapter reports
`supportsManualCookieOverride` as false, so the CLI refuses the override. No
remote sandbox was available for this pass, so the flow has not run against a
Linux agent yet.

## Linux Chrome startup follow-up

The Linux CI integration run failed on the initial Chrome debugging request before any transfer. Chrome had written its port file but the endpoint timed out. Preview 3 waits for the newly launched endpoint to become ready, with a regression test for delayed readiness and process exit. All 15 CLI tests and two desktop tests then passed locally, including browser integration; type checks and both package builds also passed.

## Computer-use test: passed

The actual Electron app ran against two isolated Abra identities with synthetic localhost tabs. Through the visible UI, two sessions were sent, the picker was reopened while a session remained active, one session was revoked, and the other was brought back. The agent CLI then sent its own tab; the incoming indicator appeared, Open on this computer accepted it, and the sandbox tab’s Pull button created another local copy. All three returned contexts preserved the expected synthetic cookie and localStorage values. The original sandbox tab and cookie remained intact. Stopping the isolated daemon changed the UI to Unreachable and disabled pulling; restarting it and using Check now restored Connected.

The installed app also listed the real Grokbot tabs while preserving the existing X handoff. No real tabs were pulled or revoked. Selecting another session now clears a stale operation message that could otherwise still say Session revoked. Reports are in `/Users/vividh/Desktop/abra-test-results/ui-cHotuL/`. The full Linux CI run passed, including browser tests, PowerShell syntax, and the Windows WSL package build, after repairing missing optional Rollup platform entries in the lockfile.

## Earlier release tests

The Codex features mentioned below have since been removed. These results describe the earlier release.

## Firecracker: passed

A fresh nested-KVM EC2 host booted a Firecracker guest with Node 22, Chrome 152, and Codex 0.153.4. The published `v0.3.0-rc.1` command installed Teleport inside that guest and paired with an isolated laptop identity over iroh. A second run reused the installed CLI.

All 12 checks passed: installation/pairing, discovery, guest control, browser preview, changed cookie return, changed localStorage return, tab return, matching Codex versions, workspace restore, rejection of divergent laptop edits, workspace/transcript return, and the internal observer in the returned signed snapshot.

Fixtures contained synthetic browser state and a synthetic Codex transcript. No personal login or paid model call was used. SSH prepared fixtures and inspected results; it carried no Abra transfers. The guest image needed its DNS resolver configured before the test. The first test runner attempt incorrectly parsed the browser preview’s two JSON records as one document; using the app’s existing parser fixed the runner.

## Daytona: blocked at pairing

The default sandbox installed the original source-build package successfully. The published package then installed into a fresh directory without compiling Abra. The internal observer created a signed workspace snapshot.

Pairing failed with `transport: timed out`. TLS connections from the sandbox to the default iroh relay reset; relay access worked from the Firecracker guest. Browser and Codex transfer therefore could not run on Daytona. This is a failed connectivity test, not a successful provider round trip.

Daytona documents organization-level network restrictions that can prevent sandbox access to unlisted destinations: https://www.daytona.io/docs/en/network-limits/ . A fresh Daytona probe also failed to download from `https://abra.vividh.lol/install.sh` with `curl: (35) Recv failure: Connection reset by peer`. That probe sandbox was deleted.

## Cleanup

The test Daytona sandbox was deleted. The Firecracker guest was stopped, and its temporary EC2 instance, security group, and key pair were removed. Existing EC2 instances were left running.

Full local reports are under `/Users/vividh/Desktop/abra-test-results/teleport-live-20260905/`.

## Custom installer domain: passed

`abra.vividh.lol` resolves to GitHub Pages with a valid HTTPS certificate and HTTPS enforcement. Its hosted script matches the published installer. A fresh isolated macOS install paired over iroh in 6.3 seconds, discovery succeeded, and a second connection command reused the installed CLI. A regression test verifies that a failed installer download returns failure to the agent.
