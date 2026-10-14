import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {import('./types.mjs').SchemaFile} SchemaFile
 */

// Cache files of the former mercurial based implementation, which are removed
// if found.
const OBSOLETE_CACHE_FILES = [
  'persistent_schema_cache.json',
  'temporary_schema_cache.json',
];

/**
 * Updates URLs in a description string.
 *
 * This function replaces custom placeholders like $(url:key)[label] with actual links
 * from the urlReplacements map, and also updates existing relative hrefs if a matching
 * replacement is found. Absolute URLs are left unchanged.
 *
 * @param {string} description
 * @param {object} urlReplacements
 * @param {boolean} logWarnings - if true, log warnings about unknown URLs
 * @returns {string} Updated descriptions where URLs have been replaced or updated.
 */
export function replaceUrlsInDescription(
  description,
  urlReplacements,
  logWarnings
) {
  // 1. Replace existing hrefs with relative URLs
  description = description.replace(
    /<a\s+[^>]*href=(['"])(?![a-z][a-z0-9+.-]*:|\/\/)([^'"]+)\1([^>]*)>/gi,
    (match, quote, relUrl, rest) => {
      const replacementUrl = urlReplacements[relUrl.trim()];
      if (!replacementUrl) {
        if (logWarnings) {
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
        if (logWarnings) {
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
 * Fix malformed HTML tags where the closing tag is missing and a second
 * opening tag appears instead (e.g. `<code>X<code>` → `<code>X</code>`).
 *
 * @param {string} str - The string to fix.
 * @param {string[]} tags - Tag names to check.
 * @returns {string} The fixed string.
 */
export function fixMalformedClosingTags(str, tags = []) {
  for (const tag of tags) {
    const openTag = `<${tag}>`;
    let first = str.indexOf(openTag);

    while (first !== -1) {
      const second = str.indexOf(openTag, first + openTag.length);
      if (second === -1) {
        break;
      }

      const content = str.slice(first + openTag.length, second);
      if (!content.includes(`</${tag}>`)) {
        str = `${str.slice(0, second)}</${tag}>${str.slice(second + openTag.length)}`;
      }

      first = str.indexOf(openTag, second + 1);
    }
  }
  return str;
}

/**
 * Extract `<dl>/<dt>/<dd>` definition list pairs from a string.
 *
 * @param {string} str - The string to parse.
 * @returns {Object} An object mapping keys (dt) to descriptions (dd).
 */
export function extractDlDescriptions(str) {
  const result = {};
  if (!str) {
    return result;
  }
  const dlMatch = str.match(/<dl>([\s\S]*?)<\/dl>/i);
  if (!dlMatch) {
    return result;
  }
  const pairRegex = /<dt>(.*?)<\/dt>\s*<dd>(.*?)<\/dd>/gi;
  let match;
  while ((match = pairRegex.exec(dlMatch[1])) !== null) {
    result[match[1].trim()] = match[2].trim();
  }
  return result;
}

/**
 * Converts a snake_case string to camelCase.
 *
 * @param {string} str - The snake_case string to convert.
 * @returns {string} The converted camelCase string.
 */
export function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * fetch based request variant with retries and a hard timeout on client side.
 *
 * @param {string} url - The URL to GET.
 * @param {object} [headers] - Additional request headers.
 *
 * @returns {Promise<?string>} text content, or null if the URL does not exist
 */
export async function request(url, headers = {}) {
  console.log(` - downloading ${url}`);
  let lastError;
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      console.warn(` !! ${lastError.message}, retrying in 5s ...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 404) {
        return null;
      }
      if (response.ok) {
        return await response.text();
      }
      lastError = new Error(
        `Download failed with HTTP ${response.status} for ${url}`
      );
      lastError.status = response.status;
      const rateLimited = [403, 429].includes(response.status);
      if (rateLimited && !headers.Authorization) {
        lastError.message +=
          ' (the API rate limit may be exceeded, set GITHUB_TOKEN)';
      }
      // Other client errors will not go away by retrying.
      if (response.status < 500 && !rateLimited) {
        throw lastError;
      }
    } catch (ex) {
      if (ex === lastError) {
        throw ex;
      }
      lastError = new Error(`Download failed: ${ex.message} for ${url}`);
    }
  }
  throw lastError;
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
 * Remove the cache files of the former mercurial based implementation, the
 * git cache replaces them.
 */
export async function removeObsoleteCacheFiles() {
  for (const file of OBSOLETE_CACHE_FILES) {
    try {
      await fs.rm(file);
      console.log(` - removed obsolete cache file ${file}`);
    } catch {
      // The file does not exist.
    }
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
 * Simple helper function to parse command line arguments. Values are kept as
 * they are (e.g. paths), except for the release name, which is lowercased.
 *
 * @returns {object} command line arguments and their values
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      // Split at the first "=" only, the value may include "=" as well.
      const [key, ...rest] = arg.slice(2).split('=');
      const value = rest.join('=');
      if (!value) {
        args[key] = true;
      } else {
        args[key] = key === 'release' ? value.toLowerCase() : value;
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
