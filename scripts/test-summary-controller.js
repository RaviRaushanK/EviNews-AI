const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSummaryController } = require('../controllers/summaryController');
const { createSummaryWorkflowService } = require('../services/summaryWorkflowService');
const { buildInputFingerprint } = require('../utils/summaryValidation');

const EVENT = '10000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const SUMMARY = '30000000-0000-4000-8000-000000000003';
const saved = { id: SUMMARY, event_id: EVENT, generated_at: '2026-10-01T00:00:00Z', grounding_status: 'supported', verification_status: 'needs_review', model_version: 'fixture-model' };

function controllerFixture({ event = { id: EVENT }, summaries = [saved], detail = saved, generated = { status: 'ready', reused: false, summary: saved } } = {}) {
  let queries = 0;
  let generationCalls = 0;
  const queryService = {
    async findEventById() { queries++; return event; },
    async findSummariesForEvent() { queries++; return summaries; },
    async findSummaryById() { queries++; return detail; }
  };
  const workflowService = { async generateForEvent() { generationCalls++; return generated; } };
  const controller = createSummaryController({ queryService, workflowService });
  return { controller, queries: () => queries, generationCalls: () => generationCalls };
}

async function invoke(controller, method, { eventId = EVENT, summaryId = SUMMARY, body } = {}) {
  const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await controller[method]({ params: { eventId, summaryId }, body }, res);
  return res;
}

function context() {
  const value = { event: { id: EVENT }, reports: [], claims: [], evidence: [], contradictions: [], metadata: {} };
  value.metadata.input_fingerprint = buildInputFingerprint(value);
  return value;
}

test('list summaries returns stable success envelope', async () => {
  const { controller } = controllerFixture(); const res = await invoke(controller, 'listForEvent');
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true); assert.equal(res.body.data[0].id, SUMMARY);
  assert.equal(res.body.data[0].context_snapshot, undefined);
});
test('empty summary list is successful', async () => {
  const res = await invoke(controllerFixture({ summaries: [] }).controller, 'listForEvent');
  assert.deepEqual(res.body.data, []);
});
test('detail returns summary only for its own event', async () => {
  const res = await invoke(controllerFixture().controller, 'getForEvent');
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.id, SUMMARY);
});
test('cross-event summary is not found', async () => {
  const res = await invoke(controllerFixture().controller, 'getForEvent', { eventId: OTHER });
  assert.equal(res.statusCode, 404); assert.equal(res.body.error.code, 'SUMMARY_NOT_FOUND');
});
test('missing summary and missing event are controlled 404s', async () => {
  assert.equal((await invoke(controllerFixture({ detail: null }).controller, 'getForEvent')).statusCode, 404);
  assert.equal((await invoke(controllerFixture({ event: null }).controller, 'listForEvent')).statusCode, 404);
});
test('invalid event ID is rejected before reads', async () => {
  const fixture = controllerFixture(); const res = await invoke(fixture.controller, 'listForEvent', { eventId: 'bad' });
  assert.equal(res.statusCode, 400); assert.equal(fixture.queries(), 0);
});
test('invalid summary ID is rejected before reads', async () => {
  const fixture = controllerFixture(); const res = await invoke(fixture.controller, 'getForEvent', { summaryId: 'bad' });
  assert.equal(res.statusCode, 400); assert.equal(fixture.queries(), 0);
});
test('generate endpoint returns created summary', async () => {
  const fixture = controllerFixture(); const res = await invoke(fixture.controller, 'generateForEvent', { body: {} });
  assert.equal(res.statusCode, 201); assert.equal(res.body.data.summary.id, SUMMARY); assert.equal(fixture.generationCalls(), 1);
});
test('existing summary uses 200 and reused flag', async () => {
  const result = { status: 'ready', reused: true, summary: saved };
  const res = await invoke(controllerFixture({ generated: result }).controller, 'generateForEvent');
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.reused, true);
});
test('provider failure returns safe API error and no summary', async () => {
  const result = { status: 'failed', error: { code: 'GEMINI_SERVER', message: 'SECRET_RAW_RESPONSE' } };
  const res = await invoke(controllerFixture({ generated: result }).controller, 'generateForEvent');
  assert.equal(res.statusCode, 503); assert.equal(res.body.success, false);
  assert.ok(!JSON.stringify(res.body).includes('SECRET_RAW_RESPONSE'));
});
test('malformed model output maps to safe error', async () => {
  const res = await invoke(controllerFixture({ generated: { status: 'failed', error: { code: 'SUMMARY_INVALID_OUTPUT' } } }).controller, 'generateForEvent');
  assert.equal(res.statusCode, 502); assert.equal(res.body.error.code, 'SUMMARY_INVALID_OUTPUT');
});
test('grounding review and insufficient evidence do not return a saved summary', async () => {
  for (const [status, code] of [['needs_review', 'SUMMARY_NEEDS_REVIEW'], ['insufficient_grounding', 'SUMMARY_INSUFFICIENT_GROUNDING']]) {
    const res = await invoke(controllerFixture({ generated: { status } }).controller, 'generateForEvent');
    assert.equal(res.statusCode, 422); assert.equal(res.body.error.code, code);
  }
});
test('unknown request body is rejected without generation', async () => {
  const fixture = controllerFixture(); const res = await invoke(fixture.controller, 'generateForEvent', { body: { model: 'unsafe' } });
  assert.equal(res.statusCode, 400); assert.equal(fixture.generationCalls(), 0);
});
test('unexpected SQL or key-bearing error is sanitized', async () => {
  const fixture = controllerFixture(); fixture.controller.listForEvent = createSummaryController({
    queryService: { findEventById: async () => { throw new Error('SYNTHETIC_API_KEY sql text C:\\private'); } }, workflowService: {}
  }).listForEvent;
  const res = await invoke(fixture.controller, 'listForEvent');
  assert.equal(res.statusCode, 500); assert.ok(!JSON.stringify(res.body).includes('SYNTHETIC_API_KEY'));
});
test('workflow returns existing fingerprint without generating or persisting', async () => {
  let generationCalls = 0; let writes = 0;
  const service = createSummaryWorkflowService({
    contextService: { buildContextForEvent: async () => context() },
    generationService: { generateSummaryForEvent: async () => { generationCalls++; } },
    queryService: { findSummaryByFingerprint: async () => saved, persistSummary: async () => { writes++; } }
  });
  const result = await service.generateForEvent(EVENT);
  assert.equal(result.status, 'ready'); assert.equal(result.reused, true); assert.equal(result.attempts, 0);
  assert.equal(generationCalls, 0); assert.equal(writes, 0);
});
test('workflow passes one frozen fingerprinted context and persists once', async () => {
  let passedContext = null; let writes = 0;
  const snapshot = context();
  const service = createSummaryWorkflowService({
    contextService: { buildContextForEvent: async () => snapshot },
    generationService: { generateSummaryForEvent: async (id, supplied) => { passedContext = supplied; return { status: 'generated', attempts: 1, persistenceReady: { event_id: id, input_fingerprint: supplied.metadata.input_fingerprint } }; } },
    queryService: { findSummaryByFingerprint: async () => null, persistSummary: async () => { writes++; return saved; } }
  });
  const result = await service.generateForEvent(EVENT);
  assert.equal(passedContext, snapshot); assert.equal(writes, 1); assert.equal(result.status, 'ready');
});
test('workflow never persists failed, malformed, review, or insufficient results', async () => {
  for (const status of ['failed', 'needs_review', 'insufficient_grounding']) {
    let writes = 0;
    const service = createSummaryWorkflowService({
      contextService: { buildContextForEvent: async () => context() },
      generationService: { generateSummaryForEvent: async () => ({ status, error: { code: 'SUMMARY_INVALID_OUTPUT' } }) },
      queryService: { findSummaryByFingerprint: async () => null, persistSummary: async () => { writes++; } }
    });
    assert.equal((await service.generateForEvent(EVENT)).status, status); assert.equal(writes, 0);
  }
});
test('review result keeps sanitized grounding findings without storing prose', async () => {
  const service = createSummaryWorkflowService({
    contextService: { buildContextForEvent: async () => context() },
    generationService: { generateSummaryForEvent: async () => ({ status: 'needs_review', verification_metadata: { statements: [{ statement_id: 's1', grounding_status: 'needs_review', checks: [{ code: 'MISSING_SUPPORT', passed: false }], warnings: [] }] } }) },
    queryService: { findSummaryByFingerprint: async () => null, persistSummary: async () => { throw new Error('must not persist'); } }
  });
  const result = await service.generateForEvent(EVENT);
  assert.deepEqual(result.findings[0].failed_checks, ['MISSING_SUPPORT']); assert.equal(result.summary, null);
});
test('concurrent identical requests share one generation and one write', async () => {
  let calls = 0; let writes = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createSummaryWorkflowService({
    contextService: { buildContextForEvent: async () => context() },
    generationService: { generateSummaryForEvent: async (id, snapshot) => { calls++; await gate; return { status: 'generated', persistenceReady: { event_id: id, input_fingerprint: snapshot.metadata.input_fingerprint } }; } },
    queryService: { findSummaryByFingerprint: async () => null, persistSummary: async () => { writes++; return saved; } }
  });
  const first = service.generateForEvent(EVENT); const second = service.generateForEvent(EVENT); release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(writes, 1); assert.deepEqual(results.map(row => row.reused).sort(), [false, true]);
});
test('changed context fingerprint permits a new generation', async () => {
  let calls = 0; let revision = 0;
  const service = createSummaryWorkflowService({
    contextService: { buildContextForEvent: async () => { const value = context(); value.event.title = String(++revision); value.metadata.input_fingerprint = buildInputFingerprint(value); return value; } },
    generationService: { generateSummaryForEvent: async (id, snapshot) => { calls++; return { status: 'generated', persistenceReady: { event_id: id, input_fingerprint: snapshot.metadata.input_fingerprint } }; } },
    queryService: { findSummaryByFingerprint: async () => null, persistSummary: async () => saved }
  });
  await service.generateForEvent(EVENT); await service.generateForEvent(EVENT); assert.equal(calls, 2);
});
test('workflow rejects context from another event before generation', async () => {
  let calls = 0;
  const service = createSummaryWorkflowService({
    contextService: { buildContextForEvent: async () => { const value = context(); value.event.id = OTHER; value.metadata.input_fingerprint = buildInputFingerprint(value); return value; } },
    generationService: { generateSummaryForEvent: async () => { calls++; } },
    queryService: { findSummaryByFingerprint: async () => null, persistSummary: async () => {} }
  });
  await assert.rejects(service.generateForEvent(EVENT), { code: 'SUMMARY_CONTEXT_INVALID' }); assert.equal(calls, 0);
});
