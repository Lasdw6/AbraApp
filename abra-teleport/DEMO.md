# Configured demo

Launch `~/Applications/Abra Teleport.app`. Everything needed for the normal demo is available in its Browser and Codex screens; no terminal commands are part of the flow.

The cloud endpoint is a standalone Ubuntu EC2 VM in `us-west-1`. Paperplanes is not installed or used. Its SSH access is restricted to the configured local public IP.

The status pill in the top-right turns green when both endpoints are ready. The activity panel shows every handoff and reports the actual error if a step fails.

The VM and its stable public IPv4 address incur AWS charges while allocated. Infrastructure details are stored in `~/.abra-teleport/cloud/endpoint.json` for the app.
