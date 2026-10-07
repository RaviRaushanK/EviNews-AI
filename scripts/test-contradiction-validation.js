/**
 * Phase 5 pure contradiction validation tests.
 * No database, Gemini, network, or filesystem access.
 */

const assert = require('assert/strict');
const {
  SUPPORTED_CLASSIFICATIONS,
  normalizeText,
  canonicalizeClaimPair,
  validateClassification,
  validateReason,
  validateConfidence,
  validateBooleanField,
  validateContradictionResponse,
  buildEvaluationFingerprint
} = require('../utils/contradictionValidation');

let passed = 0;
let failed = 0;

function test(name, callback) {
  try {
    callback();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    console.log('FAIL ' + name + ' -> ' + error.message);
  }
}

function fingerprintInput(overrides = {}) {
  return {
    claim_1: {
      id: 'b',
      text: 'The service was suspended.',
      type: 'fact',
      evidence: ['The service was suspended on Monday.'],
      published_at: '2026-10-01T10:00:00Z',
      reference_date: '2026-10-01'
    },
    claim_2: {
      id: 'a',
      text: 'The service remained available.',
      type: 'fact',
      evidence: ['Officials said the service remained available.'],
      published_at: '2026-10-01T11:00:00Z',
      reference_date: '2026-10-01'
    },
    prompt_version: 'phase5-v1',
    model: 'test-model',
    ...overrides
  };
}

test('canonical ordering', () => {
  assert.deepEqual(canonicalizeClaimPair('a', 'b'), { claim_id_1: 'a', claim_id_2: 'b' });
});

test('reversed pair produces same canonical pair', () => {
  assert.deepEqual(canonicalizeClaimPair('b', 'a'), canonicalizeClaimPair('a', 'b'));
});

test('identical claim IDs rejected', () => {
  assert.throws(() => canonicalizeClaimPair('a', 'a'));
});

test('missing claim IDs rejected', () => {
  assert.throws(() => canonicalizeClaimPair('', 'b'));
  assert.throws(() => canonicalizeClaimPair('a', null));
});

test('valid classifications accepted', () => {
  for (const value of SUPPORTED_CLASSIFICATIONS) {
    assert.equal(validateClassification(value), value);
  }
});

test('invalid classification rejected', () => {
  assert.throws(() => validateClassification('DIRECT'));
  assert.throws(() => validateClassification('unknown'));
  assert.throws(() => validateClassification(null));
});

test('valid reason accepted and normalized', () => {
  assert.equal(validateReason('  Material   quantities differ. '), 'Material quantities differ.');
});

test('empty reason rejected', () => {
  assert.throws(() => validateReason('  '));
});

test('confidence zero accepted', () => assert.equal(validateConfidence(0), 0));
test('confidence one accepted', () => assert.equal(validateConfidence(1), 1));
test('confidence below zero rejected', () => assert.throws(() => validateConfidence(-0.01)));
test('confidence above one rejected', () => assert.throws(() => validateConfidence(1.01)));

test('NaN and infinite confidence rejected', () => {
  assert.throws(() => validateConfidence(Number.NaN));
  assert.throws(() => validateConfidence(Infinity));
  assert.throws(() => validateConfidence(-Infinity));
});

test('absent confidence accepted as null', () => {
  assert.equal(validateConfidence(undefined), null);
  assert.equal(validateConfidence(null), null);
});

test('valid booleans accepted', () => {
  assert.equal(validateBooleanField(true, 'flag'), true);
  assert.equal(validateBooleanField(false, 'flag'), false);
});

test('string booleans rejected', () => {
  assert.throws(() => validateBooleanField('true', 'flag'));
  assert.throws(() => validateBooleanField('false', 'flag'));
});

const validResponse = {
  classification: 'direct',
  reason: 'The claims assert incompatible service states at the same time.',
  same_subject: true,
  same_reference_time: true,
  normal_update: false,
  confidence: 0.91
};

test('valid complete response accepted', () => {
  assert.deepEqual(validateContradictionResponse(validResponse), validResponse);
});

test('malformed response rejected', () => {
  assert.throws(() => validateContradictionResponse(null));
  assert.throws(() => validateContradictionResponse([]));
  assert.throws(() => validateContradictionResponse({ ...validResponse, same_subject: 'true' }));
  assert.throws(() => validateContradictionResponse({ ...validResponse, unexpected: true }));
});

test('none response accepted without becoming another classification', () => {
  const result = validateContradictionResponse({
    ...validResponse,
    classification: 'none',
    normal_update: true,
    confidence: undefined
  });
  assert.equal(result.classification, 'none');
  assert.equal(result.confidence, null);
});

test('deterministic text normalization', () => {
  assert.equal(normalizeText('  Meaningful\n text\t remains.  '), 'Meaningful text remains.');
  assert.equal(normalizeText('Meaningful text remains.'), 'Meaningful text remains.');
});

test('fingerprint is deterministic across property and evidence order', () => {
  const input = fingerprintInput();
  const reordered = {
    model: input.model,
    prompt_version: input.prompt_version,
    claim_2: { ...input.claim_2, evidence: [...input.claim_2.evidence].reverse() },
    claim_1: { ...input.claim_1, evidence: [...input.claim_1.evidence].reverse() }
  };
  assert.equal(buildEvaluationFingerprint(input), buildEvaluationFingerprint(reordered));
});

test('reversed claim input produces same fingerprint', () => {
  const input = fingerprintInput();
  assert.equal(
    buildEvaluationFingerprint(input),
    buildEvaluationFingerprint({ ...input, claim_1: input.claim_2, claim_2: input.claim_1 })
  );
});

test('changing claim text changes fingerprint', () => {
  const input = fingerprintInput();
  const changed = fingerprintInput({ claim_1: { ...input.claim_1, text: 'The service resumed.' } });
  assert.notEqual(buildEvaluationFingerprint(input), buildEvaluationFingerprint(changed));
});

test('changing evidence changes fingerprint', () => {
  const input = fingerprintInput();
  const changed = fingerprintInput({ claim_1: { ...input.claim_1, evidence: ['Different evidence.'] } });
  assert.notEqual(buildEvaluationFingerprint(input), buildEvaluationFingerprint(changed));
});

test('changing model or prompt version changes fingerprint', () => {
  const input = fingerprintInput();
  assert.notEqual(
    buildEvaluationFingerprint(input),
    buildEvaluationFingerprint(fingerprintInput({ model: 'other-model' }))
  );
  assert.notEqual(
    buildEvaluationFingerprint(input),
    buildEvaluationFingerprint(fingerprintInput({ prompt_version: 'phase5-v2' }))
  );
});

console.log('---');
console.log('TESTS_PASSED=' + passed);
console.log('TESTS_FAILED=' + failed);
if (failed > 0) {
  process.exitCode = 1;
}
