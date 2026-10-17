'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');
const childProcess = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PRELOAD = __filename;
const SUITES = Object.freeze({
  legacy: 'test-live-summary-evaluation.js', credentials: 'test-evaluation-credential-channel.js',
  transport: 'test-single-request-https-transport.js', workflow: 'test-offline-summary-workflow.js',
  'multi-event': 'test-multi-event-evaluation.js', validation: 'test-summary-validation.js',
  grounding: 'test-summary-grounding.js', loopback: 'test-offline-summary-loopback.js', native: 'test-native-summary-launcher.js'
});
const SOURCES = [
  'scripts/evaluate-live-summaries.js', 'scripts/evaluate-multi-event.js', 'scripts/test-regression-guard.js',
  ...Object.values(SUITES).map(file => 'scripts/' + file),
  'evaluation/regressionGuard.js', 'evaluation/liveSummarySafety.js', 'evaluation/providerDispatch.js',
  'evaluation/singleRequestHttpsTransport.js', 'evaluation/evaluationCredentialChannel.js',
  'evaluation/offlineSummaryWorkflow.js', 'evaluation/offlineSummaryDependencies.js',
  'evaluation/nativeSummaryLauncher.js', 'evaluation/nativeSummaryWorker.js',
  'scripts/evaluate-native-summary.js', 'scripts/probe-gemini-egress.js',
  'utils/text.js', 'utils/hashes.js', 'utils/claimValidation.js', 'utils/contradictionValidation.js',
  'utils/timeline.js', 'utils/eventChanges.js', 'utils/summaryValidation.js', 'utils/summaryGrounding.js',
  'services/articleProcessingService.js', 'services/evidenceMappingService.js', 'services/contradictionQueryService.js',
  'services/contradictionCandidateService.js', 'services/eventTimelineService.js', 'services/eventChangeService.js',
  'services/summaryContextService.js', 'services/summaryGenerationService.js', 'services/summaryWorkflowService.js',
  'services/summaryQueryService.js', 'config/summaries.js', 'config/claims.js', 'config/contradictions.js', 'config/embeddings.js'
];
const ASSETS = ['package.json', 'fixtures/phase7-multi-event-evaluation.json', 'fixtures/contradiction-evaluation.json',
  'fixtures/phase6-utilities.json', 'fixtures/phase7-summaries.json',
  'fixtures/tls/loopback-cert.pem', 'fixtures/tls/loopback-key.pem', 'fixtures/tls/untrusted-cert.pem'];
const BUILTINS = new Set(['assert', 'assert/strict', 'test', 'crypto', 'fs', 'fs/promises', 'path', 'module', 'events',
  'https', 'http', 'net', 'tls', 'dns', 'dns/promises', 'child_process', 'url']);
const nativeSpawn = childProcess.spawnSync;
const nativeWrite = fs.writeSync.bind(fs);
const realpath = fs.realpathSync.native.bind(fs.realpathSync);
const normalize = value => path.resolve(value).toLowerCase();
function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
const CONFIG = frozen({
  'config/summaries.js': { provider: 'gemini', model: '', promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2',
    maxContextBytes: 64000, maxClaims: 50, maxEvidence: 100, maxContradictions: 100, maxStatements: 30, maxStatementChars: 2000,
    timeoutMs: 20000, retry: { maxAttempts: 1, retryTimeouts: false }, summaryStatuses: ['pending', 'verified', 'needs_review'],
    generationStatuses: ['pending', 'succeeded', 'failed'], groundingStatuses: ['supported', 'partially_supported', 'conflicting', 'unsupported', 'needs_review'] },
  'config/claims.js': { gemini: { claimModel: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', timeoutMs: 20000, retryDelayMs: 2000 },
    extraction: { maxArticleChars: 6000, maxClaimsPerArticle: 10, maxArticlesPerRun: 20 }, evidence: { minOverlap: 0.25 } },
  'config/contradictions.js': { gemini: { contradictionModel: '' }, detection: { promptVersion: 'phase5-v1', maxCandidatesPerRun: 50 },
    query: { defaultLimit: 50, maxLimit: 200 }, validation: { supportedClassifications: ['direct', 'partial', 'temporal', 'none'], confidenceMin: 0, confidenceMax: 1, maxReasonChars: 2000 } },
  'config/embeddings.js': { gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', embeddingModel: 'gemini-embedding-001',
    dimensions: 768, timeoutMs: 15000, maxChars: 7000, batchSize: 10, retryDelayMs: 2000 },
    clustering: { articleThreshold: 0.78, eventThreshold: 0.78, minClusterSize: 2, maxArticlesPerRun: 50 } }
});

function environment(profile) {
  const result = { NODE_ENV: 'test', TZ: 'UTC', NO_COLOR: '1', EVINEWS_REGRESSION_PROFILE: profile };
  if (process.platform === 'win32' && process.env.SystemRoot) result.SystemRoot = process.env.SystemRoot;
  return result;
}
function readReport(result) {
  try {
    const raw = result.output?.[3];
    if (!raw || Buffer.byteLength(raw) > 16384) return null;
    const report = JSON.parse(String(raw));
    if (report.protocol !== 'evinews-regression-guard-v2' || !Number.isSafeInteger(report.violations) || report.violations < 0 ||
        !Number.isSafeInteger(report.children) || report.children < 0 || !Array.isArray(report.codes) ||
        !Number.isSafeInteger(report.attempts) || report.attempts < report.children || !Array.isArray(report.launches) ||
        report.launches.length !== Math.min(report.attempts, 64) ||
        !['supervisor', 'suite', 'self-test', 'probe', 'unapproved'].includes(report.role) ||
        Object.keys(report).sort().join(',') !== 'attempts,children,codes,launches,protocol,role,violations' ||
        report.launches.some(row => !validRecord(row)) ||
        report.children !== report.launches.filter(row => row.admitted).length ||
        report.launches.some(row => row.outcome === 'RUNNING' || row.outcome === 'EXPECTED_PROBE' && report.role !== 'self-test') ||
        report.violations === 0 && report.launches.some(row => !['SUCCESS', 'CLI_REJECTED', 'EXPECTED_PROBE'].includes(row.outcome)) ||
        report.codes.length > 32 || new Set(report.codes).size !== report.codes.length ||
        (report.violations === 0 ? report.codes.length !== 0 : report.codes.length === 0) ||
        report.codes.some(code => typeof code !== 'string' || !/^GUARD_[A-Z_]+$/.test(code))) return null;
    return report;
  } catch (_) { return null; }
}
const PROBES = frozen(Object.fromEntries([
  ...['environment', 'dotenv', 'env-file', 'sdk', 'database', 'network', 'write', 'promise-write', 'child', 'child-options',
    'caught', 'dns', 'nested-caught', 'nested-missing', 'direct-unreviewed', 'nested-helper-failure', 'nested-helper-missing',
    'nested-helper-exit', 'nested-helper-timeout', 'nested-helper-signal', 'ledger-overflow']
    .map(name => [name, { profile: 'probe', expected: 'violation' }]),
  ...['loopback-host', 'loopback-port', 'loopback-tls', 'loopback-binding', 'loopback-dns']
    .map(name => [name, { profile: 'loopback', expected: 'violation' }]),
  ...['ordinary-helper-loopback', 'ordinary-helper-suite', 'ordinary-helper-probe']
    .map(name => [name, { profile: 'offline', expected: 'violation' }]),
  ...['ordinary-helper-cli', 'ordinary-spawn-cli'].map(name => [name, { profile: 'offline', expected: 'success' }]),
  ...['config', 'listeners'].map(name => [name, { profile: 'probe', expected: 'success' }]),
  ['missing-report', { profile: 'probe', expected: 'missing' }], ['timeout', { profile: 'probe', expected: 'timeout' }],
  ['signal', { profile: 'probe', expected: 'signal' }], ['unexpected-exit', { profile: 'probe', expected: 'exit' }]
]));
const preloaded = process.execArgv.includes(PRELOAD);
const entry = path.basename(process.argv[1] || '');
const bootProfile = preloaded ? process.env.EVINEWS_REGRESSION_PROFILE : null;
const probeName = entry === 'test-regression-guard.js' && process.argv[2] === '--probe' ? process.argv[3] : null;
const role = !preloaded ? entry === 'run-guarded-regressions.js' ? 'supervisor' : 'unapproved' :
  entry === 'test-regression-guard.js' && !probeName && bootProfile === 'offline' ? 'self-test' :
    probeName && PROBES[probeName]?.profile === bootProfile && bootProfile !== 'offline' ? 'probe' : 'suite';
const state = { violations: 0, children: 0, attempts: 0, codes: new Set(), launches: [] };
function mark(code) { state.violations++; state.codes.add(code); }
function deny(code) { mark(code); const error = new Error('Regression guard rejected an operation'); error.code = code; throw error; }
const OUTCOMES = ['DENIED', 'RUNNING', 'SUCCESS', 'CLI_REJECTED', 'EXPECTED_PROBE', 'UNEXPECTED_EXIT', 'TIMEOUT',
  'SIGNAL', 'REPORT_INVALID', 'GUARD_VIOLATION', 'SPAWN_ERROR'];
function validRecord(row) {
  return row && Object.keys(row).sort().join(',') === 'admitted,childViolations,command,outcome,report,status' &&
    [...Object.values(SUITES), 'test-regression-guard.js', 'evaluate-live-summaries.js', 'evaluate-multi-event.js', 'UNREVIEWED',
      ...Object.keys(PROBES).map(name => 'probe:' + name)].includes(row.command) &&
    typeof row.admitted === 'boolean' && (row.status === null || Number.isSafeInteger(row.status)) &&
    (row.childViolations === null || Number.isSafeInteger(row.childViolations) && row.childViolations >= 0) &&
    OUTCOMES.includes(row.outcome) && ['VALID', 'INVALID', 'MISSING', 'NOT_RUN'].includes(row.report);
}
function launchReport() {
  return frozen({ protocol: 'evinews-regression-guard-v2', role, violations: state.violations, children: state.children,
    attempts: state.attempts, codes: [...state.codes].sort(), launches: state.launches.map(row => ({ ...row })) });
}
process.on('exit', () => {
  if (state.violations) process.exitCode = 1;
  if (preloaded) nativeWrite(3, JSON.stringify(launchReport()));
});
function dataOptions(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(key => !['input', 'encoding', 'timeout', 'maxBuffer'].includes(key) ||
    !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) return null;
  const result = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const timeout = result.timeout ?? (role === 'supervisor' ? 60000 : 30000), maxBuffer = result.maxBuffer ?? 1048576;
  if (result.encoding !== undefined && result.encoding !== 'utf8' || !Number.isSafeInteger(timeout) || timeout < 1 ||
    timeout > (role === 'supervisor' ? 60000 : 30000) || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 1048576 ||
    result.input !== undefined && (typeof result.input !== 'string' || Buffer.byteLength(result.input) > 200000)) return null;
  return { ...result, timeout, maxBuffer };
}
function cliOutcome(script, args, result) {
  try {
    if (result.stderr || ![0, 1].includes(result.status)) return false;
    const rows = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const last = rows.at(-1);
    if (script === 'evaluate-live-summaries.js') return rows.length === 1 && last.execution === 'NOT RUN' &&
      (result.status === 0 ? args[0] === '--preflight-stdin' && last.status === 'PREFLIGHT_VALID' : last.status === 'PREFLIGHT_REJECTED');
    if (last.exitCode !== result.status) return false;
    if (result.status === 0) return last.complete === true && last.mode === 'SYNTHETIC_OFFLINE_CONTRACT_EVALUATION';
    return args[0] === '--fixture-stdin' && last.complete === false &&
      (rows.length === 1 && last.status === 'NOT RUN' && last.reason === 'Invalid fixture or blocked offline initialization' ||
        last.mode === 'SYNTHETIC_OFFLINE_CONTRACT_EVALUATION' && Number.isSafeInteger(last.counts?.failed) && last.counts.failed > 0);
  } catch (_) { return false; }
}
function expectedProbe(name, result, guard) {
  if (PROBES[name].expected === 'timeout') return result.error?.code === 'ETIMEDOUT';
  if (PROBES[name].expected === 'signal') return !result.error && guard === null && Boolean(result.signal || result.status !== 0);
  if (result.error || result.signal) return false;
  if (PROBES[name].expected === 'missing') return result.status === 0 && guard === null;
  if (PROBES[name].expected === 'exit') return result.status === 2 && guard?.violations === 0;
  if (PROBES[name].expected === 'violation') return result.status === 1 && guard?.violations > 0;
  return result.status === 0 && guard?.violations === 0;
}
// The only native launch site: helpers and spawnSync share role checks and ledger.
function launchChild(script, args, profile, options, executable = process.execPath) {
  state.attempts++;
  if (state.launches.length === 64) return deny('GUARD_CHILD_LIMIT');
  const known = [...Object.values(SUITES), 'test-regression-guard.js', 'evaluate-live-summaries.js', 'evaluate-multi-event.js'].includes(script);
  const row = { command: known ? script : 'UNREVIEWED', admitted: false, status: null, outcome: 'DENIED', report: 'NOT_RUN', childViolations: null };
  state.launches.push(row);
  let controls;
  try { controls = dataOptions(options); } catch (_) { return deny('GUARD_CHILD'); }
  if (executable !== process.execPath || !controls || !Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype ||
    args.length > 2 || Array.from({ length: args.length }, (_, i) => Object.getOwnPropertyDescriptor(args, String(i)))
      .some(descriptor => !descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')) return deny('GUARD_CHILD');
  args = [...args];
  const suite = Object.values(SUITES).includes(script) && args.length === 0 && profile === (script === SUITES.loopback ? 'loopback' : 'offline');
  const selfRoot = script === 'test-regression-guard.js' && args.length === 0 && profile === 'offline';
  const probe = script === 'test-regression-guard.js' && args.length === 2 && args[0] === '--probe' &&
    Object.hasOwn(PROBES, args[1]) && PROBES[args[1]].profile === profile;
  if (script === 'test-regression-guard.js' && args[0] === '--probe' && Object.hasOwn(PROBES, args[1])) row.command = 'probe:' + args[1];
  const nested = role === 'probe' && probe && profile === 'probe' &&
    (['nested-caught', 'nested-helper-failure'].includes(probeName) && args[1] === 'caught' ||
      ['nested-missing', 'nested-helper-missing'].includes(probeName) && args[1] === 'missing-report' ||
      probeName === 'nested-helper-exit' && args[1] === 'unexpected-exit' ||
      probeName === 'nested-helper-timeout' && args[1] === 'timeout' || probeName === 'nested-helper-signal' && args[1] === 'signal');
  const live = script === 'evaluate-live-summaries.js' && (args.length === 0 || args.length === 1 && ['--execute', '--preflight-stdin'].includes(args[0]));
  const offline = script === 'evaluate-multi-event.js' && (args.length === 0 || args.length === 1 && args[0] === '--fixture-stdin');
  const cli = profile === 'offline' && (entry === SUITES.legacy && (live || offline && args.length === 0) ||
    entry === SUITES.transport && live && args[0] === '--execute' ||
    entry === SUITES['multi-event'] && offline && args[0] === '--fixture-stdin' ||
    ['ordinary-helper-cli', 'ordinary-spawn-cli'].includes(probeName) && live && args[0] === '--execute');
  if (!(role === 'supervisor' && (suite || selfRoot) || role === 'self-test' && probe || nested || role === 'suite' && cli)) return deny('GUARD_CHILD');
  row.admitted = true; row.outcome = 'RUNNING'; state.children++;
  let result;
  try {
    result = nativeSpawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT, env: environment(profile), shell: false, windowsHide: true, encoding: 'utf8', input: controls.input,
      timeout: controls.timeout, maxBuffer: controls.maxBuffer, stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });
  } catch (_) {
    row.outcome = 'SPAWN_ERROR'; mark('GUARD_CHILD_REPORT'); throw Object.assign(new Error('Guarded child failed'), { code: 'GUARD_CHILD_REPORT' });
  }
  const guard = readReport(result);
  row.status = Number.isSafeInteger(result.status) ? result.status : null;
  row.report = guard ? 'VALID' : result.output?.[3] ? 'INVALID' : 'MISSING'; row.childViolations = guard?.violations ?? null;
  const clean = !result.error && !result.signal && guard !== null && guard.violations === 0;
  const accepted = role === 'self-test' && probe ? expectedProbe(args[1], result, guard) :
    clean && (cli ? cliOutcome(script, args, result) : result.status === 0);
  row.outcome = accepted ? role === 'self-test' && probe ? 'EXPECTED_PROBE' : result.status === 1 ? 'CLI_REJECTED' : 'SUCCESS' :
    result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : result.error ? 'SPAWN_ERROR' : result.signal ? 'SIGNAL' :
      !guard ? 'REPORT_INVALID' : guard.violations ? 'GUARD_VIOLATION' : 'UNEXPECTED_EXIT';
  if (!accepted) mark('GUARD_CHILD_REPORT');
  return { result, guard, safe: clean && accepted };
}
function runGuarded(script, args = [], profile = 'offline', options = {}) {
  return launchChild(script, args, profile, options);
}

function install() {
  const profile = process.env.EVINEWS_REGRESSION_PROFILE;
  if (!['offline', 'loopback', 'probe'].includes(profile)) throw new Error('Regression guard profile required');
  const synthetic = environment(profile);
  process.env = new Proxy(synthetic, {
    get(target, name) {
      if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY|^DB_|^DATABASE|^DOTENV|^NODE_OPTIONS$/i.test(String(name))) return deny('GUARD_ENVIRONMENT');
      return Object.hasOwn(target, name) ? target[name] : undefined;
    },
    set() { return deny('GUARD_ENVIRONMENT'); }, deleteProperty() { return deny('GUARD_ENVIRONMENT'); },
    defineProperty() { return deny('GUARD_ENVIRONMENT'); }
  });
  const sources = new Set(SOURCES.map(file => normalize(path.join(ROOT, file))));
  const reads = new Set([...SOURCES, ...ASSETS].map(file => normalize(path.join(ROOT, file))));
  const configs = new Map(Object.entries(CONFIG).map(([file, value]) => [normalize(path.join(ROOT, file)), value]));
  function readable(file) {
    if (file === 0) return;
    try {
      const actual = file instanceof URL ? fileURLToPath(file) : file;
      if (typeof actual !== 'string' && !Buffer.isBuffer(actual)) return deny('GUARD_FILE_READ');
      const full = path.resolve(String(actual));
      if (!reads.has(normalize(full)) || normalize(realpath(full)) !== normalize(full)) return deny('GUARD_FILE_READ');
    } catch (error) { if (error.code?.startsWith('GUARD_')) throw error; return deny('GUARD_FILE_READ'); }
  }
  const load = Module._load;
  Module._load = function (name, parent, main) {
    if (Module.isBuiltin(name)) {
      if (!BUILTINS.has(name.replace(/^node:/, ''))) return deny('GUARD_IMPORT');
    } else {
      if (!name.startsWith('.') && !path.isAbsolute(name)) return deny('GUARD_IMPORT');
      const resolved = Module._resolveFilename(name, parent, main);
      if (configs.has(normalize(resolved))) return configs.get(normalize(resolved));
      if (!sources.has(normalize(resolved)) && !reads.has(normalize(resolved))) return deny('GUARD_IMPORT');
      readable(resolved);
    }
    return load.call(this, name, parent, main);
  };
  for (const name of ['readFileSync', 'readFile', 'createReadStream']) {
    const original = fs[name]; fs[name] = function (file, ...args) { readable(file); return original.call(this, file, ...args); };
  }
  const promises = fs.promises;
  const originalRead = promises.readFile.bind(promises);
  promises.readFile = function (file, ...args) { readable(file); return originalRead(file, ...args); };
  const originalOpen = fs.openSync;
  const descriptors = new Set([0]);
  fs.openSync = function (file, flags, ...args) {
    if (flags !== 'r' && flags !== 0) return deny('GUARD_FILE_WRITE');
    readable(file); const fd = originalOpen.call(this, file, flags, ...args); descriptors.add(fd); return fd;
  };
  const originalReadSync = fs.readSync;
  fs.readSync = function (fd, ...args) { if (!descriptors.has(fd)) return deny('GUARD_FILE_READ'); return originalReadSync.call(this, fd, ...args); };
  const originalClose = fs.closeSync;
  fs.closeSync = function (fd) { descriptors.delete(fd); return originalClose.call(this, fd); };
  // Unneeded alternate descriptor/file APIs are denied, not incompletely emulated.
  for (const name of ['open', 'opendir', 'opendirSync', 'readdir', 'readdirSync', 'read', 'readv', 'readvSync',
    'watch', 'watchFile', 'readlink', 'readlinkSync', 'openAsBlob']) if (typeof fs[name] === 'function') fs[name] = () => deny('GUARD_FILE_READ');
  const writes = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'truncate', 'truncateSync',
    'ftruncate', 'ftruncateSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync',
    'mkdtemp', 'mkdtempSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync',
    'symlink', 'symlinkSync', 'chmod', 'chmodSync', 'fchmod', 'fchmodSync', 'chown', 'chownSync', 'fchown', 'fchownSync',
    'lchown', 'lchownSync', 'lchmod', 'lchmodSync', 'utimes', 'utimesSync', 'futimes', 'futimesSync', 'lutimes', 'lutimesSync', 'writev', 'writevSync'];
  for (const name of writes) if (typeof fs[name] === 'function') fs[name] = () => deny('GUARD_FILE_WRITE');
  for (const name of Object.keys(promises)) if (!['readFile', 'constants'].includes(name) && typeof promises[name] === 'function') promises[name] = () => deny('GUARD_FILE_WRITE');
  for (const name of ['write', 'writeSync']) {
    const original = fs[name]; fs[name] = function (fd, ...args) {
      if (![1, 2].includes(fd)) return deny('GUARD_FILE_WRITE'); return original.call(this, fd, ...args);
    };
  }
  const net = require('node:net'), tls = require('node:tls'), https = require('node:https'), http = require('node:http');
  const dns = require('node:dns'), dnsPromises = require('node:dns/promises');
  const ports = new Set();
  const testCas = profile === 'loopback' ? ['loopback-cert.pem', 'untrusted-cert.pem'].map(file =>
    fs.readFileSync(path.join(ROOT, 'fixtures/tls', file), 'utf8').replace(/\r\n/g, '\n').trim()) : [];
  function connection(args) {
    const value = args[0];
    const normalized = Array.isArray(value) ? value[0] : value;
    if (profile !== 'loopback' || !normalized || typeof normalized !== 'object' || normalized.host !== '127.0.0.1' ||
      !ports.has(Number(normalized.port)) || normalized.path) return deny('GUARD_NETWORK');
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { connection(args); return connect.apply(this, args); };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (profile !== 'loopback' || args[0] !== 0 || args[1] !== '127.0.0.1') return deny('GUARD_NETWORK');
    let port;
    this.once('listening', () => { port = this.address().port; ports.add(port); });
    this.once('close', () => ports.delete(port));
    return listen.apply(this, args);
  };
  const tlsConnect = tls.connect;
  tls.connect = function (...args) { connection(args); if (args[0]?.rejectUnauthorized === false) return deny('GUARD_NETWORK'); return tlsConnect.apply(this, args); };
  const request = https.request;
  https.request = function (options, ...args) {
    if (profile !== 'loopback' || !options || typeof options !== 'object' || options.hostname !== '127.0.0.1' ||
      !ports.has(Number(options.port)) || options.rejectUnauthorized !== true || typeof options.ca !== 'string' ||
      !testCas.includes(options.ca.replace(/\r\n/g, '\n').trim()) ||
      options.headers?.authorization || options.headers?.['x-goog-api-key']) return deny('GUARD_NETWORK');
    return request.call(this, options, ...args);
  };
  https.get = () => deny('GUARD_NETWORK'); http.request = http.get = () => deny('GUARD_NETWORK');
  http.createServer = () => deny('GUARD_NETWORK');
  global.fetch = () => deny('GUARD_NETWORK');
  if (global.WebSocket) global.WebSocket = class { constructor() { deny('GUARD_NETWORK'); } };
  for (const object of [dns, dnsPromises]) for (const name of Object.keys(object)) {
    if (typeof object[name] === 'function') object[name] = () => deny('GUARD_NETWORK');
  }
  // Node also calls lookup for numeric listen addresses; no resolver is needed.
  dns.lookup = function (host, options, callback) {
    if (profile !== 'loopback' || host !== '127.0.0.1') return deny('GUARD_NETWORK');
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof callback !== 'function') return deny('GUARD_NETWORK');
    process.nextTick(() => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
  };
  function childCommand(command, args, options) {
    let script = 'UNREVIEWED', tail = [];
    const descriptors = Array.isArray(args) && args.length > 0 && args.length <= 3 &&
      Array.from({ length: args.length }, (_, i) => Object.getOwnPropertyDescriptor(args, String(i)));
    if (descriptors && descriptors.every(descriptor => descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string')) {
      const values = descriptors.map(descriptor => descriptor.value), candidate = path.basename(values[0]);
      if (normalize(values[0]) === normalize(path.join(ROOT, 'scripts', candidate))) script = candidate;
      tail = values.slice(1);
    }
    const nestedProbe = role === 'probe' && ['nested-caught', 'nested-missing'].includes(probeName);
    const child = launchChild(script, tail, nestedProbe ? 'probe' : 'offline', options, command);
    if (!child.safe) throw Object.assign(new Error('Guarded child failed'), { code: 'GUARD_CHILD_REPORT' });
    return child.result;
  }
  childProcess.spawnSync = childCommand;
  for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[name] = () => launchChild('UNREVIEWED', [], 'offline', {});
  }
}

module.exports = { SUITES, runGuarded, readReport, launchReport };
if (process.execArgv.includes(PRELOAD)) install();
