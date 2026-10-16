import { createHash } from 'node:crypto';

const ASSESSMENTS = ['unconfirmed','confirmed','false_positive','preference','risk_accepted','deferred'];
const TARGETS = ['program','contract','reference','eval','context'];
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).map(key=>[key,sortValue(value[key])]));
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`feedback ${label} must be a non-empty string`);
}

export function validateFeedback(bundle) {
  if (!bundle || bundle.schemaVersion !== 1 || !Array.isArray(bundle.records)) throw new Error('feedback requires schemaVersion 1 and records array');
  for (const r of bundle.records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('feedback record must be an object');
    for (const key of ['id','project','title','actual','author']) text(r[key],key);
    if (!ASSESSMENTS.includes(r.assessment)) throw new Error('feedback assessment is invalid');
    if (r.target !== undefined && !TARGETS.includes(r.target)) throw new Error('feedback target is invalid');
    if (!Array.isArray(r.evidence) || !r.evidence.length) throw new Error('feedback evidence is required');
    for (const e of r.evidence) {
      text(e?.ref,'evidence.ref');
      if (!/^[a-f0-9]{64}$/.test(e?.sha256)) throw new Error('feedback evidence.sha256 must contain 64 lowercase hex digits');
    }
    if (r.assessment === 'confirmed') {
      for (const key of ['expected','reason','scope','pattern','target']) text(r[key],key);
    }
  }
  uniqueRecords([bundle]);
  return bundle;
}
function uniqueRecords(bundles) {
  const seen = new Map();
  for (const bundle of bundles) for (const r of bundle.records) {
    const key = canonical([r.project,r.id]);
    if (seen.has(key) && canonical(seen.get(key)) !== canonical(r)) throw new Error(`feedback id conflict: ${r.project}/${r.id}`);
    seen.set(key,r);
  }
  return [...seen.values()].sort((a,b)=>compare(canonical([a.project,a.id]),canonical([b.project,b.id])));
}
export function proposeImprovements(bundles) {
  bundles.forEach(validateFeedback);
  const records = uniqueRecords(bundles);
  const groups = new Map();
  for (const r of records) {
    if (![r.scope,r.pattern,r.target].every(v=>typeof v === 'string' && v.trim())) continue;
    const key = canonical([r.project,r.scope,r.pattern,r.target]);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  const candidates = [...groups].sort(([a],[b])=>compare(a,b)).flatMap(([key,group])=>{
    const supporting=group.filter(r=>r.assessment==='confirmed');
    if (!supporting.length) return [];
    const counter=group.filter(r=>r.assessment!=='confirmed');
    const r=supporting[0];
    return [{id:`improvement-${hash(key)}`,project:r.project,scope:r.scope,pattern:r.pattern,target:r.target,
      status:counter.length?'needs_review':'proposed',feedbackIds:supporting.map(r=>r.id),
      counterEvidenceIds:counter.map(r=>r.id),runIds:[...new Set(supporting.map(r=>r.runId).filter(Boolean))].sort(compare),
      examples:group,requires:['domain_review','regression_verification','explicit_adoption']}];
  });
  return {schemaVersion:1,advisory:true,recordCount:records.length,candidates};
}

// Import is an observation, never a confirmation or an authenticated human label.
export function feedbackFromRun({project,manifest,manifestSha256}) {
  text(project,'project'); text(manifest?.runId,'runId');
  return validateFeedback({schemaVersion:1,sourceRun:{runId:manifest.runId,manifestSha256,
    humanDecision:manifest.humanDecision ?? null,verification:manifest.verification ?? null,
    requiredChecks:manifest.requiredChecks ?? []},records:(manifest.findings || []).map(f=>({
    id:`observation-${hash(canonical([project,manifest.runId,manifestSha256,f.id]))}`,
    project,runId:manifest.runId,findingId:f.id,title:f.title,actual:f.description || f.title,
    assessment:'unconfirmed',author:'kualityforge:import',observedStatus:f.status,observation:f,
    sourceRunnerIds:f.sourceRunnerIds || (f.sourceRunnerId?[f.sourceRunnerId]:[]),
    evidence:[{ref:`run:${manifest.runId}/manifest.json`,sha256:manifestSha256}]
  }))});
}
