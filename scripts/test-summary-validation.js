const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) { if (/gemini|@google|sequelize|[\\/]models|^https?$/.test(name)) throw new Error('Forbidden dependency'); return originalLoad.call(this, name, ...args); };
global.fetch = () => { throw new Error('Forbidden provider call'); };
const fixture = require('../fixtures/phase7-summaries.json');
const { validateSummaryOutput, buildInputFingerprint, stableSerialize, requireSummaryModel } = require('../utils/summaryValidation');
let passed = 0;
let failed = 0;
function test(name, callback) { try { callback(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function sample(item = {}) {
  const data = { context: structuredClone(fixture.context), statement: structuredClone(fixture.statement) };
  for (const edit of item.set || []) { const path = [...edit.path]; const key = path.pop(); path.reduce((value, part) => value[part], data)[key] = structuredClone(edit.value); }
  return data;
}
for (const item of fixture.cases) test('fixture validation ' + item.id, () => {
  const data = sample(item);
  if (item.validation) assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context), { code: item.validation });
  else assert.equal(validateSummaryOutput({ statements: [data.statement] }, data.context).statements.length, 1);
});
for (const output of [null, [], {}, { statements: null }, { statements: {}, summary_text: 'hidden prose' }, { statements: [], extra: true }]) test('malformed top-level ' + JSON.stringify(output), () => assert.throws(() => validateSummaryOutput(output, fixture.context)));
for (const [key, value] of [['id', 'bad-id'], ['id', 's0'], ['text', ' '], ['text', 123], ['text', 'a'.repeat(2001)], ['source_claim_ids', 'claim-a'], ['evidence_ids', null], ['contradiction_ids', [false]], ['attribution', {}], ['source_claim_ids', ['claim-a', 'claim-a']]]) test('invalid statement ' + key + ':' + String(value).slice(0, 25), () => { const data = sample(); data.statement[key] = value; assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context)); });
test('unexpected statement field rejected', () => { const data = sample(); data.statement.confidence = 1; assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context)); });
test('missing attribution rejected', () => { const data = sample(); delete data.statement.attribution; assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context)); });
test('duplicate statement IDs rejected', () => assert.throws(() => validateSummaryOutput({ statements: [fixture.statement, fixture.statement] }, fixture.context)));
test('statement limit enforced', () => assert.throws(() => validateSummaryOutput({ statements: [fixture.statement] }, fixture.context, { maxStatements: 0, maxStatementChars: 2000 })));
test('empty output valid but not truth verified', () => assert.deepEqual(validateSummaryOutput({ statements: [] }, fixture.context), { statements: [] }));
test('detached immutable output', () => { const data = sample(); const result = validateSummaryOutput({ statements: [data.statement] }, data.context); assert.ok(Object.isFrozen(result.statements[0].evidence_ids)); assert.equal(data.statement.text, fixture.statement.text); });
test('matching contradiction references accepted', () => { const data = sample(fixture.cases.find(row => row.id === 'conflicting')); data.statement.source_claim_ids.push('claim-b'); data.statement.contradiction_ids.push('relation-a'); validateSummaryOutput({ statements: [data.statement] }, data.context); });
test('contradiction must reference cited pair', () => { const data = sample(fixture.cases.find(row => row.id === 'conflicting')); data.statement.contradiction_ids.push('relation-a'); assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context), { code: 'SUMMARY_WRONG_CONTRADICTION_CLAIMS' }); });
test('wrong context evidence claim rejected', () => { const data = sample(); data.context.evidence[0].claim_id = 'outside'; assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context)); });
test('cross-event evidence rejected', () => { const data = sample(); data.context.evidence[0].article_id = 'outside'; assert.throws(() => validateSummaryOutput({ statements: [data.statement] }, data.context)); });
test('fingerprint excludes prior fingerprint field', () => { const data = sample(); const hash = buildInputFingerprint(data.context); data.context.metadata.input_fingerprint = 'different'; assert.equal(buildInputFingerprint(data.context), hash); });
test('stable object key serialization', () => assert.equal(stableSerialize({ b: 2, a: 1 }), stableSerialize({ a: 1, b: 2 })));
test('invalid JSON fingerprint values rejected', () => assert.throws(() => stableSerialize({ invalid: undefined })));
test('summary model never falls back to a claim model', () => { assert.throws(() => requireSummaryModel({ provider: 'gemini', model: '' }), { code: 'SUMMARY_MODEL_NOT_CONFIGURED' }); assert.throws(() => requireSummaryModel({ provider: 'gemini', model: ' ' }), { code: 'SUMMARY_MODEL_NOT_CONFIGURED' }); assert.equal(requireSummaryModel({ provider: 'gemini', model: 'fixture-explicit' }), 'fixture-explicit'); });
test('unsupported generation provider fails locally', () => assert.throws(() => requireSummaryModel({ provider: 'other', model: 'fixture' }), { code: 'SUMMARY_PROVIDER_NOT_SUPPORTED' }));
test('evidence from another in-event article is rejected', () => { const data = sample(); data.context.evidence[0].article_id = 'article-b'; assert.throws(() => validateSummaryOutput({statements:[data.statement]},data.context), {code:'SUMMARY_INVALID_EVIDENCE_REFERENCE'}); });
test('warning content participates in fingerprint', () => { const data = sample(); const first=buildInputFingerprint(data.context); data.context.warnings[0].message='Changed coverage warning'; assert.notEqual(buildInputFingerprint(data.context),first); });
console.log(`TESTS_PASSED=${passed}\nTESTS_FAILED=${failed}`);
process.exitCode = failed ? 1 : 0;
