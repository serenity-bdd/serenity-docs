'use strict'

const ContentCatalog = require('./content-catalog')

const { START_PAGE_ID } = require('./constants')

/**
 * Organizes the raw aggregate of virtual files into a {ContentCatalog}.
 *
 * @memberof content-classifier
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Object} playbook.site - Site-related configuration data.
 * @param {String} playbook.site.startPage - The start page for the site; redirects from base URL.
 * @param {Object} playbook.urls - URL settings for the site.
 * @param {String} playbook.urls.htmlExtensionStyle - The style to use when computing page URLs.
 * @param {Object} aggregate - The raw aggregate of virtual file objects to be classified.
 * @returns {ContentCatalog} An organized catalog of virtual content files.
 */
function classifyContent (playbook, aggregate) {
  const catalog = aggregate.reduce(
    (catalog, { name: component, version, title, start_page: startPage, nav, files }) => {
      files.forEach((file) => allocateSrc(file, component, version, nav) && catalog.addFile(file))
      catalog.addComponentVersion(component, version, title, startPage)
      return catalog
    },
    new ContentCatalog(playbook)
  )
  registerSiteStartPage(playbook, catalog)
  return catalog
}

function allocateSrc (file, component, version, nav) {
  const filepath = file.path
  const pathSegments = filepath.split('/')
  const navInfo = nav && getNavInfo(filepath, nav)
  if (navInfo) {
    file.nav = navInfo
    file.src.family = 'navigation'
    if (pathSegments[0] === 'modules' && pathSegments.length > 2) {
      file.src.module = pathSegments[1]
      // relative to modules/<module>
      file.src.relative = pathSegments.slice(2).join('/')
      file.src.moduleRootPath = calculateRootPath(pathSegments.length - 3)
    } else {
      // relative to root
      file.src.relative = filepath
    }
  } else if (pathSegments[0] === 'modules') {
    if (pathSegments[2] === 'pages') {
      if (pathSegments[3] === '_partials') {
        // QUESTION should this family be partial-page instead?
        file.src.family = 'partial'
        // relative to modules/<module>/pages/_partials
        file.src.relative = pathSegments.slice(4).join('/')
      } else if (file.src.mediaType === 'text/asciidoc') {
        file.src.family = 'page'
        // relative to modules/<module>/pages
        file.src.relative = pathSegments.slice(3).join('/')
      } else {
        return
      }
    } else if (pathSegments[2] === 'assets') {
      if (pathSegments[3] === 'images') {
        file.src.family = 'image'
        // relative to modules/<module>/assets/images
        file.src.relative = pathSegments.slice(4).join('/')
      } else if (pathSegments[3] === 'attachments') {
        file.src.family = 'attachment'
        // relative to modules/<module>/assets/attachments
        file.src.relative = pathSegments.slice(4).join('/')
      } else {
        return
      }
    } else if (pathSegments[2] === 'examples') {
      file.src.family = 'example'
      // relative to modules/<module>/examples
      file.src.relative = pathSegments.slice(3).join('/')
    } else {
      return
    }

    file.src.module = pathSegments[1]
    file.src.moduleRootPath = calculateRootPath(pathSegments.length - 3)
  } else {
    return
  }

  file.src.component = component
  file.src.version = version
  return true
}

/**
 * Return navigation properties if this file is registered as a navigation file.
 *
 * @param {String} filepath - The path of the virtual file to match.
 * @param {Array} nav - The array of navigation entries from the component descriptor.
 *
 * @returns {Object} An object of properties, which includes the navigation
 * index, if this file is a navigation file, or undefined if it's not.
 */
function getNavInfo (filepath, nav) {
  const index = nav.findIndex((candidate) => candidate === filepath)
  if (~index) return { index }
}

function registerSiteStartPage (playbook, contentCatalog) {
  const pageSpec = playbook.site.startPage
  if (!pageSpec) return
  const rel = contentCatalog.resolvePage(pageSpec)
  if (!rel) throw new Error('Specified start page for site not found: ' + pageSpec)
  const src = Object.assign({}, START_PAGE_ID, {
    family: 'alias',
    basename: 'index.adoc',
    stem: 'index',
    mediaType: 'text/asciidoc',
  })
  contentCatalog.addFile({ src, rel })
}

function calculateRootPath (depth) {
  return depth
    ? Array(depth)
      .fill('..')
      .join('/')
    : '.'
}

module.exports = classifyContent
