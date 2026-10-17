'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const Module = require('node:module');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createOfflineSummaryWorkflow } = require('../evaluation/offlineSummaryWorkflow');
const { loadOfflineSummaryDependencies } = require('../evaluation/offlineSummaryDependencies');
const EVENT = '81000000-0000-4000-8000-000000000001', ARTICLE = '82000000-0000-4000-8000-000000000001';
const CLAIM = '83000000-0000-4000-8000-000000000001', EVIDENCE = '84000000-0000-4000-8000-000000000001';
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixture(options = {}) {
  const settings = { model: 'offline-fixture-only', promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2', timeoutMs: options.timeoutMs || 1000 };
  const api = loadOfflineSummaryDependencies(Object.freeze({ ...settings, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 }));
  const context = index => {
    const text = `Synthetic library ${index} opened.`, hash = crypto.createHash('sha256').update(text).digest('hex');
    const source = { id: 'fixture-source', name: 'Synthetic Publisher' };
    const snapshot = { event: { id: EVENT, title: 'Synthetic event' }, reports: [{ article_id: ARTICLE, source }],
      claims: [{ claim_id: CLAIM, article_id: ARTICLE, claim_text: text, claim_type: 'fact', source }],
      evidence: [{ evidence_id: EVIDENCE, claim_id: CLAIM, article_id: ARTICLE, evidence_text: text, evidence_hash: hash,
        source_grounded: true, exact_source_grounded: true, source_excerpt_provenance: { article_id: ARTICLE, source_id: source.id,
          source_name: source.name, evidence_hash: hash, source_text_hash: hash } }], contradictions: [],
      warnings: [{ code: 'SUMMARY_SINGLE_SOURCE', message: 'Synthetic coverage warning.' }],
      coverage: { status: 'unknown' }, metadata: { model: settings.model, prompt_version: settings.promptVersion, contract_version: settings.contractVersion } };
    if (options.mutateContext) options.mutateContext(snapshot);
    snapshot.metadata.input_fingerprint = api.buildInputFingerprint(snapshot); return freeze(snapshot);
  };
  const snapshots = Object.freeze(Array.from({ length: options.count || 1 }, (_, i) => context(i)));
  const target = { host: 'localhost', port: 3306, database: 'evinews_ai_eval_unused_no_connection' };
  const limits = { maxEvents: 1, maxArticles: 1, maxSummaryAttempts: 3, maxProviderCalls: options.budget || 3 };
  const config = { mode: 'isolated-live', target, eventIds: [EVENT], articles: [{ id: ARTICLE, event_id: EVENT }],
    attempts: [EVENT], limits, summary: settings };
  const approval = { approved: true, targetAllowlist: [target], developmentTarget: { ...target, database: 'evinews_ai' },
    productionTargets: [], productionNotConfigured: true, eventIds: [EVENT], articleIds: [ARTICLE], limits, summary: settings };
  const state = { sends: 0, signals: [] };
  const transport = { async sendOne(request, { signal }) {
    state.sends++; state.signals.push(signal);
    if (options.error) throw options.error;
    if (options.pending) return new Promise(() => {});
    const snapshot = snapshots.find(row => request.contents.includes(row.claims[0].claim_text));
    const statement = { id: 's1', text: 'Synthetic Publisher excerpt: ' + snapshot.evidence[0].evidence_text,
      source_claim_ids: [CLAIM], evidence_ids: [EVIDENCE], contradiction_ids: [], attribution: 'Synthetic Publisher' };
    if (options.mutateStatement) options.mutateStatement(statement);
    return { text: options.raw ?? JSON.stringify({ statements: [statement] }) };
  } };
  return { config, approval, snapshots, snapshotApproval: { approved: true, fingerprints: snapshots.map(row => row.metadata.input_fingerprint) }, transport, state };
}
function make(input) {
  return createOfflineSummaryWorkflow({ config: input.config, approval: input.approval, snapshots: input.snapshots,
    snapshotApproval: input.snapshotApproval, transport: input.transport,
    httpsTransport: input.httpsTransport, executionMode: input.executionMode });
}
const hash = input => input.snapshots[0].metadata.input_fingerprint;

function authenticatedFixture(options = {}) {
  const input = fixture({ ...options, timeoutMs: 20000, budget: 1 });
  input.config.limits.maxSummaryAttempts = 1;
  const original = input.transport, channel = new EventEmitter();
  input.state.deliveries = 0; input.state.requests = 0;
  channel.send = () => { input.state.deliveries++; queueMicrotask(() => channel.emit('message', {
    protocol: 'evinews-evaluation-secret-v1', secret: 'DUMMY_EVALUATION_ONLY' })); };
  const httpsFixture = { request(settings, callback) {
    input.state.requests++; assert.equal(settings.headers['x-goog-api-key'], 'DUMMY_EVALUATION_ONLY');
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { queueMicrotask(async () => {
      const response = await original.sendOne({ contents: JSON.parse(body).contents[0].parts[0].text }, { signal: new AbortController().signal });
      const res = new EventEmitter(); res.statusCode = options.status || 200; res.destroyed = false; res.destroy = () => { res.destroyed = true; };
      callback(res); if (res.destroyed) return;
      res.emit('data', Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: response.text }] } }] })));
      res.emit('end');
    }); };
    return req;
  } };
  delete input.transport;
  input.executionMode = 'authenticated-fixture-test'; input.httpsTransport = { httpsFixture, credentialChannel: channel };
  return input;
}

test('authenticated fixture uses one in-memory dispatch, never persistence, and caches repeats', async () => {
  const input = authenticatedFixture(), run = make(input);
  try {
    assert.equal(input.state.deliveries, 0);
    const [a, b] = await Promise.all([run.evaluate(hash(input)), run.evaluate(hash(input))]);
    assert.equal(a.status, 'accepted'); assert.deepEqual(a, b); assert.deepEqual(await run.evaluate(hash(input)), a);
    assert.equal(a.factual_truth_verified, false); assert.equal(a.persistenceReady, undefined);
    assert.equal(JSON.stringify(a).includes('DUMMY_EVALUATION_ONLY'), false);
    assert.equal(input.state.deliveries, 1); assert.equal(input.state.requests, 1); assert.equal(run.dispatches, 1);
  } finally { run.close(); }
});

for (const [label, mutate] of [
  ['approval', row => { row.approval.approved = false; }],
  ['snapshot', row => { row.snapshots = [...row.snapshots]; }],
  ['model', row => { row.config.summary = { ...row.config.summary, model: 'unapproved-model' }; }],
  ['budget', row => { row.config.limits.maxProviderCalls = 2; }],
  ['attempts', row => { row.config.limits.maxSummaryAttempts = 2; }],
  ['timeout', row => { row.config.summary.timeoutMs = 19999; }],
  ['native binding', row => { row.httpsTransport.httpsFixture = require('node:https'); }],
  ['external mode', row => { row.executionMode = 'live'; }]
]) test(`authenticated ${label} rejects before credentials or transport`, () => {
  const input = authenticatedFixture(); mutate(input); assert.throws(() => make(input));
  assert.equal(input.state.deliveries, 0); assert.equal(input.state.requests, 0);
});

test('authenticated HTTP diagnostics survive sanitized workflow boundary', async () => {
  const input = authenticatedFixture({ status: 503 }), run = make(input);
  try {
    const result = await run.evaluate(hash(input));
    assert.equal(result.status, 'failed'); assert.deepEqual(result.diagnostic, { category: 'HTTP', status: 503 });
    assert.equal(JSON.stringify(result).includes('DUMMY_EVALUATION_ONLY'), false);
    assert.equal(input.state.requests, 1);
  } finally { run.close(); }
});

for (const encoding of ['literal', 'unicode', 'mixed']) test(`grounding-rejected credential reflection ${encoding} never enters workflow results`, async () => {
  const secret = 'DUMMY_EVALUATION_ONLY';
  const summary = { statements: [{ id: 's1', text: 'Synthetic Publisher excerpt: Synthetic library 0 opened. ' + secret,
    source_claim_ids: [CLAIM], evidence_ids: [EVIDENCE], contradiction_ids: [], attribution: 'Synthetic Publisher' }] };
  const escaped = value => Array.from(value, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const raw = JSON.stringify(summary).replace(secret, encoding === 'unicode' ? escaped(secret) :
    encoding === 'mixed' ? 'DUMMY_' + escaped('EVALUATION') + '_ONLY' : secret);
  const input = authenticatedFixture({ raw }), run = make(input);
  try {
    const result = await run.evaluate(hash(input));
    assert.equal(result.status, 'failed'); assert.equal(result.structured_output, null); assert.equal(result.verification_metadata, null);
    assert.deepEqual(result.diagnostic, { category: 'RESPONSE_PARSE' });
    assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes('\\u0044'), false);
    assert.deepEqual(await run.evaluate(hash(input)), result); assert.equal(input.state.deliveries, 1);
    assert.equal(input.state.requests, 1); assert.equal(run.dispatches, 1);
  } finally { run.close(); }
});

for (const [label, options] of [
  ['malformed output', { raw: 'not JSON' }],
  ['unsupported output', { mutateStatement: statement => { statement.text += ' Unsupported conclusion.'; } }]
]) test(`authenticated ${label} is not accepted`, async () => {
  const input = authenticatedFixture(options), run = make(input);
  try { assert.notEqual((await run.evaluate(hash(input))).status, 'accepted'); assert.equal(input.state.requests, 1); }
  finally { run.close(); }
});

test('HTTPS stays lazy for fake callers and rejected preflight/bindings', async () => {
  const load = Module._load; let loads = 0;
  Module._load = function (name, ...args) {
    if (name === './singleRequestHttpsTransport') { loads++; throw new Error('Unexpected HTTPS initialization'); }
    return load.call(this, name, ...args);
  };
  try {
    const good = fixture(), workflow = make(good);
    try { assert.equal((await workflow.evaluate(hash(good))).status, 'accepted'); } finally { workflow.close(); }
    for (const mutate of [
      row => { row.httpsTransport = {}; },
      row => { delete row.transport; },
      row => { row.executionMode = 'live'; },
      row => { delete row.transport; row.httpsTransport = { loopback: {} }; },
      row => { delete row.transport; row.executionMode = 'loopback-test'; row.httpsTransport = { loopback: {}, model: 'override' }; },
      row => { delete row.transport; row.executionMode = 'loopback-test'; row.httpsTransport = { loopback: {} }; row.snapshotApproval.approved = false; },
      row => { delete row.transport; row.executionMode = 'loopback-test'; row.httpsTransport = { loopback: {} }; row.snapshots = [...row.snapshots]; }
    ]) { const input = fixture(); mutate(input); assert.throws(() => make(input)); assert.equal(input.state.sends, 0); }
    assert.equal(loads, 0);
  } finally { Module._load = load; }
});

test('valid immutable approved snapshot uses real generation/validation/grounding and no persistence', async () => {
  const input = fixture(), workflow = make(input);
  try {
    const result = await workflow.evaluate(hash(input));
    assert.equal(result.status, 'accepted'); assert.equal(result.factual_truth_verified, false);
    assert.equal(result.verification_status, 'needs_review'); assert.equal(result.verification_metadata.statements[0].support_basis, 'source_excerpt');
    assert.deepEqual(result.warnings, input.snapshots[0].warnings);
    assert.equal(result.persistenceReady, undefined); assert.equal(workflow.persistSummary, undefined);
    assert.equal(input.state.sends, 1); assert.equal(workflow.dispatches, 1);
  } finally { workflow.close(); }
});

for (const authenticated of [false, true]) test(`forbidden imports, dotenv, SDK/database and environment credential access: authenticated=${authenticated}`, async () => {
  const input = authenticated ? authenticatedFixture() : fixture();
  const originalLoad = Module._load, originalRead = fs.readFileSync, environment = process.env;
  let forbidden = 0, credentialReads = 0;
  Module._load = function (name, ...args) {
    if (/dotenv|sequelize|mysql|genai|geminiClientService|summaryWorkflowService|summaryQueryService|summaryContextService|models|config[\\/](db|database)/i.test(name)) {
      forbidden++; throw new Error('Forbidden dependency sentinel');
    }
    return originalLoad.call(this, name, ...args);
  };
  fs.readFileSync = function (file, ...args) {
    if (/(?:^|[\\/])\.env(?:$|\.)/.test(String(file))) { forbidden++; throw new Error('Forbidden environment file'); }
    return originalRead.call(this, file, ...args);
  };
  process.env = new Proxy(Object.create(null), { get(_, key) {
    if (/GEMINI|KEY|TOKEN|PASSWORD|DB_/i.test(String(key))) { credentialReads++; throw new Error('Forbidden credential sentinel'); }
    return undefined;
  } });
  let workflow;
  try {
    workflow = make(input); assert.equal((await workflow.evaluate(hash(input))).status, 'accepted');
    assert.equal(forbidden, 0); assert.equal(credentialReads, 0);
  } finally { workflow?.close(); process.env = environment; fs.readFileSync = originalRead; Module._load = originalLoad; }
});

for (const [label, mutate] of [
  ['mutable array', input => { input.snapshots = [...input.snapshots]; }],
  ['mutable root', input => { input.snapshots = Object.freeze([{ ...input.snapshots[0] }]); }],
  ['mutable nested field', input => { input.snapshots = Object.freeze([Object.freeze({ ...input.snapshots[0], coverage: { status: 'unknown' } })]); }],
  ['approval absent', input => { input.snapshotApproval = null; }],
  ['approval false', input => { input.snapshotApproval.approved = false; }],
  ['fingerprint unapproved', input => { input.snapshotApproval.fingerprints = ['f'.repeat(64)]; }],
  ['stale fingerprint', input => { input.snapshots = freeze([{ ...input.snapshots[0], event: { id: EVENT, title: 'Changed' } }]); }],
  ['cross-event evidence', input => { const c = structuredClone(input.snapshots[0]); c.evidence[0].article_id = 'foreign'; input.snapshots = freeze([c]); }],
  ['invalid preflight', input => { input.config.mode = 'development'; }]
]) test(`${label} is rejected before offline generation`, () => {
  const input = fixture(); mutate(input); assert.throws(() => make(input)); assert.equal(input.state.sends, 0);
});

test('snapshot getters are rejected without evaluating their values', () => {
  const input = fixture(); let accesses = 0;
  input.snapshots = Object.freeze([Object.freeze({ ...input.snapshots[0], get warnings() { accesses++; throw new Error('Must not execute'); } })]);
  assert.throws(() => make(input)); assert.equal(accesses, 0); assert.equal(input.state.sends, 0);
});

function freezeDescriptors(value) {
  if (value && typeof value === 'object') {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, 'value')) freezeDescriptors(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

// Count factory entry as well as sends: invalid representations must fail even
// before the non-persisting generation factory is instantiated.
function assertRejectedBeforeGeneration(input) {
  const read = fs.readFileSync; let generationInitializations = 0;
  global.__snapshotTestFactoryEntry = () => { generationInitializations++; };
  fs.readFileSync = function (file, ...args) {
    const source = read.call(this, file, ...args);
    return String(file).endsWith('summaryGenerationService.js') ? String(source).replace(
      'function createSummaryGenerationService({ contextService, geminiClient, config = summariesConfig }) {',
      'function createSummaryGenerationService({ contextService, geminiClient, config = summariesConfig }) { global.__snapshotTestFactoryEntry();') : source;
  };
  try {
    assert.throws(() => make(input), { code: 'EOFFLINE_SNAPSHOT_INVALID' });
    assert.equal(generationInitializations, 0); assert.equal(input.state.sends, 0);
  } finally { fs.readFileSync = read; delete global.__snapshotTestFactoryEntry; }
}

for (const location of ['warnings', 'warning message', 'provenance', 'provenance source name']) {
  test(`non-enumerable ${location} is rejected before generation or transport`, () => {
    const input = fixture(), context = structuredClone(input.snapshots[0]);
    const [object, key] = location === 'warnings' ? [context, 'warnings'] :
      location === 'warning message' ? [context.warnings[0], 'message'] :
        location === 'provenance' ? [context.evidence[0], 'source_excerpt_provenance'] :
          [context.evidence[0].source_excerpt_provenance, 'source_name'];
    Object.defineProperty(object, key, { value: object[key], enumerable: false });
    const api = loadOfflineSummaryDependencies(Object.freeze({ ...input.config.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 }));
    context.metadata.input_fingerprint = api.buildInputFingerprint(context);
    input.snapshotApproval.fingerprints = [context.metadata.input_fingerprint];
    input.snapshots = freezeDescriptors([context]);
    assertRejectedBeforeGeneration(input);
  });
}

for (const [key, enumerable] of [['extra', true], ['extra', false], ['01', true], ['-1', true], ['1.0', true], ['4294967295', true]]) {
  test(`custom array property ${key}, enumerable=${enumerable}, is rejected`, () => {
    const input = fixture(), context = structuredClone(input.snapshots[0]);
    Object.defineProperty(context.warnings, key, { value: { code: 'Synthetic hidden warning' }, enumerable });
    input.snapshots = freezeDescriptors([context]);
    assertRejectedBeforeGeneration(input);
  });
}

test('custom property on snapshot container is rejected before generation', () => {
  const input = fixture(), container = [...input.snapshots];
  container.extra = 'Synthetic omitted metadata'; input.snapshots = Object.freeze(container);
  assertRejectedBeforeGeneration(input);
});

test('previous hidden-warning fingerprint collision cannot reuse snapshot approval', () => {
  const input = fixture();
  const api = loadOfflineSummaryDependencies(Object.freeze({ ...input.config.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 }));
  const hidden = message => {
    const context = structuredClone(input.snapshots[0]);
    Object.defineProperty(context, 'warnings', { value: [{ code: 'SUMMARY_SINGLE_SOURCE', message }], enumerable: false });
    context.metadata.input_fingerprint = api.buildInputFingerprint(context); return freezeDescriptors(context);
  };
  const first = hidden('First synthetic warning'), changed = hidden('Different synthetic warning');
  assert.equal(first.metadata.input_fingerprint, changed.metadata.input_fingerprint);
  input.snapshotApproval.fingerprints = [first.metadata.input_fingerprint];
  for (const context of [first, changed]) {
    input.snapshots = Object.freeze([context]); assertRejectedBeforeGeneration(input);
  }
});

test('supported warning changes produce distinct fingerprints and require new approval', async () => {
  const input = fixture(), context = structuredClone(input.snapshots[0]);
  const api = loadOfflineSummaryDependencies(Object.freeze({ ...input.config.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 }));
  context.warnings[0].message = 'Changed synthetic coverage warning';
  context.metadata.input_fingerprint = api.buildInputFingerprint(context);
  assert.notEqual(context.metadata.input_fingerprint, hash(input));
  const original = input.snapshots[0]; input.snapshots = freezeDescriptors([context]);
  assertRejectedBeforeGeneration(input);
  input.snapshotApproval.fingerprints.push(context.metadata.input_fingerprint);
  input.snapshots = Object.freeze([original, input.snapshots[0]]);
  const workflow = make(input);
  try {
    const first = await workflow.evaluate(original.metadata.input_fingerprint);
    const second = await workflow.evaluate(context.metadata.input_fingerprint);
    assert.equal(first.status, 'accepted'); assert.equal(second.status, 'accepted');
    assert.notDeepEqual(first.warnings, second.warnings);
    assert.deepEqual(await workflow.evaluate(context.metadata.input_fingerprint), second);
    assert.equal(input.state.sends, 2);
  } finally { workflow.close(); }
});

test('frozen snapshot-array accessors and sparse arrays are rejected without invoking getters', () => {
  for (const kind of ['getter', 'sparse']) {
    const input = fixture(); let accesses = 0;
    const array = Array(1);
    if (kind === 'getter') Object.defineProperty(array, '0', { get() { accesses++; throw new Error('Must not execute'); } });
    input.snapshots = Object.freeze(array);
    assert.throws(() => make(input)); assert.equal(accesses, 0); assert.equal(input.state.sends, 0);
  }
});

test('bounded summary attempts reject additional distinct fingerprints independently of dispatch budget', async () => {
  const input = fixture({ count: 2 }); input.config.limits.maxSummaryAttempts = 1;
  const workflow = make(input);
  try {
    assert.equal((await workflow.evaluate(hash(input))).status, 'accepted');
    await assert.rejects(workflow.evaluate(input.snapshots[1].metadata.input_fingerprint), { code: 'ELIVE_ATTEMPT_LIMIT' });
    assert.equal(input.state.sends, 1);
  } finally { workflow.close(); }
});

test('new workflow instances have detached in-memory idempotency state', async () => {
  const input = fixture(), first = make(input), second = make(input);
  try {
    assert.deepEqual(await first.evaluate(hash(input)), await second.evaluate(hash(input)));
    assert.equal(input.state.sends, 2); assert.equal(first.dispatches, 1); assert.equal(second.dispatches, 1);
  } finally { first.close(); second.close(); }
});

test('duplicate snapshots, concurrent calls and repeated runs reuse one fingerprint result deterministically', async () => {
  const input = fixture(); input.snapshots = Object.freeze([input.snapshots[0], input.snapshots[0]]);
  const workflow = make(input);
  try {
    const [first, second] = await Promise.all([workflow.evaluate(hash(input)), workflow.evaluate(hash(input))]);
    assert.deepEqual(first, second); assert.deepEqual(await workflow.evaluate(hash(input)), first);
    first.structured_output.statements[0].text = 'Caller mutation';
    assert.notEqual((await workflow.evaluate(hash(input))).structured_output.statements[0].text, 'Caller mutation');
    assert.equal(input.state.sends, 1);
  } finally { workflow.close(); }
});

for (const [label, options, expected] of [
  ['invalid JSON', { raw: 'SYNTHETIC_SECRET raw response' }, 'failed'],
  ['invalid schema', { raw: '{"unexpected":"SYNTHETIC_SECRET"}' }, 'failed'],
  ['unknown claim', { mutateStatement: s => { s.source_claim_ids = ['foreign']; } }, 'failed'],
  ['unsupported details', { mutateStatement: s => { s.text += ' invented caveat'; } }, 'needs_review'],
  ['missing attribution', { mutateStatement: s => { s.attribution = null; } }, 'needs_review'],
  ['stale provenance', { mutateContext: c => { c.evidence[0].source_excerpt_provenance.source_id = 'foreign'; } }, 'needs_review'],
  ['missing evidence', { mutateContext: c => { c.evidence = []; } }, 'insufficient_grounding']
]) test(`${label} cannot become an accepted evaluation`, async () => {
  const input = fixture(options), workflow = make(input);
  try {
    const result = await workflow.evaluate(hash(input)); assert.equal(result.status, expected);
    assert.equal(result.factual_truth_verified, false); assert.equal(result.persistenceReady, undefined);
    if (expected === 'failed') assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
  } finally { workflow.close(); }
});

test('unknown fingerprint rejects without a dispatch', async () => {
  const input = fixture(), workflow = make(input);
  try { await assert.rejects(workflow.evaluate('f'.repeat(64))); assert.equal(input.state.sends, 0); }
  finally { workflow.close(); }
});

test('shared provider budget denies the second distinct snapshot before transport', async () => {
  const input = fixture({ count: 2, budget: 1 }), workflow = make(input);
  try {
    assert.equal((await workflow.evaluate(hash(input))).status, 'accepted');
    const second = await workflow.evaluate(input.snapshots[1].metadata.input_fingerprint);
    assert.equal(second.status, 'failed'); assert.equal(second.error.code, 'ELIVE_PROVIDER_BUDGET');
    assert.equal(input.state.sends, 1); assert.equal(workflow.dispatches, 1);
    assert.deepEqual(await workflow.evaluate(input.snapshots[1].metadata.input_fingerprint), second);
  } finally { workflow.close(); }
});

test('closed workflow rejects before generation and transport', async () => {
  const input = fixture(), workflow = make(input); workflow.close();
  await assert.rejects(workflow.evaluate(hash(input)), { code: 'ELIVE_PROVIDER_CLOSED' }); assert.equal(input.state.sends, 0);
});

test('timeout consumes one reservation, cancels the signal and never retries', async () => {
  const input = fixture({ timeoutMs: 10, pending: true }), workflow = make(input);
  try {
    const result = await workflow.evaluate(hash(input)); assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'GEMINI_TIMEOUT');
    assert.equal(input.state.signals[0].aborted, true); assert.equal(input.state.sends, 1); assert.equal(workflow.dispatches, 1);
  } finally { workflow.close(); }
});

test('closing cancels outstanding generation and prevents accepting late output', async () => {
  const input = fixture({ pending: true }), workflow = make(input);
  const pending = workflow.evaluate(hash(input)); workflow.close();
  const result = await pending; assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'ELIVE_PROVIDER_CLOSED');
  assert.equal(input.state.signals[0].aborted, true); assert.equal(input.state.sends, 1);
});

test('provider exceptions with sensitive messages and error codes are sanitized', async () => {
  const error = Object.assign(new Error('SYNTHETIC_SECRET header: private response body'), { code: 'GEMINI_SYNTHETIC_SECRET' });
  const input = fixture({ error }), workflow = make(input);
  try {
    const result = await workflow.evaluate(hash(input)); assert.equal(result.error.code, 'EOFFLINE_EVALUATION_FAILED');
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET')); assert.equal(input.state.sends, 1);
  } finally { workflow.close(); }
});

test('new undeclared production imports fail closed before initialization', () => {
  const input = fixture(), read = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    const source = read.call(this, file, ...args);
    return String(file).endsWith('summaryGenerationService.js') ? "require('../config/database');\n" + source : source;
  };
  try { assert.throws(() => make(input), { code: 'EOFFLINE_DEPENDENCY_REJECTED' }); assert.equal(input.state.sends, 0); }
  finally { fs.readFileSync = read; }
});
