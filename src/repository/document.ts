import { createHash } from 'node:crypto';

export type Encoding = 'utf8' | 'utf8bom' | 'utf16le';
export interface DocumentData { bytes: Buffer; text: string; hash: string; encoding: Encoding; eol: '\n' | '\r\n'; mixedEol: boolean }
export function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export function decode(bytes: Buffer): DocumentData {
  let encoding: Encoding = 'utf8'; let offset = 0;
  if (bytes[0] === 255 && bytes[1] === 254) { encoding = 'utf16le'; offset = 2; }
  else if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) { encoding = 'utf8bom'; offset = 3; }
  const original = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
  if (original.includes('\0')) throw new Error('Binary excluded.');
  const crlf = original.includes('\r\n'); const loneLf = /(?<!\r)\n/.test(original); const loneCr = /\r(?!\n)/.test(original);
  return { bytes, text: original.replaceAll('\r\n', '\n'), hash: hash(bytes), encoding, eol: crlf ? '\r\n' : '\n', mixedEol: (crlf && loneLf) || loneCr };
}
export function encode(text: string, format: Pick<DocumentData, 'encoding' | 'eol' | 'mixedEol'>): Buffer {
  if (format.mixedEol || /\r(?!\n)|\0/.test(text)) throw new Error('Mixed line endings or binary text cannot be edited safely.');
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\n', format.eol);
  const bytes = Buffer.from(normalized, format.encoding === 'utf16le' ? 'utf16le' : 'utf8');
  const bom = format.encoding === 'utf16le' ? Buffer.from([255, 254]) : format.encoding === 'utf8bom' ? Buffer.from([239, 187, 191]) : Buffer.alloc(0);
  const result = Buffer.concat([bom, bytes]);
  if (result.length > 256000) throw new Error('Edited file exceeds the 256 KB limit.');
  return result;
}
