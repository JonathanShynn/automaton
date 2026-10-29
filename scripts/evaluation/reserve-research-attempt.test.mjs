import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveResearchAttempt, ATTEMPT_PREFIX } from './reserve-research-attempt.mjs';
const env={GITHUB_REPOSITORY:'JonathanShynn/automaton',GITHUB_REF:'refs/heads/evaluation/offline-cloud-trial',GITHUB_EVENT_NAME:'push',GITHUB_SHA:'a'.repeat(40),GH_TOKEN:'synthetic-secret',GEMINI_FREE_TIER_CONFIRMED:'true',GEMINI_RESEARCH_TRIAL_APPROVED:'true'};
function service() {
  const refs=new Map();
  return async (url,init) => {
    assert.equal(init.redirect,'error');
    if(init.method==='POST') {
      const {ref,sha}=JSON.parse(init.body); assert.ok([ATTEMPT_PREFIX+1,ATTEMPT_PREFIX+2].includes(ref));
      if(refs.has(ref))return Response.json({},{status:422});
      const claim={ref,object:{sha,type:'commit'}}; refs.set(ref,claim);return Response.json(claim,{status:201});
    }
    const ref='refs/'+url.split('/git/ref/')[1];return Response.json(refs.get(ref)??{},{status:refs.has(ref)?200:404});
  };
}
test('reserves only two attempts across runner restarts and never resets a used slot',async()=>{
  const github=service();assert.equal((await reserveResearchAttempt(env,github)).slot,1);
  assert.equal((await reserveResearchAttempt({...env,GITHUB_SHA:'b'.repeat(40)},github)).slot,2);
  await assert.rejects(reserveResearchAttempt(env,github),/EXHAUSTED/);
});
test('three simultaneous runners get exactly two unique attempt slots',async()=>{
  const github=service();const results=await Promise.allSettled([1,2,3].map(()=>reserveResearchAttempt(env,github)));
  const ok=results.filter(r=>r.status==='fulfilled').map(r=>r.value.slot).sort();assert.deepEqual(ok,[1,2]);
});
test('HTTP errors, ambiguous create and missing confirmation deny without using another slot',async()=>{
  for(const status of [401,403,500,503]) {let calls=0;await assert.rejects(reserveResearchAttempt(env,async()=>{calls++;return Response.json({},{status});}),/NO_CALL/);assert.equal(calls,1);}
  let calls=0;await assert.rejects(reserveResearchAttempt(env,async()=>{calls++;throw new Error(env.GH_TOKEN);}),/NO_CALL/);assert.equal(calls,1);
  await assert.rejects(reserveResearchAttempt(env,async()=>Response.json({},{status:201})),/NO_CALL/);
  await assert.rejects(reserveResearchAttempt(env,async()=>Response.json({},{status:422})),/NO_CALL/);
  await assert.rejects(reserveResearchAttempt({...env,GEMINI_RESEARCH_TRIAL_APPROVED:''},()=>assert.fail('No network')),/INVALID/);
});
test('public reservation result contains no credential',async()=>{
  const r=await reserveResearchAttempt(env,service());assert.equal(r.maximumProviderRequests,1);assert.equal(r.totalAuthorizedRequests,2);assert.ok(!JSON.stringify(r).includes(env.GH_TOKEN));
});
