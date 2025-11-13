import bent from 'bent';
import fs from 'node:fs/promises';
import https from 'https';
import jsonUtils from 'comment-json';
import path from 'node:path';

import { createWriteStream } from 'node:fs';

/**
 * @typedef {import('./types.mjs').SchemaFile} SchemaFile
 */

const requestText = bent('GET', 'string', 200);

// The temporary cache is still written to disc, but can be easily cleared
// without interfering with the persistent cache.
const SCHEMA_CACHE = {};
const PERSISTENT_SCHEMA_CACHE_FILE = 'persistent_schema_cache.json';
const TEMPORARY_SCHEMA_CACHE_FILE = 'temporary_schema_cache.json';

/**
 * Updates URLs in a description string.
 *
 * This function replaces custom placeholders like $(url:key)[label] with actual links
 * from the urlReplacements map, and also updates existing relative hrefs if a matching
 * replacement is found. Absolute URLs are left unchanged.
 *
 * @param {string} description
 * @param {object} urlReplacements
 * @param {string} revision - used to supress logging for all but the "tip" revision
 * @returns {string} Updated descriptions where URLs have been replaced or updated.
 */
export function replaceUrlsInDescription(
  description,
  urlReplacements,
  revision
) {
  // 1. Replace existing hrefs with relative URLs
  description = description.replace(
    /<a\s+[^>]*href=(['"])(?![a-z][a-z0-9+.-]*:|\/\/)([^'"]+)\1([^>]*)>/gi,
    (match, quote, relUrl, rest) => {
      const replacementUrl = urlReplacements[relUrl.trim()];
      if (!replacementUrl) {
        if (revision === 'tip') {
          console.log(`Unknown relative URL in href: ${relUrl}`);
        }
        return match; // leave as-is if no replacement found
      }
      return `<a href=${quote}${replacementUrl}${quote}${rest}>`;
    }
  );

  // 2. Replace $(url:key)[label] placeholders
  description = description.replace(
    /\$\(\s*url\s*:\s*([^)]+?)\s*\)\[(.+?)\]/g,
    (match, placeholder, label) => {
      const url = urlReplacements[placeholder.trim()];
      if (!url) {
        if (revision === 'tip') {
          console.log(`Unknown url placeholder: ${placeholder}`);
        }
        return match; // leave as-is
      }
      return `<a href='${url}'>${label}</a>`;
    }
  );

  return description;
}

/**
 * Simple helper function to sort nested objects by keys.
 *
 * @param {any} x - To be sorted element. Skipped if it isn't an object.
 *
 * @returns The object recursively sorted by keys.
 */
export function sortKeys(x) {
  if (typeof x !== 'object' || !x) {
    return x;
  }
  if (Array.isArray(x)) {
    return x.map(sortKeys);
  }
  return Object.keys(x)
    .sort()
    .reduce((o, k) => ({ ...o, [k]: sortKeys(x[k]) }), {});
}

/**
 * Simple helper function to produce pretty JSON files.
 *
 * @param {string} filePath - The path to write the JSON to.
 * @param {obj} json - The obj to write into the file.
 */
export async function writePrettyJSONFile(filePath, json) {
  try {
    return await fs.writeFile(filePath, JSON.stringify(json, null, 4));
  } catch (err) {
    console.error('Error in writePrettyJSONFile()', filePath, err);
    throw err;
  }
}

/**
 * Simple helper function to check if a URL is valid.
 *
 * @param {string} url
 * @param {string} [placeholder] - Optional placeholder name for logging purposes
 *
 * @returns {boolean} true if the URL returns a successful response, false otherwise
 */
export async function validateUrl(url, placeholder = '') {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
    });

    if (response.ok) {
      return true;
    } else {
      const logEntries = [response.status, placeholder, url];
      console.log(
        ` - problematic URL found: ${logEntries.filter(Boolean).join(' - ')}`
      );
      return false;
    }
  } catch (error) {
    console.log(
      ` - problematic URL found: network error - ${placeholder || '?'} - ${url}`
    );
    return false;
  }
}

/**
 * Simple helper function to download a URL and store its content on the user's
 * disc.
 *
 * @param {string} url - The URL to download.
 * @param {string} filePath - The path to write the downloaded file to.
 */
export async function downloadUrl(url, filePath) {
  console.log(` - downloading ${url} ...`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return new Promise((resolve, reject) => {
    const file = createWriteStream(filePath);
    https
      .get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            resolve(filePath);
          });
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

/**
 * Simple helper function to download a URL and return its content.
 *
 * @param {string} url
 * @returns {string} content
 */
export async function readUrl(url) {
  console.log(` - downloading ${url}`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return requestText(url);
}

/**
 * Simple helper function to download a URL and cache its content in SCHEMA_CACHE.
 * Reading the same URL at a later time will retrieve the content from the cache.
 *
 * @param {string} url
 * @param {boolean} temporary - if the temporary cache is used, which is stored
 *    in a separate file and can be easily cleared independently of the persistent
 *    cache
 *
 * @returns {string} content of url
 */
export async function readCachedUrl(url, options) {
  const temporary = options?.temporary ?? false;
  const cache = temporary
    ? { type: 'temporary', file: TEMPORARY_SCHEMA_CACHE_FILE }
    : { type: 'persistent', file: PERSISTENT_SCHEMA_CACHE_FILE };

  if (!SCHEMA_CACHE[cache.type]) {
    try {
      const data = await fs.readFile(cache.file, 'utf-8');
      SCHEMA_CACHE[cache.type] = new Map(jsonUtils.parse(data));
    } catch (ex) {
      // Cache file does not yet exist.
      SCHEMA_CACHE[cache.type] = new Map();
    }
  }

  if (!SCHEMA_CACHE[cache.type].has(url)) {
    const rev = await readUrl(url);
    SCHEMA_CACHE[cache.type].set(url, rev);
    await writePrettyJSONFile(
      cache.file,
      Array.from(SCHEMA_CACHE[cache.type].entries())
    );
  }
  return SCHEMA_CACHE[cache.type].get(url);
}

/**
 * Simple helper function to parse command line arguments.
 *
 * @returns {object} command line arguments and their values
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (!value) {
        args[key] = true;
      } else {
        args[key] = value.toLowerCase();
      }
    }
  }
  return args;
}

/**
 * Simple helper function to get all JSON files in a given folder.
 *
 * @param {string} folderPath - The path of the folder
 *
 * @returns {SchemaFile[]}
 */
export async function getJsonFiles(folderPath) {
  const files = await fs.readdir(folderPath, { withFileTypes: true });
  return files
    .filter(
      (item) =>
        !item.isDirectory() && path.extname(item.name).toLowerCase() === '.json'
    )
    .map((item) => ({
      name: item.name,
      path: folderPath,
    }));
}

/**
 * Determines whether a given number is odd.
 *
 * @param {number} num - The number to check.
 *
 * @returns {boolean} Returns true if the number is odd, false otherwise.
 *
 */
export function isOdd(num) {
  return num % 2 !== 0;
}

/**
 * Filters the `properties` of an `aEntry` object so that it only includes
 * properties which also exist in the corresponding `sEntry.properties` object.
 *
 * @param {object} aEntry - annotation definition
 * @param {object} sEntry - schema definition
 * @returns {object} The filtered aEntry object.
 */
export function filterAnnotationEntry(aEntry, sEntry) {
  return {
    ...aEntry,
    properties: Object.fromEntries(
      Object.entries(aEntry.properties || {}).filter(
        ([key]) => key in (sEntry.properties || {})
      )
    ),
  };
}
