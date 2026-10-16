import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { requireOption, readOptions } from './options.mjs';
import { validateFeedback, proposeImprovements, feedbackFromRun } from '../core/feedback.mjs';
import { loadGateInputFromArtifactRoot } from '../core/gate-input.mjs';

export async function runFeedback(args) {
  const [action,...options]=args;
  if (!['record','import','propose'].includes(action)) throw new Error('feedback requires record, import or propose');
  const allowed=new Set(action==='import'?['--artifact-root','--project','--output']:['--input','--output']);
  const counts=new Map();
  for(let i=0;i<options.length;i+=2) {
    const key=options[i];
    if(!allowed.has(key) || !options[i+1] || options[i+1].startsWith('--')) throw new Error(`invalid feedback option: ${key}`);
    counts.set(key,(counts.get(key)||0)+1);
    if(counts.get(key)>1 && !(key==='--input' && action==='propose')) throw new Error(`duplicate feedback option: ${key}`);
  }
  const output=resolve(requireOption(options,'--output','feedback'));
  let result;
  if (action==='import') {
    const root=requireOption(options,'--artifact-root','feedback import');
    const project=requireOption(options,'--project','feedback import');
    const loaded=await loadGateInputFromArtifactRoot(root);
    if(loaded.integrityErrors.length) throw new Error(`feedback import integrity errors: ${loaded.integrityErrors.join('; ')}`);
    const bytes=await readFile(loaded.manifestPath);
    if(JSON.stringify(JSON.parse(bytes))!==JSON.stringify(loaded.manifest)) throw new Error('feedback import manifest changed during replay');
    result=feedbackFromRun({project,manifest:loaded.derivedManifest,manifestSha256:createHash('sha256').update(bytes).digest('hex')});
  } else {
    const inputs=readOptions(options,'--input');
    if(!inputs.length) throw new Error('feedback requires --input');
    const bundles=await Promise.all(inputs.map(async p=>validateFeedback(JSON.parse(await readFile(p,'utf8')))));
    result=action==='record'?bundles[0]:proposeImprovements(bundles);
  }
  await writeFile(output,`${JSON.stringify(result,null,2)}\n`,{flag:'wx'});
  return {status:'written',output,advisory:true};
}
