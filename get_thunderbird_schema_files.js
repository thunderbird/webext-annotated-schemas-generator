#!/usr/bin/env node

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Author: John Bieling
 */

import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import https from "https";
import bent from 'bent';

import jsonUtils from "comment-json";
import extract from "extract-zip";
import bcd from "@mdn/browser-compat-data" with { type: 'json' };
import os from "node:os";
import yaml from "yaml";

const requestJson = bent('GET', 'json', 200);

const API_DOC_BASE_URL = "https://webextension-api.thunderbird.net/en";
const HG_URL = "https://hg-edge.mozilla.org";
const BUILD_HUB_URL = "buildhub.moz.tools";

const COMM_SCHEMA_FOLDERS = [
  {
    folderPath: "mail/components/extensions/schemas",
    zipFileNameSuffix: "mail",
  },
  {
    folderPath: "mail/components/extensions/annotations",
    zipFileNameSuffix: "mail-annotations",
  }
];
const MOZILLA_SCHEMA_FOLDERS = [
  {
    folderPath: "browser/components/extensions/schemas",
    zipFileNameSuffix: "browser",
  },
  {
    folderPath: "toolkit/components/extensions/schemas",
    zipFileNameSuffix: "toolkit",
  },

];
const LOCALE_FILES = [
  {
    branch: "mozilla",
    filePath: "toolkit/locales/en-US/toolkit/global/extensionPermissions.ftl",
  },
  {
    branch: "comm",
    filePath: "mail/locales/en-US/messenger/extensionPermissions.ftl",
  }
];

const COMM_URL_PLACEHOLDER_FILE = "mail/components/extensions/annotations/url-placeholders.json"
const COMM_VERSION_FILE = "mail/config/version_display.txt";
const COMM_GECKO_REV = ".gecko_rev.yml";

let URL_REPLACEMENTS = {};

const HELP_SCREEN = `

Usage:

    node get_thunderbird_schema_files.js <options>
    
Options:
   --manifest_version=number  - The requested manifest version of the schema
                                files. Allowed values are "2" and "3".
   --output=path              - Path of a folder to store the processed schema
                                files. All existing files in that folder will be
                                deleted.
   --release=name             - The name of the Thunderbird release to get the
                                schema files for. The files will be downloaded
                                from hg.mozilla.org. Examples: "central", "beta",
                                "esr" or "esr115". Either --release or --source
                                has to be specified.
   --source=path              - Path to a local checkout of a mozilla repository
                                with a matching /comm directory. Either --release
                                or --source has to be specified.
`;
let TEMP_DIR;
let schemas = [];
let api_doc_branch = "latest";

const args = parseArgs();
if ((!args.source && !args.release) || !args.output || !args.manifest_version) {
  console.log(HELP_SCREEN);
} else {
  main();
}

// -----------------------------------------------------------------------------

async function main() {
  // Some additional sanity checks.
  if (!["2", "3"].includes(`${args.manifest_version}`)) {
    console.log(`Unsupported Manifest Version: <${args.manifest_version}>`);
    return;
  }

  const tempFolder = await fs.mkdtemp(
    path.join(os.tmpdir(), "webext-schemas-generator")
  );
  TEMP_DIR = tempFolder;

  // Download schema files, if requested.
  if (args.release) {
    let release = args.release
    if (release == "esr") {
      let esr = await getThunderbirdESR();
      if (!esr) {
        throw new Error(
          "Unable to determine version of current Thunderbird ESR."
        );
      }
      release = `esr${esr}`
    }
    console.log(` Downloading files from ${HG_URL} ...`);
    args.source = await downloadFilesFromMozilla(release);
  } else {
    // Set the release based on the provided folder name.
    args.release = path.basename(args.source).split("-")[1];
  }

  // Determine api_doc_branch based on requested release.
  if (args.release == "beta") {
    api_doc_branch = `beta-mv${args.manifest_version}`;
  } else if (args.release == "release") {
    api_doc_branch = `release-mv${args.manifest_version}`;
  } else if (args.release == "esr") {
    api_doc_branch = `esr-mv${args.manifest_version}`;
  } else if (args.release.startsWith("esr")) {
    api_doc_branch = `${args.release.substring(3)}-esr-mv${args.manifest_version}`;
  }

  // Setup output directory.
  await fs.rm(args.output, { recursive: true, force: true });
  await fs.mkdir(args.output, { recursive: true });

  // Extract and save the locale strings for permissions.
  const permissionStrings = await extractPermissionStrings(args.source);
  const permissionStringsFile = path.join(args.output, "permissions.ftl");
  await fs.writeFile(permissionStringsFile, permissionStrings.join('\n') + '\n', 'utf-8');

  console.log(` Validating used URLs ...`);

  URL_REPLACEMENTS = jsonUtils.parse(
    await fs.readFile(path.join(args.source, "comm", COMM_URL_PLACEHOLDER_FILE), "utf-8")
  );

  for (let [placeholder, url] of Object.entries(URL_REPLACEMENTS)) {
    const status = await validateUrl(url)
    if (status != 200) {
      console.log(" - problematic URL found:", status, placeholder, url)
    }
  }

  console.log(` Parsing schema files ...`);

  // Parse the toolkit schema files.
  await readSchemaFiles(
    "firefox",
    await getJsonFiles(
      path.join(args.source, "toolkit", "components", "extensions", "schemas")
    )
  );

  // Parse the browser schema files.
  await readSchemaFiles(
    "firefox",
    await getJsonFiles(
      path.join(args.source, "browser", "components", "extensions", "schemas")
    )
  );

  // Parse Thunderbird's own schema files.
  await readSchemaFiles(
    "thunderbird",
    await getJsonFiles(
      path.join(
        args.source,
        "comm",
        "mail",
        "components",
        "extensions",
        "schemas"
      )
    )
  );

  // Add information from annotation files.
  await readAnnotationFiles(
    ["thunderbird", "firefox"],
    await getJsonFiles(
      path.join(
        args.source,
        "comm",
        "mail",
        "components",
        "extensions",
        "annotations"
      )
    )
  );

  // Filter for supported schema entries, as defined by our annotation files.
  // Thunderbird schemas are always included, Firefox schemas need to be included
  // manually by specifying version_added.
  schemas = schemas.flatMap((schema) => {
    // Keep Thunderbird APIs.
    if (schema.owner == "thunderbird") {
      return [schema];
    }
    // Remove unsupported entries.
    schema.json = schema.json.filter(j => {
      // Is there a version_added root entry?
      const version_added = j.annotations && j.annotations.find(a => a.version_added).version_added;
      if (version_added) {
        // Root entries are removed, they are only used to indicate if a Firefox
        // API is supported or not.
        j.annotations = j.annotations.filter(a => !a.version_added);
        if (!j.annotations.length) {
          delete j.annotations
        }
        // The information is kept to be used as lower limit.
        schema.version_added = version_added;
        return true;
      }
      // A WebExtensionManifest?
      if (j.types && j.types.some(
        t => [
          "WebExtensionManifest",
        ].includes(t.$extend) && Object.values(t.properties).some(
          p => p.annotations && p.annotations.some(a => a.version_added)
        )
      )) {
        return true;
      }

      // A permission?
      if (j.types && j.types.some(
        t => [
          "Permission",
          "OptionalPermission",
          "PermissionNoPrompt",
          "OptionalPermissionNoPrompt"
        ].includes(t.$extend) && t.choices.some(c => c.enums && Object.values(c.enums).some(
          p => p.annotations && p.annotations.some(a => a.version_added)
        ))
      )) {
        return true;
      }

      return false;
    });
    return schema.json.length
      ? [schema]
      : [];
  });

  // Process $import.
  for (const schema of schemas) {
    schema.json = processImports(schema.json);
  }

  // Process schemas.
  for (const schema of schemas) {
    schema.json = processSchema(
      schema,
      schema.json,
      null,
      args.manifest_version
    );
  }

  // Verify api doc links (async).
  for (const schema of schemas) {
    for (let entries of schema.json) {
      for (let [name, values] of Object.entries(entries)) {

        if (
          ["types", "functions", "events"].includes(name)
        ) {
          for (let v of values.filter(v => v.api_documentation_url)) {
            let status = await validateUrl(v.api_documentation_url);
            if (status != 200) {
              console.log(" - problematic URL found:", status, v.api_documentation_url)
              delete v.api_documentation_url;
            }
          }
        };

        if (
          ["properties"].includes(name)
        ) {
          for (let v of Object.values(values).filter(v => v.api_documentation_url)) {
            let status = await validateUrl(v.api_documentation_url);
            if (status != 200) {
              console.log(" - problematic URL found:", status, v.api_documentation_url)
              delete v.api_documentation_url;
            }
          }
        }

      }
    }
  }

  // Add information about application version.
  const versionFilePath = path.join(args.source, "comm", ...COMM_VERSION_FILE.split("/"));
  const applicationVersion = await fs.readFile(versionFilePath, 'utf-8').then(v => v.trim());

  const githubWorkflowOutput = process.env.GITHUB_OUTPUT;
  if (githubWorkflowOutput) {
    await fs.appendFile(githubWorkflowOutput, `tag_name=${applicationVersion}\n`);
  }
  for (const schema of schemas) {
    let manifestNamespace = schema.json.find(e => e.namespace == "manifest");
    if (manifestNamespace) {
      manifestNamespace.applicationVersion = applicationVersion;
    } else {
      schema.json.push({
        namespace: "manifest",
        applicationVersion,
      })
    }
  }

  // Write files.
  for (const schema of schemas) {
    const output_file_name = schema.file.name;
    await writePrettyJSONFile(
      path.join(args.output, output_file_name),
      sortKeys(schema.json)
    );
  }

  // Cleanup.
  await fs.rm(TEMP_DIR, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------

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

  for (let localeFile of LOCALE_FILES) {
    const parts = localeFile.filePath.split("/");
    // Files from comm-* repositories are inside the comm/ folder in the local
    // source directory.
    if (localeFile.branch == "comm") {
      parts.unshift("comm");
    }
    const localeFilePath = path.join(sourceFolder, ...parts);
    const content = await fs.readFile(localeFilePath, 'utf-8')
    const lines = content.split('\n');
    const matchedLines = lines
      .filter(line => line.startsWith(prefix))
      .map(line => {
        // Remove numbers appended to the keys, which sometimes are needed to
        // deal with locale updates.
        const [key, ...rest] = line.split('=');
        let sanitizedKey = key.replace(/[\d\s]+$/, '');
        let sanitizedValue = rest.join('=').trim().replaceAll("{ -brand-short-name }", "Thunderbird")
        return `${sanitizedKey} = ${sanitizedValue}`;
      });
    permissionStrings.push(...matchedLines);
  }
  return permissionStrings;
}

/**
 * Downloads the required files from hg.mozilla.org. The files are specified by
 * the global const COMM_SCHEMA_FOLDERS, MOZILLA_SCHEMA_FOLDERS and LOCALE_FILES.
 * 
 * @param {string} release - The release to get the files for, matching the names
 *   used for releases on hg.mozilla.org (central, beta, esr128, ...)
 *
 * @returns {string} Path to the temp directory with the downloaded files.
 */
async function downloadFilesFromMozilla(release) {
  if (!release) {
    throw new Error(
      "Missing release parameter in downloadFilesFromMozilla()"
    );
  }

  const folders = new Set();
  const steps
    = 2 * COMM_SCHEMA_FOLDERS.length
    + 2 * MOZILLA_SCHEMA_FOLDERS.length
    + LOCALE_FILES.length
    + 3;

  let step = 1;

  // Query MOZ BUILD HUB to get the latest release for a given tree.
  const getCommRevisionFromBuildHub = async (release) => {
    try {
      const postData = JSON.stringify({
        "size": 1,
        "query": {
          "term": {
            "source.tree": `comm-${release}`
          }
        },
        "sort": [{
          "download.date": { "order": "desc" }
        }]
      });

      const options = {
        hostname: BUILD_HUB_URL,
        port: 443,
        path: '/api/search',
        method: 'POST'
      };

      console.log(
        ` [${step++}/${steps}]`,
        ` Requesting latest revision for comm-${release} from ${BUILD_HUB_URL} ...`
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

      let data = JSON.parse(await task.promise);
      return data.hits.hits[0]._source.source.revision;
    } catch (ex) {
      console.error(ex);
      throw new Error(`Failed to retrieve latest revision from ${BUILD_HUB_URL}`);
    }
  }
  const commRev = release == "central" ? "tip" : await getCommRevisionFromBuildHub(release);

  // Download the GECKO_REV file to get the matching MOZILLA revision.
  const getMozillaRevFromGeckoRevFile = async () => {
    const repository = `comm-${release}`;
    console.log(
      ` [${step++}/${steps}]`,
      ` Downloading ${COMM_GECKO_REV} from ${repository} @ ${commRev} to ${TEMP_DIR} ...`
    );
    let geckoRevFile = await downloadHgFile(repository, COMM_GECKO_REV, commRev, "rev");
    let content = await fs.readFile(geckoRevFile, "utf-8");
    let { GECKO_HEAD_REV } = yaml.parse(content);
    return GECKO_HEAD_REV;
  }
  const mozillaRev = release == "central" ? "tip" : await getMozillaRevFromGeckoRevFile();

  // Download COMM schema files.
  for (let schemaFolder of COMM_SCHEMA_FOLDERS) {
    const repository = `comm-${release}`;
    const zipFileName = `${release}-${schemaFolder.zipFileNameSuffix}.zip`;
    const zipFilePath = path.join(TEMP_DIR, zipFileName);
    console.log(
      ` [${step++}/${steps}]`,
      ` Downloading ${zipFileName} from ${repository} @ ${commRev} to ${TEMP_DIR} ...`
    );
    try {
      await download(getHgFolderZipPath(repository, schemaFolder.folderPath, commRev), zipFilePath);
    } catch (ex) {
      throw new Error("Download failed, try again later");
    }
    console.log(
      ` [${step++}/${steps}]`,
      ` Unpacking ${zipFileName} ...`
    );
    await extract(path.resolve(zipFilePath), {
      dir: path.resolve(TEMP_DIR),
      onEntry: (entry) => folders.add(entry.fileName.split("/")[0]),
    });
    await fs.unlink(zipFilePath);
  }

  // Download MOZILLA schema files.
  for (let schemaFolder of MOZILLA_SCHEMA_FOLDERS) {
    const repository = `mozilla-${release}`;
    const zipFileName = `${release}-${schemaFolder.zipFileNameSuffix}.zip`;
    const zipFilePath = path.join(TEMP_DIR, zipFileName);
    console.log(
      ` [${step++}/${steps}]`,
      ` Downloading ${zipFileName} from ${repository} @ ${mozillaRev} to ${TEMP_DIR} ...`
    );
    try {
      await download(getHgFolderZipPath(repository, schemaFolder.folderPath, mozillaRev), zipFilePath);
    } catch (ex) {
      throw new Error("Download failed, try again later");
    }
    console.log(
      ` [${step++}/${steps}]`,
      ` Unpacking ${zipFileName} ...`
    );
    await extract(path.resolve(zipFilePath), {
      dir: path.resolve(TEMP_DIR),
      onEntry: (entry) => folders.add(entry.fileName.split("/")[0]),
    });
    await fs.unlink(zipFilePath);
  }

  // Find the mozilla-* folder and rename /comm-* to /comm.
  let mozillaFolder;
  for (const folder of folders) {
    const parts = folder.split("-").map((e) => e.toLowerCase());
    if (parts[0] == "mozilla") {
      mozillaFolder = folder;
    }
    if (parts[0] == "comm") {
      await fs.rename(path.join(TEMP_DIR, folder), path.join(TEMP_DIR, "comm"));
    }
  }

  // Check if all needed folders are available.
  try {
    await fs.access(path.join(TEMP_DIR, mozillaFolder));
    await fs.access(path.join(TEMP_DIR, "comm"));
  } catch (ex) {
    throw new Error("Download of schema files did not succeed!");
  }

  // Move /comm inside of /mozilla.
  await fs.rename(
    path.join(TEMP_DIR, "comm"),
    path.join(TEMP_DIR, mozillaFolder, "comm")
  );

  // Download locale files.
  for (let localeFile of LOCALE_FILES) {
    const repository = `${localeFile.branch}-${release}`;
    const rev = localeFile.branch == "comm" ? commRev : mozillaRev;
    console.log(
      ` [${step++}/${steps}]`,
      ` Downloading ${localeFile.filePath} from ${repository} @ ${rev} to ${TEMP_DIR} ...`
    );
    await downloadHgFile(repository, localeFile.filePath, rev, mozillaFolder);
  }

  // Download application version file from comm-* repository.
  {
    const repository = `comm-${release}`;
    console.log(
      ` [${step++}/${steps}]`,
      ` Downloading ${COMM_VERSION_FILE} from ${repository} @ ${commRev} to ${TEMP_DIR} ...`
    );
    await downloadHgFile(repository, COMM_VERSION_FILE, commRev, mozillaFolder);
  }

  return path.join(TEMP_DIR, mozillaFolder);
}

/**
 * Get all files in a given folder.
 * 
 * @param {string} folderPath - The path of the folder
 * 
 * @returns {File[]}
 */
async function getJsonFiles(folderPath) {
  const files = await fs.readdir(folderPath, { withFileTypes: true });
  return files.filter(
    (item) =>
      !item.isDirectory() && path.extname(item.name).toLowerCase() === ".json"
  );
}

/**
 * Read the content of schema files, parse them as JSON and add them to the global
 * schemas object.
 * 
 * @param {string} owner - The owner of the schema, either "thunderbird" or "firefox".
 * @param {File[]} files
 */
async function readSchemaFiles(owner, files) {
  for (const file of files) {
    const json = jsonUtils.parse(
      await fs.readFile(path.join(file.path, file.name), "utf-8")
    );
    schemas.push({
      file,
      json,
      owner,
    });
  }
}

/**
 * Merge annotation elements from the provided annotation JSON into the specified
 * schema JSON.
 * 
 * @param {any} schema - An element from a schema JSON.
 * @param {any} annotation  - An element from an annotation JSON.
 * @param {string} basePath - The pase path of the currently processed annotation
 *    schema, needed to resolve the path of to-be-included files.
 */
async function mergeAnnotations(schema, annotation, basePath) {
  if (
    typeof schema != typeof annotation ||
    Array.isArray(schema) != Array.isArray(annotation)
  ) {
    throw new Error("Unexpected type mismatch between schema entry and annotation entry")
  }

  if (Array.isArray(annotation)) {
    // Array with objects which are identified by $extend, namespace, name, or id.
    for (let aEntry of annotation) {
      // If the annotation specified min/max_manifest_version, will match only
      // against the same entry in the schema, otherwise match against all entries
      // in the schema.
      let sEntries = schema.filter(e =>
        (aEntry.namespace && e.namespace == aEntry.namespace) ||
        (aEntry.$extend && e.$extend == aEntry.$extend) ||
        (aEntry.name && e.name == aEntry.name) ||
        (aEntry.id && e.id == aEntry.id)
      ).filter(e =>
        (!aEntry.min_manifest_version || aEntry.min_manifest_version == e.min_manifest_version) &&
        (!aEntry.max_manifest_version || aEntry.max_manifest_version == e.max_manifest_version)
      );
      if (sEntries.length) {
        for (let sEntry of sEntries) {
          await mergeAnnotations(sEntry, aEntry, basePath)
        }
      } else {
        throw new Error(`Unmatched entry: ${JSON.stringify(aEntry, null, 2)}`);
      }
    }
  } else if (typeof annotation == "object") {
    for (const aEntry of Object.keys(annotation)) {
      if (!schema[aEntry]) {
        await expandAnnotations(aEntry, annotation, basePath);
        schema[aEntry] = annotation[aEntry];
      } else {
        if (aEntry == "choices") {
          // Choices must be matched by position.
          if (schema[aEntry].length != annotation[aEntry].length) {
            throw new Error("Choices array with non-matching sizes: ", aEntry);
          }
          for (let i = 0; i < annotation[aEntry].length; i++) {
            await mergeAnnotations(schema[aEntry][i], annotation[aEntry][i], basePath)
          }
        } else {
          await mergeAnnotations(schema[aEntry], annotation[aEntry], basePath)
        }
      }
    }
  }
}

/**
 * Expand to-be-included elements and add them directly to the schema.
 * 
 * @param {string} aEntry - The name of the currently processed JSON property.
 * @param {any} annotation - The currently processed JSON object, which includes
 *   aEntry.
 * @param {string} basePath - The pase path of the currently processed annotation
 *    schema, needed to resolve the path of to-be-included files.
 */
async function expandAnnotations(aEntry, annotation, basePath) {
  switch (aEntry) {
    case "annotations":
      for (const aObj of annotation[aEntry]) {
        if (!aObj.code || Array.isArray(aObj.code)) {
          continue;
        }

        if (!aObj.type) {
          if (aObj.code.endsWith(".js") || aObj.code.endsWith(".mjs")) { aObj.type = "JavaScript"; }
          if (aObj.code.endsWith(".css")) { aObj.type = "CSS"; }
          if (aObj.code.endsWith(".json")) { aObj.type = "JSON"; }
        }
        const code = await fs.readFile(path.join(basePath, aObj.code), "utf-8");
        aObj.code = code.replaceAll("\r", "").split("\n");
      }
      break;
    case "enums":
      for (const enumName of Object.keys(annotation[aEntry])) {
        if (annotation[aEntry][enumName]["annotations"]) {
          await expandAnnotations("annotations", annotation[aEntry][enumName], basePath)
        }
      }
      break;
  }
}

/**
 * Merge the information stored in the annotation files into the schema files.
 * 
 * @param {string[]} owners - Array of owners. Values should be either "thunderbird"
 *    or "firefox". Try to merge each annotation file into the matching schema
 *    file of the primary owner first. If that fails, try the secondary owner.
 * @param {File[]} files - Array of annotation files.
 */
async function readAnnotationFiles(owners, files) {
  for (const file of files) {
    for (let owner of owners) {
      let schema = schemas.find(e =>
        e.owner == owner &&
        e.file.name == file.name
      );
      if (schema) {
        const json = jsonUtils.parse(
          await fs.readFile(path.join(file.path, file.name), "utf-8")
        );
        await mergeAnnotations(schema.json, json, file.path);
        break;
      }
    }
  }
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
function getHgFolderZipPath(repository, folderPath, revision) {
  const root = repository.endsWith("central") ? "" : "releases/";
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
function getHgFilePath(repository, filePath, rev) {
  const root = repository.endsWith("central") ? "" : "releases/";
  return `${HG_URL}/${root}${repository}/raw-file/${rev}/${filePath}`;
}

/**
 * Download a file from hg.mozilla.org.
 * @param {string} repository - The repository, for example comm-central,
 *    comm-beta, comm-esr115, ...
 * @param {string} filePath - The path of the file.
 * @param {string} rev - The revision of the file.
 * @param {string} folder - The destination folder
 */
async function downloadHgFile(repository, filePath, rev, folder) {
  const hgFilePath = getHgFilePath(repository, filePath, rev);
  const parts = filePath.split("/");
  // Files from comm-* repositories are inside the comm/ folder in the local
  // source directory.
  if (repository.startsWith("comm")) {
    parts.unshift("comm");
  }
  await fs.mkdir(path.join(TEMP_DIR, folder, ...parts.slice(0, -1)), { recursive: true });
  return download(hgFilePath, path.join(TEMP_DIR, folder, ...parts));
}

/**
 * Replace $import statements by the actual referenced element/namespace.
 *
 * @param {any} value - The currently processed value. Usually a schema JSON.
 *
 * @returns {any} The processed value.
 */
function processImports(value) {
  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(processImports);
  }

  // Recursive merge of objects, to is modified. 
  const mergeObjects = (to, from) => {
    for (const n in from) {
      if (typeof to[n] != "object") {
        to[n] = from[n];
      } else if (typeof from[n] == "object") {
        to[n] = mergeObjects(to[n], from[n]);
      }
    }
    return to;
  }

  if (value.hasOwnProperty("$import")) {
    // Assume imports are unique, ignore prepended namespace (lazy me).
    const id = value.$import.split(".").pop();
    delete value.$import;

    // We skip ManifestBase for now.
    if (id != "ManifestBase") {
      let imported = getNestedIdOrNamespace(schemas, id);
      if (imported) {
        // Do not import top level manifest limits.
        imported = JSON.parse(JSON.stringify(imported));
        delete imported.min_manifest_version;
        delete imported.max_manifest_version;
        // Do not import namespace name and id.
        delete imported.namespace;
        delete imported.id;
        return mergeObjects(value, imported);
      }
      console.log(`Missing requested import: ${id}`);
    }
  }

  // Default.
  return Object.keys(value).reduce((o, key) => {
    o[key] = processImports(value[key]);
    return o;
  }, {});
}

/**
 * Helper function to find an element or namespace in the provided (nested) obj.
 *
 * @param {any} value - The currently processed value. Usually a schema JSON.
 * @param {string} searchString - The id or namespace name to look for.
 *
 * @returns {any} The processed value.
 */
function getNestedIdOrNamespace(value, searchString) {
  if (typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      const rv = getNestedIdOrNamespace(element, searchString);
      if (rv !== undefined) {
        return rv;
      }
    }
    return undefined;
  }

  // An object
  if (value.namespace == searchString) {
    return value;
  }
  if (value.id == searchString) {
    return value;
  }
  for (const element of Object.values(value)) {
    const rv = getNestedIdOrNamespace(element, searchString);
    if (rv !== undefined) {
      return rv;
    }
  }
  return undefined;
}

/**
 * Sort JSON by keys for better diff-ability, filter by manifest version, merge
 * enums, remove single leftover choices.
 *
 * @param {object} schema - The currently processed schema.
 * @param {any} value - The currently processed value. Usually a schema JSON, but
 *   the function recursively calls itself on nested elements.
 * @param {string} name - The name of currently processed value.
 * @param {string} requested_manifest_version - The manifest version which should
 *   used. Invalid elements are removed.
 *
 * @returns {any} The processed value.
 */
function processSchema(
  schema,
  value,
  name,
  requested_manifest_version,
  fullPath = ""
) {
  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .filter(
        (v) =>
          (!v.min_manifest_version ||
            v.min_manifest_version <= requested_manifest_version) &&
          (!v.max_manifest_version ||
            v.max_manifest_version >= requested_manifest_version)
      )
      .map((e) =>
        processSchema(schema, e, e.name || e.id, requested_manifest_version, fullPath)
      );
  }

  // Looks like value is an object. Find current hierarchal location to be able
  // to retrieve compat data.
  if (value.namespace) {
    // Reset.
    fullPath = value.namespace;
  }

  if (name && typeof name !== "object") {
    fullPath = `${fullPath}.${name}`;
    const parts = fullPath.split(".");
    // Check if this is the event/type/function level.
    if (
      parts.length == 3 &&
      ["types", "functions", "events", "properties"].includes(parts[1])
    ) {
      const [namespaceName, , entryName] = parts;
      if (schema.owner == "firefox") {
        addFirefoxCompatData({
          schema,
          value,
          namespaceName,
          entryName,
        });
      }
      if (schema.owner == "thunderbird") {
        addThunderbirdCompatData({ value, namespaceName, entryName });
      }
    }

    // Check if this is the parameters level.
    if (
      parts.length == 5 &&
      ["types", "functions", "events"].includes(parts[1]) &&
      "parameters" == parts[3] &&
      schema.owner == "firefox"
    ) {
      const [namespaceName, , entryName, , paramName] = parts;
      addFirefoxCompatData({
        schema,
        value,
        namespaceName,
        entryName,
        paramName,
      });
    }
  } else {
    // Top-level properties are not an array, but an object with the property
    // names as keys.
    const parts = fullPath.split(".");
    if (parts.length == 2 && parts[1] == "properties") {
      for (let key of Object.keys(value)) {
        value[key] = processSchema(
          schema,
          value[key],
          key,
          requested_manifest_version,
          fullPath
        );
      }
      return value;
    }
  }

  return Object.keys(value).reduce((o, key) => {
    let v = value[key];
    const v_orig_length = v.length;
    if (
      (!v.min_manifest_version ||
        v.min_manifest_version <= requested_manifest_version) &&
      (!v.max_manifest_version ||
        v.max_manifest_version >= requested_manifest_version)
    ) {
      v = processSchema(
        schema,
        value[key],
        value[key].name,
        requested_manifest_version,
        `${fullPath}.${key}`
      );
      switch (key) {
        case "min_manifest_version":
        case "max_manifest_version":
          // Do not include manifest limits in clean per-single-manifest schema
          // files.
          break;
        case "choices":
          // Merge enums if a choice is all but enums.
          if (v_orig_length != v.length && v.every((e) => !!e.enum)) {
            // Merge into first entry.
            v[0].enum = v
              .reduce((enums, entry) => {
                enums.push(...entry.enum);
                return enums;
              }, [])
              .sort();
            v = [v[0]];
          }

          // If the manifest_version filter reduced the choice entries and only
          // one remains, remove the choice.
          if (v_orig_length != v.length && v.length == 1) {
            Object.assign(o, v[0]);
          } else {
            o[key] = v;
          }
          break;
        case "description":
        case "deprecated":
          if (typeof v === "string") {
            // Newer schema files use the Firefox notation directly, but older
            // ones may still use the deprecated reStructuredText notations.
            // Fix any remaining deprecated notation.
            v = v.replace(/``(.+?)``/g, "<val>$1</val>");
            v = v.replace(/:doc:`(.*?)`/g, "$(doc:$1)");
            v = v.replace(/:ref:`(.*?)`/g, "$(ref:$1)");
            v = v.replace(
              /:permission:`(.*?)`/g,
              "<permission>$1</permission>"
            );

            // Replace URLs.
            v = v.replace(/\$\(\s*url\s*:\s*([^)]+?)\s*\)\[(.+?)\]/g, (match, placeholder, label) => {
              const url = URL_REPLACEMENTS[placeholder.trim()];
              if (!url) {
                console.log(`Unknown url placeholder: ${placeholder}`);
                return match; // If no URL found, leave it as-is
              }
              return `<a href='${url}'>${label}</a>`;
            });

            // Replace single back ticks.
            v = v.replace(/`(.+?)`/g, "<val>$1</val>");
          }
        default:
          o[key] = v;
      }
    }

    return o;
  }, {});
}

/**
 * Add Firefox compatibility data from BCD.
 * 
 * @param {object} pathData
 * @param {object} pathData.schema - The currently processed schema.
 * @param {object} pathData.value - The currently processed value. Usually a schema
 *    JSON.
 * @param {string} pathData.namespaceName - namespace name of the to be processed
 *    value
 * @param {string} pathData.entryName - entry name of the to be processed
 *    value
 * @param {string} pathData.paramName - parameter name of the to be processed
 *    value
 */
function addFirefoxCompatData({ schema, value, namespaceName, entryName, paramName }) {
  let entry =
    bcd.webextensions.api[namespaceName] &&
    bcd.webextensions.api[namespaceName][entryName];
  if (entry && paramName) {
    entry = entry[paramName];
  }
  if (!entry) return;

  let compatData = entry.__compat;
  if (compatData) {
    if (compatData?.mdn_url) {
      if (!value.annotations) {
        value.annotations = [];
      }
      value.annotations.push({ mdn_documentation_url: compatData.mdn_url });
    }
    if (compatData?.support?.firefox) {
      if (!value.annotations) {
        value.annotations = [];
      }
      for (let key of Object.keys(compatData?.support?.firefox)) {
        switch (key) {
          case "version_added":
          case "version_removed": {
            // Do not override explicitly specified values from annotation files.
            if (!value.annotations.some(a => a.hasOwnProperty(key))) {
              // If Thunderbird globally specifies a higher version (in the root
              // of the schema) then Firefox/BCD, use that instead.
              const firefox_version = compatData.support.firefox[key];
              const thunderbird_version = schema[key];
              value.annotations.push({
                [key]: !isNaN(parseInt(thunderbird_version, 10)) && (
                  firefox_version == true ||
                  isNaN(parseInt(firefox_version, 10)) ||
                  parseInt(thunderbird_version, 10) > parseInt(firefox_version, 10)
                ) ? thunderbird_version : firefox_version
              })
            }
            break;
          }
          case "notes": {
            const notes = Array.isArray(compatData.support.firefox.notes)
              ? compatData.support.firefox.notes
              : [compatData.support.firefox.notes]
            notes.forEach(note => {
              value.annotations.push({ note, bcd: true })
            })
          }
        }
      }

      compatData.support.firefox;
    }
  }
}

/**
 * Add generated Thunderbird compatibility data.
 * 
 * @param {object} pathData
 * @param {object} pathData.value - The currently processed value. Usually a schema
 *   JSON.
 * @param {string} pathData.namespaceName - namespace name of the to be processed
 *    value
 * @param {string} pathData.entryName - entry name of the to be processed
 *    value
 */
function addThunderbirdCompatData({ value, namespaceName, entryName }) {
  const anchorParts = [entryName];
  if (value.parameters) {
    anchorParts.push(
      ...value.parameters.map((e) => e.name).filter((e) => e != "callback")
    );
  }
  const anchor = anchorParts.join("-").toLowerCase();
  if (!value.annotations) {
    value.annotations = [];
  }
  value.annotations.push({ api_documentation_url: `${API_DOC_BASE_URL}/${api_doc_branch}/${namespaceName}.html#${anchor}` });
}

/**
 * Sort nested objects by keys.
 * 
 * @param {any} x - To be sorted element. Skipped if it isn't an object.
 *
 * @returns The object recursively sorted by keys.
 */
function sortKeys(x) {
  if (typeof x !== "object" || !x) {
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
 * Helper function to produce pretty JSON files.
 *
 * @param {string} filePath - The path to write the JSON to.
 * @param {obj} json - The obj to write into the file.
 */
async function writePrettyJSONFile(filePath, json) {
  try {
    return await fs.writeFile(filePath, JSON.stringify(json, null, 4));
  } catch (err) {
    console.error("Error in writePrettyJSONFile()", filePath, err);
    throw err;
  }
}

/**
 * Helper function to download a file.
 *
 * @param {string} url - The URL to download.
 * @param {string} filePath - The path to write the downloaded file to.
 */
async function download(url, filePath) {
  await new Promise(resolve => setTimeout(resolve, 2500));
  return new Promise((resolve, reject) => {
    const file = createWriteStream(filePath);
    https
      .get(url, (response) => {
        response.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            resolve(filePath);
          });
        });
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

// Simple URL validator.
function validateUrl(url) {
  return new Promise(resolve => {
    const request = https.get(url, (response) => {
      response.resume();
      resolve(response.statusCode);
    });

    request.setTimeout(5000, () => {
      request.destroy();
      resolve(408); // Request Timeout
    });

    request.on('error', (err) => {
      resolve(500);
    })
  });
}

// Simple command line argument parser.
function parseArgs(argv = process.argv.slice(2)) {
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

// Simple helper to retrieve version of current ESR.
async function getThunderbirdESR() {
  const {
    THUNDERBIRD_ESR,
    THUNDERBIRD_ESR_NEXT,
  } = await requestJson("https://product-details.mozilla.org/1.0/thunderbird_versions.json");

  const getVersion = (v) => v ? Number(v.split(".")[0]) : null;
  const ESR = getVersion(THUNDERBIRD_ESR);
  const NEXT_ESR = getVersion(THUNDERBIRD_ESR_NEXT);

  return NEXT_ESR || ESR;
}