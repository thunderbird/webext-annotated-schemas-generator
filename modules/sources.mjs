import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { GITHUB_API_URL, GITHUB_RAW_URL } from './constants.mjs';
import { request } from './tools.mjs';

// Based on the sources of the policy-templates generator:
// https://github.com/thunderbird/policy-templates/blob/main/generator/modules/sources.mjs

const execFileAsync = promisify(execFile);

/**
 * Read files and their history from a local bare git repository, using the
 * native git command. The repository is a blobless clone: file contents are
 * fetched when needed, see prefetchHistory() and prefetchFiles().
 */
export class LocalGitSource {
  #catFile = null;
  #readCache = new Map();

  /**
   * @param {string} dir - Path to the local bare git repository.
   */
  constructor(dir) {
    this.dir = dir;
    this.description = dir;
  }

  async #git(args, { input, env } = {}) {
    const promise = execFileAsync('git', [`--git-dir=${this.dir}`, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    if (input !== undefined) {
      promise.child.stdin.end(input);
    }
    return (await promise).stdout;
  }

  /**
   * Open the local clone of the given repository, which is used as a cache.
   * A valid clone is updated, anything else (missing, broken, cloned from a
   * different repository, update failed) is removed and cloned again.
   *
   * @param {string} url - URL of the remote repository.
   * @param {string} dir - Path of the local bare clone.
   *
   * @returns {Promise<LocalGitSource>}
   */
  static async open(url, dir) {
    const source = new LocalGitSource(dir);
    if (await source.#isCloneOf(url)) {
      try {
        console.log(` - updating the git cache in ${dir} ...`);
        await source.#git(['fetch', '--prune', '--no-tags', 'origin']);
        return source;
      } catch (ex) {
        console.warn(` !! Updating the git cache failed: ${ex.message}`);
      }
    }

    console.log(` - cloning ${url} into ${dir} ...`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await execFileAsync('git', [
      'clone',
      '--bare',
      '--filter=blob:none',
      '--no-tags',
      url,
      dir,
    ]);
    // A bare clone has no fetch refspec, branches are updated in place.
    await source.#git([
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/heads/*',
    ]);
    return source;
  }

  async #isCloneOf(url) {
    try {
      const isBare = await this.#git(['rev-parse', '--is-bare-repository']);
      const origin = await this.#git(['remote', 'get-url', 'origin']);
      return isBare.trim() === 'true' && origin.trim() === url;
    } catch {
      return false;
    }
  }

  /**
   * Get the names of all branches.
   *
   * @returns {Promise<string[]>}
   */
  async listBranches() {
    const refs = await this.#git([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
    ]);
    return refs.split('\n').filter(Boolean);
  }

  /**
   * Resolve a branch to a commit.
   *
   * @param {string} name - Name of the branch, e.g. "esr153".
   * @returns {Promise<string|null>} the commit, or null if the branch does not
   *    exist
   */
  async resolveBranch(name) {
    try {
      return (
        await this.#git([
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${name}^{commit}`,
        ])
      ).trim();
    } catch {
      return null;
    }
  }

  /**
   * Get the commits in the history of the given commit which modified the
   * given file, newest first. The full history is used: by default, git only
   * follows one parent of a merge, which hides changes which reached the branch
   * through the other parent (e.g. uplifts to beta merged into release).
   *
   * @param {string} commit
   * @param {string} filePath - Path of the file inside the repository.
   * @returns {Promise<string[]>}
   */
  async getFileHistory(commit, filePath) {
    const log = await this.#git([
      'rev-list',
      '--full-history',
      commit,
      '--',
      filePath,
    ]);
    return log.split('\n').filter(Boolean);
  }

  /**
   * Get the paths of all files inside a folder (including sub folders) at the
   * given commit.
   *
   * @param {string} commit
   * @param {string} folderPath - Path of the folder inside the repository.
   * @returns {Promise<string[]>}
   */
  async listFiles(commit, folderPath) {
    const files = await this.#git([
      'ls-tree',
      '-r',
      '--name-only',
      commit,
      '--',
      `${folderPath}/`,
    ]);
    return files.split('\n').filter(Boolean);
  }

  /**
   * Fetch all revisions of the given files in the full history of the given
   * commits, which are not yet available locally, with a single request.
   *
   * @param {string[]} commits
   * @param {string[]} paths - Paths of files or folders.
   */
  async prefetchHistory(commits, paths) {
    const objects = await this.#git([
      'rev-list',
      '--objects',
      '--missing=print',
      '--full-history',
      ...commits,
      '--',
      ...paths,
    ]);
    await this.#fetchObjects(
      objects
        .split('\n')
        .filter((line) => line.startsWith('?'))
        .map((line) => line.slice(1))
    );
  }

  /**
   * Fetch the given files at the given commit, which are not yet available
   * locally, with a single request.
   *
   * @param {string} commit
   * @param {string[]} paths - Paths of files or folders.
   */
  async prefetchFiles(commit, paths) {
    const tree = await this.#git(['ls-tree', '-r', commit, '--', ...paths]);
    const blobs = tree
      .split('\n')
      .map((line) => line.split(/\s/))
      .filter(([, type]) => type === 'blob')
      .map(([, , id]) => id);
    if (!blobs.length) {
      return;
    }
    const status = await this.#git(['cat-file', '--batch-check'], {
      input: `${blobs.join('\n')}\n`,
      env: { GIT_NO_LAZY_FETCH: '1' },
    });
    await this.#fetchObjects(
      status
        .split('\n')
        .filter((line) => line.endsWith(' missing'))
        .map((line) => line.split(' ')[0])
    );
  }

  async #fetchObjects(ids) {
    if (!ids.length) {
      return;
    }
    console.log(` - fetching ${ids.length} files into the git cache ...`);
    await this.#git(
      [
        '-c',
        'fetch.negotiationAlgorithm=noop',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        '--filter=blob:none',
        '--stdin',
        'origin',
      ],
      { input: `${ids.join('\n')}\n` }
    );
  }

  /**
   * Read a file at the given commit. Missing file contents are fetched on
   * demand, which is slow: use prefetchHistory() or prefetchFiles() first.
   *
   * @param {string} commit
   * @param {string} filePath - Path of the file inside the repository.
   * @returns {Promise<string|null>} content of the file, or null if it does
   *    not exist at the given commit
   */
  async readFile(commit, filePath) {
    const spec = `${commit}:${filePath}`;
    if (!this.#readCache.has(spec)) {
      if (!this.#catFile) {
        this.#catFile = new CatFileBatch(this.dir);
      }
      this.#readCache.set(spec, this.#catFile.read(spec));
    }
    return this.#readCache.get(spec);
  }

  /**
   * Stop the git process used by readFile().
   */
  close() {
    this.#catFile?.close();
    this.#catFile = null;
  }
}

/**
 * A long-running "git cat-file --batch" process, to read many files without
 * spawning a git process for each of them.
 */
class CatFileBatch {
  #process;
  #buffer = Buffer.alloc(0);
  #pending = [];

  constructor(dir) {
    this.#process = spawn('git', [`--git-dir=${dir}`, 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.#process.stdout.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#processBuffer();
    });
    this.#process.on('exit', (code) => {
      for (const { reject } of this.#pending.splice(0)) {
        reject(new Error(`git cat-file exited with code ${code}`));
      }
    });
  }

  /**
   * @param {string} spec - The object to read, e.g. "<commit>:<path>".
   * @returns {Promise<string|null>} content, or null if it does not exist
   */
  read(spec) {
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#process.stdin.write(`${spec}\n`);
    });
  }

  #processBuffer() {
    while (this.#pending.length) {
      const headerEnd = this.#buffer.indexOf(0x0a);
      if (headerEnd === -1) {
        return;
      }
      // The header is either "<id> <type> <size>" or "<spec> missing".
      const header = this.#buffer.subarray(0, headerEnd).toString();
      if (/ (missing|ambiguous)$/.test(header)) {
        this.#buffer = this.#buffer.subarray(headerEnd + 1);
        this.#pending.shift().resolve(null);
        continue;
      }
      const size = Number(header.split(' ').at(-1));
      // The content is followed by a newline.
      if (this.#buffer.length < headerEnd + 1 + size + 1) {
        return;
      }
      const content = this.#buffer
        .subarray(headerEnd + 1, headerEnd + 1 + size)
        .toString('utf-8');
      this.#buffer = this.#buffer.subarray(headerEnd + 1 + size + 1);
      this.#pending.shift().resolve(content);
    }
  }

  close() {
    this.#process.stdin.end();
  }
}

/**
 * Read single revisions of files from a GitHub repository. Commits and folder
 * listings are requested from the GitHub API, files are downloaded from
 * raw.githubusercontent.com. The file history is not available, as the GitHub
 * API does not support a full history (see LocalGitSource.getFileHistory()).
 */
export class GitHubSource {
  /**
   * @param {string} repository - The repository, e.g. "mozilla-firefox/firefox".
   */
  constructor(repository) {
    this.repository = repository;
    this.description = `https://github.com/${repository}`;
  }

  async #api(apiPath, accept = 'application/vnd.github+json') {
    const headers = { Accept: accept };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    return request(
      `${GITHUB_API_URL}/repos/${this.repository}${apiPath}`,
      headers
    );
  }

  /**
   * Resolve a branch or tag to a commit.
   *
   * @param {string} ref - e.g. "main" or "FIREFOX_153_5_0esr_BUILD1".
   * @returns {Promise<string|null>} the commit, or null if the ref does not
   *    exist
   */
  async resolveRef(ref) {
    try {
      const sha = await this.#api(
        `/commits/${encodeURIComponent(ref)}`,
        'application/vnd.github.sha'
      );
      return sha?.trim() ?? null;
    } catch (ex) {
      // An unknown ref is reported as "Unprocessable Entity".
      if (ex.status === 422) {
        return null;
      }
      throw ex;
    }
  }

  /**
   * Get the paths of the files inside a folder (not including sub folders) at
   * the given commit.
   *
   * @param {string} commit
   * @param {string} folderPath - Path of the folder inside the repository.
   * @returns {Promise<string[]>}
   */
  async listFiles(commit, folderPath) {
    const entries = JSON.parse(
      (await this.#api(`/contents/${folderPath}?ref=${commit}`)) ?? '[]'
    );
    return entries.filter((e) => e.type === 'file').map((e) => e.path);
  }

  /**
   * Read a file at the given commit.
   *
   * @param {string} commit
   * @param {string} filePath - Path of the file inside the repository.
   * @returns {Promise<string|null>} content of the file, or null if it does
   *    not exist at the given commit
   */
  async readFile(commit, filePath) {
    return request(
      `${GITHUB_RAW_URL}/${this.repository}/${commit}/${filePath}`
    );
  }
}
