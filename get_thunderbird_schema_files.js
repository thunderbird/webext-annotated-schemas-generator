#!/usr/bin/env node

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Author: John Bieling
 */

import extract from 'extract-zip';
import fs from 'node:fs/promises';
import jsonUtils from 'comment-json';
import os from 'node:os';
import path from 'node:path';

import {
  downloadUrl,
  getJsonFiles,
  parseArgs,
  replaceUrlsInDescription,
  sortKeys,
  validateUrl,
  writePrettyJSONFile,
  filterAnnotationEntry,
} from './modules/tools.mjs';

import {
  checkoutSourceFile,
  getCommRevisionFromBuildHub,
  getCurrentThunderbirdESR,
  getHgFolderZipPath,
  getMozillaRevFromGeckoRevFile,
} from './modules/mozilla.mjs';

import {
  COMM_SCHEMA_FOLDERS,
  COMM_URL_PLACEHOLDER_FILE,
  COMM_VERSION_FILE,
  HELP_SCREEN,
  LOCALE_FILES,
  MOZILLA_SCHEMA_FOLDERS,
} from './modules/constants.mjs';

import { processImports, processSchema } from './modules/process.mjs';

/**
 * @typedef {import('./modules/types.mjs').SchemaFile} SchemaFile
 */

// The config object is used as a global state, not limited to passed in command
// line arguments.
const config = parseArgs();
if (
  (!config.source && !config.release) ||
  !config.output ||
  !config.manifest_version
) {
  console.log(HELP_SCREEN);
} else {
  main();
}

// -----------------------------------------------------------------------------

async function main() {
  // Some additional sanity checks.
  if (!['2', '3'].includes(`${config.manifest_version}`)) {
    console.log(`Unsupported Manifest Version: <${config.manifest_version}>`);
    return;
  }

  config.tempFolder = await fs.mkdtemp(
    path.join(os.tmpdir(), 'webext-schemas-generator')
  );

  // Download schema files, if requested.
  if (config.release) {
    if (config.release === 'esr') {
      const esr = await getCurrentThunderbirdESR();
      if (!esr) {
        throw new Error(
          'Unable to determine version of current Thunderbird ESR.'
        );
      }
      config.release = `esr${esr}`;
      config.docRelease = `esr`;
    } else {
      config.docRelease = config.release;
    }

    console.log(` Downloading files from Mozilla ...`);

    // Add commRev and mozillaRev properties to the config object.
    const { commRev, mozillaRev } = await getMatchingRevisions(config.release);
    Object.assign(config, { commRev, mozillaRev });

    config.source = await downloadFilesFromMozilla(config.release);
  } else {
    // Set the release based on the provided folder name.
    config.release = path.basename(config.source).split('-')[1];
    config.docRelease = config.release;

    console.log(` Downloading files from Mozilla ...`);

    // Add commRev and mozillaRev properties to the config object.
    const { commRev, mozillaRev } = await getMatchingRevisions(config.release);
    Object.assign(config, { commRev, mozillaRev });
  }

  // Setup output directory.
  await fs.rm(config.output, { recursive: true, force: true });
  await fs.mkdir(config.output, { recursive: true });

  // Extract and save the locale strings for permissions.
  const permissionStrings = await extractPermissionStrings(config.source);
  const permissionStringsFile = path.join(config.output, 'permissions.ftl');
  await fs.writeFile(
    permissionStringsFile,
    `${permissionStrings.join('\n')}\n`,
    'utf-8'
  );

  console.log(` Validating used URLs ...`);

  config.urlReplacements = jsonUtils.parse(
    await fs.readFile(
      path.join(config.source, 'comm', COMM_URL_PLACEHOLDER_FILE),
      'utf-8'
    )
  );

  for (const [placeholder, url] of Object.entries(config.urlReplacements)) {
    await validateUrl(url, placeholder);
  }

  console.log(` Parsing schema files ...`);

  config.schemaInfos = [];

  // Parse the toolkit schema files.
  await readSchemaFiles(
    'firefox',
    await getJsonFiles(
      path.join(config.source, 'toolkit', 'components', 'extensions', 'schemas')
    )
  );

  // Parse the browser schema files.
  await readSchemaFiles(
    'firefox',
    await getJsonFiles(
      path.join(config.source, 'browser', 'components', 'extensions', 'schemas')
    )
  );

  // Parse Thunderbird's own schema files.
  await readSchemaFiles(
    'thunderbird',
    await getJsonFiles(
      path.join(
        config.source,
        'comm',
        'mail',
        'components',
        'extensions',
        'schemas'
      )
    )
  );

  // Add information from annotation files.
  await readAnnotationFiles(
    ['thunderbird', 'firefox'],
    config,
    await getJsonFiles(
      path.join(
        config.source,
        'comm',
        'mail',
        'components',
        'extensions',
        'annotations'
      )
    )
  );

  // Filter for supported schema entries, as defined by our annotation files.
  // Thunderbird schemas are always included, Firefox schemas need to be included
  // manually by specifying version_added.
  config.schemaInfos = config.schemaInfos.flatMap((schemaInfo) => {
    // Keep Thunderbird APIs.
    if (schemaInfo.owner === 'thunderbird') {
      return [schemaInfo];
    }
    // Remove unsupported entries.
    schemaInfo.schema = schemaInfo.schema.filter((j) => {
      // Is there a version_added root entry?
      const version_added =
        j.annotations &&
        j.annotations.find((a) => a.version_added).version_added;
      if (version_added) {
        // Root entries are removed, they are only used to indicate if a Firefox
        // API is supported or not.
        j.annotations = j.annotations.filter((a) => !a.version_added);
        if (!j.annotations.length) {
          delete j.annotations;
        }
        // The information is kept to be used as lower limit.
        schemaInfo.version_added = version_added;
        return true;
      }
      // A WebExtensionManifest?
      if (
        j.types &&
        j.types.some(
          (t) =>
            ['WebExtensionManifest'].includes(t.$extend) &&
            Object.values(t.properties).some(
              (p) => p.annotations && p.annotations.some((a) => a.version_added)
            )
        )
      ) {
        return true;
      }

      // A permission?
      if (
        j.types &&
        j.types.some(
          (t) =>
            [
              'Permission',
              'OptionalPermission',
              'PermissionNoPrompt',
              'OptionalPermissionNoPrompt',
            ].includes(t.$extend) &&
            t.choices.some(
              (c) =>
                c.enums &&
                Object.values(c.enums).some(
                  (p) =>
                    p.annotations && p.annotations.some((a) => a.version_added)
                )
            )
        )
      ) {
        return true;
      }

      return false;
    });
    return schemaInfo.schema.length ? [schemaInfo] : [];
  });

  // Process $import.
  for (const schemaInfo of config.schemaInfos) {
    schemaInfo.schema = processImports(schemaInfo.schema);
  }

  // Process schemas.
  for (const schemaInfo of config.schemaInfos) {
    schemaInfo.schema = await processSchema({
      config,
      value: schemaInfo.schema,
      schemaInfo,
      revision: config.commRev,
    });
  }

  // Add information about application version.
  const versionFilePath = path.join(
    config.source,
    'comm',
    ...COMM_VERSION_FILE.split('/')
  );
  const applicationVersion = await fs
    .readFile(versionFilePath, 'utf-8')
    .then((v) => v.trim());

  const githubWorkflowOutput = process.env.GITHUB_OUTPUT;
  if (githubWorkflowOutput) {
    await fs.appendFile(
      githubWorkflowOutput,
      `tag_name=${applicationVersion}\n`
    );
  }
  for (const schemaInfo of config.schemaInfos) {
    const manifestNamespace = schemaInfo.schema.find(
      (e) => e.namespace === 'manifest'
    );
    if (manifestNamespace) {
      manifestNamespace.applicationVersion = applicationVersion;
    } else {
      schemaInfo.schema.push({ namespace: 'manifest', applicationVersion });
    }
  }

  // Write files.
  for (const schemaInfo of config.schemaInfos) {
    const output_file_name = schemaInfo.file.name;
    await writePrettyJSONFile(
      path.join(config.output, output_file_name),
      sortKeys(schemaInfo.schema)
    );
  }

  // Cleanup.
  await fs.rm(config.tempFolder, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------

async function getMatchingRevisions(release) {
  if (!release) {
    throw new Error('Missing release parameter in getMatchingRevisions()');
  }

  const commRev =
    release === 'central' ? 'tip' : await getCommRevisionFromBuildHub(release);

  const mozillaRev =
    release === 'central'
      ? 'tip'
      : await getMozillaRevFromGeckoRevFile(release, commRev);

  return { commRev, mozillaRev };
}

/**
 * Downloads the required files from hg.mozilla.org. The files are specified by
 * the const COMM_SCHEMA_FOLDERS, MOZILLA_SCHEMA_FOLDERS and LOCALE_FILES.
 *
 * @param {string} release - The release to get the files for, matching the names
 *   used for releases on hg.mozilla.org (central, beta, esr128, ...)
 *
 * @returns {string} Path to the temp directory with the downloaded files.
 */
async function downloadFilesFromMozilla(release) {
  if (!release) {
    throw new Error('Missing release parameter in downloadFilesFromMozilla()');
  }

  const folders = new Set();

  // Download COMM schema files.
  for (const schemaFolder of COMM_SCHEMA_FOLDERS) {
    const repository = `comm-${release}`;
    const zipFileName = `${release}-${schemaFolder.zipFileNameSuffix}.zip`;
    const zipFilePath = path.join(config.tempFolder, zipFileName);
    try {
      await downloadUrl(
        getHgFolderZipPath(repository, schemaFolder.folderPath, config.commRev),
        zipFilePath
      );
    } catch (ex) {
      throw new Error('Download failed, try again later');
    }
    console.log(` - unpacking ${zipFileName} ...`);
    await extract(path.resolve(zipFilePath), {
      dir: path.resolve(config.tempFolder),
      onEntry: (entry) => folders.add(entry.fileName.split('/')[0]),
    });
    await fs.unlink(zipFilePath);
  }

  // Download MOZILLA schema files.
  for (const schemaFolder of MOZILLA_SCHEMA_FOLDERS) {
    const repository = `mozilla-${release}`;
    const zipFileName = `${release}-${schemaFolder.zipFileNameSuffix}.zip`;
    const zipFilePath = path.join(config.tempFolder, zipFileName);
    try {
      await downloadUrl(
        getHgFolderZipPath(
          repository,
          schemaFolder.folderPath,
          config.mozillaRev
        ),
        zipFilePath
      );
    } catch (ex) {
      throw new Error('Download failed, try again later');
    }
    console.log(` - unpacking ${zipFileName} ...`);
    await extract(path.resolve(zipFilePath), {
      dir: path.resolve(config.tempFolder),
      onEntry: (entry) => folders.add(entry.fileName.split('/')[0]),
    });
    await fs.unlink(zipFilePath);
  }

  // Find the mozilla-* folder and rename /comm-* to /comm.
  let mozillaFolder;
  for (const folder of folders) {
    const parts = folder.split('-').map((e) => e.toLowerCase());
    if (parts[0] === 'mozilla') {
      mozillaFolder = folder;
    }
    if (parts[0] === 'comm') {
      await fs.rename(
        path.join(config.tempFolder, folder),
        path.join(config.tempFolder, 'comm')
      );
    }
  }

  // Check if all needed folders are available.
  try {
    await fs.access(path.join(config.tempFolder, mozillaFolder));
    await fs.access(path.join(config.tempFolder, 'comm'));
  } catch (ex) {
    throw new Error('Download of schema files did not succeed!');
  }

  // Move /comm inside of /mozilla.
  await fs.rename(
    path.join(config.tempFolder, 'comm'),
    path.join(config.tempFolder, mozillaFolder, 'comm')
  );

  // Download locale files.
  for (const localeFile of LOCALE_FILES) {
    const repository = `${localeFile.branch}-${release}`;
    await checkoutSourceFile(
      config,
      repository,
      localeFile.filePath,
      localeFile.branch === 'comm' ? config.commRev : config.mozillaRev,
      mozillaFolder
    );
  }

  // Download application version file from comm-* repository.
  {
    const repository = `comm-${release}`;
    await checkoutSourceFile(
      config,
      repository,
      COMM_VERSION_FILE,
      config.commRev,
      mozillaFolder
    );
  }

  return path.join(config.tempFolder, mozillaFolder);
}

/**
 * The permission strings are stored in two fluent files, one in toolkit/ and one
 * in mail/. This function extracts all string definitions with the prefix
 * "webext-perms-description-".
 *
 * @param {string} sourcefolders - the source folder as specified by --source
 *
 * @returns {string[]} - Permission strings.
 */
async function extractPermissionStrings(sourceFolder) {
  const permissionStrings = [];
  const prefix = 'webext-perms-description-';

  for (const localeFile of LOCALE_FILES) {
    const parts = localeFile.filePath.split('/');
    // Files from comm-* repositories are inside the comm/ folder in the local
    // source directory.
    if (localeFile.branch === 'comm') {
      parts.unshift('comm');
    }
    const localeFilePath = path.join(sourceFolder, ...parts);
    const content = await fs.readFile(localeFilePath, 'utf-8');
    const lines = content.split('\n');
    const matchedLines = lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => {
        // Remove numbers appended to the keys, which sometimes are needed to
        // deal with locale updates.
        const [key, ...rest] = line.split('=');
        const sanitizedKey = key.replace(/[\d\s]+$/, '');
        const sanitizedValue = rest
          .join('=')
          .trim()
          .replaceAll('{ -brand-short-name }', 'Thunderbird');
        return `${sanitizedKey} = ${sanitizedValue}`;
      });
    permissionStrings.push(...matchedLines);
  }
  return permissionStrings;
}

/**
 * Read the content of schema files, parse them as JSON and add them to the global
 * schemas object.
 *
 * @param {string} owner - The owner of the schema, either "thunderbird" or "firefox".
 * @param {SchemaFile[]} files
 */
async function readSchemaFiles(owner, files) {
  for (const file of files) {
    const schema = jsonUtils.parse(
      await fs.readFile(path.join(file.path, file.name), 'utf-8')
    );
    config.schemaInfos.push({ file, schema, owner });
  }
}

/**
 * Merge the information stored in the annotation files into the schema files.
 *
 * @param {string[]} owners - Array of owners. Values should be either "thunderbird"
 *    or "firefox". Try to merge each annotation file into the matching schema
 *    file of the primary owner first. If that fails, try the secondary owner.
 * @param {object} config - Config object.
 * @param {SchemaFile[]} files - Array of annotation files.
 */
async function readAnnotationFiles(owners, config, files) {
  for (const file of files) {
    for (const owner of owners) {
      const schemaInfo = config.schemaInfos.find(
        (e) => e.owner === owner && e.file.name === file.name
      );
      if (schemaInfo) {
        const json = jsonUtils.parse(
          await fs.readFile(path.join(file.path, file.name), 'utf-8')
        );
        await mergeAnnotations(config, schemaInfo.schema, json, file.path);
        break;
      }
    }
  }
}

/**
 * Merge annotation elements from the provided annotation JSON into the specified
 * schema JSON.
 *
 * @param {object} config - Config object.
 * @param {any} schema - An element from a schema JSON.
 * @param {any} annotation  - An element from an annotation JSON.
 * @param {string} basePath - The pase path of the currently processed annotation
 *    schema, needed to resolve the path of to-be-included files.
 */
async function mergeAnnotations(config, schema, annotation, basePath) {
  if (
    typeof schema !== typeof annotation ||
    Array.isArray(schema) !== Array.isArray(annotation)
  ) {
    throw new Error(
      'Unexpected type mismatch between schema entry and annotation entry'
    );
  }

  if (Array.isArray(annotation)) {
    // Array with objects which are identified by $extend, namespace, name, or id.
    for (const aEntry of annotation) {
      // If the annotation specified min/max_manifest_version, will match only
      // against the same entry in the schema, otherwise match against all entries
      // in the schema.
      const sEntries = schema
        .filter(
          (e) =>
            (aEntry.namespace && e.namespace === aEntry.namespace) ||
            (aEntry.$extend && e.$extend === aEntry.$extend) ||
            (aEntry.name && e.name === aEntry.name) ||
            (aEntry.id && e.id === aEntry.id)
        )
        .filter(
          (e) =>
            (!aEntry.min_manifest_version ||
              aEntry.min_manifest_version === e.min_manifest_version) &&
            (!aEntry.max_manifest_version ||
              aEntry.max_manifest_version === e.max_manifest_version)
        );
      if (sEntries.length) {
        for (const sEntry of sEntries) {
          // An annotated WebExtensionManifest aEntry may only be merged into an
          // schema sEntry, if they have a matching property.
          await mergeAnnotations(
            config,
            sEntry,
            sEntry.$extend === 'WebExtensionManifest' &&
              aEntry.$extend === sEntry.$extend
              ? filterAnnotationEntry(aEntry, sEntry)
              : aEntry,
            basePath
          );
        }
      } else {
        throw new Error(`Unmatched entry: ${JSON.stringify(aEntry, null, 2)}`);
      }
    }
  } else if (typeof annotation === 'object') {
    for (const aEntry of Object.keys(annotation)) {
      if (!schema[aEntry]) {
        await expandAnnotations(config, aEntry, annotation, basePath);
        schema[aEntry] = annotation[aEntry];
      } else {
        if (aEntry === 'choices') {
          // Choices must be matched by position.
          if (schema[aEntry].length !== annotation[aEntry].length) {
            throw new Error('Choices array with non-matching sizes: ', aEntry);
          }
          for (let i = 0; i < annotation[aEntry].length; i++) {
            await mergeAnnotations(
              config,
              schema[aEntry][i],
              annotation[aEntry][i],
              basePath
            );
          }
        } else {
          await mergeAnnotations(
            config,
            schema[aEntry],
            annotation[aEntry],
            basePath
          );
        }
      }
    }
  }
}

/**
 * Expand to-be-included elements and add them directly to the schema.
 *
 * @param {object} config - Config object.
 * @param {string} aEntry - The name of the currently processed JSON property.
 * @param {any} annotation - The currently processed JSON object, which includes
 *   aEntry.
 * @param {string} basePath - The pase path of the currently processed annotation
 *    schema, needed to resolve the path of to-be-included files.
 */
async function expandAnnotations(config, aEntry, annotation, basePath) {
  switch (aEntry) {
    case 'annotations':
      for (const aObj of annotation[aEntry]) {
        for (const type of ['text', 'hint', 'note', 'warning']) {
          if (!aObj[type]) {
            continue;
          }
          // Replace URLs and single or double back ticks.
          aObj[type] = replaceUrlsInDescription(
            aObj[type],
            config.urlReplacements
          )
            .replace(/``(.+?)``/g, '<val>$1</val>')
            .replace(/`(.+?)`/g, '<val>$1</val>');
        }

        if (aObj.list) {
          for (let i = 0; i < aObj.list.length; i++) {
            // Replace URLs and single or double back ticks.
            aObj.list[i] = replaceUrlsInDescription(
              aObj.list[i],
              config.urlReplacements
            )
              .replace(/``(.+?)``/g, '<val>$1</val>')
              .replace(/`(.+?)`/g, '<val>$1</val>');
          }
        }

        if (aObj.code) {
          if (Array.isArray(aObj.code)) {
            continue;
          }
          if (!aObj.type) {
            if (aObj.code.endsWith('.js') || aObj.code.endsWith('.mjs')) {
              aObj.type = 'JavaScript';
            }
            if (aObj.code.endsWith('.css')) {
              aObj.type = 'CSS';
            }
            if (aObj.code.endsWith('.json')) {
              aObj.type = 'JSON';
            }
          }
          const code = await fs.readFile(
            path.join(basePath, aObj.code),
            'utf-8'
          );
          aObj.code = code.replaceAll('\r', '').split('\n');
        }
      }
      break;
    case 'enums':
      for (const enumName of Object.keys(annotation[aEntry])) {
        if (annotation[aEntry][enumName]['annotations']) {
          await expandAnnotations(
            config,
            'annotations',
            annotation[aEntry][enumName],
            basePath
          );
        }
      }
      break;
  }
}
