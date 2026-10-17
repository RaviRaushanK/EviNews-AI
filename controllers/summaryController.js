const { validateId } = require('../services/contradictionQueryService');
const summaryQuery = require('../services/summaryQueryService');
const summaryWorkflow = require('../services/summaryWorkflowService');

const PUBLIC_ERRORS = Object.freeze({
  INVALID_EVENT_ID: [400, 'eventId must be a valid UUID.'],
  MISSING_EVENT_ID: [400, 'eventId is required.'],
  INVALID_SUMMARY_ID: [400, 'summaryId must be a valid UUID.'],
  MISSING_SUMMARY_ID: [400, 'summaryId is required.'],
  EVENT_NOT_FOUND: [404, 'Event not found.'],
  SUMMARY_EVENT_NOT_FOUND: [404, 'Event not found.'],
  SUMMARY_NOT_FOUND: [404, 'Summary not found for this event.'],
  SUMMARY_INVALID_REQUEST: [400, 'This endpoint accepts no request fields.'],
  SUMMARY_INSUFFICIENT_GROUNDING: [422, 'Insufficient information to generate an evidence-grounded summary.'],
  SUMMARY_NEEDS_REVIEW: [422, 'Generated text needs review and was not saved.'],
  SUMMARY_MODEL_NOT_CONFIGURED: [503, 'Summary model is not configured.'],
  GEMINI_KEY_MISSING: [503, 'Summary provider is not configured.'],
  GEMINI_RATE_LIMIT: [503, 'Summary provider rate limit reached.'],
  GEMINI_SERVER: [503, 'Summary provider is unavailable.'],
  GEMINI_TIMEOUT: [504, 'Summary provider timed out.'],
  GEMINI_ERROR: [502, 'Summary provider request failed.'],
  GEMINI_EMPTY_RESPONSE: [502, 'Summary provider returned an empty response.'],
  GEMINI_AUTH: [502, 'Summary provider authentication failed.'],
  GEMINI_BAD_REQUEST: [502, 'Summary provider rejected the request.'],
  SUMMARY_INVALID_JSON: [502, 'Summary provider did not return strict JSON.'],
  SUMMARY_INVALID_OUTPUT: [502, 'Summary provider output failed validation.'],
  SUMMARY_CONTEXT_INVALID: [422, 'Summary context failed integrity checks.'],
  SUMMARY_CROSS_EVENT_CLAIM: [422, 'Summary references a claim outside the event.'],
  SUMMARY_INVALID_PERSISTENCE_INPUT: [422, 'Generated summary failed persistence validation.'],
  SUMMARY_PROVIDER_NOT_SUPPORTED: [503, 'Summary provider is not supported.'],
  SUMMARY_PERSISTENCE_FAILED: [500, 'Summary could not be saved.']
});

function publicSummaryError(error) {
  const code = error?.code;
  const known = Object.hasOwn(PUBLIC_ERRORS, code);
  return {
    status: known ? PUBLIC_ERRORS[code][0] : 500,
    error: { code: known ? code : 'SUMMARY_ERROR', message: known ? PUBLIC_ERRORS[code][1] : 'Unable to complete the summary request.' }
  };
}

function generationError(result) {
  if (result.status === 'insufficient_grounding') return { code: 'SUMMARY_INSUFFICIENT_GROUNDING' };
  if (result.status === 'needs_review') return { code: 'SUMMARY_NEEDS_REVIEW' };
  return { code: result.error?.code || 'SUMMARY_ERROR' };
}

function createSummaryController({ queryService, workflowService }) {
  return {
    async listForEvent(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        if (!await queryService.findEventById(id)) throw { code: 'EVENT_NOT_FOUND' };
        const summaries = await queryService.findSummariesForEvent(id);
        return res.status(200).json({ success: true, data: summaries.map(row => ({
          id: row.id, event_id: row.event_id, generated_at: row.generated_at,
          model_provider: row.model_provider, model_version: row.model_version,
          grounding_status: row.grounding_status, verification_status: row.verification_status,
          input_fingerprint: row.input_fingerprint
        })) });
      } catch (error) {
        const mapped = publicSummaryError(error);
        return res.status(mapped.status).json({ success: false, error: mapped.error });
      }
    },
    async getForEvent(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        const summaryId = validateId(req.params.summaryId, 'summary_id');
        if (!await queryService.findEventById(id)) throw { code: 'EVENT_NOT_FOUND' };
        const summary = await queryService.findSummaryById(summaryId);
        if (!summary || summary.event_id !== id) throw { code: 'SUMMARY_NOT_FOUND' };
        return res.status(200).json({ success: true, data: summary });
      } catch (error) {
        const mapped = publicSummaryError(error);
        return res.status(mapped.status).json({ success: false, error: mapped.error });
      }
    },
    async generateForEvent(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw { code: 'SUMMARY_INVALID_REQUEST' };
        const result = await workflowService.generateForEvent(id);
        if (result.status !== 'ready') {
          const mapped = publicSummaryError(generationError(result));
          return res.status(mapped.status).json({ success: false, error: mapped.error });
        }
        return res.status(result.reused ? 200 : 201).json({ success: true, data: { summary: result.summary, reused: result.reused } });
      } catch (error) {
        const mapped = publicSummaryError(error);
        return res.status(mapped.status).json({ success: false, error: mapped.error });
      }
    }
  };
}

module.exports = {
  ...createSummaryController({ queryService: summaryQuery, workflowService: summaryWorkflow }),
  createSummaryController, publicSummaryError, generationError
};
