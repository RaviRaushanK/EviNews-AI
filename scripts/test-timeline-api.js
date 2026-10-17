const assert = require('assert/strict');
const Module = require('module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (/gemini|@google|sequelize|[\\/]models/.test(name)) throw new Error('Forbidden dependency: ' + name);
  return load.call(this, name, ...args);
};
const { createTimelineController, parseChangeQuery } = require('../controllers/timelineController');
const EVENT = '10000000-0000-4000-8000-000000000001';
let passed = 0;
let failed = 0;
let providerCalls = 0;
global.fetch = () => { providerCalls++; throw new Error('Forbidden provider call'); };
function setup(failure) {
  const calls = [];
  const data = { event: { id: EVENT }, entries: [{ article_id: 'z' }, { article_id: 'a' }], groups: [], changes: [], baseline: { interval: '(since, until]' }, warnings: [{ code: 'COVERAGE_UNKNOWN' }], completeness: { status: 'unknown' } };
  const controller = createTimelineController({
    timelineService: { getTimelineForEvent: async (...args) => { calls.push(args); if (failure) throw failure; return data; } },
    changeService: { getChangesForEvent: async (...args) => { calls.push(args); if (failure) throw failure; return data; } }
  });
  return { controller, calls, data };
}
async function invoke(method, { id = EVENT, query = {}, failure } = {}) {
  const state = setup(failure);
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await state.controller[method]({ params: { eventId: id }, query }, res);
  return { ...state, res };
}
async function test(name, callback) {
  try { await callback(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' -> ' + error.message); }
}
async function main() {
  await test('valid timeline and response shape', async () => { const s = await invoke('getTimeline'); assert.equal(s.res.statusCode, 200); assert.deepEqual(s.res.body, { success: true, data: s.data }); });
  await test('timeline ordering preserved', async () => { const s = await invoke('getTimeline'); assert.deepEqual(s.res.body.data.entries.map(e => e.article_id), ['z', 'a']); });
  await test('coverage and warnings preserved', async () => { const s = await invoke('getTimeline'); assert.equal(s.res.body.data.completeness.status, 'unknown'); assert.equal(s.res.body.data.warnings.length, 1); });
  for (const method of ['getTimeline', 'getChanges']) {
    await test(method + ' rejects invalid UUID before service', async () => { const s = await invoke(method, { id: 'bad' }); assert.equal(s.res.statusCode, 400); assert.equal(s.calls.length, 0); assert.equal(s.res.body.error.code, 'INVALID_EVENT_ID'); });
    await test(method + ' maps missing event', async () => { const s = await invoke(method, { failure: Object.assign(new Error('internal'), { code: 'EVENT_NOT_FOUND' }) }); assert.equal(s.res.statusCode, 404); assert.equal(s.res.body.error.message, 'Event not found.'); });
    await test(method + ' sanitizes unexpected service error', async () => { const s = await invoke(method, { failure: new Error('SYNTHETIC_SECRET database-password C:\\private\\file') }); assert.equal(s.res.statusCode, 500); assert.equal(s.res.body.success, false); assert.ok(!JSON.stringify(s.res.body).includes('SYNTHETIC_SECRET')); assert.equal(s.res.body.error.code, method === 'getTimeline' ? 'TIMELINE_ERROR' : 'CHANGES_ERROR'); });
  }
  await test('valid changes defaults preserve baseline', async () => { const s = await invoke('getChanges'); assert.equal(s.res.statusCode, 200); assert.deepEqual(s.calls, [[EVENT, {}]]); assert.equal(s.res.body.data.baseline.interval, '(since, until]'); });
  await test('valid since/until normalized', async () => { const s = await invoke('getChanges', { query: { since: '2026-10-01T05:30:00+05:30', until: '2026-10-02' } }); assert.deepEqual(s.calls[0][1], { since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z' }); });
  for (const query of [{ since: 'invalid' }, { until: 'invalid' }, { since: ['2026-10-01'] }, { until: { value: '2026-10-02' } }, { since: '2026-02-30' }, { until: '2026-10-02T10:00:00' }]) {
    await test('invalid date query ' + JSON.stringify(query), async () => { const s = await invoke('getChanges', { query }); assert.equal(s.res.statusCode, 400); assert.equal(s.res.body.error.code, 'INVALID_CHANGE_DATE'); assert.equal(s.calls.length, 0); });
  }
  for (const until of ['2026-10-01', '2026-09-30']) {
    await test('reject equal/reversed range ' + until, async () => { const s = await invoke('getChanges', { query: { since: '2026-10-01', until } }); assert.equal(s.res.statusCode, 400); assert.equal(s.res.body.error.code, 'INVALID_CHANGE_RANGE'); assert.equal(s.calls.length, 0); });
  }
  await test('blank optional filters omitted', () => assert.deepEqual(parseChangeQuery({ since: '', until: '' }), {}));
  await test('unknown query does not reach service', async () => { const s = await invoke('getChanges', { query: { model: 'not-used' } }); assert.deepEqual(s.calls[0][1], {}); });
  await test('UUID normalized', async () => { const s = await invoke('getTimeline', { id: EVENT.toUpperCase() }); assert.equal(s.calls[0][0], EVENT); });
  await test('no provider calls', () => assert.equal(providerCalls, 0));
  console.log(`Timeline API tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
