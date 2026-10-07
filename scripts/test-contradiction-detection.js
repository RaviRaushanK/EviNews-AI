/**
 * Phase 5 contradiction detection tests.
 * All provider and persistence behavior is controlled in memory.
 */

const assert = require('assert/strict');
const {
  buildContradictionPrompt,
  createSequelizeDetectionRepository,
  createContradictionDetectionService
} = require('../services/contradictionDetectionService');

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID_1 = '20000000-0000-4000-8000-000000000001';
const CLAIM_ID_2 = '20000000-0000-4000-8000-000000000002';
const MODEL = 'test-contradiction-model';
const PROMPT_VERSION = 'phase5-v1';

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

function candidate(fingerprint = 'a'.repeat(64)) {
  return {
    claim_id_1: CLAIM_ID_1,
    claim_id_2: CLAIM_ID_2,
    input_fingerprint: fingerprint,
    claim_1: {
      id: CLAIM_ID_1,
      article_id: '30000000-0000-4000-8000-000000000001',
      claim_text: 'Company X announced 100 layoffs.',
      claim_type: 'data',
      evidence: ['Company X announced 100 layoffs on Monday.'],
      article: {
        id: '30000000-0000-4000-8000-000000000001',
        title: 'Company X announces layoffs',
        source: { id: 'source-1', name: 'Source One' },
        published_at: '2026-10-01T10:00:00.000Z'
      }
    },
    claim_2: {
      id: CLAIM_ID_2,
      article_id: '30000000-0000-4000-8000-000000000002',
      claim_text: 'Company X announced 200 layoffs.',
      claim_type: 'data',
      evidence: ['Company X announced 200 layoffs on Monday.'],
      article: {
        id: '30000000-0000-4000-8000-000000000002',
        title: 'Layoff total disputed',
        source: { id: 'source-2', name: 'Source Two' },
        published_at: '2026-10-01T11:00:00.000Z'
      }
    }
  };
}

function candidateSummary(candidates, overrides = {}) {
  return {
    eventId: EVENT_ID,
    totalClaims: candidates.length > 0 ? 2 : 0,
    rawPairCount: candidates.length,
    compatiblePairCount: candidates.length,
    skippedSameArticle: 0,
    skippedDuplicate: 0,
    skippedIncompatible: 0,
    skippedPreviouslyEvaluated: 0,
    truncatedCandidateCount: 0,
    candidates,
    ...overrides
  };
}

function response(classification, overrides = {}) {
  return JSON.stringify({
    classification,
    reason: classification === 'none'
      ? 'The claims describe a normal update.'
      : 'The claims give incompatible layoff totals for the same reference time.',
    same_subject: true,
    same_reference_time: classification !== 'none',
    normal_update: classification === 'none',
    confidence: 0.91,
    ...overrides
  });
}

function uniqueError() {
  const error = new Error('duplicate');
  error.name = 'SequelizeUniqueConstraintError';
  return error;
}

function createFakeModels(options = {}) {
  const state = {
    checks: [...(options.checks || [])],
    contradictions: [...(options.contradictions || [])],
    transactionsStarted: 0,
    transactionsCommitted: 0,
    transactionsRolledBack: 0
  };

  const sequelize = {
    async transaction(callback) {
      state.transactionsStarted += 1;
      const transaction = { checks: [], contradictions: [] };
      try {
        const result = await callback(transaction);
        state.checks.push(...transaction.checks);
        state.contradictions.push(...transaction.contradictions);
        state.transactionsCommitted += 1;
        return result;
      } catch (error) {
        state.transactionsRolledBack += 1;
        throw error;
      }
    }
  };

  const ContradictionCheck = {
    async create(data, { transaction }) {
      if (options.failCheck) {
        throw new Error('check persistence failed');
      }
      const duplicate = [...state.checks, ...transaction.checks].some((row) =>
        row.claim_id_1 === data.claim_id_1 &&
        row.claim_id_2 === data.claim_id_2 &&
        row.input_fingerprint === data.input_fingerprint);
      if (duplicate) {
        throw uniqueError();
      }
      transaction.checks.push({ ...data });
      return data;
    }
  };

  const Contradiction = {
    async findOne({ where, transaction }) {
      return [...state.contradictions, ...transaction.contradictions].find((row) =>
        row.claim_id_1 === where.claim_id_1 && row.claim_id_2 === where.claim_id_2) || null;
    },
    async create(data, { transaction }) {
      if (options.failContradiction) {
        throw new Error('contradiction persistence failed');
      }
      const duplicate = [...state.contradictions, ...transaction.contradictions].some((row) =>
        row.claim_id_1 === data.claim_id_1 && row.claim_id_2 === data.claim_id_2);
      if (duplicate || options.concurrentContradiction) {
        throw uniqueError();
      }
      transaction.contradictions.push({ ...data });
      return data;
    }
  };

  const Event = {
    async findByPk() {
      return {
        id: EVENT_ID,
        title: 'Company X layoffs',
        description: 'Reports about planned layoffs.',
        event_date: new Date('2026-10-01T09:00:00Z')
      };
    }
  };

  return { state, sequelize, ContradictionCheck, Contradiction, Event };
}

function createHarness({ rawResponse, providerError, modelsOptions, candidateResult } = {}) {
  const models = createFakeModels(modelsOptions);
  const repository = createSequelizeDetectionRepository(models);
  const calls = { gemini: 0, candidate: 0, providerOptions: null };
  const candidateService = {
    async getContradictionCandidates(eventId, options) {
      calls.candidate += 1;
      assert.equal(eventId, EVENT_ID);
      assert.equal(options.includeEvaluated, undefined);
      return candidateResult || candidateSummary([candidate()]);
    }
  };
  const geminiClient = {
    async generateText(prompt, options) {
      calls.gemini += 1;
      calls.providerOptions = options;
      assert.match(prompt, /ARTICLE PUBLICATION TIME/);
      assert.match(prompt, /CLAIM REFERENCE TIME/);
      assert.match(prompt, /normal update/i);
      if (providerError) {
        throw providerError;
      }
      return { text: rawResponse, model: options.model, attempts: 1 };
    }
  };
  const service = createContradictionDetectionService({
    candidateService,
    geminiClient,
    repository,
    config: {
      gemini: { contradictionModel: MODEL },
      detection: { promptVersion: PROMPT_VERSION, maxCandidatesPerRun: 50 }
    },
    now: () => new Date('2026-10-06T10:00:00Z')
  });
  return { service, models, calls };
}

async function main() {
  for (const classification of ['direct', 'partial', 'temporal']) {
    await test(`valid ${classification} creates check and contradiction`, async () => {
      const harness = createHarness({ rawResponse: response(classification) });
      const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
      assert.equal(result.evaluated, 1);
      assert.equal(result.contradictions_created, 1);
      assert.equal(harness.models.state.checks[0].outcome, classification);
      assert.equal(harness.models.state.contradictions[0].contradiction_type, classification);
      assert.equal(harness.models.state.contradictions[0].status, 'unresolved');
    });
  }

  await test('valid none creates contradiction check only', async () => {
    const harness = createHarness({ rawResponse: response('none') });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.none_recorded, 1);
    assert.equal(harness.models.state.checks[0].outcome, 'none');
    assert.equal(harness.models.state.contradictions.length, 0);
  });

  await test('confidence is validated but never persisted', async () => {
    const harness = createHarness({ rawResponse: response('direct', { confidence: 1 }) });
    await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(Object.hasOwn(harness.models.state.checks[0], 'confidence'), false);
    assert.equal(Object.hasOwn(harness.models.state.contradictions[0], 'confidence'), false);
  });

  await test('malformed or wrapped JSON fails evaluation', async () => {
    for (const rawResponse of ['not json', '```json\n' + response('direct') + '\n```', 'Result: ' + response('direct')]) {
      const harness = createHarness({ rawResponse });
      const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
      assert.equal(result.failed, 1);
      assert.equal(result.results[0].error_type, 'parsing');
      assert.equal(harness.models.state.checks.length, 0);
    }
  });

  await test('invalid classification fails validation', async () => {
    const harness = createHarness({ rawResponse: response('conflict') });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].error_type, 'validation');
    assert.equal(harness.models.state.checks.length, 0);
  });

  await test('invalid reason fails validation', async () => {
    const harness = createHarness({ rawResponse: response('direct', { reason: '  ' }) });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].error_type, 'validation');
    assert.equal(harness.models.state.checks.length, 0);
  });

  await test('invalid boolean fails validation', async () => {
    const harness = createHarness({ rawResponse: response('direct', { same_subject: 'true' }) });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].error_type, 'validation');
    assert.equal(harness.models.state.checks.length, 0);
  });

  await test('invalid confidence fails validation', async () => {
    const harness = createHarness({ rawResponse: response('direct', { confidence: 1.5 }) });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].error_type, 'validation');
    assert.equal(harness.models.state.checks.length, 0);
  });

  await test('provider error does not create a none record', async () => {
    const providerError = new Error('provider unavailable');
    providerError.code = 'GEMINI_SERVER';
    const harness = createHarness({ providerError });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].error_type, 'provider');
    assert.equal(result.none_recorded, 0);
    assert.equal(harness.models.state.checks.length, 0);
  });

  await test('persistence failure rolls back check and contradiction', async () => {
    const harness = createHarness({
      rawResponse: response('direct'),
      modelsOptions: { failContradiction: true }
    });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].error_type, 'persistence');
    assert.equal(harness.models.state.transactionsRolledBack, 1);
    assert.equal(harness.models.state.checks.length, 0);
    assert.equal(harness.models.state.contradictions.length, 0);
  });

  await test('canonical claim ordering is preserved', async () => {
    const harness = createHarness({ rawResponse: response('direct') });
    await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(harness.models.state.checks[0].claim_id_1, CLAIM_ID_1);
    assert.equal(harness.models.state.checks[0].claim_id_2, CLAIM_ID_2);
    assert.ok(harness.models.state.checks[0].claim_id_1 < harness.models.state.checks[0].claim_id_2);
  });

  await test('concurrent duplicate check is skipped without duplicate writes', async () => {
    const existing = {
      claim_id_1: CLAIM_ID_1,
      claim_id_2: CLAIM_ID_2,
      input_fingerprint: 'a'.repeat(64),
      outcome: 'none'
    };
    const harness = createHarness({
      rawResponse: response('direct'),
      modelsOptions: { checks: [existing] }
    });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.skipped, 1);
    assert.equal(result.evaluated, 0);
    assert.equal(harness.models.state.checks.length, 1);
    assert.equal(harness.models.state.contradictions.length, 0);
  });

  await test('existing positive contradiction is preserved', async () => {
    const existing = {
      claim_id_1: CLAIM_ID_1,
      claim_id_2: CLAIM_ID_2,
      contradiction_type: 'direct',
      reason: 'Original reason'
    };
    const harness = createHarness({
      rawResponse: response('partial'),
      modelsOptions: { contradictions: [existing] }
    });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].existing_positive, true);
    assert.equal(result.contradictions_created, 0);
    assert.equal(harness.models.state.contradictions.length, 1);
    assert.equal(harness.models.state.contradictions[0].contradiction_type, 'direct');
    assert.equal(harness.models.state.checks[0].outcome, 'partial');
  });

  await test('concurrent contradiction uniqueness preserves ledger evaluation', async () => {
    const harness = createHarness({
      rawResponse: response('direct'),
      modelsOptions: { concurrentContradiction: true }
    });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.results[0].concurrent_positive, true);
    assert.equal(harness.models.state.checks.length, 1);
    assert.equal(harness.models.state.contradictions.length, 0);
    assert.equal(harness.models.state.transactionsCommitted, 1);
  });

  await test('changed fingerprint creates a new check while preserving positive', async () => {
    const existingCheck = {
      claim_id_1: CLAIM_ID_1,
      claim_id_2: CLAIM_ID_2,
      input_fingerprint: 'b'.repeat(64),
      outcome: 'direct'
    };
    const existingContradiction = {
      claim_id_1: CLAIM_ID_1,
      claim_id_2: CLAIM_ID_2,
      contradiction_type: 'direct'
    };
    const harness = createHarness({
      rawResponse: response('partial'),
      modelsOptions: {
        checks: [existingCheck],
        contradictions: [existingContradiction]
      }
    });
    await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(harness.models.state.checks.length, 2);
    assert.equal(harness.models.state.checks[1].input_fingerprint, 'a'.repeat(64));
    assert.equal(harness.models.state.contradictions.length, 1);
  });

  await test('same fingerprint skipped by candidate generation makes no provider call', async () => {
    const harness = createHarness({
      candidateResult: candidateSummary([], { skippedPreviouslyEvaluated: 1 })
    });
    const result = await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.equal(result.skipped, 1);
    assert.equal(result.candidates_considered, 0);
    assert.equal(harness.calls.gemini, 0);
  });

  await test('model is passed explicitly and prompt includes event and claim context', async () => {
    const harness = createHarness({ rawResponse: response('none') });
    await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.deepEqual(harness.calls.providerOptions, { model: MODEL });
    const prompt = buildContradictionPrompt(EVENT_ID, {
      title: 'Event title',
      description: 'Event description',
      event_date: '2026-10-01T09:00:00.000Z'
    }, candidate());
    assert.match(prompt, /Source One/);
    assert.match(prompt, /Company X announces layoffs/);
    assert.match(prompt, new RegExp(EVENT_ID));
  });

  await test('missing model fails before candidates or provider calls', async () => {
    const candidateService = {
      calls: 0,
      async getContradictionCandidates() {
        this.calls += 1;
        return candidateSummary([candidate()]);
      }
    };
    const geminiClient = {
      calls: 0,
      async generateText() {
        this.calls += 1;
      }
    };
    const repository = { async persistEvaluation() {} };
    const service = createContradictionDetectionService({
      candidateService,
      geminiClient,
      repository,
      config: {
        gemini: { contradictionModel: '' },
        detection: { promptVersion: PROMPT_VERSION, maxCandidatesPerRun: 50 }
      }
    });
    await assert.rejects(
      service.detectContradictionsForEvent(EVENT_ID),
      (error) => error.code === 'CONTRADICTION_MODEL_NOT_CONFIGURED'
    );
    assert.equal(candidateService.calls, 0);
    assert.equal(geminiClient.calls, 0);
  });

  await test('invalid detection options fail clearly', async () => {
    const harness = createHarness({ rawResponse: response('none') });
    await assert.rejects(
      harness.service.detectContradictionsForEvent(EVENT_ID, null),
      (error) => error.code === 'INVALID_DETECTION_OPTIONS'
    );
    await assert.rejects(
      harness.service.detectContradictionsForEvent(EVENT_ID, { maxCandidates: '1' }),
      (error) => error.code === 'INVALID_MAX_CANDIDATES'
    );
    assert.equal(harness.calls.candidate, 0);
    assert.equal(harness.calls.gemini, 0);
  });

  await test('no Phase 3 or Phase 4 models are written', async () => {
    const harness = createHarness({ rawResponse: response('direct') });
    await harness.service.detectContradictionsForEvent(EVENT_ID);
    assert.deepEqual(Object.keys(harness.models.state).sort(), [
      'checks',
      'contradictions',
      'transactionsCommitted',
      'transactionsRolledBack',
      'transactionsStarted'
    ]);
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
