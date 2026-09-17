require('dotenv').config();

// Usage:
//   node scripts/process-articles.js                  -> oldest collected/cleaned articles (MAX_ARTICLES_PER_RUN)
//   node scripts/process-articles.js 5               -> oldest 5 collected/cleaned articles
//   node scripts/process-articles.js --ids=a,b       -> only the given article ids (still limited to collected/cleaned)
//   node scripts/process-articles.js --reconcile     -> only embedded/clustered articles with missing/stale embeddings
//   node scripts/process-articles.js --reconcile --ids=a,b -> reconcile only the given embedded/clustered ids
const rawArgs = process.argv.slice(2);
const reconcile = rawArgs.includes('--reconcile');
const idsArg = rawArgs.find((arg) => arg.startsWith('--ids='));
const articleIds = idsArg
  ? idsArg.slice('--ids='.length).split(',').map((value) => value.trim()).filter(Boolean)
  : undefined;
const limitArg = Number.parseInt(rawArgs.find((arg) => /^\d+$/.test(arg)), 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : undefined;


async function main() {
  const models = require('../models');
  if (!models.sequelize) {
    console.error('DB_NOT_CONFIGURED: set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env');
    process.exitCode = 1;
    return;
  }
  const service = require('../services/processingService');
  try {
    await models.sequelize.authenticate();
  } catch (error) {
    console.error(`DB_AUTH_FAILED: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = reconcile
    ? await service.reconcileEmbeddings({ limit, articleIds })
    : await service.processArticles({ limit, articleIds });
  console.log(JSON.stringify(result, null, 2));
  await models.sequelize.close();
}

main().catch((error) => {
  console.error(`PROCESS_SCRIPT_FAILED: ${error && error.message}`);
  process.exitCode = 1;
});
