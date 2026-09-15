# Task-scoped undo

Task-scoped undo remains internal and is not offered in the chat menu; use native Source Control for reviewing changes. Internal undo retains native previews and preflight checks. Workspace requires an in-pane confirmation, while Full access skips it. Review and legacy Custom settings cannot undo.

Undo restores the recorded starting bytes, including preexisting developer edits and original encoding/BOM/newlines. It removes task-created files and restores task-deleted files. A move is reversed through its recorded source and destination changes. It never changes the Git index or creates a commit.

All affected paths are checked before restoration begins and again before each write. Undo refuses changed content, dirty editor buffers, linked paths, ignored/protected paths, a changed HEAD, corrupt snapshots, and unconfirmed edit operations. It does not attempt a fuzzy reverse patch. Later edits—even unrelated edits within the same affected file—require reconciliation before undo.

## Cancellation and interruption

Undo restores files sequentially, not as a single filesystem transaction. Its private journal records the path about to be restored and each completed restoration. Cancelling leaves completed restorations intact and reports their count. Reopen the conversation and use Undo again to resume. A pending restoration whose bytes already match the baseline can be recognized after reload without rewriting it. Later conflicting changes still stop recovery.

The conversation blocks new tasks while its recorded undo remains incomplete. Historical native diff tabs are labeled when reopened after undo; they show the original task's changes, not the current working tree. Earlier validation results no longer describe the restored working tree. Undo is available for the conversation's latest recorded edit task, not as an arbitrary history browser.

Filesystem checks do not provide an atomic compare-and-swap against another local process. Empty directories created during editing can remain, and custom Windows ACL preservation is not guaranteed. Unconfirmed original edits require manual inspection; this feature does not automatically guess their outcome. Undo after actual isolated VS Code termination/restart and forced termination at synthetic filesystem boundaries are tested. Representative repository/workstation acceptance and power-loss durability remain unverified.

## Interrupted file operations

Version 0.4.4 records pending intent and snapshots before writing temporary-file content. An unfinished operation stops further mutations in that task, preserving the evidence. A create is marked applied only after its temporary hard link is removed. Loading a task never replays an operation, rolls it back or deletes leftovers.

An unconfirmed native diff shows the baseline and intended output; it does not prove that output reached disk. Inspect Source Control and the affected files before continuing. A partial replacement can leave the original intact alongside a `.ekod-*.tmp` file. A move can leave the source only, both source and destination as hard links, or the destination only. A create interrupted before its applied marker can also retain a temporary hard link. Editing either hard-linked name changes the same underlying file. Undo refuses unconfirmed operations; it does not infer ownership from matching contents.

Preserve later developer work and compare the actual files with the recorded snapshots before manually reconciling an interrupted operation. Remove a leftover temporary file only after verifying it belongs to the interrupted operation and any needed content has been preserved. The extension excludes these temporary files from source context and does not automatically remove them. After reconciliation, a follow-up captures a fresh baseline; the old unconfirmed task remains historical evidence and cannot be automatically undone. Do not mark its journal applied by hand to bypass checks.

`npm test` includes Windows worker processes killed at eleven controlled boundaries: partial temporary write, before/after replacement, replacement after an earlier completed edit, before/after deletion, between the two move journal entries, after destination linking, after source removal, and creation before/after its applied marker. Tests check original BOM/line endings, snapshots, staged work, HEAD, no automatic replay, exclusion of leftovers and refusal of ambiguous undo. These are process crashes at known boundaries, not power failures or proof of filesystem durability during an in-flight kernel operation.
