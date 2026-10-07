/**
 * Isolated Phase 5 contradiction evaluation.
 * Reads fixture data, optionally calls Gemini, validates responses, and prints metrics.
 * It does not import models or any persistence repository.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const contradictionsConfig = require('../config/contradictions');
const {
  SUPPORTED_CLASSIFICATIONS,
  canonicalizeClaimPair,
  buildEvaluationFingerprint
} = require('../utils/contradictionValidation');
const {
  generateCandidatePairs,
  resolveContradictionModel
} = require('../services/contradictionCandidateService');
const {
  buildContradictionPrompt,
  parseAndValidateResponse
} = require('../services/contradictionDetectionService');
const geminiClientService = require('../services/geminiClientService');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'contradiction-evaluation.json');
const CLASSES = ['direct', 'partial', 'temporal', 'none'];
const REQUIRED_CLAIM_FIELDS = [
  'id', 'article_id', 'claim_text', 'claim_type', 'evidence_text',
  'article_title', 'source_name', 'published_at'
];

function evaluationError(message) {
  const error = new Error(message);
  error.code = 'EVALUATION_FIXTURE_ERROR';
  return error;
}

function loadAndValidateFixture() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  if (!fixture || typeof fixture !== 'object' || !Array.isArray(fixture.cases)) {
    throw evaluationError('fixture must contain a cases array');
  }
  if (fixture.cases.length < 24 || fixture.cases.length > 32) {
    throw evaluationError('fixture must contain between 24 and 32 cases');
  }

  const caseIds = new Set();
  const claimIds = new Set();
  let sameArticleCases = 0;
  for (const item of fixture.cases) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
      throw evaluationError('every case must have a stable non-empty id');
    }
    if (caseIds.has(item.id)) {
      throw evaluationError(`duplicate case id: ${item.id}`);
    }
    caseIds.add(item.id);
    if (!item.expected || !SUPPORTED_CLASSIFICATIONS.includes(item.expected.classification)) {
      throw evaluationError(`case ${item.id} has an invalid expected classification`);
    }
    if (typeof item.expected.candidate_expected !== 'boolean') {
      throw evaluationError(`case ${item.id} must define expected.candidate_expected`);
    }

    for (const side of ['claim_a', 'claim_b']) {
      const claim = item[side];
      if (!claim || typeof claim !== 'object') {
        throw evaluationError(`case ${item.id} is missing ${side}`);
      }
      for (const field of REQUIRED_CLAIM_FIELDS) {
        if (typeof claim[field] !== 'string' || !claim[field].trim()) {
          throw evaluationError(`case ${item.id} ${side}.${field} is required`);
        }
      }
      if (claimIds.has(claim.id)) {
        throw evaluationError(`duplicate claim id: ${claim.id}`);
      }
      claimIds.add(claim.id);
      if (!claim.id.startsWith('eval-') || !claim.article_id.startsWith('eval-')) {
        throw evaluationError(`case ${item.id} must use isolated evaluation IDs`);
      }
      if (Number.isNaN(new Date(claim.published_at).getTime())) {
        throw evaluationError(`case ${item.id} ${side}.published_at is invalid`);
      }
    }

    if (item.claim_a.article_id === item.claim_b.article_id) {
      sameArticleCases += 1;
      if (item.expected.candidate_expected !== false) {
        throw evaluationError(`same-article case ${item.id} must set candidate_expected=false`);
      }
    }
  }
  if (sameArticleCases === 0) {
    throw evaluationError('fixture must include at least one same-article case');
  }
  return fixture;
}

function fixtureClaim(claim) {
  return {
    id: claim.id,
    article_id: claim.article_id,
    event_id: null,
    claim_text: claim.claim_text,
    claim_type: claim.claim_type,
    evidence: [claim.evidence_text],
    article: {
      id: claim.article_id,
      title: claim.article_title,
      source: { id: `eval-source-${claim.id}`, name: claim.source_name },
      published_at: claim.published_at
    }
  };
}

function evaluationCandidate(item, model) {
  const first = fixtureClaim(item.claim_a);
  const second = fixtureClaim(item.claim_b);
  const pair = canonicalizeClaimPair(first.id, second.id);
  const byId = new Map([[first.id, first], [second.id, second]]);
  const claim1 = byId.get(pair.claim_id_1);
  const claim2 = byId.get(pair.claim_id_2);
  const fingerprintClaim = (claim) => ({
    id: claim.id,
    text: claim.claim_text,
    type: claim.claim_type,
    evidence: claim.evidence,
    published_at: claim.article.published_at,
    reference_date: null
  });
  return {
    claim_id_1: pair.claim_id_1,
    claim_id_2: pair.claim_id_2,
    claim_1: claim1,
    claim_2: claim2,
    input_fingerprint: buildEvaluationFingerprint({
      claim_1: fingerprintClaim(claim1),
      claim_2: fingerprintClaim(claim2),
      model,
      prompt_version: contradictionsConfig.detection.promptVersion
    })
  };
}

function evaluateCandidates(cases, modelForFingerprint) {
  const outcomes = [];
  for (const item of cases) {
    const result = generateCandidatePairs(
      [fixtureClaim(item.claim_a), fixtureClaim(item.claim_b)],
      {
        model: modelForFingerprint,
        promptVersion: contradictionsConfig.detection.promptVersion
      }
    );
    outcomes.push({
      id: item.id,
      expected: item.expected.candidate_expected,
      generated: result.generated.length === 1
    });
  }

  const expectedPositive = outcomes.filter((item) => item.expected).length;
  const expectedReached = outcomes.filter((item) => item.expected && item.generated).length;
  const generatedTotal = outcomes.filter((item) => item.generated).length;
  const falseNegatives = outcomes.filter((item) => item.expected && !item.generated).map((item) => item.id);
  const negativeCorrectlyFiltered = outcomes.filter((item) => !item.expected && !item.generated).length;
  return {
    outcomes,
    candidate_expected_positive: expectedPositive,
    candidate_generated_positive: expectedReached,
    candidate_generated_total: generatedTotal,
    candidate_false_negatives: falseNegatives,
    candidate_recall: expectedPositive === 0 ? 0 : expectedReached / expectedPositive,
    candidate_negative_correctly_filtered: negativeCorrectlyFiltered
  };
}

function emptyConfusionMatrix() {
  return Object.fromEntries(CLASSES.map((expected) => [
    expected,
    Object.fromEntries(CLASSES.map((predicted) => [predicted, 0]))
  ]));
}

function safeRatio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function calculateClassifierMetrics(cases, results) {
  const expectedCases = cases.filter((item) => item.expected.candidate_expected);
  const successful = results.filter((item) => item.status === 'classified');
  const errors = results.filter((item) => item.status === 'error');
  const matrix = emptyConfusionMatrix();
  let correct = 0;
  for (const result of successful) {
    matrix[result.expected][result.predicted] += 1;
    if (result.expected === result.predicted) {
      correct += 1;
    }
  }

  const perClass = {};
  for (const classification of CLASSES) {
    const truePositive = matrix[classification][classification];
    const predictedCount = CLASSES.reduce((sum, expected) => sum + matrix[expected][classification], 0);
    const expectedCount = expectedCases.filter(
      (item) => item.expected.classification === classification
    ).length;
    const precision = safeRatio(truePositive, predictedCount);
    const recall = safeRatio(truePositive, expectedCount);
    perClass[classification] = {
      precision,
      recall,
      f1: safeRatio(2 * precision * recall, precision + recall)
    };
  }

  const macro = {
    precision: CLASSES.reduce((sum, item) => sum + perClass[item].precision, 0) / CLASSES.length,
    recall: CLASSES.reduce((sum, item) => sum + perClass[item].recall, 0) / CLASSES.length,
    f1: CLASSES.reduce((sum, item) => sum + perClass[item].f1, 0) / CLASSES.length
  };
  const normalUpdateCases = expectedCases.filter((item) => item.normal_update === true);
  const normalUpdateIds = new Set(normalUpdateCases.map((item) => item.id));
  const normalUpdateFalsePositives = successful.filter((item) =>
    normalUpdateIds.has(item.id) && item.predicted !== 'none').length;
  const expectedNone = expectedCases.filter((item) => item.expected.classification === 'none');
  const expectedNoneIds = new Set(expectedNone.map((item) => item.id));
  const noneFalsePositives = successful.filter((item) =>
    expectedNoneIds.has(item.id) && item.predicted !== 'none').length;

  return {
    classified_cases: expectedCases.length,
    successful_classifications: successful.length,
    classification_errors: errors.length,
    correct_classifications: correct,
    incorrect_classifications: successful.length - correct,
    accuracy: safeRatio(correct, successful.length),
    error_rate: safeRatio(errors.length, expectedCases.length),
    per_class: perClass,
    macro,
    confusion_matrix: matrix,
    normal_update_cases: normalUpdateCases.length,
    normal_update_false_positives: normalUpdateFalsePositives,
    normal_update_false_positive_rate: safeRatio(
      normalUpdateFalsePositives,
      normalUpdateCases.length
    ),
    none_cases: expectedNone.length,
    none_false_positives: noneFalsePositives,
    none_false_positive_rate: safeRatio(noneFalsePositives, expectedNone.length),
    errors
  };
}

function categoryDistribution(cases) {
  const distribution = {};
  for (const item of cases) {
    distribution[item.category] = (distribution[item.category] || 0) + 1;
  }
  return distribution;
}

async function run() {
  const fixture = loadAndValidateFixture();
  const cases = [...fixture.cases].sort((first, second) => first.id.localeCompare(second.id));
  const configuredModel = contradictionsConfig.gemini.contradictionModel;
  const candidateMetrics = evaluateCandidates(
    cases,
    configuredModel || 'candidate-evaluation-only-no-provider-model'
  );

  console.log('CONTRADICTION_EVALUATION_VERSION=' + fixture.version);
  console.log('TOTAL_CASES=' + cases.length);
  console.log('CATEGORY_DISTRIBUTION=' + JSON.stringify(categoryDistribution(cases)));
  console.log('CANDIDATE_METRICS=' + JSON.stringify(candidateMetrics));

  let model;
  try {
    model = resolveContradictionModel(configuredModel);
  } catch (error) {
    console.error('EVALUATION_BLOCKED=GEMINI_CONTRADICTION_MODEL_NOT_CONFIGURED');
    console.error('EVALUATION BLOCKED — GEMINI PROVIDER UNAVAILABLE');
    process.exitCode = 1;
    return;
  }

  const loadedPaths = Object.keys(require.cache).map((item) => item.replace(/\\/g, '/'));
  if (loadedPaths.some((item) => item.endsWith('/models/index.js'))) {
    throw evaluationError('production model registry must not be loaded by evaluation');
  }

  console.log('MODEL=' + model);
  console.log('CLASSIFIER_RESULTS_ARE_LIVE_MODEL_OUTPUT=true');
  const results = [];
  let providerBlocked = false;

  for (const item of cases.filter((entry) => entry.expected.candidate_expected)) {
    const candidate = evaluationCandidate(item, model);
    const eventId = `eval-event-${item.id}`;
    const eventContext = {
      title: `Evaluation case ${item.id}`,
      description: `Isolated ${item.category} evaluation fixture`,
      event_date: null
    };
    try {
      const prompt = buildContradictionPrompt(eventId, eventContext, candidate);
      const generated = await geminiClientService.generateText(prompt, { model });
      const validated = parseAndValidateResponse(generated.text);
      const result = {
        id: item.id,
        expected: item.expected.classification,
        predicted: validated.classification,
        confidence: validated.confidence,
        status: 'classified'
      };
      results.push(result);
      console.log('CASE_RESULT=' + JSON.stringify(result));
    } catch (error) {
      const result = {
        id: item.id,
        expected: item.expected.classification,
        predicted: null,
        status: 'error',
        error_category: error && error.code ? error.code : 'EVALUATION_ERROR'
      };
      results.push(result);
      console.error('CASE_RESULT=' + JSON.stringify(result));
      if (String(result.error_category).startsWith('GEMINI_')) {
        providerBlocked = true;
        break;
      }
    }
  }

  const classifierMetrics = calculateClassifierMetrics(cases, results);
  const qualityGate = !providerBlocked && classifierMetrics.classification_errors === 0 &&
    candidateMetrics.candidate_recall >= 0.90 &&
    classifierMetrics.accuracy >= 0.80 &&
    classifierMetrics.none_false_positive_rate <= 0.10 &&
    classifierMetrics.normal_update_false_positive_rate <= 0.10;

  console.log('CLASSIFIER_METRICS=' + JSON.stringify(classifierMetrics));
  console.log('QUALITY_GATE_PASSED=' + qualityGate);
  console.log('PRODUCTION_DB_WRITES=0');

  if (providerBlocked) {
    console.error('EVALUATION BLOCKED — GEMINI PROVIDER UNAVAILABLE');
  }
  if (classifierMetrics.classification_errors > 0 || providerBlocked) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`EVALUATION_FATAL=${error.code || error.name}: ${error.message}`);
  process.exitCode = 1;
});
