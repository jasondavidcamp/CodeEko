// Only a whole, direct request may initiate undo. Questions about undo, quoted
// instructions, file-specific requests and compound tasks stay conversational.
export function explicitUndoRequest(text: string): boolean {
  if (text.length > 8000) return false;
  return /^(?:(?:please|can you|could you|would you)\s+)?(?:undo|revert)\s+(?:(?:the|my|your|these|those)\s+)?(?:(?:pending|last|latest|task)\s+)?changes(?:\s+please)?[.!?]*$/i.test(text.trim())
    || /^(?:please\s+)?undo(?:\s+(?:that|the last task))?[.!?]*$/i.test(text.trim());
}
