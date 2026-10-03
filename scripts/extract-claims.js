/**
 * Claim extraction CLI (Phase 4).
 *
 * Usage:
 *   node scripts/extract-claims.js
 *   node scripts/extract-claims.js --limit=1
 *   node scripts/extract-claims.js --ids=<uuid>
 *   node scripts/extract-claims.js --ids=<uuid1>,<uuid2>
 *   node scripts/extract-claims.js --dry-run
 *
 * --dry-run makes ZERO Gemini calls and ZERO database writes.
 */

require('dotenv').config();

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const idsArg = rawArgs.find((arg) => arg.startsWith('--ids='));
const articleIds = idsArg
  ? idsArg.slice('--ids='.length).split(',').map((value) => value.trim()).filter(Boolean)
  : undefined;
const limitArg = Number.parseInt(rawArgs.find((arg) => /^\d+$/.test(arg)) || (rawArgs.find((arg) => arg.startsWith('--limit=')) || '').slice('--limit='.length), 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : undefined;

async function main() {
  const models = require('../models');
  if (!models.sequelize) {
    console.error('DB_NOT_CONFIGURED: set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env');
    process.exitCode = 1;
    return;
  }

  try {
    await models.sequelize.authenticate();
  } catch (error) {
    console.error(`DB_AUTH_FAILED: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const service = require('../services/claimProcessingService');

  if (dryRun) {
    const preview = await service.previewClaims({ limit, articleIds });
    console.log(JSON.stringify(preview, null, 2));
    await models.sequelize.close();
    return;
  }

  const result = await service.processClaims({ limit, articleIds });
  console.log(JSON.stringify(result, null, 2));
  await models.sequelize.close();
}

main().catch((error) => {
  console.error(`CLAIM_SCRIPT_FAILED: ${error && error.message}`);
  process.exitCode = 1;
});
