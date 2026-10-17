const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (/gemini|@google|sequelize|[\\/]models|^https?$|^net$/.test(name)) throw new Error('Forbidden test dependency: ' + name);
  return originalLoad.call(this, name, ...args);
};
const { createEventTimelineService, createSequelizeTimelineRepository } = require('../services/eventTimelineService');
const fixture = require('../fixtures/phase6-utilities.json');
const EVENT = '10000000-0000-4000-8000-000000000001';
const OTHER_EVENT = '10000000-0000-4000-8000-000000000002';
let passed = 0;
let failed = 0;
let providerCalls = 0;
const originalFetch = global.fetch;
global.fetch = () => { providerCalls++; throw new Error('Forbidden provider call'); };
async function test(name, callback) {
  try { await callback(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' -> ' + error.message); }
}
function setup(overrides = {}) {
  const articles = overrides.articles || fixture.articles.map((article) => ({ ...structuredClone(article), url: 'https://fixture.invalid/' + article.id, processing_status: 'claims_extracted' }));
  const members = overrides.members || articles.map((article) => article.id);
  const claims = overrides.claims === undefined ? [{ ...structuredClone(fixture.claims[0]), article_id: 'fixture-a', event_id: null, confidence_score: 0.8, evidence: [{ ...structuredClone(fixture.claims[0].evidence[0]), article_id: 'fixture-a', claim_id: 'fixture-claim' }] }] : overrides.claims;
  const calls = [];
  const repository = {
    async findEvent(id) { calls.push(['event', id]); return overrides.missing ? null : { id, title: 'Isolated event', event_date: '2026-10-01' }; },
    async findEventArticleIds(id) { calls.push(['membership', id]); return members; },
    async loadArticles(ids) { calls.push(['articles', [...ids]]); return articles; }
  };
  const claimQuery = {
    async getClaimsForEvent(id) { calls.push(['claims', id]); if (overrides.claimError) throw new Error('Unavailable'); return claims === null ? null : { claims }; }
  };
  return { service: createEventTimelineService({ repository, claimQuery }), calls, articles, claims, repository };
}

async function main() {
  await test('event membership excludes unrelated articles and claims', async () => {
    const data = setup({ members: ['fixture-a'], claims: [{ ...fixture.claims[0], article_id: 'fixture-b' }] });
    const result = await data.service.getTimelineForEvent(EVENT);
    assert.deepEqual(result.entries.map((entry) => entry.article_id), ['fixture-a']);
    assert.equal(result.entries[0].claim_count, 0);
    assert.deepEqual(data.calls.find(([name]) => name === 'articles')[1], ['fixture-a']);
  });
  await test('requested event determines membership including multi-event articles', async () => {
    const data = setup();
    data.repository.findEventArticleIds = async (id) => id === EVENT ? ['fixture-a'] : ['fixture-a', 'fixture-b'];
    assert.equal((await data.service.getTimelineForEvent(EVENT)).count, 1);
    assert.equal((await data.service.getTimelineForEvent(OTHER_EVENT)).count, 2);
  });
  await test('nullable claim event ID preserves claims', async () => {
    const result = await setup().service.getTimelineForEvent(EVENT);
    const entry = result.entries.find((row) => row.article_id === 'fixture-a');
    assert.equal(entry.claim_count, 1); assert.equal(entry.claims[0].event_id, null);
  });
  await test('claims with another event ID still follow article membership', async () => {
    const data = setup(); data.claims[0].event_id = OTHER_EVENT;
    assert.equal((await data.service.getTimelineForEvent(EVENT)).entries[0].claim_count, 1);
  });
  await test('article URL, source, confidence and evidence context preserved', async () => {
    const result = await setup().service.getTimelineForEvent(EVENT);
    const entry = result.entries[0];
    assert.equal(entry.url, 'https://fixture.invalid/fixture-a');
    assert.equal(entry.source.name, 'Fixture A'); assert.equal(entry.claims[0].confidence_score, 0.8);
    assert.equal(entry.evidence[0].evidence_location.paragraph, 1);
    assert.equal(entry.evidence[0].article.id, 'fixture-a'); assert.equal(entry.evidence[0].source.name, 'Fixture A');
  });
  await test('published date takes precedence and timezone offsets normalize', async () => {
    const entry = (await setup().service.getTimelineForEvent(EVENT)).entries[0];
    assert.equal(entry.report_timestamp, '2026-10-01T10:00:00.000Z'); assert.equal(entry.date_source, 'published_at');
  });
  await test('null publication time falls back to fetched time', async () => {
    const entry = (await setup().service.getTimelineForEvent(EVENT)).entries.find((row) => row.article_id === 'fixture-fallback');
    assert.equal(entry.date_source, 'fetched_at'); assert.equal(entry.report_timestamp, '2026-10-02T10:00:00.000Z');
  });
  await test('invalid publication time falls back when collection time valid', async () => {
    const data = setup(); data.articles[2].published_at = 'invalid';
    assert.equal((await data.service.getTimelineForEvent(EVENT)).entries.find((row) => row.article_id === 'fixture-fallback').date_source, 'fetched_at');
  });
  await test('invalid dates keep article visible and warn', async () => {
    const result = await setup().service.getTimelineForEvent(EVENT);
    assert.equal(result.entries.find((row) => row.article_id === 'fixture-invalid').report_timestamp, null);
    assert.ok(result.warnings.some((row) => row.code === 'REPORT_DATE_UNAVAILABLE'));
  });
  await test('unusual old dates are preserved', async () => {
    const data = setup(); data.articles[0].published_at = '2001-01-01';
    const result = await data.service.getTimelineForEvent(EVENT);
    assert.equal(result.entries[0].article_id, 'fixture-b'); assert.equal(result.entries[0].report_timestamp, '2001-01-01T00:00:00.000Z');
  });
  await test('timestamp ties are grouped without baseline ordering', async () => {
    const result = await setup().service.getTimelineForEvent(EVENT);
    assert.equal(result.groups[0].tied, true); assert.deepEqual(result.groups[0].entries.map((row) => row.article_id), ['fixture-a', 'fixture-b']);
  });
  await test('zero claims retain visible complete entries', async () => {
    const result = await setup({ claims: [] }).service.getTimelineForEvent(EVENT);
    assert.equal(result.count, 4); assert.ok(result.entries.every((row) => row.claims_empty));
  });
  await test('pending extraction is distinguished from accepted zero claims', async () => {
    const data = setup({ claims: [] }); data.articles[0].processing_status = 'clustered';
    const result = await data.service.getTimelineForEvent(EVENT);
    assert.equal(result.entries.find((row) => row.article_id === 'fixture-b').claims_status, 'unavailable');
    assert.ok(result.warnings.some((row) => row.code === 'CLAIMS_NOT_EXTRACTED'));
  });
  await test('null claims keep every article visible', async () => {
    const result = await setup({ claims: null }).service.getTimelineForEvent(EVENT);
    assert.equal(result.count, 4); assert.ok(result.entries.every((row) => row.claims_unavailable));
    assert.ok(result.warnings.some((row) => row.code === 'CLAIMS_UNAVAILABLE'));
  });
  await test('claim query failure degrades safely', async () => assert.equal((await setup({ claimError: true }).service.getTimelineForEvent(EVENT)).completeness.status, 'partial'));
  await test('missing evidence is explicit without losing the claim', async () => {
    const data = setup(); delete data.claims[0].evidence;
    const result = await data.service.getTimelineForEvent(EVENT);
    assert.equal(result.entries[0].claims[0].evidence_status, 'unavailable');
    assert.ok(result.warnings.some((row) => row.code === 'EVIDENCE_UNAVAILABLE'));
  });
  await test('empty event does not query articles or claims', async () => {
    const data = setup({ members: [] }); const result = await data.service.getTimelineForEvent(EVENT);
    assert.deepEqual(result.entries, []); assert.deepEqual(result.groups, []);
    assert.deepEqual(data.calls.map(([name]) => name), ['event', 'membership']);
  });
  await test('missing event is a controlled error', async () => await assert.rejects(setup({ missing: true }).service.getTimelineForEvent(EVENT), { code: 'EVENT_NOT_FOUND' }));
  await test('invalid event ID fails before reads', async () => {
    const data = setup(); await assert.rejects(data.service.getTimelineForEvent('invalid'), { code: 'INVALID_EVENT_ID' }); assert.deepEqual(data.calls, []);
  });
  await test('membership read errors are controlled and sanitized', async () => {
    const data = setup(); data.repository.findEventArticleIds = async () => { throw new Error('Sensitive internal detail'); };
    await assert.rejects(data.service.getTimelineForEvent(EVENT), (error) => error.code === 'TIMELINE_READ_ERROR' && !error.message.includes('Sensitive'));
  });
  await test('missing article metadata retains membership placeholder', async () => {
    const result = await setup({ members: ['missing'] }).service.getTimelineForEvent(EVENT);
    assert.equal(result.entries[0].article_id, 'missing'); assert.equal(result.entries[0].article_available, false);
  });
  await test('shuffled reads produce identical output', async () => {
    const first = setup(); const second = setup(); second.articles.reverse(); second.claims.reverse();
    assert.deepEqual(await first.service.getTimelineForEvent(EVENT), await second.service.getTimelineForEvent(EVENT));
  });
  await test('returned structures are detached from supplied objects', async () => {
    const data = setup(); const snapshot = JSON.stringify([data.articles, data.claims]); const result = await data.service.getTimelineForEvent(EVENT);
    result.entries[0].source.name = 'changed'; result.entries[0].claims[0].evidence[0].evidence_location.paragraph = 99;
    assert.equal(JSON.stringify([data.articles, data.claims]), snapshot);
  });
  await test('focused Sequelize adapter uses read methods and required fields only', async () => {
    const queries = [];
    const models = {
      Event: { findByPk: async (id, options) => { queries.push(['event', options]); return { id }; } },
      EventArticle: { findAll: async (options) => { queries.push(['members', options]); return [{ article_id: 'fixture-a' }]; } },
      Article: { findAll: async (options) => { queries.push(['articles', options]); return [{ toJSON: () => ({ id: 'fixture-a', Source: { id: 'source-a', name: 'Fixture A', url: 'https://fixture.invalid' } }) }]; } },
      Source: {}
    };
    const repository = createSequelizeTimelineRepository(models, { in: 'in' });
    await repository.findEvent(EVENT); const ids = await repository.findEventArticleIds(EVENT); const articles = await repository.loadArticles(ids);
    const query = queries.find(([name]) => name === 'articles')[1];
    assert.deepEqual(query.attributes, ['id', 'source_id', 'title', 'url', 'published_at', 'fetched_at', 'processing_status']);
    assert.deepEqual(query.include[0].attributes, ['id', 'name', 'url']); assert.equal(query.include.length, 1);
    assert.equal(articles[0].source.name, 'Fixture A');
    assert.ok(!query.attributes.includes('content')); assert.deepEqual(query.where, { id: { in: ['fixture-a'] } });
    assert.deepEqual(await repository.loadArticles([]), []);
  });
  await test('no models loaded, provider calls or write methods available', () => {
    assert.equal(providerCalls, 0);
    assert.ok(!Object.keys(require.cache).some((name) => /[\\/]models[\\/]|gemini|@google|sequelize/.test(name)));
  });
  Module._load = originalLoad; global.fetch = originalFetch;
  console.log('TESTS_PASSED=' + passed); console.log('TESTS_FAILED=' + failed); process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
