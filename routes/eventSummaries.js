const router = require('express').Router();
const controller = require('../controllers/summaryPageController');
router.get('/events/:eventId/summary', controller.show);
router.post('/events/:eventId/summary/generate', controller.generate);
module.exports = router;
