import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Based on the sources of the policy-templates generator:
// https://github.com/thunderbird/policy-templates/blob/main/generator/modules/sources.mjs

const execFileAsync = promisify(execFile);

/**
 * Read files and their history from a local bare git repository, using the
 * native git command. The repository is a partial clone: file contents are
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
    if (!(await source.#update(url))) {
      await source.#clone(url);
    }
    await source.#writeCommitGraph();
    return source;
  }

  /**
   * Update a valid clone of the given repository.
   *
   * @returns {Promise<boolean>} false if there is no valid clone or the update
   *    failed
   */
  async #update(url) {
    if (!(await this.#isCloneOf(url))) {
      return false;
    }
    try {
      console.log(` - updating the git cache in ${this.dir} ...`);
      await this.#git(['fetch', '--prune', '--no-tags', 'origin']);
      return true;
    } catch (ex) {
      console.warn(` !! Updating the git cache failed: ${ex.message}`);
      return false;
    }
  }

  async #clone(url) {
    console.log(` - cloning ${url} into ${this.dir} ...`);
    await fs.rm(this.dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(this.dir), { recursive: true });
    await execFileAsync('git', [
      'clone',
      '--bare',
      '--filter=blob:none',
      '--no-tags',
      url,
      this.dir,
    ]);
    // A bare clone has no fetch refspec, branches are updated in place.
    await this.#git([
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/heads/*',
    ]);
  }

  /**
   * Write the commit-graph with changed-path filters, which speeds up the file
   * histories (see getFileHistory()) considerably. An existing commit-graph is
   * reused, so updating it after a fetch is fast. Without it, the cache is
   * still valid, just slower.
   */
  async #writeCommitGraph() {
    try {
      await this.#git([
        'commit-graph',
        'write',
        '--reachable',
        '--changed-paths',
      ]);
    } catch (ex) {
      console.warn(` !! Writing the commit-graph failed: ${ex.message}`);
    }
  }

  /**
   * Fetch a single commit of the given repository into a new local repository,
   * without its history and without file contents or folders: they are fetched
   * when needed, see prefetchFiles(). Used for repositories where only a single
   * revision is needed, which are too large to be cloned.
   *
   * @param {string} url - URL of the remote repository.
   * @param {string} ref - A branch or tag, e.g. "main" or
   *    "FIREFOX_153_5_0esr_BUILD1".
   * @param {string} dir - Path of the local bare repository, which must not
   *    exist yet.
   *
   * @returns {Promise<{source: LocalGitSource, commit: string}>}
   */
  static async fetchRef(url, ref, dir) {
    console.log(` - fetching ${ref} of ${url} ...`);
    const source = new LocalGitSource(dir);
    await execFileAsync('git', ['init', '--quiet', '--bare', dir]);
    await source.#git(['remote', 'add', 'origin', url]);
    // Missing objects are fetched from origin on demand.
    await source.#git(['config', 'remote.origin.promisor', 'true']);
    await source.#git(['config', 'remote.origin.partialclonefilter', 'tree:0']);
    try {
      await source.#git([
        'fetch',
        '--quiet',
        '--depth=1',
        '--filter=tree:0',
        '--no-tags',
        'origin',
        ref,
      ]);
    } catch (ex) {
      throw new Error(`Fetching ${ref} of ${url} failed: ${ex.stderr || ex}`);
    }
    const commit = (
      await source.#git(['rev-parse', 'FETCH_HEAD^{commit}'])
    ).trim();
    return { source, commit };
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
    console.log(` - fetching ${ids.length} files into ${this.dir} ...`);
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
