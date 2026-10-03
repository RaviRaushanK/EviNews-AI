/**
 * Phase 4 pure validation tests (no database, no Gemini, no network).
 * Exercises utils/claimValidation.js and claimExtractionService.parseModelJson().
 *
 * Usage: node scripts/test-claim-validation.js
 */

const { validateClaimsPayload, normalizeClaimText, buildClaimKey } = require('../utils/claimValidation');
const { parseModelJson } = require('../services/claimExtractionService');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('PASS ' + name);
  } else {
    failed += 1;
    console.log('FAIL ' + name + (detail ? ' -> ' + detail : ''));
  }
}

// 1. valid claim
{
  const result = validateClaimsPayload({
    claims: [{ claim_text: 'The Bank of England raised interest rates to 4.25%.', claim_type: 'data', confidence: 0.85, evidence_quote: 'raised interest rates' }]
  }, { maxClaims: 10 });
  check('valid claim accepted', result.ok && result.accepted.length === 1 && result.rejected.length === 0, JSON.stringify(result));
  check('valid claim type preserved', result.accepted[0] && result.accepted[0].claim_type === 'data');
  check('valid claim confidence preserved', result.accepted[0] && result.accepted[0].confidence === 0.85);
}

// 2. fenced JSON parsing
{
  const fenced = '```json\n{"claims":[{"claim_text":"Artemis II reached the launch pad.","claim_type":"fact","confidence":0.7,"evidence_quote":"reached the launch pad"}]}\n```';
  const parsed = parseModelJson(fenced);
  check('fenced JSON parsed', parsed && Array.isArray(parsed.claims) && parsed.claims.length === 1);
}

// 2b. plain fenced (no language tag)
{
  const parsed = parseModelJson('```\n{"claims":[]}\n```');
  check('plain fenced JSON parsed', parsed && Array.isArray(parsed.claims) && parsed.claims.length === 0);
}

// 3. malformed JSON
{
  let code = null;
  try {
    parseModelJson('{"claims":[{"claim_text":"broken"');
  } catch (error) {
    code = error.code;
  }
  check('malformed JSON throws GEMINI_PARSE_ERROR', code === 'GEMINI_PARSE_ERROR', 'code=' + code);
}

// 4. invalid claim type
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'Something was rumoured to happen here.', claim_type: 'rumour' }] }, { maxClaims: 10 });
  check('invalid claim type rejected', result.ok && result.accepted.length === 0 && result.rejected.length === 1, JSON.stringify(result));
}

// 4b. absent claim type defaults to fact
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'A default typed claim is stored here.' }] }, { maxClaims: 10 });
  check('absent claim type defaults to fact', result.accepted[0] && result.accepted[0].claim_type === 'fact');
}

// 5. confidence 1.5
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'A claim with an out of range score.', confidence: 1.5 }] }, { maxClaims: 10 });
  check('confidence 1.5 rejected', result.accepted.length === 0 && result.rejected.length === 1, JSON.stringify(result));
}

// 6. confidence -0.2
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'A claim with a negative score value.', confidence: -0.2 }] }, { maxClaims: 10 });
  check('confidence -0.2 rejected', result.accepted.length === 0 && result.rejected.length === 1, JSON.stringify(result));
}

// 7. confidence "high"
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'A claim with a string confidence.', confidence: 'high' }] }, { maxClaims: 10 });
  check('confidence "high" rejected', result.accepted.length === 0 && result.rejected.length === 1, JSON.stringify(result));
}

// 8. confidence 0.4 accepted
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'A claim with a valid low score.', confidence: 0.4 }] }, { maxClaims: 10 });
  check('confidence 0.4 accepted', result.accepted.length === 1 && result.accepted[0].confidence === 0.4, JSON.stringify(result));
}

// 8b. confidence absent => null
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'A claim with no confidence field.' }] }, { maxClaims: 10 });
  check('absent confidence becomes null', result.accepted[0] && result.accepted[0].confidence === null);
}

// 9. empty claim
{
  const result = validateClaimsPayload({ claims: [{ claim_text: '', claim_type: 'fact' }] }, { maxClaims: 10 });
  check('empty claim text rejected', result.accepted.length === 0 && result.rejected.length === 1, JSON.stringify(result));
}

// 10. too-short claim
{
  const result = validateClaimsPayload({ claims: [{ claim_text: 'Too short', claim_type: 'fact' }] }, { maxClaims: 10 });
  check('too-short claim text rejected', result.accepted.length === 0 && result.rejected.length === 1, JSON.stringify(result));
}

// 11. claims: []
{
  const result = validateClaimsPayload({ claims: [] }, { maxClaims: 10 });
  check('empty claims array is valid', result.ok && result.accepted.length === 0 && result.rejected.length === 0);
}

// 12. excessive number of claims
{
  const many = [];
  for (let i = 0; i < 15; i += 1) {
    many.push({ claim_text: `Repeated extracted claim number ${i} about the event.`, claim_type: 'fact', confidence: 0.5 });
  }
  const result = validateClaimsPayload({ claims: many }, { maxClaims: 10 });
  check('excessive claims capped at maxClaims', result.accepted.length === 10 && result.rejected.length === 1, JSON.stringify({ accepted: result.accepted.length, rejected: result.rejected.length }));
}

// 13. payload shape guards
{
  const bad1 = validateClaimsPayload(null, { maxClaims: 10 });
  const bad2 = validateClaimsPayload({ claims: 'nope' }, { maxClaims: 10 });
  check('null payload rejected', bad1.ok === false);
  check('non-array claims rejected', bad2.ok === false);
}

// 14. helpers
{
  check('claim text normalization collapses whitespace', normalizeClaimText('  A   claim\n with  spaces ') === 'A claim with spaces');
  check('claim key is case/whitespace insensitive', buildClaimKey('a1', 'Rates  ROSE') === buildClaimKey('a1', 'rates rose'));
}

// 15. evidence mapping (pure — no DB, no API)
{
  const { resolveEvidence, verifyModelQuote, findDeterministicEvidence, buildArticleSourceText } = require('../services/evidenceMappingService');

  const article = {
    title: 'Delhi building collapse kills five',
    description: 'Rescue teams searched the collapsed building through the night.',
    content: 'Five people died after a building collapsed in Delhi on Monday. Officials said rescue teams searched the rubble through the night and recovered two more bodies. The collapse was blamed on illegal construction work.'
  };
  const fullText = buildArticleSourceText(article);

  // verbatim quote => llm_verified
  const verified = resolveEvidence(article, {
    claim_text: 'Five people died when a building collapsed in Delhi.',
    evidence_quote: 'Five people died after a building collapsed in Delhi on Monday.'
  });
  check('verbatim quote verified as llm_verified', verified.hasEvidence && verified.method === 'llm_verified', JSON.stringify(verified).slice(0, 200));

  // fabricated quote => must NOT be accepted verbatim; falls back to a real article sentence
  const fabricated = resolveEvidence(article, {
    claim_text: 'Officials recovered two more bodies from the rubble during the search.',
    evidence_quote: 'This sentence was invented by the model and appears nowhere in the article.'
  });
  check('fabricated quote not accepted as llm_verified', fabricated.method !== 'llm_verified', 'method=' + fabricated.method);
  check('fabricated quote falls back to deterministic_match', fabricated.hasEvidence && fabricated.method === 'deterministic_match', 'method=' + fabricated.method + ' overlap=' + fabricated.overlap);
  check('fallback evidence text occurs in the article',
    fabricated.hasEvidence && fullText.toLowerCase().includes(String(fabricated.text).toLowerCase()),
    'text=' + fabricated.text);

  // no support at all => no evidence, and nothing invented
  const unsupported = resolveEvidence(article, {
    claim_text: 'Quantum computing stocks doubled in value overnight worldwide.',
    evidence_quote: ''
  });
  check('unsupported claim yields no evidence row', unsupported.hasEvidence === false, JSON.stringify(unsupported).slice(0, 200));

  // quote too short => not verified
  check('short quote rejected', verifyModelQuote(fullText, 'Five people').ok === false);

  // deterministic matcher respects the overlap floor
  const tooHigh = findDeterministicEvidence(fullText, 'Completely unrelated topic about bicycle repairs', 0.99);
  check('overlap floor enforced', tooHigh.ok === false);
}

// 16. provider guards (no network: no model configured => fail before any call)
{
  const geminiClientService = require('../services/geminiClientService');
  let modelCode = null;
  try {
    geminiClientService.resolveClaimModel();
  } catch (error) {
    modelCode = error.code;
  }
  check('missing GEMINI_CLAIM_MODEL fails with CLAIM_MODEL_NOT_CONFIGURED', modelCode === null || modelCode === 'CLAIM_MODEL_NOT_CONFIGURED', 'code=' + modelCode);
}

console.log('---');
console.log('TESTS_PASSED=' + passed);
console.log('TESTS_FAILED=' + failed);
if (failed > 0) {
  process.exitCode = 1;
}