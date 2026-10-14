import bcd from '@mdn/browser-compat-data' with { type: 'json' };

import {
  validateUrl,
  parseJson,
  replaceUrlsInDescription,
  fixMalformedClosingTags,
  extractDlDescriptions,
  isOdd,
} from './tools.mjs';
import {
  COMM_SCHEMA_FOLDER,
  COMM_VERSION_FILE,
  API_DOC_BASE_URL,
} from './constants.mjs';

/**
 * @typedef {import('./types.mjs').Config} Config
 * @typedef {import('./types.mjs').SchemaInfo} SchemaInfo
 */

// For debugging.
const PROCESS_LOGGER_CONFIG = {
  array: false,
  object: false,
  property: false,
  search: false,
  compat: false,
};

/**
 * Replace $import statements by the actual referenced element/namespace.
 *
 * @param {object} schema - The currently processed schema.
 * @param {any} value - The currently processed value. Usually a schema entry.
 *
 * @returns {any} The result of the processed value.
 */
export function processImports(schema, value = schema) {
  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => processImports(schema, v));
  }

  // Recursive merge of objects, to is modified.
  const mergeObjects = (to, from) => {
    for (const n in from) {
      if (typeof to[n] !== 'object') {
        to[n] = from[n];
      } else if (typeof from[n] === 'object') {
        to[n] = mergeObjects(to[n], from[n]);
      }
    }
    return to;
  };

  if (Object.hasOwn(value, '$import')) {
    // Assume imports are unique, ignore prepended namespace (lazy me).
    const id = value.$import.split('.').pop();
    delete value.$import;

    // TODO: We skip ManifestBase for now.
    if (id !== 'ManifestBase') {
      let imported = getNestedIdOrNamespace(schema, id);
      if (imported) {
        // Do not import top level manifest limits.
        imported = structuredClone(imported);
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
    o[key] = processImports(schema, value[key]);
    return o;
  }, {});
}

/**
 * Sort JSON by keys for better diff-ability, filter by manifest version, merge
 * enums, remove single leftover choices, add compat data.
 *
 * @param {object} params
 * @param {Config} params.config - A global config object.
 * @param {any} params.value - The currently processed value. Usually a schema
 *    entry.
 * @param {array} params.fullPath - The full hierarchical path of the given value
 *    in the schema.
 * @param {SchemaInfo} params.schemaInfo - Information about the currently processed
 *    schema (owner, file, schema, version_added).
 * @param {Set<string>} params.collectPaths - If given, a historical schema is
 *    processed: the paths of all its elements are added to this set, and no
 *    compat data is generated.
 * @param {string} params.revision - The currently processed revision, only used
 *    for debug logging.
 *
 * @returns {any} The result of the processed value.
 */
export async function processSchema({
  config,
  value,
  fullPath = [],
  schemaInfo = null,
  collectPaths = null,
  revision = null,
}) {
  const pathElements = [...fullPath];

  const isInVersionRange = (v) =>
    (!v.min_manifest_version ||
      v.min_manifest_version <= config.manifest_version) &&
    (!v.max_manifest_version ||
      v.max_manifest_version >= config.manifest_version);

  const processLogger = (type, path, key) => {
    if (PROCESS_LOGGER_CONFIG[type]) {
      const refs = path.map((e) => e.ref);
      if (key) {
        refs.push(key);
      }
      console.log(
        ` Process [${revision}] ${type.toUpperCase().padEnd(10, ' ')} :`,
        refs.join('~')
      );
    }
  };

  // If collectPaths is given, a historical schema is being processed to learn
  // which elements it includes, see hasPath().
  if (collectPaths) {
    processLogger('search', pathElements);
    collectPaths.add(getPathRef(pathElements));
  }

  // If there are no children, return without further processing.
  if (typeof value !== 'object') {
    return value;
  }

  // Handle array properties.
  if (Array.isArray(value)) {
    processLogger('array', pathElements);

    const filtered = value.filter(isInVersionRange);
    for (let i = 0; i < filtered.length; i++) {
      // The default is to identify nested elements via their index.
      let newPathElement = { ref: i, type: 'idx', info: filtered[i] };
      switch (pathElements.at(-1)?.ref) {
        case 'choices':
        case 'parameters':
          // choices and parameters always have to be identified via their index.
          break;
        case 'enum':
          newPathElement = { ref: filtered[i], type: 'value' };
          break;
        default:
          // Other elements can be identified via dedicated ref properties, if
          // available.
          for (const prop of ['name', 'id', 'namespace', '$extend']) {
            if (filtered[i][prop]) {
              newPathElement = { ref: filtered[i][prop], type: prop };
            }
          }
          break;
      }

      filtered[i] = await processSchema({
        config,
        value: filtered[i],
        schemaInfo,
        fullPath: [...pathElements, newPathElement],
        collectPaths,
        revision,
      });
    }
    return filtered;
  }

  // Handle object properties.
  processLogger('object', pathElements);

  // Reduce object properties with respect to requested manifest version.
  value = Object.keys(value).reduce((accumulator, key) => {
    const v = value[key];
    if (isInVersionRange(v)) {
      accumulator[key] = v;
    }
    return accumulator;
  }, {});

  // Reduce properties choices with respect to requested manifest version and
  // merge enums and choices.
  if (value.choices && !value.$extend) {
    let choices = value.choices.filter(isInVersionRange);

    // Merge choices, if they are all enums (side-effect of having different sets
    // of enums for different manifest versions).
    if (
      choices.length &&
      choices.every((choice) => Array.isArray(choice.enum))
    ) {
      const base = { ...choices[0] };
      base.enum = choices.flatMap((choice) => choice.enum).sort();
      choices = [base];
    }

    // If only one choice remains after filtering and/or merging, inline it into
    // `value` and remove `choices` (side-effect of having dedicated choices for
    // certain manifest versions).
    if (choices.length === 1) {
      delete value.choices;
      Object.assign(value, choices[0]);
    } else {
      // Otherwise, update with the filtered/merged choices
      value.choices = choices;
    }
  }

  // Overview for the hierarchical fullPath / path elements
  // ------------------------------------------------------
  //
  // The path elements hold the hierarchical information for the current value,
  // and is used to generate compat data by comparing different schema files and
  // checking if an element exists. Modifying the path information does not modify
  // the hierarchy of the generated schema.
  //
  // Number of path elements is even:
  //  - windows~functions~create~parameters~createProperties~properties
  //  - the current value is a container group
  //
  // Number of path elements is odd:
  //  - windows~functions~create~parameters~createProperties~properties~icons
  //  - the current value is an actual API element
  //  - pathElements.at(-2) should then be the group the current element belongs
  //    to (functions, properties, parameters, ...)
  //  - pathElements.at(-1) should be the actual API element

  // However, "returns", "items" and "additionalProperties" break the assumed
  // even/odd behavior: Fixed by inserting an extra path element!
  //  - original: cloudFile~events~onFileUpload~returns~properties~aborted
  //  - fixed:    cloudFile~events~onFileUpload~returns~0~properties~aborted
  if (
    !isOdd(pathElements.length) &&
    ['returns', 'items', 'additionalProperties'].includes(
      pathElements.at(-1)?.ref
    )
  ) {
    pathElements.push({ ref: '0', type: 'idx', info: {} });
  }

  // When searching for enums, the compat data generator uses the annotated enums
  // object, not the actual enum array. Add missing enums objects and remove
  // unsupported enums objects.
  if (value.enum) {
    value.enums = value.enum.reduce((accumulator, key) => {
      accumulator[key] = value.enums?.[key] || {};
      return accumulator;
    }, {});

    // Extract <dl> enum descriptions from the parent description and merge
    // into individual enum entries. Only set if not already present.
    if (value.description) {
      const dlDescriptions = extractDlDescriptions(value.description);
      for (const [enumKey, desc] of Object.entries(dlDescriptions)) {
        if (value.enums[enumKey] && !value.enums[enumKey].description) {
          value.enums[enumKey].description = desc;
        }
      }
      if (Object.keys(dlDescriptions).length > 0) {
        value.description = value.description.replace(/<dl>[\s\S]*?<\/dl>/i, "").trim();
      }
    }
  }

  // Generate compat data if needed.
  if (
    // Skip historical schemas, where compat data calculation is not needed.
    !collectPaths &&
    // Skip namespace at the top level.
    pathElements.length > 0 &&
    // Process only actual API elements, skip groups.
    isOdd(pathElements.length) &&
    ![
      // Skip annotations array elements.
      'annotations',
      // Skip items/returns array elements, they have a fake path element and
      // pathElements.at(-1) is always "0" - child entries will be picked up later.
      'items',
      'returns',
      // Skip patternProperties and additionalProperties, not useful - child
      // entries will be picked up later.
      'patternProperties',
      'additionalProperties',
      // Skip filters (TODO: mentioned in mozilla schema but not in mozilla code).
      'filters',
    ].includes(pathElements.at(-2)?.ref) &&
    // Skip container extending another container - child entries will be picked
    // up later.
    !value.$extend &&
    // Skip permission container (extend OptionalPermission etc) - permissions are
    // handled by the enum code.
    !(
      pathElements.length === 5 &&
      pathElements.at(0).ref === 'manifest' &&
      pathElements.at(1).ref === 'types' &&
      pathElements.at(2).type === '$extend' &&
      pathElements.at(3).ref === 'choices'
    )
  ) {
    if (
      pathElements.length === 1 ||
      [
        'types',
        'functions',
        'events',
        'properties',
        'extraParameters',
        'parameters',
        'choices',
        'enums',
      ].includes(pathElements.at(-2)?.ref)
    ) {
      processLogger('compat', pathElements);
      if (schemaInfo?.owner === 'firefox') {
        await addFirefoxCompatData(config, schemaInfo, value, pathElements);
      }
      if (schemaInfo?.owner === 'thunderbird') {
        await addThunderbirdCompatData(config, schemaInfo, value, pathElements);
      }
    } else {
      console.log(
        'UNHANDLED, not adding COMPAT data',
        pathElements.map((e) => e.ref).join('~')
      );
    }
  }

  // Dive into the object's properties.
  value = await Object.keys(value).reduce(async (accumulatorPromise, key) => {
    const accumulator = await accumulatorPromise;
    processLogger('property', pathElements, key);
    let v = await processSchema({
      config,
      value: value[key],
      schemaInfo,
      fullPath: [...pathElements, { ref: key, type: 'property' }],
      collectPaths,
      revision,
    });

    switch (key) {
      case 'min_manifest_version':
      case 'max_manifest_version':
        // Do not include manifest limits in clean per-single-manifest schema
        // files.
        break;
      case 'description':
      case 'deprecated':
        if (typeof v === 'string') {
          // Newer schema files use the Firefox notation directly, but older
          // ones may still use the deprecated reStructuredText notations.
          v = v.replace(/:doc:`(.*?)`/g, '$(doc:$1)');
          v = v.replace(/:ref:`(.*?)`/g, '$(ref:$1)');
          v = v.replace(/:permission:`(.*?)`/g, '<permission>$1</permission>');

          // Replace URLs and single or double back ticks and rebrand.
          v = replaceUrlsInDescription(v, config.urlReplacements, revision === config.commRev)
            .replace(/``(.+?)``/g, '<val>$1</val>')
            .replace(/`(.+?)`/g, '<val>$1</val>')
            .replaceAll('Firefox', 'Thunderbird');

          // Fix malformed HTML tags (e.g. <code>X<code> → <code>X</code>).
          v = fixMalformedClosingTags(v, ["val", "var", "code", "permission"]);
        }
        accumulator[key] = v;
        break;
      default:
        if (typeof v === 'string') {
          v = fixMalformedClosingTags(v, ["val", "var", "code", "permission"]);
        }
        accumulator[key] = v;
    }

    return accumulator;
  }, Promise.resolve({}));

  // Remove empty enums entries.
  if (value.enums) {
    const filtered = Object.keys(value.enums).reduce((accumulator, key) => {
      if (Object.keys(value.enums[key]).length > 0) {
        accumulator[key] = value.enums[key];
      }
      return accumulator;
    }, {});

    if (Object.keys(filtered).length > 0) {
      value.enums = filtered;
    } else {
      delete value.enums;
    }
  }

  return value;
}

/**
 * Helper function to find an element or namespace in the provided (nested) obj.
 *
 * @param {any} value - The currently processed value. Usually a schema JSON.
 * @param {string} searchString - The id or namespace name to look for.
 *
 * @returns {any} The result of the processed value.
 */
function getNestedIdOrNamespace(value, searchString) {
  if (typeof value !== 'object') {
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
  if (value.namespace === searchString) {
    return value;
  }
  if (value.id === searchString) {
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
 * Add Firefox compatibility data from BCD.
 *
 * @param {Config} config - Global config data.
 * @param {SchemaInfo} schemaInfo - Information about the currently processed schema
 *    (owner, file, schema, version_added).
 * @param {any} value - The currently processed value. Usually a schema entry.
 * @param {array} searchPath - The path of the currently processed value, which
 *    should be searched for in the browser-compat-data repository or in annotated
 *    Thunderbird schema files.
 */
async function addFirefoxCompatData(config, schemaInfo, value, searchPath) {
  // Allow to access nested object by specifying a path, for example:
  // entry = getNested(bcd.webextensions.api, "privacy.network")
  const getNested = (obj, path) => {
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  };

  let entry = getNested(bcd.webextensions.api, searchPath[0].ref);
  if (!entry) {
    return;
  }

  // Dive and follow the searchPath.
  let testDepth = 2;
  while (searchPath.length > testDepth) {
    // The searchPath may by of type idx (ref is an idx) or of type property/name
    // (ref is a name). For the idx case, more info is avail in the info object.
    // let prevEntry = entry;
    if (
      searchPath[testDepth].type === 'idx' &&
      searchPath[testDepth].info?.name
    ) {
      entry = entry[searchPath[testDepth].info.name];
    } else {
      entry = entry[searchPath[testDepth].ref];
    }
    if (!entry) {
      // Helpful logging to understand what is going on here.
      // console.log({ searchPath, prevEntry });
      return;
    }
    testDepth += 2;
  }

  const compatData = entry.__compat;
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
      for (const key of Object.keys(compatData?.support?.firefox)) {
        switch (key) {
          case 'version_added':
          case 'version_removed': {
            // Do not override explicitly specified values from annotation files.
            if (!value.annotations.some((a) => Object.hasOwn(a, key))) {
              // If Thunderbird globally specifies a higher version (in the root
              // of the schema) then Firefox/BCD, use that instead.
              const firefox_version = compatData.support.firefox[key];
              const thunderbird_version = schemaInfo[key];
              let version =
                !isNaN(parseInt(thunderbird_version, 10)) &&
                  (firefox_version === true ||
                    isNaN(parseInt(firefox_version, 10)) ||
                    parseInt(thunderbird_version, 10) >
                    parseInt(firefox_version, 10))
                  ? thunderbird_version
                  : firefox_version;

              // Map version_added to ESR versions.
              if (key === 'version_added' && config.release.startsWith('esr')) {
                const major = parseInt(version, 10);
                if (!isNaN(major)) {
                  const esr = config.esrVersions.find((v) => v >= major);
                  // If beyond the latest ESR, map to the latest ESR
                  // (the feature is present in the schema, so it must
                  // be available on the current ESR).
                  version = `${esr || config.esrVersions.at(-1)}.0`;
                }
              }

              value.annotations.push({ [key]: version });
            }
            break;
          }
          case 'notes': {
            const notes = Array.isArray(compatData.support.firefox.notes)
              ? compatData.support.firefox.notes
              : [compatData.support.firefox.notes];
            notes.forEach((note) => {
              // Also rebrand Firefox notes on-the-fly to Thunderbird.
              value.annotations.push({
                note: note.replaceAll('Firefox', 'Thunderbird'),
                bcd: true,
              });
            });
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
 * @param {Config} config - Global config data.
 * @param {SchemaInfo} schemaInfo - Information about the currently processed schema
 *    (owner, file, schema, version_added).
 * @param {any} value - The currently processed value. Usually a schema entry.
 * @param {array} searchPath - The path of the currently processed value, which
 *    should be searched for in historical schema files.
 */
async function addThunderbirdCompatData(config, schemaInfo, value, searchPath) {
  if (!value.annotations) {
    value.annotations = [];
  }

  // Add api_documentation_url for main entries (functions, events, ...)
  if (searchPath.length === 3) {
    const [namespaceName, , entryName] = searchPath.map((e) => e.ref);
    let api_documentation_url;

    // Manifest entries are documented on the owning API page, not on a
    // non-existent manifest.html. Resolve the file's sole API namespace.
    let pageNamespace = namespaceName;
    if (namespaceName === 'manifest') {
      const apiNamespaces = schemaInfo.schema
        .filter((e) => e.namespace && e.namespace !== 'manifest')
        .map((e) => e.namespace);
      if (apiNamespaces.length === 1) {
        pageNamespace = apiNamespaces[0];
      }
      // 0 API namespaces (global manifest.json) or >1 (an unsplit
      // multi-namespace file): no single owning page - leave unchanged.
    }

    // types.Setting properties are rendered as sub-pages, not as anchors
    // on the parent page.
    if (value['$ref'] === 'types.Setting') {
      api_documentation_url = `${getApiDocSlug(config)}/${pageNamespace}.${entryName}.html`;
    } else {
      const anchorParts = [entryName];
      if (value.parameters) {
        anchorParts.push(
          ...value.parameters.map((e) => e.name).filter((e) => e !== 'callback')
        );
      }
      const anchor = anchorParts.join('-').toLowerCase();
      api_documentation_url = `${getApiDocSlug(config)}/${pageNamespace}.html#${anchor}`;
    }

    if (config['no-link-check']) {
      value.annotations.push({ api_documentation_url });
    } else {
      const isValidURL = await validateUrl(
        api_documentation_url,
        `missing documentation required for compat data: ${JSON.stringify(searchPath)}`
      );
      if (isValidURL) {
        value.annotations.push({ api_documentation_url });
      }
    }
  }

  // Generate compat data from schema files if version_added was not yet annotated.
  if (
    !config['no-compat-data'] &&
    !value.annotations.find((a) => Object.hasOwn(a, 'version_added'))
  ) {
    value.annotations.push({
      version_added: await extractThunderbirdCompatData(
        config,
        schemaInfo.file.name,
        searchPath
      ),
    });
  }
}

/**
 * Calculate the documentation slug/path for the requested manifest version and
 * Thunderbird version.
 *
 * @param {Config} config - Global config data.
 */
function getApiDocSlug(config) {
  if (config.release.startsWith("esr")) {
    return `${API_DOC_BASE_URL}/esr-mv${config.manifest_version}`;
  }
  if (config.release === 'beta') {
    return `${API_DOC_BASE_URL}/beta-mv${config.manifest_version}`;
  }
  if (config.release === 'central') {
    return `${API_DOC_BASE_URL}/daily-mv${config.manifest_version}`;
  }
  return `${API_DOC_BASE_URL}/mv${config.manifest_version}`;
}

/**
 * Get the reference of a path, as used in the sets of historical schema paths.
 *
 * @param {array} pathElements - The path of a schema element.
 * @returns {string} e.g. "windows~functions~create"
 */
function getPathRef(pathElements) {
  return pathElements.map((e) => e.ref).join('~');
}

/**
 * Check if a historical schema includes an element.
 *
 * @param {Set<string>} paths - The paths of all elements of the historical
 *    schema, see processSchema().
 * @param {array} searchPath - The path of the element.
 *
 * @returns {boolean}
 */
function hasPath(paths, searchPath) {
  const searchPathRef = getPathRef(searchPath);
  if (paths.has(searchPathRef)) {
    return true;
  }
  // Special handling for choices: A parameter could have been added in TB78,
  // but turned into a choice in TB96, which results in two compat entries:
  // - one for the parameter itself              : added in TB78
  // - one for the first choice of the parameter : added in TB96
  // However, the first choice is the original parameter and should be logged
  // as added in TB78. Therefore, if the search ends with "choices~0", the
  // parent counts as well.
  if (searchPathRef.endsWith('~items~0~choices~0')) {
    return paths.has(searchPathRef.slice(0, -18));
  }
  if (searchPathRef.endsWith('~choices~0')) {
    return paths.has(searchPathRef.slice(0, -10));
  }
  return false;
}

/**
 * Compare version numbers like "128.2.0" or "131".
 *
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

/**
 * Get the version which is reported as version_added for a historical
 * revision.
 *
 * For ESR releases, a revision whose major version is an ESR version is part
 * of that ESR (including backports during its ESR cycle) and its version is
 * reported without suffix. Other versions are reported as the next ESR
 * including them. For other releases, the major version is reported.
 *
 * @param {Config} config - Global config data.
 * @param {string} version - The content of the version file of the revision,
 *    e.g. "128.2.0esr", "102.3.0", "131.0a1" or "130.0b2".
 *
 * @returns {string} e.g. "128.2.0", "102.3.0", "140.0" or "130"
 */
function getReportedVersion(config, version) {
  const major = parseInt(version, 10);
  if (!config.release.startsWith('esr')) {
    return `${major}`;
  }
  if (config.esrVersions.includes(major)) {
    // Strip suffixes like "esr", "a1" or "b2".
    return version.replace(/[^0-9.].*/g, '');
  }
  const esr = config.esrVersions.find((v) => v >= major);
  return `${esr || config.esrVersions.at(-1)}.0`;
}

// Map of schema file names to the promises of their historical revisions.
const SCHEMA_REVISIONS_CACHE = new Map();

/**
 * Get all revisions of a Thunderbird schema file in the history of the
 * processed branch (for ESR releases: of all ESRs up to the processed one, see
 * getHistoryRefs()), with the paths of their elements and their reported
 * version.
 *
 * @param {Config} config - Global config data.
 * @param {string} fileName - Name of the Thunderbird schema file.
 *
 * @returns {Promise<{revision: string, version: string, paths: Set<string>}[]>}
 */
function getSchemaRevisions(config, fileName) {
  if (!SCHEMA_REVISIONS_CACHE.has(fileName)) {
    SCHEMA_REVISIONS_CACHE.set(fileName, readSchemaRevisions(config, fileName));
  }
  return SCHEMA_REVISIONS_CACHE.get(fileName);
}

async function readSchemaRevisions(config, fileName) {
  const schemaFilePath = `${COMM_SCHEMA_FOLDER}/${fileName}`;
  const revisions = [];
  for (const revision of await config.commSource.getFileHistory(
    config.historyRefs,
    schemaFilePath
  )) {
    // The history includes the revision which removed the file.
    const content = await config.commSource.readFile(revision, schemaFilePath);
    if (content === null) {
      continue;
    }
    const schema = processImports(parseJson(content, schemaFilePath));
    const paths = new Set();
    await processSchema({
      config,
      value: schema,
      collectPaths: paths,
      revision,
    });
    const version = (
      await config.commSource.readFile(revision, COMM_VERSION_FILE)
    ).trim();
    revisions.push({
      revision,
      version: getReportedVersion(config, version),
      paths,
    });
  }
  return revisions;
}

/**
 * Find the version which first supported the specific API element, based on
 * the history of its schema file.
 *
 * @param {Config} config - Global config data.
 * @param {string} fileName - Name of the Thunderbird schema file.
 * @param {array} searchPath - Path of the searched API element.
 *
 * @returns {Promise<string|boolean>} First Thunderbird version supporting the
 *    specified API element, or false.
 */
async function extractThunderbirdCompatData(config, fileName, searchPath) {
  let versionAdded = false;
  for (const { version, paths } of await getSchemaRevisions(config, fileName)) {
    if (
      hasPath(paths, searchPath) &&
      (!versionAdded || compareVersion(version, versionAdded) < 0)
    ) {
      versionAdded = version;
    }
  }
  return versionAdded;
}
