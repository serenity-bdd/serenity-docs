'use strict'

// matches pattern version@component:module:topic/page w/ optional .adoc ext
// ex. 1.0@antora:playbook:ui/bundle.adoc
const PAGE_ID_RX = /^(?:([^@]+)@)?(?:(?:([^:]+):)?(?:([^:]+))?:)?([^:]+?)(?:\.adoc)?$/
const PAGE_ID_RXG = { version: 1, component: 2, module: 3, page: 4 }

/**
 * Parses a contextual page ID string into a file src object.
 *
 * Parses the specified page ID spec to create a page ID object (the essence of what the src
 * property of a virtual file contains). If a context object is provided, it will be used to qualify
 * the reference, populating the component, version, and/or module properties, if missing.
 *
 * * If a component is specified, but not a version, the version remains undefined.
 * * If a component is specified, but not a module, the module defaults to ROOT.
 *
 * @memberof content-classifier
 *
 * @param {String} spec - The contextual page ID spec (e.g.,
 *   version@component:module:topic/page followed by optional .adoc extension).
 * @param {Object} [ctx={}] - The src context.
 *
 * @returns {Object} A page ID object that can be used to look up the file in the content catalog.
 * If the spec is malformed, this function returns undefined.
 */
function parsePageId (spec, ctx = {}) {
  const match = spec.match(PAGE_ID_RX)
  if (!match) return

  let version = match[PAGE_ID_RXG.version]
  let component = match[PAGE_ID_RXG.component]
  let module = match[PAGE_ID_RXG.module]
  let relative = match[PAGE_ID_RXG.page] + '.adoc'
  const family = 'page'

  if (component) {
    if (!module) module = 'ROOT'
  } else {
    component = ctx.component
    if (!version) version = ctx.version
    if (!module) module = ctx.module
  }

  return { component, version, module, family, relative }
}

module.exports = parsePageId
