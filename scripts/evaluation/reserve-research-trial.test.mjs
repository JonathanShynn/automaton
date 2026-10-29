import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveGeminiProbe, PROBE_RESERVATION } from './reserve-research-trial.mjs';

const env = { GITHUB_REPOSITORY: 'JonathanShynn/automaton', GITHUB_REF: 'refs/heads/evaluation/offline-cloud-trial',
  GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40), GH_TOKEN: 'synthetic-private-token',
  GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_RESEARCH_TRIAL_APPROVED: 'true' };
const claim = () => ({ ref: PROBE_RESERVATION, object: { sha: env.GITHUB_SHA, type: 'commit' } });

test('reserves a fixed durable reference before authorizing one two-request mission', async () => {
  let calls = 0;
  const result = await reserveGeminiProbe(env, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/JonathanShynn/automaton/git/refs');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { ref: PROBE_RESERVATION, sha: env.GITHUB_SHA });
    return Response.json(claim(), { status: 201 });
  });
  assert.equal(calls, 1); assert.equal(result.maximumProviderRequests, 2);
  assert.ok(!JSON.stringify(result).includes(env.GH_TOKEN));
});

test('two simultaneous runners cannot reuse the durable claim', async () => {
  let exists = false;
  const github = async () => {
    if (exists) return Response.json({}, { status: 422 });
    exists = true;
    return Response.json(claim(), { status: 201 });
  };
  const results = await Promise.allSettled([reserveGeminiProbe(env, github), reserveGeminiProbe(env, github)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(reserveGeminiProbe(env, github), /NO_CALL/);
});

test('wrong repo, branch, event, SHA, token or confirmations fail before network', async () => {
  for (const field of Object.keys(env)) {
    await assert.rejects(reserveGeminiProbe({ ...env, [field]: '' }, () => assert.fail('network forbidden')), /SETUP_INVALID/);
  }
});

test('HTTP errors and redirects deny without retrying or exposing response bodies', async () => {
  for (const status of [200, 301, 401, 403, 409, 422, 500, 503]) {
    let calls = 0;
    await assert.rejects(reserveGeminiProbe(env, async () => {
      calls++; return new Response(env.GH_TOKEN, { status });
    }), /NOT_CREATED_NO_CALL/);
    assert.equal(calls, 1);
  }
});

test('ambiguous network or malformed/mismatched success never authorizes a call', async () => {
  for (const transport of [async () => { throw new Error(env.GH_TOKEN); },
    async () => new Response('invalid', { status: 201 }),
    async () => Response.json({ ...claim(), object: { sha: 'b'.repeat(40), type: 'commit' } }, { status: 201 }),
    async () => Response.json({ ...claim(), ref: 'refs/tags/other' }, { status: 201 })]) {
    await assert.rejects(reserveGeminiProbe(env, transport), /UNCERTAIN_NO_CALL/);
  }
});
