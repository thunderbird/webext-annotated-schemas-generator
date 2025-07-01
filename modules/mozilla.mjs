import bent from 'bent';
import fs from 'node:fs/promises';
import https from 'https';
import jsonUtils from 'comment-json';
import path from 'node:path';
import yaml from 'yaml';

import { HG_URL, BUILD_HUB_URL, COMM_GECKO_REV } from './constants.mjs';
import { downloadUrl, readCachedUrl } from './tools.mjs';

const requestJson = bent('GET', 'json', 200);

/**
 * Download a file from hg.mozilla.org and add it to the local checkout folder.
 *
 * @param {string} repository - The repository, for example comm-central,
 *    comm-beta, comm-esr115, ...
 * @param {string} filePath - The path of the file.
 * @param {string} rev - The revision of the file.
 * @param {string} checkoutFolder - The local mozilla checkout folder
 */
export async function checkoutSourceFile(
  config,
  repository,
  filePath,
  rev,
  checkoutFolder
) {
  const hgFilePath = getHgFilePath(repository, filePath, rev);
  const parts = filePath.split('/');
  // Files from comm-* repositories are inside the comm/ folder in the local
  // source directory.
  if (repository.startsWith('comm')) {
    parts.unshift('comm');
  }
  await fs.mkdir(
    path.join(config.tempFolder, checkoutFolder, ...parts.slice(0, -1)),
    { recursive: true }
  );
  return downloadUrl(
    hgFilePath,
    path.join(config.tempFolder, checkoutFolder, ...parts)
  );
}

/**
 * Get URL to download a folder as a zip file from hg.mozilla.org.
 *
 * @param {string} repository - The repository, for example comm-central,
 *    comm-beta, comm-esr115, ...
 * @param {string} folderPath - The path of the folder.
 * @param {string} revision - The requested revision.
 *
 * @returns {string} URL pointing to zip download of the folder from hg.mozilla.org.
 */
export function getHgFolderZipPath(repository, folderPath, revision) {
  const root = repository.endsWith('central') ? '' : 'releases/';
  const rv = `${HG_URL}/${root}${repository}/archive/${revision}.zip/${folderPath}`;
  return rv;
}

/**
 * Get URL to download a raw file from hg.mozilla.org.
 *
 * @param {string} repository - The repository, for example comm-central,
 *    comm-beta, comm-esr115, ...
 * @param {string} filePath - The path of the file.
 * @param {string} rev - The revision of the file.
 *
 * @returns {string} URL pointing to the raw file download from hg.mozilla.org.
 */
export function getHgFilePath(repository, filePath, rev) {
  const root = repository.endsWith('central') ? '' : 'releases/';
  return `${HG_URL}/${root}${repository}/raw-file/${rev}/${filePath}`;
}

/**
 * Get URL to download the revision log for a file from hg.mozilla.org. At most
 * 125 revision entries are retrieved.
 *
 * @param {string} repository - The repository, for example comm-central,
 *    comm-beta, comm-esr115, ...
 * @param {string} filePath - The path of the file.
 * @param {string} rev - The revision of the file. (TODO)
 *
 * @returns {string} URL pointing to the raw file download from hg.mozilla.org.
 */
export function getHgRevisionLogPath(repository, filePath, rev) {
  const root = repository.endsWith('central') ? '' : 'releases/';
  return `${HG_URL}/${root}${repository}/json-log/${rev}/${filePath}?revcount=125`;
}

/**
 * Query BUILD_HUB_URL to get the latest release for a given comm release.
 *
 * @param {string} release - the requested comm release (beta, release, esrXY)
 *
 * @returns {string} revision/changeset
 */
export async function getCommRevisionFromBuildHub(release) {
  try {
    const postData = JSON.stringify({
      size: 1,
      query: { term: { 'source.tree': `comm-${release}` } },
      sort: [{ 'download.date': { order: 'desc' } }],
    });

    const options = {
      hostname: BUILD_HUB_URL,
      port: 443,
      path: '/api/search',
      method: 'POST',
    };

    console.log(
      ` - requesting latest revision for comm-${release} from ${BUILD_HUB_URL} ...`
    );

    // Create the HTTP request.
    const task = Promise.withResolvers();
    const req = https.request(options, (res) => {
      let responseData = '';

      // A chunk of data has been received.
      res.on('data', (chunk) => {
        responseData += chunk;
      });

      // The whole response has been received.
      res.on('end', () => {
        task.resolve(responseData);
      });
    });

    // Handle errors.
    req.on('error', (error) => {
      task.reject(error.message);
    });

    // Send the POST data.
    req.write(postData);
    req.end();

    const data = jsonUtils.parse(await task.promise);
    return data.hits.hits[0]._source.source.revision;
  } catch (ex) {
    console.error(ex);
    throw new Error(`Failed to retrieve latest revision from ${BUILD_HUB_URL}`);
  }
}

/**
 * Download the GECKO_REV file from hg.mozilla.org to get the MOZILLA revision
 * matching a given COMM revision.
 */
export async function getMozillaRevFromGeckoRevFile(release, commRev) {
  const gecko_rev_url = getHgFilePath(
    `comm-${release}`,
    COMM_GECKO_REV,
    commRev
  );
  const content = await readCachedUrl(gecko_rev_url, {
    temporary: commRev === 'tip',
  });
  const { GECKO_HEAD_REV } = yaml.parse(content);
  return GECKO_HEAD_REV;
}

/**
 * Retrieve version of the current ESR from product-details.mozilla.org.
 *
 * @returns {string} major version of the current ESR
 */
export async function getCurrentThunderbirdESR() {
  const { THUNDERBIRD_ESR, THUNDERBIRD_ESR_NEXT } = await requestJson(
    'https://product-details.mozilla.org/1.0/thunderbird_versions.json'
  );

  const getVersion = (v) => (v ? Number(v.split('.')[0]) : null);
  const ESR = getVersion(THUNDERBIRD_ESR);
  const NEXT_ESR = getVersion(THUNDERBIRD_ESR_NEXT);

  return NEXT_ESR || ESR;
}
