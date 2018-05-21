'use strict'

const { posix: path } = require('path')
const splitOnce = require('../util/split-once')

const { EXAMPLES_DIR_PROXY, PARTIALS_DIR_PROXY } = require('../constants')

/**
 * Resolves the specified include target to a virtual file in the content catalog.
 *
 * @memberof asciidoc-loader
 *
 * @param {String} target - The target of the include directive to resolve.
 * @param {File} file - The outermost virtual file from which the include originated (not
 *   necessarily the current file).
 * @param {Cursor} cursor - The cursor of the reader for file that contains the include directive.
 * @param {ContentCatalog} catalog - The content catalog that contains the virtual files in the site.
 * @returns {Object} A map containing the file, path, and contents of the resolved file.
 */
function resolveIncludeFile (target, file, cursor, catalog) {
  let [family, relative] = splitOnce(target, '/')
  if (family === PARTIALS_DIR_PROXY) {
    family = 'partial'
  } else if (family === EXAMPLES_DIR_PROXY) {
    family = 'example'
  } else {
    family = undefined
    relative = target
  }

  let resolvedIncludeFile
  if (family) {
    resolvedIncludeFile = catalog.getById({
      component: file.src.component,
      version: file.src.version,
      module: file.src.module,
      family,
      relative,
    })
  } else {
    // TODO can we keep track of the virtual file we're currently in instead of relying on cursor.dir?
    resolvedIncludeFile = catalog.getByPath({
      component: file.src.component,
      version: file.src.version,
      path: path.join(cursor.dir, relative),
    })
  }

  if (resolvedIncludeFile) {
    return {
      file: resolvedIncludeFile.src.path,
      path: resolvedIncludeFile.src.basename,
      // NOTE src.contents is set if a page is marked as a partial
      contents: (resolvedIncludeFile.src.contents || resolvedIncludeFile.contents).toString(),
    }
  } else {
    if (family) target = `{${family}sdir}/${relative}`
    // FIXME use replace next line instead of pushing an include; maybe raise error
    // TODO log "Unresolved include"
    return {
      file: cursor.file,
      contents: `+include::${target}[]+`,
    }
  }
}

module.exports = resolveIncludeFile
