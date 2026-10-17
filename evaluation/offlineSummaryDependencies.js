'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { failure } = require('./liveSummarySafety');

// Private CommonJS instances: no global require patch, shared cache, dotenv or
// application defaults. This is an import boundary for audited code, not a sandbox.
function loadOfflineSummaryDependencies(settings) {
  const root = path.resolve(__dirname, '..');
  const allowed = new Set(['services/summaryGenerationService.js', 'services/contradictionQueryService.js',
    'utils/summaryValidation.js', 'utils/summaryGrounding.js'].map(file => path.join(root, file)));
  const cache = new Map();
  function load(filename) {
    if (!allowed.has(filename)) throw failure('EOFFLINE_DEPENDENCY_REJECTED');
    if (cache.has(filename)) return cache.get(filename).exports;
    const local = new Module(filename);
    local.filename = filename;
    local.require = request => {
      if (request === 'crypto' || request === 'node:crypto') return crypto;
      if (!request.startsWith('.')) throw failure('EOFFLINE_DEPENDENCY_REJECTED');
      const target = path.resolve(path.dirname(filename), request + '.js');
      if (target === path.join(root, 'config/summaries.js')) return settings;
      // Only validateId is used from this module; query factories/defaults are not exposed.
      if (target === path.join(root, 'config/contradictions.js')) return Object.freeze({});
      return load(target);
    };
    cache.set(filename, local);
    try { local._compile(fs.readFileSync(filename, 'utf8'), filename); }
    catch (_) { cache.delete(filename); throw failure('EOFFLINE_DEPENDENCY_REJECTED'); }
    return local.exports;
  }
  const generation = load(path.join(root, 'services/summaryGenerationService.js'));
  const validation = load(path.join(root, 'utils/summaryValidation.js'));
  return Object.freeze({ createSummaryGenerationService: generation.createSummaryGenerationService,
    buildInputFingerprint: validation.buildInputFingerprint, requireContext: validation.requireContext });
}

module.exports = { loadOfflineSummaryDependencies };
