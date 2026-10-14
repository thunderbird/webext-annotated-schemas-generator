import { HISTORICAL_ESR_VERSIONS, OLDEST_ESR } from './constants.mjs';

// Based on the branch handling of the policy-templates generator:
// https://github.com/thunderbird/policy-templates/blob/main/generator/modules/branches.mjs

/**
 * @typedef {import('./sources.mjs').LocalGitSource} LocalGitSource
 */

/**
 * Get the ESR version of an ESR branch.
 *
 * @param {string} branch - e.g. "esr153"
 * @returns {number|null} e.g. 153, or null if it is not an ESR branch
 */
export function getEsrVersion(branch) {
  const esr = branch.match(/^esr(\d+)$/);
  return esr ? Number(esr[1]) : null;
}

/**
 * Get the ESR branches of the repository from OLDEST_ESR on, sorted by
 * version (oldest first).
 *
 * @param {LocalGitSource} source
 * @returns {Promise<string[]>} e.g. ["esr115", "esr128", "esr140", "esr153"]
 */
export async function getEsrBranches(source) {
  return (await source.listBranches())
    .filter((branch) => getEsrVersion(branch) >= OLDEST_ESR)
    .sort((a, b) => getEsrVersion(a) - getEsrVersion(b));
}

/**
 * Get the branch of the repository for a release name.
 *
 * @param {LocalGitSource} source
 * @param {string} release - "esr" (the newest ESR branch), "esr<N>", "release",
 *    "beta" or "central" (Daily).
 * @returns {Promise<string>} the branch, e.g. "esr153" or "main"
 */
export async function getReleaseBranch(source, release) {
  if (release === 'central') {
    return 'main';
  }
  if (release === 'esr') {
    const esrBranches = await getEsrBranches(source);
    if (!esrBranches.length) {
      throw new Error(`No ESR branches found in ${source.description}.`);
    }
    return esrBranches.at(-1);
  }
  return release;
}

/**
 * Get the ESR branches whose history is used for the compat data of an ESR
 * branch: all ESR branches from OLDEST_ESR up to the given branch.
 *
 * @param {LocalGitSource} source
 * @param {string} branch - e.g. "esr153"
 * @returns {Promise<string[]>} e.g. ["esr115", "esr128", "esr140", "esr153"]
 */
export async function getEsrHistoryBranches(source, branch) {
  const esr = getEsrVersion(branch);
  return (await getEsrBranches(source)).filter((b) => getEsrVersion(b) <= esr);
}

/**
 * Get all ESR versions up to the given ESR branch, including the historical
 * ESR versions without a branch.
 *
 * @param {string[]} esrBranches - see getEsrHistoryBranches()
 * @returns {number[]} e.g. [60, 68, 78, 91, 102, 115, 128, 140, 153]
 */
export function getEsrVersions(esrBranches) {
  return [...HISTORICAL_ESR_VERSIONS, ...esrBranches.map(getEsrVersion)];
}
