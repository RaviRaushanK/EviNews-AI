/**
 * Phase 5 contradiction controller tests.
 * Services are mocked; no Gemini calls or database writes occur.
 */

const assert = require('assert/strict');
const {
  createContradictionController
} = require('../controllers/contradictionController');

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '20000000-0000-4000-8000-000000000001';

let passed = 0;
let failed = 0;

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    console.log('FAIL ' + name + ' -> ' + error.message);
  }
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  error.stack = 'SECRET_STACK_TRACE';
  return error;
}

function createHarness(overrides = {}) {
  const calls = {
    detection: [],
    eventQuery: [],
    claimQuery: [],
    checksQuery: []
  };
  const detectionService = {
    async detectContradictionsForEvent(eventId, options) {
      calls.detection.push({ eventId, options });
      if (overrides.detectionError) {
        throw overrides.detectionError;
      }
      return overrides.detectionResult || { eventId, evaluated: 0, results: [] };
    }
  };
  const queryService = {
    async getContradictionsForEvent(eventId, options) {
      calls.eventQuery.push({ eventId, options });
      if (overrides.eventError) {
        throw overrides.eventError;
      }
      return overrides.eventResult || { event: { id: eventId }, contradictions: [] };
    },
    async getContradictionsForClaim(claimId, options) {
      calls.claimQuery.push({ claimId, options });
      if (overrides.claimError) {
        throw overrides.claimError;
      }
      return overrides.claimResult || { claimId, contradictions: [] };
    },
    async getContradictionChecksForClaim(claimId, options) {
      calls.checksQuery.push({ claimId, options });
      if (overrides.checksError) {
        throw overrides.checksError;
      }
      return overrides.checksResult || { claimId, checks: [] };
    }
  };
  return {
    calls,
    controller: createContradictionController({ detectionService, queryService })
  };
}

async function invoke(handler, request) {
  const res = responseRecorder();
  await handler(request, res);
  return res;
}

async function main() {
  await test('event detection delegates to detection service', async () => {
    const { controller, calls } = createHarness();
    const res = await invoke(controller.detectForEvent, {
      params: { eventId: EVENT_ID },
      body: { maxCandidates: 20, dryRun: false }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.detection, [{
      eventId: EVENT_ID,
      options: { maxCandidates: 20, dryRun: false }
    }]);
  });

  await test('event query delegates parsed query options', async () => {
    const { controller, calls } = createHarness();
    await invoke(controller.listForEvent, {
      params: { eventId: EVENT_ID },
      query: { status: 'unresolved', type: 'direct', limit: '50' }
    });
    assert.deepEqual(calls.eventQuery[0], {
      eventId: EVENT_ID,
      options: { status: 'unresolved', type: 'direct', limit: 50 }
    });
  });

  await test('claim query delegates to query service', async () => {
    const { controller, calls } = createHarness();
    await invoke(controller.listForClaim, {
      params: { claimId: CLAIM_ID },
      query: { limit: '10' }
    });
    assert.deepEqual(calls.claimQuery[0], {
      claimId: CLAIM_ID,
      options: { limit: 10 }
    });
  });

  await test('evaluation history delegates without unsupported outcome filter', async () => {
    const { controller, calls } = createHarness();
    await invoke(controller.listChecksForClaim, {
      params: { claimId: CLAIM_ID },
      query: { limit: '5' }
    });
    assert.deepEqual(calls.checksQuery[0], {
      claimId: CLAIM_ID,
      options: { limit: 5 }
    });
  });

  await test('missing eventId returns 400', async () => {
    const { controller } = createHarness();
    const res = await invoke(controller.listForEvent, { params: {}, query: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  await test('missing claimId returns 400', async () => {
    const { controller } = createHarness();
    const res = await invoke(controller.listForClaim, { params: {}, query: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  await test('invalid primitive query parameters return 400', async () => {
    const { controller, calls } = createHarness();
    const limit = await invoke(controller.listForEvent, {
      params: { eventId: EVENT_ID },
      query: { limit: '1.5' }
    });
    const status = await invoke(controller.listForEvent, {
      params: { eventId: EVENT_ID },
      query: { status: 10 }
    });
    const outcome = await invoke(controller.listChecksForClaim, {
      params: { claimId: CLAIM_ID },
      query: { outcome: 'none' }
    });
    assert.equal(limit.statusCode, 400);
    assert.equal(status.statusCode, 400);
    assert.equal(outcome.statusCode, 400);
    assert.equal(calls.eventQuery.length, 0);
    assert.equal(calls.checksQuery.length, 0);
  });

  await test('invalid detection body and unsupported dry run return 400', async () => {
    const { controller, calls } = createHarness();
    const invalid = await invoke(controller.detectForEvent, {
      params: { eventId: EVENT_ID },
      body: { maxCandidates: '20' }
    });
    const dryRun = await invoke(controller.detectForEvent, {
      params: { eventId: EVENT_ID },
      body: { dryRun: true }
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(dryRun.statusCode, 400);
    assert.equal(calls.detection.length, 0);
  });

  await test('service not-found error maps to 404', async () => {
    const { controller } = createHarness({
      eventError: codedError('EVENT_NOT_FOUND', 'Event not found')
    });
    const res = await invoke(controller.listForEvent, {
      params: { eventId: EVENT_ID },
      query: {}
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.message, 'Event not found');
  });

  await test('invalid-input service error maps to 400', async () => {
    const { controller } = createHarness({
      claimError: codedError('INVALID_CLAIM_ID', 'claim_id must be a valid UUID')
    });
    const res = await invoke(controller.listForClaim, {
      params: { claimId: CLAIM_ID },
      query: {}
    });
    assert.equal(res.statusCode, 400);
  });

  await test('provider error maps to sanitized 502', async () => {
    const { controller } = createHarness({
      detectionError: codedError('GEMINI_SERVER', 'raw provider response SECRET')
    });
    const res = await invoke(controller.detectForEvent, {
      params: { eventId: EVENT_ID },
      body: {}
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error.message, 'Upstream Gemini request failed');
    assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
  });

  await test('concurrency conflict maps to 409', async () => {
    const { controller } = createHarness({
      detectionError: codedError('CONTRADICTION_CHECK_ALREADY_EXISTS')
    });
    const res = await invoke(controller.detectForEvent, {
      params: { eventId: EVENT_ID },
      body: {}
    });
    assert.equal(res.statusCode, 409);
  });

  await test('unexpected error maps to sanitized 500', async () => {
    const { controller } = createHarness({
      claimError: codedError('SQL_INTERNAL_FAILURE', 'database password SECRET')
    });
    const res = await invoke(controller.listForClaim, {
      params: { claimId: CLAIM_ID },
      query: {}
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.message, 'Internal server error');
    assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
  });

  await test('successful responses use success=true and data', async () => {
    const expected = { claimId: CLAIM_ID, contradictions: [] };
    const { controller } = createHarness({ claimResult: expected });
    const res = await invoke(controller.listForClaim, {
      params: { claimId: CLAIM_ID },
      query: {}
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data, expected);
  });

  await test('error responses use success=false without stack trace', async () => {
    const { controller } = createHarness({
      eventError: codedError('EVENT_NOT_FOUND', 'Event not found')
    });
    const res = await invoke(controller.listForEvent, {
      params: { eventId: EVENT_ID },
      query: {}
    });
    assert.equal(res.body.success, false);
    assert.equal(Object.hasOwn(res.body.error, 'stack'), false);
    assert.equal(JSON.stringify(res.body).includes('SECRET_STACK_TRACE'), false);
  });

  await test('controller never exposes raw Gemini error content', async () => {
    const { controller } = createHarness({
      detectionError: codedError('GEMINI_ERROR', 'raw Gemini body and authorization SECRET')
    });
    const res = await invoke(controller.detectForEvent, {
      params: { eventId: EVENT_ID },
      body: {}
    });
    assert.equal(JSON.stringify(res.body).includes('raw Gemini'), false);
    assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
  });

  await test('all required Express routes are registered once', () => {
    const router = require('../routes');
    const routes = router.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).filter((method) => layer.route.methods[method])
      }));
    const required = [
      ['post', '/events/:eventId/contradictions/detect'],
      ['get', '/events/:eventId/contradictions'],
      ['get', '/claims/:claimId/contradictions'],
      ['get', '/claims/:claimId/contradiction-checks']
    ];
    for (const [method, path] of required) {
      assert.equal(
        routes.filter((route) => route.path === path && route.methods.includes(method)).length,
        1
      );
    }
  });

  console.log('---');
  console.log('TESTS_PASSED=' + passed);
  console.log('TESTS_FAILED=' + failed);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
