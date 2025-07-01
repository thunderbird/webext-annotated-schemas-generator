export const API_DOC_BASE_URL = 'https://webextension-api.thunderbird.net/en';

export const BUILD_HUB_URL = 'https://buildhub.moz.tools';

export const COMM_GECKO_REV = '.gecko_rev.yml';

export const COMM_SCHEMA_FOLDERS = [
  {
    folderPath: 'mail/components/extensions/schemas',
    zipFileNameSuffix: 'mail',
  },
  {
    folderPath: 'mail/components/extensions/annotations',
    zipFileNameSuffix: 'mail-annotations',
  },
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
                                from hg.mozilla.org. Examples: "central", "beta",
                                "esr" or "esr115". Either --release or --source
                                has to be specified.
   --source=path              - Path to a local checkout of a mozilla repository
                                with a matching /comm directory. Either --release
                                or --source has to be specified.
`;

export const HG_URL = 'https://hg-edge.mozilla.org';

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
  {
    folderPath: 'browser/components/extensions/schemas',
    zipFileNameSuffix: 'browser',
  },
  {
    folderPath: 'toolkit/components/extensions/schemas',
    zipFileNameSuffix: 'toolkit',
  },
];
