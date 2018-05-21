'use strict'

const convict = require('convict')
const yaml = require('js-yaml')

const ARGS_SCANNER_RX = /(?:([^=,]+)|(?==))(?:,|$|=(|("|').*?\3|[^,]+)(?:,|$))/g

/**
 * A convict function wrapper that decouples it from the process environment.
 * This wrapper allows the args array and env map to be specified as options.
 */
function solitaryConvict (schema, opts = {}) {
  registerCustomFormats(convict)

  let processArgv
  let args = opts.args || []
  processArgv = process.argv
  // NOTE convict expects first two arguments to be node command and script filename
  let argv = processArgv.slice(0, 2).concat(args)
  process.argv = argv

  let processEnv
  let env = opts.env || {}
  processEnv = process.env
  process.env = env

  const config = convict(schema)

  process.argv = processArgv
  process.env = processEnv

  const originalLoad = config.load
  config.load = function (configOverlay) {
    process.argv = argv
    process.env = env
    const combinedConfig = originalLoad.apply(this, [configOverlay])
    process.argv = processArgv
    process.env = processEnv
    return combinedConfig
  }

  return config
}

function registerCustomFormats (convict) {
  convict.addFormat({
    name: 'object',
    validate: (val) => {
      if (typeof val !== 'object') throw new Error('must be an object (key/value pairs)')
    },
    coerce: (val) => {
      const accum = {}
      let match
      ARGS_SCANNER_RX.lastIndex = 0
      while ((match = ARGS_SCANNER_RX.exec(val))) {
        const [, k, v] = match
        if (k) accum[k] = v ? yaml.safeLoad(v) : ''
      }
      return accum
    },
  })
  convict.addFormat({
    name: 'dir-or-virtual-files',
    validate: (val) => {
      if (!(typeof val === 'string' || val instanceof String || Array.isArray(val))) {
        throw new Error('must be a directory path or list of virtual files')
      }
    },
  })
}

module.exports = solitaryConvict
