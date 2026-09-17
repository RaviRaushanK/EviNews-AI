/**
 * Source service.
 * Owns source identity so repeated collections do not create duplicates.
 */

const { Source } = require('../models');

function requireModels() {
  if (!Source) {
    throw new Error('Database models are not initialized');
  }
}

async function findByIdentity({ name, url, rss_url, api_identifier }) {
  if (name) {
    const byName = await Source.findOne({ where: { name } });
    if (byName) {
      return byName;
    }
  }
  if (url) {
    const byUrl = await Source.findOne({ where: { url } });
    if (byUrl) {
      return byUrl;
    }
  }
  if (rss_url) {
    const byRss = await Source.findOne({ where: { rss_url } });
    if (byRss) {
      return byRss;
    }
  }
  if (api_identifier) {
    const byApiId = await Source.findOne({ where: { api_identifier } });
    if (byApiId) {
      return byApiId;
    }
  }
  return null;
}

async function findOrCreateSource({ name, url, rss_url, api_identifier }) {
  requireModels();
  const existing = await findByIdentity({ name, url, rss_url, api_identifier });
  if (existing) {
    return { source: existing, created: false };
  }

  try {
    const source = await Source.create({ name, url, rss_url, api_identifier });
    return { source, created: true };
  } catch (error) {
    // A concurrent insert may win the race on a unique column. Recover by lookup.
    if (error && error.name === 'SequelizeUniqueConstraintError') {
      const recovered = await findByIdentity({ name, url, rss_url, api_identifier });
      if (recovered) {
        return { source: recovered, created: false };
      }
    }
    throw error;
  }
}

async function findOrCreateNewsApiSource({ name, api_identifier }) {
  return findOrCreateSource({
    name: name || 'NewsAPI',
    url: null,
    rss_url: null,
    api_identifier: api_identifier || null
  });
}

async function findOrCreateRssSource({ name, url, rss_url }) {
  return findOrCreateSource({
    name: name || 'RSS Feed',
    url: url || null,
    rss_url: rss_url || null,
    api_identifier: null
  });
}

module.exports = {
  findOrCreateSource,
  findOrCreateNewsApiSource,
  findOrCreateRssSource
};
