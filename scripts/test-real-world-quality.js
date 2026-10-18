'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { validateArtifact, evaluateArtifact, safeArtifactPath } = require('../evaluation/realWorldQuality');
const { main, reportArtifact } = require('./evaluate-real-world-quality');
const FILE = 'fixtures/real-world-quality-template.json';
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', FILE), 'utf8'));
const metrics = data => evaluateArtifact(data).runs[0].metrics;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('synthetic fixture validates and produces counted metrics, not factual truth', () => {
  const data = fixture(), report = evaluateArtifact(data), m = report.runs[0].metrics;
  assert.equal(validateArtifact(data), data); assert.equal(report.complete, true); assert.equal(report.factual_truth_verified, false);
  assert.equal(report.minimum_checks_pass, true); assert.deepEqual(m.claim_precision, { value: 1, numerator: 2, denominator: 2, reason: null });
  assert.equal(m.claim_recall.numerator, 2); assert.equal(m.claim_recall.denominator, 5);
  assert.equal(m.summary_coverage.value, 1); assert.equal(m.timeline_ordering.numerator, 1); assert.equal(m.timeline_ordering.excluded_pairs, 2);
});

for (const [name, mutate] of [
  ['missing events', x => { delete x.events; }],
  ['missing reference claims', x => { delete x.events[0].claims; }],
  ['missing review', x => { delete x.runs[0].review; }],
  ['duplicate event IDs', x => x.events.push(structuredClone(x.events[0]))],
  ['duplicate claim IDs', x => x.events[0].claims.push(structuredClone(x.events[0].claims[0]))],
  ['duplicate output IDs', x => x.runs[0].claims.push(structuredClone(x.runs[0].claims[0]))],
  ['orphan evidence', x => { x.events[0].evidence[0].claim_id = 'missing'; }],
  ['wrong evidence report', x => { x.events[0].evidence[0].report_id = 'report-b'; }],
  ['unknown output evidence', x => { x.runs[0].evidence[0].reference_evidence_id = 'missing'; }],
  ['cross-claim output evidence', x => { x.runs[0].evidence[0].claim_output_id = 'output-claim-b'; }],
  ['unknown summary evidence', x => { x.runs[0].statements[0].evidence_ids = ['missing']; }],
  ['mismatched statement evidence', x => { x.runs[0].statements[0].evidence_ids = ['evidence-b']; }],
  ['unknown scenario', x => { x.events[0].scenario = 'H'; }],
  ['unresolved required review', x => { x.events[0].review.status = 'unresolved'; }],
  ['unresolved conflict labels', x => { x.events[0].relations[0].resolution = 'pending'; }],
  ['ambiguous relation falsely resolved', x => { x.events[0].relations[1].resolution = 'resolved'; }],
  ['bad timestamp', x => { x.events[0].assessment_cutoff = 'tomorrow'; }],
  ['impossible calendar date', x => { x.events[0].reports[0].published_at = '2026-02-30T00:00:00Z'; }],
  ['timezone omitted', x => { x.events[0].reports[0].published_at = '2026-01-01T10:00:00'; }],
  ['after cutoff', x => { x.events[0].reports[0].collected_at = '2027-01-01T00:00:00Z'; }],
  ['invalid support classification', x => { x.events[0].evidence[0].relationship = 'verified_true'; }],
  ['non-source reference excerpt', x => { x.events[0].evidence[0].excerpt = 'invented'; }],
  ['stale article hash', x => { x.events[0].reports[0].text += ' Changed.'; }],
  ['unsafe metadata path', x => { x.events[0].reports[0].artifact.path = '../.env'; }],
  ['incomplete artifact', x => { x.complete = false; }],
  ['missing run', x => { x.runs = []; }],
  ['success despite failed technical execution', x => { x.runs[0].status = 'failed'; }],
  ['success despite invalid schema', x => { x.runs[0].schema_valid = false; }],
  ['empty accepted result', x => { x.runs[0].statements = []; }],
  ['factual truth at top', x => { x.factual_truth_verified = true; }],
  ['factual truth in run', x => { x.runs[0].factual_truth_verified = true; }],
  ['unsupported hidden field', x => { Object.defineProperty(x.events[0], 'secret', { value: 'dummy' }); }],
  ['array custom field', x => { x.events.extra = 1; }],
  ['accessor never invoked', x => { Object.defineProperty(x.events[0], 'scenario', { enumerable: true, get() { throw new Error('must not execute'); } }); }]
]) test('rejects ' + name, () => { const data = fixture(); mutate(data); assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' }); });

for (const value of ['../.env', '.env', 'fixtures/.env.json', '/tmp/a.json', 'C:/data/a.json', 'fixtures/../a.json', 'fixtures//a.json', 'https://fixture.invalid/a.json', 'fixtures/credentials.json', 'fixtures/a%2ejson', 'fixtures/a\\b.json']) {
  test('unsafe path rejected without opening it: ' + value, () => assert.throws(() => safeArtifactPath(value)));
}
test('unsupported accepted additions are counted and fail minimum checks', () => {
  const data = fixture(); data.runs[0].statements[0].support = 'insufficient';
  const report = evaluateArtifact(data); assert.equal(report.minimum_checks_pass, false);
  assert.equal(report.runs[0].metrics.unsupported_statement_rate.numerator, 1);
  assert.equal(report.runs[0].metrics.summary_coverage.numerator, 1);
});
test('changed attribution is not supported summary coverage', () => {
  const data = fixture(); data.runs[0].statements[0].attribution_correct = false;
  const report = evaluateArtifact(data); assert.equal(report.minimum_checks_pass, false); assert.equal(report.runs[0].metrics.attribution_accuracy.value, 0.5);
  assert.equal(report.runs[0].metrics.summary_coverage.value, 0.5);
});
test('zero denominator differs from unavailable observations', () => {
  const data = fixture(); data.events[0].relations = data.events[0].relations.filter(row => row.kind !== 'conflict');
  const m = metrics(data); assert.equal(m.contradiction_candidate_recall.value, 'N/A');
  assert.equal(m.contradiction_candidate_recall.reason, 'ZERO_DENOMINATOR');
  data.runs[0].claims = null; data.runs[0].evidence = null;
  const missing = metrics(data).claim_precision; assert.equal(missing.value, 'N/A'); assert.equal(missing.numerator, null); assert.equal(missing.reason, 'OBSERVATIONS_UNAVAILABLE');
});
test('repeated output claims cannot inflate recall', () => {
  const data = fixture(); data.runs[0].claims.push({ ...data.runs[0].claims[0], id: 'duplicate-semantic-claim' });
  assert.equal(metrics(data).claim_recall.numerator, 2); assert.equal(metrics(data).claim_precision.denominator, 3);
});
test('equivalent reference claims share one recall target', () => {
  const data = fixture(); data.events[0].claims[2].equivalence_group = data.events[0].claims[0].equivalence_group;
  assert.equal(metrics(data).claim_recall.denominator, 4);
});
test('syndicated publishers do not count as independent origins', () => {
  const result = evaluateArtifact(fixture()).runs[0].source_independence;
  assert.equal(result.publishers, 3); assert.equal(result.confirmed_origin_groups, 1); assert.equal(result.unknown_or_uncertain_reports, 1);
});
test('time ties are excluded rather than forced into an order', () => {
  const data = fixture(); data.events[0].reports[1].published_at = data.events[0].reports[0].published_at;
  assert.equal(metrics(data).timeline_ordering.value, 'N/A'); assert.equal(metrics(data).timeline_ordering.excluded_pairs, 3);
});
test('unknown publication dates remain excluded and labelled fallback', () => {
  const data = fixture(); data.events[0].reports[0].published_at = null; data.events[0].reports[0].date_fallback = true;
  assert.equal(metrics(data).timeline_ordering.denominator, 0);
});
test('missing ordered reports count as missed comparable pairs', () => {
  const data = fixture(); data.runs[0].timeline = ['report-a']; assert.equal(metrics(data).timeline_ordering.value, 0);
});
test('changing units affects provenance fingerprint, not automatic semantic truth', () => {
  const data = fixture(), before = evaluateArtifact(data); data.events[0].claims[2].unit = 'seats';
  const after = evaluateArtifact(data); assert.notEqual(before.fingerprint, after.fingerprint); assert.equal(after.factual_truth_verified, false);
});
test('normal update predicted as direct conflict has exact TP FP FN', () => {
  const data = fixture(); data.events[0].relations = data.events[0].relations.filter(row => row.id === 'relation-update'); data.runs[0].classifications[0].classification = 'direct';
  const classes = metrics(data).contradiction_classification.classes;
  assert.deepEqual([classes.direct.tp, classes.direct.fp, classes.direct.fn], [0, 1, 0]);
  assert.deepEqual([classes.none.tp, classes.none.fp, classes.none.fn], [0, 0, 1]);
});
test('known positive contradiction yields exact counts and missing decisions reduce recall', () => {
  const data = fixture(); data.events[0].relations = data.events[0].relations.filter(row => row.id === 'relation-update'); const relation = data.events[0].relations[0];
  relation.kind = 'conflict'; relation.classification = 'direct'; relation.required_disclosure = true;
  data.runs[0].candidate_relation_ids = [relation.id]; data.runs[0].classifications[0].classification = 'direct'; data.runs[0].disclosed_relation_ids = [relation.id];
  let m = metrics(data); assert.equal(m.contradiction_candidate_recall.value, 1); assert.equal(m.conflict_preservation.value, 1);
  assert.deepEqual([m.contradiction_classification.classes.direct.tp, m.contradiction_classification.classes.direct.fp, m.contradiction_classification.classes.direct.fn], [1, 0, 0]);
  data.runs[0].classifications = []; m = metrics(data); assert.equal(m.contradiction_classification.classes.direct.recall.value, 0);
});
test('duplicate change predictions cannot inflate recall or precision', () => {
  const data = fixture(); data.runs[0].changes.push({ ...data.runs[0].changes[0], id: 'duplicate-change' });
  assert.equal(metrics(data).change_precision.value, 0.5); assert.equal(metrics(data).change_recall.value, 1);
});
test('wrong update category produces a false positive and false negative', () => {
  const data = fixture(); data.runs[0].changes[0].category = 'contradictory_information';
  assert.equal(metrics(data).change_precision.numerator, 0); assert.equal(metrics(data).change_recall.numerator, 0);
});
test('unsupported adversarial acceptance is visible even if natural summaries pass', () => {
  const data = fixture(); data.runs[0].grounding_trials[1].actual_accept = true;
  const report = evaluateArtifact(data); assert.equal(report.minimum_checks_pass, false); assert.equal(report.runs[0].metrics.unsupported_acceptance_rate.value, 1);
});
test('weak evidence abstention and failed runs are separate outcomes', () => {
  const data = fixture(); data.events[0].expected_abstention = true; data.runs[0].summary_status = 'insufficient_grounding'; data.runs[0].statements = [];
  assert.equal(metrics(data).insufficient_grounding_accuracy.value, 1);
  data.runs[0].status = 'failed'; data.runs[0].summary_status = 'failed';
  assert.equal(evaluateArtifact(data).minimum_checks_pass, false); assert.equal(metrics(data).technical_completion.value, 0);
});
test('excerpt occurrence is distinct from human support', () => {
  const data = fixture(); data.runs[0].evidence[0].human_support = 'insufficient';
  assert.equal(metrics(data).evidence_traceability.value, 1); assert.equal(metrics(data).evidence_support.value, 0);
});
test('non-occurring captured evidence lowers traceability without inventing a source', () => {
  const data = fixture(); data.runs[0].evidence[0].excerpt = 'A fabricated quote.'; data.runs[0].evidence[0].human_support = 'insufficient';
  assert.equal(metrics(data).evidence_traceability.value, 0);
});
test('redundant summary propositions and extra idempotency dispatches are measured', () => {
  const data = fixture(); data.runs[0].statements.push({ ...data.runs[0].statements[0], id: 'statement-duplicate' });
  data.runs[0].idempotency_trials[0].extra_dispatches = 1;
  assert.equal(metrics(data).redundancy.numerator, 1); assert.equal(metrics(data).summary_coverage.numerator, 2); assert.equal(metrics(data).idempotency.value, 0);
});
test('deterministic inputs and object-key reordering produce the same fingerprint', () => {
  const data = fixture(), before = evaluateArtifact(data);
  const reordered = Object.fromEntries(Object.entries(data).reverse()); assert.deepEqual(evaluateArtifact(reordered), before);
});
test('changed evidence labels affect evaluation fingerprint', () => {
  const data = fixture(), before = evaluateArtifact(data).fingerprint; data.events[0].evidence[0].relationship = 'contradict';
  assert.notEqual(evaluateArtifact(data).fingerprint, before);
});
test('changed warnings affect fingerprint without entering statements', () => {
  const data = fixture(), before = evaluateArtifact(data); data.runs[0].warnings.push({ code: 'SUMMARY_CONFLICT_OMITTED', count: 1 });
  const after = evaluateArtifact(data); assert.notEqual(after.fingerprint, before.fingerprint); assert.deepEqual(after.runs[0].metrics, before.runs[0].metrics);
  assert.ok(!JSON.stringify(after).includes('SUMMARY_CONFLICT_OMITTED'));
});
test('changed article text requires matching hash and changes fingerprint', () => {
  const data = fixture(), before = evaluateArtifact(data).fingerprint; data.events[0].reports[0].text += ' A synthetic addition.';
  data.events[0].reports[0].artifact.sha256 = sha(data.events[0].reports[0].text); assert.notEqual(evaluateArtifact(data).fingerprint, before);
});
test('CLI success, invalid path and incomplete input use sanitized nonzero rejection', () => {
  const out = []; assert.equal(main([FILE], value => out.push(value)), 0); assert.equal(out[0].exitCode, 0);
  for (const args of [[], ['../.env'], ['https://fixture.invalid/a'], [FILE, '--execute']]) {
    const rows = []; assert.equal(main(args, value => rows.push(value)), 1);
    assert.equal(rows[0].complete, false); assert.equal(rows[0].code, 'QUALITY_ARTIFACT_REJECTED');
    assert.ok(!JSON.stringify(rows).includes('C:\\')); assert.ok(!JSON.stringify(rows).includes('.env'));
  }
});
test('dependency sentinel permits only pure crypto import; no credential/config/network/native/DB initialization', () => {
  const target = require.resolve('../evaluation/realWorldQuality'), saved = require.cache[target], original = Module._load;
  const seen = [];
  try {
    delete require.cache[target];
    Module._load = function (name, parent, mainFlag) {
      if (parent?.filename === target) { seen.push(name); assert.equal(name, 'node:crypto'); }
      return original.call(this, name, parent, mainFlag);
    };
    const pure = require(target); pure.evaluateArtifact(fixture()); assert.deepEqual(seen, ['node:crypto']);
  } finally { Module._load = original; require.cache[target] = saved; }
});

test('known claim precision and recall counts retain false positives and missed groups', () => {
  const data = fixture(); data.runs[0].claims.push({ id: 'unsupported-output', reference_claim_id: null, supported: false, attribution_correct: false });
  const m = metrics(data); assert.equal(m.claim_precision.numerator, 2); assert.equal(m.claim_precision.denominator, 3);
  assert.equal(m.claim_recall.numerator, 2); assert.equal(m.claim_recall.denominator - m.claim_recall.numerator, 3);
});
test('CLI reporting boundary rejects incomplete artifacts with nonzero exit', () => {
  const data = fixture(); data.complete = false; const result = reportArtifact(data);
  assert.equal(result.exitCode, 1); assert.equal(result.complete, false); assert.ok(!Object.hasOwn(result, 'runs'));
});
test('CLI reporting boundary does not classify unsupported results as success', () => {
  const data = fixture(); data.runs[0].statements[0].support = 'insufficient';
  assert.equal(reportArtifact(data).exitCode, 1);
});
test('no stage observations produces N/A, not manufactured classifier scores', () => {
  const data = fixture(); for (const key of ['claims', 'evidence', 'statements', 'candidate_relation_ids', 'classifications', 'disclosed_relation_ids', 'timeline', 'changes', 'grounding_trials', 'idempotency_trials']) data.runs[0][key] = null;
  data.runs[0].summary_status = 'needs_review'; data.runs[0].schema_valid = null;
  const m = metrics(data); assert.equal(m.contradiction_classification.confusion_matrix, null); assert.equal(m.contradiction_classification.classes.direct.f1.value, 'N/A');
  assert.equal(m.summary_coverage.reason, 'OBSERVATIONS_UNAVAILABLE'); assert.equal(m.schema_validity.value, 'N/A');
});
test('scoring never mutates captured statements or original warning shapes', () => {
  const data = fixture(), before = structuredClone(data); evaluateArtifact(data); assert.deepEqual(data, before);
});
test('all representative relationship structures remain separate from settled truth', () => {
  const data = fixture(); assert.deepEqual([...new Set(data.events[0].relations.map(row => row.kind))].sort(), ['ambiguous', 'conflict', 'correction', 'equivalent', 'normal_update']);
  assert.deepEqual([...new Set(data.events[0].evidence.map(row => row.relationship))].sort(), ['contradict', 'insufficient', 'support']);
  assert.equal(evaluateArtifact(data).factual_truth_verified, false);
});

function unavailable(data) {
  for (const key of ['claims', 'evidence', 'statements', 'candidate_relation_ids', 'classifications', 'disclosed_relation_ids', 'timeline', 'changes', 'grounding_trials', 'idempotency_trials']) data.runs[0][key] = null;
  data.runs[0].schema_valid = null; data.runs[0].summary_status = 'needs_review';
}
test('fix 1: unavailable required component stages cannot pass or exit zero', () => {
  const data = fixture(); unavailable(data); data.scope = { type: 'component', required_stages: ['claims', 'evidence'] };
  const report = reportArtifact(data); assert.equal(report.artifact_complete, true); assert.equal(report.complete, false);
  assert.equal(report.evaluation_status, 'NOT EVALUATED'); assert.equal(report.minimum_checks_pass, false); assert.equal(report.evaluation_success, false); assert.equal(report.exitCode, 1);
  assert.equal(report.runs[0].stages.claims.status, 'NOT EVALUATED');
});
test('fix 1: partial end-to-end observation cannot claim successful completion', () => {
  const data = fixture(); data.runs[0].timeline = null;
  const report = reportArtifact(data); assert.equal(report.evaluation_status, 'PARTIAL'); assert.equal(report.complete, false);
  assert.equal(report.end_to_end_complete, false); assert.equal(report.exitCode, 1); assert.equal(report.runs[0].stages.timeline.reason, 'OBSERVATIONS_UNAVAILABLE');
});
test('fix 1: explicitly scoped claims/evidence evaluation succeeds without summary data', () => {
  const data = fixture(), claims = data.runs[0].claims, evidence = data.runs[0].evidence; unavailable(data);
  data.runs[0].claims = claims; data.runs[0].evidence = evidence; data.scope = { type: 'component', required_stages: ['claims', 'evidence'] };
  const report = reportArtifact(data); assert.equal(report.exitCode, 0); assert.equal(report.evaluation_success, true); assert.equal(report.end_to_end_complete, false);
  assert.equal(report.runs[0].stages.summary.status, 'NOT EVALUATED'); assert.equal(report.runs[0].stages.summary.reason, 'OUT_OF_SCOPE');
  assert.equal(report.runs[0].metrics.summary_coverage.value, 'N/A'); assert.equal(report.runs[0].metrics.summary_coverage.reason, 'OUT_OF_SCOPE');
});
test('fix 1: out-of-scope populated data is not silently reported as evaluated', () => {
  const data = fixture(); data.scope = { type: 'component', required_stages: ['claims'] };
  const report = evaluateArtifact(data); assert.equal(report.runs[0].stages.contradictions.status, 'NOT EVALUATED');
  assert.equal(report.runs[0].metrics.contradiction_classification.classes.direct.f1.reason, 'OUT_OF_SCOPE');
});
for (const [name, scope] of [['missing', null], ['unknown stage', { type: 'component', required_stages: ['network'] }], ['empty', { type: 'component', required_stages: [] }], ['duplicate', { type: 'component', required_stages: ['claims', 'claims'] }], ['partial end-to-end declaration', { type: 'end_to_end', required_stages: ['claims'] }]]) {
  test('fix 1: rejects ' + name + ' scope', () => { const data = fixture(); data.scope = scope; assert.throws(() => validateArtifact(data)); });
}
test('fix 1: no grounding trials or same-input repeats means stages are not evaluated', () => {
  const data = fixture(); data.runs[0].grounding_trials = []; data.runs[0].idempotency_trials[0].same_input = false;
  const report = evaluateArtifact(data); assert.equal(report.complete, false); assert.equal(report.runs[0].stages.grounding.status, 'NOT EVALUATED');
  assert.equal(report.runs[0].stages.idempotency.status, 'NOT EVALUATED');
});

test('fix 2: A evidence cannot credit referenced claim B', () => {
  const data = fixture(), row = data.runs[0].statements[0];
  row.reference_claim_ids.push('claim-b'); row.claim_support.push({ claim_id: 'claim-b', evidence_ids: [], support: 'support' });
  data.runs[0].statements.pop(); assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 2: claim-level A evidence cannot be assigned to B', () => {
  const data = fixture(), row = data.runs[0].statements[0];
  row.reference_claim_ids.push('claim-b'); row.claim_support.push({ claim_id: 'claim-b', evidence_ids: ['evidence-a'], support: 'support' });
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 2: missing claim-level judgement fails closed', () => {
  const data = fixture(); data.runs[0].statements[0].reference_claim_ids.push('claim-b');
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 2: A and B both receive credit with separate evidence and support judgements', () => {
  const data = fixture(), row = data.runs[0].statements[0];
  row.text += ' ' + data.runs[0].statements[1].text; row.reference_claim_ids.push('claim-b'); row.evidence_ids.push('evidence-b');
  row.claim_support.push({ claim_id: 'claim-b', evidence_ids: ['evidence-b'], support: 'support' }); data.runs[0].statements.pop();
  assert.equal(metrics(data).summary_coverage.numerator, 2); assert.equal(metrics(data).summary_coverage.denominator, 2);
});
test('fix 2: inconsistent claim-level semantic support cannot be accepted as whole support', () => {
  const data = fixture(); data.runs[0].statements[0].claim_support[0].support = 'insufficient';
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 2: duplicate source evidence cannot create additional summary coverage', () => {
  const data = fixture(); data.runs[0].statements.pop(); assert.equal(metrics(data).summary_coverage.numerator, 1);
  data.events[0].evidence.push({ ...data.events[0].evidence[0], id: 'reference-evidence-alias' });
  data.runs[0].statements[0].evidence_ids.push('reference-evidence-alias'); data.runs[0].statements[0].claim_support[0].evidence_ids.push('reference-evidence-alias');
  assert.equal(metrics(data).summary_coverage.numerator, 1); assert.equal(metrics(data).summary_coverage.denominator, 2);
});

test('fix 3: exact reference duplicates with new IDs share the same recall target', () => {
  const data = fixture(), before = metrics(data).claim_recall;
  data.events[0].claims.push({ ...data.events[0].claims[0], id: 'reference-copy' });
  assert.deepEqual(metrics(data).claim_recall, before);
});
test('fix 3: exact identities with inconsistent equivalence groups fail closed', () => {
  const data = fixture(); data.events[0].claims.push({ ...data.events[0].claims[0], id: 'reference-copy', equivalence_group: 'inconsistent-group' });
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
for (const reversed of [false, true]) test('fix 3: symmetric reference/prediction duplicates are counted once, reversed=' + reversed, () => {
  const data = fixture(), original = data.events[0].relations.find(row => row.id === 'relation-conflict');
  const before = metrics(data).contradiction_classification.classes.direct;
  data.events[0].relations.push({ ...original, id: 'relation-conflict-copy', claim_ids: reversed ? [...original.claim_ids].reverse() : [...original.claim_ids] });
  assert.deepEqual(metrics(data).contradiction_classification.classes.direct, before);
  data.runs[0].classifications.push({ id: 'prediction-one', relation_id: original.id, classification: 'direct' }, { id: 'prediction-copy', relation_id: 'relation-conflict-copy', classification: 'direct' });
  data.runs[0].candidate_relation_ids = [original.id, 'relation-conflict-copy']; data.runs[0].disclosed_relation_ids = [original.id, 'relation-conflict-copy'];
  const m = metrics(data); assert.equal(m.contradiction_classification.classes.direct.tp, 1); assert.equal(m.contradiction_classification.classes.direct.recall.denominator, 1);
  assert.equal(m.contradiction_candidate_recall.denominator, 1); assert.equal(m.conflict_preservation.denominator, 1);
});
test('fix 3: conflicting duplicate symmetric annotations fail closed', () => {
  const data = fixture(), row = data.events[0].relations.find(item => item.id === 'relation-conflict');
  data.events[0].relations.push({ ...row, id: 'conflicting-reference-copy', classification: 'partial', claim_ids: [...row.claim_ids].reverse() });
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 3: conflicting predictions against reference aliases fail closed', () => {
  const data = fixture(), row = data.events[0].relations.find(item => item.id === 'relation-conflict');
  data.events[0].relations.push({ ...row, id: 'reference-copy' });
  data.runs[0].classifications.push({ id: 'prediction-a', relation_id: row.id, classification: 'direct' }, { id: 'prediction-b', relation_id: 'reference-copy', classification: 'none' });
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 3: directional reverse updates remain distinct, same-direction copies do not', () => {
  const data = fixture(), row = data.events[0].relations[0], before = metrics(data).contradiction_classification.classes.none.recall.denominator;
  data.events[0].relations.push({ ...row, id: 'directional-copy' }); assert.equal(metrics(data).contradiction_classification.classes.none.recall.denominator, before);
  data.events[0].relations.push({ ...row, id: 'directional-reverse', claim_ids: [...row.claim_ids].reverse() });
  assert.equal(metrics(data).contradiction_classification.classes.none.recall.denominator, before + 1);
});
test('fix 3: distinct propositions retain separate recall targets', () => {
  const data = fixture(), before = metrics(data).claim_recall.denominator;
  data.events[0].claims.push({ ...data.events[0].claims[0], id: 'distinct-proposition', text: 'The fictional hall closed on Wednesday.', reference_period: 'Wednesday', equivalence_group: 'fact-wednesday' });
  assert.equal(metrics(data).claim_recall.denominator, before + 1);
});

function twoEvidenceObservations() {
  const data = fixture(); data.runs[0].evidence.push({ id: 'unsupported-evidence-b', claim_output_id: 'output-claim-b', reference_evidence_id: 'evidence-b', report_id: 'report-b', excerpt: 'A fabricated observation.', human_support: 'insufficient' });
  return data;
}
test('fix 4: distinct supported and unsupported links produce exact 1/2 rates', () => {
  const m = metrics(twoEvidenceObservations()); assert.equal(m.evidence_support.numerator, 1); assert.equal(m.evidence_support.denominator, 2);
  assert.equal(m.evidence_traceability.value, 0.5);
});
test('fix 4: copying supported observations cannot improve support or traceability', () => {
  const data = twoEvidenceObservations(), before = metrics(data);
  for (let i = 0; i < 8; i++) data.runs[0].evidence.push({ ...data.runs[0].evidence[0], id: 'evidence-copy-' + i });
  const report = evaluateArtifact(data).runs[0]; assert.deepEqual(report.metrics.evidence_support, before.evidence_support);
  assert.deepEqual(report.metrics.evidence_traceability, before.evidence_traceability); assert.deepEqual(report.evidence_observations, { raw: 10, unique: 2, duplicates: 8 });
});
for (const field of ['human_support', 'excerpt']) test('fix 4: conflicting duplicate evidence ' + field + ' fails closed', () => {
  const data = fixture(), copy = { ...data.runs[0].evidence[0], id: 'conflicting-evidence' };
  copy[field] = field === 'excerpt' ? 'A different observation.' : 'insufficient'; data.runs[0].evidence.push(copy);
  assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
test('fix 4: reference evidence aliases cannot evade metric deduplication', () => {
  const data = fixture(); data.events[0].evidence.push({ ...data.events[0].evidence[0], id: 'reference-evidence-copy' });
  data.runs[0].evidence.push({ ...data.runs[0].evidence[0], id: 'observation-copy', reference_evidence_id: 'reference-evidence-copy' });
  assert.equal(metrics(data).evidence_support.denominator, 1); assert.equal(evaluateArtifact(data).runs[0].evidence_observations.duplicates, 1);
});

test('fix 5: supported correctly attributed content is not unsupported', () => assert.equal(metrics(fixture()).unsupported_statement_rate.numerator, 0));
test('fix 5: supported content with wrong attribution counts as unsupported', () => {
  const data = fixture(); data.runs[0].statements[0].attribution_correct = false;
  const m = metrics(data); assert.equal(m.unsupported_statement_rate.numerator, 1); assert.equal(m.unsupported_statement_rate.denominator, 2); assert.equal(m.attribution_accuracy.value, 0.5);
});
test('fix 5: multiple defects on one statement count once', () => {
  const data = fixture(); data.runs[0].statements[0].support = 'insufficient'; data.runs[0].statements[0].attribution_correct = false;
  assert.equal(metrics(data).unsupported_statement_rate.numerator, 1);
});
test('fix 5: non-accepted statements are excluded from the accepted denominator', () => {
  const data = fixture(); data.runs[0].summary_status = 'needs_review'; data.runs[0].statements[0].attribution_correct = false;
  const m = metrics(data).unsupported_statement_rate; assert.equal(m.numerator, 0); assert.equal(m.denominator, 0); assert.equal(m.value, 'N/A');
});

test('fix 6: valid exact source offsets remain accepted', () => assert.doesNotThrow(() => validateArtifact(fixture())));
for (const [name, values] of [['oversized end', { end: 1000000 }], ['negative start', { start: -1 }], ['end before start', { start: 20, end: 10 }], ['fractional start', { start: 0.5 }], ['fractional end', { end: 35.5 }], ['empty span', { start: 0, end: 0 }]]) {
  test('fix 6: rejects ' + name, () => { const data = fixture(); Object.assign(data.events[0].evidence[0], values); assert.throws(() => validateArtifact(data), { code: 'QUALITY_ARTIFACT_INVALID' }); });
}
