import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explicitUndoRequest } from '../src/ui/undoRequest';

test('direct conversational undo requests are recognized without interpreting quoted or compound instructions', () => {
  for (const text of ['undo the pending changes', 'Undo your changes.', 'can you undo the last changes?', 'please revert these changes', 'undo', 'undo that', 'undo the last task']) assert.equal(explicitUndoRequest(text), true, text);
  for (const text of ['do not undo the pending changes', 'explain undo', 'how do I undo changes?', '"undo the pending changes"', 'undo changes in main.ps1', 'undo changes and delete everything', 'undo all repository changes', 'do not revert changes', 'undo the last commit']) assert.equal(explicitUndoRequest(text), false, text);
});
