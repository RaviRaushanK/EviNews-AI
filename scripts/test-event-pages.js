const assert = require('assert/strict');
const Module = require('module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (/gemini|@google|sequelize|[\\/]models/.test(name)) throw new Error('Forbidden dependency: ' + name);
  return load.call(this, name, ...args);
};
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { createEventPageController } = require('../controllers/eventPageController');
const { createEventPageService, createSequelizeEventPageRepository } = require('../services/eventPageService');
const presentation = require('../utils/eventPresentation');
const { createEventTimelineService } = require('../services/eventTimelineService');
const { createEventChangeService } = require('../services/eventChangeService');
const EVENT = '10000000-0000-4000-8000-000000000001';
const BAD = '<script>alert("fixture")</script>';
let passed = 0;
let failed = 0;
let providerCalls = 0;
global.fetch = () => { providerCalls++; throw new Error('Forbidden provider call'); };
function setup({ empty = false, failure, missing = false } = {}) {
  const articles = [
    { id: 'a', title: 'Earlier ' + BAD, published_at: '2026-10-01T10:00:00Z', source: { name: BAD }, url: 'javascript:alert(1)', processing_status: 'claims_extracted' },
    { id: 'b', title: 'Later report', fetched_at: '2026-10-02T10:00:00Z', source: { name: 'Second source' }, url: 'https://fixture.invalid/report', processing_status: 'claims_extracted' },
    { id: 'c', title: 'Zero claim report', published_at: '2026-10-02T10:00:00Z', source: {}, processing_status: 'claims_extracted' },
    { id: 'd', title: 'Pending report', source: {}, processing_status: 'clustered' }
  ];
  const claims = [
    { id: 'first', article_id: 'a', claim_text: 'The company announced 1000 layoffs. ' + BAD, claim_type: 'factual', confidence_score: .9, evidence: [{ id: 'e1', article_id: 'a', evidence_text: 'Earlier evidence ' + BAD }] },
    { id: 'second', article_id: 'b', claim_text: 'The company announced 2000 layoffs.', claim_type: 'factual', confidence_score: .8, evidence: [{ id: 'e2', article_id: 'b', evidence_text: 'Later evidence' }] }
  ];
  const event = { id: EVENT, title: 'Fixture event ' + BAD, status: 'active', event_date: null };
  const timelineService = createEventTimelineService({
    repository: { findEvent: async () => { if (failure) throw failure; return missing ? null : event; }, findEventArticleIds: async () => empty ? [] : articles.map(a => a.id), loadArticles: async () => articles },
    claimQuery: { getClaimsForEvent: async () => ({ claims }) }
  });
  const changeService = createEventChangeService({ timelineService, contradictionQuery: { getContradictionsForEvent: async () => ({ contradictions: [{ id: 'relation', claim_id_1: 'first', claim_id_2: 'second', contradiction_type: 'direct', status: 'under_review', reason: 'Stored disagreement ' + BAD }] }) } });
  const eventPageService = { listEvents: async () => { if (failure) throw failure; return { events: empty ? [] : [{ ...event, article_count: 4 }], limit: 100 }; } };
  return createEventPageController({ eventPageService, timelineService, changeService });
}
async function page(method = 'show', options = {}, request = {}) {
  const res = { status(code) { this.statusCode = code; return this; }, render(view, data) { this.view = view; this.data = data; return this; } };
  await setup(options)[method]({ params: { eventId: EVENT, ...request.params }, query: request.query || {} }, res);
  res.html = await ejs.renderFile(path.join(__dirname, '..', 'views', res.view + '.ejs'), res.data);
  return res;
}
async function test(name, callback) {
  try { await callback(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' -> ' + error.message); }
}
async function main() {
  await test('event list renders', async () => { const r = await page('index'); assert.equal(r.statusCode, 200); assert.ok(r.html.includes('/events/' + EVENT)); assert.ok(r.html.includes('4 reports')); });
  await test('empty event list', async () => assert.ok((await page('index', { empty: true })).html.includes('No events available.')));
  await test('detail renders timeline and tabs', async () => { const r = await page(); assert.equal(r.statusCode, 200); assert.ok(r.html.includes('What Changed?')); assert.ok(r.html.includes('Timeline')); });
  await test('missing event page 404', async () => assert.equal((await page('show', { missing: true })).statusCode, 404));
  await test('invalid event page 400', async () => assert.equal((await page('show', {}, { params: { eventId: 'bad' } })).statusCode, 400));
  await test('invalid view 400', async () => assert.equal((await page('show', {}, { query: { view: ['timeline'] } })).statusCode, 400));
  await test('invalid page dates 400', async () => assert.equal((await page('show', {}, { query: { view: 'changes', since: 'bad' } })).statusCode, 400));
  await test('unexpected page error sanitized', async () => { const r = await page('index', { failure: new Error('SYNTHETIC_SECRET C:\\private\\db') }); assert.equal(r.statusCode, 500); assert.ok(!r.html.includes('SYNTHETIC_SECRET')); });
  await test('zero claim report retained', async () => { const r = await page(); assert.ok(r.html.includes('Zero claim report')); assert.ok(r.html.includes('No claims were extracted from this report.')); });
  await test('pending claims distinguished', async () => assert.ok((await page()).html.includes('Claims are not available for this report.')));
  await test('evidence and confidence rendered', async () => { const r = await page(); assert.ok(r.html.includes('Earlier evidence')); assert.ok(r.html.includes('Confidence: 90%')); assert.ok(r.html.includes('Original report')); });
  await test('tied timestamps explicitly labelled', async () => assert.ok((await page()).html.includes('Equal-time reports')));
  await test('fetched date provenance', async () => assert.ok((await page()).html.includes('Using fetched time')));
  await test('missing dates handled', async () => assert.ok((await page()).html.includes('Date unavailable')));
  await test('changes show stored contradiction type/status/reason', async () => { const r = await page('show', {}, { query: { view: 'changes' } }); for (const text of ['Contradictory information', 'Stored disagreement', 'direct / under_review', 'Previous', 'Current', 'Later evidence', '2 Oct 2026']) assert.ok(r.html.includes(text), text); });
  await test('empty changes state', async () => assert.ok((await page('show', { empty: true }, { query: { view: 'changes' } })).html.includes('No changes available in this interval.')));
  await test('empty timeline state', async () => assert.ok((await page('show', { empty: true })).html.includes('No reports available for this event.')));
  await test('HTML title/claim/source/evidence escaped', async () => { const r = await page(); assert.ok(!r.html.includes(BAD)); assert.ok(r.html.includes('&lt;script&gt;')); assert.ok(!r.html.includes('href="javascript:')); });
  await test('changes reason HTML escaped', async () => { const r = await page('show', {}, { query: { view: 'changes' } }); assert.ok(!r.html.includes(BAD)); assert.ok(r.html.includes('Stored disagreement &lt;script&gt;')); });
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///private', '//fixture.invalid', 'https://user:pass@fixture.invalid', 'https://fixture.invalid/\nattack', 'not-a-url']) {
    await test('reject unsafe link ' + url.replace(/\n/g, ' '), () => assert.equal(presentation.safeArticleUrl(url), null));
  }
  await test('safe HTTP(S) links accepted', () => { assert.equal(presentation.safeArticleUrl('https://fixture.invalid/a?b=1&c=2'), 'https://fixture.invalid/a?b=1&c=2'); assert.equal(presentation.safeArticleUrl('http://fixture.invalid/'), 'http://fixture.invalid/'); });
  await test('category labels/class whitelist', () => { for (const c of ['new_information', 'previously_reported', 'updated_information', 'changed_value', 'contradictory_information', 'unclassified']) assert.notEqual(presentation.categoryLabel(c), c); assert.equal(presentation.categoryClass(BAD), 'unclassified'); assert.equal(presentation.categoryLabel('__proto__'), 'Unclassified'); });
  await test('confidence bounds', () => { assert.equal(presentation.confidenceLabel(null), 'Unavailable'); assert.equal(presentation.confidenceLabel(2), 'Unavailable'); assert.equal(presentation.confidenceLabel(.87), '87%'); });
  await test('list service counts/defaults and input unchanged', async () => { const events = [{ id: 'a', event_date: 'bad' }, { id: 'b' }]; const before = JSON.stringify(events); const s = createEventPageService({ repository: { listEvents: async () => events, countReports: async ids => { assert.deepEqual(ids, ['a', 'b']); return [{ event_id: 'a', count: '3' }]; } } }); const data = await s.listEvents(); assert.equal(data.events[0].article_count, 3); assert.equal(data.events[1].article_count, 0); assert.equal(data.events[0].event_date, null); assert.equal(JSON.stringify(events), before); });
  await test('list repository read-only bounded queries', async () => { const op = Symbol('in'); let calls = 0; const repo = createSequelizeEventPageRepository({ Event: { findAll: async opts => { calls++; assert.equal(opts.limit, 100); assert.equal(opts.raw, true); assert.deepEqual(opts.order, [['createdAt', 'DESC'], ['id', 'ASC']]); return []; } }, EventArticle: { count: async opts => { calls++; assert.deepEqual(opts.group, ['event_id']); assert.deepEqual(opts.where.event_id[op], ['a']); return []; } } }, { in: op }); await repo.listEvents(); await repo.countReports(['a']); assert.deepEqual(await repo.countReports([]), []); assert.equal(calls, 2); });
  await test('page router preserves GET-only boundaries', () => { const router = require('../routes/events'); assert.deepEqual(router.stack.map(layer => [layer.route.path, layer.route.methods]), [['/events', { get: true }], ['/events/:eventId', { get: true }]]); });
  await test('API routes wired and page mount separate', () => { const routes = fs.readFileSync(path.join(__dirname, '../routes/index.js'), 'utf8'); assert.ok(routes.includes("router.get('/events/:eventId/timeline', timelineController.getTimeline)")); assert.ok(routes.includes("router.get('/events/:eventId/changes', timelineController.getChanges)")); const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'); assert.ok(app.includes("app.use('/api', routes)")); assert.ok(app.includes("app.use(require('./routes/events'))")); });
  await test('no raw EJS text interpolation', () => { for (const name of fs.readdirSync(path.join(__dirname, '../views/events'))) { const text = fs.readFileSync(path.join(__dirname, '../views/events', name), 'utf8'); for (const match of text.matchAll(/<%-([\s\S]*?)%>/g)) assert.ok(match[1].trim().startsWith('include(')); } });
  await test('no provider calls or DB dependencies', () => assert.equal(providerCalls, 0));
  console.log(`Event page tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
