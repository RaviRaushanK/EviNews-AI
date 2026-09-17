/**
 * Manual RSS collection script.
 * Usage: node scripts/collect-rss.js [feedUrl1 feedUrl2 ...]
 */

require('dotenv').config();

const collectionService = require('../services/collectionService');
const newsConfig = require('../config/newsSources');

async function main() {
  const cliFeeds = process.argv.slice(2).filter(Boolean);
  const feeds = cliFeeds.length > 0 ? cliFeeds : newsConfig.rss.feedUrls;
  console.log(`Collecting RSS feeds: ${feeds.length > 0 ? feeds.join(', ') : '(none configured)'}`);
  const result = await collectionService.collectFromRss(feeds.length > 0 ? feeds : undefined);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
