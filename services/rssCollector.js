/**
 * RSS collector.
 * Transport layer only: downloads/parses feeds and returns raw items.
 * One failing feed never aborts the remaining feeds.
 */

const Parser = require('rss-parser');
const newsConfig = require('../config/newsSources');

const MAX_ITEMS_PER_FEED = 30;

function createParser() {
  return new Parser({
    timeout: newsConfig.collection.timeoutMs,
    headers: {
      'User-Agent': newsConfig.collection.userAgent
    }
  });
}

async function fetchFeed(feedUrl) {
  const parser = createParser();
  try {
    const feed = await parser.parseURL(feedUrl);
    const items = Array.isArray(feed.items) ? feed.items.slice(0, MAX_ITEMS_PER_FEED) : [];
    return {
      ok: true,
      feedUrl,
      feedTitle: feed.title || null,
      feedLink: feed.link || null,
      items
    };
  } catch (error) {
    return {
      ok: false,
      feedUrl,
      error: (error && error.message) || 'RSS feed request failed',
      items: []
    };
  }
}

async function fetchAllFeeds(feedUrls) {
  const urls = Array.isArray(feedUrls) && feedUrls.length > 0 ? feedUrls : newsConfig.rss.feedUrls;
  const results = [];
  for (const feedUrl of urls) {
    // Sequential collection keeps Phase 2 behavior predictable for beginners.
    // eslint-disable-next-line no-await-in-loop
    const result = await fetchFeed(feedUrl);
    results.push(result);
  }
  return results;
}

module.exports = {
  MAX_ITEMS_PER_FEED,
  fetchFeed,
  fetchAllFeeds
};
