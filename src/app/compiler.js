'use strict'

var solc = require('solc/wrapper')

var webworkify = require('webworkify')
var utils = require('./utils')

var EventManager = require('../lib/eventManager')

/*
  trigger compilationFinished, compilerLoaded, compilationStarted
*/
function Compiler (editor, handleGithubCall) {
  var self = this
  this.event = new EventManager()

  var compileJSON
  var compilerAcceptsMultipleFiles

  var cachedRemoteFiles = {}
  var worker = null

  var optimize = false

  this.setOptimize = function (_optimize) {
    optimize = _optimize
  }

  var internalCompile = function (files, missingInputs) {
    gatherImports(files, missingInputs, function (error, input) {
      if (error) {
        self.lastCompilationResult = null
        self.event.trigger('compilationFinished', [false, { 'error': error }, files])
      } else {
        compileJSON(input, optimize ? 1 : 0)
      }
    })
  }

  var compile = function () {
    self.event.trigger('compilationStarted', [])
    var input = editor.getValue()

    var files = {}
    files[utils.fileNameFromKey(editor.getCacheFile())] = input
    internalCompile(files)
  }
  this.compile = compile

  function setCompileJSON (_compileJSON) {
    compileJSON = _compileJSON
  }
  this.setCompileJSON = setCompileJSON // this is exposed for testing

  function onCompilerLoaded (version) {
    self.event.trigger('compilerLoaded', [version])
  }

  function onInternalCompilerLoaded () {
    if (worker === null) {
      var compiler = solc(window.Module)

      compilerAcceptsMultipleFiles = compiler.supportsMulti

      compileJSON = function (source, optimize, cb) {
        var missingInputs = []
        var missingInputsCallback = function (path) {
          missingInputs.push(path)
          return { error: 'Deferred import' }
        }

        var result
        try {
          result = compiler.compile(source, optimize, missingInputsCallback)
        } catch (exception) {
          result = { error: 'Uncaught JavaScript exception:\n' + exception }
        }

        compilationFinished(result, missingInputs, source)
      }

      onCompilerLoaded(compiler.version())
    }
  }

  this.lastCompilationResult = {
    data: null,
    source: null
  }
  function compilationFinished (data, missingInputs, source) {
    var noFatalErrors = true // ie warnings are ok

    function isValidError (error) {
      // The deferred import is not a real error
      // FIXME: maybe have a better check?
      if (/Deferred import/.exec(error)) {
        return false
      }

      return utils.errortype(error) !== 'warning'
    }

    if (data['error'] !== undefined) {
      // Ignore warnings (and the 'Deferred import' error as those are generated by us as a workaround
      if (isValidError(data['error'])) {
        noFatalErrors = false
      }
    }
    if (data['errors'] !== undefined) {
      data['errors'].forEach(function (err) {
        // Ignore warnings and the 'Deferred import' error as those are generated by us as a workaround
        if (isValidError(err)) {
          noFatalErrors = false
        }
      })
    }

    if (!noFatalErrors) {
      // There are fatal errors - abort here
      self.lastCompilationResult = null
      self.event.trigger('compilationFinished', [false, data, source])
    } else if (missingInputs !== undefined && missingInputs.length > 0) {
      // try compiling again with the new set of inputs
      internalCompile(source.sources, missingInputs)
    } else {
      self.lastCompilationResult = {
        data: data,
        source: source
      }
      self.event.trigger('compilationFinished', [true, data, source])
    }
  }

  this.loadVersion = function (usingWorker, url) {
    console.log('Loading ' + url + ' ' + (usingWorker ? 'with worker' : 'without worker'))
    self.event.trigger('loadingCompiler', [url, usingWorker])

    if (usingWorker) {
      loadWorker(url)
    } else {
      loadInternal(url)
    }
  }

  function loadInternal (url) {
    delete window.Module
    // NOTE: workaround some browsers?
    window.Module = undefined

    // Set a safe fallback until the new one is loaded
    setCompileJSON(function (source, optimize) {
      compilationFinished({error: 'Compiler not yet loaded.'})
    })

    var newScript = document.createElement('script')
    newScript.type = 'text/javascript'
    newScript.src = url
    document.getElementsByTagName('head')[0].appendChild(newScript)
    var check = window.setInterval(function () {
      if (!window.Module) {
        return
      }
      window.clearInterval(check)
      onInternalCompilerLoaded()
    }, 200)
  }

  function loadWorker (url) {
    if (worker !== null) {
      worker.terminate()
    }
    worker = webworkify(require('./compiler-worker.js'))
    var jobs = []
    worker.addEventListener('message', function (msg) {
      var data = msg.data
      switch (data.cmd) {
        case 'versionLoaded':
          compilerAcceptsMultipleFiles = !!data.acceptsMultipleFiles
          onCompilerLoaded(data.data)
          break
        case 'compiled':
          var result
          try {
            result = JSON.parse(data.data)
          } catch (exception) {
            result = { 'error': 'Invalid JSON output from the compiler: ' + exception }
          }
          var sources = {}
          if (data.job in jobs !== undefined) {
            sources = jobs[data.job].sources
            delete jobs[data.job]
          }
          compilationFinished(result, data.missingInputs, sources)
          break
      }
    })
    worker.onerror = function (msg) {
      compilationFinished({ error: 'Worker error: ' + msg.data })
    }
    worker.addEventListener('error', function (msg) {
      compilationFinished({ error: 'Worker error: ' + msg.data })
    })
    compileJSON = function (source, optimize) {
      jobs.push({sources: source})
      worker.postMessage({cmd: 'compile', job: jobs.length - 1, source: JSON.stringify(source), optimize: optimize})
    }
    worker.postMessage({cmd: 'loadVersion', data: url})
  }

  function gatherImports (files, importHints, cb) {
    importHints = importHints || []
    if (!compilerAcceptsMultipleFiles) {
      cb(null, files[editor.getCacheFile()])
      return
    }
    // FIXME: This will only match imports if the file begins with one.
    //        It should tokenize by lines and check each.
    // eslint-disable-next-line no-useless-escape
    var importRegex = /^\s*import\s*[\'\"]([^\'\"]+)[\'\"];/g
    var reloop = false
    var githubMatch
    do {
      reloop = false
      for (var fileName in files) {
        var match
        while ((match = importRegex.exec(files[fileName]))) {
          var importFilePath = match[1]
          if (importFilePath.startsWith('./')) {
            importFilePath = importFilePath.slice(2)
          }

          // FIXME: should be using includes or sets, but there's also browser compatibility..
          if (importHints.indexOf(importFilePath) === -1) {
            importHints.push(importFilePath)
          }
        }
      }
      while (importHints.length > 0) {
        var m = importHints.pop()
        if (m in files) {
          continue
        }
        if (editor.hasFile(m)) {
          files[m] = editor.getFile(m)
          reloop = true
        } else if (m in cachedRemoteFiles) {
          files[m] = cachedRemoteFiles[m]
          reloop = true
        } else if ((githubMatch = /^(https?:\/\/)?(www.)?github.com\/([^/]*\/[^/]*)\/(.*)/.exec(m))) {
          handleGithubCall(githubMatch[3], githubMatch[4], function (err, content) {
            if (err) {
              cb('Unable to import "' + m + '": ' + err)
              return
            }

            cachedRemoteFiles[m] = content
            files[m] = content

            gatherImports(files, importHints, cb)
          })
          return
        } else if (/^[^:]*:\/\//.exec(m)) {
          cb('Unable to import "' + m + '": Unsupported URL')
          return
        } else {
          cb('Unable to import "' + m + '": File not found')
          return
        }
      }
    } while (reloop)
    cb(null, { 'sources': files })
  }
}

module.exports = Compiler
