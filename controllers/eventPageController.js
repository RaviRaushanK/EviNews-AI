const eventPageService = require('../services/eventPageService');
const timelineService = require('../services/eventTimelineService');
const changeService = require('../services/eventChangeService');
const { validateId } = require('../services/contradictionQueryService');
const { parseChangeQuery, publicError } = require('./timelineController');
const presentation = require('../utils/eventPresentation');

function createEventPageController({ eventPageService, timelineService, changeService }) {
  function sendError(res, error) {
    const mapped = publicError(error, 'EVENT_PAGE_ERROR');
    return res.status(mapped.status).render('events/error', { error: mapped.error });
  }
  return {
    async index(req, res) {
      try { return res.status(200).render('events/index', { ...await eventPageService.listEvents(), presentation }); }
      catch (error) { return sendError(res, error); }
    },
    async show(req, res) {
      try {
        const id = validateId(req.params.eventId, 'event_id');
        const view = req.query.view === undefined ? 'timeline' : req.query.view;
        if (!['timeline', 'changes'].includes(view)) { const error = new Error('Invalid view'); error.code = 'INVALID_VIEW'; throw error; }
        const options = parseChangeQuery(req.query);
        const data = view === 'timeline' ? await timelineService.getTimelineForEvent(id) : await changeService.getChangesForEvent(id, options);
        return res.status(200).render('events/show', { data, view, options, presentation });
      } catch (error) { return sendError(res, error); }
    }
  };
}

module.exports = { ...createEventPageController({ eventPageService, timelineService, changeService }), createEventPageController };
