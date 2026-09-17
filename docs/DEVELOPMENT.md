# Development

Use Node.js 22 or newer and npm for development only:

```powershell
npm ci
npm test
npm run package
```

Press F5 to launch an Extension Development Host. Packaging produces a single VSIX containing compiled JavaScript and Zod (the only runtime library). TypeScript, VS Code types and `vsce` are development dependencies. Git runs as fixed argument arrays with no shell, a 15-second timeout, disabled fsmonitor, optional locks disabled, and a 4 MiB output cap. Fixed validation commands and automatically inspected Pester tests are supported; general command execution is unavailable. See [Validation](VALIDATION.md) for selection, module installation, execution policy and process limits.

Developer references are included in [Architecture](ARCHITECTURE.md), [Protocol](PROTOCOL.md), and [Acceptance](ACCEPTANCE.md). The roadmap remains the long-term product direction.

Optional live tests use an isolated synthetic PowerShell repository. Set `CODEEKO_TEST_ENDPOINT`, `CODEEKO_TEST_API_KEY`, and `CODEEKO_TEST_MODEL` in the process environment, then run `npm run test:live`, `npm run test:live:editing`, or `npm run test:live:validation`. Use `npm run test:live:literal-recovery` to exercise repeated-name recovery and a six-character function/test update in a synthetic repository. These tests make billable model requests and are excluded from `npm test`. Run `npm run test:host` to test all three suites and actual native diff tabs in the VS Code extension host; Microsoft's development-only `@vscode/test-electron` helper downloads a separate test build into the OS temporary directory. Set `CODEEKO_VSCODE_VERSION` to choose a version (default `stable`), or set `CODEEKO_VSCODE_EXECUTABLE` to use an existing executable. It launches a temporary profile without changing your normal VS Code settings. Never put test keys in source files or committed settings.

## Source installation

See [Getting started](GETTING_STARTED.md) for the build-and-install script.

## Streaming endpoint probe

For a transport comparison inside the installed extension host, run **CodeEko: Compare Request Timing → Transport and compression**. It compares the same serialized production hello request through VS Code fetch and a reused PowerShell HttpClient, with default and identity encoding. The fixed worker source is compiled with the extension; it needs no downloaded scripts or modules. `test/transportComparison.test.ts` verifies scheduling, request equality, unchanged chat settings, failure filtering, cancellation and redaction with fake providers. `test/powerShellTransport.test.ts` runs both available Windows PowerShell 5.1 and PowerShell 7 engines against a loopback HTTP fixture using only an in-memory test copy that accepts HTTP. It verifies delayed/mislabeled SSE, actual gzip decompression, redirects/errors and owned-worker cleanup. Production URLs still require HTTPS and normal certificate verification. Test results do not establish behavior on a different workstation, proxy or provider.

### Automated idle/repeat test

Copy **only** `scripts/Test-CodeEkoWarmup.ps1` to the test workstation and run `./Test-CodeEkoWarmup.ps1`. It prompts for the HTTPS API base URL, exact model ID and hidden API key. No Node installation, repository checkout or companion files are needed there.

Defaults are five sequential requests per batch, three batches, and 600 seconds without probe requests between batches: 15 requests plus 20 minutes of idle time. Each request uses the same synthetic fresh-chat `hello` payload generated from CodeEko's production agent protocol and compatibility formatter. There is no accumulated conversation history, repository access, tool execution or automatic retry. The transport is PowerShell/.NET, not the VS Code extension host. No initial idle period is assumed, and an idle period does not guarantee a cold provider or cache expiry. Avoid unrelated model activity during the run if testing idle behavior.

The default settings match Full access, User message compatibility, streaming enabled, temperature zero and `max_tokens: 4096`. Match a different CodeEko configuration using `-PermissionMode Review`, `-PermissionMode Workspace`, `-CompatibilityMode Standard`, or `-NoStreaming`. Model/endpoint selection remains explicit. By default one HttpClient is reused across all batches; this permits connection pooling but does not prove a TCP connection survived an idle period. For a separate comparison, `-FreshConnections` creates a client per request and sends `Connection: close`.

The script writes a uniquely named `codeeko-warmup-*.json` in the current directory before starting and checkpoints after every request. Use `-OutputPath` to choose a different new file; existing files are refused. Ctrl+C or process termination leaves previously saved measurements available, with `completed: false`. Reports contain request timing, batch/position, actual idle duration, bounded error codes/types, token usage when supplied, and valid-reply counts. Empty responses, unsupported actions, malformed output and unsuccessful requests are excluded from valid-reply latency summaries. The summary does not evaluate greeting quality. No key, endpoint, response text or arbitrary exception message is saved.

For a longer unattended run: `./Test-CodeEkoWarmup.ps1 -Batches 6 -RequestsPerBatch 10 -IdleSeconds 600`. Idle intervals and batch sizes are configurable; all requests remain sequential. Send the JSON report after completion. Do not interpret differences from the extension solely as a provider effect because the HTTP stacks differ.

Maintainers: edit `scripts/probes/ApiWarmup.template.ps1`, then run `npm run build` and `node scripts/Build-CodeEkoWarmup.cjs`. The generator embeds current message profiles and reuses the existing streaming probe's byte reader and redacted error collector. Tests verify generated-file consistency, real Windows PowerShell 5.1 execution against a loopback fixture, equality with production messages, waits/checkpoints, output-file protection, and invalid-reply exclusion.

### Streaming on/off test

Run `./scripts/Test-CodeEkoStreaming.ps1` in PowerShell 5.1 or 7. Enter the configured API base URL, exact model ID and key at the prompts. The key prompt is hidden. The probe sends three pairs of synthetic requests (normal and streaming), reversing order on alternate pairs, with a 300-second limit each, and prints a metadata-only JSON report. It detects SSE framing independently of the content-type header and records raw first-body-byte timing, byte/chunk counts and the first 20 content-chunk arrival times. Use `-Pairs 1` for a shorter two-request check. All requests use the same synthetic prompt; this isolates a basic API call but does not reproduce CodeEko repository context. Save the report with `./scripts/Test-CodeEkoStreaming.ps1 | Set-Content -Encoding UTF8 "$env:USERPROFILE/Desktop/api-timing.json"`. Probe version 4 includes a failure stage and up to 12 nested exception records with allowlisted type names, numeric HRESULTs and available WebException/socket codes. Exception messages, stack traces, URLs and arbitrary exception data are excluded. Unknown exception types appear as `OtherException`; these codes are diagnostic clues, not definitive attribution to the provider. No repository files are sent and no response text or credentials are exported. These are live, potentially billable requests. This probe does not enable streaming in CodeEko.
