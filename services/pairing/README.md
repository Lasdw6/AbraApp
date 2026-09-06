# Short pairing codes

The desktop creates a signed Abra ticket and replaces it with a code such as `ABRA-K7M2Q4XT` (eight random characters plus the prefix) in the connection command. The installer installs or upgrades the agent CLI if necessary, then the CLI redeems the code and verifies the original ticket through Abra. Existing installations pair without downloading the archive again.

New codes contain 40 random bits and act as temporary lookup credentials. The trusted pairing service holds the signed ticket over HTTPS in a DynamoDB table encrypted at rest; it can read that ticket. The code itself is not stored. Short codes rely on server access controls, request limits, expiry, and single-use redemption, rather than serving as encryption keys. Browser sessions never pass through this service.

Older 22-character codes remain supported: their 128 random bits derive separate lookup and AES-256-GCM keys, so those tickets remain encrypted from the service.

Tickets expire after at most ten minutes. Redemption atomically deletes the record, so only one request succeeds. Expired records cannot be redeemed even while DynamoDB's asynchronous TTL cleanup is pending. A lost redemption response consumes the code; generate a new command to retry.

The service accepts HTTPS POST requests at `/v2/tickets` and `/v2/redeem` (and the legacy `/v1` routes). Neither codes nor tickets appear in request URLs. It limits requests to 30 per source IP per minute and 600 total per minute, and accepts at most 16,000 characters of ciphertext. It stores only hashes of IPs for rate counting and expires those counters. The function has no logging permissions and its IAM role can only put, update, or delete records in its own table.

## Development and deployment

```sh
npm run check
npm run test:pairing
npm run deploy:pairing
```

Deployment uses the AWS CLI and CloudFormation in `us-east-1` by default (`AWS_REGION` overrides it). `stack.json` defines the Lambda function, public HTTPS function URL, IAM role, and encrypted DynamoDB table. The deploy script bundles the pinned AWS SDK and uploads the function code. The account concurrency quota bounds Lambda execution; no reserved concurrency is configured.

The production endpoint is in `abra-teleport/src/pairing-code.ts`. `ABRA_TELEPORT_PAIRING_URL` overrides it for CLI development. `abra-teleport agent ticket --full` creates the older self-contained command without contacting the code service.

The public installer is `docs/install.sh`, generated from `abra-teleport/scripts/connect.sh` when packaging the agent. Publish the referenced GitHub Release archive before the updated Pages installer becomes live. The archive checksum is pinned in that installer.
