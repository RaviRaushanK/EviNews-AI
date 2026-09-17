/**
 * Manual NewsAPI collection script.
 * Usage: node scripts/collect-newsapi.js "climate change"
 */

require('dotenv').config();

const collectionService = require('../services/collectionService');

async function main() {
  const query = process.argv[2] || 'technology';
  console.log(`Collecting NewsAPI top-headlines for query: ${query}`);
  const result = await collectionService.collectFromNewsApi({ q: query });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
