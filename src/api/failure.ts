export const failureCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ABORT_ERR'] as const;
export function failureMetadata(error: unknown) {
  const codes: (typeof failureCodes[number])[] = [];
  const queue: unknown[] = [error]; const visited = new Set<unknown>();
  while (queue.length && visited.size < 8) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || visited.has(item)) continue;
    visited.add(item);
    const { code, cause, errors } = item as { code?: unknown; cause?: unknown; errors?: unknown };
    if (failureCodes.includes(code as any) && !codes.includes(code as any)) codes.push(code as typeof failureCodes[number]);
    if (cause) queue.push(cause);
    if (Array.isArray(errors)) queue.push(...errors.slice(0, 8));
  }
  return codes;
}
