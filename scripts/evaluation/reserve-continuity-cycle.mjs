import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTINUITY_PREFIX = 'refs/tags/evaluation/gemini-continuity-v1-cycle-';
export async function reserveContinuityCycle(env, transport = fetch) {
  if (env.GITHUB_REPOSITORY !== 'JonathanShynn/automaton' || env.GITHUB_REF !== 'refs/heads/evaluation/offline-cloud-trial' ||
      env.GITHUB_EVENT_NAME !== 'push' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !env.GH_TOKEN?.trim() ||
      !/^[123]$/.test(env.CONTINUITY_CYCLE ?? '') || env.GEMINI_FREE_TIER_CONFIRMED !== 'true' ||
      env.GEMINI_CONTINUITY_TRIAL_APPROVED !== 'true') throw new Error('CONTINUITY_RESERVATION_INVALID');
  const ref = CONTINUITY_PREFIX + env.CONTINUITY_CYCLE + '-reserved';
  try {
    const response = await transport('https://api.github.com/repos/JonathanShynn/automaton/git/refs', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref, sha: env.GITHUB_SHA }),
    });
    // Existing, uncertain or failed reservations never permit any phase to run.
    if (response.status !== 201) throw new Error('DENIED');
    const claim = await response.json();
    if (claim.ref !== ref || claim.object?.sha !== env.GITHUB_SHA || claim.object?.type !== 'commit') throw new Error('UNCERTAIN');
    return { reserved: true, cycle: Number(env.CONTINUITY_CYCLE), maximumProviderRequests: 1, totalAuthorizedRequests: 3 };
  } catch { throw new Error('CONTINUITY_RESERVATION_DENIED_NO_PROVIDER_CALL'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reserveContinuityCycle(process.env).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('CONTINUITY_RESERVATION_DENIED_NO_PROVIDER_CALL'); process.exitCode = 1;
  });
}
