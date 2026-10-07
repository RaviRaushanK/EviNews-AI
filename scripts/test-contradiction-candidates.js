/**
 * Phase 5 contradiction candidate tests.
 * Uses an in-memory read repository; no database, Gemini, or network access.
 */

const assert = require('assert/strict');
const {
  isObviousDuplicate,
  assessCompatibility,
  generateCandidatePairs,
  createContradictionCandidateService
} = require('../services/contradictionCandidateService');

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_EVENT_ID = '10000000-0000-4000-8000-000000000002';
const MODEL = 'test-contradiction-model';
const PROMPT_VERSION = 'phase5-v1';

let passed = 0;
let failed = 0;

function test(name, callback) {
  return Promise.resolve()
    .then(callback)
    .then(() => {
      passed += 1;
      console.log('PASS ' + name);
    })
    .catch((error) => {
      failed += 1;
      console.log('FAIL ' + name + ' -> ' + error.message);
    });
}

function id(number) {
  return `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function articleId(number) {
  return `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function claim(number, articleNumber, text, overrides = {}) {
  return {
    id: id(number),
    article_id: articleId(articleNumber),
    event_id: EVENT_ID,
    claim_text: text,
    claim_type: 'fact',
    evidence: [`Evidence for claim ${number}: ${text}`],
    article: {
      id: articleId(articleNumber),
      title: `Article ${articleNumber}`,
      source: { id: `source-${articleNumber}`, name: `Source ${articleNumber}` },
      published_at: `2026-10-0${Math.min(articleNumber, 9)}T10:00:00Z`
    },
    ...overrides
  };
}

function config(model = MODEL) {
  return {
    gemini: { contradictionModel: model },
    detection: { promptVersion: PROMPT_VERSION, maxCandidatesPerRun: 50 }
  };
}

function createRepository(eventClaims, checks = []) {
  const calls = { loadClaimsForEvent: 0, loadExistingChecks: 0, writes: 0 };
  return {
    calls,
    async loadClaimsForEvent(eventId) {
      calls.loadClaimsForEvent += 1;
      if (eventId === EVENT_ID) {
        return { eventExists: true, claims: eventClaims };
      }
      if (eventId === OTHER_EVENT_ID) {
        return { eventExists: true, claims: [] };
      }
      return { eventExists: false, claims: [] };
    },
    async loadExistingChecks() {
      calls.loadExistingChecks += 1;
      return checks;
    }
  };
}

function createService(repository, model = MODEL) {
  return createContradictionCandidateService({ repository, config: config(model) });
}

async function main() {
  await test('same-article claim pairs are excluded', () => {
    const result = generateCandidatePairs([
      claim(1, 1, 'Company X announced 100 layoffs.'),
      claim(2, 1, 'Company X denied announcing 100 layoffs.')
    ], { model: MODEL, promptVersion: PROMPT_VERSION });
    assert.equal(result.skippedSameArticle, 1);
    assert.equal(result.generated.length, 0);
  });

  await test('cross-article potentially conflicting pair is generated', () => {
    const result = generateCandidatePairs([
      claim(1, 1, 'Company X announced 100 layoffs.'),
      claim(2, 2, 'Company X announced 200 layoffs.')
    ], { model: MODEL, promptVersion: PROMPT_VERSION });
    assert.equal(result.rawPairCount, 1);
    assert.equal(result.generated.length, 1);
  });

  await test('pair order is canonical', () => {
    const result = generateCandidatePairs([
      claim(2, 2, 'Company X announced 200 layoffs.'),
      claim(1, 1, 'Company X announced 100 layoffs.')
    ], { model: MODEL, promptVersion: PROMPT_VERSION });
    assert.equal(result.generated[0].claim_id_1, id(1));
    assert.equal(result.generated[0].claim_id_2, id(2));
  });

  await test('A-B and B-A are never both returned', () => {
    const result = generateCandidatePairs([
      claim(2, 2, 'Company X announced 200 layoffs.'),
      claim(1, 1, 'Company X announced 100 layoffs.')
    ], { model: MODEL, promptVersion: PROMPT_VERSION });
    assert.equal(result.generated.length, 1);
    assert.equal(new Set(result.generated.map((item) => `${item.claim_id_1}:${item.claim_id_2}`)).size, 1);
  });

  await test('exact and lightly normalized duplicate claims are excluded', () => {
    assert.equal(isObviousDuplicate(
      'Company X announced 100 layoffs.',
      '  The company X announced 100 layoffs! '
    ), true);
    const result = generateCandidatePairs([
      claim(1, 1, 'Company X announced 100 layoffs.'),
      claim(2, 2, 'The company X announced 100 layoffs!')
    ], { model: MODEL, promptVersion: PROMPT_VERSION });
    assert.equal(result.skippedDuplicate, 1);
    assert.equal(result.generated.length, 0);
  });

  await test('obvious unrelated claims are filtered', () => {
    const first = claim(1, 1, 'Company X announced 100 layoffs.');
    const second = claim(2, 2, 'A Mars rover photographed an ancient crater.');
    assert.equal(assessCompatibility(first, second).compatible, false);
    assert.equal(assessCompatibility(
      claim(3, 3, 'Company X announced a factory closure.'),
      claim(4, 4, 'The city council announced a new park.')
    ).compatible, false);
  });

  await test('potential numerical conflict remains eligible', () => {
    const first = claim(1, 1, 'Company X announced 100 layoffs.');
    const second = claim(2, 2, 'Company X announced 200 layoffs.');
    assert.equal(assessCompatibility(first, second).compatible, true);
  });

  await test('claim.event_id null does not prevent membership candidate generation', async () => {
    const claims = [
      claim(1, 1, 'Company X announced 100 layoffs.', { event_id: null }),
      claim(2, 2, 'Company X announced 200 layoffs.')
    ];
    const result = await createService(createRepository(claims)).getContradictionCandidates(EVENT_ID);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].claim_1.event_id, undefined);
  });

  await test('only claims loaded for requested event membership are considered', async () => {
    const repository = createRepository([
      claim(1, 1, 'Company X announced 100 layoffs.'),
      claim(2, 2, 'Company X announced 200 layoffs.')
    ]);
    const service = createService(repository);
    const requested = await service.getContradictionCandidates(EVENT_ID);
    const other = await service.getContradictionCandidates(OTHER_EVENT_ID);
    assert.equal(requested.totalClaims, 2);
    assert.equal(other.totalClaims, 0);
  });

  const baseClaims = [
    claim(1, 1, 'Company X announced 100 layoffs.'),
    claim(2, 2, 'Company X announced 200 layoffs.')
  ];
  const baseline = await createService(createRepository(baseClaims))
    .getContradictionCandidates(EVENT_ID, { includeEvaluated: true });
  const evaluatedCandidate = baseline.candidates[0];

  await test('existing positive check with same fingerprint is skipped', async () => {
    const check = {
      claim_id_1: evaluatedCandidate.claim_id_1,
      claim_id_2: evaluatedCandidate.claim_id_2,
      input_fingerprint: evaluatedCandidate.input_fingerprint,
      outcome: 'direct'
    };
    const result = await createService(createRepository(baseClaims, [check]))
      .getContradictionCandidates(EVENT_ID);
    assert.equal(result.skippedPreviouslyEvaluated, 1);
    assert.equal(result.candidates.length, 0);
  });

  await test('existing none check with same fingerprint is skipped', async () => {
    const check = {
      claim_id_1: evaluatedCandidate.claim_id_1,
      claim_id_2: evaluatedCandidate.claim_id_2,
      input_fingerprint: evaluatedCandidate.input_fingerprint,
      outcome: 'none'
    };
    const result = await createService(createRepository(baseClaims, [check]))
      .getContradictionCandidates(EVENT_ID);
    assert.equal(result.skippedPreviouslyEvaluated, 1);
    assert.equal(result.candidates.length, 0);
  });

  await test('changed evidence fingerprint makes pair eligible again', async () => {
    const oldCheck = {
      claim_id_1: evaluatedCandidate.claim_id_1,
      claim_id_2: evaluatedCandidate.claim_id_2,
      input_fingerprint: evaluatedCandidate.input_fingerprint,
      outcome: 'none'
    };
    const changedClaims = [
      { ...baseClaims[0], evidence: ['New evidence for the same claim.'] },
      baseClaims[1]
    ];
    const result = await createService(createRepository(changedClaims, [oldCheck]))
      .getContradictionCandidates(EVENT_ID);
    assert.equal(result.skippedPreviouslyEvaluated, 0);
    assert.equal(result.candidates.length, 1);
    assert.notEqual(result.candidates[0].input_fingerprint, oldCheck.input_fingerprint);
  });

  await test('reversed claim input produces the same fingerprint', () => {
    const forward = generateCandidatePairs(baseClaims, { model: MODEL, promptVersion: PROMPT_VERSION });
    const reverse = generateCandidatePairs([...baseClaims].reverse(), {
      model: MODEL,
      promptVersion: PROMPT_VERSION
    });
    assert.equal(forward.generated[0].input_fingerprint, reverse.generated[0].input_fingerprint);
  });

  await test('maxCandidates is enforced after sorting', async () => {
    const claims = [
      claim(3, 3, 'Company X announced 300 layoffs.'),
      claim(1, 1, 'Company X announced 100 layoffs.'),
      claim(2, 2, 'Company X announced 200 layoffs.')
    ];
    const result = await createService(createRepository(claims))
      .getContradictionCandidates(EVENT_ID, { maxCandidates: 1 });
    assert.equal(result.eligibleCandidateCount, 3);
    assert.equal(result.returnedCandidateCount, 1);
    assert.equal(result.truncatedCandidateCount, 2);
    assert.deepEqual(
      [result.candidates[0].claim_id_1, result.candidates[0].claim_id_2],
      [id(1), id(2)]
    );
  });

  await test('final candidate ordering is deterministic', async () => {
    const claims = [
      claim(3, 3, 'Company X announced 300 layoffs.'),
      claim(1, 1, 'Company X announced 100 layoffs.'),
      claim(2, 2, 'Company X announced 200 layoffs.')
    ];
    const forward = await createService(createRepository(claims))
      .getContradictionCandidates(EVENT_ID);
    const reverse = await createService(createRepository([...claims].reverse()))
      .getContradictionCandidates(EVENT_ID);
    assert.deepEqual(
      forward.candidates.map((item) => [item.claim_id_1, item.claim_id_2]),
      reverse.candidates.map((item) => [item.claim_id_1, item.claim_id_2])
    );
  });

  await test('missing model environment configuration fails before reads', async () => {
    const repository = createRepository(baseClaims);
    const service = createService(repository, '');
    await assert.rejects(
      service.getContradictionCandidates(EVENT_ID),
      (error) => error.code === 'CONTRADICTION_MODEL_NOT_CONFIGURED'
    );
    assert.equal(repository.calls.loadClaimsForEvent, 0);
  });

  await test('invalid maxCandidates is rejected without coercion', async () => {
    const service = createService(createRepository(baseClaims));
    await assert.rejects(
      service.getContradictionCandidates(EVENT_ID, { maxCandidates: '1' }),
      (error) => error.code === 'INVALID_MAX_CANDIDATES'
    );
  });

  await test('candidate service performs no database writes', async () => {
    const repository = createRepository(baseClaims);
    await createService(repository).getContradictionCandidates(EVENT_ID);
    assert.equal(repository.calls.writes, 0);
  });

  await test('unit path loads neither Gemini service nor database models', () => {
    const loadedPaths = Object.keys(require.cache).map((path) => path.replace(/\\/g, '/'));
    assert.equal(loadedPaths.some((path) => path.endsWith('/services/geminiClientService.js')), false);
    assert.equal(loadedPaths.some((path) => path.endsWith('/models/index.js')), false);
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
