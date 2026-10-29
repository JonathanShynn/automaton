import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const ATTEMPT_PREFIX = 'refs/tags/evaluation/gemini-research-trial-v2-slot-';
export async function reserveResearchAttempt(env, transport = fetch) {
  if (env.GITHUB_REPOSITORY !== 'JonathanShynn/automaton' || env.GITHUB_REF !== 'refs/heads/evaluation/offline-cloud-trial' ||
      env.GITHUB_EVENT_NAME !== 'push' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !env.GH_TOKEN?.trim() ||
      env.GEMINI_FREE_TIER_CONFIRMED !== 'true' || env.GEMINI_RESEARCH_TRIAL_APPROVED !== 'true') throw new Error('RESEARCH_RESERVATION_INVALID');
  const root = 'https://api.github.com/repos/JonathanShynn/automaton/git/';
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
    'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    for (const slot of [1, 2]) {
      const ref = ATTEMPT_PREFIX + slot;
      const response = await transport(root + 'refs', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers,
        body: JSON.stringify({ ref, sha: env.GITHUB_SHA }) });
      if (response.status === 201) {
        const created = await response.json();
        if (created.ref !== ref || created.object?.sha !== env.GITHUB_SHA || created.object?.type !== 'commit') throw new Error('UNCERTAIN');
        return { reserved: true, slot, maximumProviderRequests: 1, totalAuthorizedRequests: 2 };
      }
      if (response.status !== 422) throw new Error('DENIED');
      // Only a confirmed existing reservation permits trying the next slot.
      const existing = await transport(root + 'ref/' + ref.slice(5), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers });
      if (existing.status !== 200) throw new Error('UNCERTAIN');
      const claim = await existing.json();
      if (claim.ref !== ref || claim.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(claim.object?.sha ?? '')) throw new Error('UNCERTAIN');
    }
  } catch { throw new Error('RESEARCH_ATTEMPT_NOT_AUTHORIZED_NO_CALL'); }
  throw new Error('RESEARCH_TWO_ATTEMPTS_EXHAUSTED_NO_CALL');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reserveResearchAttempt(process.env).then(r => console.log(JSON.stringify(r))).catch(() => {
    console.error('RESEARCH_ATTEMPT_RESERVATION_DENIED_NO_PROVIDER_CALL'); process.exitCode = 1;
  });
}
