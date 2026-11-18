import yaml from 'yaml';

import { COMM_GECKO_REV, LANDO_HG2GIT_URL } from './constants.mjs';

/**
 * @typedef {import('./common/cached_clone.mjs').HistorySource} HistorySource
 */

const HG_REV_REGEX = /^[0-9a-f]{12,40}$/i;
const LANDO_ATTEMPTS = 3;
const LANDO_TIMEOUT_MS = 15000;

/**
 * Map a mercurial revision of the Firefox repository to its git commit, using
 * the Lando API.
 *
 * @param {string} hgRev - The mercurial revision (12 to 40 hex digits).
 *
 * @returns {Promise<string>} The git commit.
 */
export async function getGitCommitFromHgRev(hgRev) {
  const url = `${LANDO_HG2GIT_URL}/${hgRev}`;
  let lastError;
  for (let attempt = 1; attempt <= LANDO_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(LANDO_TIMEOUT_MS),
      });
      if (response.status === 404) {
        // The revision is unknown, retrying does not help.
        throw Object.assign(new Error(`${url} has no such revision`), {
          permanent: true,
        });
      }
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      const { git_hash: gitHash } = await response.json();
      if (!/^[0-9a-f]{40}$/i.test(gitHash ?? '')) {
        throw new Error(`${url} returned no git commit`);
      }
      return gitHash;
    } catch (ex) {
      lastError = ex;
      if (ex.permanent) {
        break;
      }
      if (attempt < LANDO_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw new Error(
    `Mapping the mercurial revision ${hgRev} to a git commit failed: ${lastError.message}`,
    { cause: lastError }
  );
}

/**
 * Read the GECKO_REV file of a COMM revision to get the matching MOZILLA ref.
 *
 * GECKO_HEAD_REF is used if it is set. COMM may also pin MOZILLA to a revision
 * for which there is no tag, with GECKO_HEAD_REV only (a commented out
 * GECKO_HEAD_REF is not read). Then the mercurial revision is mapped to its
 * git commit.
 *
 * @param {HistorySource} commSource
 * @param {string} commRev - The COMM revision.
 *
 * @returns {Promise<string>} The MOZILLA ref: a tag, "main" or a git commit.
 */
export async function getMozillaRefFromGeckoRevFile(commSource, commRev) {
  const content = await commSource.readFile(commRev, COMM_GECKO_REV);
  // GECKO_HEAD_REF is a tag (e.g. FIREFOX_153_5_0esr_BUILD1) or "default"
  // (the main branch). GECKO_HEAD_REV is a mercurial changeset, which does not
  // exist in the git repository.
  const { GECKO_HEAD_REF, GECKO_HEAD_REV } = yaml.parse(content ?? '') ?? {};
  if (GECKO_HEAD_REF) {
    return GECKO_HEAD_REF === 'default' ? 'main' : GECKO_HEAD_REF;
  }
  const hgRev = String(GECKO_HEAD_REV ?? '');
  if (!HG_REV_REGEX.test(hgRev)) {
    throw new Error(
      `No GECKO_HEAD_REF or GECKO_HEAD_REV found in ${COMM_GECKO_REV} of ${commRev}`
    );
  }
  const gitCommit = await getGitCommitFromHgRev(hgRev);
  console.log(
    ` - no GECKO_HEAD_REF, GECKO_HEAD_REV ${hgRev} is git commit ${gitCommit}`
  );
  return gitCommit;
}
