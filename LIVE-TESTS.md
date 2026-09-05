# Live tests — September 5, 2026

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
