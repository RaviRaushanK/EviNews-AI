/**
 * Contradiction detection configuration (Phase 5).
 * The model has no fallback; live detection must require explicit configuration.
 */

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SUPPORTED_CLASSIFICATIONS = Object.freeze([
  'direct',
  'partial',
  'temporal',
  'none'
]);

module.exports = {
  gemini: {
    contradictionModel: process.env.GEMINI_CONTRADICTION_MODEL || ''
  },
  detection: {
    promptVersion: process.env.CONTRADICTION_PROMPT_VERSION || 'phase5-v1',
    maxCandidatesPerRun: parsePositiveInt(process.env.CONTRADICTION_MAX_CANDIDATES, 50)
  },
  query: {
    defaultLimit: 50,
    maxLimit: 200
  },
  validation: {
    supportedClassifications: SUPPORTED_CLASSIFICATIONS,
    confidenceMin: 0,
    confidenceMax: 1,
    maxReasonChars: 2000
  }
};
