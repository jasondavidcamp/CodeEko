# Validation and bounded repair

Version 0.3 adds `run_validation {}` and automatic validation before an edited task completes. The executor, not the model, limits each task to three validation rounds. Unchanged repository fingerprints reuse the current result. Edits invalidate it. A failed final round blocks completion and further edits; changes remain uncommitted for review.

## Checks

- Windows PowerShell 5.1 parses changed PowerShell files without executing their statements. Explicit validation before edits parses all eligible PowerShell files.
- Available PSScriptAnalyzer runs its built-in rules against source text with explicit settings. It does not load repository analyzer settings or custom rules. Warnings and errors trigger repair. Files with `using module` or `#requires -Modules` are omitted from automatic analysis because resolution can import code.
- Supported Pester 4 or 5 runs only files selected by the developer in a multi-select picker. The approval covers up to three rounds in the current task. Empty selection skips execution. Known integration/e2e/acceptance/deployment/system filenames are excluded from candidates, but filenames do not establish safety. Selected tests and dependencies execute as the user: this is not a sandbox or network isolation mechanism. Approve only known unit tests. Newly created or renamed test paths require a new selection in a subsequent task if the current selection has already been made.

Parser/analyzer failures prevent Pester from starting in that round. Test failures, zero discovered tests, container failures and validator process failures cannot count as a pass. Missing modules or unapproved tests produce an explicit partial result. The agent receives bounded diagnostics to repair actual defects, with instructions not to weaken tests to hide failures.

## Workstation settings

Both settings are application-scoped; repository settings and model actions cannot change them:

- `llmRuntime.installValidationModules` defaults to false. Enabling it permits one attempt per task to install missing modules into CurrentUser from the verified HTTPS PSGallery source. Pester is pinned to 5.7.1; PSScriptAnalyzer uses the gallery release. Connectivity, package-provider, license or policy failures leave reduced coverage. The installer does not alter gallery trust, bypass publisher checks, or install globally.
- `llmRuntime.validationExecutionPolicy` defaults to `Inherit`. `RemoteSigned` optionally permits local unsigned scripts in validation child processes only. It does not change machine settings or override Group Policy. An AllSigned workstation may block unsigned test fixtures; the failure appears in validation results.

The fixed runner uses the system Windows PowerShell executable, no profile, no interactive prompts, an isolated working directory, and an allowlisted environment without API keys or inherited module-search overrides. Repository paths/text arrive as JSON over stdin, not executable command interpolation. Each command has a 60-second limit (120 seconds for installation), a 256 KB combined output cap, and cancellation requests process-tree termination. Already completed script side effects cannot be undone by cancellation.

## Results and limits

Task-private `validation.json` records rounds, commands, statuses and bounded diagnostics. Repository text fingerprints, HEAD and staged diff are checked for staleness. Editor buffers must be saved. Fingerprints cover readable manifest content, not every possible external or ignored-file side effect. A local process can still race checks. Validation is not a security boundary against malicious tests or installed modules.

The final UI summary distinguishes passed, failed, partial, unrun and stale results. A partial result is not proof of correct behavior. Reports are local plaintext alongside task snapshots. Task undo is a separate roadmap item.

Developer tests use synthetic repositories; real Pester fixture tests explicitly use process-only RemoteSigned and never change machine execution policy. Run `npm run test:live:validation` with the README's environment variables for a real-model repair demonstration. This requires supported Pester and PSScriptAnalyzer for a full pass.

References: [Pester configuration](https://pester.dev/docs/v5/usage/Configuration), [Pester 4 invocation](https://pester.dev/docs/v4/commands/Invoke-Pester), [Invoke-ScriptAnalyzer](https://learn.microsoft.com/en-us/powershell/module/psscriptanalyzer/invoke-scriptanalyzer?view=ps-modules).
