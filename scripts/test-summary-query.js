const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSummaryQueryService } = require('../services/summaryQueryService');
const { buildInputFingerprint } = require('../utils/summaryValidation');
const { verifySummary, evidenceHash } = require('../utils/summaryGrounding');

const eventId = '11111111-1111-4111-8111-111111111111';
const otherEvent = '22222222-2222-4222-8222-222222222222';
const claimId = '33333333-3333-4333-8333-333333333333';
const secondClaimId = '44444444-4444-4444-8444-444444444444';
const summaryId = '55555555-5555-4555-8555-555555555555';
const articleId = '66666666-6666-4666-8666-666666666666';
const otherArticle = '77777777-7777-4777-8777-777777777777';
const context = () => ({
  event: { id: eventId }, reports: [{ article_id: articleId }],
  claims: [{ claim_id: claimId, article_id: articleId, claim_text: 'Confirmed claim.' }],
  evidence: [], contradictions: [], metadata: {}
});
const fingerprint = buildInputFingerprint(context());
const verification = () => verifySummary({ statements: [] }, context());
const input = () => ({
  event_id: eventId, input_fingerprint: fingerprint,
  summary_text: 'Source reports a confirmed claim.', model_provider: 'gemini', model_version: 'fixture-model',
  prompt_version: 'phase7-v1', contract_version: 'phase7-summary-v1', generation_status: 'succeeded',
  grounding_status: 'needs_review', verification_status: 'needs_review',
  structured_output: { statements: [] },
  context_snapshot: { ...context(), metadata: { input_fingerprint: fingerprint } },
  verification_metadata: verification(), claims: [{ claim_id: claimId, verification_status: 'supported' }]
});

function fixture() {
  const state = { summaries: [], links: [], failLinks: false, transactions: 0, rollbacks: 0, creates: 0 };
  const repository = {
    async transaction(work) {
      state.transactions++;
      const before = { summaries: structuredClone(state.summaries), links: structuredClone(state.links) };
      try { return await work({}); }
      catch (error) { state.summaries = before.summaries; state.links = before.links; state.rollbacks++; throw error; }
    },
    async findById(id) {
      const row = state.summaries.find(item => item.id === id);
      return row ? { ...row, claims: state.links.filter(link => link.summary_id === id).map(link => ({ ...link })) } : null;
    },
    async findByFingerprint(id, hash) {
      const row = state.summaries.find(item => item.event_id === id && item.input_fingerprint === hash);
      return row ? repository.findById(row.id) : null;
    },
    async findForEvent(id) { return Promise.all(state.summaries.filter(item => item.event_id === id).map(item => repository.findById(item.id))); },
    async findEvent(id) { return id === eventId ? { id } : null; },
    async findMemberArticleIds(id) { return id === eventId ? [articleId] : []; },
    async findClaims(ids) {
      return ids.map(id => ({ id, article_id: id === secondClaimId ? otherArticle : articleId, event_id: id === secondClaimId ? otherEvent : eventId }));
    },
    async createSummary(data) {
      state.creates++;
      if (state.summaries.some(row => row.event_id === data.event_id && row.input_fingerprint === data.input_fingerprint)) {
        const error = new Error('duplicate'); error.name = 'SequelizeUniqueConstraintError'; throw error;
      }
      const row = { ...data, id: summaryId, generated_at: new Date('2026-01-01T00:00:00Z') };
      state.summaries.push(row);
      return row;
    },
    async createLinks(links) { if (state.failLinks) throw new Error('Database link failure'); state.links.push(...links); },
    async updateSummary(id, fields) { Object.assign(state.summaries.find(row => row.id === id), fields); }
  };
  return { state, repository, service: createSummaryQueryService({ repository }) };
}

test('find by ID returns summary and linked claims', async () => {
  const { service } = fixture();
  const saved = await service.persistSummary(input());
  assert.equal((await service.findSummaryById(saved.id)).claims[0].claim_id, claimId);
});

test('missing summary returns null', async () => assert.equal(await fixture().service.findSummaryById(summaryId), null));
test('event metadata lookup validates its ID', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.findEventById(eventId), { id: eventId });
  await assert.rejects(service.findEventById('bad'), { code: 'INVALID_EVENT_ID' });
});
test('event summaries return deterministic generated_at DESC, id ASC order', async () => {
  const { state, service } = fixture();
  state.summaries.push(
    { id: '88888888-8888-4888-8888-888888888888', event_id: eventId, generated_at: new Date('2026-01-01') },
    { id: '77777777-7777-4777-8777-777777777777', event_id: eventId, generated_at: new Date('2026-01-01') },
    { id: '99999999-9999-4999-8999-999999999999', event_id: eventId, generated_at: new Date('2026-01-02') },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event_id: otherEvent, generated_at: new Date('2026-01-03') }
  );
  assert.deepEqual((await service.findSummariesForEvent(eventId)).map(row => row.id), [state.summaries[2].id, state.summaries[1].id, state.summaries[0].id]);
});
test('empty event summary list is stable', async () => assert.deepEqual(await fixture().service.findSummariesForEvent(eventId), []));
test('fingerprint lookup returns the saved summary', async () => {
  const { service } = fixture(); await service.persistSummary(input());
  assert.equal((await service.findSummaryByFingerprint(eventId, fingerprint)).id, summaryId);
});
test('successful persistence writes summary and linked claims in one transaction', async () => {
  const { state, service } = fixture(); await service.persistSummary(input());
  assert.equal(state.transactions, 1); assert.equal(state.summaries.length, 1); assert.equal(state.links.length, 1);
});
test('duplicate links with equal status are collapsed', async () => {
  const { state, service } = fixture(); const data = input(); data.claims.push({ ...data.claims[0] });
  await service.persistSummary(data); assert.equal(state.links.length, 1);
});
test('conflicting duplicate links are rejected', async () => {
  const { state, service } = fixture(); const data = input(); data.claims.push({ claim_id: claimId, verification_status: 'unsupported' });
  await assert.rejects(service.persistSummary(data), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' }); assert.equal(state.transactions, 0);
});
test('cross-event claims are rejected and transaction rolls back', async () => {
  const { state, service } = fixture(); const data = input(); data.claims.push({ claim_id: secondClaimId, verification_status: 'supported' });
  await assert.rejects(service.persistSummary(data), { code: 'SUMMARY_CROSS_EVENT_CLAIM' });
  assert.equal(state.summaries.length, 0); assert.equal(state.links.length, 0); assert.equal(state.rollbacks, 1);
});
test('unknown claims are rejected without partial records', async () => {
  const { state, repository, service } = fixture(); repository.findClaims = async () => [];
  await assert.rejects(service.persistSummary(input()), { code: 'SUMMARY_CROSS_EVENT_CLAIM' });
  assert.equal(state.summaries.length, 0); assert.equal(state.links.length, 0); assert.equal(state.rollbacks, 1);
});
test('unknown event is rejected', async () => {
  const { service } = fixture(); const data = input(); data.event_id = otherEvent; data.context_snapshot.event.id = otherEvent;
  data.input_fingerprint = buildInputFingerprint(data.context_snapshot);
  data.context_snapshot.metadata.input_fingerprint = data.input_fingerprint;
  await assert.rejects(service.persistSummary(data), { code: 'SUMMARY_EVENT_NOT_FOUND' });
});
test('verified status cannot be asserted by persistence or update', async () => {
  const { service } = fixture(); const data = input(); data.verification_status = 'verified';
  await assert.rejects(service.persistSummary(data), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' });
  await assert.rejects(service.updateVerificationState(summaryId, { ...verification(), verification_status: 'verified' }), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' });
});
test('link failure rolls back the summary and sanitizes the error', async () => {
  const { state, service } = fixture(); state.failLinks = true;
  await assert.rejects(service.persistSummary(input()), { code: 'SUMMARY_PERSISTENCE_FAILED', message: 'Summary could not be persisted' });
  assert.equal(state.summaries.length, 0); assert.equal(state.links.length, 0); assert.equal(state.rollbacks, 1);
});
test('existing fingerprint returns existing summary without a new transaction', async () => {
  const { state, service } = fixture(); const first = await service.persistSummary(input()); const second = await service.persistSummary(input());
  assert.equal(second.id, first.id); assert.equal(state.transactions, 1); assert.equal(state.creates, 1);
});
test('unique-constraint race returns the winning summary', async () => {
  const { state, repository } = fixture();
  let reads = 0;
  repository.findByFingerprint = async () => ++reads === 1 ? null : ({ id: summaryId, event_id: eventId, claims: [] });
  repository.transaction = async () => { const error = new Error('duplicate'); error.name = 'SequelizeUniqueConstraintError'; throw error; };
  const result = await createSummaryQueryService({ repository }).persistSummary(input());
  assert.equal(result.id, summaryId); assert.equal(state.creates, 0);
});
test('malformed input and failed generation are rejected before writes', async () => {
  const { state, service } = fixture();
  await assert.rejects(service.persistSummary(null), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' });
  const data = input(); data.generation_status = 'failed';
  await assert.rejects(service.persistSummary(data), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' });
  assert.equal(state.transactions, 0);
});
test('stale fingerprint and malformed output cannot be persisted', async () => {
  const { state, service } = fixture();
  const stale = input(); stale.context_snapshot.claims[0].claim_text = 'Changed claim.';
  await assert.rejects(service.persistSummary(stale), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' });
  const malformed = input(); malformed.structured_output = { unexpected: true };
  await assert.rejects(service.persistSummary(malformed), { code: 'SUMMARY_INVALID_PERSISTENCE_INPUT' });
  assert.equal(state.transactions, 0);
});
test('controlled verification update retains needs_review and deterministic metadata', async () => {
  const { service } = fixture(); await service.persistSummary(input());
  const metadata = verification();
  const changed = await service.updateVerificationState(summaryId, { grounding_status: 'needs_review', verification_status: 'needs_review', verification_metadata: metadata });
  assert.equal(changed.grounding_status, 'needs_review'); assert.equal(changed.verification_status, 'needs_review');
});
test('service never loads or calls a provider', async () => {
  const provider = require.resolve('../services/geminiClientService');
  const before = Boolean(require.cache[provider]);
  await fixture().service.findSummariesForEvent(eventId);
  assert.equal(Boolean(require.cache[provider]), before);
});

function excerptInput() {
  const snapshot=context(); snapshot.reports[0].source={id:'source-one',name:'Outlet One'}; snapshot.claims[0].source={id:'source-one',name:'Outlet One'};
  const text='The company reports no layoffs.';
  const hash=evidenceHash(text);
  snapshot.evidence=[{evidence_id:'evidence-one',claim_id:claimId,article_id:articleId,evidence_text:text,evidence_hash:hash,source_grounded:true,exact_source_grounded:true,
    source_excerpt_provenance:{article_id:articleId,source_id:'source-one',source_name:'Outlet One',evidence_hash:hash,source_text_hash:evidenceHash('Source article: '+text)}}];
  snapshot.metadata={prompt_version:'phase7-v2',contract_version:'phase7-summary-v2'};
  snapshot.warnings=[{code:'SUMMARY_SINGLE_SOURCE',message:'One source.'}];
  const output={statements:[{id:'s1',text:'Outlet One excerpt: '+text,source_claim_ids:[claimId],evidence_ids:['evidence-one'],contradiction_ids:[],attribution:'Outlet One'}]};
  const metadata=verifySummary(output,snapshot); const hashInput=buildInputFingerprint(snapshot); snapshot.metadata.input_fingerprint=hashInput;
  return {...input(),input_fingerprint:hashInput,summary_text:output.statements[0].text,prompt_version:'phase7-v2',contract_version:'phase7-summary-v2',grounding_status:metadata.grounding_status,
    structured_output:output,context_snapshot:snapshot,verification_metadata:metadata};
}
test('excerpt support basis and separate coverage warnings persist atomically in isolated repository', async () => {
  const {state,service}=fixture(); const saved=await service.persistSummary(excerptInput());
  assert.equal(saved.verification_metadata.statements[0].support_basis,'source_excerpt'); assert.equal(saved.verification_metadata.factual_truth_verified,false);
  assert.equal(saved.verification_status,'needs_review'); assert.equal(saved.context_snapshot.warnings[0].code,'SUMMARY_SINGLE_SOURCE'); assert.equal(state.transactions,1); assert.equal(state.links.length,1);
});
test('excerpt fingerprint idempotency retains one summary and link', async () => {
  const {state,service}=fixture(); const a=await service.persistSummary(excerptInput()); const b=await service.persistSummary(excerptInput()); assert.equal(a.id,b.id); assert.equal(state.creates,1); assert.equal(state.links.length,1);
});
test('fabricated excerpt support metadata is rejected before writes', async () => {
  const {state,service}=fixture(); const data=excerptInput(); data.verification_metadata=structuredClone(data.verification_metadata); data.verification_metadata.statements[0].support_basis='exact_claim';
  await assert.rejects(service.persistSummary(data),{code:'SUMMARY_INVALID_PERSISTENCE_INPUT'}); assert.equal(state.transactions,0);
});
