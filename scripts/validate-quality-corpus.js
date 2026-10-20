'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeArtifactPath } = require('../evaluation/realWorldQuality');
const { validateCorpus, validateFinalComposition, validateTransition } = require('../evaluation/corpusPreparation');
const ROOT = path.resolve(__dirname, '..');
function approvedPath(value) {
  safeArtifactPath(value);
  if (!value.startsWith('evaluation/corpora/8w-v1/') || !value.endsWith('.json')) throw new Error('Rejected corpus path');
}
function readJson(value) {
  approvedPath(value); let current = ROOT;
  for (const part of value.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Rejected corpus path'); }
  const stats = fs.statSync(current);
  if (!stats.isFile() || stats.size > 1000000 || fs.realpathSync(current) !== current) throw new Error('Rejected corpus input');
  return JSON.parse(fs.readFileSync(current, 'utf8'));
}
function loadBundle(paths) {
  if (!Array.isArray(paths) || paths.length !== 5) throw new Error('Expected five approved paths');
  paths.forEach(approvedPath);
  const [manifest, development, assessment, reviews, adjudications] = paths.map(readJson);
  if (!Array.isArray(development) || !Array.isArray(assessment)) throw new Error('Rejected references');
  const splits = new Map((manifest.events || []).map(event => [event.id, event.split]));
  if (!development.every(row => splits.get(row.event_id) === 'development') || !assessment.every(row => splits.get(row.event_id) === 'assessment')) throw new Error('Rejected reference split');
  return { manifest, references: [...development, ...assessment], reviews, adjudications };
}
function main(args, output = value => console.log(JSON.stringify(value))) {
  try {
    if (!Array.isArray(args) || args.length < 5) throw new Error('Missing corpus files');
    const paths = args.slice(0, 5); let final = false, provisional = false, previous = null;
    for (let i = 5; i < args.length; i++) {
      if (args[i] === '--final' && !final) final = true;
      else if (args[i] === '--allow-provisional-development' && !provisional) provisional = true;
      else if (args[i] === '--previous' && previous === null && args.length >= i + 6) { previous = args.slice(i + 1, i + 6); i += 5; }
      else throw new Error('Rejected corpus option');
    }
    if (provisional && !final) throw new Error('Provisional development applies only to final checks');
    [...paths, ...(previous || [])].forEach(approvedPath);
    const bundle = loadBundle(paths), report = validateCorpus(bundle);
    if (previous) report.transition = validateTransition(loadBundle(previous), bundle);
    if (final) report.composition = validateFinalComposition(bundle, { allowProvisionalDevelopment: provisional });
    output({ ...report, exitCode: 0 }); return 0;
  } catch (error) {
    const code = ['CORPUS_COMPOSITION_INVALID', 'CORPUS_NOT_FROZEN'].includes(error?.code) ? error.code : 'CORPUS_REJECTED';
    output({ state: 'REJECTED', code, evaluation_performed: false, factual_truth_verified: false, exitCode: 1 }); return 1;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, loadBundle, approvedPath };
