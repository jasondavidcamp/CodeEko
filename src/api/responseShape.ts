/** Counts only: no response text, arbitrary property names, arguments or identifiers. */
export function emptyResponseShape() {
  return { selectedChoices: 0, otherChoices: 0, deltaTextCharacters: 0, messageTextCharacters: 0,
    alternateTextCharacters: 0, reasoningCharacters: 0, refusalCharacters: 0, nonStringContentValues: 0, toolCallEntries: 0 };
}
export type ResponseShape = ReturnType<typeof emptyResponseShape>;
export function inspectResponseShape(target: ResponseShape, data: any): void {
  const length = (value: unknown) => typeof value === 'string' ? value.length : 0;
  for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
    if (choice?.index !== undefined && choice.index !== 0) { target.otherChoices++; continue; }
    target.selectedChoices++;
    target.deltaTextCharacters += length(choice?.delta?.content);
    target.messageTextCharacters += length(choice?.message?.content);
    target.alternateTextCharacters += length(choice?.text);
    for (const item of [choice?.delta, choice?.message]) {
      target.reasoningCharacters += length(item?.reasoning_content) + length(item?.reasoning);
      target.refusalCharacters += length(item?.refusal);
      if (item?.content != null && typeof item.content !== 'string') target.nonStringContentValues++;
      if (Array.isArray(item?.tool_calls)) target.toolCallEntries += item.tool_calls.length;
      if (item?.function_call) target.toolCallEntries++;
    }
  }
}
