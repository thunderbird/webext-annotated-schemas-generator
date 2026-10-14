export const API_DOC_BASE_URL = 'https://webextension-api.thunderbird.net/en';

export const COMM_GECKO_REV = '.gecko_rev.yml';

// The Thunderbird repository. It is cloned (blobless) into GIT_CACHE_DIR, as
// the history of the schema files is needed to generate compat data.
export const COMM_GIT_URL =
  'https://github.com/thunderbird/thunderbird-desktop.git';

export const GIT_CACHE_DIR = 'git-cache/thunderbird-desktop.git';

// The Firefox repository. Only a single revision is needed, which is read
// through the GitHub API.
export const MOZILLA_GITHUB_REPOSITORY = 'mozilla-firefox/firefox';

export const GITHUB_API_URL = 'https://api.github.com';

export const GITHUB_RAW_URL = 'https://raw.githubusercontent.com';

// The oldest ESR branch available in the git repository. Its history includes
// all older versions.
export const OLDEST_ESR = 115;

// ESR versions released before OLDEST_ESR, which no longer have a branch. Used
// to map the version in which an element was added to the next ESR.
export const HISTORICAL_ESR_VERSIONS = [60, 68, 78, 91, 102];

export const COMM_SCHEMA_FOLDER = 'mail/components/extensions/schemas';

export const COMM_SCHEMA_FOLDERS = [
  { folderPath: COMM_SCHEMA_FOLDER },
  { folderPath: 'mail/components/extensions/annotations' },
];

export const COMM_URL_PLACEHOLDER_FILE =
  'mail/components/extensions/annotations/url-placeholders.json';

export const COMM_VERSION_FILE = 'mail/config/version_display.txt';

export const HELP_SCREEN = `

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
                                from hg.mozilla.org. Examples: "daily", "beta",
                                "esr" or "esr115". Either --release or --source
                                has to be specified.
   --source=path              - Path to a local checkout of a mozilla repository
                                with a matching /comm directory. Either --release
                                or --source has to be specified.
   --no-compat-data           - Skip generation of compatibility data (doc URLs,
                                version_added, BCD data).
   --no-link-check            - Skip validation of documentation URLs and always
                                add them to the schema files.
`;

export const LOCALE_FILES = [
  {
    branch: 'mozilla',
    filePath: 'toolkit/locales/en-US/toolkit/global/extensionPermissions.ftl',
  },
  {
    branch: 'comm',
    filePath: 'mail/locales/en-US/messenger/extensionPermissions.ftl',
  },
];

export const MOZILLA_SCHEMA_FOLDERS = [
  { folderPath: 'browser/components/extensions/schemas' },
  { folderPath: 'toolkit/components/extensions/schemas' },
];

// Extension registry files that map schema files to API namespaces.
export const REGISTRY_FILES = [
  {
    branch: 'mozilla',
    filePath: 'toolkit/components/extensions/ext-toolkit.json',
  },
  {
    branch: 'mozilla',
    filePath: 'browser/components/extensions/ext-browser.json',
  },
  {
    branch: 'comm',
    filePath: 'mail/components/extensions/ext-mail.json',
  },
];
