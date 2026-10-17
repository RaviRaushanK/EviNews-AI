const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (/gemini|@google|sequelize|[\\/]models|^https?$|^net$/.test(name)) throw new Error('Forbidden test dependency: ' + name);
  return originalLoad.call(this, name, ...args);
};
const { createEventTimelineService } = require('../services/eventTimelineService');
const { createEventChangeService } = require('../services/eventChangeService');
const fixture = require('../fixtures/phase6-utilities.json');
const EVENT = '10000000-0000-4000-8000-000000000001';
const MAX_LIMIT = require('../config/contradictions').query.maxLimit;
let passed = 0;
let failed = 0;
let providerCalls = 0;
const originalFetch = global.fetch;
global.fetch = () => { providerCalls++; throw new Error('Forbidden provider call'); };
async function test(name, callback) {
  try { await callback(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' -> ' + error.message); }
}
function setup(item = fixture.comparisons[0], overrides = {}) {
  const articles = overrides.articles || [
    { id: 'before-article', title: 'Earlier report', url: 'https://fixture.invalid/earlier', source: { id: 'a', name: 'Fixture A' }, published_at: '2026-10-01T10:00:00Z', processing_status: 'claims_extracted' },
    { id: 'after-article', title: 'Later report', url: 'https://fixture.invalid/later', source: { id: 'b', name: 'Fixture B' }, published_at: '2026-10-02T10:00:00Z', processing_status: 'claims_extracted' }
  ];
  const claims = overrides.claims || [
    { id: 'before-claim', article_id: 'before-article', claim_type: item.type, claim_text: item.before, confidence_score: 0.8, event_id: null, evidence: [{ id: 'before-evidence', article_id: 'before-article', evidence_text: item.before }] },
    { id: 'after-claim', article_id: 'after-article', claim_type: item.type, claim_text: item.after, confidence_score: 0.9, event_id: null, evidence: [{ id: 'after-evidence', article_id: 'after-article', evidence_text: item.after }] }
  ];
  const rows = overrides.rows || (item.contradiction_type ? [{ id: 'stored-' + item.id, claim_1: { id: 'before-claim' }, claim_2: { id: 'after-claim' }, contradiction_type: item.contradiction_type, status: item.status, reason: 'Stored fixture reason' }] : []);
  const calls = [];
  const timelineService = createEventTimelineService({
    repository: {
      findEvent: async () => ({ id: EVENT, title: 'Isolated fixture event' }),
      findEventArticleIds: async () => articles.map((article) => article.id),
      loadArticles: async () => articles
    },
    claimQuery: { getClaimsForEvent: async () => overrides.claimUnavailable ? null : { claims } }
  });
  const contradictionQuery = { getContradictionsForEvent: async (id, options) => {
    calls.push([id, options]); if (overrides.contradictionError) throw new Error('Unavailable');
    return overrides.contradictionNull ? null : { count: rows.length, contradictions: rows };
  } };
  return { service: createEventChangeService({ timelineService, contradictionQuery }), articles, claims, rows, calls, timelineService };
}

async function main() {
  for (const item of fixture.comparisons) {
    await test('service fixture ' + item.id, async () => {
      const result = await setup(item).service.getChangesForEvent(EVENT);
      const change = result.changes.find((row) => row.current_claim_id === 'after-claim');
      assert.equal(change.category, item.category); assert.ok(change.rule_id && change.reason);
      assert.equal(change.current_report.article_id, 'after-article');
      if (item.contradiction_type) {
        assert.equal(change.contradiction.contradiction_type, item.contradiction_type); assert.equal(change.contradiction.status, item.status);
        assert.equal(change.previous_claim_id, 'before-claim'); assert.equal(change.reason, 'Stored fixture reason');
      }
    });
  }
  await test('first report has no previous claim context', async () => {
    const result = await setup().service.getChangesForEvent(EVENT); const first = result.changes[0];
    assert.equal(first.category, 'new_information'); assert.equal(first.previous_claim_id, null); assert.equal(first.previous_report, null);
  });
  await test('all earlier reports remain baseline, not just the adjacent report', async () => {
    const data = setup();
    data.articles.push({ ...data.articles[0], id: 'middle-article', published_at: '2026-10-01T20:00:00Z' });
    data.claims.push({ ...data.claims[0], id: 'middle-claim', article_id: 'middle-article', claim_text: 'A satellite launched.' });
    const change = (await data.service.getChangesForEvent(EVENT)).changes.find((row) => row.current_claim_id === 'after-claim');
    assert.equal(change.category, 'previously_reported'); assert.equal(change.previous_claim_id, 'before-claim');
  });
  await test('since boundary retains earlier reports and excludes boundary from output', async () => {
    const result = await setup().service.getChangesForEvent(EVENT, { since: '2026-10-01T10:00:00Z', until: '2026-10-02T10:00:00Z' });
    assert.equal(result.count, 1); assert.equal(result.changes[0].category, 'previously_reported');
    assert.equal(result.baseline.reports_at_or_before_since, 1); assert.equal(result.baseline.selected_reports, 1);
  });
  await test('since includes nonadjacent baseline reports', async () => {
    const data = setup(); data.articles.push({ ...data.articles[0], id: 'middle', published_at: '2026-10-01T20:00:00Z' });
    data.claims.push({ ...data.claims[0], id: 'middle-claim', article_id: 'middle', claim_text: 'A satellite launched.' });
    const result = await data.service.getChangesForEvent(EVENT, { since: '2026-10-01T20:00:00Z' });
    assert.equal(result.count, 1); assert.equal(result.baseline.reports_at_or_before_since, 2); assert.equal(result.changes[0].previous_claim_id, 'before-claim');
  });
  await test('until is inclusive and future reports are not baselines', async () => {
    const result = await setup().service.getChangesForEvent(EVENT, { until: '2026-10-01T10:00:00Z' });
    assert.equal(result.count, 1); assert.equal(result.changes[0].previous_claim_id, null);
  });
  await test('timezone-offset window matches UTC', async () => {
    const data = setup(); assert.deepEqual(await data.service.getChangesForEvent(EVENT, { since: '2026-10-01T15:30:00+05:30' }), await data.service.getChangesForEvent(EVENT, { since: '2026-10-01T10:00:00Z' }));
  });
  await test('invalid dates, swapped ranges and equal ranges fail before reads', async () => {
    let reads = 0;
    const service = createEventChangeService({ timelineService: { getTimelineForEvent: async () => { reads++; } }, contradictionQuery: { getContradictionsForEvent: async () => { reads++; } } });
    for (const options of [{ since: 'invalid' }, { until: null }, { since: '2026-02-30' }, { since: '2026-10-02', until: '2026-10-01' }, { since: '2026-10-01', until: '2026-10-01' }, null, []]) await assert.rejects(service.getChangesForEvent(EVENT, options), (error) => error.code.startsWith('INVALID_'));
    assert.equal(reads, 0);
  });
  await test('no eligible report yields empty results', async () => assert.deepEqual((await setup().service.getChangesForEvent(EVENT, { since: '2026-10-03' })).changes, []));
  await test('all stored relations to earlier claims are connected and preserved', async () => {
    const data = setup();
    data.articles.push({ ...data.articles[0], id: 'middle', published_at: '2026-10-01T20:00:00Z' });
    data.claims.push({ ...data.claims[0], id: 'middle-claim', article_id: 'middle', claim_text: 'The library remained closed.' });
    data.rows.push(
      { id: 'relation-z', claim_1: { id: 'before-claim' }, claim_2: { id: 'after-claim' }, contradiction_type: 'direct', status: 'resolved', reason: 'First stored reason' },
      { id: 'relation-a', claim_1: { id: 'middle-claim' }, claim_2: { id: 'after-claim' }, contradiction_type: 'partial', status: 'under_review', reason: 'Second stored reason' }
    );
    const change = (await data.service.getChangesForEvent(EVENT)).changes.find((row) => row.current_claim_id === 'after-claim');
    assert.equal(change.category, 'contradictory_information');
    assert.deepEqual(change.stored_contradictions.map((row) => row.id), ['relation-a', 'relation-z']);
    assert.equal(change.stored_contradictions[0].previous_report.article_id, 'middle');
    assert.equal(change.stored_contradictions[1].outcome, 'direct'); assert.equal(change.stored_contradictions[1].status, 'resolved');
  });
  await test('zero claims preserve report selection counts', async () => { const result = await setup(undefined, { claims: [] }).service.getChangesForEvent(EVENT); assert.equal(result.count, 0); assert.equal(result.baseline.selected_reports, 2); });
  await test('empty event yields no changes', async () => assert.equal((await setup(undefined, { articles: [], claims: [] }).service.getChangesForEvent(EVENT)).count, 0));
  await test('missing event propagates a controlled error', async () => {
    const service = createEventChangeService({ timelineService: { getTimelineForEvent: async () => { const error = new Error('Missing'); error.code = 'EVENT_NOT_FOUND'; throw error; } }, contradictionQuery: { getContradictionsForEvent: async () => { throw new Error('Must not query'); } } });
    await assert.rejects(service.getChangesForEvent(EVENT), { code: 'EVENT_NOT_FOUND' });
  });
  await test('tied reports never compare against each other', async () => {
    const data = setup(); data.articles[1].published_at = data.articles[0].published_at;
    const result = await data.service.getChangesForEvent(EVENT); assert.ok(result.changes.every((change) => change.previous_claim_id === null && change.category === 'new_information'));
  });
  await test('undated report is not treated as earlier context', async () => {
    const data = setup(); data.articles[0].published_at = null;
    const result = await data.service.getChangesForEvent(EVENT); assert.equal(result.count, 1); assert.equal(result.changes[0].category, 'new_information');
    assert.equal(result.baseline.undated_reports, 1); assert.ok(result.warnings.some((row) => row.code === 'UNDATED_REPORTS_NOT_COMPARED'));
  });
  await test('claims unavailable returns warnings without invented changes', async () => {
    const result = await setup(undefined, { claimUnavailable: true }).service.getChangesForEvent(EVENT);
    assert.equal(result.count, 0); assert.equal(result.completeness.status, 'partial'); assert.ok(result.warnings.some((row) => row.code === 'CLAIMS_UNAVAILABLE'));
  });
  await test('evidence from both reports and confidence preserved', async () => {
    const change = (await setup().service.getChangesForEvent(EVENT)).changes[1];
    assert.equal(change.evidence[0].id, 'after-evidence'); assert.equal(change.previous_evidence[0].id, 'before-evidence');
    assert.equal(change.current_claim.confidence_score, 0.9); assert.equal(change.previous_report.source.name, 'Fixture A');
  });
  await test('empty stored contradictions mean unknown coverage', async () => {
    const data = setup(); const result = await data.service.getChangesForEvent(EVENT);
    assert.equal(result.completeness.coverage.contradictions.status, 'unknown'); assert.equal(result.completeness.status, 'unknown');
    assert.ok(result.warnings.some((row) => row.code === 'CONTRADICTION_COVERAGE_UNKNOWN')); assert.deepEqual(data.calls, [[EVENT, { limit: MAX_LIMIT }]]);
  });
  await test('reaching query cap means limited coverage', async () => {
    const rows = Array.from({ length: MAX_LIMIT }, (_, index) => ({ id: 'stored-' + index, claim_1: { id: 'before-claim' }, claim_2: { id: 'after-claim' }, contradiction_type: 'direct', status: 'unresolved' }));
    const result = await setup(undefined, { rows }).service.getChangesForEvent(EVENT);
    assert.equal(result.completeness.coverage.contradictions.status, 'limited'); assert.equal(result.completeness.status, 'partial');
    assert.ok(result.warnings.some((row) => row.code === 'CONTRADICTION_COVERAGE_LIMITED'));
  });
  await test('contradiction query failure degrades safely', async () => {
    const result = await setup(undefined, { contradictionError: true }).service.getChangesForEvent(EVENT);
    assert.equal(result.count, 2); assert.equal(result.completeness.coverage.contradictions.available, false); assert.ok(result.warnings.some((row) => row.code === 'CONTRADICTION_DATA_UNAVAILABLE'));
  });
  await test('null contradiction response is unavailable', async () => assert.equal((await setup(undefined, { contradictionNull: true }).service.getChangesForEvent(EVENT)).completeness.coverage.contradictions.available, false));
  await test('none outcomes and unrelated stored relations do not create contradictions', async () => {
    const data = setup(undefined, { rows: [{ id: 'none', claim_id_1: 'before-claim', claim_id_2: 'after-claim', contradiction_type: 'none' }, { id: 'other', claim_id_1: 'foreign-a', claim_id_2: 'foreign-b', contradiction_type: 'direct' }] });
    const result = await data.service.getChangesForEvent(EVENT); assert.ok(result.changes.every((change) => change.category !== 'contradictory_information')); assert.equal(result.completeness.coverage.contradictions.accepted, 0);
  });
  await test('numeric difference without stored annotation does not infer contradiction', async () => {
    const result = await setup(fixture.comparisons.find((row) => row.id === 'count')).service.getChangesForEvent(EVENT);
    assert.equal(result.changes[1].category, 'changed_value'); assert.equal(result.changes[1].contradiction, undefined);
  });
  await test('shuffled article, claim and contradiction order is deterministic', async () => {
    const item = fixture.comparisons.find((row) => row.id === 'stored-direct'); const first = setup(item); const second = setup(item);
    second.articles.reverse(); second.claims.reverse(); second.rows.reverse();
    assert.deepEqual(await first.service.getChangesForEvent(EVENT), await second.service.getChangesForEvent(EVENT));
  });
  await test('service inputs remain unchanged and outputs are detached', async () => {
    const data = setup(); const before = JSON.stringify([data.articles, data.claims, data.rows]); const result = await data.service.getChangesForEvent(EVENT);
    result.changes[1].current_report.source.name = 'changed'; result.changes[1].evidence[0].evidence_text = 'changed';
    assert.equal(JSON.stringify([data.articles, data.claims, data.rows]), before);
  });
  await test('unit service paths expose no production models or provider calls', () => {
    assert.equal(providerCalls, 0); assert.ok(!Object.keys(require.cache).some((name) => /[\\/]models[\\/]|gemini|@google|sequelize/.test(name)));
  });
  Module._load = originalLoad; global.fetch = originalFetch;
  console.log('TESTS_PASSED=' + passed); console.log('TESTS_FAILED=' + failed); process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
