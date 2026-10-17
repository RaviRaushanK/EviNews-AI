const { parseTimelineDate } = require('../utils/timeline');

function createSequelizeEventPageRepository({ Event, EventArticle }, Op) {
  return {
    listEvents() {
      return Event.findAll({ attributes: ['id', 'title', 'description', 'status', 'event_date'], order: [['createdAt', 'DESC'], ['id', 'ASC']], limit: 100, raw: true });
    },
    async countReports(eventIds) {
      if (!eventIds.length) return [];
      return EventArticle.count({ where: { event_id: { [Op.in]: eventIds } }, group: ['event_id'] });
    }
  };
}

function createEventPageService({ repository }) {
  return {
    async listEvents() {
      const events = await repository.listEvents();
      const counts = new Map((await repository.countReports(events.map((event) => event.id))).map((row) => [row.event_id, Number(row.count)]));
      return { events: events.map((event) => ({ ...structuredClone(event), event_date: parseTimelineDate(event.event_date), article_count: counts.get(event.id) || 0 })), limit: 100 };
    }
  };
}

let service;
async function listEvents() {
  if (!service) service = createEventPageService({ repository: createSequelizeEventPageRepository(require('../models'), require('sequelize').Op) });
  return service.listEvents();
}

module.exports = { createSequelizeEventPageRepository, createEventPageService, listEvents };
