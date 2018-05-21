'use strict'

const ConverterExtension = require('./xref/converter-extension')

/**
 * Creates an HTML5 converter instance with Antora enhancements.
 *
 * @memberof asciidoc-loader
 *
 * @param {Asciidoctor} asciidoctor - Asciidoctor API.
 * @param {Object} callbacks - Callback functions.
 * @param {Function} callbacks.onPageRef - A function that converts a page reference.
 *
 * @returns {Converter} An enhanced instance of Asciidoctor's HTML5 converter.
 */
function createConverter (asciidoctor, callbacks) {
  const converter = createBaseHtmlConverter(asciidoctor)
  converter.$extend(ConverterExtension)
  converter.$on_page_ref(callbacks.onPageRef)
  return converter
}

function createBaseHtmlConverter (asciidoctor) {
  return asciidoctor.Converter.Factory.getDefault(false).create('html5')
}

module.exports = createConverter
