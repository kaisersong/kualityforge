import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const cli=resolve('src/cli/index.mjs');
const run=(...args)=>spawnSync(process.execPath,[cli,'feedback',...args],{encoding:'utf8'});
test('record and propose preserve history and reject corrupt run import',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qf-feedback-'));
 try {
 const input=join(dir,'input.json'), output=join(dir,'event.json'), proposal=join(dir,'proposal.json');
 await writeFile(input,JSON.stringify({schemaVersion:1,records:[{id:'e',project:'slides',assessment:'unconfirmed',title:'clip',actual:'clipped',author:'user',evidence:[{ref:'screenshot.png',sha256:'a'.repeat(64)}]}]}));
 assert.equal(run('record','--input',input,'--output',output).status,0);
 assert.notEqual(run('record','--input',input,'--output',output).status,0);
 assert.equal(run('propose','--input',output,'--output',proposal).status,0);
 assert.deepEqual(JSON.parse(await readFile(proposal,'utf8')).candidates,[]);
 await writeFile(join(dir,'manifest.json'),JSON.stringify({runId:'bad',reviewers:[{runnerId:'x',artifact:'missing.md'}],findings:[],requiredChecks:[]}));
 assert.notEqual(run('import','--artifact-root',dir,'--project','slides','--output',join(dir,'bad.json')).status,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('imports replayable incomplete runs and never rewrites their manifest',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qf-feedback-import-'));
 try {
 const invoke=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
 const init=invoke('init','--artifact-root',dir,'--run-id','r');
 assert.equal(init.status,0,init.stderr);
 const review=join(dir,'input.md');
 await writeFile(review,'```kualityforge-review\n'+JSON.stringify({runnerId:'codex:test',status:'completed',findings:[{id:'f',title:'Title changes source entity',severity:'warning'}]})+'\n```\n');
 const write=invoke('write-review','--artifact-root',dir,'--input',review,'--expected-runner-id','codex:test');
 assert.equal(write.status,0,write.stderr);
 const before=await readFile(join(dir,'manifest.json'),'utf8');
 const output=join(dir,'feedback.json');
 const result=run('import','--artifact-root',dir,'--project','slides','--output',output);
 assert.equal(result.status,0,result.stderr);
 const bundle=JSON.parse(await readFile(output,'utf8'));
 assert.equal(bundle.records.length,1);
 assert.equal(bundle.records[0].assessment,'unconfirmed');
 assert.equal(await readFile(join(dir,'manifest.json'),'utf8'),before);
 }finally {await rm(dir,{recursive:true,force:true});}
});
