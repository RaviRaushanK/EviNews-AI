const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateFixture, loadFixture, installIsolation, runEvaluation, WARNING_INVENTORY } = require('./evaluate-multi-event');

test('versioned synthetic fixture has three events, ten scenarios and seventeen required cases', () => {
  const data = loadFixture();
  assert.equal(data.events.length, 3); assert.equal(data.scenarios.length, 10);
  assert.equal(data.scenarios.flatMap(row => row.cases).length, 17);
  assert.equal(data.schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

for (const [name, mutate] of [
  ['wrong version', data => { data.version = 'unapproved'; }],
  ['non-synthetic kind', data => { data.kind = 'live'; }],
  ['missing schema', data => { delete data.schema; }],
  ['missing scenario', data => { data.scenarios.pop(); }],
  ['missing required case', data => { data.scenarios[0].cases.pop(); }],
  ['duplicate case', data => { data.scenarios[0].cases.push(data.scenarios[0].cases[0]); }],
  ['unknown action', data => { data.scenarios[0].cases[0].action = 'run_live_job'; }],
  ['missing expected criteria', data => { data.scenarios[0].cases[0].expected = {}; }],
  ['duplicate entity ID', data => { data.claims[1].id = data.claims[0].id; }],
  ['non-isolated entity ID', data => { data.events[0].id = '434acc94-672c-4be0-80be-a628a44a1cac'; }],
  ['foreign article membership', data => { data.articles[0].event_id = 'unknown'; }],
  ['evidence wrong article', data => { data.evidence[0].article_id = data.articles[2].id; }],
  ['non-synthetic URL', data => { data.articles[0].url = 'https://example.com/live'; }],
  ['invalid date', data => { data.articles[0].published_at = 'not-a-date'; }],
  ['cross-event contradiction', data => { data.contradictions[0].claim_id_1 = data.claims[0].id; }]
]) test('fixture rejects ' + name, () => {
  const data = loadFixture(); mutate(data); assert.throws(() => validateFixture(data), /Invalid offline fixture/);
});

for (const field of ['claim_id', 'article_id']) {
  for (const [name, value] of [['null', null], ['empty', ''], ['whitespace', ' '], ['unknown', '83000000-0000-4000-8000-000000000099'], ['object', {}]]) {
    test('evidence rejects ' + field + ' ' + name + ' before evaluation', async () => {
      const data = loadFixture(); data.evidence[0][field] = value;
      assert.throws(() => validateFixture(data), /Invalid offline fixture/);
      await assert.rejects(runEvaluation(data), /Invalid offline fixture/);
    });
  }
  test('evidence rejects missing ' + field, async () => {
    const data = loadFixture(); delete data.evidence[0][field];
    await assert.rejects(runEvaluation(data), /Invalid offline fixture/);
  });
}
test('orphan evidence cannot exploit two missing identifiers', async () => {
  const data = loadFixture(); delete data.evidence[0].claim_id; delete data.evidence[0].article_id;
  await assert.rejects(runEvaluation(data), /evidence reference IDs/);
});
for (const [name, mutate] of [
  ['duplicate evidence ID', data => { data.evidence.push(structuredClone(data.evidence[0])); }],
  ['null evidence record', data => { data.evidence[0] = null; }],
  ['empty evidence text', data => { data.evidence[0].evidence_text = ''; }]
]) test(name + ' fails evaluation', async () => {
  const data = loadFixture(); mutate(data); await assert.rejects(runEvaluation(data), /Invalid offline fixture/);
});

test('isolation blocks network transports, providers, databases and production jobs before import', () => {
  const guard = installIsolation();
  try {
    const denied = ['node:net', 'net', 'node:tls', 'node:http', 'node:https', 'node:dns', 'node:dgram', 'node:child_process', 'node:worker_threads',
      'mysql2', 'sequelize', '@google/genai', '../models', '../config/db', '../services/geminiClientService', '../services/collectionService',
      '../services/embeddingService', '../services/clusteringOrchestrationService', '../services/clusteringService', '../services/contradictionDetectionService',
      './collect-newsapi', './evaluate-contradictions', '../app'];
    for (const name of denied) {
      assert.throws(() => require(name), { code: 'OFFLINE_ISOLATION' });
    }
    assert.throws(() => global.fetch('https://fixture.invalid'), { code: 'OFFLINE_ISOLATION' });
    assert.equal(guard.state.fetchAttempts, 1);
    assert.equal(guard.state.blockedImports, denied.length); assert.equal(guard.state.blocked, denied.length + 1);
    assert.deepEqual(require('dotenv').config(), { parsed: {} });
    assert.equal(Object.hasOwn(guard.state, 'databaseConnections'), false);
    assert.equal(Object.hasOwn(guard.state, 'providerCalls'), false);
  } finally { guard.restore(); }
});

test('evaluation completes all cases without touching inputs, legacy assets, environment or real connections', async () => {
  const files = ['contradiction-evaluation.json', 'phase6-utilities.json', 'phase7-summaries.json'];
  const content = files.map(file => fs.readFileSync(path.join(__dirname, '../fixtures', file), 'utf8'));
  const data = loadFixture(), before = JSON.stringify(data), environment = { ...process.env }, originalFetch = global.fetch;
  const report = await runEvaluation(data);
  assert.equal(report.exitCode, 0); assert.equal(report.complete, true);
  assert.deepEqual(report.counts, { passed: 17, failed: 0, notRun: 0 });
  assert.equal(report.liveQualityMetrics, false);
  assert.deepEqual(report.isolation.guardedEntryPointObservations, { blocked: 0, blockedImports: 0, fetchAttempts: 0 });
  assert.deepEqual(report.isolation.activity, { realProviderCalls: 'NOT MEASURED', databaseConnections: 'NOT MEASURED', realDatabaseWrites: 'NOT MEASURED' });
  assert.equal(report.isolation.enforced.length, 3);
  const coverage = report.results.find(row => row.case === 'pending-single-source').details;
  assert.ok(coverage.warningCodes.includes('EXCERPT_PROVENANCE_ONLY'));
  assert.ok(coverage.warningCodes.includes('INCOMPLETE_COVERAGE'));
  assert.deepEqual(coverage.warningCodes, Object.values(WARNING_INVENTORY).flat().sort());
  assert.equal(coverage.appendedWarningsRejected, 22);
  assert.equal(JSON.stringify(data), before); assert.deepEqual({ ...process.env }, environment); assert.equal(global.fetch, originalFetch);
  files.forEach((file, index) => assert.equal(fs.readFileSync(path.join(__dirname, '../fixtures', file), 'utf8'), content[index]));
  const loaded = Object.keys(require.cache).map(file => file.replace(/\\/g, '/'));
  assert.ok(!loaded.some(file => /\/(models\/|config\/db\.js|services\/geminiClientService\.js|node_modules\/(mysql2|sequelize|@google)\/)/.test(file)));
});

for (const [file, expected] of Object.entries(WARNING_INVENTORY)) {
  test('warning inventory matches inspected producer ' + file, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const found = new Set();
    for (const match of source.matchAll(/warnings\.push\(\{\s*code:\s*([^,\n]+)/g)) {
      for (const literal of match[1].matchAll(/'([A-Z][A-Z_]+)'/g)) {
        if (literal[1] === 'SUMMARY_CONTRADICTION_COVERAGE_') {
          found.add('SUMMARY_CONTRADICTION_COVERAGE_UNKNOWN'); found.add('SUMMARY_CONTRADICTION_COVERAGE_LIMITED');
          assert.ok(source.includes("contradictionCoverage === 'limited'"));
        } else found.add(literal[1]);
      }
    }
    assert.deepEqual([...found].sort(), [...expected].sort());
  });
}
let warningReport;
for (const code of Object.values(WARNING_INVENTORY).flat()) {
  test(code + ' retains original metadata and rejects statement insertion before persistence', async () => {
    warningReport ||= runEvaluation();
    const report = await warningReport;
    assert.equal(report.complete, true);
    const item = report.results.find(row => row.case === 'pending-single-source').details.warningCases.find(row => row.warning.code === code);
    assert.ok(item); assert.equal(item.metadataPreserved, true); assert.equal(item.appendedRejected, true); assert.equal(item.statementFieldRejected, true);
    if (code === 'STORED_CONTRADICTION_CONTEXT') {
      assert.deepEqual(Object.keys(item.warning).sort(), ['code', 'relations']);
      assert.ok(item.warning.relations.length > 0);
      assert.equal(item.warning.relations[0].contradiction_type, 'direct');
      assert.equal(item.warning.relations[0].status, 'under_review');
      assert.equal(item.appendRepresentation, 'serialized original structured object');
    } else if (code === 'SUMMARY_CONFLICT_OMITTED') {
      assert.deepEqual(item.warning, { code, count: 1 });
      assert.equal(item.appendRepresentation, 'serialized original structured object');
    } else {
      assert.equal(typeof item.warning.message, 'string'); assert.equal(item.appendRepresentation, 'existing message');
      if (['CLAIMS_NOT_EXTRACTED', 'MEMBER_ARTICLE_UNAVAILABLE', 'REPORT_DATE_UNAVAILABLE', 'FETCHED_DATE_USED'].includes(code)) assert.equal(typeof item.warning.article_id, 'string');
      if (code === 'EVIDENCE_UNAVAILABLE') assert.ok(item.warning.claim_ids.length > 0);
      if (code === 'UNDATED_REPORTS_NOT_COMPARED') assert.ok(item.warning.count > 0);
    }
  });
}

function cli(data) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'evaluate-multi-event.js'), '--fixture-stdin'],
    { input: JSON.stringify(data), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.stderr, '');
  return { status: result.status, rows: result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)) };
}
test('offline CLI complete run exits zero and preserves candidate disagreements', () => {
  const result = cli(loadFixture()), aggregate = result.rows.at(-1);
  assert.equal(result.status, 0); assert.equal(aggregate.complete, true); assert.equal(aggregate.exitCode, 0);
  assert.deepEqual(aggregate.counts, { passed: 17, failed: 0, notRun: 0 });
  const candidates = result.rows.find(row => row.case === 'reuse-phase5-labels').details;
  assert.deepEqual(candidates.mismatches.map(row => row.case), ['none-002', 'none-005']);
  assert.equal(candidates.classifier, 'NOT RUN'); assert.equal(candidates.candidateRecall, 1);
  assert.equal(candidates.candidateLabelMatches, 29); assert.equal(candidates.labeledCases, 31);
});
test('offline CLI failed assertion exits nonzero and cannot report complete', () => {
  const data = loadFixture(); data.scenarios[0].cases[0].expected.report_counts[0] = 99;
  const result = cli(data), aggregate = result.rows.at(-1);
  assert.equal(result.status, 1); assert.equal(aggregate.complete, false); assert.equal(aggregate.counts.failed, 1);
});
test('offline CLI missing required case exits nonzero before any evaluation result', () => {
  const data = loadFixture(); data.scenarios[0].cases.pop();
  const result = cli(data); assert.equal(result.status, 1); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].complete, false); assert.equal(result.rows[0].status, 'NOT RUN');
});
test('offline CLI orphan evidence fails rather than silently filtering it', () => {
  const data = loadFixture(); delete data.evidence[0].claim_id; delete data.evidence[0].article_id;
  const result = cli(data); assert.equal(result.status, 1); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].complete, false);
});

test('failed assertion produces nonzero evaluation exit code and a FAIL case', async () => {
  const data = loadFixture(); data.scenarios[0].cases[0].expected.report_counts[0] = 99;
  const report = await runEvaluation(data);
  assert.equal(report.exitCode, 1); assert.equal(report.complete, false); assert.equal(report.counts.failed, 1);
  assert.equal(report.results[0].status, 'FAIL');
});

test('incomplete evaluation fixture stops before loading production services', async () => {
  const data = loadFixture(); data.scenarios.pop(); await assert.rejects(runEvaluation(data), /missing required scenario/);
});

test('offline runs have deterministic results and restore guards after failures', async () => {
  const first = await runEvaluation(), second = await runEvaluation();
  assert.deepEqual(second, first);
  const invalid = loadFixture(); invalid.events.pop();
  await assert.rejects(runEvaluation(invalid));
  assert.equal(typeof require('node:net').connect, 'function'); // Import only; no connection.
});
