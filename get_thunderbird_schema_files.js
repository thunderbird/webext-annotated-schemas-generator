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
  toCamelCase,
  validateUrl,
  writePrettyJSONFile,
  filterAnnotationEntry,
} from './modules/tools.mjs';

import {
  checkoutSourceFile,
  getRevisionFromBuildHub,
  getCurrentThunderbirdESR,
  getHgFolderZipPath,
  getMozillaRevFromGeckoRevFile,
  getSupportedESRVersions,
} from './modules/mozilla.mjs';

import {
  COMM_SCHEMA_FOLDERS,
  COMM_URL_PLACEHOLDER_FILE,
  COMM_VERSION_FILE,
  HELP_SCREEN,
  LOCALE_FILES,
  MOZILLA_SCHEMA_FOLDERS,
  REGISTRY_FILES,
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

      // Build ESR version list and fetch commRevs for all ESR repos.
      const esrVersions = await getSupportedESRVersions();
      config.esrVersions = esrVersions;
      config.esrCommRevs = {};
      for (const v of esrVersions) {
        config.esrCommRevs[v] = {
          rev: await getRevisionFromBuildHub(`comm-esr${v}`),
          temporary: false,
        };
      }
    } else if (config.release === 'daily' || config.release === 'central') {
      // We allow "daily" as an input --release, but use "central".
      config.release = `central`;
    }

    console.log(` Downloading files from Mozilla ...`);

    // Add commRev and mozillaRev properties to the config object.
    const { commRev, mozillaRev } = await getMatchingRevisions(config.release);
    Object.assign(config, { commRev, mozillaRev });

    config.source = await downloadFilesFromMozilla(config.release);
  } else {
    // Set the release based on the provided folder name.
    config.release = path.basename(config.source).split('-')[1];

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

  // Use extension registries to merge schema files that contribute to the same
  // namespace (e.g. user_scripts.json + user_scripts_content.json both define
  // the userScripts namespace). The registries map schema files to namespace
  // paths, so we can identify which files need merging.
  await mergeSchemasByRegistry(config);

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
      revision: config.commRev.rev,
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

  // Create synthetic API namespace entries for manifest-only schema files.
  // These files only have a "manifest" namespace with $extend types but no API
  // namespace. The namespace name is derived from the registry mapping if
  // available, otherwise from the manifest key using camelCase convention.
  // This runs after filtering and processing to avoid the synthetic entries
  // being removed by the filter or modified by compat data generation.
  for (const schemaInfo of config.schemaInfos) {
    const hasApiNamespace = schemaInfo.schema.some(
      (e) => e.namespace && e.namespace !== 'manifest'
    );
    if (hasApiNamespace) continue;

    const manifestNs = schemaInfo.schema.find(
      (e) => e.namespace === 'manifest'
    );
    if (!manifestNs?.types) continue;

    for (const type of manifestNs.types) {
      if (type.$extend !== 'WebExtensionManifest') continue;
      for (const propName of Object.keys(type.properties || {})) {
        const apiName =
          config.manifestKeyToApiName.get(propName) || toCamelCase(propName);
        schemaInfo.schema.push({ namespace: apiName });
      }
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

  // Decide if responses should be cached. For example one could skip caching for
  // release by setting temporary = release === 'central';
  const temporary = false;
  const commRev = {
    rev: await getRevisionFromBuildHub(`comm-${release}`),
    temporary,
  };

  const mozillaRev = {
    rev: release === 'central'
      ? await getRevisionFromBuildHub('mozilla-central')
      : await getMozillaRevFromGeckoRevFile(release, commRev.rev, temporary),
    temporary,
  };

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
        getHgFolderZipPath(repository, schemaFolder.folderPath, config.commRev.rev),
        zipFilePath
      );
      console.log(` - unpacking ${zipFileName} ...`);
      await extract(path.resolve(zipFilePath), {
        dir: path.resolve(config.tempFolder),
        onEntry: (entry) => folders.add(entry.fileName.split('/')[0]),
      });
      await fs.unlink(zipFilePath);
    } catch (ex) {
      console.warn(` !! Skipping ${zipFileName}: ${ex.message}`);
    }
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
          config.mozillaRev.rev
        ),
        zipFilePath
      );
      console.log(` - unpacking ${zipFileName} ...`);
      await extract(path.resolve(zipFilePath), {
        dir: path.resolve(config.tempFolder),
        onEntry: (entry) => folders.add(entry.fileName.split('/')[0]),
      });
      await fs.unlink(zipFilePath);
    } catch (ex) {
      console.warn(` !! Skipping ${zipFileName}: ${ex.message}`);
    }
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
      localeFile.branch === 'comm' ? config.commRev.rev : config.mozillaRev.rev,
      mozillaFolder
    );
  }

  // Download extension registry files.
  for (const registryFile of REGISTRY_FILES) {
    const repository = `${registryFile.branch}-${release}`;
    await checkoutSourceFile(
      config,
      repository,
      registryFile.filePath,
      registryFile.branch === 'comm' ? config.commRev.rev : config.mozillaRev.rev,
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
      config.commRev.rev,
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
 * Resolve a chrome:// schema URL to a filesystem path relative to the source
 * root.
 *
 * @param {string} chromeUrl - e.g. "chrome://extensions/content/schemas/alarms.json"
 * @returns {string} The relative filesystem path, e.g. "toolkit/components/extensions/schemas/alarms.json"
 */
function resolveSchemaUrl(chromeUrl) {
  const chromeMap = {
    'chrome://extensions/content/': 'toolkit/components/extensions/',
    'chrome://browser/content/': 'browser/components/extensions/',
    'chrome://messenger/content/': 'comm/mail/components/extensions/',
  };
  for (const [prefix, fsPrefix] of Object.entries(chromeMap)) {
    if (chromeUrl.startsWith(prefix)) {
      return fsPrefix + chromeUrl.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Read extension registry files and merge schema files that contribute to the
 * same API namespace. For example, user_scripts.json and
 * user_scripts_content.json both define the "userScripts" namespace — the
 * content file's entries (events, functions, types) should be merged into the
 * parent file's namespace.
 *
 * @param {object} config - Global configuration object.
 */
async function mergeSchemasByRegistry(config) {
  // Build a map of schema filename → list of namespace paths from all registries,
  // and a map of manifest key → API namespace name.
  const schemaNamespaces = new Map();
  config.manifestKeyToApiName = new Map();
  for (const registryFile of REGISTRY_FILES) {
    const registryPath = path.join(
      config.source,
      ...registryFile.filePath.split('/')
    );
    let registry;
    try {
      registry = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
    } catch {
      console.warn(` !! Registry file not found: ${registryFile.filePath}`);
      continue;
    }
    for (const [, entry] of Object.entries(registry)) {
      // Build manifest key → API name mapping.
      if (entry.manifest && entry.paths?.length) {
        const apiName = entry.paths[0][0];
        for (const mk of entry.manifest) {
          config.manifestKeyToApiName.set(mk, apiName);
        }
      }

      if (!entry.schema || !entry.paths?.length) continue;
      const resolved = resolveSchemaUrl(entry.schema);
      if (!resolved) continue;
      const filename = path.basename(resolved);
      const topNamespace = entry.paths[0][0];
      if (!schemaNamespaces.has(filename)) {
        schemaNamespaces.set(filename, new Set());
      }
      schemaNamespaces.get(filename).add(topNamespace);
    }
  }

  // Find namespaces served by multiple schema files.
  // Invert the map: namespace → [filenames]
  const namespaceFiles = new Map();
  for (const [filename, namespaces] of schemaNamespaces) {
    for (const ns of namespaces) {
      if (!namespaceFiles.has(ns)) {
        namespaceFiles.set(ns, []);
      }
      namespaceFiles.get(ns).push(filename);
    }
  }

  // Merge schemas where multiple files contribute to the same namespace.
  for (const [namespace, filenames] of namespaceFiles) {
    if (filenames.length <= 1) continue;

    // Find the schemaInfos for these files.
    const schemaInfos = filenames
      .map((fn) => config.schemaInfos.find((si) => si.file.name === fn))
      .filter(Boolean);
    if (schemaInfos.length <= 1) continue;

    // Pick the first as primary, merge others into it.
    const primary = schemaInfos[0];
    for (let i = 1; i < schemaInfos.length; i++) {
      const secondary = schemaInfos[i];
      // Find the namespace entry in the secondary schema.
      const secondaryNs = secondary.schema.find(
        (e) => e.namespace === namespace
      );
      if (!secondaryNs) continue;

      // Find or create the namespace entry in the primary schema.
      let primaryNs = primary.schema.find((e) => e.namespace === namespace);
      if (!primaryNs) {
        primaryNs = { namespace };
        primary.schema.push(primaryNs);
      }

      // Merge arrays: functions, events, types.
      for (const key of ['functions', 'events', 'types']) {
        if (secondaryNs[key]?.length) {
          if (!primaryNs[key]) primaryNs[key] = [];
          primaryNs[key].push(...secondaryNs[key]);
        }
      }

      // Merge properties.
      if (secondaryNs.properties) {
        if (!primaryNs.properties) primaryNs.properties = {};
        Object.assign(primaryNs.properties, secondaryNs.properties);
      }

      // Remove the merged namespace from the secondary schema.
      secondary.schema = secondary.schema.filter(
        (e) => e.namespace !== namespace
      );

      // If secondary has no remaining content, remove it entirely.
      if (secondary.schema.length === 0) {
        const idx = config.schemaInfos.indexOf(secondary);
        if (idx !== -1) config.schemaInfos.splice(idx, 1);
      }
    }
  }
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
      } else if (aEntry.namespace) {
        // Allow annotations to introduce new namespace entries (e.g., for
        // documentation-only APIs like oauthProvider).
        schema.push(aEntry);
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
