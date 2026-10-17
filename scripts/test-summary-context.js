const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) { if (/gemini|@google|sequelize|[\\/]models|^https?$/.test(name)) throw new Error('Forbidden dependency'); return originalLoad.call(this, name, ...args); };
global.fetch = () => { throw new Error('Forbidden provider call'); };
const fixture = require('../fixtures/phase7-summaries.json');
const config = require('../config/summaries');
const { createSummaryContextService } = require('../services/summaryContextService');
const { requireContext, stableSerialize } = require('../utils/summaryValidation');
let passed = 0;
let failed = 0;
async function test(name, callback) { try { await callback(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function setup(options = {}) {
  const data = structuredClone(fixture.context);
  const state = { calls: [], audit: data.evidence.map(row => ({ evidence_id: row.evidence_id, claim_id: row.claim_id, article_id: row.article_id, grounded: true })) };
  state.timeline = { event: data.event, warnings: data.warnings, completeness: data.coverage.timeline, entries: data.reports.map(row => ({ ...row, claims: data.claims.filter(claim => claim.article_id === row.article_id).map(claim => ({ id: claim.claim_id, article_id: claim.article_id, event_id: null, claim_text: claim.claim_text, claim_type: claim.claim_type, confidence_score: claim.extraction_confidence, evidence: data.evidence.filter(item => item.claim_id === claim.claim_id).map(item => ({ ...item, id: item.evidence_id })) })) })) };
  state.changes = { event: data.event, baseline: { since: null, until: null, interval: '(since, until]' }, completeness: { status: 'unknown' }, warnings: [], changes: [{ category: 'changed_value', rule_id: 'VALUE_CHANGED', previous_claim_id: 'claim-a', current_claim_id: 'claim-b', previous_report: data.reports[0], current_report: data.reports[1], reason: 'One value changed; not inferred as a contradiction.', evidence: [{ id: 'evidence-b' }], previous_evidence: [{ id: 'evidence-a' }] }] };
  state.relations = { event: data.event, contradictions: [] };
  state.articles = data.reports.map(row => ({ id: row.article_id, title: row.title, content: data.evidence.filter(item => item.article_id === row.article_id).map(item => item.evidence_text).join(' '), source: structuredClone(row.source) }));
  state.config = { ...config, model: 'fixture-model-only', ...options };
  state.service = createSummaryContextService({
    config: state.config,
    timelineService: { getTimelineForEvent: async id => { state.calls.push(['timeline', id]); if (state.timelineError) throw new Error('fixture failure'); return state.timeline; } },
    changeService: { getChangesForEvent: async id => { state.calls.push(['changes', id]); if (state.changeError) throw new Error('fixture failure'); return state.changes; } },
    contradictionQuery: { getContradictionsForEvent: async (id, options) => { state.calls.push(['contradictions', id, options]); if (state.relationError) throw new Error('fixture failure'); return state.relations; } },
    claimQuery: { auditEvidenceGrounding: async ids => { state.calls.push(['audit', ids]); if (state.auditError) throw new Error('fixture failure'); return state.audit; } },
    articleSourceQuery: async ids => { state.calls.push(['source', ids]); if (state.sourceError) throw new Error('fixture failure'); return state.articles; }
  });
  state.build = () => state.service.buildContextForEvent(data.event.id);
  return state;
}
async function main() {
  await test('context sections and exact source wording', async () => { const result = await setup().build(); for (const key of ['event', 'reports', 'claims', 'evidence', 'contradictions', 'changes', 'coverage', 'warnings', 'metadata']) assert.ok(Object.hasOwn(result, key)); assert.equal(result.claims[0].claim_text, fixture.context.claims[0].claim_text); assert.equal(result.claims[0].extraction_confidence, .9); });
  await test('event scoped reads reuse existing services', async () => { const state = setup(); await state.build(); assert.deepEqual(state.calls.map(row => row[0]), ['timeline', 'changes', 'contradictions', 'audit', 'source']); assert.deepEqual(state.calls[3][1], ['article-a', 'article-b']); assert.deepEqual(state.calls[4][1], ['article-a', 'article-b']); });
  await test('nullable/other claim event_id is not membership authority', async () => { const state = setup(); const original = await state.build(); state.timeline.entries[0].claims[0].event_id = 'other-event'; assert.equal((await state.build()).metadata.input_fingerprint, original.metadata.input_fingerprint); });
  await test('invalid UUID fails before any read', async () => { const state = setup(); await assert.rejects(state.service.buildContextForEvent('invalid'), { code: 'INVALID_EVENT_ID' }); assert.equal(state.calls.length, 0); });
  await test('another event timeline rejected', async () => { const state = setup(); state.timeline.event = { ...state.timeline.event, id: 'other' }; await assert.rejects(state.build(), { code: 'SUMMARY_CROSS_EVENT_REFERENCE' }); });
  await test('wrong report claim rejected', async () => { const state = setup(); state.timeline.entries[0].claims[0].article_id = 'outside'; await assert.rejects(state.build(), { code: 'SUMMARY_CROSS_EVENT_REFERENCE' }); });
  await test('cross-event evidence rejected', async () => { const state = setup(); state.timeline.entries[0].claims[0].evidence[0].article_id = 'outside'; await assert.rejects(state.build(), { code: 'SUMMARY_INVALID_EVIDENCE_REFERENCE' }); });
  await test('evidence wrong claim rejected', async () => { const state = setup(); state.timeline.entries[0].claims[0].evidence[0].claim_id = 'claim-b'; await assert.rejects(state.build(), { code: 'SUMMARY_INVALID_EVIDENCE_REFERENCE' }); });
  await test('mismatched audit relationship rejected', async () => { const state = setup(); state.audit[0].claim_id = 'claim-b'; await assert.rejects(state.build(), { code: 'SUMMARY_INVALID_EVIDENCE_REFERENCE' }); });
  await test('duplicate claim ID rejected', async () => { const state = setup(); state.timeline.entries[1].claims[0].id = 'claim-a'; state.timeline.entries[1].claims[0].evidence = []; await assert.rejects(state.build()); });
  await test('duplicate evidence ID rejected', async () => { const state = setup(); state.timeline.entries[1].claims[0].evidence[0].id = 'evidence-a'; await assert.rejects(state.build()); });
  await test('contradiction reason/status/evidence preserved', async () => { const state = setup(); state.relations.contradictions = [{ id: 'relation', claim_1: { id: 'claim-a' }, claim_2: { id: 'claim-b' }, contradiction_type: 'partial', status: 'under_review', reason: 'Stored reason' }]; const result = await state.build(); assert.equal(result.contradictions[0].reason, 'Stored reason'); assert.equal(result.contradictions[0].status, 'under_review'); assert.deepEqual(result.contradictions[0].evidence_ids, ['evidence-a', 'evidence-b']); });
  await test('out-of-event contradiction rejected', async () => { const state = setup(); state.relations.contradictions = [{ id: 'relation', claim_id_1: 'claim-a', claim_id_2: 'outside', contradiction_type: 'direct', status: 'unresolved' }]; await assert.rejects(state.build()); });
  await test('out-of-event change rejected', async () => { const state = setup(); state.changes.changes[0].current_claim_id = 'outside'; await assert.rejects(state.build()); });
  await test('wrong change evidence rejected', async () => { const state = setup(); state.changes.changes[0].evidence = [{ id: 'evidence-a' }]; await assert.rejects(state.build()); });
  await test('wrong in-event report for change rejected', async () => { const state = setup(); state.changes.changes[0].current_report = state.changes.changes[0].previous_report; await assert.rejects(state.build(), { code: 'SUMMARY_CROSS_EVENT_REFERENCE' }); });
  await test('timeline date provenance and source preserved', async () => { const result = await setup().build(); assert.equal(result.reports[1].date_source, 'fetched_at'); assert.equal(result.claims[1].source.name, 'Fixture B'); assert.equal(result.claims[1].report_timestamp, '2026-10-02T10:00:00.000Z'); });
  await test('change IDs reasons reports evidence preserved', async () => { const result = await setup().build(); assert.equal(result.changes[0].category, 'changed_value'); assert.equal(result.changes[0].previous_claim_id, 'claim-a'); assert.equal(result.changes[0].current_report.article_id, 'article-b'); assert.deepEqual(result.changes[0].evidence_ids, ['evidence-b']); });
  await test('unknown coverage never upgraded', async () => { const result = await setup().build(); assert.equal(result.coverage.contradictions.status, 'unknown'); assert.equal(result.coverage.status, 'unknown'); assert.ok(result.warnings.some(row => row.code === 'FIXTURE_UNKNOWN_COVERAGE')); });
  await test('limited coverage at query cap', async () => { const state = setup({ maxContradictions: 1 }); state.relations.contradictions = [{ id: 'relation', claim_id_1: 'claim-a', claim_id_2: 'claim-b', contradiction_type: 'direct', status: 'unresolved' }]; assert.equal((await state.build()).coverage.contradictions.status, 'limited'); });
  await test('source completeness partial preserved', async () => { const state = setup(); state.timeline.completeness.status = 'partial'; assert.equal((await state.build()).coverage.status, 'partial'); });
  await test('identical input fingerprint repeat', async () => { const state = setup(); assert.equal((await state.build()).metadata.input_fingerprint, (await state.build()).metadata.input_fingerprint); });
  await test('shuffled input yields identical fingerprint', async () => { const state = setup(); const first = await state.build(); state.timeline.entries.reverse(); state.audit.reverse(); assert.equal((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  await test('warning order does not change fingerprint', async () => { const state = setup(); state.timeline.warnings.push({ code: 'SECOND_WARNING', message: 'Second fixture warning' }); const first = await state.build(); state.timeline.warnings.reverse(); assert.equal((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  await test('coverage state participates in fingerprint', async () => { const state = setup(); const first = await state.build(); state.timeline.completeness.status = 'partial'; assert.notEqual((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  await test('stored contradiction details participate in fingerprint', async () => { const state = setup(); state.relations.contradictions = [{ id: 'relation', claim_id_1: 'claim-a', claim_id_2: 'claim-b', contradiction_type: 'direct', status: 'unresolved', reason: 'Initial reason' }]; const first = await state.build(); state.relations.contradictions[0].reason = 'Changed reason'; assert.notEqual((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  await test('change values and explanations participate in fingerprint', async () => { const state = setup(); const first = await state.build(); state.changes.changes[0].current_value = 201; state.changes.changes[0].reason = 'Changed explanation'; const second = await state.build(); assert.equal(second.changes[0].current_value, 201); assert.notEqual(second.metadata.input_fingerprint, first.metadata.input_fingerprint); });
  for (const field of ['claim_text', 'confidence_score']) await test('changed claim input changes fingerprint ' + field, async () => { const state = setup(); const first = await state.build(); state.timeline.entries[0].claims[0][field] = field === 'claim_text' ? 'Acme did not cut 100 jobs.' : .5; assert.notEqual((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  for (const field of ['evidence_text', 'evidence_hash']) await test('changed evidence input changes fingerprint ' + field, async () => { const state = setup(); const first = await state.build(); state.timeline.entries[0].claims[0].evidence[0][field] = 'Changed input'; assert.notEqual((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  for (const field of ['model', 'promptVersion', 'contractVersion']) await test('configuration participates in fingerprint ' + field, async () => { const a = setup(); const b = setup({ [field]: 'changed' }); assert.notEqual((await a.build()).metadata.input_fingerprint, (await b.build()).metadata.input_fingerprint); });
  await test('report time changes fingerprint but extraction clock does not', async () => { const state = setup(); const first = await state.build(); state.timeline.entries[0].claims[0].extracted_at = new Date(); assert.equal((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); state.timeline.entries[0].report_timestamp = '2026-10-03T00:00:00Z'; assert.notEqual((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  await test('sources immutable and result recursively frozen', async () => { const state = setup(); const before = JSON.stringify([state.timeline, state.changes, state.relations, state.audit]); const result = await state.build(); assert.equal(JSON.stringify([state.timeline, state.changes, state.relations, state.audit]), before); assert.ok(Object.isFrozen(result.claims[0].source)); assert.ok(Object.isFrozen(result.metadata)); });
  await test('claim/evidence count bounds close dependent references', async () => { const result = await setup({ maxClaims: 1, maxEvidence: 1 }).build(); assert.equal(result.claims.length, 1); assert.equal(result.changes.length, 0); assert.equal(result.coverage.bounds.truncated, true); requireContext(result); });
  await test('changed omitted inputs still invalidate fingerprint', async () => { const state = setup({ maxClaims: 1 }); const first = await state.build(); state.timeline.entries[1].claims[0].claim_text = 'Changed omitted claim'; assert.notEqual((await state.build()).metadata.input_fingerprint, first.metadata.input_fingerprint); });
  await test('byte bound drops whole units without factual truncation', async () => { const result = await setup({ maxContextBytes: 1800 }).build(); assert.ok(Buffer.byteLength(stableSerialize(result)) <= 1800); assert.equal(result.coverage.bounds.truncated, true); requireContext(result); for (const claim of result.claims) assert.ok(fixture.context.claims.some(row => row.claim_text === claim.claim_text)); });
  await test('unrepresentable metadata budget fails explicitly', async () => await assert.rejects(setup({ maxContextBytes: 80 }).build(), { code: 'SUMMARY_CONTEXT_TOO_LARGE' }));
  await test('zero claims never performs an unscoped audit', async () => { const state = setup(); state.timeline.entries.forEach(row => { row.claims = []; row.claim_count = 0; row.claims_status = 'empty'; }); state.changes.changes = []; const result = await state.build(); assert.equal(result.claims.length, 0); assert.equal(state.calls.filter(row => row[0] === 'audit').length, 0); assert.equal(result.reports.length, 2); });
  await test('zero reports avoids audit', async () => { const state = setup(); state.timeline.entries = []; state.changes.changes = []; await state.build(); assert.equal(state.calls.filter(row => row[0] === 'audit').length, 0); });
  await test('audit failure degrades to unknown not supported', async () => { const state = setup(); state.auditError = true; const result = await state.build(); assert.equal(result.evidence[0].source_grounded, null); assert.ok(result.warnings.some(row => row.code === 'SUMMARY_EVIDENCE_AUDIT_UNAVAILABLE')); });
  await test('contradiction read failure degrades coverage', async () => { const state = setup(); state.relationError = true; const result = await state.build(); assert.equal(result.coverage.contradictions.available, false); assert.equal(result.coverage.status, 'partial'); });
  await test('change read failure degrades coverage', async () => { const state = setup(); state.changeError = true; const result = await state.build(); assert.equal(result.coverage.status, 'partial'); assert.equal(result.changes.length, 0); });
  await test('another event auxiliary response rejected', async () => { const state = setup(); state.changes.event = { id: 'outside' }; await assert.rejects(state.build(), { code: 'SUMMARY_CROSS_EVENT_REFERENCE' }); });
  await test('invalid bounds rejected locally', () => assert.throws(() => setup({ maxClaims: 0 })));
  await test('migration/model consistency and reversible definitions without DB', async () => {
    const calls = [];
    const queryInterface = Object.fromEntries(['addColumn', 'addIndex', 'removeIndex', 'removeColumn'].map(method => [method, async (...args) => calls.push([method, ...args])]));
    const types = { UUID: 'UUID', UUIDV4: 'UUIDV4', NOW: 'NOW', DATE: 'DATE', JSON: 'JSON', STRING: n => 'VARCHAR(' + n + ')', CHAR: n => 'CHAR(' + n + ')', TEXT: n => 'TEXT(' + n + ')', ENUM: (...values) => ({ enum: values }) };
    const migration = require('../migrations/013_extend_summary_grounding');
    await migration.up(queryInterface, types);
    const model = originalLoad.call(Module, '../models/summary', module)( { define: (name, attributes, options) => ({ name, attributes, options }) }, types);
    const columns = calls.filter(row => row[0] === 'addColumn');
    assert.equal(columns.length, 8);
    assert.deepEqual(model.attributes.grounding_status.type.enum, config.groundingStatuses);
    assert.deepEqual(model.attributes.generation_status.type.enum, config.generationStatuses);
    assert.deepEqual(model.attributes.verification_status.type.enum, config.summaryStatuses);
    for (const [, table, name, definition] of columns) { assert.equal(table, 'summaries'); assert.deepEqual(model.attributes[name].type, definition.type); assert.equal(model.attributes[name].allowNull, definition.allowNull); assert.equal(model.attributes[name].defaultValue, definition.defaultValue); }
    const indexes = calls.filter(row => row[0] === 'addIndex');
    assert.equal(indexes.length, 2);
    assert.deepEqual(indexes[0].slice(1), ['summaries', ['event_id', 'input_fingerprint'], { name: 'idx_summaries_input_unique', unique: true }]);
    for (const [, , fields, opts] of indexes) assert.ok(model.options.indexes.some(row => row.name === opts.name && JSON.stringify(row.fields) === JSON.stringify(fields)));
    await migration.down(queryInterface);
    assert.deepEqual(calls.filter(row => row[0] === 'removeColumn').map(row => row[2]), columns.map(row => row[2]).reverse());
    assert.equal(calls.filter(row => row[0] === 'removeIndex').length, 2);
  });
  await test('evidence article must equal its claim article within event', async () => { const state=setup(); state.timeline.entries[0].claims[0].evidence[0].article_id='article-b'; await assert.rejects(state.build(),{code:'SUMMARY_INVALID_EVIDENCE_REFERENCE'}); });
  await test('source audit preserves case and generates bound provenance', async () => { const state=setup(); const result=await state.build(); const row=result.evidence[0]; assert.equal(row.exact_source_grounded,true); assert.equal(row.source_excerpt_provenance.source_id,'source-a'); assert.equal(row.source_excerpt_provenance.evidence_hash,row.evidence_hash); });
  await test('case-insensitive legacy audit cannot establish exact excerpt provenance', async () => { const state=setup(); state.articles[0].content=state.articles[0].content.toLowerCase(); const row=(await state.build()).evidence[0]; assert.equal(row.source_grounded,true); assert.equal(row.exact_source_grounded,false); assert.equal(row.source_excerpt_provenance,null); });
  await test('source read failure leaves excerpts unproven', async () => { const state=setup(); state.sourceError=true; const result=await state.build(); assert.equal(result.evidence[0].exact_source_grounded,null); assert.ok(result.warnings.some(row=>row.code==='SUMMARY_EXCERPT_AUDIT_UNAVAILABLE')); });
  await test('source attribution mismatch fails closed', async () => { const state=setup(); state.articles[0].source.id='imposter'; await assert.rejects(state.build(),{code:'SUMMARY_INVALID_EVIDENCE_REFERENCE'}); });
  await test('unrelated source read is rejected', async () => { const state=setup(); state.articles.push({id:'outside'}); await assert.rejects(state.build(),{code:'SUMMARY_INVALID_EVIDENCE_REFERENCE'}); });
  await test('source text changes invalidate fingerprint even when quote still exists', async () => { const state=setup(); const first=await state.build(); state.articles[0].content+=' More original reporting.'; assert.notEqual((await state.build()).metadata.input_fingerprint,first.metadata.input_fingerprint); });
  await test('single-source warning is in context before fingerprint', async () => { const state=setup(); state.timeline.entries=state.timeline.entries.slice(0,1); state.articles=state.articles.slice(0,1); state.changes.changes=[]; const result=await state.build(); assert.ok(result.warnings.some(row=>row.code==='SUMMARY_SINGLE_SOURCE')); assert.ok(result.metadata.input_fingerprint); });
  console.log(`TESTS_PASSED=${passed}\nTESTS_FAILED=${failed}`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
