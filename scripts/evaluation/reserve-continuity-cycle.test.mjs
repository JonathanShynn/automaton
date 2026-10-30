import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveContinuityCycle, CONTINUITY_PREFIX } from './reserve-continuity-cycle.mjs';
const env = { GITHUB_REPOSITORY:'JonathanShynn/automaton', GITHUB_REF:'refs/heads/evaluation/offline-cloud-trial',
  GITHUB_EVENT_NAME:'push', GITHUB_SHA:'a'.repeat(40), GH_TOKEN:'synthetic-secret', CONTINUITY_CYCLE:'1',
  GEMINI_FREE_TIER_CONFIRMED:'true', GEMINI_CONTINUITY_TRIAL_APPROVED:'true' };
function service() {
  const refs=new Set();
  return async (url, init) => {
    assert.equal(url,'https://api.github.com/repos/JonathanShynn/automaton/git/refs'); assert.equal(init.method,'POST'); assert.equal(init.redirect,'error');
    const {ref,sha}=JSON.parse(init.body); assert.match(ref,/^refs\/tags\/evaluation\/gemini-continuity-v1-cycle-[123]-reserved$/);
    if(refs.has(ref))return Response.json({},{status:422});
    refs.add(ref);return Response.json({ref,object:{sha,type:'commit'}},{status:201});
  };
}
test('each of the three fixed cycles can be reserved once across runner restarts',async()=>{
  const api=service();for(const cycle of ['1','2','3']) {
    const result=await reserveContinuityCycle({...env,CONTINUITY_CYCLE:cycle},api);
    assert.equal(result.maximumProviderRequests,1);assert.equal(result.totalAuthorizedRequests,3);
    await assert.rejects(reserveContinuityCycle({...env,CONTINUITY_CYCLE:cycle,GITHUB_SHA:'b'.repeat(40)},api),/DENIED/);
  }
});
test('concurrent attempts for the same phase admit only one runner',async()=>{
  const api=service();const results=await Promise.allSettled([1,2,3].map(()=>reserveContinuityCycle(env,api)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('transport, HTTP and ambiguous responses deny without a retry or alternate slot',async()=>{
  for(const status of [401,403,422,500,503]) {
    let calls=0;await assert.rejects(reserveContinuityCycle(env,async()=>{calls++;return Response.json({},{status});}),/NO_PROVIDER_CALL/);assert.equal(calls,1);
  }
  let calls=0;await assert.rejects(reserveContinuityCycle(env,async()=>{calls++;throw new Error(env.GH_TOKEN);}),/NO_PROVIDER_CALL/);assert.equal(calls,1);
  for(const body of [{},{ref:CONTINUITY_PREFIX+'1-reserved',object:{sha:'b'.repeat(40),type:'commit'}}]) {
    await assert.rejects(reserveContinuityCycle(env,async()=>Response.json(body,{status:201})),/NO_PROVIDER_CALL/);
  }
});
test('invalid phase or absent explicit approval is rejected before transport',async()=>{
  for(const change of [{CONTINUITY_CYCLE:'4'},{CONTINUITY_CYCLE:'01'},{GEMINI_CONTINUITY_TRIAL_APPROVED:''},{GITHUB_EVENT_NAME:'workflow_dispatch'}]) {
    await assert.rejects(reserveContinuityCycle({...env,...change},()=>assert.fail('No transport')),/INVALID/);
  }
});
