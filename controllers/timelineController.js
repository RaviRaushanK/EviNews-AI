const timelineService = require('../services/eventTimelineService');
const changeService = require('../services/eventChangeService');
const { validateId } = require('../services/contradictionQueryService');
const { validateWindow } = require('../services/eventChangeService');

function parseChangeQuery(query = {}) {
  const options = {};
  for (const key of ['since', 'until']) {
    if (query[key] === undefined || query[key] === '') continue;
    if (typeof query[key] !== 'string' || !query[key]) {
      const error = new Error('Invalid date parameter'); error.code = 'INVALID_CHANGE_DATE'; throw error;
    }
    options[key] = query[key];
  }
  const window = validateWindow(options);
  return Object.fromEntries(Object.entries(window).filter(([, value]) => value !== null));
}

function publicError(error, fallback) {
  const messages = {
    INVALID_EVENT_ID: 'eventId must be a valid UUID.',
    MISSING_EVENT_ID: 'eventId is required.',
    INVALID_CHANGE_DATE: 'Dates must be valid ISO timestamps with a timezone, or date-only values.',
    INVALID_CHANGE_RANGE: 'since must be earlier than until.',
    INVALID_VIEW: 'Unknown event view.',
    EVENT_NOT_FOUND: 'Event not found.'
  };
  const known = Object.hasOwn(messages, error && error.code);
  return {
    status: known ? error.code === 'EVENT_NOT_FOUND' ? 404 : 400 : 500,
    error: { code: known ? error.code : fallback, message: known ? messages[error.code] : 'Unable to load this event. Please try again later.' }
  };
}

function createTimelineController({ timelineService, changeService }) {
  return {
    async getTimeline(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        return res.status(200).json({ success: true, data: await timelineService.getTimelineForEvent(id) });
      } catch (error) {
        const mapped = publicError(error, 'TIMELINE_ERROR');
        return res.status(mapped.status).json({ success: false, error: mapped.error });
      }
    },
    async getChanges(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        const options = parseChangeQuery(req.query);
        return res.status(200).json({ success: true, data: await changeService.getChangesForEvent(id, options) });
      } catch (error) {
        const mapped = publicError(error, 'CHANGES_ERROR');
        return res.status(mapped.status).json({ success: false, error: mapped.error });
      }
    }
  };
}

module.exports = { ...createTimelineController({ timelineService, changeService }), createTimelineController, parseChangeQuery, publicError };
