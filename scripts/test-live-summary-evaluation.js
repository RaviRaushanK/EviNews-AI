'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { validatePreflight, HARD_LIMITS } = require('../evaluation/liveSummarySafety');
const { createProviderDispatcher } = require('../evaluation/providerDispatch');
const { runLiveEvaluation, AUTHORIZATION } = require('./evaluate-live-summaries');
const EVENT = '81000000-0000-4000-8000-000000000001';
const ARTICLE = '82000000-0000-4000-8000-000000000001';
const CLAIM = '83000000-0000-4000-8000-000000000001';
const EVIDENCE = '84000000-0000-4000-8000-000000000001';
const copy = value => structuredClone(value);
function fixture() {
  const target = { host: 'localhost', port: 3306, database: 'evinews_ai_eval_synthetic_only' };
  const limits = { maxEvents: 2, maxArticles: 2, maxSummaryAttempts: 2, maxProviderCalls: 2 };
  const summary = { model: 'offline-fixture-only', promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2', timeoutMs: 1000 };
  return { config: { mode: 'isolated-live', target, eventIds: [EVENT], articles: [{ id: ARTICLE, event_id: EVENT }], attempts: [EVENT], limits, summary },
    approval: { approved: true, targetAllowlist: [copy(target)], developmentTarget: { host: 'localhost', port: 3306, database: 'evinews_ai' },
      productionTargets: [], productionNotConfigured: true, eventIds: [EVENT], articleIds: [ARTICLE], limits: copy(limits), summary: copy(summary) } };
}
function adapters(config, options = {}) {
  const state = { initializes: 0, providerCalls: 0, transactions: 0, closes: 0, summaries: [], links: [], plans: [] };
  const text = 'The synthetic library opened.';
  const source = { id: 'fixture-source', name: 'Synthetic Publisher' };
  return { state, executionMode: 'offline-test', transport: { async sendOne(request, { signal }) {
    state.providerCalls++; assert.equal(request.model, config.summary.model); assert.equal(signal.aborted, false);
    assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.config), true);
    if (options.providerError) throw options.providerError;
    return { text: JSON.stringify({ statements: [{ id: 's1', text: source.name + ' excerpt: ' + text + (options.unsupported ? ' invented caveat' : ''),
      attribution: source.name, source_claim_ids: [CLAIM], evidence_ids: [EVIDENCE], contradiction_ids: [] }] }) };
  } }, async initialize(plan) {
    state.initializes++; state.plans.push(plan);
    const { buildInputFingerprint } = require('../utils/summaryValidation');
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const context = { event: { id: EVENT, title: 'Synthetic evaluation' }, reports: [{ article_id: ARTICLE, source }],
      claims: [{ claim_id: CLAIM, article_id: ARTICLE, claim_text: text, claim_type: 'fact', source }],
      evidence: [{ evidence_id: EVIDENCE, claim_id: CLAIM, article_id: ARTICLE, evidence_text: text, evidence_hash: hash,
        source_grounded: true, exact_source_grounded: true, source_excerpt_provenance: { article_id: ARTICLE, source_id: source.id, source_name: source.name, evidence_hash: hash, source_text_hash: hash } }],
      contradictions: [], warnings: [], coverage: { status: 'unknown' }, metadata: { model: config.summary.model, prompt_version: config.summary.promptVersion, contract_version: config.summary.contractVersion } };
    if (options.mutateContext) options.mutateContext(context);
    context.metadata.input_fingerprint = buildInputFingerprint(context);
    return { contextService: { buildContextForEvent: async () => copy(context) },
      summaryRepository: {
        transaction: async work => { state.transactions++; return work({ fakeTransaction: true }); },
        findByFingerprint: async (id, hash) => state.summaries.find(row => row.event_id === id && row.input_fingerprint === hash) || null,
        findEvent: async id => ({ id }), findMemberArticleIds: async () => [ARTICLE],
        findClaims: async () => [{ id: CLAIM, article_id: ARTICLE, event_id: EVENT }],
        createSummary: async row => { const saved = { ...copy(row), id: '85000000-0000-4000-8000-000000000001' }; state.summaries.push(saved); return saved; },
        createLinks: async rows => { state.links.push(...copy(rows)); },
        findById: async id => state.summaries.find(row => row.id === id)
      }, close: async () => { state.closes++; } };
  } };
}

const invalid = [
  ['missing mode', x => { delete x.config.mode; }], ['invalid mode', x => { x.config.mode = 'development'; }],
  ['development target', x => { x.config.target.database = 'evinews_ai'; }],
  ['shared test target', x => { x.config.target.database = 'evinews_ai_test'; }],
  ['protected development evaluation-shaped name', x => { x.approval.developmentTarget.database = x.config.target.database; }],
  ['production target', x => { x.approval.productionNotConfigured = false; x.approval.productionTargets = [copy(x.config.target)]; }],
  ['unacknowledged production absence', x => { x.approval.productionNotConfigured = false; }],
  ['missing allowlist', x => { delete x.approval.targetAllowlist; }], ['empty allowlist', x => { x.approval.targetAllowlist = []; }],
  ['malformed allowlist', x => { x.approval.targetAllowlist = ['mysql://SECRET']; }],
  ['duplicate alias allowlist', x => { x.approval.targetAllowlist.push({ ...x.config.target, host: '127.0.0.1' }); }],
  ['unapproved host', x => { x.config.target.host = 'other-host'; }],
  ['credentials in hostname', x => { x.config.target.host = 'user:SECRET@localhost'; }],
  ['extra connection URL', x => { x.config.target.url = 'mysql://SECRET'; }],
  ['missing provider budget', x => { delete x.config.limits.maxProviderCalls; }],
  ['zero provider budget', x => { x.config.limits.maxProviderCalls = 0; }],
  ['unapproved provider budget', x => { x.config.limits.maxProviderCalls = 3; }],
  ['hard provider budget exceeded', x => { x.config.limits.maxProviderCalls = 25; }],
  ['excess events', x => {
    const second = '81000000-0000-4000-8000-000000000002';
    x.config.eventIds.push(second); x.approval.eventIds.push(second); x.config.limits.maxEvents = 1;
  }],
  ['unapproved event', x => { x.config.eventIds = ['81000000-0000-4000-8000-000000000099']; }],
  ['duplicate event', x => { x.config.eventIds.push(EVENT); }],
  ['excess articles', x => { x.config.articles.push(copy(x.config.articles[0]), copy(x.config.articles[0])); }],
  ['unapproved article', x => { x.config.articles[0].id = '82000000-0000-4000-8000-000000000099'; }],
  ['URL article input', x => { x.config.articles[0].url = 'https://fixture.invalid'; }],
  ['excess attempts', x => { x.config.attempts = [EVENT, EVENT, EVENT]; }],
  ['unapproved attempt', x => { x.config.attempts = ['81000000-0000-4000-8000-000000000099']; }],
  ['missing approval', x => { x.approval.approved = false; }],
  ['changed model', x => { x.config.summary.model = 'different-model'; }]
];
for (const [name, mutate] of invalid) test(name + ' rejects before adapter initialization', async () => {
  const x = fixture(); mutate(x); const deps = adapters(x.config);
  await assert.rejects(runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION));
  assert.equal(deps.state.initializes, 0); assert.equal(deps.state.providerCalls, 0); assert.equal(deps.state.transactions, 0);
});
test('preflight is immutable and independent of development environment defaults', () => {
  const x = fixture(), environment = { ...process.env }, plan = validatePreflight(x.config, x.approval);
  assert.equal(Object.isFrozen(plan.target), true); assert.equal(Object.isFrozen(plan.attempts), true);
  assert.deepEqual({ ...process.env }, environment); assert.notEqual(plan.target.database, 'evinews_ai');
});
test('explicit execution authorization and adapters are required', async () => {
  const x = fixture(), deps = adapters(x.config);
  await assert.rejects(runLiveEvaluation(x.config, x.approval, deps), { code: 'ELIVE_EXECUTION_NOT_AUTHORIZED' });
  await assert.rejects(runLiveEvaluation(x.config, x.approval, {}, AUTHORIZATION), { code: 'ELIVE_ADAPTER_REQUIRED' });
  assert.equal(deps.state.initializes, 0);
});
test('trusted doubles exercise real workflow and fingerprint reuse with one provider dispatch', async () => {
  const x = fixture(); x.config.attempts.push(EVENT); const deps = adapters(x.config);
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (/^(?:mysql2|sequelize|@google\/genai|https?|net|tls)$/.test(name) || /(?:models|geminiClientService|config[\\/]db)/.test(name)) throw new Error('Forbidden live dependency');
    return load.call(this, name, ...args);
  };
  try {
    const result = await runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION);
    assert.equal(result.complete, true); assert.equal(result.summaryAttempts, 2); assert.equal(result.providerDispatches, 1);
    assert.equal(result.results[1].reused, true); assert.equal(deps.state.summaries.length, 1); assert.equal(deps.state.links.length, 1);
    assert.equal(deps.state.closes, 1); assert.ok(Object.isFrozen(deps.state.plans[0]));
    assert.ok(!JSON.stringify(result).includes('synthetic library')); assert.ok(!JSON.stringify(result).includes(x.config.target.database));
  } finally { Module._load = load; }
});
test('runtime budget stops a second provider dispatch when no cached fingerprint is returned', async () => {
  const x = fixture(); x.config.limits.maxProviderCalls = 1; x.config.attempts.push(EVENT);
  const deps = adapters(x.config), init = deps.initialize;
  deps.initialize = async plan => {
    const resource = await init(plan);
    // Return ready without retaining a row, forcing a fresh fingerprint lookup.
    resource.summaryRepository.findByFingerprint = async () => null;
    return resource;
  };
  const result = await runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION);
  assert.equal(result.complete, false); assert.equal(result.error, 'ELIVE_PROVIDER_BUDGET');
  assert.equal(deps.state.providerCalls, 1); assert.equal(result.providerDispatches, 1); assert.equal(deps.state.closes, 1);
});
test('legacy opaque providers and non-offline execution reject before initialization', async () => {
  for (const mutate of [deps => { delete deps.transport; }, deps => { deps.provider = { generateOnce() {} }; },
    deps => { deps.transport = { generateOnce() {} }; }, deps => { delete deps.executionMode; },
    deps => { deps.executionMode = 'live'; }]) {
    const x = fixture(), deps = adapters(x.config); mutate(deps);
    await assert.rejects(runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION));
    assert.equal(deps.state.initializes, 0); assert.equal(deps.state.providerCalls, 0);
  }
});
test('unsupported output stops before persistence and before another event attempt', async () => {
  const x = fixture(); x.config.attempts.push(EVENT); const deps = adapters(x.config, { unsupported: true });
  const result = await runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION);
  assert.equal(result.complete, false); assert.equal(result.summaryAttempts, 1); assert.equal(deps.state.transactions, 0);
});
test('unexpected context members and excessive context sizes fail before provider or writes', async () => {
  for (const mutateContext of [ctx => { ctx.reports[0].article_id = 'foreign'; }, ctx => { ctx.claims = Array.from({ length: 51 }, () => ctx.claims[0]); }]) {
    const x = fixture(), deps = adapters(x.config, { mutateContext });
    const result = await runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION);
    assert.equal(result.complete, false); assert.equal(deps.state.providerCalls, 0); assert.equal(deps.state.transactions, 0); assert.equal(deps.state.closes, 1);
  }
});
test('reports sanitize provider and initializer exceptions', async () => {
  const x = fixture(), deps = adapters(x.config, { providerError: new Error('SECRET https://credentials.invalid TOKEN') });
  const result = await runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION);
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.ok(!JSON.stringify(result).includes('credentials.invalid'));
  const failed = await runLiveEvaluation(x.config, x.approval, { ...adapters(x.config), initialize: async () => { throw new Error('SECRET'); } }, AUTHORIZATION);
  assert.equal(failed.error, 'ELIVE_EXECUTION_FAILED'); assert.ok(!JSON.stringify(failed).includes('SECRET'));
});
test('CLI is preflight-only, opt-in, offline and absent from existing npm scripts', () => {
  const file = path.join(__dirname, 'evaluate-live-summaries.js');
  for (const args of [[], ['--execute'], ['--preflight-stdin']]) {
    const child = spawnSync(process.execPath, [file, ...args], { input: JSON.stringify(fixture()), encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error); assert.equal(child.stderr, ''); assert.equal(child.status, args[0] === '--preflight-stdin' ? 0 : 1);
    assert.equal(JSON.parse(child.stdout).execution, 'NOT RUN');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')));
  assert.ok(Object.values(pkg.scripts).every(cmd => !cmd.includes('evaluate-live-summaries')));
});
test('original offline CLI still completes its unchanged seventeen cases', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'evaluate-multi-event.js')], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(report.counts, { passed: 17, failed: 0, notRun: 0 }); assert.equal(report.liveQualityMetrics, false);
});

const badNumbers = [
  ['missing', undefined], ['null', null], ['empty', ''], ['whitespace', ' '], ['malformed', 'invalid'],
  ['numeric string', '1'], ['object', {}], ['array', []], ['fractional', 1.5], ['negative', -1], ['zero', 0],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['NaN', NaN], ['infinity', Infinity]
];
for (const name of Object.keys(HARD_LIMITS)) {
  for (const side of ['config', 'approval']) for (const [label, value] of badNumbers) {
    test(`${side} ${name}: ${label} rejected before initialization`, async () => {
      const x = fixture(), deps = adapters(x.config);
      if (value === undefined) delete x[side].limits[name]; else x[side].limits[name] = value;
      await assert.rejects(runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION));
      assert.equal(deps.state.initializes, 0); assert.equal(deps.state.providerCalls, 0); assert.equal(deps.state.transactions, 0);
    });
  }
  for (const value of [HARD_LIMITS[name] - 1, HARD_LIMITS[name], HARD_LIMITS[name] + 1]) {
    test(`${name}: hard ceiling boundary ${value}`, async () => {
      const x = fixture(), deps = adapters(x.config);
      x.config.limits[name] = value; x.approval.limits[name] = value;
      if (value <= HARD_LIMITS[name]) assert.equal(validatePreflight(x.config, x.approval).limits[name], value);
      else await assert.rejects(runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION));
      assert.equal(deps.state.initializes, 0); assert.equal(deps.state.providerCalls, 0);
    });
  }
  for (const value of [1, 2, 3]) test(`${name}: approved ceiling 2 boundary ${value}`, async () => {
    const x = fixture(), deps = adapters(x.config); x.config.limits[name] = value;
    if (value <= 2) assert.equal(validatePreflight(x.config, x.approval).limits[name], value);
    else await assert.rejects(runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION));
    assert.equal(deps.state.initializes, 0);
  });
}

function countFixture(name, count) {
  const x = fixture();
  x.config.limits = { ...HARD_LIMITS }; x.approval.limits = { ...HARD_LIMITS };
  const id = (prefix, index) => `${prefix}000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  if (name === 'maxEvents') {
    x.config.eventIds = Array.from({ length: count }, (_, i) => id('81', i));
    x.config.articles = x.config.eventIds.map((event_id, i) => ({ id: id('82', i), event_id }));
    x.config.attempts = count ? [x.config.eventIds[0]] : [];
    x.approval.eventIds = [...x.config.eventIds]; x.approval.articleIds = x.config.articles.map(row => row.id);
  } else if (name === 'maxArticles') {
    x.config.articles = Array.from({ length: count }, (_, i) => ({ id: id('82', i), event_id: EVENT }));
    x.approval.articleIds = x.config.articles.map(row => row.id);
  } else x.config.attempts = Array(count).fill(EVENT);
  return x;
}
for (const name of ['maxEvents', 'maxArticles', 'maxSummaryAttempts']) {
  for (const count of [0, HARD_LIMITS[name] - 1, HARD_LIMITS[name], HARD_LIMITS[name] + 1]) {
    test(`${name}: input count ${count} boundary`, async () => {
      const x = countFixture(name, count), deps = adapters(x.config);
      if (count > 0 && count <= HARD_LIMITS[name]) validatePreflight(x.config, x.approval);
      else await assert.rejects(runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION));
      assert.equal(deps.state.initializes, 0); assert.equal(deps.state.providerCalls, 0);
    });
  }
}

function dispatchFixture(sendOne, budget = 2, timeoutMs = 1000) {
  const dispatcher = createProviderDispatcher({ executionMode: 'offline-test', transport: { sendOne },
    maxProviderCalls: budget, model: 'offline-fixture-only', timeoutMs });
  const options = { model: 'offline-fixture-only', timeoutMs, maxAttempts: 1, responseMimeType: 'application/json' };
  return { dispatcher, send: () => dispatcher.generateText('Synthetic test only', options), options };
}
for (const budget of [1, 23, 24]) test(`exactly ${budget} transport sends permitted, repeated attempt denied before send`, async () => {
  let sends = 0;
  const { dispatcher, send } = dispatchFixture(() => { sends++; return { text: 'offline' }; }, budget);
  try {
    for (let i = 0; i < budget; i++) await send();
    await assert.rejects(send(), { code: 'ELIVE_PROVIDER_BUDGET' });
    assert.equal(sends, budget); assert.equal(dispatcher.dispatches, sends);
  } finally { dispatcher.close(); }
});

test('concurrent admissions reserve before transport without exceeding shared budget', async () => {
  let sends = 0; const releases = [];
  const { dispatcher, send } = dispatchFixture(() => { sends++; return new Promise(resolve => releases.push(resolve)); }, 2);
  try {
    const settled = Promise.allSettled(Array.from({ length: 6 }, send));
    assert.equal(sends, 2); assert.equal(dispatcher.dispatches, 2);
    releases.forEach(resolve => resolve({ text: 'offline' }));
    const results = await settled;
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 2);
    assert.equal(results.filter(row => row.reason?.code === 'ELIVE_PROVIDER_BUDGET').length, 4);
  } finally { dispatcher.close(); }
});

test('failed requests consume budget and do not retry automatically', async () => {
  for (const sendError of [() => { throw new Error('offline failure'); }, async () => { throw new Error('offline rejection'); }]) {
    let sends = 0; const { dispatcher, send } = dispatchFixture(() => { sends++; return sendError(); }, 1);
    try {
      await assert.rejects(send()); assert.equal(sends, 1);
      await assert.rejects(send(), { code: 'ELIVE_PROVIDER_BUDGET' }); assert.equal(sends, 1);
    } finally { dispatcher.close(); }
  }
});

test('timed-out transport consumes budget and receives cancellation without retry', async () => {
  let sends = 0, signal;
  const { dispatcher, send } = dispatchFixture((_, options) => { sends++; signal = options.signal; return new Promise(() => {}); }, 1, 10);
  try {
    await assert.rejects(send(), { code: 'GEMINI_TIMEOUT' }); assert.equal(signal.aborted, true);
    await assert.rejects(send(), { code: 'ELIVE_PROVIDER_BUDGET' }); assert.equal(sends, 1);
  } finally { dispatcher.close(); }
});

test('closing cancels pending sends and denies late calls before transport', async () => {
  let sends = 0, signal;
  const { dispatcher, send } = dispatchFixture((_, options) => { sends++; signal = options.signal; return new Promise(() => {}); });
  const pending = send(); dispatcher.close(); dispatcher.close();
  await assert.rejects(pending, { code: 'ELIVE_PROVIDER_CLOSED' }); assert.equal(signal.aborted, true);
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CLOSED' }); assert.equal(sends, 1);
});

test('option getter closing the gate rejects before transport and consumes no reservation', async () => {
  let sends = 0;
  const { dispatcher, options, send } = dispatchFixture(() => { sends++; return { text: 'offline' }; });
  const closingOptions = {
    ...options,
    get model() { dispatcher.close(); return options.model; }
  };
  try {
    await assert.rejects(dispatcher.generateText('Synthetic test only', closingOptions), { code: 'ELIVE_PROVIDER_CLOSED' });
    assert.equal(sends, 0);
    assert.equal(dispatcher.dispatches, 0);
    await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CLOSED' });
    assert.equal(sends, 0);
    assert.equal(dispatcher.dispatches, 0);
  } finally { dispatcher.close(); }
});

test('raw transport is not exposed and URLs headers or retry settings are rejected before send', async () => {
  let sends = 0; const { dispatcher, options } = dispatchFixture(() => { sends++; return { text: 'offline' }; });
  try {
    assert.equal(dispatcher.transport, undefined); assert.equal(dispatcher.sendOne, undefined);
    for (const extra of [{ url: 'https://fixture.invalid' }, { headers: {} }, { maxAttempts: 2 }, { model: 'other' }, { timeoutMs: 2 }]) {
      await assert.rejects(dispatcher.generateText('offline', { ...options, ...extra }), { code: 'ELIVE_PROVIDER_CONTRACT' });
    }
    assert.equal(sends, 0); assert.equal(dispatcher.dispatches, 0);
  } finally { dispatcher.close(); }
});

test('response attempt metadata cannot authorize sends and is rejected as a malformed response', async () => {
  let sends = 0; const { dispatcher, send } = dispatchFixture(() => { sends++; return { text: 'offline', attempts: 2 }; }, 1);
  try {
    await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CONTRACT' });
    await assert.rejects(send(), { code: 'ELIVE_PROVIDER_BUDGET' }); assert.equal(sends, 1);
  } finally { dispatcher.close(); }
});

for (const [label, value] of [...badNumbers, ['above ceiling', 25]]) {
  test(`dispatcher provider budget ${label} rejected without transport invocation`, () => {
    let sends = 0;
    assert.throws(() => createProviderDispatcher({ executionMode: 'offline-test',
      transport: { sendOne() { sends++; } }, maxProviderCalls: value, model: 'offline-fixture-only', timeoutMs: 1000 }),
    { code: 'ELIVE_LIMITS_INVALID' });
    assert.equal(sends, 0);
  });
}

test('legacy provider returned by initializer is rejected before any send or persistence', async () => {
  const x = fixture(), deps = adapters(x.config), initialize = deps.initialize;
  deps.initialize = async plan => ({ ...await initialize(plan), provider: { generateOnce() { throw new Error('Must not run'); } } });
  const report = await runLiveEvaluation(x.config, x.approval, deps, AUTHORIZATION);
  assert.equal(report.error, 'ELIVE_ADAPTER_INVALID'); assert.equal(report.complete, false);
  assert.equal(deps.state.providerCalls, 0); assert.equal(deps.state.transactions, 0); assert.equal(deps.state.closes, 1);
});
