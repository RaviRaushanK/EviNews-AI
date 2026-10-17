import fs from 'fs';

function load(path) {
  try {
    const t = fs.readFileSync(path, 'utf8');
    const out = { present: {}, absent: {} };
    for (const m of t.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/gm)) {
      out[Number.isInteger(1) ? 'present' : 'present'][m[1]] = true;
    }
    return t;
  } catch (e) {
    return 'ERR:' + e.message;
  }
}

// Only print presence (not secrets)
function present(path) {
  try {
    const t = fs.readFileSync(path, 'utf8');
    const set = [];
    for (const m of t.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/gm)) {
      const v = m[2].trim();
      if (v.length > 0) set.push(m[1]);
    }
    return set;
  } catch (e) { return null; }
}

console.log('ENV.example claim-model refs: ' + JSON.stringify((present('C:/Users/Ravi/Desktop/EviNews-AI/.env.example') || [])
  .filter(k => /CLAIM|GEMINI/.test(k)).sort()));

const envKeys = present('C:/Users/Ravi/Desktop/EviNews-AI/.env');
console.log('ENV claim-model refs: ' + JSON.stringify((envKeys || [])
  .filter(k => /CLAIM|GEMINI/.test(k)).sort()));

// Now read the service that resolves the external-grounded claim model
import { readFileSync } from 'fs';
const root = 'C:/Users/Ravi/Desktop/EviNews-AI';
const walk = (dir) => {
  let ents = []; try { ents = require('fs').readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.includes('node_modules')) continue;
    const p = dir + '/' + e.name;
    if (e.isDirectory()) walk(p);
    else if (/\.(js)$/.test(e.name)) {
      try {
        const src = require('fs').readFileSync(p, 'utf8');
        if (/resolveClaimModel|external|CLAIM_MODEL|CLAIM_CLAIM_LABEL/.test(src)) {
          const refs = new Set();
          for (const mm of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) refs.add(mm[1]);
          if (refs.size) console.log('  [' + p.replace(root, '') + '] reads env: ' + [...refs].sort().join(', '));
        }
      } catch {}
    }
  }
};
console.log('--- services reading model env ---');
walk(root);