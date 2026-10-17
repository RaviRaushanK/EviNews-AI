const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (/sequelize|google|gemini|services|models|https?$|^net$/.test(name)) throw new Error('Forbidden utility dependency: ' + name);
  return originalLoad.call(this, name, ...args);
};
const timeline = require('../utils/timeline');
const fixture = require('../fixtures/phase6-utilities.json');
let passed = 0;
let failed = 0;
function test(name, callback) {
  try { callback(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' -> ' + error.message); }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test('ISO dates normalize to UTC', () => assert.equal(timeline.parseTimelineDate('2026-10-01T10:00:00Z'), '2026-10-01T10:00:00.000Z'));
test('timezone offsets represent the same instant', () => assert.equal(timeline.parseTimelineDate('2026-10-01T15:30:00+05:30'), timeline.parseTimelineDate('2026-10-01T10:00:00Z')));
test('date-only input has UTC midnight', () => assert.equal(timeline.parseTimelineDate('2026-10-01'), '2026-10-01T00:00:00.000Z'));
test('Date objects accepted without mutation', () => { const date = new Date('2026-10-01'); assert.equal(timeline.parseTimelineDate(date), date.toISOString()); });
test('epoch zero preserved', () => assert.equal(timeline.parseTimelineDate(0), '1970-01-01T00:00:00.000Z'));
test('null and invalid values never throw', () => { for (const value of [null, undefined, '', 'invalid', NaN, Infinity, {}, [], Symbol('invalid'), new Date(NaN)]) assert.equal(timeline.parseTimelineDate(value), null); });
test('impossible calendar dates rejected', () => { for (const date of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00']) assert.equal(timeline.parseTimelineDate(date), null); });
test('leap day validated', () => { assert.ok(timeline.parseTimelineDate('2024-02-29')); assert.equal(timeline.parseTimelineDate('2026-02-29'), null); });
test('timezone-free datetimes rejected', () => assert.equal(timeline.parseTimelineDate('2026-10-01T10:00:00'), null));
test('invalid clock times do not roll forward', () => { for (const date of ['2026-10-01T24:00:00Z', '2026-10-01T10:60:00Z', '2026-10-01T10:00:60Z']) assert.equal(timeline.parseTimelineDate(date), null); });
test('null article produces an undated entry', () => assert.equal(timeline.buildTimelineEntry(null).report_timestamp, null));
test('publication time takes precedence', () => assert.deepEqual(timeline.selectReportDate(fixture.articles[0]), { report_timestamp: '2026-10-01T10:00:00.000Z', date_source: 'published_at' }));
test('null publication date falls back to fetched time', () => assert.equal(timeline.selectReportDate(fixture.articles[2]).date_source, 'fetched_at'));
test('invalid publication date falls back to fetched time', () => assert.equal(timeline.selectReportDate({ published_at: 'invalid', fetched_at: '2026-10-01' }).date_source, 'fetched_at'));
test('missing dates remain undated', () => assert.deepEqual(timeline.selectReportDate(fixture.articles[3]), { report_timestamp: null, date_source: null }));
test('claim extraction time is never a report timestamp', () => assert.equal(timeline.buildTimelineEntry({ id: 'a' }, [{ extracted_at: '2026-10-01' }]).report_timestamp, null));
test('article source, title, claims and evidence preserved', () => { const entry = timeline.buildTimelineEntry(fixture.articles[0], fixture.claims); assert.equal(entry.article_id, 'fixture-b'); assert.deepEqual(entry.source, fixture.articles[0].source); assert.equal(entry.title, fixture.articles[0].title); assert.deepEqual(entry.claims, fixture.claims); assert.deepEqual(entry.evidence, fixture.claims[0].evidence); assert.equal(entry.claim_count, 1); });
test('separately supplied evidence preserved', () => assert.deepEqual(timeline.buildTimelineEntry(fixture.articles[0], fixture.claims, [{ evidence_text: 'Separate evidence' }]).evidence, [{ evidence_text: 'Separate evidence' }]));
test('empty claims distinguished from unavailable claims', () => { const empty = timeline.buildTimelineEntry(fixture.articles[0], []); const absent = timeline.buildTimelineEntry(fixture.articles[0], null); assert.equal(empty.claims_status, 'empty'); assert.equal(empty.claims_empty, true); assert.equal(absent.claims_status, 'unavailable'); assert.equal(absent.claims_unavailable, true); assert.equal(absent.claim_count, 0); });
const entries = fixture.articles.map((article) => timeline.buildTimelineEntry(article, []));
test('ordering uses timestamp then stable ID', () => assert.deepEqual(timeline.sortTimelineEntries(entries).map((entry) => entry.article_id), ['fixture-a', 'fixture-b', 'fixture-fallback', 'fixture-invalid']));
test('shuffled input yields identical timeline', () => assert.deepEqual(timeline.sortTimelineEntries([...entries].reverse()), timeline.sortTimelineEntries(entries)));
test('equal timestamps form one tied group', () => { const groups = timeline.groupTimelineEntries(entries); assert.equal(groups.length, 3); assert.equal(groups[0].tied, true); assert.deepEqual(groups[0].entries.map((entry) => entry.article_id), ['fixture-a', 'fixture-b']); });
test('undated entries are not treated as simultaneous', () => { const groups = timeline.groupTimelineEntries([timeline.buildTimelineEntry({ id: 'b' }), timeline.buildTimelineEntry({ id: 'a' })]); assert.equal(groups.length, 2); assert.ok(groups.every((group) => !group.tied)); });
test('empty and null entry lists supported', () => { assert.deepEqual(timeline.sortTimelineEntries(null), []); assert.deepEqual(timeline.groupTimelineEntries([]), []); });
test('frozen inputs accepted without mutation', () => { const article = freeze(structuredClone(fixture.articles[0])); const claims = freeze(structuredClone(fixture.claims)); timeline.buildTimelineEntry(article, claims); timeline.groupTimelineEntries(freeze(structuredClone(entries))); assert.deepEqual(article, fixture.articles[0]); assert.deepEqual(claims, fixture.claims); });
test('nested output is detached from inputs', () => { const entry = timeline.buildTimelineEntry(fixture.articles[0], fixture.claims); entry.source.name = 'changed'; entry.claims[0].evidence[0].evidence_location.paragraph = 99; entry.evidence[0].evidence_text = 'changed'; assert.equal(fixture.claims[0].evidence[0].evidence_location.paragraph, 1); assert.equal(fixture.articles[0].source.name, 'Fixture B'); });
test('pure imports load no provider or models', () => assert.ok(!Object.keys(require.cache).some((name) => /[\\/](models|services)[\\/]|@google|sequelize/.test(name))));
Module._load = originalLoad;
console.log('TESTS_PASSED=' + passed);
console.log('TESTS_FAILED=' + failed);
process.exitCode = failed ? 1 : 0;
