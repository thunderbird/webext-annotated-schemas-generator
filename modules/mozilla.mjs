import yaml from 'yaml';

import { COMM_GECKO_REV } from './constants.mjs';

/**
 * @typedef {import('./sources.mjs').LocalGitSource} LocalGitSource
 */

/**
 * Read the GECKO_REV file of a COMM revision to get the matching MOZILLA ref.
 *
 * @param {LocalGitSource} commSource
 * @param {string} commRev - The COMM revision.
 *
 * @returns {Promise<string>} The MOZILLA ref, a tag or "main".
 */
export async function getMozillaRefFromGeckoRevFile(commSource, commRev) {
  const content = await commSource.readFile(commRev, COMM_GECKO_REV);
  // GECKO_HEAD_REF is a tag (e.g. FIREFOX_153_5_0esr_BUILD1) or "default"
  // (the main branch). GECKO_HEAD_REV is ignored: it is a mercurial changeset,
  // which does not exist in the git repository.
  const { GECKO_HEAD_REF } = yaml.parse(content ?? '') ?? {};
  if (!GECKO_HEAD_REF) {
    throw new Error(
      `No GECKO_HEAD_REF found in ${COMM_GECKO_REV} of ${commRev}`
    );
  }
  return GECKO_HEAD_REF === 'default' ? 'main' : GECKO_HEAD_REF;
}
