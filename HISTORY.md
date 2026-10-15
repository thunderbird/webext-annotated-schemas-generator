# How the history of the schema files is read

The `version_added` of a Thunderbird API element is the lowest version of a
revision of its schema file which includes it. This needs the **complete**
history of the schema files on the processed branch. This document explains
why plain `git log` is not enough, how the history is read instead, and how
this relates to the [policy-templates](https://github.com/thunderbird/policy-templates)
generator, which solves the same problem for the policy schema.

## The problem: merge-day merges hide uplifts

A change lands on `main` (Daily) and rides the train to `beta` and `release`.
It may also be uplifted to the beta or release line of an older version. On
merge day, the lines are joined by merges which take their whole content from
the newer line: "Merge main into beta", "Promote beta to release", and, from
the conversion of the mercurial history, "Merge old head via hg
debugsetparents". The older line is attached as second parent, it contributes
nothing to the content.

`git log <branch> -- <file>` (and the GitHub API) follows only one parent at a
merge whose content equals that parent: the newer line. The older line, with
its uplifts and dot releases, is never visited.

Example from Thunderbird's policy schema: `BackgroundAppUpdate` landed on
`main` as `8781847a5fa` (92.0a1) and was uplifted to the 91 line as
`a70c5571935` (91.0). The merge `649deed33b8` joined the 91 line into the 92
line. Plain `git log release -- policies-schema.json` only finds `8781847a5fa`,
so the policy would be reported as new in 92, although it shipped in 91.0.

## The concept: side parents and the union of plain histories

The lines merged in this way are not part of `main`. Their heads are the
parents (besides the first) of the merges on the branch which are not part of
`main`: the **side parents** (`getSideParents()` in
[modules/commit_graph.mjs](modules/commit_graph.mjs)). The complete history of
a file is the **union of the plain histories** from the branch and from each
side parent. Merges whose content equals one of their parents are not needed:
they add no content of their own and never have a lower version.

For ESR releases, the history of all ESRs up to the processed one is used, to
find the backports during each ESR cycle (e.g. `128.2.0`). ESRs 60 to 102 have
no branch in the git repository, they are read from the tag of their last
release (`HISTORICAL_ESR_TAGS` in [modules/constants.mjs](modules/constants.mjs)).

## Shared with policy-templates, and where it differs

Both generators use the same concept, and both have a `getSideParents()` with
the same logic. They differ in where the commit graph and the plain histories
come from:

|                     | this generator                                                                                        | policy-templates                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| History needed of   | ~27 Thunderbird schema files                                                                          | one policy schema per product (Thunderbird and Firefox)                         |
| Local clone         | **blobless** clone of thunderbird-desktop: commits and folders, files on demand                       | **treeless** clone per product: commits only                                    |
| Side parents        | local commit graph                                                                                    | local commit graph                                                              |
| Plain histories     | local `git rev-list <branch and side parents> -- <file>`                                              | GitHub API, one request per starting point, cached                              |
| File contents       | from the clone, fetched in one request                                                                | downloads from raw.githubusercontent.com, cached                                |
| GitHub API requests | none                                                                                                  | ~120 (Thunderbird) and ~600 (Firefox) on a cold cache, a few per run after that |
| Firefox             | a single revision (a shallow fetch per run); Firefox's `version_added` comes from browser-compat-data | the history of the policy schema                                                |

## Blobless or treeless: the trade-off

- **Blobless** (commits and folders local, files on demand): the plain
  histories and the files are local, no API requests are needed. But the clone
  grows with the folders of the whole repository: about 175 MB for
  thunderbird-desktop (including the commit-graph which speeds up the
  history queries), but several GB for mozilla-firefox, which would explode
  the cache.
- **Treeless** (commits only) plus the GitHub API: the clones stay small
  (thunderbird-desktop about 55 MB, mozilla-firefox about 380 MB), but every
  plain history is an API request (about 2.5 s each for mozilla-firefox), and
  file contents are downloads. That is fine for one file. For the schema
  files of this generator it would explode the requests: about 27 files times
  about 110 starting points, ~3000 requests plus ~1500 downloads on a cold
  cache.

So the choice follows from which repository's history is needed, and for how
many files: this generator reads many files of the small repository
(blobless), policy-templates reads one file of each repository, including the
large one (treeless).

**This generator needs no history of Firefox only because the `version_added`
of Firefox APIs comes from browser-compat-data (BCD).** If BCD were ever
dropped, the history of Firefox's schema files would be needed. Then Firefox
must be read like policy-templates does (treeless clone plus GitHub API),
because a blobless clone of Firefox would explode the cache, and the many API
requests on a cold cache have to be accepted.

## Versions of the revisions

The version of a revision is read from `mail/config/version_display.txt` at
that revision. For ESR releases, a version of an ESR (e.g. `128.2.0esr`) is
reported without suffix, other versions as the next ESR including them
(`getReportedVersion()` in [modules/process.mjs](modules/process.mjs)).
policy-templates reads the version file the same way, but presents the
versions differently (`normalizeVersion()` and `addSupportedSince()` in its
`generator/modules/compatibility.mjs`).

## Robustness

Revisions which removed a schema file, or whose schema can't be parsed, are
skipped (with a warning for the latter): they were never a valid schema. In
Firefox, an uplift of 2018 (`d2c220e4f6ad`) was committed with conflict
markers in the policy schema and fixed later; the complete history reaches
such revisions, plain `git log` did not.

## Verification

- For all 27 schema files and the branches `esr153` (including the old ESR
  tags), `release`, `beta` and `main`, the side-parent mechanism returns the
  same changes as `git rev-list --full-history` (which needs all folders
  locally, so it is not an option for policy-templates), without the ~550
  merges per branch whose content equals a parent.
- The ESR output matches the last files generated from mercurial, except the
  `commands` API (102.0 before, now 68.0: it is registered in `ext-mail.json`
  since Thunderbird 68).
- To check a file, compare
  `git rev-list --no-merges --full-history <refs> -- <file>` with the history
  returned by `LocalGitSource.getFileHistory()` on the git cache.
