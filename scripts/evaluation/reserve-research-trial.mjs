import { pathToFileURL } from 'node:url';
import path from 'node:path';

// This reservation survives the runner and is never deleted by this program.
// A failed/ambiguous create or a previously used reservation denies the call.
export const PROBE_RESERVATION = 'refs/tags/evaluation/gemini-research-trial-v1-reserved';
export async function reserveGeminiProbe(env, transport = fetch) {
  if (env.GITHUB_REPOSITORY !== 'JonathanShynn/automaton' ||
      env.GITHUB_REF !== 'refs/heads/evaluation/offline-cloud-trial' ||
      env.GITHUB_EVENT_NAME !== 'push' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
      !env.GH_TOKEN?.trim() || env.GEMINI_FREE_TIER_CONFIRMED !== 'true' ||
      env.GEMINI_RESEARCH_TRIAL_APPROVED !== 'true') {
    throw new Error('PROBE_RESERVATION_SETUP_INVALID');
  }
  let response;
  try {
    response = await transport('https://api.github.com/repos/JonathanShynn/automaton/git/refs', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: PROBE_RESERVATION, sha: env.GITHUB_SHA }),
    });
  } catch { throw new Error('PROBE_RESERVATION_UNCERTAIN_NO_CALL'); }
  if (response.status !== 201) throw new Error('PROBE_RESERVATION_NOT_CREATED_NO_CALL');
  let claim;
  try { claim = await response.json(); }
  catch { throw new Error('PROBE_RESERVATION_UNCERTAIN_NO_CALL'); }
  if (claim.ref !== PROBE_RESERVATION || claim.object?.sha !== env.GITHUB_SHA || claim.object?.type !== 'commit') {
    throw new Error('PROBE_RESERVATION_UNCERTAIN_NO_CALL');
  }
  return { reserved: true, maximumProviderRequests: 2, reservation: PROBE_RESERVATION };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reserveGeminiProbe(process.env).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('GEMINI_SINGLE_USE_RESERVATION_DENIED_NO_PROVIDER_CALL');
    process.exitCode = 1;
  });
}
