'use strict'

const $pageRefCallback = Symbol('pageRefCallback')
const Opal = global.Opal
const Inline = Opal.const_get_local(Opal.module(null, 'Asciidoctor'), 'Inline')

const ConverterExtension = (() => {
  const scope = Opal.module(Opal.module(null, 'Antora'), 'ConverterExtension')
  Opal.defn(scope, '$inline_anchor', function inlineAnchor (node) {
    if (node.getType() === 'xref') {
      let refSpec = node.getAttribute('refid')
      if (
        node.getAttribute('path') ||
        // NOTE refSpec is undefined if inter-document xref refers to current docname and fragment is empty
        // TODO remove check for file extension after upgrading to 1.5.7
        (refSpec && refSpec.endsWith('.adoc') && (refSpec = refSpec.substr(0, refSpec.length - 5)) !== undefined)
      ) {
        const callback = this[$pageRefCallback]
        if (callback) {
          const { content, target } = callback(refSpec, node.getText())
          let options
          if (target.charAt() === '#') {
            options = Opal.hash2(['type', 'target'], { type: 'link', target })
          } else {
            // TODO pass attributes (e.g., id, role) after upgrading to 1.5.7
            const attributes = Opal.hash2(['role'], { role: 'page' })
            options = Opal.hash2(['type', 'target', 'attributes'], { type: 'link', target, attributes })
          }
          node = Inline.$new(node.getParent(), 'anchor', content, options)
        }
      }
    }
    return Opal.send(this, Opal.find_super_dispatcher(this, 'inline_anchor', inlineAnchor), [node])
  })
  Opal.defn(scope, '$on_page_ref', function (callback) {
    this[$pageRefCallback] = callback
  })
  return scope
})()

module.exports = ConverterExtension
