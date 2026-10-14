/**
 * JSON schema file object.
 *
 * @typedef {Object} SchemaFile
 * @property {string} name - The filename of the JSON schema file (e.g., "browser.json")
 * @property {string} path - The absolute directory path containing the file
 */

/**
 * Configuration object for the schema generation process.
 *
 * @typedef {Object} Config
 * @property {string} [source] - Source folder path for local schema files
 * @property {string} [release] - Thunderbird release version to download
 * @property {string} output - Output directory for generated schemas
 * @property {string} manifest_version - WebExtension manifest version ("2" or "3")
 * @property {string} [tempFolder] - Temporary folder for processing
 * @property {string} [branch] - Branch of the comm repository (e.g. "esr153", "main")
 * @property {string[]} [historyBranches] - Branches whose history is used for
 *    the compat data (for ESR releases: all ESR branches up to `branch`)
 * @property {number[]} [esrVersions] - All ESR versions up to `branch`, only
 *    for ESR releases
 * @property {string} [commRev] - Comm repository revision (git commit)
 * @property {string} [mozillaRev] - Mozilla repository revision (git commit)
 * @property {import('./sources.mjs').LocalGitSource} [commSource] - The local
 *    clone of the comm repository
 * @property {import('./sources.mjs').GitHubSource} [mozillaSource] - The
 *    mozilla repository on GitHub
 * @property {Object} [urlReplacements] - URL placeholder replacements
 * @property {SchemaInfo[]} [schemaInfos] - Array of processed schema information
 */

/**
 * Schema information object containing file and parsed data.
 *
 * @typedef {Object} SchemaInfo
 * @property {SchemaFile} file - The schema file metadata
 * @property {Object} schema - The parsed JSON schema content
 * @property {string} owner - The owner of the schema ("thunderbird" or "firefox")
 */
