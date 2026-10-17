const { validateId } = require('../services/contradictionQueryService');
const summaryQuery = require('../services/summaryQueryService');
const summaryWorkflow = require('../services/summaryWorkflowService');
const { publicSummaryError, generationError } = require('./summaryController');
const { buildSummaryView } = require('../utils/summaryPresentation');
const presentation = require('../utils/eventPresentation');

function createSummaryPageController({ queryService, workflowService }) {
  function sendError(res, error) {
    const mapped = publicSummaryError(error);
    return res.status(mapped.status).render('events/error', { error: mapped.error });
  }
  async function renderPage(res, eventId, selectedId, state = null) {
    const event = await queryService.findEventById(eventId);
    if (!event) throw { code: 'EVENT_NOT_FOUND' };
    const summaries = await queryService.findSummariesForEvent(eventId);
    const selected = selectedId ? await queryService.findSummaryById(selectedId) : summaries[0] || null;
    if (selectedId && (!selected || selected.event_id !== eventId)) throw { code: 'SUMMARY_NOT_FOUND' };
    return res.status(state?.status || 200).render('events/summary', {
      event, summaries, view: buildSummaryView(selected), state, presentation
    });
  }
  return {
    async show(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        const selectedId = req.query.summaryId === undefined ? null : validateId(req.query.summaryId, 'summary_id');
        return await renderPage(res, id, selectedId);
      } catch (error) { return sendError(res, error); }
    },
    async generate(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw { code: 'SUMMARY_INVALID_REQUEST' };
        if (!await queryService.findEventById(id)) throw { code: 'EVENT_NOT_FOUND' };
        const result = await workflowService.generateForEvent(id);
        if (result.status === 'ready') return res.redirect(303, `/events/${encodeURIComponent(id)}/summary?summaryId=${encodeURIComponent(result.summary.id)}`);
        const mapped = publicSummaryError(generationError(result));
        return await renderPage(res, id, null, { status: mapped.status, message: mapped.error.message, code: mapped.error.code, findings: result.findings || [] });
      } catch (error) { return sendError(res, error); }
    }
  };
}

module.exports = {
  ...createSummaryPageController({ queryService: summaryQuery, workflowService: summaryWorkflow }),
  createSummaryPageController
};
