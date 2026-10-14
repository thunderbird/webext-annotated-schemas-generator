import { HISTORICAL_ESR_TAGS, OLDEST_ESR } from './constants.mjs';

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
 * Get the ESR branches from OLDEST_ESR up to the given ESR branch.
 *
 * @param {LocalGitSource} source
 * @param {string} branch - e.g. "esr153"
 * @returns {Promise<string[]>} e.g. ["esr115", "esr128", "esr140", "esr153"]
 */
async function getEsrBranchesUpTo(source, branch) {
  const esr = getEsrVersion(branch);
  return (await getEsrBranches(source)).filter((b) => getEsrVersion(b) <= esr);
}

/**
 * Get the refs whose history is used for the compat data of a branch. For an
 * ESR branch, these are all ESRs up to it: the tags of the historical ESRs
 * (see HISTORICAL_ESR_TAGS) and the ESR branches. Otherwise, the branch
 * itself.
 *
 * @param {LocalGitSource} source
 * @param {string} branch - e.g. "esr153" or "beta"
 * @returns {Promise<string[]>} e.g. ["refs/tags/THUNDERBIRD_60_9_1_RELEASE",
 *    ..., "refs/heads/esr115", ..., "refs/heads/esr153"]
 */
export async function getHistoryRefs(source, branch) {
  if (!getEsrVersion(branch)) {
    return [`refs/heads/${branch}`];
  }
  return [
    ...Object.values(HISTORICAL_ESR_TAGS).map((tag) => `refs/tags/${tag}`),
    ...(await getEsrBranchesUpTo(source, branch)).map((b) => `refs/heads/${b}`),
  ];
}

/**
 * Get all ESR versions up to the given ESR branch, including the historical
 * ESR versions without a branch.
 *
 * @param {LocalGitSource} source
 * @param {string} branch - e.g. "esr153"
 * @returns {Promise<number[]>} e.g. [60, 68, 78, 91, 102, 115, 128, 140, 153]
 */
export async function getEsrVersions(source, branch) {
  return [
    ...Object.keys(HISTORICAL_ESR_TAGS).map(Number),
    ...(await getEsrBranchesUpTo(source, branch)).map(getEsrVersion),
  ];
}
