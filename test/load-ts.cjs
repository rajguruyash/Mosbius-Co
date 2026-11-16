'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Node 20 has no global `navigator` (Node 21 added it), and pixi.js reads it while it loads, so a test that loaded a module
// importing pixi.js died on Node 20, which is what CI's setup-node "20" provides. Define a minimal one only where it is
// missing; Node 21 and later already have their own. Test harness and tools/export-sprites.cjs only: no shipped code runs here.
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: `Node.js/${process.versions.node.split('.')[0]}`, language: 'en-US', languages: ['en-US'], platform: process.platform, hardwareConcurrency: 1 },
    configurable: true,
    writable: true
  });
}

const cache = new Map();

function resolveTs(fromDir, request) {
  const base = request.startsWith('@shared/')
    ? path.resolve(__dirname, '..', 'src/shared', request.slice('@shared/'.length))
    : path.resolve(fromDir, request);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(filename) {
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  // A `.json` import is data, not TypeScript. The bundler parses it (the app
  // compiles with resolveJsonModule); handing it to transpileModule instead
  // fails output generation outright, so parse it the same way here.
  if (filename.endsWith('.json')) {
    const json = { exports: JSON.parse(fs.readFileSync(filename, 'utf8')) };
    cache.set(filename, json);
    return json.exports;
  }
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      // Match tsconfig.node/tsconfig.web. Without it a default import of a CJS
      // builtin (`import path from 'node:path'`) compiles to `path_1.default`,
      // which is undefined at run time — the module loads fine and then explodes
      // on first use. Test harness only; no shipped code compiles through here.
      esModuleInterop: true
    },
    fileName: filename,
    reportDiagnostics: true
  });
  if (output.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n'
    }));
  }
  const mod = { exports: {} };
  cache.set(filename, mod);
  const localRequire = (request) => {
    if (request.startsWith('.') || request.startsWith('@shared/')) {
      const resolved = resolveTs(path.dirname(filename), request);
      if (resolved) return loadFile(resolved);
    }
    return require(request);
  };
  const run = new Function('module', 'exports', 'require', '__filename', '__dirname', output.outputText);
  run(mod, mod.exports, localRequire, filename, path.dirname(filename));
  return mod.exports;
}

/** Load a TypeScript module and its local TypeScript imports for node:test. */
module.exports = function loadTs(relativePath) {
  return loadFile(path.resolve(__dirname, '..', relativePath));
};
