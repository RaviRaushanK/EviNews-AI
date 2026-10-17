const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (/sequelize|google|gemini|services|models|https?$|^net$/.test(name)) throw new Error('Forbidden utility dependency: ' + name);
  return originalLoad.call(this, name, ...args);
};
const changes = require('../utils/eventChanges');
const fixture = require('../fixtures/phase6-utilities.json');
let passed = 0;
let failed = 0;
function test(name, callback) {
  try { callback(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' -> ' + error.message); }
}
function pair(item) {
  return { previous: { id: item.id + '-before', claim_text: item.before, claim_type: item.type }, current: { id: item.id + '-after', claim_text: item.after, claim_type: item.type } };
}
for (const item of fixture.comparisons) {
  test('fixture ' + item.id, () => {
    const { current, previous } = pair(item);
    const relations = item.contradiction_type ? [{ id: 'stored-' + item.id, claim_id_1: current.id, claim_id_2: previous.id, contradiction_type: item.contradiction_type, status: item.status, reason: 'Isolated stored conflict' }] : [];
    const result = changes.compareClaimPair(current, previous, relations);
    assert.equal(result.category, item.category);
    assert.equal(result.current_claim_id, current.id);
    assert.ok(result.reason && result.rule_id);
    for (const key of ['previous_value', 'current_value', 'previous_context', 'current_context']) assert.ok(Object.hasOwn(result, key));
    if (relations.length) { assert.equal(result.previous_claim_id, previous.id); assert.equal(result.contradiction.status, item.status); assert.equal(result.contradiction.contradiction_type, item.contradiction_type); assert.equal(result.reason, 'Isolated stored conflict'); }
  });
}
const numeric = pair(fixture.comparisons.find((item) => item.id === 'count'));
test('changed value includes old/new values and context', () => { const result = changes.compareClaimPair(numeric.current, numeric.previous); assert.equal(result.previous_value, 100); assert.equal(result.current_value, 150); assert.equal(result.current_context.unit, 'people'); assert.equal(result.current_context.reference_period, '2026-10-01'); });
test('numeric extraction preserves dates and decimals', () => assert.deepEqual(changes.extractNumbers('2026-10-01: 1,000 people and 2.5%'), ['2026', '10', '01', '1,000', '2.5']));
test('percentage helper identifies values and units', () => assert.deepEqual(changes.extractPercentages('10% and 12.5 percent'), [{ value: 10, unit: '%' }, { value: 12.5, unit: 'percent' }]));
test('unit helper preserves currency, percent and scale', () => assert.deepEqual(changes.extractUnits('$2 million and 10%'), ['$', 'million', '%']));
test('date helper rejects impossible dates', () => assert.deepEqual(changes.extractDates('2026-02-30 and 2026-10-01'), ['2026-10-01']));
test('negation helper recognizes contractions', () => { assert.ok(changes.hasNegation("The library didn't open")); assert.ok(changes.hasNegation('The library never opened')); assert.equal(changes.hasNegation('The library opened'), false); });
test('attribution helper recognizes speakers and according-to', () => { assert.equal(changes.extractAttribution('Mayor Lee said the library opened'), 'mayor lee'); assert.equal(changes.extractAttribution('According to Mayor Rao, the library opened'), 'mayor rao'); assert.equal(changes.extractAttribution('Lee: "The library opened"'), 'lee'); });
test('money scale mismatch is not a changed value', () => { const item = pair(fixture.comparisons.find((row) => row.id === 'money')); item.current.claim_text = item.current.claim_text.replace('million', 'billion'); assert.equal(changes.compareClaimPair(item.current, item.previous).category, 'unclassified'); });
test('questions are not normalized into assertions', () => { const current = { id: 'question', claim_type: 'fact', claim_text: 'The library opened?' }; const previous = { id: 'assertion', claim_type: 'fact', claim_text: 'The library opened.' }; assert.equal(changes.compareClaimPair(current, previous).category, 'unclassified'); });
test('exact text with different reference metadata is ambiguous', () => { const current = { ...numeric.previous, id: 'other', reference_period: '2026-10-02' }; const previous = { ...numeric.previous, reference_period: '2026-10-01' }; assert.equal(changes.compareClaimPair(current, previous).category, 'unclassified'); });
test('ranges are not interpreted as a single changed value', () => { const previous = { ...numeric.previous, claim_text: numeric.previous.claim_text.replace('100 people', '100 to 150 people') }; const current = { ...numeric.current, claim_text: numeric.current.claim_text.replace('150 people', '100 to 200 people') }; assert.equal(changes.compareClaimPair(current, previous).category, 'unclassified'); });
test('unresolved pronoun values are ambiguous', () => { const previous = { ...numeric.previous, claim_text: numeric.previous.claim_text.replace('Acme', 'They') }; const current = { ...numeric.current, claim_text: numeric.current.claim_text.replace('Acme', 'They') }; assert.equal(changes.compareClaimPair(current, previous).category, 'unclassified'); });
test('unattributed identical quotations remain ambiguous', () => { const previous = { id: 'before', claim_type: 'quote', claim_text: 'I approved the plan.' }; const current = { ...previous, id: 'after' }; assert.equal(changes.compareClaimPair(current, previous).category, 'unclassified'); });
test('undated number change requires explicit caller reference period', () => { const item = pair(fixture.comparisons.find((row) => row.id === 'ambiguous-number')); item.previous.reference_period = '2026-10-01'; item.current.reference_period = '2026-10-01'; assert.equal(changes.compareClaimPair(item.current, item.previous).category, 'changed_value'); });
test('different explicit reference periods are not matched', () => { const item = pair(fixture.comparisons.find((row) => row.id === 'ambiguous-number')); item.previous.reference_period = '2026-10-01'; item.current.reference_period = '2026-10-02'; assert.equal(changes.compareClaimPair(item.current, item.previous).category, 'unclassified'); });
test('multiple metric/value patterns remain ambiguous', () => { const before = { ...numeric.previous, claim_text: 'On 2026-10-01, Acme reported 100 people affected and 20 homes damaged.' }; const after = { ...numeric.current, claim_text: 'On 2026-10-01, Acme reported 150 people affected and 20 homes damaged.' }; assert.equal(changes.compareClaimPair(after, before).category, 'unclassified'); });
test('different claim types cannot be exact repeats', () => assert.equal(changes.compareClaimPair({ ...numeric.previous, id: 'other', claim_type: 'quote' }, numeric.previous).category, 'unclassified'));
test('empty history returns qualified newly reported label', () => { const result = changes.compareClaimToHistory(numeric.current, []); assert.equal(result.rule_id, 'NEW_NO_MATCH'); assert.equal(result.previous_claim_id, null); assert.match(result.reason, /does not mean factually novel/); });
test('null history supported', () => assert.equal(changes.compareClaimToHistory(numeric.current, null).category, 'new_information'));
test('empty/null current claim arrays return no results', () => { assert.deepEqual(changes.compareClaims([], [numeric.previous]), []); assert.deepEqual(changes.compareClaims(null), []); });
test('missing claim text remains unclassified', () => { assert.equal(changes.compareClaimPair(null, numeric.previous).category, 'unclassified'); assert.equal(changes.compareClaimToHistory(null).category, 'unclassified'); });
test('no stored relation means no contradiction classification', () => { const item = pair(fixture.comparisons.find((row) => row.id === 'stored-direct')); assert.equal(changes.compareClaimPair(item.current, item.previous).category, 'unclassified'); });
test('unrelated stored relation ignored', () => assert.equal(changes.compareClaimPair(numeric.current, numeric.previous, [{ claim_id_1: 'unrelated-a', claim_id_2: 'unrelated-b', contradiction_type: 'direct' }]).category, 'changed_value'));
test('multiple possible value baselines remain unclassified', () => { const second = { ...numeric.previous, id: 'second', claim_text: numeric.previous.claim_text.replace('100', '120') }; assert.equal(changes.compareClaimToHistory(numeric.current, [numeric.previous, second]).category, 'unclassified'); });
test('history order does not affect output', () => { const another = { ...numeric.previous, id: 'a', claim_text: 'A satellite launched.' }; assert.deepEqual(changes.compareClaimToHistory(numeric.current, [numeric.previous, another]), changes.compareClaimToHistory(numeric.current, [another, numeric.previous])); });
test('same claim ID excluded from history', () => assert.equal(changes.compareClaimToHistory(numeric.current, [numeric.current]).category, 'new_information'));
test('inputs and nested stored annotations never mutated', () => { const item = pair(fixture.comparisons.find((row) => row.id === 'stored-direct')); const relation = { claim_id_1: item.current.id, claim_id_2: item.previous.id, contradiction_type: 'direct', status: 'unresolved', reason: 'Stored' }; const snapshot = JSON.stringify({ item, relation }); Object.freeze(item.current); Object.freeze(item.previous); Object.freeze(relation); const result = changes.compareClaimPair(item.current, item.previous, [relation]); result.contradiction.status = 'resolved'; assert.equal(JSON.stringify({ item, relation }), snapshot); });
test('pure imports load no models, services or provider', () => assert.ok(!Object.keys(require.cache).some((name) => /[\\/](models|services)[\\/]|@google|sequelize/.test(name))));
Module._load = originalLoad;
console.log('TESTS_PASSED=' + passed);
console.log('TESTS_FAILED=' + failed);
process.exitCode = failed ? 1 : 0;
