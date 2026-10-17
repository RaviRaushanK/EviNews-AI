'use strict';

const { HARD_LIMITS, failure, requireSafe } = require('./liveSummarySafety');

// Offline-only boundary. A future real transport requires separate review.
function createProviderDispatcher({ executionMode, transport, maxProviderCalls, model, timeoutMs }) {
  requireSafe(executionMode === 'offline-test', 'ELIVE_REAL_TRANSPORT_UNAVAILABLE');
  requireSafe(transport && typeof transport.sendOne === 'function' && !('generateOnce' in transport), 'ELIVE_TRANSPORT_REQUIRED');
  requireSafe(Number.isSafeInteger(maxProviderCalls) && maxProviderCalls > 0 && maxProviderCalls <= HARD_LIMITS.maxProviderCalls, 'ELIVE_LIMITS_INVALID');
  requireSafe(typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model) &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'ELIVE_PROVIDER_CONTRACT');
  const sendOne = transport.sendOne.bind(transport);
  const active = new Set();
  let dispatches = 0, closed = false, violation = null;
  return Object.freeze({
    get dispatches() { return dispatches; },
    get violation() { return violation; },
    async generateText(prompt, options) {
      requireSafe(!closed, 'ELIVE_PROVIDER_CLOSED');
      const keys = ['model', 'timeoutMs', 'maxAttempts', 'responseMimeType'];
      requireSafe(options && Object.getPrototypeOf(options) === Object.prototype && Object.keys(options).length === keys.length &&
        keys.every(key => Object.hasOwn(options, key)) && options.model === model && options.timeoutMs === timeoutMs &&
        options.maxAttempts === 1 && options.responseMimeType === 'application/json' &&
        typeof prompt === 'string' && prompt.length > 0 && Buffer.byteLength(prompt) <= 80000, 'ELIVE_PROVIDER_CONTRACT');
      requireSafe(!closed, 'ELIVE_PROVIDER_CLOSED');
      if (dispatches >= maxProviderCalls) { violation = 'ELIVE_PROVIDER_BUDGET'; throw failure(violation); }
      const request = Object.freeze({ model, contents: prompt, config: Object.freeze({ responseMimeType: 'application/json' }) });
      const controller = new AbortController();
      active.add(controller);
      let timer;
      const cancelled = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(failure(closed ? 'ELIVE_PROVIDER_CLOSED' : 'GEMINI_TIMEOUT')), { once: true });
        timer = setTimeout(() => controller.abort(), timeoutMs);
      });
      try {
        // No await between reservation and the single-request transport call.
        dispatches++;
        const sent = sendOne(request, Object.freeze({ signal: controller.signal }));
        const response = await Promise.race([sent, cancelled]);
        requireSafe(response && typeof response.text === 'string' && Object.keys(response).length === 1 &&
          Object.hasOwn(response, 'text'), 'ELIVE_PROVIDER_CONTRACT');
        return { text: response.text, attempts: 1 };
      } finally {
        clearTimeout(timer);
        active.delete(controller);
      }
    },
    close() {
      closed = true;
      for (const controller of active) controller.abort();
    }
  });
}

module.exports = { createProviderDispatcher };
