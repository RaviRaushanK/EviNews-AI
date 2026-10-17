require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const AID = '1c91b673-a465-436c-9f02-b0d488204571';

(async function main() {
  const m = require('mongodb');
  const uri = process.env.MONGO_URI || process.env.DB_URI;
  if (!uri && process.env.ATLAS_URI) uri = process.env.ATLAS_URI;
  if (!uri) { console.log('NO_MONGO_URI'); process.exit(0); }

  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SHORT_TIMEOUT_MS = 2000;
  let connected = false;
  let listenerReady = false;
  const short = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), SHORT_TIMEOUT_MS);
    Promise.race([client.connect(), sleep(4000)])
      .then(() => { clearTimeout(t); if (client && client.topology && client.topology.connections) listenerReady = true; connected = true; resolve(true); })
      .catch(() => { clearTimeout(t); resolve(false); });
  });
  connected = await short;
  if (!connected) { console.log('DB_CONNECT_TIMEOUT'); process.exit(0); }

  const db = client.db();
  const claimCol = db.collection('evinews_claims');
  const evCol = db.collection('claim_evidence');

  async function num(r) { try { return (await r).toArray ? (await r).toArray() : await r; } catch (e) { return e && e.errmsg ? e : r; } }
  async function countOf(col, filter) {
    try { const n = await col.countDocuments(filter); return n; }
    catch (e) { return 'ERR:' + (e && e.message || e); }
  }

  const articleClaimCount = await countOf(claimCol, { article_id: AID });
  console.log('AUDIT candidate=candidate  article_claim_rows=' + articleClaimCount);

  process.exitCode = 0;
  try { await client.close(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.log('AUDIT_FATAL=' + (e && e.message || e).toString().slice(0, 120)); try { process.exit(0); } catch (_) {} });
