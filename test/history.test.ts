import { runAgent } from '../src/agent/loop';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { git } from '../src/repository/git';
import { showCommit } from '../src/repository/history';
import { parseAction } from '../src/protocol/actions';
import { authorize } from '../src/policy/boundary';
import { ReadOnlyTools } from '../src/tools/readOnly';
import { RepositoryIndex } from '../src/indexing';

test('commit inspection distinguishes history from dirty work and includes deletions and initial commits', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ekod-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await git(root,['init']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.invalid']);
 await assert.rejects(showCommit(root),/no commits/);
 for(const [file,text] of [['main.ps1','return 1'],['removed.ps1','old function'],['.env','PRIVATE_SECRET']])await fs.writeFile(path.join(root,file),text);
 await git(root,['add','.']);await git(root,['commit','-m','Initial fixture']);
 const first:any=await showCommit(root);assert.equal(first.parents.length,0);assert.ok(first.files.some((f:any)=>f.path==='main.ps1'&&f.diff.includes('+return 1')));assert.ok(!JSON.stringify(first).includes('PRIVATE_SECRET'));
 await fs.writeFile(path.join(root,'main.ps1'),'return 2');await fs.unlink(path.join(root,'removed.ps1'));
 await git(root,['add','--all']);await git(root,['commit','-m','Update capacity and remove obsolete function']);
 await fs.writeFile(path.join(root,'main.ps1'),'STAGED_VALUE');await git(root,['add','main.ps1']);await fs.writeFile(path.join(root,'main.ps1'),'WORKTREE_VALUE');
 const status=await git(root,['status','--porcelain']),staged=await git(root,['diff','--cached']);
 const tools=new ReadOnlyTools(new RepositoryIndex(root,path.join(root,'.git','index-fixture')),async()=> '');
 const result:any=await tools.execute(parseAction(JSON.stringify({version:1,tool:'git_show_commit',args:{}})),new AbortController().signal);
 assert.match(result.message,/Update capacity/);assert.ok(result.files.some((f:any)=>f.path==='removed.ps1'&&f.status==='D'));
 let calls=0;
 const answer=await runAgent({complete:async (_model:any,messages:any[])=>{calls++;if(calls===1)return JSON.stringify({version:1,tool:'git_show_commit',args:{}});const context=JSON.stringify(messages);assert.ok(context.includes('Update capacity and remove obsolete function'));assert.ok(context.includes('removed.ps1'));assert.ok(!context.includes('STAGED_VALUE'));return JSON.stringify({version:1,tool:'complete_task',args:{summary:'The last commit changed the return value from 1 to 2 and deleted the obsolete function.'}});}},'fake',[{role:'user',content:'Help me understand what was added in the last commit'}],tools,()=> 'Review',new AbortController().signal,()=>{});
 assert.match(answer,/return value from 1 to 2/);assert.equal(calls,2);
 const diff=result.files.find((f:any)=>f.path==='main.ps1').diff;assert.match(diff,/-return 1/);assert.ok(diff.includes('+return 2'));assert.ok(!JSON.stringify(result).includes('STAGED_VALUE'));assert.ok(!JSON.stringify(result).includes('WORKTREE_VALUE'));
 assert.equal((await showCommit(root,'HEAD~1') as any).hash,first.hash);
 assert.equal(await git(root,['diff','--cached']),staged);assert.equal(await fs.readFile(path.join(root,'main.ps1'),'utf8'),'WORKTREE_VALUE');
 // The private index fixture is test-owned; tracked-file status must stay unchanged.
 assert.equal((await git(root,['status','--porcelain'])).split('\n').filter(l=>!l.includes('.index-fixture')).join('\n'),status);
 for(const mode of ['Review','Workspace','Full access'])assert.doesNotThrow(()=>authorize('git_show_commit',mode));
 for(const revision of ['--all','HEAD; echo bad','HEAD:path','../file','HEAD~100']){assert.throws(()=>parseAction(JSON.stringify({version:1,tool:'git_show_commit',args:{revision}})));await assert.rejects(showCommit(root,revision));}
});
