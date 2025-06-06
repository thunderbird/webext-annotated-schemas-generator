Overview
========

This script processes Mozilla WebExtension API schema files by retrieving them either
from  [`hg.mozilla.org`](https://hg.mozilla.org) or from a local checkout of the Mozilla
Mercurial code repository.

Schemas for APIs not supported by Thunderbird are excluded. The remaining schema files
are then processed as follows:

- `$import` keys are resolved by inlining the referenced entities.  
- Entries not compatible with the requested manifest version are removed.  
- URL placeholders in the form `$(url:key)[title]` within descriptions are replaced with
  proper `<a>` tags.  
- Firefox schema files are enriched using [browser-compat-data](https://github.com/mdn/browser-compat-data).  
- Thunderbird schema files are augmented with the `api_documentation_url` property.  
- Thunderbird annotation files are merged into the final schema output.

For convenience, the Thunderbird team provides the processed output in the  
[webext-schemas](https://github.com/thunderbird/webext-schemas) repository.


Install needed packages
=======================

```
npm install
```

Usage
=====

```
   node get_thunderbird_schema_files.js <options>
```
  
Options
=======

```
   --manifest_version=number  - The requested manifest version of the schema
                                files. Allowed values are "2" and "3".
   --output=path              - Path of a folder to store the processed schema
                                files. All existing files in that folder will be
                                deleted.
   --release=name             - The name of the Thunderbird release to get the
                                schema files for. The files will be downloaded
                                from hg.mozilla.org. Examples: "central", "beta"
                                or "esr115". Either --release or --source has to
                                be specified.
   --source=path              - Path to a local checkout of a mozilla repository
                                with a matching /comm directory. Either --release
                                or --source has to be specified.
```
