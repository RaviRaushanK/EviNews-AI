const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');
const { createSummaryPageController } = require('../controllers/summaryPageController');

const EVENT = '10000000-0000-4000-8000-000000000001';
const SUMMARY = '20000000-0000-4000-8000-000000000002';
const BAD = '<script>window.secret=1</script>';

function summaryFixture() {
  return {
    id: SUMMARY, event_id: EVENT, summary_text: 'Summary ' + BAD,
    generated_at: '2026-10-01T12:00:00Z', model_version: 'fixture-model',
    generation_status: 'succeeded', grounding_status: 'supported', verification_status: 'needs_review',
    context_snapshot: {
      reports: [{ article_id: 'article-a', title: 'Report ' + BAD, url: 'javascript:alert(1)', source: { name: 'Source ' + BAD } }],
      claims: [{ claim_id: 'claim-a', article_id: 'article-a', claim_text: 'Claim ' + BAD, source: { name: 'Source ' + BAD } }],
      evidence: [{ evidence_id: 'evidence-a', article_id: 'article-a', claim_id: 'claim-a', evidence_text: 'Evidence ' + BAD }],
      contradictions: [{ contradiction_id: 'relation-a', claim_id_1: 'claim-a', claim_id_2: 'claim-b', contradiction_type: 'direct', status: 'under_review', reason: 'Disagreement ' + BAD }],
      coverage: { status: 'partial', contradictions: { status: 'limited' } },
      warnings: [{ code: 'COVERAGE_LIMITED', message: 'Limited source coverage ' + BAD }]
    },
    structured_output: { statements: [{ id: 's1', text: 'Statement ' + BAD, source_claim_ids: ['claim-a'], evidence_ids: ['evidence-a'], contradiction_ids: ['relation-a'], attribution: 'Source ' + BAD }] },
    verification_metadata: { statements: [{ statement_id: 's1', grounding_status: 'supported', checks: [], warnings: [] }] }
  };
}

function setup({ summary = summaryFixture(), event = { id: EVENT, title: 'Event ' + BAD, status: 'active', event_date: '2026-10-01T00:00:00Z' }, result } = {}) {
  const queryService = {
    findEventById: async () => event,
    findSummariesForEvent: async () => summary ? [summary] : [],
    findSummaryById: async () => summary
  };
  const workflowService = { generateForEvent: async () => result || { status: 'ready', reused: true, summary: summaryFixture() } };
  return createSummaryPageController({ queryService, workflowService });
}

async function render(method = 'show', options = {}, request = {}) {
  const res = {
    status(code) { this.statusCode = code; return this; },
    render(view, data) { this.view = view; this.data = data; return this; },
    redirect(code, url) { this.statusCode = code; this.location = url; return this; }
  };
  await setup(options)[method]({ params: { eventId: EVENT, ...request.params }, query: request.query || {}, body: request.body }, res);
  if (res.view) res.html = await ejs.renderFile(path.join(__dirname, '../views', res.view + '.ejs'), res.data);
  return res;
}

test('summary page displays event, generated time, model and source count', async () => {
  const page = await render();
  assert.equal(page.statusCode, 200); assert.match(page.html, /fixture-model/);
  assert.match(page.html, /1 source/); assert.match(page.html, /Grounded/);
});
test('summary, claim, evidence, source and contradiction text are escaped', async () => {
  const page = await render();
  assert.ok(!page.html.includes(BAD)); assert.match(page.html, /&lt;script&gt;/);
  for (const word of ['Summary', 'Statement', 'Claim', 'Evidence', 'Disagreement']) assert.ok(page.html.includes(word));
  assert.ok(!page.html.includes('href="javascript:'));
});
test('evidence and stored contradiction type/status are visible', async () => {
  const page = await render();
  assert.match(page.html, /direct/); assert.match(page.html, /under_review/);
  assert.match(page.html, /Evidence/); assert.match(page.html, /Grounding: supported/);
});
test('verification wording does not claim factual truth', async () => {
  const page = await render();
  assert.match(page.html, /does not establish factual truth/);
  assert.ok(!page.html.includes('Fact Checked')); assert.match(page.html, /Needs Review/);
});
test('limited contradiction coverage warning is visible', async () => {
  const page = await render();
  assert.match(page.html, /Contradiction checks: limited/);
  assert.match(page.html, /do not establish complete claim-pair coverage/);
  assert.ok(!page.html.includes('No contradictions found'));
});
test('empty summary state retains generate action and timeline links', async () => {
  const page = await render('show', { summary: null });
  assert.match(page.html, /No saved summary/); assert.match(page.html, /Generate Summary/);
  assert.match(page.html, /What Changed/); assert.match(page.html, /Timeline/);
});
test('provider failure state is safe and no unsaved prose is displayed', async () => {
  const result = { status: 'failed', error: { code: 'GEMINI_SERVER', message: 'SYNTHETIC_SECRET' } };
  const page = await render('generate', { summary: null, result }, { body: {} });
  assert.equal(page.statusCode, 503); assert.match(page.html, /Generation Failed/);
  assert.ok(!page.html.includes('SYNTHETIC_SECRET'));
});
test('insufficient grounding shows an explicit empty state', async () => {
  const page = await render('generate', { summary: null, result: { status: 'insufficient_grounding', reason: 'NO_CLAIMS' } }, { body: {} });
  assert.equal(page.statusCode, 422); assert.match(page.html, /Insufficient Evidence/);
});
test('needs-review generation does not display unsupported draft', async () => {
  const page = await render('generate', { summary: null, result: { status: 'needs_review', structured_output: { statements: [{ text: 'SYNTHETIC_UNSUPPORTED' }] }, findings: [{ statement_id: 's1', grounding_status: 'needs_review', failed_checks: ['MISSING_SUPPORT'], warnings: [] }] } }, { body: {} });
  assert.equal(page.statusCode, 422); assert.match(page.html, /Needs Review/); assert.match(page.html, /MISSING_SUPPORT/); assert.ok(!page.html.includes('SYNTHETIC_UNSUPPORTED'));
});
test('generation reuse redirects to saved summary', async () => {
  const page = await render('generate', {}, { body: {} });
  assert.equal(page.statusCode, 303); assert.ok(page.location.endsWith('summaryId=' + SUMMARY));
});
test('missing event and cross-event summary are controlled 404s', async () => {
  assert.equal((await render('show', { event: null })).statusCode, 404);
  const other = { ...summaryFixture(), event_id: '90000000-0000-4000-8000-000000000009' };
  assert.equal((await render('show', { summary: other }, { query: { summaryId: SUMMARY } })).statusCode, 404);
});
test('invalid URL ID and request body are rejected', async () => {
  assert.equal((await render('show', {}, { params: { eventId: 'bad' } })).statusCode, 400);
  assert.equal((await render('generate', {}, { body: { model: 'unsafe' } })).statusCode, 400);
});
test('summary page routes are separate from Phase 6 routes', () => {
  const router = require('../routes/eventSummaries');
  assert.deepEqual(router.stack.map(layer => [layer.route.path, layer.route.methods]), [
    ['/events/:eventId/summary', { get: true }], ['/events/:eventId/summary/generate', { post: true }]
  ]);
  assert.match(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), /app\.use\(require\('\.\/routes\/eventSummaries'\)\)/);
});
