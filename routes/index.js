/**
 * API routes definition
 */

const express = require('express');
const collectionController = require('../controllers/collectionController');
const processingController = require('../controllers/processingController');
const claimController = require('../controllers/claimController');

const router = express.Router();

// Example route - health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Phase 2: multi-source collection endpoints (verification only, no dashboard yet).
router.post('/collect/newsapi', collectionController.collectNewsApi);
router.post('/collect/rss', collectionController.collectRss);
router.get('/articles/recent', collectionController.recentArticles);

// Phase 3: processing + clustering verification endpoints (no dashboard yet).
router.post('/process/articles', processingController.processArticles);
router.post('/process/articles/reconcile', processingController.reconcileArticles);
router.post('/cluster/articles', processingController.clusterArticles);
router.get('/events', processingController.listEvents);
router.get('/events/:id', processingController.getEvent);

// Phase 4: claim extraction + claim inspection endpoints.
router.post('/claims/extract', claimController.extractClaims);
router.post('/claims/extract/:articleId', claimController.extractClaimsForArticle);
router.get('/events/:id/claims', claimController.listEventClaims);
router.get('/articles/:id/claims', claimController.listArticleClaims);

module.exports = router;

