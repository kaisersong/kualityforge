import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback, proposeImprovements } from '../../../src/core/feedback.mjs';
const record = (extra={}) => ({id:'e1',project:'slides',runId:'r1',findingId:'f1',title:'标题失真',actual:'2项审查',expected:'2位客户',reason:'数量对象改变',scope:'quantified-title',pattern:'entity-binding',target:'contract',assessment:'confirmed',author:'maintainer',evidence:[{ref:'source.txt',sha256:'a'.repeat(64)}],...extra});
const pack = (...records) => ({schemaVersion:1,records});
test('only explicit qualified confirmations generate advisory candidates',()=>{
 const result=proposeImprovements([pack(record(),record({id:'e2',assessment:'risk_accepted'}))]);
 assert.equal(result.candidates.length,1);
 assert.equal(result.candidates[0].status,'needs_review');
 assert.deepEqual(result.candidates[0].counterEvidenceIds,['e2']);
 assert.equal(result.advisory,true);
 assert.equal(proposeImprovements([pack(record({assessment:'unconfirmed'}))]).candidates.length,0);
 assert.equal(proposeImprovements([pack(record({assessment:'false_positive'}))]).candidates.length,0);
});
test('dedup, conflicts and project isolation',()=>{
 const a=record();
 assert.equal(proposeImprovements([pack(a),pack(a)]).candidates[0].feedbackIds.length,1);
 assert.throws(()=>proposeImprovements([pack(a,record({title:'changed'}))]),/conflict/);
 assert.equal(proposeImprovements([pack(a,record({id:'e2',project:'reports'}))]).candidates.length,2);
});
test('validation rejects incomplete confirmed feedback and malformed input',()=>{
 for(const extra of [{expected:''},{scope:''},{reason:''},{evidence:[]},{target:'gate'},{assessment:'verified'},{evidence:[{ref:'x',sha256:'bad'}]}]) assert.throws(()=>validateFeedback(pack(record(extra))));
 assert.throws(()=>validateFeedback({schemaVersion:2,records:[]}));
 const input=pack(record()); const snapshot=JSON.stringify(input); proposeImprovements([input]); assert.equal(JSON.stringify(input),snapshot);
});

test('run import preserves observations without claiming confirmation', async()=>{
 const { feedbackFromRun }=await import('../../../src/core/feedback.mjs');
 for(const status of ['verified','dismissed','risk_accepted']) {
 const bundle=feedbackFromRun({project:'slides',manifestSha256:'a'.repeat(64),manifest:{runId:'r',findings:[{id:'f',title:'problem',status}],humanDecision:{owner:'kai'},verification:{status:'passed'}}});
 assert.equal(bundle.records[0].assessment,'unconfirmed');
 assert.equal(bundle.records[0].observedStatus,status);
 assert.equal(bundle.sourceRun.humanDecision.owner,'kai');
 assert.equal(proposeImprovements([bundle]).candidates.length,0);
 }
});
