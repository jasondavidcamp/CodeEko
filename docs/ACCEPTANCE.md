# Acceptance and validation

## Automated

Run `npm test`. The suite uses isolated temporary Git repositories and mock HTTPS responses. It never runs the pilot repository's scripts, Pester tests, integrations or environment-changing operations.

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

These tests send only a small synthetic PowerShell fixture. They do not read or send another project's source, copy credentials into settings/files, run the fixture's PowerShell code, or alter normal VS Code settings. API credentials, endpoint selection, and machine-specific executable paths remain environment configuration. The live suite is opt-in and excluded from ordinary `npm test`; the VSIX excludes all test harness code. See the README for environment variables and commands.

Scope: the host test checks the real panel lifecycle, then invokes the real agent/tool loop directly within the extension host. It does not automate typing into the webview, entering a key through the UI, or restarting VS Code between conversational turns. Visual/keyboard checks, actual UI key entry, whole-application restart recovery, representative production repositories, and other endpoint/proxy/certificate configurations remain to be checked.

## Editing validation completed — 2026-09-14

The 0.2 automated suite covers exact multi-file patches, creation, confirmed delete/move, stale hashes, protected developer spans, dirty buffers, changed destinations during approval, cancellation, permission revocation, encoding/BOM/newline preservation, empty files, ambiguous replacements, hard links, ignored paths and nested repositories. A configured Git clean-filter tripwire verifies that inspection does not execute the filter. Mock UI checks verify cancellation after an applied edit and reopening recorded diffs.

`npm run test:live:editing` passed against `models/gemini-2.5-flash` in seven model calls. The isolated VS Code 1.138.0-insider host then passed both live suites: four read-only calls and seven editing calls. The editing task changed a PowerShell multiplier from 7 to 9, updated the Pester expectation from 28 to 36, and created `docs/CHANGE.md`. Exact byte assertions verified that an existing developer comment, UTF-8 BOM/CRLF encoding, staged index and HEAD were preserved. All three changes remained uncommitted. Saved review snapshots reloaded successfully, and three actual native text-diff tabs opened in the host.

This demonstrates editing and review on a synthetic fixture, not execution of its Pester tests. Whole-application crash recovery, interactive destructive-operation approval, visual/keyboard review, and representative repository testing remain manual gates. Atomic replacement does not eliminate external-process races; interrupted moves require inspection. Automatic validation and undo remain future work.

## Remaining manual pilot gate

1. Build and install the VSIX in a clean Windows VS Code profile with access to your configured endpoint.
2. Set the HTTPS API endpoint, store an individual key and select a dynamically discovered model. Interrupt endpoint connectivity and verify the configured/manual model fallback and useful timeout error. Verify certificate/proxy handling without disabling TLS.
3. Open the real PowerShell 5.1 repository. Create two named threads, ask different questions and restart VS Code; verify histories and repository association.
4. Ask “Explain how the entry point loads its modules and where those behaviors are tested. Cite paths and lines.” Compare the answer against source; verify searches/read actions support the answer.
5. Add an uncommitted function, save it and ask about it. Verify refreshed symbols and unchanged working-tree content. Unsaved editor changes are outside this release's disk index.
6. Cancel a slow model request and a search. Verify no subsequent actions run and the thread reports cancelled. Close the panel mid-task and reopen it after cancellation finishes.
7. Open a multi-root workspace; verify selection precedes tool activity. Open the same repository in a second window and verify the lease prevents overlapping sessions.
8. Inspect Source Control before/after each question. All preexisting files must remain byte-for-byte unchanged and no index/chat artifacts should appear in the repository.
9. Check keyboard access, progress updates, long responses, narrow panel layouts, and literal rendering of HTML-like content.

These interactive and endpoint tests are required before declaring Phase 1/2 exit criteria satisfied. Packaging and mock tests alone do not establish endpoint compatibility or the full pilot outcome.
