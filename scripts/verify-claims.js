/**
 * Phase 4 read-only claim verification tool.
 *
 * Prints claims, evidence, confidence, provenance and a grounding audit
 * (every stored evidence_text must occur inside its article text).
 *
 * It NEVER writes to the database and NEVER calls Gemini.
 *
 * Usage:
 *   node scripts/verify-claims.js
 *   node scripts/verify-claims.js --event=<eventId>
 *   node scripts/verify-claims.js --article=<articleId>
 */

require('dotenv').config();

const models = require('../models');
const claimQueryService = require('../services/claimQueryService');

const rawArgs = process.argv.slice(2);
const eventArg = rawArgs.find((arg) => arg.startsWith('--event='));
const articleArg = rawArgs.find((arg) => arg.startsWith('--article='));
const eventId = eventArg ? eventArg.slice('--event='.length).trim() : null;
const articleId = articleArg ? articleArg.slice('--article='.length).trim() : null;

async function main() {
  const { Article, Claim, ClaimEvidence, Event, sequelize } = models;
  if (!Article || !Claim) {
    console.error('Database models are not initialized. Check your .env DB settings.');
    process.exitCode = 1;
    return;
  }

  if (articleId) {
    const data = await claimQueryService.getClaimsForArticle(articleId);
    if (!data) {
      console.error('ARTICLE_NOT_FOUND=' + articleId);
      process.exitCode = 1;
      if (sequelize) {
        await sequelize.close();
      }
      return;
    }
    console.log('ARTICLE ' + JSON.stringify({
      id: data.article.id,
      status: data.article.processing_status,
      source: data.article.Source ? data.article.Source.name : null,
      title: String(data.article.title || '').slice(0, 120),
      processing_error: data.article.processing_error ? String(data.article.processing_error).slice(0, 160) : null,
      claim_count: data.claims.length
    }));
    for (const claim of data.claims) {
      console.log('  CLAIM ' + JSON.stringify({
        id: claim.id,
        type: claim.claim_type,
        confidence: claim.confidence_score,
        event_id: claim.event_id,
        extracted_at: claim.extracted_at,
        evidence_count: claim.evidence.length,
        text: String(claim.claim_text || '').slice(0, 140)
      }));
      for (const evidence of claim.evidence) {
        console.log('    EVIDENCE ' + JSON.stringify({
          id: evidence.id,
          source: evidence.evidence_location && evidence.evidence_location.source ? evidence.evidence_location.source : 'unknown',
          chars: evidence.evidence_text ? evidence.evidence_text.length : 0
        }));
      }
    }
  }

  // Global summary (always printed).
  const totalClaims = await Claim.count();
  const totalEvidence = ClaimEvidence ? await ClaimEvidence.count() : 0;
  console.log('CLAIM_COUNT_TOTAL=' + totalClaims);
  console.log('EVIDENCE_COUNT_TOTAL=' + totalEvidence);

  const byType = await Claim.findAll({ attributes: ['claim_type'] });
  const typeCounts = {};
  for (const row of byType) {
    typeCounts[row.claim_type] = (typeCounts[row.claim_type] || 0) + 1;
  }
  console.log('CLAIM_TYPE_COUNTS=' + JSON.stringify(typeCounts));

  const statuses = await Article.findAll({ attributes: ['processing_status'] });
  const statusCounts = {};
  for (const row of statuses) {
    statusCounts[row.processing_status] = (statusCounts[row.processing_status] || 0) + 1;
  }
  console.log('ARTICLE_STATUS_COUNTS=' + JSON.stringify(statusCounts));

  if (Event) {
    console.log('EVENT_COUNT=' + await Event.count());
  }

  // Grounding audit: evidence must be present in the article text.
  const findings = await claimQueryService.auditEvidenceGrounding(articleId ? [articleId] : undefined);
  const ungrounded = findings.filter((row) => !row.grounded);
  console.log('EVIDENCE_AUDITED=' + findings.length);
  console.log('EVIDENCE_UNGROUNDED=' + ungrounded.length);
  for (const row of ungrounded.slice(0, 10)) {
    console.log('  UNGROUNDED ' + JSON.stringify(row));
  }

  if (sequelize) {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error('VERIFY_CLAIMS_FAILED: ' + (error && error.message));
  process.exitCode = 1;
});