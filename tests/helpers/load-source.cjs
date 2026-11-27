'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');

// Exercise production TypeScript without starting an Extension Host. Dependencies
// can be substituted at the module boundary, while the tested methods stay intact.
module.exports = function loadSource(relativePath, mocks = {}) {
  // The same contract tests can validate an installed JavaScript build while
  // retaining any local Extension Host safeguards in that build.
  const filename = process.env.OVERLEAF_TEST_BUILD_DIR
    ? path.resolve(process.env.OVERLEAF_TEST_BUILD_DIR,
      relativePath.replace(/^src\//, '').replace(/\.ts$/, '.js'))
    : path.resolve(__dirname, '../..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText, diagnostics = [] } = filename.endsWith('.js')
    ? { outputText: source }
    : ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: true,
    },
    });
  const errors = diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }));
  }
  const requireFromSource = createRequire(filename);
  const localRequire = name => Object.prototype.hasOwnProperty.call(mocks, name)
    ? mocks[name]
    : requireFromSource(name);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__filename', '__dirname', outputText)(
    localRequire, module, module.exports, filename, path.dirname(filename),
  );
  return module.exports;
};
