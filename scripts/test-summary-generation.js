const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildInputFingerprint } = require('../utils/summaryValidation');
const { evidenceHash } = require('../utils/summaryGrounding');
const { createSummaryGenerationService } = require('../services/summaryGenerationService');
const { createSummaryQueryService } = require('../services/summaryQueryService');
const { createSummaryWorkflowService } = require('../services/summaryWorkflowService');

const eventId = '70000000-0000-4000-8000-000000000001';
const articleId = '70000000-0000-4000-8000-000000000002';
const claimId = '70000000-0000-4000-8000-000000000003';
const evidenceId = '70000000-0000-4000-8000-000000000004';
const otherClaimId = '70000000-0000-4000-8000-000000000005';
const otherEvidenceId = '70000000-0000-4000-8000-000000000006';
const config = { provider: 'gemini', model: 'fixture-model-only', promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2', timeoutMs: 1000, maxStatements: 30, maxStatementChars: 2000 };
const claimText = 'Outlet One said 100 jobs were lost on 2026-10-01.';

function context() {
  const value = {
    event: { id: eventId, title: 'Fixture event' },
    reports: [{ article_id: articleId, title: 'Fixture report', source: { name: 'Outlet One' }, report_timestamp: '2026-10-01T00:00:00.000Z' }],
    claims: [{ claim_id: claimId, article_id: articleId, claim_text: claimText, source: { name: 'Outlet One' } }],
    evidence: [{ evidence_id: evidenceId, claim_id: claimId, article_id: articleId, evidence_text: claimText, evidence_hash: evidenceHash(claimText), source_grounded: true }],
    contradictions: [], changes: [],
    coverage: { status: 'partial', contradictions: { status: 'unknown' } },
    warnings: [{ code: 'SUMMARY_CONTRADICTION_COVERAGE_UNKNOWN', message: 'Coverage unknown.' }, { code: 'SUMMARY_SINGLE_SOURCE', message: 'Claims in this summary context have one named source.' }],
    metadata: { provider: config.provider, model: config.model, prompt_version: config.promptVersion, contract_version: config.contractVersion }
  };
  value.metadata.input_fingerprint = buildInputFingerprint(value);
  return value;
}

function statement() {
  return { id: 's1', text: claimText, source_claim_ids: [claimId], evidence_ids: [evidenceId], contradiction_ids: [], attribution: 'Outlet One' };
}

function harness({ snapshot = context(), output = { statements: [statement()] }, settings = config, error } = {}) {
  let calls = 0;
  let prompt = '';
  let options = null;
  const geminiClient = { async generateText(value, opts) {
    calls++; prompt = value; options = opts;
    if (error) throw error;
    return { text: typeof output === 'string' ? output : JSON.stringify(output), model: opts.model, attempts: 1 };
  } };
  const service = createSummaryGenerationService({ contextService: { async buildContextForEvent() { return snapshot; } }, geminiClient, config: settings });
  return { service, calls: () => calls, prompt: () => prompt, options: () => options, snapshot };
}

function refresh(snapshot) { snapshot.metadata.input_fingerprint = buildInputFingerprint(snapshot); return snapshot; }
async function run(options) { const h = harness(options); return { ...h, result: await h.service.generateSummaryForEvent(eventId) }; }

test('valid structured JSON yields one persistence-ready, extractive result', async () => {
  const { result, calls, options } = await run();
  assert.equal(result.status, 'generated'); assert.equal(calls(), 1);
  assert.equal(options().model, config.model); assert.equal(options().maxAttempts, 1);
  assert.equal(options().responseMimeType, 'application/json');
  assert.equal(result.persistenceReady.summary_text, claimText);
  assert.deepEqual(result.persistenceReady.claims, [{ claim_id: claimId, verification_status: 'supported' }]);
  assert.equal(result.verification_status, 'needs_review');
});
test('malformed JSON fails without correction', async () => {
  const { result, calls } = await run({ output: '```json\n{}\n```' });
  assert.equal(result.error.code, 'SUMMARY_INVALID_JSON'); assert.equal(calls(), 1);
});
test('missing statement ID fails validation', async () => {
  const s = statement(); delete s.id;
  assert.equal((await run({ output: { statements: [s] } })).result.error.code, 'SUMMARY_INVALID_OUTPUT');
});
test('fabricated and cross-event claim IDs fail validation', async () => {
  for (const id of ['fabricated-id', '80000000-0000-4000-8000-000000000001']) {
    const s = statement(); s.source_claim_ids = [id];
    assert.equal((await run({ output: { statements: [s] } })).result.error.code, 'SUMMARY_INVALID_OUTPUT');
  }
});
test('fabricated evidence ID fails validation', async () => {
  const s = statement(); s.evidence_ids = ['fabricated-id'];
  assert.equal((await run({ output: { statements: [s] } })).result.error.code, 'SUMMARY_INVALID_OUTPUT');
});
test('evidence linked to a different claim fails validation', async () => {
  const snapshot = context();
  snapshot.claims.push({ claim_id: otherClaimId, article_id: articleId, claim_text: 'Another fact.', source: { name: 'Outlet One' } });
  snapshot.evidence.push({ evidence_id: otherEvidenceId, claim_id: otherClaimId, article_id: articleId, evidence_text: 'Another fact.', evidence_hash: evidenceHash('Another fact.'), source_grounded: true });
  const s = statement(); s.evidence_ids = [otherEvidenceId];
  assert.equal((await run({ snapshot: refresh(snapshot), output: { statements: [s] } })).result.error.code, 'SUMMARY_INVALID_OUTPUT');
});
test('invalid contradiction ID fails validation', async () => {
  const s = statement(); s.contradiction_ids = ['fabricated-id'];
  assert.equal((await run({ output: { statements: [s] } })).result.error.code, 'SUMMARY_INVALID_OUTPUT');
});
test('unsupported statement cannot become persistence-ready', async () => {
  const s = statement(); s.source_claim_ids = []; s.evidence_ids = [];
  const { result } = await run({ output: { statements: [s] } });
  assert.equal(result.status, 'needs_review'); assert.equal(result.grounding_status, 'unsupported'); assert.equal(result.persistenceReady, null);
});
test('arbitrary paraphrase requires review', async () => {
  const s = statement(); s.text = 'The outlet reported many jobs were lost.';
  const { result } = await run({ output: { statements: [s] } });
  assert.equal(result.status, 'needs_review'); assert.equal(result.persistenceReady, null);
});
test('single source is disclosed and prompt treats sources as untrusted', async () => {
  const { result, prompt } = await run();
  assert.ok(result.warnings.some(row => row.code === 'SUMMARY_SINGLE_SOURCE'));
  assert.match(prompt(), /prompt-injection/); assert.match(prompt(), /single-source/i);
});
test('zero claims avoids Gemini', async () => {
  const snapshot = context(); snapshot.claims = []; snapshot.evidence = [];
  const { result, calls } = await run({ snapshot: refresh(snapshot) });
  assert.equal(result.reason, 'NO_CLAIMS'); assert.equal(calls(), 0);
});
test('zero evidence avoids Gemini', async () => {
  const snapshot = context(); snapshot.evidence = [];
  const { result, calls } = await run({ snapshot: refresh(snapshot) });
  assert.equal(result.reason, 'NO_EVIDENCE'); assert.equal(calls(), 0);
});
test('sparse ungrounded evidence avoids Gemini', async () => {
  const snapshot = context(); snapshot.evidence[0].source_grounded = null;
  const { result, calls } = await run({ snapshot: refresh(snapshot) });
  assert.equal(result.reason, 'NO_GROUNDED_EVIDENCE'); assert.equal(calls(), 0);
});
test('limited contradiction coverage is preserved, not treated as no conflict', async () => {
  const snapshot = context(); snapshot.coverage.contradictions.status = 'limited';
  const { result, prompt } = await run({ snapshot: refresh(snapshot) });
  assert.equal(result.persistenceReady.context_snapshot.coverage.contradictions.status, 'limited');
  assert.match(prompt(), /"limited"/);
});
test('stored conflict must be cited with both claims or result needs review', async () => {
  const snapshot = context();
  snapshot.claims.push({ claim_id: otherClaimId, article_id: articleId, claim_text: 'Outlet Two said 200 jobs were lost.', source: { name: 'Outlet Two' } });
  snapshot.contradictions.push({ contradiction_id: '70000000-0000-4000-8000-000000000007', claim_id_1: claimId, claim_id_2: otherClaimId, contradiction_type: 'direct', status: 'unresolved' });
  const { result } = await run({ snapshot: refresh(snapshot) });
  assert.equal(result.status, 'needs_review'); assert.ok(result.warnings.some(row => row.code === 'SUMMARY_CONFLICT_OMITTED'));
});
test('missing summary model fails before context or provider call', async () => {
  const { result, calls } = await run({ settings: { ...config, model: '' } });
  assert.equal(result.error.code, 'SUMMARY_MODEL_NOT_CONFIGURED'); assert.equal(calls(), 0);
});
test('provider timeout and 5xx become sanitized failures with one attempt', async () => {
  for (const code of ['GEMINI_TIMEOUT', 'GEMINI_SERVER']) {
    const { result, calls } = await run({ error: Object.assign(new Error('request details are not public'), { code }) });
    assert.equal(result.error.code, code); assert.equal(result.attempts, 1); assert.equal(calls(), 1);
    assert.ok(!result.error.message.includes('request details'));
  }
});
test('provider malformed or empty response never becomes a summary', async () => {
  const { result } = await run({ error: Object.assign(new Error('empty'), { code: 'GEMINI_EMPTY_RESPONSE' }) });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'GEMINI_EMPTY_RESPONSE');
});
test('fingerprint, prompt and contract versions survive unchanged', async () => {
  const { result, snapshot, prompt } = await run();
  assert.equal(result.persistenceReady.input_fingerprint, snapshot.metadata.input_fingerprint);
  assert.equal(result.persistenceReady.prompt_version, config.promptVersion);
  assert.equal(result.persistenceReady.contract_version, config.contractVersion);
  assert.match(prompt(), /phase7-summary-v2/);
});
test('persistence-ready output passes the existing query service boundary with an isolated repository', async () => {
  const { result } = await run();
  let saved = null;
  const links = [];
  const repository = {
    transaction: work => work({}),
    findByFingerprint: async () => null,
    findEvent: async () => ({ id: eventId }),
    findMemberArticleIds: async () => [articleId],
    findClaims: async () => [{ id: claimId, article_id: articleId, event_id: eventId }],
    createSummary: async data => { saved = { ...data, id: '70000000-0000-4000-8000-000000000008' }; return saved; },
    createLinks: async rows => { links.push(...rows); },
    findById: async () => ({ ...saved, claims: links })
  };
  const persisted = await createSummaryQueryService({ repository }).persistSummary(result.persistenceReady);
  assert.equal(persisted.id, saved.id); assert.equal(links.length, 1);
  assert.equal(links[0].claim_id, claimId);
});
test('context integrity mismatch fails before provider call', async () => {
  const snapshot = context(); snapshot.claims[0].claim_text = 'Tampered.';
  const { result, calls } = await run({ snapshot });
  assert.equal(result.error.code, 'SUMMARY_CONTEXT_INVALID'); assert.equal(calls(), 0);
});

function excerptContext(text = 'The company reports no layoffs.') {
  const snapshot = context();
  snapshot.reports[0].source.id = 'source-one';
  snapshot.claims[0].source.id = 'source-one';
  const row = snapshot.evidence[0];
  row.evidence_text = text; row.evidence_hash = evidenceHash(text); row.exact_source_grounded = true;
  row.source_excerpt_provenance = { article_id: articleId, source_id: 'source-one', source_name: 'Outlet One', evidence_hash: row.evidence_hash, source_text_hash: evidenceHash('Source article: ' + text) };
  return refresh(snapshot);
}
test('exact excerpt produces persistence-ready output without verifying the extracted claim', async () => {
  const snapshot = excerptContext(); const s = statement(); s.text = 'Outlet One excerpt: ' + snapshot.evidence[0].evidence_text;
  const { result, prompt } = await run({ snapshot, output: { statements: [s] } });
  assert.equal(result.status, 'generated'); assert.equal(result.verification_metadata.statements[0].support_basis, 'source_excerpt');
  assert.equal(result.verification_metadata.statements[0].factual_truth_verified, false);
  assert.equal(result.verification_status, 'needs_review');
  assert.ok(result.persistenceReady.context_snapshot.warnings.some(row => row.code === 'SUMMARY_SINGLE_SOURCE'));
  assert.match(prompt(), /Do NOT append warnings/); assert.match(prompt(), /complete evidence_text/);
});
test('explicit old version overrides stop before context or provider calls', async () => {
  for (const settings of [{ ...config, promptVersion:'phase7-v1' }, { ...config, contractVersion:'phase7-summary-v1' }]) {
    const { result, calls } = await run({ settings }); assert.equal(result.error.code,'SUMMARY_VERSION_NOT_ACTIVE'); assert.equal(calls(),0);
  }
});
test('excerpt with appended caveat never reaches real workflow persistence boundary', async () => {
  const snapshot = excerptContext(); const s = statement(); s.text = 'Outlet One excerpt: ' + snapshot.evidence[0].evidence_text + ' (Evidence is single-source).';
  const h = harness({ snapshot, output:{ statements:[s] } }); let writes=0;
  const service = createSummaryWorkflowService({ contextService:{buildContextForEvent:async()=>snapshot},generationService:h.service,
    queryService:{findSummaryByFingerprint:async()=>null,persistSummary:async()=>{writes++;}} });
  const result=await service.generateForEvent(eventId); assert.equal(result.status,'needs_review'); assert.equal(writes,0); assert.equal(h.calls(),1);
});
test('unsupported joint excerpt with stored conflict cannot become accepted', async () => {
  const snapshot=excerptContext(); snapshot.claims.push({claim_id:otherClaimId,article_id:articleId,claim_text:'A contrary fact.',source:{id:'source-one',name:'Outlet One'}});
  snapshot.contradictions.push({contradiction_id:'70000000-0000-4000-8000-000000000007',claim_id_1:claimId,claim_id_2:otherClaimId,contradiction_type:'direct',status:'unresolved'});
  const s=statement(); s.text='Outlet One excerpt: '+snapshot.evidence[0].evidence_text; s.source_claim_ids.push(otherClaimId); s.contradiction_ids.push(snapshot.contradictions[0].contradiction_id);
  const {result}=await run({snapshot:refresh(snapshot),output:{statements:[s]}}); assert.equal(result.status,'needs_review'); assert.equal(result.persistenceReady,null);
});
