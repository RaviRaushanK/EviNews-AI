const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) { if (/gemini|@google|sequelize|[\\/]models|^https?$/.test(name)) throw new Error('Forbidden dependency'); return originalLoad.call(this, name, ...args); };
global.fetch = () => { throw new Error('Forbidden provider call'); };
const fixture = require('../fixtures/phase7-summaries.json');
const { groundStatement, verifySummary, evidenceHash } = require('../utils/summaryGrounding');
let passed = 0;
let failed = 0;
function test(name, callback) { try { callback(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function sample(item = {}) {
  const data = { context: structuredClone(fixture.context), statement: structuredClone(fixture.statement) };
  for (const edit of item.set || []) { const path = [...edit.path]; const key = path.pop(); path.reduce((value, part) => value[part], data)[key] = structuredClone(edit.value); }
  return data;
}
for (const item of fixture.cases) test('fixture grounding ' + item.id, () => { const data = sample(item); const before = JSON.stringify(data); const result = groundStatement(data.statement, data.context); assert.equal(result.grounding_status, item.grounding); assert.equal(result.verification_status, 'needs_review'); assert.equal(result.factual_truth_verified, false); assert.equal(JSON.stringify(data), before); });
test('no attribution cannot establish support', () => { const data = sample(); data.statement.attribution = null; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('changed speaker needs review', () => { const data = sample(); data.statement.attribution = 'Invented source'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('claim citation and source occurrence alone do not entail wording', () => { const data = sample(); data.context.evidence[0].evidence_text = 'Acme denied all layoffs.'; data.context.evidence[0].evidence_hash = evidenceHash(data.context.evidence[0].evidence_text); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('quotation embedded in a denial is not deterministically supported', () => { const data = sample(); data.context.evidence[0].evidence_text = 'This statement is false: ' + data.statement.text; data.context.evidence[0].evidence_hash = evidenceHash(data.context.evidence[0].evidence_text); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('missing hash requires review', () => { const data = sample(); data.context.evidence[0].evidence_hash = null; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('normalized hash preserves case', () => assert.equal(evidenceHash('  Abc\n def '), evidenceHash('Abc def')));
test('resolved relation does not establish truth', () => { const data = sample(fixture.cases.find(row => row.id === 'conflicting')); data.context.contradictions[0].status = 'resolved'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('stored partial and temporal types preserved', () => { for (const type of ['partial', 'temporal']) { const data = sample(fixture.cases.find(row => row.id === 'conflicting')); data.context.contradictions[0].contradiction_type = type; const result = groundStatement(data.statement, data.context); assert.equal(result.grounding_status, 'conflicting'); assert.equal(result.warnings[0].relations[0].contradiction_type, type); } });
test('coverage warning preserved even for exact support', () => { const result = groundStatement(fixture.statement, fixture.context); assert.ok(result.warnings.some(row => row.code === 'INCOMPLETE_COVERAGE')); });
test('unknown/limited coverage never yields verified', () => { for (const status of ['unknown', 'limited']) { const data = sample(); data.context.coverage.contradictions.status = status; assert.equal(verifySummary({ statements: [data.statement] }, data.context).verification_status, 'needs_review'); } });
test('empty summary stays needs_review', () => assert.equal(verifySummary({ statements: [] }, fixture.context).grounding_status, 'needs_review'));
test('mixed supported/unsupported summary is partial', () => { const data = sample(); const unsupported = { ...structuredClone(data.statement), id: 's2', source_claim_ids: [], evidence_ids: [] }; assert.equal(verifySummary({ statements: [data.statement, unsupported] }, data.context).grounding_status, 'partially_supported'); });
test('output deeply frozen', () => assert.ok(Object.isFrozen(groundStatement(fixture.statement, fixture.context).checks)));
test('numbers dates units and negation cannot be changed', () => { const data = sample(); const text = 'Director Lee said Acme did not cut 5% of jobs on 2026-10-02.'; data.context.claims[0].claim_text = text; data.context.evidence[0].evidence_text = text; data.context.evidence[0].evidence_hash = evidenceHash(text); data.statement.text = text; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'supported'); for (const altered of [text.replace('not ', ''), text.replace('Lee', 'Patel'), text.replace('5%', '6%'), text.replace('jobs', 'homes'), text.replace('10-02', '10-03')]) { data.statement.text = altered; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); } });
function excerptSample(text = 'Acme did not cut 5% of jobs on 2026-10-02.', claimText = 'Acme retained jobs.') {
  const data = sample();
  const row = data.context.evidence[0];
  data.context.metadata.contract_version = 'phase7-summary-v2';
  data.context.claims[0].claim_text = claimText;
  row.evidence_text = text;
  row.evidence_hash = evidenceHash(text);
  row.exact_source_grounded = true;
  row.source_excerpt_provenance = { article_id: row.article_id, source_id: 'source-a', source_name: 'Fixture A', evidence_hash: row.evidence_hash, source_text_hash: evidenceHash('Original source: ' + text) };
  data.statement.text = 'Fixture A excerpt: ' + text;
  return data;
}
const observed = [
  ['\u201cwhoever wins AI, wins\u201d', 'President Trump stated that whoever wins AI wins.'],
  ['President Trump dismisses need for AI guardrails', 'President Trump dismissed the need for AI guardrails.']
];
for (const [text, claim] of observed) test('observed excerpt supports provenance without validating paraphrased claim: ' + claim, () => {
  const data = excerptSample(text, claim);
  data.context.reports[0].source.name = 'BBC News'; data.context.claims[0].source.name = 'BBC News';
  data.context.evidence[0].source_excerpt_provenance.source_name = 'BBC News'; data.statement.attribution = 'BBC News'; data.statement.text = 'BBC News excerpt: ' + text;
  const result = groundStatement(data.statement, data.context);
  assert.equal(result.grounding_status, 'supported'); assert.equal(result.support_basis, 'source_excerpt');
  assert.equal(result.factual_truth_verified, false); assert.equal(result.verification_status, 'needs_review');
  assert.ok(result.warnings.some(row => row.code === 'EXCERPT_PROVENANCE_ONLY'));
  data.statement.text = claim; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review');
});
test('excerpt whitespace normalization preserves full wording', () => { const data = excerptSample(); data.statement.text = data.statement.text.replace('not cut', 'not\n cut'); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'supported'); });
for (const [name, change] of [
  ['case', text => text.replace('Acme', 'acme')], ['punctuation', text => text.replace('.', '!')],
  ['number', text => text.replace('5%', '6%')], ['date', text => text.replace('10-02', '10-03')],
  ['negation', text => text.replace('not ', '')], ['partial quotation', text => text.replace(' on 2026-10-02.', '')],
  ['caveat', text => text + ' (Evidence is single-source).'], ['invented speaker', text => text.replace('Acme', 'Director Lee says Acme')]
]) test('excerpt rejects altered ' + name, () => { const data = excerptSample(); data.statement.text = change(data.statement.text); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
for (const [name, edit] of [
  ['missing strict audit', row => { row.exact_source_grounded = null; }],
  ['case-insensitive audit only', row => { row.exact_source_grounded = false; }],
  ['missing provenance', row => { row.source_excerpt_provenance = null; }],
  ['stale provenance', row => { row.source_excerpt_provenance.evidence_hash = 'stale'; }],
  ['invalid source digest', row => { row.source_excerpt_provenance.source_text_hash = 'stale'; }],
  ['wrong source', row => { row.source_excerpt_provenance.source_name = 'Another source'; }],
  ['wrong source ID', row => { row.source_excerpt_provenance.source_id = 'another'; }],
  ['wrong provenance article', row => { row.source_excerpt_provenance.article_id = 'article-b'; }]
]) test('excerpt rejects ' + name, () => { const data = excerptSample(); edit(data.context.evidence[0]); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('excerpt rejects stale or missing evidence hash', () => { for (const hash of [null, 'stale']) { const data = excerptSample(); data.context.evidence[0].evidence_hash = hash; assert.notEqual(groundStatement(data.statement, data.context).grounding_status, 'supported'); } });
test('excerpt rejects wrong claim article even within event', () => { const data = excerptSample(); data.context.evidence[0].article_id = 'article-b'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'unsupported'); });
test('excerpt attribution must match both report and stored source', () => { const data = excerptSample(); data.context.reports[0].source.name = 'Imposter'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('excerpt requires deliberately activated contract version', () => { const data = excerptSample(); data.context.metadata.contract_version = 'phase7-summary-v1'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('excerpt cannot merge multiple claims', () => { const data = excerptSample(); data.context.claims[1].source = structuredClone(data.context.claims[0].source); data.statement.source_claim_ids.push('claim-b'); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('excerpt cannot merge multiple evidence passages', () => { const data = excerptSample(); const extra = structuredClone(data.context.evidence[0]); extra.evidence_id = 'extra'; data.context.evidence.push(extra); data.statement.evidence_ids.push('extra'); assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('denial cannot be removed from an excerpt or replaced with the claim assertion', () => { const data = excerptSample('This statement is false: Acme cut 100 jobs.', 'Acme cut 100 jobs.'); data.statement.text = 'Fixture A excerpt: Acme cut 100 jobs.'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); data.statement.text = 'Acme cut 100 jobs.'; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'needs_review'); });
test('stored conflict cannot upgrade partial claim support to persistence-safe conflicting', () => { const data = sample(fixture.cases.find(row => row.id === 'partially-supported')); data.context.contradictions = [{ contradiction_id: 'relation', claim_id_1:'claim-a', claim_id_2:'claim-b', contradiction_type:'direct', status:'unresolved' }]; assert.equal(groundStatement(data.statement, data.context).grounding_status, 'partially_supported'); });
test('legacy strict claim path retains distinct support basis', () => assert.equal(groundStatement(fixture.statement, fixture.context).support_basis, 'exact_claim'));
console.log(`TESTS_PASSED=${passed}\nTESTS_FAILED=${failed}`);
process.exitCode = failed ? 1 : 0;
