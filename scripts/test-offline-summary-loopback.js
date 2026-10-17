'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { createOfflineSummaryWorkflow } = require('../evaluation/offlineSummaryWorkflow');
const { loadOfflineSummaryDependencies } = require('../evaluation/offlineSummaryDependencies');
// Public test-only TLS material; never application credentials.
const cert = fs.readFileSync(path.join(__dirname, '../fixtures/tls/loopback-cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, '../fixtures/tls/loopback-key.pem'), 'utf8');
const EVENT = '81000000-0000-4000-8000-000000000001', ARTICLE = '82000000-0000-4000-8000-000000000001';
const CLAIM = '83000000-0000-4000-8000-000000000001', EVIDENCE = '84000000-0000-4000-8000-000000000001';
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function input(loopback, { count = 1, budget = 3, timeoutMs = 1500 } = {}) {
  const summary = { model: 'offline-fixture-only', promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2', timeoutMs };
  const api = loadOfflineSummaryDependencies(Object.freeze({ ...summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 }));
  const snapshots = Object.freeze(Array.from({ length: count }, (_, index) => {
    const text = `Synthetic library ${index} opened.`, hash = crypto.createHash('sha256').update(text).digest('hex');
    const source = { id: 'fixture-source', name: 'Synthetic Publisher' };
    const context = { event: { id: EVENT, title: 'Synthetic event' }, reports: [{ article_id: ARTICLE, source }],
      claims: [{ claim_id: CLAIM, article_id: ARTICLE, claim_text: text, claim_type: 'fact', source }],
      evidence: [{ evidence_id: EVIDENCE, claim_id: CLAIM, article_id: ARTICLE, evidence_text: text, evidence_hash: hash,
        source_grounded: true, exact_source_grounded: true, source_excerpt_provenance: { article_id: ARTICLE, source_id: source.id,
          source_name: source.name, evidence_hash: hash, source_text_hash: hash } }], contradictions: [],
      warnings: [{ code: 'SUMMARY_SINGLE_SOURCE', message: 'Synthetic coverage warning.' }], coverage: { status: 'unknown' },
      metadata: { model: summary.model, prompt_version: summary.promptVersion, contract_version: summary.contractVersion } };
    context.metadata.input_fingerprint = api.buildInputFingerprint(context); return freeze(context);
  }));
  const target = { host: 'localhost', port: 3306, database: 'evinews_ai_eval_unused_no_connection' };
  const limits = { maxEvents: 1, maxArticles: 1, maxSummaryAttempts: 3, maxProviderCalls: budget };
  return { config: { mode: 'isolated-live', target, eventIds: [EVENT], articles: [{ id: ARTICLE, event_id: EVENT }], attempts: [EVENT], limits, summary },
    approval: { approved: true, targetAllowlist: [target], developmentTarget: { ...target, database: 'evinews_ai' },
      productionTargets: [], productionNotConfigured: true, eventIds: [EVENT], articleIds: [ARTICLE], limits, summary },
    snapshots, snapshotApproval: { approved: true, fingerprints: snapshots.map(row => row.metadata.input_fingerprint) },
    executionMode: 'loopback-test', httpsTransport: { loopback } };
}
const fingerprint = (row, index = 0) => row.snapshots[index].metadata.input_fingerprint;
function output(index = 0, suffix = '') {
  return JSON.stringify({ statements: [{ id: 's1', text: `Synthetic Publisher excerpt: Synthetic library ${index} opened.${suffix}`,
    source_claim_ids: [CLAIM], evidence_ids: [EVIDENCE], contradiction_ids: [], attribution: 'Synthetic Publisher' }] });
}
const envelope = text => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Local socket lifecycle deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function server(t, handler) {
  const state = { requests: 0, connections: 0, sockets: new Set() };
  const local = https.createServer({ key, cert }, (req, res) => {
    state.requests++;
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['x-goog-api-key'], undefined);
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1beta/models/offline-fixture-only:generateContent');
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => handler(res, body));
  });
  local.on('connection', socket => { state.connections++; state.sockets.add(socket); socket.on('close', () => state.sockets.delete(socket)); });
  local.on('tlsClientError', () => {});
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise(resolve => local.close(resolve));
    for (const socket of state.sockets) socket.destroy();
    await closed; await until(() => state.sockets.size === 0); assert.equal(local.listening, false);
  });
  return { state, loopback: { port: local.address().port, ca: cert } };
}
function workflow(t, row) { const value = createOfflineSummaryWorkflow(row); t.after(() => value.close()); return value; }

test('real TLS generation preserves grounding/warnings and concurrent duplicate idempotency', async t => {
  const local = await server(t, res => res.end(envelope(output()))), row = input(local.loopback), run = workflow(t, row);
  const [a, b] = await Promise.all([run.evaluate(fingerprint(row)), run.evaluate(fingerprint(row))]);
  assert.deepEqual(a, b); assert.equal(a.status, 'accepted'); assert.equal(a.factual_truth_verified, false);
  assert.equal(a.verification_metadata.statements[0].support_basis, 'source_excerpt');
  assert.deepEqual(a.warnings, row.snapshots[0].warnings); assert.equal(a.persistenceReady, undefined); assert.equal(run.persistSummary, undefined);
  assert.deepEqual(await run.evaluate(fingerprint(row)), a);
  assert.equal(run.dispatches, 1); assert.equal(local.state.requests, 1); assert.equal(local.state.connections, 1);
});

test('concurrent distinct snapshots share one budget; exhaustion and closure open no extra socket', async t => {
  const local = await server(t, (res, body) => res.end(envelope(output(body.includes('Synthetic library 1 opened.') ? 1 : 0))));
  const row = input(local.loopback, { count: 3, budget: 2 }), run = workflow(t, row);
  const results = await Promise.all(row.snapshots.map(snapshot => run.evaluate(snapshot.metadata.input_fingerprint)));
  assert.equal(results.filter(result => result.status === 'accepted').length, 2);
  assert.equal(results[2].error.code, 'ELIVE_PROVIDER_BUDGET'); assert.equal(run.dispatches, 2);
  await run.evaluate(fingerprint(row, 2)); run.close(); await assert.rejects(run.evaluate(fingerprint(row)));
  assert.equal(local.state.requests, 2); assert.equal(local.state.connections, 2);
});

test('invalid preflight, bindings, endpoint overrides and closed workflow open no sockets', async t => {
  const local = await server(t, res => res.end(envelope(output())));
  for (const mutate of [
    row => { row.snapshotApproval.approved = false; }, row => { row.snapshots = [...row.snapshots]; },
    row => { row.executionMode = 'live'; }, row => { row.transport = { sendOne() {} }; },
    row => { row.httpsTransport.host = 'external.invalid'; }, row => { row.httpsTransport.timeoutMs = 1; },
    row => { row.httpsTransport.maxProviderCalls = 24; }, row => { row.httpsTransport.loopback.port = 0; },
    row => { row.httpsTransport.loopback.ca = 'not a certificate'; }, row => { row.config.limits.maxProviderCalls = 25; }
  ]) { const row = input({ ...local.loopback }); mutate(row); assert.throws(() => createOfflineSummaryWorkflow(row)); }
  const row = input(local.loopback), run = workflow(t, row); run.close(); await assert.rejects(run.evaluate(fingerprint(row)));
  assert.equal(run.dispatches, 0); assert.equal(local.state.connections, 0);
});

for (const status of [302, 307, 503]) test(`HTTP ${status} has no followup or retry`, async t => {
  const local = await server(t, res => { res.writeHead(status, { Location: 'https://external.invalid/' }); res.end('Sensitive body must not escape'); });
  const row = input(local.loopback), run = workflow(t, row), result = await run.evaluate(fingerprint(row));
  assert.equal(result.status, 'failed'); assert.equal(JSON.stringify(result).includes('Sensitive body'), false);
  assert.equal(run.dispatches, 1); assert.equal(local.state.requests, 1); assert.equal(local.state.connections, 1);
});

for (const kind of ['timeout', 'cancel']) test(`${kind} destroys pending response and consumes one reservation`, async t => {
  const local = await server(t, res => { res.writeHead(200); res.write('{'); });
  const row = input(local.loopback, { timeoutMs: 500 }), run = workflow(t, row), pending = run.evaluate(fingerprint(row));
  await until(() => local.state.requests === 1);
  if (kind === 'cancel') run.close();
  const result = await pending; assert.equal(result.status, 'failed');
  await until(() => local.state.sockets.size === 0);
  assert.equal(run.dispatches, 1); assert.equal(local.state.requests, 1); assert.equal(local.state.connections, 1);
});

for (const [label, body] of [
  ['oversize', 'x'.repeat(2048)], ['invalid envelope', '{}'], ['invalid JSON', envelope('not JSON')],
  ['invalid schema', envelope('{}')], ['unsupported caveat', envelope(output(0, ' Unsupported conclusion.'))]
]) test(`${label} is never accepted`, async t => {
  const local = await server(t, res => res.end(body)), row = input(local.loopback);
  row.httpsTransport.maxResponseBytes = 1024;
  const run = workflow(t, row), result = await run.evaluate(fingerprint(row));
  assert.notEqual(result.status, 'accepted'); assert.equal(result.persistenceReady, undefined);
  assert.equal(run.dispatches, 1); assert.equal(local.state.requests, 1);
  await until(() => local.state.sockets.size === 0);
});

test('wrong certificate fails TLS without an HTTP request or retry', async t => {
  const local = await server(t, res => res.end(envelope(output()))), row = input(local.loopback);
  row.httpsTransport.loopback = { ...local.loopback, ca: fs.readFileSync(path.join(__dirname, '../fixtures/tls/untrusted-cert.pem'), 'utf8') };
  const run = workflow(t, row); assert.equal((await run.evaluate(fingerprint(row))).status, 'failed');
  await until(() => local.state.sockets.size === 0);
  assert.equal(run.dispatches, 1); assert.equal(local.state.connections, 1); assert.equal(local.state.requests, 0);
});

test('approved snapshot without exact provenance cannot produce accepted output', async t => {
  const local = await server(t, res => res.end(envelope(output()))), row = input(local.loopback);
  const snapshot = structuredClone(row.snapshots[0]);
  delete snapshot.evidence[0].source_excerpt_provenance;
  snapshot.evidence[0].exact_source_grounded = false;
  snapshot.claims[0].claim_text = 'Synthetic extracted claim differs from the original excerpt.';
  const api = loadOfflineSummaryDependencies(Object.freeze({ ...row.config.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 }));
  snapshot.metadata.input_fingerprint = api.buildInputFingerprint(snapshot);
  row.snapshots = freeze([snapshot]); row.snapshotApproval.fingerprints = [snapshot.metadata.input_fingerprint];
  const run = workflow(t, row), result = await run.evaluate(fingerprint(row));
  assert.notEqual(result.status, 'accepted'); assert.equal(result.persistenceReady, undefined);
  assert.equal(run.dispatches, 1); assert.equal(local.state.requests, 1);
});

test('loopback path never initializes forbidden dependencies or reads credentials/environment files', async t => {
  const local = await server(t, res => res.end(envelope(output()))), row = input(local.loopback);
  const load = Module._load, read = fs.readFileSync, environment = process.env;
  let forbidden = 0, run;
  const deny = () => { forbidden++; throw new Error('Forbidden offline dependency'); };
  Module._load = function (name, ...args) {
    if (/dotenv|sequelize|mysql|genai|geminiClientService|summaryWorkflowService|summaryQueryService|summaryContextService|models|config[\\/](db|database)/i.test(name)) return deny();
    return load.call(this, name, ...args);
  };
  fs.readFileSync = function (file, ...args) { if (/(?:^|[\\/])\.env(?:$|\.)/.test(String(file))) return deny(); return read.call(this, file, ...args); };
  process.env = new Proxy(Object.create(null), { get(_, name) { if (/GEMINI|KEY|TOKEN|PASSWORD|DB_/i.test(String(name))) return deny(); return undefined; } });
  try {
    run = createOfflineSummaryWorkflow(row); assert.equal((await run.evaluate(fingerprint(row))).status, 'accepted'); assert.equal(forbidden, 0);
  } finally { run?.close(); process.env = environment; fs.readFileSync = read; Module._load = load; }
});
