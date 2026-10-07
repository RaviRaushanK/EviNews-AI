/**
 * Thin HTTP adapter for Phase 5 contradiction services.
 * Business logic, Gemini calls, queries, and persistence remain in services.
 */

const contradictionDetectionService = require('../services/contradictionDetectionService');
const contradictionQueryService = require('../services/contradictionQueryService');

function httpInputError(message) {
  const error = new Error(message);
  error.code = 'INVALID_HTTP_INPUT';
  return error;
}

function parseQueryLimit(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw httpInputError('limit must be a positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw httpInputError('limit must be a positive integer');
  }
  return parsed;
}

function parseDetectionBody(body) {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw httpInputError('request body must be a JSON object');
  }

  const options = {};
  if (body.maxCandidates !== undefined) {
    if (typeof body.maxCandidates !== 'number' || !Number.isFinite(body.maxCandidates) ||
        !Number.isInteger(body.maxCandidates) || body.maxCandidates <= 0) {
      throw httpInputError('maxCandidates must be a positive integer');
    }
    options.maxCandidates = body.maxCandidates;
  }
  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== 'boolean') {
      throw httpInputError('dryRun must be a boolean');
    }
    if (body.dryRun) {
      throw httpInputError('dryRun=true is not supported by the contradiction detection service');
    }
    options.dryRun = false;
  }
  return options;
}

function parseContradictionQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw httpInputError('query parameters must be an object');
  }
  const options = {};
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !query.status) {
      throw httpInputError('status must be a non-empty string');
    }
    options.status = query.status;
  }
  if (query.type !== undefined) {
    if (typeof query.type !== 'string' || !query.type) {
      throw httpInputError('type must be a non-empty string');
    }
    options.type = query.type;
  }
  const limit = parseQueryLimit(query.limit);
  if (limit !== undefined) {
    options.limit = limit;
  }
  return options;
}

function parseHistoryQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw httpInputError('query parameters must be an object');
  }
  if (query.outcome !== undefined) {
    throw httpInputError('outcome filtering is not supported by the query service');
  }
  const limit = parseQueryLimit(query.limit);
  return limit === undefined ? {} : { limit };
}

function statusForError(error) {
  const code = error && error.code ? String(error.code) : '';
  if (code.endsWith('_NOT_FOUND')) {
    return 404;
  }
  if (
    code === 'CONTRADICTION_CHECK_ALREADY_EXISTS' ||
    code.includes('CONFLICT') ||
    code.includes('ALREADY_EXISTS') ||
    code.includes('UNIQUE')
  ) {
    return 409;
  }
  if (code.startsWith('GEMINI_')) {
    return 502;
  }
  if (
    code.startsWith('INVALID_') ||
    code.startsWith('MISSING_') ||
    code === 'CONTRADICTION_MODEL_NOT_CONFIGURED'
  ) {
    return 400;
  }
  return 500;
}

function sendError(res, error) {
  const status = statusForError(error);
  let message = 'Internal server error';
  if (status === 400 || status === 404) {
    message = String(error.message || 'Invalid request').slice(0, 300);
  } else if (status === 409) {
    message = 'The contradiction evaluation already exists or was created concurrently';
  } else if (status === 502) {
    message = 'Upstream Gemini request failed';
  }
  return res.status(status).json({
    success: false,
    error: {
      message,
      code: error && error.code ? String(error.code) : 'INTERNAL_ERROR'
    }
  });
}

function createContradictionController({ detectionService, queryService }) {
  if (!detectionService || typeof detectionService.detectContradictionsForEvent !== 'function') {
    throw new TypeError('detectionService is required');
  }
  if (!queryService || typeof queryService.getContradictionsForEvent !== 'function' ||
      typeof queryService.getContradictionsForClaim !== 'function' ||
      typeof queryService.getContradictionChecksForClaim !== 'function') {
    throw new TypeError('queryService is required');
  }

  return {
    async detectForEvent(req, res) {
      try {
        if (!req.params || !req.params.eventId) {
          throw httpInputError('eventId is required');
        }
        const options = parseDetectionBody(req.body);
        const data = await detectionService.detectContradictionsForEvent(req.params.eventId, options);
        return res.status(200).json({ success: true, data });
      } catch (error) {
        return sendError(res, error);
      }
    },

    async listForEvent(req, res) {
      try {
        if (!req.params || !req.params.eventId) {
          throw httpInputError('eventId is required');
        }
        const options = parseContradictionQuery(req.query);
        const data = await queryService.getContradictionsForEvent(req.params.eventId, options);
        return res.status(200).json({ success: true, data });
      } catch (error) {
        return sendError(res, error);
      }
    },

    async listForClaim(req, res) {
      try {
        if (!req.params || !req.params.claimId) {
          throw httpInputError('claimId is required');
        }
        const options = parseContradictionQuery(req.query);
        const data = await queryService.getContradictionsForClaim(req.params.claimId, options);
        return res.status(200).json({ success: true, data });
      } catch (error) {
        return sendError(res, error);
      }
    },

    async listChecksForClaim(req, res) {
      try {
        if (!req.params || !req.params.claimId) {
          throw httpInputError('claimId is required');
        }
        const options = parseHistoryQuery(req.query);
        const data = await queryService.getContradictionChecksForClaim(req.params.claimId, options);
        return res.status(200).json({ success: true, data });
      } catch (error) {
        return sendError(res, error);
      }
    }
  };
}

const controller = createContradictionController({
  detectionService: contradictionDetectionService,
  queryService: contradictionQueryService
});

module.exports = {
  ...controller,
  parseQueryLimit,
  parseDetectionBody,
  parseContradictionQuery,
  parseHistoryQuery,
  statusForError,
  sendError,
  createContradictionController
};
