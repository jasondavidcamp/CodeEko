# Acceptance and validation

## Automated

Run `npm test`. The suite uses isolated temporary Git repositories and mock HTTPS responses. It never runs an external project’s scripts or integrations. Windows-only tests run explicitly authored synthetic Pester fixtures with process-only RemoteSigned.

- Traversal, sibling paths, absolute paths, alternate streams and Windows junctions are denied.
- Unknown/malformed/oversized or extra-field actions cannot execute; mutation is denied in Review and Custom, with general commands denied in every mode.
- Multi-root selection occurs before repository access and cancelling selection stops the operation.
- Tracked and untracked ignored files, generated output, sensitive names, binaries and linked paths are excluded.
- Lexical index refresh updates changed symbols and persists outside the repository.
- Model discovery normalizes paths, deduplicates IDs, handles empty/error responses and excludes credential-bearing error bodies.
- Cancellation aborts transport, index and loop before further execution.
- The loop retrieves evidence and stops at its action budget.
- Named threads survive reconstruction, separate repositories have distinct stores, running tasks recover as interrupted, corrupt history is not overwritten.
- A mocked VS Code host exercises command registration, SecretStorage, manual model fallback, conversation lifecycle, cancellation and the busy guard. The actual emitted webview script is syntax-checked. This does not replace a real Extension Development Host check.

## Live validation completed — 2026-09-14

`npm run test:live` passed against a public Gemini service using a process-environment credential. `npm run test:host` then passed the same real-model suite inside an isolated VS Code **1.138.0-insider** Extension Development Host. The installed stable editor was unavailable because its updater held a startup lock; its installation and configuration were left untouched.

The verified host result recorded:

- Extension activation, registration of all three commands, an unset endpoint default, and opening/closing the real conversation webview.
- Successful model discovery (56 returned IDs) and selection of `models/gemini-2.5-flash`.
- Four model calls across an explanation and a follow-up, with five actual source reads: module manifest, module loader, public function, private helper, and Pester test.
- Correct file/line citations and calculations: four workers produce capacity 28 and available slots 25; a follow-up for five workers produces 35 and 32.
- Two named threads saved and loaded from disk; the follow-up uses the reloaded history.
- Updated symbol discovery after a saved file change, cancelled live HTTP requests, excluded fixture files, and unchanged repository content/status after the test restores its deliberate indexing edit.

The first live attempt correctly rejected a model action that omitted `version`. The prompt now includes concrete versioned examples, and one bounded correction request can recover a malformed response without executing it. Regression tests cover successful correction and refusal after a second invalid response. Explicitly versioned API bases are also preserved rather than having another `/v1` appended.

These tests send only a small synthetic PowerShell fixture. They do not read or send another project's source, copy credentials into settings/files, run the fixture's PowerShell code, or alter normal VS Code settings. API credentials, endpoint selection, and machine-specific executable paths remain environment configuration. The live suite is opt-in and excluded from ordinary `npm test`; the VSIX excludes all test harness code. See [Development](DEVELOPMENT.md) for environment variables and commands.

Scope: the host test checks the real panel lifecycle, then invokes the real agent/tool loop directly within the extension host. It does not automate typing into the webview, entering a key through the UI, or restarting VS Code between conversational turns. Visual/keyboard checks, actual UI key entry, whole-application restart recovery, representative production repositories, and other endpoint/proxy/certificate configurations remain to be checked.

## Editing validation completed — 2026-09-14

The 0.2 automated suite covers exact multi-file patches, creation, confirmed delete/move, stale hashes, protected developer spans, dirty buffers, changed destinations during approval, cancellation, permission revocation, encoding/BOM/newline preservation, empty files, ambiguous replacements, hard links, ignored paths and nested repositories. A configured Git clean-filter tripwire verifies that inspection does not execute the filter. Mock UI checks verify cancellation after an applied edit and reopening recorded diffs.

`npm run test:live:editing` passed against `models/gemini-2.5-flash` in seven model calls. The isolated VS Code 1.138.0-insider host then passed both live suites: four read-only calls and seven editing calls. The editing task changed a PowerShell multiplier from 7 to 9, updated the Pester expectation from 28 to 36, and created `docs/CHANGE.md`. Exact byte assertions verified that an existing developer comment, UTF-8 BOM/CRLF encoding, staged index and HEAD were preserved. All three changes remained uncommitted. Saved review snapshots reloaded successfully, and three actual native text-diff tabs opened in the host.

This demonstrates editing and review on a synthetic fixture, not execution of its Pester tests. Whole-application crash recovery, interactive destructive-operation approval, visual/keyboard review, and representative repository testing remain manual gates. Atomic replacement does not eliminate external-process races; interrupted moves require inspection. Automatic validation and undo remain future work.

## Validation evidence — 0.3

Live Gemini repaired a real failing Pester assertion in two validation rounds and seven model calls. PowerShell 5.1.26100.9444 parsing, PSScriptAnalyzer 1.25.0, and Pester 5.7.1 passed afterward. Test expectations, staged developer work and HEAD remained unchanged; the implementation and documentation changes remained uncommitted. CurrentUser analyzer installation succeeded. The default AllSigned policy was respected by the production runner; synthetic execution tests used process-only RemoteSigned.

Automated checks cover automatic completion validation, diagnostic redaction, three-round exhaustion, invalid test selection, stale results, missing tools, declined tests, real parsing without execution, real failing Pester tests and active-process cancellation. See VALIDATION.md for execution limits and outstanding manual approval/policy checks.

All 31 automated tests passed. The full isolated VS Code 1.138.0-insider host suite also passed: read-only retrieval, multi-file edits, native diff tabs, and real validation/repair. The host repair demonstration used eight model calls and two validation rounds.

## Undo evidence — 0.4

All 38 automated tests passed, including seven undo tests covering exact UTF-8/UTF-16LE restoration, patch/create/delete/move reversal, staged-work preservation, all-path preflight, approval-time changes, permission/dirty-buffer/HEAD checks, corrupt snapshots, unconfirmed edits, pending-journal recovery and cancellation after one restoration. The mock panel test exercised the Undo button and confirmation.

The full isolated VS Code host suite passed again. Its live editing task was undone after native diff review; exact original source/test bytes and preexisting developer changes were restored, the created document was removed, and staged work remained unchanged. Validation/repair also passed in two rounds. Actual whole-application termination and manual native confirmation interaction remain separate pilot gates.

## Actual restart recovery — 0.4.1

`npm run test:recovery` passed in VS Code 1.138.0-insider. Its launcher terminated the isolated instance while a real synthetic Pester test was running after an applied repository edit. The owned validation child was verified stopped. Reopening the same profile recovered two named threads, interrupted status and the applied edit. The native conversation panel reopened, no mutation replayed automatically, no interrupted validation was reported as passed, and undo restored the baseline while preserving staged developer work.

The test seeds state through the runtime's real task/thread classes, rather than typing a feature request into the webview. It uses no API credential, modifies only its synthetic repository/profile, and does not simulate power loss during a filesystem write. The original 0.4.1 launcher killed the owned process tree. In 0.4.3 it kills the extension-host PID alone and verifies that the validator and its ordinary descendant stop before closing the remaining UI. Restart recovery, preserved staged work and undo passed again in VS Code 1.138.0-insider. Interactive and mid-write cases remain manual/hardening gates.

Native lifetime tests additionally verify cleanup after completion, cancellation and forced validator termination, preservation of a separately launched process, an independent guard deadline, startup after owner-pipe closure, and refusal under Constrained Language. These fixtures do not establish confinement of broker-launched processes or malicious test code.

## Remaining manual pilot gate

Read/hash correction (0.4.6): regression tests reproduce a patch attempted without a current-task read, verify successful rereading and editing, stop after two failed corrections, and prove that an actual external edit still stops immediately without overwriting it. `npm run test:live:read-recovery` injects the missing-read attempt into a synthetic live validation task, then lets the configured model recover and repair the real Pester failure. It uses the environment-only credentials documented in [Development](DEVELOPMENT.md) and preserves test expectations and staged work.

Observed test baselines (0.4.5): deterministic tests cover repeated/new/changed/resolved failures and unknown origin for missing, skipped, truncated, duplicate, edited-test, version-mismatched and stale observations. A real Pester 5 fixture starts with one failing and one passing test, introduces a second failure, then fixes both in the third round while preserving test bytes and staged work. The report distinguishes preexisting and newly failing cases and persists observed resolution. Empty container-error entries are omitted; actual discovery errors remain failures. This establishes observations on a synthetic repository, not causal attribution or representative-workstation compatibility.

File-interruption hardening (0.4.4): `npm test` forcibly kills isolated Node workers at eleven filesystem/journal boundaries, including a partially written temporary file and a move with two linked names. The workers run real repository operations with test-only filesystem interception; the runtime has no crash-control flags. Reload preserves pending evidence, baseline snapshots, BOM/newlines, HEAD and staged work; it neither replays changes nor guesses an undo. A recorded create has no temporary alias and can be undone after reload. Tests also verify that a conflict after recording intent blocks further mutations without replacing evidence. Representative workstation and power-loss cases remain open.

Pester selection (0.4.2): deterministic tests cover selected-major discovery/execution, cache invalidation and failed optional installation reporting. The real Pester 5 adapter reports both passing and failing assertions. Real Pester 4 execution remains skipped: installation was rejected because its publisher certificate chain differed from the installed Pester 5 version. Publisher verification was preserved.

Validation hardening (0.4.1): tests verify preexisting/new/unknown source finding attribution, refusal to repeat failed validation indefinitely, and early stopping when diagnostics remain identical after a repair. Baseline Pester execution is not inferred; its absence is reported explicitly.

1. Build and install the VSIX in a clean Windows VS Code profile with access to your configured endpoint.
2. Set the HTTPS API endpoint, store an individual key and select a dynamically discovered model. Interrupt endpoint connectivity and verify the configured/manual model fallback and useful timeout error. Verify certificate/proxy handling without disabling TLS.
3. Open the real PowerShell 5.1 repository. Create two named threads, ask different questions and restart VS Code; verify histories and repository association.
4. Ask “Explain how the entry point loads its modules and where those behaviors are tested. Cite paths and lines.” Compare the answer against source; verify searches/read actions support the answer.
5. Add an uncommitted function, save it and ask about it. Verify refreshed symbols and unchanged working-tree content. Unsaved editor changes are outside this release's disk index.
6. Cancel a slow model request and a search. Verify no subsequent actions run and the thread reports cancelled. Close the panel mid-task and reopen it after cancellation finishes.
7. Open a multi-root workspace; verify selection precedes tool activity. Open the same repository in a second window and verify the lease prevents overlapping sessions.
8. Inspect Source Control before/after each question. All preexisting files must remain byte-for-byte unchanged and no index/chat artifacts should appear in the repository.
9. Check keyboard access, progress updates, long responses, narrow panel layouts, and literal rendering of HTML-like content.

Additional host coverage (0.4.6): the live suite passed twice in VS Code 1.138.0-insider, with the expanded run verifying rejection of edits against a real unsaved editor document while preserving both buffer and disk contents. It also injected a missing-read patch before live Gemini recovery and successful second-round Pester validation. Native diffs, task undo, staged work, encoding preservation, explanation/follow-up, indexing refresh and cancellation passed. A separate host-only crash/restart run verified process cleanup, thread recovery, no replay and undo. Stable VS Code launches were blocked by an update in progress; stable-host verification remains open. The host opens the real panel and diff editors, but task prompts and approval responses are supplied by the test harness, not through interactive webview controls.

These interactive and endpoint tests are required before declaring Phase 1/2 exit criteria satisfied. Packaging and mock tests alone do not establish endpoint compatibility or the full pilot outcome.
