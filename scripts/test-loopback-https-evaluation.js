'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSingleRequestHttpsDispatcher } = require('../evaluation/singleRequestHttpsTransport');
const { runLiveEvaluation, AUTHORIZATION } = require('./evaluate-live-summaries');
const cert = fs.readFileSync(path.join(__dirname, '../fixtures/tls/loopback-cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, '../fixtures/tls/loopback-key.pem'), 'utf8');
const MODEL = 'offline-loopback-only';
const response = text => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Local socket lifecycle did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function serverFixture(t, handler) {
  const state = { requests: 0, connections: 0, sockets: new Set(), tlsFailures: 0 };
  const server = https.createServer({ key, cert }, (req, res) => {
    state.requests++;
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['x-goog-api-key'], undefined);
    assert.equal(req.method, 'POST'); assert.equal(req.url, `/v1beta/models/${MODEL}:generateContent`);
    req.resume(); handler(req, res);
  });
  server.on('connection', socket => {
    state.connections++; state.sockets.add(socket); socket.on('close', () => state.sockets.delete(socket));
  });
  server.on('tlsClientError', () => { state.tlsFailures++; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of state.sockets) socket.destroy();
    await closing; await waitFor(() => state.sockets.size === 0);
    assert.equal(server.listening, false);
  });
  const loopback = { port: server.address().port, ca: cert };
  return { state, loopback };
}

function client(t, loopback, overrides = {}) {
  const timeoutMs = overrides.timeoutMs || 2000;
  const dispatcher = createSingleRequestHttpsDispatcher({ executionMode: 'loopback-test', loopback, model: MODEL,
    maxProviderCalls: 2, timeoutMs, ...overrides });
  t.after(() => dispatcher.close());
  const options = { model: MODEL, timeoutMs, maxAttempts: 1, responseMimeType: 'application/json' };
  return { dispatcher, options, send: () => dispatcher.generateText('Synthetic loopback fixture', options) };
}

test('real TLS: each admitted request counted once; concurrent over-budget calls open no sockets', async t => {
  const { state, loopback } = await serverFixture(t, (_, res) => res.end(response('fixture')));
  const { dispatcher, send, options } = client(t, loopback);
  await assert.rejects(dispatcher.generateText('fixture', { ...options, url: 'https://invalid.example' }));
  assert.equal(state.connections, 0); assert.equal(dispatcher.dispatches, 0);
  const results = await Promise.allSettled(Array.from({ length: 5 }, send));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 2);
  assert.equal(results.filter(row => row.reason?.code === 'ELIVE_PROVIDER_BUDGET').length, 3);
  await waitFor(() => state.sockets.size === 0);
  assert.equal(state.requests, 2); assert.equal(state.connections, 2); assert.equal(dispatcher.dispatches, 2);
  assert.equal(state.tlsFailures, 0);
});

test('closed gate and closure during validation open no TLS socket', async t => {
  const { state, loopback } = await serverFixture(t, (_, res) => res.end(response('fixture')));
  const { dispatcher, send, options } = client(t, loopback);
  await assert.rejects(dispatcher.generateText('fixture', { ...options,
    get model() { dispatcher.close(); return MODEL; } }), { code: 'ELIVE_PROVIDER_CLOSED' });
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CLOSED' });
  assert.equal(dispatcher.dispatches, 0); assert.equal(state.connections, 0); assert.equal(state.requests, 0);
});

for (const status of [302, 307, 503]) test(`real TLS: HTTP ${status} does not follow or retry`, async t => {
  const { state, loopback } = await serverFixture(t, (_, res) => {
    res.writeHead(status, { Location: 'https://example.invalid/do-not-follow' }); res.end('Synthetic error');
  });
  const { dispatcher, send } = client(t, loopback, { maxProviderCalls: 1 });
  await assert.rejects(send(), { code: status === 503 ? 'GEMINI_SERVER' : 'ELIVE_HTTPS_REDIRECT' });
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_BUDGET' });
  await waitFor(() => state.sockets.size === 0);
  assert.equal(state.requests, 1); assert.equal(state.connections, 1); assert.equal(dispatcher.dispatches, 1);
});

for (const partial of [false, true]) test(`real TLS timeout terminates ${partial ? 'streamed body' : 'pending response'}`, async t => {
  const { state, loopback } = await serverFixture(t, (_, res) => { if (partial) res.write('{'); });
  const { dispatcher, send } = client(t, loopback, { timeoutMs: 500, maxProviderCalls: 1 });
  await assert.rejects(send(), error => ['GEMINI_TIMEOUT', 'ELIVE_TRANSPORT_ABORTED'].includes(error.code));
  await waitFor(() => state.sockets.size === 0);
  assert.equal(state.requests, 1); assert.equal(dispatcher.dispatches, 1);
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_BUDGET' }); assert.equal(state.connections, 1);
});

test('real TLS cancellation closes the outstanding socket and prohibits late calls', async t => {
  const { state, loopback } = await serverFixture(t, (_, res) => res.write('{'));
  const { dispatcher, send } = client(t, loopback);
  const pending = send(); const rejected = assert.rejects(pending, error =>
    ['ELIVE_PROVIDER_CLOSED', 'ELIVE_TRANSPORT_ABORTED'].includes(error.code));
  await waitFor(() => state.requests === 1); dispatcher.close(); await rejected;
  await waitFor(() => state.sockets.size === 0);
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CLOSED' }); assert.equal(state.connections, 1);
});

for (const kind of ['oversized', 'malformed', 'exact-limit']) test(`real TLS bounded response: ${kind}`, async t => {
  const body = kind === 'oversized' ? 'x'.repeat(1025) : kind === 'malformed' ? 'not JSON' : response('fixture');
  const { state, loopback } = await serverFixture(t, (_, res) => res.end(body));
  const { send } = client(t, loopback, { maxResponseBytes: kind === 'exact-limit' ? Buffer.byteLength(body) : 1024 });
  if (kind === 'exact-limit') assert.equal((await send()).text, 'fixture');
  else await assert.rejects(send(), { code: kind === 'oversized' ? 'ELIVE_HTTPS_RESPONSE_TOO_LARGE' : 'ELIVE_HTTPS_INVALID_RESPONSE' });
  await waitFor(() => state.sockets.size === 0); assert.equal(state.requests, 1); assert.equal(state.connections, 1);
});

test('TLS rejects an untrusted server certificate with zero HTTP requests', async t => {
  const { state, loopback } = await serverFixture(t, (_, res) => res.end(response('fixture')));
  // A distinct certificate is supplied below by the test-only trust fixture.
  const otherCert = fs.readFileSync(path.join(__dirname, '../fixtures/tls/untrusted-cert.pem'), 'utf8');
  const { send } = client(t, { ...loopback, ca: otherCert });
  await assert.rejects(send(), { code: 'ELIVE_HTTPS_REQUEST_ERROR' });
  await waitFor(() => state.sockets.size === 0); assert.equal(state.requests, 0); assert.equal(state.connections, 1);
});

test('loopback settings reject host overrides or non-loopback bindings before sockets', () => {
  for (const loopback of [{ port: 443, ca: cert, host: 'example.invalid' }, { port: 0, ca: cert },
    { port: 443, ca: 'invalid' }, { port: 443, ca: cert + cert }, { port: 443, ca: cert, rejectUnauthorized: false }]) {
    assert.throws(() => createSingleRequestHttpsDispatcher({ executionMode: 'loopback-test', loopback,
      model: MODEL, maxProviderCalls: 1, timeoutMs: 2000 }));
  }
});

function runnerInputs(loopback) {
  const event = '81000000-0000-4000-8000-000000000001', article = '82000000-0000-4000-8000-000000000001';
  const claim = '83000000-0000-4000-8000-000000000001', evidence = '84000000-0000-4000-8000-000000000001';
  const target = { host: 'localhost', port: 3306, database: 'evinews_ai_eval_synthetic_only' };
  const limits = { maxEvents: 1, maxArticles: 1, maxSummaryAttempts: 2, maxProviderCalls: 1 };
  const summary = { model: MODEL, promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2', timeoutMs: 2000 };
  const config = { mode: 'isolated-live', target, eventIds: [event], articles: [{ id: article, event_id: event }],
    attempts: [event, event], limits, summary };
  const approval = { approved: true, targetAllowlist: [target], developmentTarget: { ...target, database: 'evinews_ai' },
    productionTargets: [], productionNotConfigured: true, eventIds: [event], articleIds: [article], limits, summary };
  const text = 'The synthetic library opened.', source = { id: 'fixture-source', name: 'Synthetic Publisher' };
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const context = { event: { id: event, title: 'Synthetic event' }, reports: [{ article_id: article, source }],
    claims: [{ claim_id: claim, article_id: article, claim_text: text, claim_type: 'fact', source }],
    evidence: [{ evidence_id: evidence, claim_id: claim, article_id: article, evidence_text: text, evidence_hash: hash,
      source_grounded: true, exact_source_grounded: true, source_excerpt_provenance: { article_id: article, source_id: source.id,
        source_name: source.name, evidence_hash: hash, source_text_hash: hash } }], contradictions: [], warnings: [],
    coverage: { status: 'unknown' }, metadata: { model: MODEL, prompt_version: summary.promptVersion, contract_version: summary.contractVersion } };
  context.metadata.input_fingerprint = require('../utils/summaryValidation').buildInputFingerprint(context);
  const output = JSON.stringify({ statements: [{ id: 's1', text: source.name + ' excerpt: ' + text, attribution: source.name,
    source_claim_ids: [claim], evidence_ids: [evidence], contradiction_ids: [] }] });
  const state = { initializes: 0, closes: 0, writes: 0 }, rows = [];
  const dependencies = { executionMode: 'loopback-test', httpsTransport: { loopback }, initialize: async () => {
    state.initializes++;
    return { contextService: { buildContextForEvent: async () => structuredClone(context) }, close: async () => { state.closes++; },
      summaryRepository: { transaction: async work => work({ fixtureOnly: true }), findByFingerprint: async () => null,
        findEvent: async () => ({ id: event }), findMemberArticleIds: async () => [article],
        findClaims: async () => [{ id: claim, article_id: article, event_id: event }],
        createSummary: async data => { const row = { ...data, id: '85000000-0000-4000-8000-000000000001' }; rows.push(row); state.writes++; return row; },
        createLinks: async () => {}, findById: async () => rows.at(-1) } };
  } };
  return { config, approval, dependencies, state, output };
}

test('runner uses HTTPS transport with one shared budget across two uncached workflow attempts', async t => {
  let output;
  const { state: server, loopback } = await serverFixture(t, (_, res) => res.end(response(output)));
  const input = runnerInputs(loopback); output = input.output;
  const report = await runLiveEvaluation(input.config, input.approval, input.dependencies, AUTHORIZATION);
  assert.equal(report.complete, false); assert.equal(report.error, 'ELIVE_PROVIDER_BUDGET');
  assert.equal(report.providerDispatches, 1); assert.equal(report.summaryAttempts, 2);
  assert.equal(input.state.writes, 1); assert.equal(input.state.closes, 1);
  await waitFor(() => server.sockets.size === 0);
  assert.equal(server.requests, 1); assert.equal(server.connections, 1);
});

test('runner rejects unsafe preflight and ambiguous transport selection before initialization or sockets', async t => {
  const { state: server, loopback } = await serverFixture(t, (_, res) => res.end(response('fixture')));
  for (const mutate of [input => { input.config.target.database = 'evinews_ai'; },
    input => { input.dependencies.transport = { sendOne() { throw new Error('Must not run'); } }; },
    input => { input.dependencies.httpsTransport.loopback = { ...loopback, host: 'other' }; }]) {
    const input = runnerInputs(loopback); mutate(input);
    await assert.rejects(runLiveEvaluation(input.config, input.approval, input.dependencies, AUTHORIZATION));
    assert.equal(input.state.initializes, 0);
  }
  assert.equal(server.connections, 0); assert.equal(server.requests, 0);
});
