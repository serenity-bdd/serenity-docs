'use strict'

const parsePageId = require('./parse-page-id')

/**
 * Attempts to resolve a contextual page ID spec to a file in the catalog.
 *
 * Parses the specified contextual page ID spec into a page ID object using parsePageId, then
 * attempts to locate a file with this page ID in the catalog. If a component is specified, but not
 * a version, the latest version of the component is used from the catalog. If a file cannot be
 * resolved, the function returns undefined. If the spec does not match the page ID syntax, this
 * function throws an error.
 *
 * @memberof content-classifier
 *
 * @param {String} spec - The contextual page ID spec (e.g.,
 *   version@component:module:topic/page followed by optional .adoc extension).
 * @param {ContentCatalog} catalog - The content catalog in which to resolve the page file.
 * @param {Object} [ctx={}] - The src context.
 *
 * @return {File} The virtual file to which the contextual page ID spec refers, or undefined if the
 * file cannot be resolved.
 */
function resolvePage (spec, catalog, ctx = {}) {
  const id = parsePageId(spec, ctx)

  if (!id) throw new Error('Invalid page ID syntax')

  if (!id.version) {
    const component = catalog.getComponent(id.component)
    if (!component) return
    id.version = component.latestVersion.version
  }

  return catalog.getById(id)
}

module.exports = resolvePage
