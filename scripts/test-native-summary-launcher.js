'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const { launchNativeSummary, readHiddenSecret } = require('../evaluation/nativeSummaryLauncher');
const { PROTOCOL, startNativeWorker, prepareNativeManifest, validResult } = require('../evaluation/nativeSummaryWorker');
const { loadOfflineSummaryDependencies } = require('../evaluation/offlineSummaryDependencies');
const EVENT = '81000000-0000-4000-8000-000000000001', ARTICLE = '82000000-0000-4000-8000-000000000001';
const CLAIM = '83000000-0000-4000-8000-000000000001', EVIDENCE = '84000000-0000-4000-8000-000000000001';
const SECRET = 'DUMMY_NATIVE_EVALUATION_ONLY';
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  const summary = { model: 'offline-native-fixture', promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2', timeoutMs: 20000 };
  const text = 'Synthetic library opened.', hash = crypto.createHash('sha256').update(text).digest('hex');
  const source = { id: 'fixture-source', name: 'Synthetic Publisher' };
  const snapshot = { event: { id: EVENT, title: 'Synthetic event' }, reports: [{ article_id: ARTICLE, source }],
    claims: [{ claim_id: CLAIM, article_id: ARTICLE, claim_text: text, claim_type: 'fact', source }],
    evidence: [{ evidence_id: EVIDENCE, claim_id: CLAIM, article_id: ARTICLE, evidence_text: text, evidence_hash: hash,
      source_grounded: true, exact_source_grounded: true, source_excerpt_provenance: { article_id: ARTICLE, source_id: source.id,
        source_name: source.name, evidence_hash: hash, source_text_hash: hash } }], contradictions: [],
    warnings: [{ code: 'SUMMARY_SINGLE_SOURCE', message: 'Synthetic coverage warning.' }], coverage: { status: 'unknown' },
    metadata: { model: summary.model, prompt_version: summary.promptVersion, contract_version: summary.contractVersion } };
  const api = loadOfflineSummaryDependencies({ ...summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 });
  snapshot.metadata.input_fingerprint = api.buildInputFingerprint(snapshot);
  const limits = { maxEvents: 1, maxArticles: 1, maxSummaryAttempts: 1, maxProviderCalls: 1 };
  const target = { host: 'localhost', port: 3306, database: 'evinews_ai_eval_unused_no_connection' };
  return { config: { mode: 'isolated-live', target, eventIds: [EVENT], articles: [{ id: ARTICLE, event_id: EVENT }], attempts: [EVENT], limits, summary },
    approval: { approved: true, targetAllowlist: [target], developmentTarget: { ...target, database: 'evinews_ai' }, productionTargets: [],
      productionNotConfigured: true, eventIds: [EVENT], articleIds: [ARTICLE], limits, summary }, snapshots: [snapshot],
    snapshotApproval: { approved: true, fingerprints: [snapshot.metadata.input_fingerprint] },
    nativeApproval: { approved: true, action: 'gemini-generateContent-once', model: summary.model,
      fingerprint: snapshot.metadata.input_fingerprint, promptVersion: summary.promptVersion, contractVersion: summary.contractVersion } };
}
function tty(auto = true) {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false; input.paused = true;
  input.isPaused = () => input.paused; input.pause = () => { input.paused = true; }; input.resume = () => { input.paused = false; };
  input.states = []; input.setRawMode = value => {
    input.isRaw = value; input.states.push(value);
    if (value && auto) queueMicrotask(() => input.emit('data', Buffer.from(SECRET + '\r')));
  };
  return input;
}
function transport(behavior = {}) {
  const state = { requests: 0, destroyed: 0, responsesDestroyed: 0, settings: null };
  const request = (settings, callback) => {
    state.requests++; state.settings = settings;
    assert.equal(settings.hostname, 'generativelanguage.googleapis.com'); assert.equal(settings.port, 443);
    assert.equal(settings.rejectUnauthorized, true); assert.equal(settings.agent, false);
    assert.equal(settings.headers['x-goog-api-key'], SECRET);
    const req = new EventEmitter(); req.destroy = () => { state.destroyed++; };
    req.end = () => {
      if (behavior.pending) return;
      queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = behavior.status || 200;
        res.destroy = () => { state.responsesDestroyed++; };
        callback(res); if (behavior.status) return;
        const statement = { id: 's1', text: 'Synthetic Publisher excerpt: Synthetic library opened.' + (behavior.unsupported ? ' Unfounded detail.' : ''),
          source_claim_ids: [CLAIM], evidence_ids: [EVIDENCE], contradiction_ids: [], attribution: 'Synthetic Publisher' };
        const body = behavior.malformedSchema ? JSON.stringify({ statements: [{ text: 'DUMMY_MALFORMED_OUTPUT' }] }) :
          behavior.reflection ? '{"statements":[],"note":"' + Array.from(SECRET, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}' :
          JSON.stringify({ statements: [statement] });
        res.emit('data', Buffer.from(behavior.oversized ? 'x'.repeat(262145) : JSON.stringify({ candidates: [{ content: { parts: [{ text: body }] } }] })));
        res.emit('end');
      });
    }; return req;
  };
  return { state, request };
}
function harness(options = {}) {
  const lifecycle = new EventEmitter(), child = new EventEmitter(), channel = new EventEmitter(), input = tty(options.auto !== false);
  const clock = { timers: [], setTimeout(fn, ms) { const timer = { fn, ms, live: true }; this.timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.live = false; }, fire(ms) { for (const timer of [...this.timers]) if (timer.live && timer.ms === ms) { timer.live = false; timer.fn(); } } };
  const sent = [], received = []; let forks = 0, kills = 0, worker, unrefs = 0, disconnects = 0;
  child.connected = true;
  child.send = (value, callback) => {
    sent.push(structuredClone(value)); queueMicrotask(() => {
      if (!(options.ignoreCancel && value.type === 'CANCEL')) channel.emit('message', structuredClone(value));
      callback?.(null);
    });
  };
  child.kill = () => {
    kills++;
    if (options.kill === 'false') return false;
    if (options.kill === 'throw') throw new Error(SECRET);
    if (options.kill !== 'pending') queueMicrotask(() => { worker?.close(); child.emit('exit', null, 'SIGKILL'); });
    return true;
  };
  child.unref = () => { unrefs++; };
  child.disconnect = () => { disconnects++; child.connected = false; channel.emit('disconnect'); };
  channel.send = value => { received.push(structuredClone(value)); queueMicrotask(() => child.emit('message', value)); };
  channel.disconnect = () => { queueMicrotask(() => { child.emit('disconnect'); child.emit('exit', 0, null); }); };
  const dependencies = { clock, lifecycle, fork(file, args, settings) {
    forks++; assert.equal(path.isAbsolute(file), true); assert.ok(file.endsWith('nativeSummaryWorker.js'));
    assert.deepEqual(args, ['--authorized-worker']); assert.deepEqual(settings.execArgv, []);
    assert.deepEqual(settings.stdio, ['ignore', 'ignore', 'ignore', 'ipc']); assert.equal(settings.windowsHide, true);
    assert.ok(Object.keys(settings.env).every(key => ['NODE_ENV', 'TZ', 'NO_COLOR', 'SystemRoot'].includes(key)));
    if (!options.noWorker) worker = startNativeWorker(channel, new EventEmitter()); return child;
  } };
  return { dependencies, input, child, channel, clock, lifecycle, sent, received, get forks() { return forks; }, get kills() { return kills; },
    get unrefs() { return unrefs; }, get disconnects() { return disconnects; }, close() { worker?.close(); } };
}
async function run(options = {}) {
  const fake = transport(options), original = https.request; https.request = fake.request;
  const h = harness(options);
  try {
    const result = await launchNativeSummary({ manifest: fixture(), authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
    assert.equal(JSON.stringify(result).includes(SECRET), false); assert.equal(result.factual_truth_verified, false);
    assert.deepEqual(h.input.states, [true, false]); assert.equal(h.input.paused, true);
    return { result, fake, h };
  } finally { h.close(); https.request = original; }
}

test('native parent/worker handshake uses one reservation/request with no returned content', async () => {
  const { result, fake, h } = await run();
  assert.equal(result.status, 'accepted'); assert.equal(result.dispatches, 1); assert.equal(fake.state.requests, 1); assert.equal(h.forks, 1);
  assert.deepEqual(h.sent.map(row => row.type || 'SECRET'), ['INIT', 'EXECUTE', 'SECRET']);
  assert.deepEqual(h.received.map(row => row.type), ['PREFLIGHT_READY', 'PREFLIGHT_PASSED', 'RESULT']);
  assert.equal(result.structured_output, undefined); assert.equal(result.validation, 'PASS'); assert.equal(result.grounding, 'PASS');
});
for (const [name, behavior, category] of [['server error', { status: 503 }, 'HTTP'], ['redirect', { status: 302 }, 'HTTP'],
  ['encoded reflection', { reflection: true }, 'RESPONSE_PARSE'], ['response size', { oversized: true }, 'RESPONSE_LIMIT']]) {
  test(`native ${name} is sanitized and never retried`, async () => {
    const { result, fake } = await run(behavior); assert.equal(result.status, 'failed');
    assert.equal(result.dispatches, 1); assert.equal(fake.state.requests, 1); assert.equal(result.diagnostic.category, category);
  });
}
test('native grounding rejection remains non-persisting and returns no statement text', async () => {
  const { result } = await run({ unsupported: true }); assert.equal(result.status, 'needs_review'); assert.equal(result.grounding, 'FAIL');
  assert.equal(result.validation, 'PASS');
  assert.equal(JSON.stringify(result).includes('Unfounded'), false);
});
test('schema failure reports validation FAIL without returning malformed output, prompt or credential', async () => {
  const { result, fake } = await run({ malformedSchema: true });
  assert.equal(result.status, 'failed'); assert.equal(result.validation, 'FAIL'); assert.equal(result.grounding, 'NOT_REACHED');
  assert.equal(result.dispatches, 1); assert.equal(fake.state.requests, 1); assert.equal(result.diagnostic, null);
  for (const sensitive of [SECRET, 'DUMMY_MALFORMED_OUTPUT', 'Synthetic library opened.', 'Evidence-grounded news summary.']) {
    assert.equal(JSON.stringify(result).includes(sensitive), false);
  }
});

function approveChangedSnapshot(manifest) {
  const api = loadOfflineSummaryDependencies({ ...manifest.config.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 });
  const hash = api.buildInputFingerprint(manifest.snapshots[0]);
  manifest.snapshots[0].metadata.input_fingerprint = hash;
  manifest.snapshotApproval.fingerprints = [hash]; manifest.nativeApproval.fingerprint = hash;
}
for (const [name, mutate] of [
  ['no claims', m => { m.snapshots[0].claims = []; m.snapshots[0].evidence = []; }],
  ['no evidence', m => { m.snapshots[0].evidence = []; }],
  ['ungrounded evidence', m => { m.snapshots[0].evidence[0].source_grounded = false; }],
  ['empty evidence', m => { m.snapshots[0].evidence[0].evidence_text = ''; }],
  ['stale evidence hash', m => { m.snapshots[0].evidence[0].evidence_hash = 'f'.repeat(64); }],
  ['missing source name', m => { m.snapshots[0].claims[0].source.name = ''; }]
]) test(`preflight ${name} returns insufficient grounding without collecting or delivering credentials`, async () => {
  const manifest = fixture(); mutate(manifest); approveChangedSnapshot(manifest);
  const fake = transport(), original = https.request; https.request = fake.request;
  const h = harness({ auto: false });
  try {
    const result = await launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
    assert.equal(result.status, 'insufficient_grounding'); assert.equal(result.dispatches, 0); assert.equal(fake.state.requests, 0);
    assert.equal(result.model, manifest.nativeApproval.model); assert.equal(result.fingerprint, manifest.nativeApproval.fingerprint);
    assert.deepEqual(h.input.states, []); assert.equal(h.input.listenerCount('data'), 0); assert.equal(h.forks, 1); assert.equal(h.kills, 0);
    assert.deepEqual(h.sent.map(row => row.type || 'SECRET'), ['INIT']); assert.deepEqual(h.received.map(row => row.type), ['RESULT']);
    assert.equal(result.cleanup.exit_confirmed, true); assert.equal(result.factual_truth_verified, false);
  } finally { h.close(); https.request = original; }
});
for (const [name, change] of [
  ['nonzero insufficient grounding', { dispatches: 1 }], ['premature accepted', { status: 'accepted', dispatches: 1, validation: 'PASS', grounding: 'PASS' }],
  ['success alias', { status: 'success' }], ['wrong fingerprint', { fingerprint: 'f'.repeat(64) }],
  ['wrong model', { model: 'wrong-model' }], ['unexpected status', { status: 'needs_review' }],
  ['malformed result', { unexpected: SECRET }], ['unexpected diagnostic', { diagnostic: { category: 'HTTP', status: 200 } }],
  ['validation already reached', { validation: 'PASS' }], ['nonzero failed result', { status: 'failed', dispatches: 1 }]
]) test(`pre-credential ${name} is rejected without input, delivery or another worker`, async () => {
  const manifest = fixture(), h = harness({ noWorker: true, auto: false });
  const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
  const result = { status: 'insufficient_grounding', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint,
    dispatches: 0, validation: 'NOT_REACHED', grounding: 'NOT_REACHED', factual_truth_verified: false, diagnostic: null, ...change };
  h.child.emit('message', { protocol: PROTOCOL, type: 'RESULT', result }); await tick(); h.clock.fire(1000);
  const returned = await pending;
  assert.equal(returned.status, 'failed'); assert.equal(h.forks, 1); assert.equal(h.kills, 1);
  assert.deepEqual(h.input.states, []); assert.equal(h.sent.filter(row => row.type === 'EXECUTE' || row.secret).length, 0);
  assert.equal(JSON.stringify(returned).includes(SECRET), false);
});

async function watchdogHarness(kill) {
  const manifest = fixture(), h = harness({ noWorker: true, kill });
  let settled = false;
  const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
  void pending.then(() => { settled = true; });
  h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint });
  await tick();
  h.child.emit('message', { protocol: 'evinews-evaluation-secret-v1', type: 'PREFLIGHT_PASSED' }); await tick();
  h.clock.fire(25000); await tick(); assert.equal(settled, false); assert.equal(h.kills, 0);
  return { h, pending, get settled() { return settled; } };
}
function assertSingleRun(h) {
  assert.equal(h.forks, 1); assert.equal(h.kills, 1);
  assert.equal(h.sent.filter(row => row.type === 'EXECUTE').length, 1);
  assert.equal(h.sent.filter(row => row.secret).length, 1);
  assert.equal(h.sent.filter(row => row.type === 'CANCEL').length, 1);
}
for (const kill of ['false', 'throw']) test(`watchdog ${kill} kill reports sanitized termination failure and releases parent references`, async () => {
  const state = await watchdogHarness(kill); state.h.clock.fire(1000);
  const result = await state.pending;
  assert.equal(result.status, 'failed'); assert.deepEqual(result.cleanup, { termination: 'FAILED', exit_confirmed: false, code: 'ENATIVE_TERMINATION_FAILED' });
  assert.equal(state.h.unrefs, 1); assert.equal(state.h.disconnects, 1); assertSingleRun(state.h);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  state.h.child.emit('error', new Error(SECRET)); state.h.child.emit('exit', 1, null);
  assert.equal(result.cleanup.exit_confirmed, false);
});
test('successful kill request waits for delayed actual exit before confirming cleanup', async () => {
  const state = await watchdogHarness('pending'); state.h.clock.fire(1000); await tick();
  assert.equal(state.settled, false); assert.equal(state.h.kills, 1);
  state.h.child.emit('exit', null, 'SIGKILL'); const result = await state.pending;
  assert.deepEqual(result.cleanup, { termination: 'CONFIRMED', exit_confirmed: true, code: null }); assertSingleRun(state.h);
  assert.equal(state.h.unrefs, 0);
});
test('successful kill without exit has a bounded unconfirmed-cleanup result', async () => {
  const state = await watchdogHarness('pending'); state.h.clock.fire(1000); await tick(); assert.equal(state.settled, false);
  state.h.clock.fire(1000); const result = await state.pending;
  assert.deepEqual(result.cleanup, { termination: 'REQUESTED', exit_confirmed: false, code: 'ENATIVE_EXIT_UNCONFIRMED' });
  assert.equal(state.h.unrefs, 1); assert.equal(state.h.disconnects, 1); assertSingleRun(state.h);
  assert.equal(state.h.clock.timers.filter(timer => timer.live).length, 0);
});
test('ordinary asynchronous kill completion confirms actual exit, not the kill return', async () => {
  const state = await watchdogHarness(); state.h.clock.fire(1000); assert.equal(state.settled, false);
  const result = await state.pending;
  assert.deepEqual(result.cleanup, { termination: 'CONFIRMED', exit_confirmed: true, code: null }); assertSingleRun(state.h);
});
test('close confirms termination when the child emits no separate exit event', async () => {
  const state = await watchdogHarness('pending'); state.h.clock.fire(1000); await tick(); assert.equal(state.settled, false);
  state.h.child.emit('close', null, 'SIGKILL'); const result = await state.pending;
  assert.deepEqual(result.cleanup, { termination: 'CONFIRMED', exit_confirmed: true, code: null }); assertSingleRun(state.h);
});
test('cleanup escalation never dispatches again and disconnect aborts its only pending request', async () => {
  const fake = transport({ pending: true }), original = https.request; https.request = fake.request;
  const h = harness({ kill: 'pending', ignoreCancel: true });
  try {
    const pending = launchNativeSummary({ manifest: fixture(), authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
    await tick(); assert.equal(fake.state.requests, 1);
    h.clock.fire(25000); await tick(); h.clock.fire(1000); await tick(); h.clock.fire(1000);
    const result = await pending; await tick();
    assert.equal(result.cleanup.code, 'ENATIVE_EXIT_UNCONFIRMED'); assert.equal(result.cleanup.exit_confirmed, false);
    assert.equal(fake.state.requests, 1); assert.ok(fake.state.destroyed >= 1); assertSingleRun(h);
  } finally { h.close(); https.request = original; }
});
test('cooperative cancellation confirms exit without requesting force termination', async () => {
  const fake = transport({ pending: true }), original = https.request; https.request = fake.request;
  const h = harness(), abort = new AbortController();
  try {
    const pending = launchNativeSummary({ manifest: fixture(), authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input, signal: abort.signal }, h.dependencies);
    await tick(); assert.equal(fake.state.requests, 1); abort.abort();
    const result = await pending;
    assert.deepEqual(result.cleanup, { termination: 'NOT_REQUESTED', exit_confirmed: true, code: null });
    assert.equal(h.kills, 0); assert.equal(h.forks, 1); assert.equal(fake.state.requests, 1); assert.ok(fake.state.destroyed >= 1);
  } finally { h.close(); https.request = original; }
});
for (const [name, change] of [
  ['nonzero insufficient grounding', { dispatches: 1 }],
  ['premature accepted', { status: 'accepted', dispatches: 1, validation: 'PASS', grounding: 'PASS' }],
  ['wrong scope', { fingerprint: 'f'.repeat(64) }]
]) test(`after EXECUTE, pre-credential ${name} cannot authorize delivery or another dispatch`, async () => {
  const manifest = fixture(), h = harness({ noWorker: true });
  const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
  h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint });
  await tick();
  h.child.emit('message', { protocol: PROTOCOL, type: 'RESULT', result: {
    status: 'insufficient_grounding', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint,
    dispatches: 0, validation: 'NOT_REACHED', grounding: 'NOT_REACHED', factual_truth_verified: false, diagnostic: null, ...change
  } });
  await tick(); h.clock.fire(1000); assert.equal((await pending).status, 'failed');
  assert.equal(h.forks, 1); assert.equal(h.kills, 1); assert.equal(h.sent.filter(row => row.type === 'EXECUTE').length, 1);
  assert.equal(h.sent.filter(row => row.secret).length, 0);
});
for (const [name, mutate] of [
  ['model', m => { m.nativeApproval.model = 'mismatch'; }], ['fingerprint', m => { m.nativeApproval.fingerprint = 'f'.repeat(64); }],
  ['version', m => { m.nativeApproval.contractVersion = 'phase7-summary-v1'; }], ['approval', m => { m.nativeApproval.approved = false; }],
  ['budget', m => { m.config.limits.maxProviderCalls = 2; }], ['timeout', m => { m.config.summary = { ...m.config.summary, timeoutMs: 19999 }; }],
  ['mutable accessor', m => { Object.defineProperty(m.snapshots[0], 'warnings', { get() { throw new Error('Must not read'); }, enumerable: true }); }],
  ['nonenumerable', m => { Object.defineProperty(m.snapshots[0], 'hidden', { value: 'ambiguous' }); }],
  ['array custom field', m => { m.snapshots.extra = 1; }], ['unknown field', m => { m.credential = SECRET; }]
]) test(`native preflight rejects ${name} before fork, input or request`, () => {
  const manifest = fixture(); mutate(manifest); const h = harness();
  assert.throws(() => launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies));
  assert.equal(h.forks, 0); assert.equal(h.input.states.length, 0);
});
test('authorization and trusted TTY required, even with valid manifest', () => {
  const h = harness(); assert.throws(() => launchNativeSummary({ manifest: fixture(), input: h.input }, h.dependencies));
  h.input.isTTY = false;
  assert.throws(() => launchNativeSummary({ manifest: fixture(), authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies));
  assert.equal(h.forks, 0);
});
test('worker independently copies/freezes snapshots without reading accessor values', () => {
  const manifest = fixture(), channel = new EventEmitter(); channel.send = () => {};
  const prepared = prepareNativeManifest(manifest, channel);
  try {
    assert.equal(Object.isFrozen(prepared.manifest.snapshots[0].evidence[0].source_excerpt_provenance), true);
    manifest.snapshots[0].warnings[0].message = 'Changed original';
    assert.notEqual(prepared.manifest.snapshots[0].warnings[0].message, 'Changed original'); assert.equal(prepared.workflow.dispatches, 0);
  } finally { prepared.workflow.close(); }
});

for (const name of ['EXECUTE before INIT', 'credential before INIT', 'credential before EXECUTE', 'duplicate EXECUTE', 'duplicate credential']) {
  test(`worker rejects ${name} and closes before any second request`, async () => {
    const fake = transport({ pending: true }), original = https.request; https.request = fake.request;
    const channel = new EventEmitter(), received = []; let disconnects = 0;
    channel.send = value => received.push(value); channel.disconnect = () => { disconnects++; };
    const worker = startNativeWorker(channel, new EventEmitter());
    try {
      const execute = { protocol: PROTOCOL, type: 'EXECUTE' }, credential = { protocol: 'evinews-evaluation-secret-v1', secret: SECRET };
      if (!name.endsWith('before INIT')) channel.emit('message', { protocol: PROTOCOL, type: 'INIT', manifest: fixture() });
      if (name.startsWith('duplicate')) channel.emit('message', execute);
      if (name === 'duplicate credential') { channel.emit('message', credential); await tick(); }
      channel.emit('message', name === 'EXECUTE before INIT' || name === 'duplicate EXECUTE' ? execute : credential);
      await tick();
      assert.equal(disconnects, 1); assert.equal(received.at(-1).type, 'FAILED'); assert.ok(fake.state.requests <= 1);
      if (name !== 'duplicate credential') assert.equal(fake.state.requests, 0);
    } finally { worker.close(); https.request = original; }
  });
}

for (const name of ['premature exit', 'disconnect', 'error', 'parent termination', 'watchdog', 'startup timeout', 'unexpected ready']) {
  test(`parent ${name} fails closed without redelivery or another worker`, async () => {
    const h = harness({ noWorker: true, auto: false });
    const pending = launchNativeSummary({ manifest: fixture(), authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
    if (name === 'startup timeout') h.clock.fire(10000);
    else if (name === 'unexpected ready') h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: 'wrong', fingerprint: 'f'.repeat(64) });
    else if (name === 'premature exit') h.child.emit('exit', 0, null);
    else if (name === 'disconnect') h.child.emit('disconnect');
    else if (name === 'error') h.child.emit('error', new Error(SECRET));
    else if (name === 'parent termination') h.lifecycle.emit('SIGTERM');
    else {
      const manifest = fixture(); h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.config.summary.model, fingerprint: manifest.nativeApproval.fingerprint });
      h.input.emit('data', Buffer.from(SECRET + '\r')); await tick(); h.clock.fire(25000);
    }
    h.clock.fire(1000); const result = await pending;
    assert.equal(result.status, 'failed'); assert.equal(h.forks, 1); assert.ok(h.kills <= 1);
    assert.equal(h.sent.filter(row => row.secret).length, 0); assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(h.input.isRaw, false);
  });
}
test('parent abort destroys a pending admitted request with one reservation', async () => {
  const fake = transport({ pending: true }), original = https.request; https.request = fake.request;
  const h = harness(), abort = new AbortController();
  try {
    const pending = launchNativeSummary({ manifest: fixture(), authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input, signal: abort.signal }, h.dependencies);
    await tick(); assert.equal(fake.state.requests, 1); abort.abort(); await tick(); h.clock.fire(1000);
    assert.equal((await pending).status, 'failed'); assert.ok(fake.state.destroyed >= 1); assert.equal(fake.state.requests, 1);
  } finally { h.close(); https.request = original; }
});
for (const [name, bytes] of [['success', 'dummy\r'], ['cancel', '\u0003'], ['invalid byte', 'bad secret\r'], ['empty', '\r'], ['oversize', 'x'.repeat(513)]]) {
  test(`hidden input ${name} always restores terminal and detaches listeners`, async () => {
    const input = tty(false), abort = new AbortController(), pending = readHiddenSecret(input, abort.signal);
    input.emit('data', Buffer.from(bytes));
    if (name === 'success') { const buffer = await pending; assert.equal(buffer.toString(), 'dummy'); buffer.fill(0); assert.ok(buffer.every(b => b === 0)); }
    else await assert.rejects(pending);
    assert.equal(input.isRaw, false); assert.equal(input.paused, true); assert.equal(input.listenerCount('data'), 0);
  });
}
test('hidden input backspace and abort preserve original raw mode', async () => {
  const input = tty(false); input.isRaw = true; input.paused = false;
  const abort = new AbortController(), pending = readHiddenSecret(input, abort.signal); input.emit('data', Buffer.from('dummy\b'));
  abort.abort(); await assert.rejects(pending); assert.equal(input.isRaw, true); assert.equal(input.paused, false);
});
test('hidden input has a separate 120-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = tty(false), pending = readHiddenSecret(input, new AbortController().signal);
  t.mock.timers.tick(120000); await assert.rejects(pending, { code: 'ENATIVE_INPUT_TIMEOUT' }); assert.equal(input.isRaw, false);
});
test('terminal close without end immediately restores state and rejects hidden input', async () => {
  const input = tty(false), abort = new AbortController(), pending = readHiddenSecret(input, abort.signal);
  try {
    input.emit('close');
    assert.equal(input.isRaw, false);
    await assert.rejects(pending, { code: 'ENATIVE_TTY_FAILED' });
    assert.equal(input.paused, true);
    for (const event of ['data', 'error', 'end', 'close']) assert.equal(input.listenerCount(event), 0);
  } finally { abort.abort(); await pending.catch(() => {}); }
});
test('terminal close cancels the parent before EXECUTE or credential delivery', async () => {
  const h = harness({ auto: false, noWorker: true }), manifest = fixture();
  const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
  h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint });
  h.input.emit('close'); await tick(); h.clock.fire(1000);
  assert.equal((await pending).status, 'failed'); assert.equal(h.forks, 1); assert.equal(h.kills, 1);
  assert.deepEqual(h.sent.map(value => value.type), ['INIT', 'CANCEL']); assert.equal(h.input.isRaw, false);
});
for (const name of ['early credential request', 'duplicate readiness', 'wrong protocol', 'unexpected run identifier', 'early credential payload']) {
  test(`parent rejects ${name} before EXECUTE or secret delivery`, async () => {
    const h = harness({ auto: false, noWorker: true }), manifest = fixture();
    const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
    const ready = { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint };
    if (name !== 'early credential request') h.child.emit('message', ready);
    const value = name === 'early credential request' ? { protocol: 'evinews-evaluation-secret-v1', type: 'PREFLIGHT_PASSED' } :
      name === 'duplicate readiness' ? ready : name === 'wrong protocol' ? { ...ready, protocol: 'wrong-protocol' } :
        name === 'unexpected run identifier' ? { ...ready, run_id: 'wrong-run' } : { protocol: 'evinews-evaluation-secret-v1', secret: SECRET };
    h.child.emit('message', value); await tick(); h.clock.fire(1000);
    const result = await pending;
    assert.equal(result.status, 'failed'); assert.equal(result.dispatches, 0); assert.equal(h.forks, 1); assert.equal(h.kills, 1);
    assert.equal(h.sent.filter(row => row.type === 'EXECUTE' || row.secret).length, 0); assert.equal(h.input.isRaw, false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  });
}
for (const name of ['wrong protocol', 'unexpected run identifier', 'duplicate INIT']) {
  test(`worker rejects ${name} before dispatch`, () => {
    const channel = new EventEmitter(), sent = []; let disconnected = 0;
    channel.send = value => sent.push(value); channel.disconnect = () => { disconnected++; };
    const worker = startNativeWorker(channel, new EventEmitter());
    try {
      const init = { protocol: PROTOCOL, type: 'INIT', manifest: fixture() };
      channel.emit('message', init); assert.equal(sent[0].type, 'PREFLIGHT_READY');
      channel.emit('message', name === 'duplicate INIT' ? init : { protocol: name === 'wrong protocol' ? 'wrong-protocol' : PROTOCOL,
        type: 'EXECUTE', ...(name === 'unexpected run identifier' ? { run_id: 'wrong-run' } : {}) });
      assert.equal(sent.at(-1).type, 'FAILED'); assert.equal(disconnected, 1);
      assert.equal(sent.some(value => value.type === 'PREFLIGHT_PASSED'), false);
    } finally { worker.close(); }
  });
}
for (const [name, mutate] of [
  ['snapshot byte limit', m => { m.snapshots[0].warnings[0].message = 'x'.repeat(64001); }],
  ['manifest string bound', m => { m.snapshots[0].warnings[0].message = 'x'.repeat(80001); }],
  ['prompt version mismatch', m => { m.nativeApproval.promptVersion = 'phase7-v1'; }]
]) test(`native ${name} fails before any worker or input`, () => {
  const manifest = fixture(), h = harness(); mutate(manifest);
  assert.throws(() => launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies));
  assert.equal(h.forks, 0); assert.equal(h.input.states.length, 0);
});
test('premature exit after EXECUTE reports unknown dispatch count and never redelivers', async () => {
  const h = harness({ noWorker: true }), manifest = fixture();
  const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
  h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint });
  await tick(); assert.equal(h.sent.filter(value => value.type === 'EXECUTE').length, 1);
  h.child.emit('exit', 1, null); const result = await pending;
  assert.equal(result.status, 'failed'); assert.equal(result.dispatches, null); assert.equal(h.forks, 1);
  assert.equal(h.sent.filter(value => value.secret).length, 0); assert.equal(h.input.isRaw, false);
});
test('input chunk is zeroed and no EXECUTE is sent until hidden input completes', async () => {
  const h = harness({ noWorker: true, auto: false }), manifest = fixture();
  const pending = launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: h.input }, h.dependencies);
  assert.deepEqual(h.sent.map(row => row.type), ['INIT']); assert.equal(h.input.states.length, 0);
  h.child.emit('message', { protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint });
  const chunk = Buffer.from(SECRET); h.input.emit('data', chunk); await tick();
  assert.ok(chunk.every(byte => byte === 0)); assert.deepEqual(h.sent.map(row => row.type), ['INIT']);
  h.lifecycle.emit('SIGTERM'); await tick(); h.clock.fire(1000); await pending;
  assert.equal(h.input.isRaw, false); assert.equal(h.input.listenerCount('data'), 0);
});
test('worker disconnect closes an admitted pending request with no retry', async () => {
  const fake = transport({ pending: true }), original = https.request; https.request = fake.request;
  const channel = new EventEmitter(); channel.disconnect = () => {};
  channel.send = value => { if (value.type === 'PREFLIGHT_PASSED') queueMicrotask(() => channel.emit('message', { protocol: 'evinews-evaluation-secret-v1', secret: SECRET })); };
  const worker = startNativeWorker(channel, new EventEmitter());
  try {
    channel.emit('message', { protocol: PROTOCOL, type: 'INIT', manifest: fixture() });
    channel.emit('message', { protocol: PROTOCOL, type: 'EXECUTE' }); await tick(); assert.equal(fake.state.requests, 1);
    channel.emit('disconnect'); await tick(); assert.ok(fake.state.destroyed >= 1); assert.equal(fake.state.requests, 1);
    assert.equal(channel.listenerCount('message'), 0);
  } finally { worker.close(); https.request = original; }
});
test('probe deadline destroys its sole pending fake TCP socket without another address attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { probeGeminiEgress } = require('./probe-gemini-egress'); let connects = 0, destroyed = 0;
  const socket = new EventEmitter(); socket.destroy = () => { destroyed++; };
  const pending = probeGeminiEgress('AUTHORIZE_CREDENTIAL_FREE_CONNECTIVITY_PROBE', {
    lookup(host, options, callback) { callback(null, [{ family: 4, address: '192.0.2.1' }, { family: 4, address: '192.0.2.2' }]); },
    connect() { connects++; return socket; }, secure() { assert.fail('TLS must not start before TCP'); }
  });
  t.mock.timers.tick(10000); assert.deepEqual(await pending, { dns: true, tcp: false, tls: false, code: 'ETIMEDOUT' });
  assert.equal(connects, 1); assert.equal(destroyed, 1);
});
test('forbidden production, credential, SDK and persistence imports are never reached', async () => {
  const original = Module._load; let forbidden = 0;
  Module._load = function (name, ...args) {
    if (/dotenv|sequelize|mysql|genai|geminiClientService|summaryWorkflowService|summaryQueryService|models|config[\\/]/i.test(name)) {
      forbidden++; throw new Error('Forbidden import');
    }
    return original.call(this, name, ...args);
  };
  try { assert.equal((await run()).result.status, 'accepted'); assert.equal(forbidden, 0); }
  finally { Module._load = original; }
});
test('native and probe CLIs do nothing on import; missing authorization rejects without dependencies', async () => {
  const { main } = require('./evaluate-native-summary'); const { probeGeminiEgress } = require('./probe-gemini-egress');
  assert.equal((await main([])).status, 'REJECTED');
  assert.deepEqual(await probeGeminiEgress(null), { dns: false, tcp: false, tls: false, code: 'NOT_AUTHORIZED' });
});
test('credential-free probe selects one address and upgrades the same fake socket, no HTTP', async () => {
  const { probeGeminiEgress } = require('./probe-gemini-egress'); let tcp = 0, tls = 0, destroys = 0;
  const socket = new EventEmitter(), secured = new EventEmitter(); socket.destroy = secured.destroy = () => { destroys++; }; secured.authorized = true;
  const result = await probeGeminiEgress('AUTHORIZE_CREDENTIAL_FREE_CONNECTIVITY_PROBE', {
    lookup(host, options, callback) { assert.equal(host, 'generativelanguage.googleapis.com'); callback(null, [{ family: 4, address: '192.0.2.2' }, { family: 4, address: '192.0.2.1' }]); },
    connect(options) { tcp++; assert.equal(options.host, '192.0.2.1'); queueMicrotask(() => socket.emit('connect')); return socket; },
    secure(options) { tls++; assert.equal(options.socket, socket); assert.equal(options.servername, 'generativelanguage.googleapis.com');
      assert.equal(options.rejectUnauthorized, true); queueMicrotask(() => secured.emit('secureConnect')); return secured; }
  });
  assert.deepEqual(result, { dns: true, tcp: true, tls: true, code: null }); assert.equal(tcp, 1); assert.equal(tls, 1); assert.equal(destroys, 2);
});
test('result schema rejects content, credentials, unbounded diagnostics and inconsistent accepted status', () => {
  const manifest = fixture(), base = { status: 'accepted', model: manifest.nativeApproval.model, fingerprint: manifest.nativeApproval.fingerprint,
    dispatches: 1, validation: 'PASS', grounding: 'PASS', factual_truth_verified: false, diagnostic: null };
  assert.equal(validResult(base, base.model, base.fingerprint), true);
  for (const changed of [{ ...base, secret: SECRET }, { ...base, dispatches: 2 }, { ...base, diagnostic: { category: 'NETWORK', message: SECRET } },
    { ...base, factual_truth_verified: true }, { ...base, grounding: 'FAIL' }]) assert.equal(validResult(changed, base.model, base.fingerprint), false);
});
