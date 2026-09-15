import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { compatibleStorage } from '../src/state/storage';

test('new identity reuses private history without copying or overwriting it', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ekod-storage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const current=path.join(root,'jasondavidcamp.ekod'),legacy=path.join(root,'internal-pilot.llm-coding-agent-runtime');
 assert.equal(compatibleStorage(current),current);await fs.mkdir(legacy);await fs.writeFile(path.join(legacy,'history.json'),'existing history');
 assert.equal(compatibleStorage(current),legacy);assert.equal(await fs.readFile(path.join(legacy,'history.json'),'utf8'),'existing history');
 assert.equal(compatibleStorage(path.join(root,'another-extension')),path.join(root,'another-extension'));
 await fs.rename(legacy,path.join(root,'archive'));await fs.symlink(path.join(root,'archive'),legacy,'junction');assert.equal(compatibleStorage(current),current);
});
