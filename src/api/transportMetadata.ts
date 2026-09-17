import { z } from 'zod';

// Values, never raw headers: gateways may put private information in any header.
export const transportMetadataSchema = z.object({
  contentType: z.enum(['event-stream', 'json', 'text', 'other', 'missing']),
  contentEncoding: z.enum(['gzip', 'deflate', 'br', 'identity', 'multiple', 'other', 'missing']),
  transferEncoding: z.enum(['chunked', 'other', 'missing']),
  contentLength: z.number().finite().nonnegative().max(1e12).optional()
});
export function transportMetadata(headers: Headers): z.infer<typeof transportMetadataSchema> {
  const type = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  const transfer = headers.get('transfer-encoding')?.trim().toLowerCase();
  const length = headers.get('content-length');
  return transportMetadataSchema.parse({
    contentType: !type ? 'missing' : type === 'text/event-stream' ? 'event-stream' : type === 'application/json' ? 'json' : type === 'text/plain' ? 'text' : 'other',
    contentEncoding: !encoding ? 'missing' : ['gzip', 'deflate', 'br', 'identity'].includes(encoding) ? encoding : encoding.includes(',') ? 'multiple' : 'other',
    transferEncoding: !transfer ? 'missing' : transfer === 'chunked' ? 'chunked' : 'other',
    ...((length && /^\d+$/.test(length) && Number(length) <= 1e12) ? { contentLength: Number(length) } : {})
  });
}
