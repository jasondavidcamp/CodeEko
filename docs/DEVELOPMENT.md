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

Run `./scripts/Test-CodeEkoStreaming.ps1` in PowerShell 5.1 or 7. Enter the configured API base URL, exact model ID and key at the prompts. The key prompt is hidden. The probe sends two synthetic requests (normal and streaming), with a 300-second limit each, and prints a metadata-only JSON report. It detects SSE framing independently of the content-type header and records the first 20 content-chunk arrival times. No repository files are sent and no response text or credentials are exported. These are live, potentially billable requests. This probe does not enable streaming in CodeEko.
