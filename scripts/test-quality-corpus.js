'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const prep = require('../evaluation/corpusPreparation');
const { validateReferenceArtifact, evaluateArtifact } = require('../evaluation/realWorldQuality');
const { loadBundle, main, approvedPath } = require('./validate-quality-corpus');
const ROOT = 'evaluation/corpora/8w-v1/';
const FILES = ['manifest-template.json', 'development-references-template.json', 'assessment-references-template.json', 'reviewer-annotations-template.json', 'adjudications-template.json'].map(name => ROOT + name);
const fixture = () => loadBundle(FILES);
const STATES = ['draft', 'annotated', 'reviewed', 'adjudicated', 'frozen'];

// These are invented offline attestations, never actual human-review results.
function setState(data, state) {
  const rank = STATES.indexOf(state);
  data.manifest.status = state; data.manifest.evaluator_commit = 'a'.repeat(40); data.manifest.freeze_at = state === 'frozen' ? '2026-01-09T00:00:00Z' : null;
  for (const event of data.manifest.events) {
    const priorHistory = event.history;
    event.status = state; event.history = STATES.slice(0, rank + 1).map((status, i) => priorHistory[i]?.status === status ? priorHistory[i] : { status, at: '2026-01-0' + (4 + i) + 'T00:00:00Z', note: 'Synthetic lifecycle fixture.' });
    for (const row of data.references.find(ref => ref.event_id === event.id).claims) row.review_state = rank >= 3 ? 'final' : 'provisional';
    const fingerprint = prep.materialFingerprint(data, event.id);
    const ref = data.references.find(row => row.event_id === event.id);
    const subjects = [...event.reports.map(row => ['report',row.id]), ...ref.claims.map(row => ['claim',row.id]), ...ref.evidence.map(row => ['evidence',row.id]), ...ref.relations.map(row => ['relation',row.id]), ['summary',event.id]];
    for (const row of data.reviews.filter(row => row.event_id === event.id)) {
      row.state = rank >= 2 ? 'complete' : 'pending'; row.reference_fingerprint = rank >= 2 ? fingerprint : null;
      row.annotations = rank >= 2 ? subjects.map(([category,subject_id]) => ({ category,subject_id,decision:'agree',notes:'Synthetic review decision.' })) : [];
    }
    const adj = data.adjudications.find(row => row.event_id === event.id);
    adj.state = rank >= 3 ? 'resolved' : 'pending'; adj.reference_fingerprint = rank >= 3 ? fingerprint : null;
    for (const row of adj.disagreements) row.resolution = rank >= 3 ? 'resolved' : 'unresolved';
    event.freeze = rank === 4 ? { at: event.history.at(-1).at, corpus_version: data.manifest.corpus_version, annotation_version: data.manifest.annotation_version, event_fingerprint: prep.freezeFingerprint(data, event.id) } : null;
  }
  return data;
}
function finalBundle() {
  const original = fixture(), baseEvent = original.manifest.events[0], baseRef = original.references[0];
  const data = { manifest: { ...original.manifest, events: [] }, references: [], reviews: [], adjudications: [] };
  const slots = [['A',3,'development'],['A',3,'assessment'],['B',3,'assessment'],['B',3,'assessment'],['C',4,'development'],['C',4,'assessment'],['D',3,'assessment'],['E',2,'assessment'],['F',4,'assessment'],['G',3,'assessment']];
  slots.forEach(([scenario, count, split], i) => {
    const event = structuredClone(baseEvent), ref = structuredClone(baseRef), prefix = 'synthetic-' + i;
    event.id = prefix; event.scenario = scenario; event.split = split; event.reports = [];
    ref.event_id = prefix; ref.sources = [];
    for (let j = 0; j < count; j++) {
      const report = structuredClone(baseEvent.reports[0]); report.id = prefix + '-report-' + j; report.source_id = prefix + '-source-' + j;
      report.publisher.id = prefix + '-publisher-' + j; report.artifact_path = 'artifacts/8w-v1/reports/' + report.id + '.txt';
      event.reports.push(report); ref.sources.push({ report_id: report.id, text: baseRef.sources[0].text });
    }
    ref.claims[0].id = prefix + '-claim'; ref.claims[0].report_id = event.reports[0].id; ref.claims[0].equivalence_group = prefix + '-group';
    Object.assign(ref.evidence[0], { id: prefix + '-evidence', claim_id: ref.claims[0].id, report_id: event.reports[0].id }); ref.summary.required_groups = [ref.claims[0].equivalence_group];
    data.manifest.events.push(event); data.references.push(ref);
    for (const role of ['A','B']) data.reviews.push({ id: prefix + '-review-' + role, event_id: prefix, role, reviewer_id: 'synthetic-reviewer-' + role, state: 'pending', reference_fingerprint: null, annotations: [], notes: 'Invented test attestation.' });
    data.adjudications.push({ event_id: prefix, state: 'pending', adjudicator_id: 'synthetic-adjudicator', reference_fingerprint: null, disagreements: [], notes: 'Invented test adjudication.' });
  });
  return setState(data, 'frozen');
}

test('Git-safe synthetic templates validate as draft, never as evaluation success', () => {
  const data = fixture(), report = prep.validateCorpus(data);
  assert.equal(report.state, 'VALID_DRAFT'); assert.equal(report.reference_structure_valid, false); assert.equal(report.evaluation_performed, false); assert.equal(report.factual_truth_verified, false);
  assert.equal(Object.hasOwn(report, 'evaluation_success'), false); assert.deepEqual(report.counts, { events: 2, reports: 2 });
  assert.throws(() => prep.projectReferences(data, 'development'));
});
for (const [name, mutate] of [
  ['duplicate event', d => d.manifest.events.push(structuredClone(d.manifest.events[0]))],
  ['duplicate report', d => d.manifest.events[0].reports.push(structuredClone(d.manifest.events[0].reports[0]))],
  ['scenario', d => { d.manifest.events[0].scenario = 'H'; }],
  ['split', d => { d.manifest.events[0].split = 'production'; }],
  ['timestamp', d => { d.manifest.events[0].reports[0].published_at = '2026-02-30T00:00:00Z'; }],
  ['SHA-256', d => { d.manifest.events[0].reports[0].sha256 = 'invalid'; }],
  ['HTTPS URL', d => { d.manifest.events[0].reports[0].url = 'http://fixture.invalid/a'; }],
  ['URL credentials', d => { d.manifest.events[0].reports[0].url = 'https://dummy-user:dummy-password@fixture.invalid/a'; }],
  ['unsafe local path', d => { d.manifest.events[0].reports[0].artifact_path = '../.env'; }],
  ['Windows drive', d => { d.manifest.events[0].reports[0].artifact_path = 'C:/story.txt'; }],
  ['UNC', d => { d.manifest.events[0].reports[0].artifact_path = '\\\\server\\story.txt'; }],
  ['encoded traversal', d => { d.manifest.events[0].reports[0].artifact_path = 'artifacts/8w-v1/reports/%2e%2e/story.txt'; }],
  ['storage classification', d => { d.manifest.events[0].reports[0].storage.classification = 'public-by-default'; }],
  ['missing independence rationale', d => { d.manifest.events[0].reports[0].independence_rationale = ''; }],
  ['duplicate claim', d => d.references[0].claims.push(structuredClone(d.references[0].claims[0]))],
  ['inconsistent equivalence', d => d.references[0].claims.push({ ...d.references[0].claims[0], id: 'claim-copy', equivalence_group: 'wrong' })],
  ['orphan evidence', d => { d.references[0].evidence[0].claim_id = 'missing'; }],
  ['cross-report evidence', d => { d.references[0].evidence[0].report_id = 'template-report-assessment'; }],
  ['invalid offset', d => { d.references[0].evidence[0].end = 1000000; }],
  ['excerpt mismatch', d => { d.references[0].evidence[0].excerpt = 'Not in source.'; }],
  ['semantic relationship', d => { d.references[0].evidence[0].relationship = 'true'; }],
  ['source hash mismatch', d => { d.references[0].sources[0].text += ' Changed.'; }],
  ['invalid state', d => { d.manifest.events[0].status = 'verified'; }],
  ['skipped history transition', d => { d.manifest.events[0].history.push({ status: 'frozen', at: '2026-01-05T00:00:00Z', note: 'Skipped steps.' }); }],
  ['factual truth', d => { d.manifest.factual_truth_verified = true; }],
  ['unknown fields', d => { d.manifest.execute_provider = true; }],
  ['accessor', d => { Object.defineProperty(d.manifest, 'status', { enumerable: true, get() { throw new Error('Never execute'); } }); }]
]) test('authoring rejects ' + name, () => { const data = fixture(); mutate(data); assert.throws(() => prep.validateCorpus(data)); });

for (const [classification, confidence] of [['confirmed_independent','confirmed'], ['likely_independent','uncertain'], ['confirmed_shared_origin','confirmed'], ['syndicated','confirmed'], ['unknown','unknown']]) {
  test('independence mapping: ' + classification, () => {
    const data = fixture(); data.manifest.events[0].reports[0].independence = classification;
    const artifact = prep.projectReferences(setState(data, 'adjudicated'), 'development');
    assert.equal(prep.mapIndependence(classification), confidence); assert.equal(artifact.events[0].reports[0].independence_confidence, confidence);
    assert.equal(artifact.events[0].reports[0].origin_group, data.manifest.events[0].reports[0].origin_group);
  });
}
for (const [state, expected] of [['draft','VALID_DRAFT'], ['annotated','READY_FOR_REVIEW'], ['reviewed','AWAITING_ADJUDICATION'], ['adjudicated','READY_TO_FREEZE'], ['frozen','FROZEN_VALID']]) {
  test('lifecycle ' + state + ' has explicit preparation-only state', () => {
    const report = prep.validateCorpus(setState(fixture(), state)); assert.equal(report.state, expected); assert.equal(report.evaluation_performed, false);
  });
}
test('draft allows explicitly incomplete metadata but cannot be projected', () => {
  const data = fixture(); data.manifest.events[0].reports[0].sha256 = null; data.references[0].sources = [];
  assert.ok(prep.validateCorpus(data).pending.length > 0); assert.throws(() => prep.projectReferences(data, 'development'));
  assert.throws(() => prep.validateCorpus(setState(data, 'annotated')));
});
test('storage permission is an explicit attestation required before annotation completion', () => {
  const data = setState(fixture(), 'annotated'); data.manifest.events[0].reports[0].storage.approved = false; assert.throws(() => prep.validateCorpus(data));
});
test('incomplete second reviewer blocks reviewed/frozen state', () => {
  const data = setState(fixture(), 'frozen'); data.reviews[1].state = 'pending'; assert.throws(() => prep.validateCorpus(data));
});
test('same person cannot fill both independent reviewer roles', () => {
  const data = setState(fixture(), 'reviewed'); data.reviews[1].reviewer_id = data.reviews[0].reviewer_id; assert.throws(() => prep.validateCorpus(data));
});
test('stale review fingerprint blocks progress', () => {
  const data = setState(fixture(), 'reviewed'); data.references[0].summary.salience_notes += ' Edited.'; assert.throws(() => prep.validateCorpus(data));
});
test('unresolved required disagreement blocks frozen assessment', () => {
  const data = setState(fixture(), 'frozen'); data.adjudications[1].disagreements.push({ id: 'required-disagreement', subject_id:'template-assessment', category:'summary', required: true, resolution: 'unresolved', notes: 'Must resolve.' });
  assert.throws(() => prep.validateCorpus(data));
});
test('excluding a required disagreement is not resolution', () => {
  const data = setState(fixture(), 'frozen'); data.adjudications[0].disagreements[0].resolution = 'excluded'; assert.throws(() => prep.validateCorpus(data));
});
test('valid resolved adjudication projects real reviewer IDs without runs', () => {
  const data = setState(fixture(), 'adjudicated'), output = prep.projectReferences(data, 'assessment');
  assert.equal(validateReferenceArtifact(output), output); assert.deepEqual(output.events[0].review.reviewers, ['template-reviewer-a','template-reviewer-b']);
  assert.equal(output.events[0].review.adjudicator, 'template-adjudicator'); assert.equal(output.factual_truth_verified, false);
  for (const name of ['runs','scope','summaries','provider_output','evaluation_success']) assert.equal(Object.hasOwn(output, name), false);
  assert.throws(() => evaluateArtifact(output));
});
test('frozen content change without resealing fails', () => {
  const data = setState(fixture(), 'frozen'); data.references[1].summary.salience_notes += ' Changed.'; assert.throws(() => prep.validateCorpus(data));
});
test('frozen version inconsistency fails', () => {
  const data = setState(fixture(), 'frozen'); data.manifest.annotation_version = 'a2'; assert.throws(() => prep.validateCorpus(data));
});
test('draft-to-annotated transition preserves history', () => assert.equal(prep.validateTransition(fixture(), setState(fixture(), 'annotated')).transition_valid, true));
test('same-version lifecycle regression is rejected', () => assert.throws(() => prep.validateTransition(setState(fixture(), 'reviewed'), fixture())));
test('changed frozen assessment requires explicit new corpus AND annotation revision', () => {
  const previous = setState(fixture(), 'frozen'), next = structuredClone(previous); next.references[1].summary.salience_notes += ' Changed.'; setState(next, 'frozen');
  assert.throws(() => prep.validateTransition(previous, next));
  next.manifest.corpus_version = 'v2'; next.manifest.annotation_version = 'a2';
  next.manifest.revision = { previous_fingerprint: prep.validateCorpus(previous).fingerprint, previous_corpus_version: 'v1', previous_annotation_version: 'a1', at: '2026-01-10T00:00:00Z', note: 'Explicit synthetic revision.' };
  setState(next, 'draft'); assert.equal(prep.validateTransition(previous, next).transition_valid, true);
  next.manifest.annotation_version = 'a1'; assert.throws(() => prep.validateTransition(previous, next));
});

function relationFixture(type, classification, resolution = 'resolved') {
  const data = fixture(), ref = data.references[0]; ref.claims.push({ ...ref.claims[0], id: 'claim-second', proposition: 'A distinct fictional proposition.', equivalence_group: 'group-second' });
  if (type === 'equivalent') {
    ref.claims[1].proposition = 'On Monday, the fictional hall closed.';
    ref.claims[1].equivalence_group = ref.claims[0].equivalence_group;
  }
  ref.relations.push({ id: 'relation-example', claim_ids: [ref.claims[0].id, 'claim-second'], type, classification, required_disclosure: type === 'contradiction' || type === 'partial_disagreement', resolution, notes: 'Synthetic relationship example, not actual human annotation.' });
  return setState(data, 'adjudicated');
}
for (const [type, classification, kind, resolution] of [['contradiction','direct','conflict','resolved'], ['contradiction','temporal','conflict','resolved'], ['temporal_update','none','normal_update','resolved'], ['correction','none','correction','resolved'], ['equivalent','none','equivalent','resolved'], ['partial_disagreement','partial','conflict','resolved'], ['not_comparable',null,'ambiguous','excluded'], ['ambiguous',null,'ambiguous','excluded']]) {
  test('relationship projects ' + type + '/' + classification, () => {
    const output = prep.projectReferences(relationFixture(type, classification, resolution), 'development');
    assert.equal(output.events[0].relations[0].kind, kind); assert.equal(output.events[0].relations[0].classification, classification);
  });
}
test('normal update cannot be forced into direct contradiction', () => assert.throws(() => prep.validateCorpus(relationFixture('temporal_update', 'direct'))));
test('unresolved relation cannot be projected as adjudicated', () => assert.throws(() => prep.validateCorpus(relationFixture('contradiction','direct','provisional'))));
test('projection uses deterministic representative for equivalent summary groups', () => {
  const data = fixture(), ref = data.references[0]; ref.claims.push({ ...ref.claims[0], id: 'aaa-equivalent' });
  const output = prep.projectReferences(setState(data, 'adjudicated'), 'development'); assert.deepEqual(output.events[0].required_summary_facts, ['aaa-equivalent']);
});
test('projection preserves source text, hash and evidence without reading metadata paths', () => {
  const data = setState(fixture(), 'adjudicated'), output = prep.projectReferences(data, 'development');
  assert.equal(output.events[0].reports[0].text, data.references[0].sources[0].text); assert.equal(output.events[0].reports[0].artifact.sha256, data.manifest.events[0].reports[0].sha256);
  assert.deepEqual(output.events[0].evidence, data.references[0].evidence);
});
test('repeated validation/projection is deterministic and does not mutate authoring data', () => {
  const data = setState(fixture(), 'adjudicated'), before = structuredClone(data);
  assert.deepEqual(prep.projectReferences(data, 'development'), prep.projectReferences(data, 'development')); assert.deepEqual(data, before);
});
test('deterministic IDs preserve key-order equivalence without claiming semantic truth', () => {
  assert.equal(prep.deterministicId('report', { a: 1, b: 2 }), prep.deterministicId('report', { b: 2, a: 1 }));
  assert.notEqual(prep.deterministicId('report', { a: 1 }), prep.deterministicId('report', { a: 2 }));
});

test('exact synthetic 10-event/32-report finished composition passes', () => {
  const result = prep.validateFinalComposition(finalBundle()); assert.equal(result.composition_valid, true); assert.equal(result.assessment_frozen, true); assert.equal(result.evaluation_performed, false);
});
test('wrong development/assessment count fails final composition', () => {
  const data = finalBundle(); data.manifest.events[1].split = 'development'; setState(data, 'frozen'); assert.throws(() => prep.validateFinalComposition(data), { code: 'CORPUS_COMPOSITION_INVALID' });
});
test('missing family fails final composition', () => {
  const data = finalBundle(); data.manifest.events[9].scenario = 'F'; setState(data, 'frozen'); assert.throws(() => prep.validateFinalComposition(data), { code: 'CORPUS_COMPOSITION_INVALID' });
});
test('wrong family report allocation fails even when totals stay 10/32', () => {
  const data = finalBundle(), from = data.manifest.events[1], to = data.manifest.events[2];
  const moved = from.reports.pop(), fromRef = data.references.find(row => row.event_id === from.id), toRef = data.references.find(row => row.event_id === to.id);
  to.reports.push(moved); toRef.sources.push(fromRef.sources.pop()); setState(data, 'frozen');
  assert.throws(() => prep.validateFinalComposition(data), { code: 'CORPUS_COMPOSITION_INVALID' });
});
test('generic draft validation does not enforce final quotas', () => { assert.equal(prep.validateCorpus(fixture()).counts.events, 2); assert.throws(() => prep.validateFinalComposition(fixture())); });
test('provisional development is allowed only through explicit final-check option', () => {
  const data = finalBundle();
  for (const event of data.manifest.events.filter(row => row.split === 'development')) { event.status = 'draft'; event.history = event.history.slice(0, 1); event.freeze = null; }
  data.manifest.status = 'draft'; data.manifest.freeze_at = null;
  assert.throws(() => prep.validateFinalComposition(data), { code: 'CORPUS_NOT_FROZEN' });
  assert.equal(prep.validateFinalComposition(data, { allowProvisionalDevelopment: true }).provisional_development, true);
});
test('CLI reports valid draft, never evaluation passed; final check fails small template', () => {
  const rows = []; assert.equal(main(FILES, row => rows.push(row)), 0); assert.equal(rows[0].state, 'VALID_DRAFT'); assert.equal(rows[0].evaluation_performed, false);
  assert.equal(main([...FILES, '--final'], row => rows.push(row)), 1); assert.equal(rows[1].code, 'CORPUS_COMPOSITION_INVALID');
});
for (const args of [[], ['../.env'], [...FILES, '--execute'], [...FILES, '--previous'], [...FILES, '--allow-provisional-development']]) test('CLI rejects unsafe/malformed invocation ' + args.length, () => {
  const rows = []; assert.equal(main(args, row => rows.push(row)), 1); assert.equal(rows[0].state, 'REJECTED'); assert.ok(!JSON.stringify(rows).includes('C:\\'));
});
for (const value of ['../.env', '/tmp/a.json', 'C:/a.json', '\\\\server\\share.json', 'evaluation/corpora/8w-v1/../a.json', 'https://example.com/a.json', 'evaluation/corpora/8w-v1/%2e%2e/a.json']) test('CLI path rejects ' + value, () => assert.throws(() => approvedPath(value)));
test('CLI optional previous version validation uses only explicit approved files', () => { assert.equal(main([...FILES, '--previous', ...FILES], () => {}), 0); });
test('pure corpus boundary imports only crypto and the reviewed pure reference validator', () => {
  const target = require.resolve('../evaluation/corpusPreparation'), cached = require.cache[target], load = Module._load, data = fixture(); const seen = [];
  try {
    delete require.cache[target];
    Module._load = function (name, parent, mainFlag) { if (parent?.filename === target) { seen.push(name); assert.ok(['node:crypto','./realWorldQuality'].includes(name)); } return load.call(this, name, parent, mainFlag); };
    const pure = require(target); assert.equal(pure.validateCorpus(data).state, 'VALID_DRAFT'); assert.deepEqual(seen, ['node:crypto','./realWorldQuality']);
  } finally { Module._load = load; require.cache[target] = cached; }
});
test('projection performs no filesystem access, metadata fetching or default service initialization', () => {
  const data = setState(fixture(), 'adjudicated'), read = fs.readFileSync; let reads = 0;
  try { fs.readFileSync = () => { reads++; throw new Error('Forbidden file access'); }; assert.equal(prep.projectReferences(data, 'assessment').factual_truth_verified, false); assert.equal(reads, 0); }
  finally { fs.readFileSync = read; }
});
test('complete review must explicitly cover each required subject', () => {
  const data = setState(fixture(), 'reviewed'); data.reviews[1].annotations.pop(); assert.throws(() => prep.validateCorpus(data));
});
test('reviewer dissent cannot disappear into an empty adjudication', () => {
  const data = setState(fixture(), 'adjudicated'); data.reviews[2].annotations[0].decision = 'disagree';
  assert.throws(() => prep.validateCorpus(data));
  const annotation = data.reviews[2].annotations[0];
  data.adjudications[1].disagreements.push({ id: 'resolved-origin', subject_id: annotation.subject_id, category: annotation.category, required: true, resolution: 'resolved', notes: 'Explicit synthetic resolution of reviewer dissent.' });
  assert.equal(prep.validateCorpus(data).state, 'READY_TO_FREEZE');
});
test('frozen seal covers reviewer outcomes and adjudication notes', () => {
  const data = setState(fixture(), 'frozen'); data.adjudications[1].notes += ' Changed.'; assert.throws(() => prep.validateCorpus(data));
});
test('resealing changed frozen review records without a new revision does not pass transition check', () => {
  const previous = setState(fixture(), 'frozen'), next = structuredClone(previous);
  next.reviews[2].notes += ' Changed reviewer explanation.'; setState(next, 'frozen'); assert.throws(() => prep.validateTransition(previous, next));
});
test('source snapshot cannot precede its recorded collection', () => {
  const data = fixture(); data.manifest.events[0].reports[0].frozen_at = '2025-12-31T00:00:00Z'; assert.throws(() => prep.validateCorpus(data));
});
test('evaluator commit must be an actual string identifier', () => {
  const data = fixture(); data.manifest.evaluator_commit = 1234567; assert.throws(() => prep.validateCorpus(data));
});
test('full synthetic frozen split projection stays reference-only', () => {
  const output = prep.projectReferences(finalBundle(), 'assessment'); assert.equal(output.events.length, 8); validateReferenceArtifact(output);
  assert.equal(Object.hasOwn(output, 'runs'), false); assert.equal(output.factual_truth_verified, false);
});

for (const relationship of ['support', 'contradict', 'insufficient']) test('evidence consistency: agreeing ' + relationship + ' aliases project once', () => {
  const data = fixture(), ref = data.references[0]; ref.evidence[0].relationship = relationship;
  ref.evidence.push({ ...ref.evidence[0], id: 'aaa-evidence-alias' });
  setState(data, 'frozen'); const before = structuredClone(data);
  const output = prep.projectReferences(data, 'development');
  assert.equal(output.events[0].evidence.length, 1); assert.equal(output.events[0].evidence[0].id, 'aaa-evidence-alias');
  assert.equal(output.events[0].evidence[0].relationship, relationship); validateReferenceArtifact(output);
  assert.deepEqual(data, before); assert.equal(ref.evidence.length, 2);
  ref.evidence.reverse(); setState(data, 'frozen');
  assert.deepEqual(prep.projectReferences(data, 'development').events[0].evidence, output.events[0].evidence);
});
for (const [first, second] of [['support','contradict'], ['support','insufficient'], ['contradict','insufficient']]) {
  for (const aliasClaim of [false, true]) test('evidence consistency: reject ' + first + '/' + second + ', claim alias=' + aliasClaim, () => {
    const data = fixture(), ref = data.references[0]; ref.evidence[0].relationship = first;
    if (aliasClaim) ref.claims.push({ ...ref.claims[0], id: 'claim-alias' });
    ref.evidence.push({ ...ref.evidence[0], id: 'evidence-alias', claim_id: aliasClaim ? 'claim-alias' : ref.claims[0].id, relationship: second });
    assert.throws(() => prep.validateCorpus(data), { code: 'QUALITY_ARTIFACT_INVALID' });
    setState(data, 'frozen'); assert.throws(() => prep.projectReferences(data, 'development'), { code: 'QUALITY_ARTIFACT_INVALID' });
  });
}
test('evidence consistency: duplicate annotation IDs remain invalid', () => {
  const data = fixture(); data.references[0].evidence.push({ ...data.references[0].evidence[0] });
  assert.throws(() => prep.validateCorpus(data));
});
test('evidence consistency: distinct exact spans remain separate', () => {
  const data = fixture(), ref = data.references[0];
  ref.evidence.push({ ...ref.evidence[0], id: 'short-evidence', excerpt: 'fictional hall', start: 4, end: 18, relationship: 'insufficient' });
  const output = prep.projectReferences(setState(data, 'frozen'), 'development');
  assert.equal(output.events[0].evidence.length, 2);
});
test('evidence consistency: same span for unrelated claims is not collapsed', () => {
  const data = fixture(), ref = data.references[0];
  ref.claims.push({ ...ref.claims[0], id: 'claim-other', proposition: 'The hall stayed open.', equivalence_group: 'other-group' });
  ref.evidence.push({ ...ref.evidence[0], id: 'other-evidence', claim_id: 'claim-other', relationship: 'contradict' });
  const output = prep.projectReferences(setState(data, 'frozen'), 'development');
  assert.equal(output.events[0].evidence.length, 2);
});
test('evidence consistency: identical canonical claim aliases share one projected relationship', () => {
  const data = fixture(), ref = data.references[0]; ref.claims.push({ ...ref.claims[0], id: 'claim-alias' });
  ref.evidence.push({ ...ref.evidence[0], id: 'evidence-alias', claim_id: 'claim-alias' });
  const output = prep.projectReferences(setState(data, 'frozen'), 'development');
  assert.equal(output.events[0].evidence.length, 1); assert.equal(new Set(output.events[0].claims.map(row => row.equivalence_group)).size, 1);
});
test('group consistency: equivalent relation with different groups is rejected before projection', () => {
  const data = relationFixture('equivalent', 'none'); data.references[0].claims[1].equivalence_group = 'different-group';
  setState(data, 'draft'); assert.throws(() => prep.validateCorpus(data), { code: 'QUALITY_ARTIFACT_INVALID' });
});
for (const classification of ['direct', 'temporal']) for (const sameGroup of [false, true]) {
  test('group consistency: contradiction ' + classification + ', same group=' + sameGroup, () => {
    const data = relationFixture('contradiction', classification);
    if (sameGroup) data.references[0].claims[1].equivalence_group = data.references[0].claims[0].equivalence_group;
    setState(data, 'frozen');
    if (sameGroup) assert.throws(() => prep.validateCorpus(data), { code: 'QUALITY_ARTIFACT_INVALID' });
    else assert.equal(prep.validateCorpus(data).state, 'FROZEN_VALID');
  });
}
for (const [type, classification, resolution] of [['temporal_update','none','resolved'], ['correction','none','resolved'], ['partial_disagreement','partial','resolved'], ['not_comparable',null,'excluded']]) {
  test('group consistency: no automatic exact-conflict rule for ' + type, () => {
    const data = relationFixture(type, classification, resolution);
    data.references[0].claims[1].equivalence_group = data.references[0].claims[0].equivalence_group;
    assert.doesNotThrow(() => prep.projectReferences(setState(data, 'frozen'), 'development'));
  });
}
for (const type of ['temporal_update', 'correction']) test('group consistency: ' + type + ' keeps both directions distinct', () => {
  const data = relationFixture(type, 'none'), ref = data.references[0], pair = [...ref.relations[0].claim_ids];
  ref.relations.push({ ...ref.relations[0], id: 'reverse-relation', claim_ids: [...pair].reverse() });
  const rows = prep.projectReferences(setState(data, 'frozen'), 'development').events[0].relations;
  assert.deepEqual(rows.map(row => row.claim_ids), [pair, [...pair].reverse()]);
});
test('group consistency: explicit equivalence projects one proposition target without inventing relations', () => {
  const data = relationFixture('equivalent', 'none'), ref = data.references[0];
  const event = prep.projectReferences(data, 'development').events[0];
  assert.equal(event.claims.length, 2); assert.equal(new Set(event.claims.map(row => row.equivalence_group)).size, 1);
  assert.equal(event.required_summary_facts.length, 1); assert.equal(event.relations.length, 1);
  ref.relations = []; setState(data, 'frozen');
  assert.equal(prep.projectReferences(data, 'development').events[0].relations.length, 0);
});
