const webpack = require('webpack')
const CommonJsRequireDependency = require('webpack/lib/dependencies/commonjs/CommonJsRequireDependency')
const { existsSync } = require('fs')
const { join, dirname, extname, relative } = require('path')
// const { cache } = require('webpack') // Cache handling missing

const fileBanner = `/* Start of pino-webpack-plugin additions */
function pinoWebpackAbsolutePath(p) {
  try {
    return require('path').join(__dirname, p)
  } catch(e) {
    // This is needed not to trigger a warning if we try to use within CJS - Do we have another way?
    const f = new Function('p', 'return new URL(p, import.meta.url).pathname');
    return f(p)
  }
}
`

const compatibilityFooter = `
/* The following statement is added by pino-webpack-plugin to make sure extracted file are valid commonjs modules */
; if(typeof module !== 'undefined' && typeof __webpack_exports__ !== "undefined") { module.exports = __webpack_exports__; }
`
const PLUGIN_NAME = 'PinoWebpackPlugin'
// const CACHE_ID = 'pino-worker-plugin' // Cache handling missing

function quote(path) {
  return `'${path.replace(/([\\'])/g, '\\$1')}'`
}

class PinoWebpackPlugin {
  constructor(options) {
    options = { transports: [], ...options }
    this.transports = options.transports
  }

  apply(compiler) {
    const outputFilename = compiler.options.output.filename
    const workerExtension = typeof outputFilename === 'string' ? extname(outputFilename) : ''
    const workerFilename = `[name]${workerExtension || '.js'}`

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      const dependencies = {} // {entry: source file, file: generated file}

      compilation.hooks.finishModules.tap(PLUGIN_NAME, (modules) => {
        const addChildCompilerEntryPoint = (id, context, file, name) => {
          // Use id as name if none was given
          dependencies[id] = { entry: new webpack.EntryPlugin(context, file, { name: name ?? id }) }
        }

        for (const mod of modules) {
          switch (true) {
            case mod.rawRequest === 'thread-stream':
              addChildCompilerEntryPoint('thread-stream-worker', mod.context, './lib/worker.js')
              break

            case mod.rawRequest === 'pino':
              addChildCompilerEntryPoint('pino/file', mod.context, './file.js', 'pino-file')
              addChildCompilerEntryPoint('pino-worker', mod.context, './lib/worker.js')
              addChildCompilerEntryPoint(
                'pino-pipeline-worker',
                mod.context,
                existsSync(join(mod.context, 'lib/worker-pipeline.js')) ? './lib/worker-pipeline.js' : './lib/worker.js'
              )
              break

            case this.transports.includes(mod.rawRequest):
              addChildCompilerEntryPoint(mod.rawRequest, mod.context, mod.request)
              break
          }
        }
      })

      // When requiring pino, also make sure all transports in the options are required
      compilation.hooks.succeedModule.tap(PLUGIN_NAME, (mod) => {
        if (mod.rawRequest !== 'pino') {
          return
        }

        for (const transport of this.transports) {
          mod.dependencies.push(new CommonJsRequireDependency(transport, null))
        }
      })

      /** Compile dependencies and add result to compilation assets **/
      compilation.hooks.additionalAssets.tapAsync(PLUGIN_NAME, (additionalAssetsCallback) => {
        // Create child compiler for dependencies
        const childCompiler = compilation.createChildCompiler(
          `${PLUGIN_NAME}ChildCompiler`,
          {
            filename: workerFilename,
            library: {
              type: 'commonjs2'
            },
            iife: false
          },
          Object.values(dependencies).map((worker) => worker.entry)
        )
        childCompiler.inputFileSystem = compiler.inputFileSystem

        // Enable required plugins
        new webpack.node.NodeTemplatePlugin({
          library: {
            type: 'commonjs2'
          },
          iife: false
        }).apply(childCompiler)
        new webpack.node.NodeTargetPlugin().apply(childCompiler)

        // Keep track of the emitted filename for each dependency.
        childCompiler.hooks.thisCompilation.tap(PLUGIN_NAME, (childCompilation) => {
          childCompilation.hooks.chunkAsset.tap(`${PLUGIN_NAME}ChildCompiler`, (chunk, file) => {
            // Unescape pino/file
            const dependencyId = chunk.name === 'pino-file' ? 'pino/file' : chunk.name

            if (dependencyId && dependencies[dependencyId]) {
              dependencies[dependencyId].file = file
            }
          })
        })

        // runAsChild merges child assets into the parent compilation. run() does
        // not, which leaves the banner pointing at worker files that were never emitted.
        childCompiler.runAsChild((err, entries, childCompilation) => {
          if (!err) {
            for (const { name, source } of childCompilation.getAssets()) {
              if (/\.(?:c|m)?js$/.test(name)) {
                compilation.updateAsset(name, new webpack.sources.ConcatSource(source, compatibilityFooter))
              }
            }
          }
          additionalAssetsCallback(err)
        })
      })

      // Add banner to entrypoints files
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS
        },
        () => {
          const dependenciesFiles = []

          // Create array of declarations used in banner
          for (const depId in dependencies) {
            if (!dependencies[depId].file) {
              continue
            }
            dependenciesFiles.push([depId, dependencies[depId].file])
          }

          // Add banner to every file generated from compilation entry points
          compilation.entrypoints.forEach((ep, k) => {
            for (const entrypointFile of ep.getFiles()) {
              const relativePath = relative(dirname(entrypointFile), '.') || '.'

              compilation.updateAsset(
                entrypointFile,
                new webpack.sources.ConcatSource(
                  fileBanner,
                  '\n',
                  `globalThis.__bundlerPathsOverrides = {${dependenciesFiles.map(
                    ([workerId, file]) => `'${workerId}': pinoWebpackAbsolutePath(${quote(join(relativePath, file))})`
                  )}};`,
                  '\n',
                  '/* End of pino-webpack-plugin additions */',
                  '\n\n',
                  compilation.assets[entrypointFile]
                )
              )
            }
          })
        }
      )
    })
  }
}

module.exports = {
  banner: fileBanner,
  footer: compatibilityFooter,
  PinoWebpackPlugin
}
