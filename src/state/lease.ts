import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
// An OS-owned lease releases automatically if the extension host terminates.
// The Windows pilot uses a named pipe; this endpoint never accepts task data.
export async function acquireRepositoryLease(root: string, options: {
  signal?: AbortSignal; timeoutMs?: number; onRetry?: (code: string) => void;
} = {}): Promise<() => Promise<void>> {
  const id = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 32);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\codeeko-${id}` : path.join(os.tmpdir(), `codeeko-${id}.sock`);
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    options.signal?.throwIfAborted();
    const server = net.createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
      });
    } catch (error) {
      server.close();
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can report an occupied named pipe as EACCES. Never remove or
      // steal it: wait briefly for the previous extension host to exit.
      if ((code === 'EADDRINUSE' || (process.platform === 'win32' && code === 'EACCES')) && Date.now() < deadline) {
        options.onRetry?.(code);
        await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
        continue;
      }
      const message = code === 'EADDRINUSE'
        ? 'This repository is already open in another CodeEko panel. Close that panel, then reload this window.'
        : 'CodeEko could not acquire the local repository lease. Another panel or local access restrictions may be blocking it. Close any other CodeEko panel for this repository, then reload this window.';
      throw Object.assign(new Error(message), { code });
    }
    let closing: Promise<void> | undefined;
    const release = () => closing ??= new Promise<void>(resolve => server.close(() => resolve()));
    if (options.signal?.aborted) { await release(); options.signal.throwIfAborted(); }
    return release;
  }
}
