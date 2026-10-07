/**
 * Phase 5 contradiction query tests.
 * Uses an in-memory read repository; no database, Gemini, or network access.
 */

const assert = require('assert/strict');
const {
  createContradictionQueryService
} = require('../services/contradictionQueryService');

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const EMPTY_EVENT_ID = '10000000-0000-4000-8000-000000000002';
const MISSING_EVENT_ID = '10000000-0000-4000-8000-000000000099';
const CLAIM_1 = '20000000-0000-4000-8000-000000000001';
const CLAIM_2 = '20000000-0000-4000-8000-000000000002';
const CLAIM_3 = '20000000-0000-4000-8000-000000000003';
const MISSING_CLAIM_ID = '20000000-0000-4000-8000-000000000099';
const ARTICLE_1 = '30000000-0000-4000-8000-000000000001';
const ARTICLE_2 = '30000000-0000-4000-8000-000000000002';
const ARTICLE_3 = '30000000-0000-4000-8000-000000000003';

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

const contexts = [
  {
    id: CLAIM_1,
    article_id: ARTICLE_1,
    event_id: null,
    claim_text: 'Company X announced 100 layoffs.',
    claim_type: 'data',
    article: {
      id: ARTICLE_1,
      title: 'Company X announces layoffs',
      published_at: '2026-10-01T10:00:00Z',
      source: { id: 'source-1', name: 'Source One' }
    },
    evidence: [{
      id: 'evidence-1',
      claim_id: CLAIM_1,
      article_id: ARTICLE_1,
      evidence_text: 'Company X announced 100 layoffs.',
      evidence_hash: 'a'.repeat(64)
    }]
  },
  {
    id: CLAIM_2,
    article_id: ARTICLE_2,
    event_id: EVENT_ID,
    claim_text: 'Company X announced 200 layoffs.',
    claim_type: 'data',
    article: {
      id: ARTICLE_2,
      title: 'Layoff total disputed',
      published_at: '2026-10-01T11:00:00Z',
      source: { id: 'source-2', name: 'Source Two' }
    },
    evidence: [{
      id: 'evidence-2',
      claim_id: CLAIM_2,
      article_id: ARTICLE_2,
      evidence_text: 'Company X announced 200 layoffs.',
      evidence_hash: 'b'.repeat(64)
    }]
  },
  {
    id: CLAIM_3,
    article_id: ARTICLE_3,
    event_id: '10000000-0000-4000-8000-000000000003',
    claim_text: 'A Mars rover photographed a crater.',
    claim_type: 'fact',
    article: {
      id: ARTICLE_3,
      title: 'Mars rover update',
      published_at: '2026-10-02T09:00:00Z',
      source: { id: 'source-3', name: 'Source Three' }
    },
    evidence: []
  }
];

const contradictions = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    claim_id_1: CLAIM_1,
    claim_id_2: CLAIM_2,
    contradiction_type: 'direct',
    status: 'unresolved',
    reason: 'The same layoff announcement has incompatible totals.',
    detected_at: '2026-10-05T10:00:00Z'
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    claim_id_1: CLAIM_1,
    claim_id_2: CLAIM_3,
    contradiction_type: 'partial',
    status: 'resolved',
    reason: 'Fixture row crossing an event boundary.',
    detected_at: '2026-10-06T10:00:00Z'
  },
  {
    id: '40000000-0000-4000-8000-000000000003',
    claim_id_1: CLAIM_2,
    claim_id_2: CLAIM_3,
    contradiction_type: 'temporal',
    status: 'under_review',
    reason: 'Another unrelated fixture row.',
    detected_at: '2026-10-04T10:00:00Z'
  }
];

const checks = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    claim_id_1: CLAIM_1,
    claim_id_2: CLAIM_2,
    outcome: 'none',
    reason: 'The reports describe a normal update.',
    model: 'test-model',
    prompt_version: 'phase5-v1',
    checked_at: '2026-10-06T12:00:00Z',
    input_fingerprint: 'c'.repeat(64)
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    claim_id_1: CLAIM_1,
    claim_id_2: CLAIM_3,
    outcome: 'partial',
    reason: 'Earlier positive evaluation.',
    model: 'test-model',
    prompt_version: 'phase5-v1',
    checked_at: '2026-10-05T12:00:00Z',
    input_fingerprint: 'd'.repeat(64)
  }
];

function createRepository() {
  const calls = { reads: 0, writes: 0 };
  return {
    calls,
    async findEvent(eventId) {
      calls.reads += 1;
      if (eventId === MISSING_EVENT_ID) {
        return null;
      }
      return {
        id: eventId,
        title: 'Company X layoffs',
        description: 'Reports about Company X layoffs.',
        status: 'active',
        event_date: '2026-10-01T09:00:00Z'
      };
    },
    async findEventArticleIds(eventId) {
      calls.reads += 1;
      return eventId === EMPTY_EVENT_ID ? [] : [ARTICLE_1, ARTICLE_2];
    },
    async findClaimIdsForArticles(articleIds) {
      calls.reads += 1;
      return articleIds.length === 0 ? [] : [CLAIM_1, CLAIM_2];
    },
    async findClaim(claimId) {
      calls.reads += 1;
      return contexts.find((claim) => claim.id === claimId) || null;
    },
    async findContradictionsForClaimIds() {
      calls.reads += 1;
      // Deliberately return cross-event rows; service must require both claims.
      return [...contradictions];
    },
    async findContradictionsForClaim() {
      calls.reads += 1;
      // Deliberately return an unrelated row; service must filter it.
      return [...contradictions];
    },
    async loadClaimContexts(claimIds) {
      calls.reads += 1;
      return contexts.filter((claim) => claimIds.includes(claim.id));
    },
    async findChecksForClaim() {
      calls.reads += 1;
      return [...checks];
    }
  };
}

function createService(repository = createRepository()) {
  return {
    repository,
    service: createContradictionQueryService({
      repository,
      config: { query: { defaultLimit: 10, maxLimit: 2 } }
    })
  };
}

async function main() {
  await test('event query requires both claims in event membership', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForEvent(EVENT_ID);
    assert.deepEqual(result.contradictions.map((row) => row.id), [contradictions[0].id]);
  });

  await test('event query does not rely on claim.event_id', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForEvent(EVENT_ID);
    assert.equal(contexts[0].event_id, null);
    assert.equal(result.contradictions[0].claim_1.id, CLAIM_1);
  });

  await test('claim with null event_id is found through article membership', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForEvent(EVENT_ID);
    assert.equal(result.member_articles, 2);
    assert.equal(result.member_claims, 2);
    assert.equal(result.count, 1);
  });

  await test('claim query finds claim_id_1 matches', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForClaim(CLAIM_1);
    assert.deepEqual(result.contradictions.map((row) => row.id), [
      contradictions[1].id,
      contradictions[0].id
    ]);
  });

  await test('claim query finds claim_id_2 matches', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForClaim(CLAIM_2);
    assert.deepEqual(result.contradictions.map((row) => row.id), [
      contradictions[0].id,
      contradictions[2].id
    ]);
  });

  await test('claim query excludes unrelated claims', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForClaim(CLAIM_1);
    assert.equal(result.contradictions.some((row) => row.id === contradictions[2].id), false);
  });

  await test('status filter works strictly', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForClaim(CLAIM_1, { status: 'resolved' });
    assert.deepEqual(result.contradictions.map((row) => row.status), ['resolved']);
  });

  await test('invalid status is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForClaim(CLAIM_1, { status: 'RESOLVED' }),
      (error) => error.code === 'INVALID_CONTRADICTION_STATUS'
    );
  });

  await test('contradiction type filter works strictly', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForClaim(CLAIM_1, { type: 'direct' });
    assert.deepEqual(result.contradictions.map((row) => row.contradiction_type), ['direct']);
  });

  await test('invalid contradiction type is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForClaim(CLAIM_1, { type: 'none' }),
      (error) => error.code === 'INVALID_CONTRADICTION_TYPE'
    );
  });

  await test('limit is strict and capped at configured maximum', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForClaim(CLAIM_1, { limit: '1' }),
      (error) => error.code === 'INVALID_QUERY_LIMIT'
    );
    await assert.rejects(
      service.getContradictionsForClaim(CLAIM_1, { limit: 0 }),
      (error) => error.code === 'INVALID_QUERY_LIMIT'
    );
    const capped = await service.getContradictionsForClaim(CLAIM_1, { limit: 999 });
    assert.equal(capped.count, 2);
  });

  await test('deterministic ordering is detected_at DESC then id ASC', async () => {
    const repository = createRepository();
    const tied = { ...contradictions[0], id: '40000000-0000-4000-8000-000000000000' };
    repository.findContradictionsForClaim = async () => [contradictions[0], tied, contradictions[1]];
    const { service } = createService(repository);
    const result = await service.getContradictionsForClaim(CLAIM_1);
    assert.deepEqual(result.contradictions.map((row) => row.id), [
      contradictions[1].id,
      tied.id
    ]);
  });

  await test('claim article and source context is returned', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForEvent(EVENT_ID);
    assert.equal(result.contradictions[0].claim_1.article.title, 'Company X announces layoffs');
    assert.deepEqual(result.contradictions[0].claim_1.article.source, {
      id: 'source-1',
      name: 'Source One'
    });
  });

  await test('evidence context is returned with bounded fields', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForEvent(EVENT_ID);
    assert.deepEqual(Object.keys(result.contradictions[0].claim_1.evidence[0]).sort(), [
      'article_id', 'evidence_hash', 'evidence_text', 'id'
    ]);
  });

  await test('missing event ID is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForEvent(null),
      (error) => error.code === 'MISSING_EVENT_ID'
    );
  });

  await test('invalid event ID is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForEvent('invalid'),
      (error) => error.code === 'INVALID_EVENT_ID'
    );
  });

  await test('missing claim ID is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForClaim(undefined),
      (error) => error.code === 'MISSING_CLAIM_ID'
    );
  });

  await test('invalid claim ID is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForClaim('invalid'),
      (error) => error.code === 'INVALID_CLAIM_ID'
    );
  });

  await test('nonexistent event is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForEvent(MISSING_EVENT_ID),
      (error) => error.code === 'EVENT_NOT_FOUND'
    );
  });

  await test('nonexistent claim is rejected', async () => {
    const { service } = createService();
    await assert.rejects(
      service.getContradictionsForClaim(MISSING_CLAIM_ID),
      (error) => error.code === 'CLAIM_NOT_FOUND'
    );
  });

  await test('empty event returns no contradictions', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForEvent(EMPTY_EVENT_ID);
    assert.equal(result.count, 0);
    assert.deepEqual(result.contradictions, []);
  });

  await test('none evaluation is absent from contradiction query', async () => {
    const { service } = createService();
    const result = await service.getContradictionsForClaim(CLAIM_1);
    assert.equal(result.contradictions.some((row) => row.contradiction_type === 'none'), false);
    assert.equal(result.contradictions.some((row) => row.id === checks[0].id), false);
  });

  await test('evaluation history includes none and persisted metadata', async () => {
    const { service } = createService();
    const result = await service.getContradictionChecksForClaim(CLAIM_1);
    assert.equal(result.checks[0].outcome, 'none');
    assert.equal(result.checks[0].model, 'test-model');
    assert.equal(result.checks[0].input_fingerprint, 'c'.repeat(64));
  });

  await test('evaluation-history query is read-only', async () => {
    const { service, repository } = createService();
    await service.getContradictionChecksForClaim(CLAIM_1, { limit: 1 });
    assert.equal(repository.calls.writes, 0);
    assert.ok(repository.calls.reads > 0);
  });

  await test('no Gemini or database model module is loaded by unit path', () => {
    const loadedPaths = Object.keys(require.cache).map((path) => path.replace(/\\/g, '/'));
    assert.equal(loadedPaths.some((path) => path.endsWith('/services/geminiClientService.js')), false);
    assert.equal(loadedPaths.some((path) => path.endsWith('/models/index.js')), false);
  });

  await test('normal query service performs no writes', async () => {
    const { service, repository } = createService();
    await service.getContradictionsForEvent(EVENT_ID);
    await service.getContradictionsForClaim(CLAIM_1);
    assert.equal(repository.calls.writes, 0);
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
