# 🏗️ webext-annotated-schemas-generator

A script to process Mozilla WebExtension API schema files. It retrieves them either from the git repositories of [Thunderbird](https://github.com/thunderbird/thunderbird-desktop) and [Firefox](https://github.com/mozilla-firefox/firefox) or from a local checkout. The script filters out schemas for APIs not supported by Thunderbird and adds annotations useful for downstream consumers:

```
     +--------------+        +-----+       +------------------+
     | tree/schemas |        | BCD |       | tree/annotations |
     +--------------+        +-----+       +------------------+
            |                   |                   |
            |                   |                   |
            +----------+        |        +----------+
                       |        |        |
                       v        v        v
                    +-----------------------+
                    |     webext-schemas    |
                    +-----------------------+
                      |      |      |      |
                      |      |      |      |
       +--------------+  +---+      +--+   +-----------+
       |                 |             |               |
       v                 v             v               v
+-------------+  +---------------+  +-----+  +-------------------+
| webext-docs |  | webext-linter |  | BCD |  | webext-typescript |
+-------------+  +---------------+  +-----+  +-------------------+
```

It processes the schema files as follows:

- Resolve and inline `$import` references.
- Remove entries incompatible with the specified manifest version.
- Replace URL placeholders like `$(url:key)[title]` in descriptions with proper `<a>` tags.
- Enrich annotations for Firefox schema files with data from the [browser-compat-data](https://github.com/mdn/browser-compat-data) repository.
- Merge Thunderbird-specific [annotations](https://searchfox.org/comm-central/source/mail/components/extensions/annotations/README.md).
- Add the `api_documentation_url` property to the annotations.
- Add the `version_added` property (Thunderbird compatibility data) to the annotations by comparing historical schema revisions to determine when each API element was first introduced.

For convenience, the Thunderbird team provides the processed output in the [webext-schemas](https://github.com/thunderbird/webext-annotated-schemas) repository.


## 📦 Installation

Before using the script, install the required Node.js packages:

```bash
npm install
```

## 🖥️ Usage

```bash
node get_thunderbird_schema_files.js [options]
```

### Options

| Option&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Description                                                                 |
|---------------------------------|-----------------------------------------------------------------------------|
| `--manifest_version` | Manifest version of the schema files. Allowed values: `2` or `3`.           |
| `--output`           | Path to a folder to store the processed schema files. Existing files in the folder will be deleted. |
| `--release`          | Thunderbird release to download the schema files for: `daily`, `beta`, `release`, `esr` (the newest ESR) or a specific ESR like `esr153`. The files are read from the latest commit of the matching branch. Either this or `--source` must be specified. |
| `--source`           | Path to a local checkout of a Mozilla repository (must include a `/comm` directory). Either this or `--release` must be specified. |
| `--no-compat-data`   | Skip generation of compatibility data (doc URLs, `version_added`, BCD data). |
| `--no-link-check`    | Skip validation of documentation URLs and always add them to the schema files. |

---

## 📄 Notes

The `version_added` compatibility data is generated from the history of the Thunderbird schema files. The script therefore keeps a blobless clone of the [Thunderbird repository](https://github.com/thunderbird/thunderbird-desktop) in the `git-cache/` folder (about 175 MB including a commit-graph which speeds up the history lookups, created in about 40 seconds on the first run). Later runs only fetch new commits. The folder can be deleted at any time, it is recreated as needed. The script requires `git`.

For ESR releases, the history of all ESRs up to the requested one is used, to report backports during an ESR cycle (e.g. `128.2.0`). ESRs before 115 have no branch in the git repository, their history is read from the tag of their last release (see `HISTORICAL_ESR_TAGS`).

From the [Firefox repository](https://github.com/mozilla-firefox/firefox) only the needed revision is fetched, without its history (about 20 MB per run, not cached).

---

## ⚖️ License

This project is licensed under the terms of the [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/).
