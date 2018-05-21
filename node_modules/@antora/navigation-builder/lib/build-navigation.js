'use strict'

const loadAsciiDoc = require('@antora/asciidoc-loader')
const NavigationCatalog = require('./navigation-catalog')

const LINK_RX = /<a href="([^"]+)"(?: class="([^"]+)")?>(.+?)<\/a>/

/**
 * Builds a {NavigationCatalog} from files in the navigation family that are
 * stored in the content catalog.
 *
 * Queries the content catalog for files in the navigation family. Then uses
 * the AsciiDoc Loader component to parse the source of each file into an
 * Asciidoctor Document object. It then looks in each file for one or more nested
 * unordered lists, which are used to build the navigation trees. It then
 * combines those trees in sorted order as a navigation menu, which gets
 * stored in the navigation catalog by component/version pair.
 *
 * @memberof navigation-builder
 *
 * @param {ContentCatalog} [contentCatalog=undefined] - The content catalog
 *   that provides access to the virtual files in the site.
 * @param {Object} [asciidocConfig={}] - AsciiDoc processor configuration options. Extensions are not propagated.
 *   Sets the relativizePageRefs option to false before passing to the loadAsciiDoc function.
 * @param {Object} [asciidocConfig.attributes={}] - Shared AsciiDoc attributes to assign to the document.
 *
 * @returns {NavigationCatalog} A navigation catalog built from the navigation files in the content catalog.
 */
function buildNavigation (contentCatalog, asciidocConfig = {}) {
  const navFiles = contentCatalog.findBy({ family: 'navigation' })
  if (!(navFiles && navFiles.length)) return new NavigationCatalog()
  asciidocConfig = Object.assign({}, asciidocConfig, { relativizePageRefs: false })
  delete asciidocConfig.extensions
  return navFiles
    .map((navFile) => loadNavigationFile(navFile, contentCatalog, asciidocConfig))
    .reduce((accum, treeSet) => accum.concat(treeSet), [])
    .reduce((catalog, { component, version, tree }) => {
      catalog.addTree(component, version, tree)
      return catalog
    }, new NavigationCatalog())
}

function loadNavigationFile (navFile, contentCatalog, asciidocConfig) {
  const lists = loadAsciiDoc(navFile, contentCatalog, asciidocConfig).blocks.filter((b) => b.getContext() === 'ulist')
  if (!lists.length) return []
  const { src: { component, version }, nav: { index } } = navFile
  return lists.map((list, idx) => {
    const tree = buildNavigationTree(list.getTitle(), list)
    tree.root = true
    tree.order = idx ? parseFloat((index + idx / lists.length).toFixed(4)) : index
    return { component, version, tree }
  })
}

function getChildList (node) {
  const firstBlock = node.getBlocks()[0]
  if (firstBlock && firstBlock.getContext() === 'ulist') return firstBlock
}

function buildNavigationTree (formattedContent, list) {
  const entry = formattedContent ? partitionContent(formattedContent) : {}

  if (list) {
    entry.items = list.getItems().map((item) => buildNavigationTree(item.getText(), getChildList(item)))
  }

  return entry
}

// atomize? distill? decompose?
function partitionContent (content) {
  if (~content.indexOf('<a')) {
    const match = content.match(LINK_RX)
    if (match) {
      const [, url, role, content] = match
      if (role === 'page') {
        const hashIdx = url.indexOf('#')
        if (~hashIdx) {
          return { content, url, urlType: 'internal', hash: url.substr(hashIdx) }
        } else {
          return { content, url, urlType: 'internal' }
        }
      } else if (url.charAt() === '#') {
        return { content, url, urlType: 'fragment', hash: url }
      } else {
        return { content, url, urlType: 'external' }
      }
    }
  }
  return { content }
}

module.exports = buildNavigation
