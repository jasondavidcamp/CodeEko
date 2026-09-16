import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
// An OS-owned lease releases automatically if the extension host terminates.
// The Windows pilot uses a named pipe; this endpoint never accepts task data.
export async function acquireRepositoryLease(root: string): Promise<() => Promise<void>> {
  const id = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 32);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\codeeko-${id}` : path.join(os.tmpdir(), `codeeko-${id}.sock`);
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('This repository is already open in another CodeEko panel, or its local lease is unavailable. Close the other panel first.')));
    server.listen(address, resolve);
  });
  return () => new Promise<void>(resolve => server.close(() => resolve()));
}
