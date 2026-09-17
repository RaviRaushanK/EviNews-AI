require('dotenv').config();
const limitArg = Number.parseInt(process.argv[2], 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : undefined;
const thresholdArg = Number.parseFloat(process.argv[3]);
const threshold = Number.isFinite(thresholdArg) && thresholdArg > 0 && thresholdArg <= 1 ? thresholdArg : undefined;

async function main() {
  const models = require('../models');
  if (!models.sequelize) {
    console.error('DB_NOT_CONFIGURED: set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env');
    process.exitCode = 1;
    return;
  }
  const orchestration = require('../services/clusteringOrchestrationService');
  try {
    await models.sequelize.authenticate();
  } catch (error) {
    console.error(`DB_AUTH_FAILED: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = await orchestration.clusterArticles({ limit, threshold });
  console.log(JSON.stringify(result, null, 2));
  await models.sequelize.close();
}

main().catch((error) => {
  console.error(`CLUSTER_SCRIPT_FAILED: ${error && error.message}`);
  process.exitCode = 1;
});
