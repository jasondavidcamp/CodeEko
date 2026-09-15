# Validation and bounded repair

Version 0.3 adds `run_validation {}` and automatic validation before an edited task completes. The executor, not the model, limits each task to three validation rounds. Unchanged repository fingerprints reuse the current result. Edits invalidate it. A failed final round blocks completion and further edits; changes remain uncommitted for review.

Version 0.4.1 also stops when failed validation is repeatedly requested without edits, or when an edit produces the same failure diagnostics. Moving diagnostic line numbers alone is not progress. This can end repair before the three-round maximum.

## Checks

- Windows PowerShell 5.1 parses changed PowerShell files without executing their statements. Explicit validation before edits parses all eligible PowerShell files.
- Available PSScriptAnalyzer runs its built-in rules against source text with explicit settings. It does not load repository analyzer settings or custom rules. Warnings and errors trigger repair. Files with `using module` or `#requires -Modules` are omitted from automatic analysis because resolution can import code.
- Supported Pester 4 or 5 runs only files selected by the developer in a multi-select picker. The approval covers up to three rounds in the current task. Empty selection skips execution. Known integration/e2e/acceptance/deployment/system filenames are excluded from candidates, but filenames do not establish safety. Selected tests and dependencies execute as the user: this is not a sandbox or network isolation mechanism. Approve only known unit tests. Newly created or renamed test paths require a new selection in a subsequent task if the current selection has already been made.

Parser/analyzer failures prevent Pester from starting in that round. Test failures, zero discovered tests, container failures and validator process failures cannot count as a pass. Missing modules or unapproved tests produce an explicit partial result. The agent receives bounded diagnostics to repair actual defects, with instructions not to weaken tests to hide failures.

## Workstation settings

These settings are application-scoped; repository settings and model actions cannot change them:

- `llmRuntime.pesterVersion` defaults to `Auto`, selecting the newest installed supported major. Choose `4` or `5` explicitly for a suite's requirements. Missing selected versions produce an omission, not a silent fallback. Changing the selected major invalidates cached validation results.
- `llmRuntime.installValidationModules` defaults to false. Enabling it permits one attempt per task to install missing modules into CurrentUser from the verified HTTPS PSGallery source. Pester is pinned to 4.10.1 when major 4 is selected, otherwise 5.7.1; PSScriptAnalyzer uses the gallery release. Connectivity, package-provider, license or publisher-policy failures leave reduced coverage and are never reported as a passed installation. The installer does not alter gallery trust, bypass publisher checks, or install globally.
- `llmRuntime.validationExecutionPolicy` defaults to `Inherit` and is captured when the task starts. `RemoteSigned` optionally permits local unsigned scripts in validation child processes only. It does not change machine settings or override Group Policy. An AllSigned workstation may block unsigned test fixtures; the failure appears in validation results.

The fixed runner uses the system Windows PowerShell executable, no profile, no interactive prompts, an isolated working directory, and an allowlisted environment without API keys or inherited module-search overrides. Repository paths/text arrive as JSON over stdin, not executable command interpolation. Each command has a 60-second limit (120 seconds for installation), a 256 KB combined output cap, and cancellation requests process-tree termination. Already completed script side effects cannot be undone by cancellation.

Version 0.4.3 attaches each validator to an unnamed Windows Job Object with kill-on-close and no breakaway permission before parsing the request or executing validation. A fixed C# bootstrap compiled with PowerShell `Add-Type` holds the non-inheritable job handle. Normal completion or forced validator exit closes that handle and terminates ordinary descendants. The host sends one JSON line and retains the input writer: a native background thread detects EOF on host exit and terminates the job. A separate native timer enforces the command duration even if the host stops servicing its own timer. Initialization or job-assignment failure blocks execution; there is no unguarded fallback. Constrained Language or other workstation restrictions may therefore prevent validation.

This is lifetime management, not a security sandbox. Tests still execute with the user's filesystem and network permissions. Processes launched through external services, scheduled tasks, WMI or other brokers are outside this job; already completed side effects remain. The trusted bootstrap compiles before job attachment, but no repository code runs before attachment succeeds. See Microsoft's [Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) for inheritance and broker limitations.

Native tests cover normal completion, cancellation, validator termination, owner loss before startup, an independent guard deadline and refusal under Constrained Language. `npm run test:recovery` kills only the real isolated VS Code extension-host PID and verifies that its active Pester validator and an ordinary descendant stop before the remaining test UI is closed. Representative workstation policy checks remain open.

## Results and limits

Task-private `validation.json` records rounds, commands, statuses and bounded diagnostics. Repository text fingerprints, HEAD and staged diff are checked for staleness. Editor buffers must be saved. Fingerprints cover readable manifest content, not every possible external or ignored-file side effect. A local process can still race checks. Validation is not a security boundary against malicious tests or installed modules.

The final UI summary distinguishes passed, failed, partial, unrun and stale results. A partial result is not proof of correct behavior. Reports are local plaintext alongside task snapshots. Task undo invalidates the historical validation result for the current working tree; see UNDO.md.

Parser/analyzer failures are compared with saved task-start source text without executing that source. Matching findings are labeled preexisting; findings absent from a complete baseline comparison are labeled new since the task baseline. Failed or truncated comparisons leave unknown origin. The final narrative includes bounded findings and the private report records checked file paths.

## Observed test baselines

Version 0.4.5 reuses approved `run_validation` results collected before the first edit. To establish a baseline, readable file hashes and HEAD must still match the captured task start, and validation must finish without a stale-state or interruption error. No reconstructed tree executes and no files are restored temporarily. The pre-edit run consumes one of the existing three rounds; no extra validation budget is added. Test selection and permissions remain required.

Pester 5 returns up to 200 case identities with the defining file, expanded test name, outcome and assertion message. A complete, unique case inventory with no skipped tests or container errors can serve as a baseline. Comparison requires the same Pester version and selected file set. For each unchanged test file, a previously passing case that fails is labeled newly failing, the same observed failure is preexisting, and a different failure message is labeled changed. Previously failing cases observed passing are listed as resolved. Changed test files, missing cases, duplicate names within the same file, skipped/truncated inventories, stale runs and incompatible versions retain unknown origin. Pester 4 continues to run but supplies no comparable case inventory in this release.

These labels describe observations, not causality. External dependencies, installed modules, nondeterminism and flaky tests can change outcomes. Neither matching failures nor passing checks prove that a task introduced no regression. Baselines live within the active task; historical reports remain in private storage, but a new task does not reuse an old baseline. Failure attribution is excluded from the no-progress signature, so relabeling the same failure cannot buy extra repair rounds.

Developer tests use synthetic repositories; real Pester fixture tests explicitly use process-only RemoteSigned and never change machine execution policy. Run `npm run test:live:validation` with the README's environment variables for a real-model repair demonstration. This requires supported Pester and PSScriptAnalyzer for a full pass.

References: [Pester configuration](https://pester.dev/docs/v5/usage/Configuration), [Pester 4 invocation](https://pester.dev/docs/v4/commands/Invoke-Pester), [Invoke-ScriptAnalyzer](https://learn.microsoft.com/en-us/powershell/module/psscriptanalyzer/invoke-scriptanalyzer?view=ps-modules).
