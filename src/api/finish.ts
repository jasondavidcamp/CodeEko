export const malformedFunctionReasons = ['MALFORMED_FUNCTION_CALL', 'function_call_filter: MALFORMED_FUNCTION_CALL'] as const;

export class MalformedFunctionCall extends Error {
  constructor() { super('Endpoint rejected the response as a malformed native function call. No action from that response was executed.'); }
}

export function checkFinishReason(reason: unknown): void {
  if (reason == null || reason === 'stop') return;
  if (malformedFunctionReasons.some(value => value === reason)) throw new MalformedFunctionCall();
  if (reason === 'length') throw new Error('Endpoint stopped at its output token limit. The incomplete response was not executed.');
  if (reason === 'content_filter') throw new Error('Endpoint blocked the response with its content filter. No action from that response was executed.');
  throw new Error('Endpoint returned an unsupported completion reason. No action from that response was executed.');
}
