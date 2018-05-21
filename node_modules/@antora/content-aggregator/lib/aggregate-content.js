'use strict'

const _ = require('lodash')
const { createHash } = require('crypto')
const expandPath = require('@antora/expand-path-helper')
const File = require('./file')
const fs = require('fs-extra')
const getCacheDir = require('cache-directory')
const git = require('nodegit')
const GIT_TYPE_OID = git.Reference.TYPE.OID
const GIT_TYPE_COMMIT = git.Object.TYPE.COMMIT
const { obj: map } = require('through2')
const matcher = require('matcher')
const mimeTypes = require('./mime-types-with-asciidoc')
const MultiProgress = require('multi-progress')
const ospath = require('path')
const { posix: path } = ospath
const posixify = ospath.sep === '\\' ? (p) => p.replace(/\\/g, '/') : undefined
const { URL } = require('url')
const vfs = require('vinyl-fs')
const yaml = require('js-yaml')

const { COMPONENT_DESC_FILENAME, CONTENT_CACHE_FOLDER, CONTENT_GLOB } = require('./constants')
const ANY_SEPARATOR_RX = /[:/]/
const CSV_RX = /\s*,\s*/
const DOT_OR_NOEXT_RX = /(?:^|\/)(?:\.|[^/.]+$)/
const GIT_URI_DETECTOR_RX = /:(?:\/\/|[^/\\])/
const HOSTED_GIT_REPO_RX = /(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?$/
const NON_UNIQUE_URI_SUFFIX_RX = /(?:\/?\.git|\/)$/
const PERIPHERAL_SEPARATOR_RX = /^\/+|\/+$/g
const URL_AUTH_CLEANER_RX = /^(https?:\/\/)(?:[^/@]+@)?(.*)/

/**
 * Aggregates files from the specified content sources so they can
 * be loaded into a virtual file catalog.
 *
 * Currently assumes each source points to a local or remote git repository.
 * Clones the repository, if necessary, then walks the git tree (or worktree)
 * of the specified branches and tags. Creates a virtual file containing the
 * source location and contents for each file matched. The files are then
 * organized by component version.
 *
 * @memberof content-aggregator
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Object} playbook.dir - The working directory of the playbook.
 * @param {Object} playbook.runtime - The runtime configuration object for Antora.
 * @param {String} [playbook.runtime.cacheDir=undefined] - The base cache directory.
 * @param {Array} playbook.content - An array of content sources.
 *
 * @returns {Object} A map of files organized by component version.
 */
async function aggregateContent (playbook) {
  const startDir = playbook.dir || '.'
  const { branches: defaultBranches, tags: defaultTags, sources } = playbook.content
  const { cacheDir, pull, silent, quiet } = playbook.runtime
  const progress = {}
  const term = process.stdout
  if (!(quiet || silent) && term.isTTY && term.columns >= 60) {
    //term.write('Aggregating content...\n')
    // QUESTION should we use MultiProgress directly as our progress object?
    progress.manager = new MultiProgress(term)
    progress.maxLabelWidth = Math.min(
      Math.ceil((term.columns - 8) / 2),
      sources.reduce(
        (max, { url }) => Math.max(max, ~url.indexOf(':') && GIT_URI_DETECTOR_RX.test(url) ? url.length : 0),
        0
      )
    )
  }
  const actualCacheDir = await ensureCacheDir(cacheDir, startDir)
  return Promise.all(
    _.map(_.groupBy(sources, 'url'), (sources, url) =>
      loadRepository(url, { pull, startDir, cacheDir: actualCacheDir, progress }).then(({ repo, repoPath, isRemote }) =>
        Promise.all(
          sources.map((source) => {
            const refPatterns = { branches: source.branches || defaultBranches, tags: source.tags || defaultTags }
            // NOTE if repository is in cache, we can assume the remote name is origin
            const remoteName = isRemote ? 'origin' : source.remote || 'origin'
            return collectComponentVersions(source, repo, repoPath, isRemote, remoteName, refPatterns)
          })
        )
          .then((componentVersions) => {
            repo.free()
            return componentVersions
          })
          .catch((err) => {
            repo.free()
            throw err
          })
      )
    )
  )
    .then((allComponentVersions) => buildAggregate(allComponentVersions))
    .catch((err) => {
      progress.manager && progress.manager.terminate()
      throw err
    })
}

function buildAggregate (componentVersions) {
  return _(componentVersions)
    .flattenDepth(2)
    .groupBy(({ name, version }) => `${version}@${name}`)
    .map((componentVersions, id) => {
      const component = _(componentVersions)
        .map((a) => _.omit(a, 'files'))
        .reduce((a, b) => _.assign(a, b), {})
      component.files = _(componentVersions)
        .map('files')
        .reduce((a, b) => [...a, ...b], [])
      return component
    })
    .sortBy(['name', 'version'])
    .value()
}

async function loadRepository (url, opts) {
  let isBare
  let isRemote
  let repo
  let repoPath

  if (~url.indexOf(':') && GIT_URI_DETECTOR_RX.test(url)) {
    isBare = isRemote = true
    repoPath = ospath.join(opts.cacheDir, generateCloneFolderName(url))
  } else if (isLocalDirectory((repoPath = expandPath(url, '~+', opts.startDir)))) {
    isBare = !isLocalDirectory(ospath.join(repoPath, '.git'))
    isRemote = false
  } else {
    throw new Error(
      `Local content source does not exist: ${repoPath}${url !== repoPath ? ' (resolved from url: ' + url + ')' : ''}`
    )
  }

  try {
    if (isBare) {
      repo = await git.Repository.openBare(repoPath)
      if (isRemote && opts.pull) {
        const progress = opts.progress
        const fetchOpts = getFetchOptions(progress, url, 'fetch')
        // fetch new refs and delete obsolete local ones
        await repo.fetch('origin', Object.assign({ prune: 1 }, fetchOpts))
        if (progress.manager) completeProgress(fetchOpts.callbacks.transferProgress.progressBar)
      }
    } else {
      repo = await git.Repository.open(repoPath)
    }
  } catch (e) {
    if (isRemote) {
      const progress = opts.progress
      const fetchOpts = getFetchOptions(progress, url, 'clone')
      repo = await fs
        .remove(repoPath)
        .then(() => git.Clone.clone(url, repoPath, { bare: 1, fetchOpts }))
        .catch((err) => {
          let msg = err.message
          if (~msg.indexOf('invalid cred') || ~msg.indexOf('SSH credentials') || ~msg.indexOf('status code: 401')) {
            msg = 'Content repository not found or you have insufficient credentials to access it'
          } else if (~msg.indexOf('no auth sock variable') || ~msg.indexOf('failed connecting agent')) {
            msg = 'SSH agent must be running to access content repository via SSH'
          } else if (/not found|not be found|not exist|404/.test(msg)) {
            msg = 'Content repository not found'
          } else {
            msg = msg.replace(/\.?\s*$/, '')
          }
          throw new Error(msg + ': ' + url)
        })
        .then((repo) =>
          repo.getCurrentBranch().then((ref) => {
            // NOTE we have a test that will catch if nodegit changes to match behavior of native git client
            repo.detachHead()
            ref.delete()
            if (progress.manager) completeProgress(fetchOpts.callbacks.transferProgress.progressBar)
            return repo
          })
        )
    } else {
      throw new Error(
        `Local content source must be a git repository: ${repoPath}${
          url !== repoPath ? ' (resolved from url: ' + url + ')' : ''
        }`
      )
    }
  }
  // NOTE return the computed repoPath since Repository API doesn't return same value
  return { repo, repoPath, isRemote }
}

async function collectComponentVersions (source, repo, repoPath, isRemote, remoteName, refPatterns) {
  return selectReferences(repo, remoteName, refPatterns).then((refs) =>
    Promise.all(refs.map((ref) => populateComponentVersion(source, repo, repoPath, isRemote, remoteName, ref)))
  )
}

async function selectReferences (repo, remote, refPatterns) {
  let { branches: branchPatterns, tags: tagPatterns } = refPatterns
  let isBare = !!repo.isBare()
  if (branchPatterns) {
    if (branchPatterns === 'HEAD' || branchPatterns === '.') {
      branchPatterns = [(await repo.getCurrentBranch()).shorthand()]
    } else if (Array.isArray(branchPatterns)) {
      if (branchPatterns.length) {
        let currentBranchIdx
        if (~(currentBranchIdx = branchPatterns.indexOf('HEAD')) || ~(currentBranchIdx = branchPatterns.indexOf('.'))) {
          branchPatterns[currentBranchIdx] = (await repo.getCurrentBranch()).shorthand()
        }
      } else {
        branchPatterns = undefined
      }
    } else {
      branchPatterns = branchPatterns.split(CSV_RX)
    }
  }

  if (tagPatterns && !Array.isArray(tagPatterns)) tagPatterns = tagPatterns.split(CSV_RX)

  return Array.from(
    (await repo.getReferences(GIT_TYPE_OID))
      .reduce((accum, ref) => {
        let segments
        let name
        let refData
        if (ref.isTag()) {
          if (tagPatterns && matcher([(name = ref.shorthand())], tagPatterns).length) {
            // NOTE tags are stored using symbol keys to distinguish them from branches
            accum.set(Symbol(name), { obj: ref, name, type: 'tag' })
          }
          return accum
        } else if (!branchPatterns) {
          return accum
        } else if ((segments = ref.name().split('/'))[1] === 'heads') {
          name = ref.shorthand()
          refData = { obj: ref, name, type: 'branch', isHead: !!ref.isHead() }
        } else if (segments[1] === 'remotes' && segments[2] === remote) {
          name = segments.slice(3).join('/')
          refData = { obj: ref, name, type: 'branch', remote }
        } else {
          return accum
        }

        // NOTE if branch is present in accum, we already know it matches the pattern
        if (accum.has(name)) {
          if (isBare === !!refData.remote) accum.set(name, refData)
        } else if (branchPatterns && matcher([name], branchPatterns).length) {
          accum.set(name, refData)
        }

        return accum
      }, new Map())
      .values()
  )
}

async function populateComponentVersion (source, repo, repoPath, isRemote, remoteName, ref) {
  let startPath = source.startPath || ''
  if (startPath && ~startPath.indexOf('/')) startPath = startPath.replace(PERIPHERAL_SEPARATOR_RX, '')
  // Q: should worktreePath be passed in?
  const worktreePath = ref.isHead && !(isRemote || repo.isBare()) ? ospath.join(repoPath, startPath) : undefined
  const files = worktreePath
    ? await readFilesFromWorktree(worktreePath)
    : await readFilesFromGitTree(repo, ref.obj, startPath)
  const componentVersion = loadComponentDescriptor(files, source.url)
  const url = isRemote ? source.url : await resolveRepoUrl(repo, repoPath, remoteName)
  const origin = computeOrigin(url, ref.name, ref.type, startPath, worktreePath)
  componentVersion.files = files.map((file) => assignFileProperties(file, origin))
  return componentVersion
}

function readFilesFromWorktree (base) {
  return new Promise((resolve, reject) => {
    const opts = { base, cwd: base, removeBOM: false }
    vfs
      .src(CONTENT_GLOB, opts)
      .on('error', reject)
      .pipe(relativizeFiles())
      .pipe(collectFiles(resolve))
  })
}

/**
 * Transforms the path of every file in the stream to a relative posix path.
 *
 * Applies a mapping function to all files in the stream so they end up with a
 * posixified path relative to the file's base instead of the filesystem root.
 * This mapper also filters out any directories (indicated by file.isNull())
 * that got caught up in the glob.
 */
function relativizeFiles () {
  return map((file, enc, next) => {
    if (file.isNull()) {
      next()
    } else {
      next(
        null,
        new File({
          path: posixify ? posixify(file.relative) : file.relative,
          contents: file.contents,
          stat: file.stat,
          src: { abspath: file.path },
        })
      )
    }
  })
}

function collectFiles (done) {
  const accum = []
  return map((file, enc, next) => accum.push(file) && next(), () => done(accum))
}

async function readFilesFromGitTree (repository, ref, startPath) {
  return srcGitTree(await getGitTree(repository, ref, startPath))
}

async function getGitTree (repository, ref, startPath) {
  let commit
  if (ref.isTag()) {
    commit = await ref.peel(GIT_TYPE_COMMIT).then((target) => repository.getCommit(target))
  } else {
    commit = await repository.getBranchCommit(ref)
  }
  if (startPath) {
    const tree = await commit.getTree()
    const subTreeEntry = await tree.getEntry(startPath)
    return repository.getTree(subTreeEntry.id())
  } else {
    return commit.getTree()
  }
}

function srcGitTree (tree) {
  return new Promise((resolve, reject) => {
    const files = []
    // NOTE walk only visits blobs (i.e., files)
    tree
      .walk()
      .on('entry', (entry) => {
        // NOTE ignore dotfiles and extensionless files; convert remaining entries to File objects
        // NOTE since nodegit 0.21.2, tree walker always returns posix paths
        if (!DOT_OR_NOEXT_RX.test(entry.path())) files.push(entryToFile(entry))
      })
      .on('error', reject)
      .on('end', () => resolve(Promise.all(files)))
      .start()
  })
}

async function entryToFile (entry) {
  const blob = await entry.getBlob()
  const contents = blob.content()
  const stat = new fs.Stats()
  stat.mode = entry.filemode()
  stat.size = contents.length
  // NOTE since nodegit 0.21.2, tree walker always returns posix paths
  return new File({ path: entry.path(), contents, stat })
}

function loadComponentDescriptor (files, repoUrl) {
  const descriptorFileIdx = files.findIndex((file) => file.path === COMPONENT_DESC_FILENAME)
  if (descriptorFileIdx < 0) throw new Error(COMPONENT_DESC_FILENAME + ' not found in ' + repoUrl)

  const descriptorFile = files[descriptorFileIdx]
  files.splice(descriptorFileIdx, 1)
  const data = yaml.safeLoad(descriptorFile.contents.toString())
  if (data.name == null) {
    throw new Error(COMPONENT_DESC_FILENAME + ' is missing a name in ' + repoUrl)
  } else if (data.version == null) {
    throw new Error(COMPONENT_DESC_FILENAME + ' is missing a version in ' + repoUrl)
  }
  data.version = data.version.toString()

  return data
}

function computeOrigin (url, refName, refType, startPath, worktreePath = undefined) {
  let match
  const origin = { type: 'git', url, startPath }
  origin[refType] = refName
  if (worktreePath) {
    origin.editUrlPattern = 'file://' + (posixify ? '/' + posixify(worktreePath) : worktreePath) + '/%s'
    // Q: should we set worktreePath instead (or additionally?)
    origin.worktree = true
  } else if ((match = url.match(HOSTED_GIT_REPO_RX))) {
    const action = match[1] === 'bitbucket.org' ? 'src' : refType === 'branch' ? 'edit' : 'blob'
    origin.editUrlPattern = 'https://' + path.join(match[1], match[2], action, refName, startPath, '%s')
  }
  return origin
}

function assignFileProperties (file, origin) {
  const extname = file.extname
  file.mediaType = mimeTypes.lookup(extname)
  if (!file.src) file.src = {}
  Object.assign(file.src, {
    path: file.path,
    basename: file.basename,
    stem: file.stem,
    extname,
    mediaType: file.mediaType,
    origin,
  })
  if (origin.editUrlPattern) file.src.editUrl = origin.editUrlPattern.replace('%s', file.src.path)
  return file
}

// QUESTION should we create dedicate (mutable) instance of progress and set progress.label?
function getFetchOptions (progress, uri, operation) {
  let authAttempted
  let isUrl
  let urlAuth
  let progressLabel = uri
  if ((isUrl = uri.startsWith('https://') || uri.startsWith('http://')) && uri.includes('@')) {
    try {
      urlAuth = new URL(uri)
      progressLabel = uri.replace(URL_AUTH_CLEANER_RX, '$1$2')
    } catch (e) {}
  }
  return {
    callbacks: {
      // https://github.com/nodegit/nodegit/blob/master/guides/cloning/ssh-with-agent/README.md#github-certificate-issue-in-os-x
      certificateCheck: () => 1,
      // NOTE nodegit will continue to make attempts until git.Cred.defaultNew() or undefined is returned
      credentials: (_, username) => {
        if (authAttempted) return process.platform === 'win32' ? undefined : git.Cred.defaultNew()
        authAttempted = true
        if (isUrl) {
          return urlAuth ? git.Cred.userpassPlaintextNew(urlAuth.username, urlAuth.password) : git.Cred.usernameNew('')
        } else {
          // NOTE sshKeyFromAgent gracefully handles SSH agent not running
          return git.Cred.sshKeyFromAgent(username)
        }
      },
      transferProgress: progress.manager ? createTransferProgress(progress, progressLabel, operation) : undefined,
    },
  }
}

function createTransferProgress (progress, progressLabel, operation) {
  const progressBar = progress.manager.newBar(formatProgressBar(progressLabel, progress.maxLabelWidth, operation), {
    total: Infinity,
    complete: '#',
    incomplete: '-',
  })
  progressBar.tick(0)
  const callback = async (transferStatus) => {
    let growth = transferStatus.receivedObjects() + transferStatus.indexedObjects()
    if (progressBar.total === Infinity) {
      progressBar.total = transferStatus.totalObjects() * 2
    } else {
      growth -= progressBar.curr
    }
    if (growth) progressBar.tick(growth)
  }
  return { callback, progressBar, waitForResult: false }
}

function formatProgressBar (label, maxLabelWidth, operation) {
  const paddingSize = maxLabelWidth - label.length
  let padding = ''
  if (paddingSize < 0) {
    label = '...' + label.substr(-paddingSize + 3)
  } else if (paddingSize) {
    padding = ' '.repeat(paddingSize)
  }
  // NOTE assume operation has a fixed length
  return `[${operation}] ${label}${padding} [:bar]`
}

function completeProgress (progressBar) {
  if (progressBar.total === Infinity) progressBar.total = 100
  const remaining = progressBar.total - progressBar.curr
  if (remaining) progressBar.tick(remaining)
}

/**
 * Generates a safe, unique folder name for a git URL.
 *
 * The purpose of this function is generate a safe, unique folder name to use for the cloned
 * repository that gets stored in the cache.
 *
 * The generated folder name follows the pattern <basename>-<sha1>.git.
 *
 * @param {String} url - The repository URL to convert.
 * @returns {String} A safe, unique folder name.
 */
function generateCloneFolderName (url) {
  let normalizedUrl = url.toLowerCase()
  if (posixify) normalizedUrl = posixify(normalizedUrl)
  normalizedUrl = normalizedUrl.replace(NON_UNIQUE_URI_SUFFIX_RX, '')
  const basename = normalizedUrl.split(ANY_SEPARATOR_RX).pop()
  const sha1hash = createHash('sha1')
  sha1hash.update(normalizedUrl)
  const sha1 = sha1hash.digest('hex')
  return `${basename}-${sha1}.git`
}

/**
 * Resolve the URL of the specified remote for the given repository.
 *
 * @param {Repository} repo - The repository on which to operate.
 * @param {String} repoPath - The local filesystem path of the repository clone.
 * @param {String} remoteName - The name of the remote to resolve.
 * @returns {String} The URL of the specified remote, or the repository path if the
 * remote does not exist.
 */
async function resolveRepoUrl (repo, repoPath, remoteName) {
  return (
    repo
      .getRemote(remoteName)
      .then((remote) => remote.url())
      // Q: should we turn this into a file URI?
      .catch(() => repoPath)
  )
}

/**
 * Checks whether the specified URL matches a directory on the local filesystem.
 *
 * @param {String} url - The URL to check.
 * @return {Boolean} A flag indicating whether the URL matches a directory on the local filesystem.
 */
function isLocalDirectory (url) {
  try {
    return fs.statSync(url).isDirectory()
  } catch (e) {
    return false
  }
}

/**
 * Expands the content cache directory path and ensures it exists.
 *
 * @param {String} preferredCacheDir - The preferred cache directory. If the value is undefined,
 *   the user's cache folder is used.
 * @param {String} startDir - The directory to use in place of a leading '.' segment.
 *
 * @returns {Promise<String>} A promise that resolves to the absolute content cache directory.
 */
function ensureCacheDir (preferredCacheDir, startDir) {
  // QUESTION should fallback directory be relative to cwd, playbook dir, or tmpdir?
  const baseCacheDir =
    preferredCacheDir == null
      ? getCacheDir('antora' + (process.env.NODE_ENV === 'test' ? '-test' : '')) || ospath.resolve('.antora/cache')
      : expandPath(preferredCacheDir, '~+', startDir)
  const cacheDir = ospath.join(baseCacheDir, CONTENT_CACHE_FOLDER)
  return fs.ensureDir(cacheDir).then(() => cacheDir)
}

module.exports = aggregateContent
module.exports._computeOrigin = computeOrigin
