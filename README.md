# 🏗️ webext-schemas-generator

A script to process Mozilla WebExtension API schema files. It retrieves them either from [`hg.mozilla.org`](https://hg.mozilla.org) or from a local checkout of the Mozilla Mercurial repository. The script filters out schemas for APIs not supported by Thunderbird and adds annotations useful for downstream consumers:

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

For convenience, the Thunderbird team provides the processed output in the [webext-schemas](https://github.com/thunderbird/webext-schemas) repository.


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
| `--release`          | Thunderbird release name to download schema files from `hg.mozilla.org` (e.g., `central`, `beta`, `esr`, or `esr115`). Either this or `--source` must be specified. |
| `--source`           | Path to a local checkout of a Mozilla repository (must include a `/comm` directory). Either this or `--release` must be specified. |

---

## 📄 Notes

The script downloads older revisions of schema files and caches them in a `persistent_schema_cache.json` file.  
To avoid a large initial download, you can download a pre-generated cache file from the release page:

[Download prebuilt cache](https://github.com/thunderbird/webext-schemas-generator/releases/tag/v1.0.0)

---

## ⚖️ License

This project is licensed under the terms of the [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/).
