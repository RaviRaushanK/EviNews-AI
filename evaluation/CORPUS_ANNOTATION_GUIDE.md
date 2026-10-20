# 8W-A2: Offline corpus authoring and human annotation

This infrastructure prepares references. It never collects news, opens source
URLs, executes a provider, connects to a database or measures system quality.
Reference validity is not factual truth. Every report/result retains
`factual_truth_verified: false` and `evaluation_performed: false` where applicable.
See REAL_WORLD_QUALITY_EVALUATION.md for metric definitions and live gates.

## Files and data boundary

Five explicit local JSON files form an authoring bundle:

1. manifest: corpus identity, versions, lifecycle, events and report metadata;
2. development references: event sources, claims, evidence and expectations;
3. assessment references: the same structure, kept separate from development;
4. reviewer annotations: independent A/B decisions bound to reference hashes;
5. adjudications: disagreements, resolutions, notes and a named adjudicator ID.

The five *-template.json files under evaluation/corpora/8w-v1/ contain only
invented hall examples. They are draft/provisional, not real events or completed
human reviews, and do not satisfy final corpus quotas. Test-generated completed
review records and ten-event examples are synthetic doubles held only in memory.

The pure module accepts `{manifest, references, reviews, adjudications}`. The CLI
combines the development/assessment arrays and checks that their splits match the
manifest. Keys are strict. Unknown fields, hidden properties, getters, symbols,
non-JSON objects, custom/sparse arrays and excessive sizes fail closed. Inputs
are bounded to 1 MB per CLI file and 2 MB per in-memory bundle; projections retain
the reference evaluator's 1 MB limit. No authoring file is a scoring run.

## 1. Select an event and split

Prefer short, accessible, clearly bounded public announcements, service incidents,
regulatory decisions or corporate reports. Record exclusions before inspecting
system output. Avoid private data, inaccessible paywalls, graphic reports and
events whose boundaries need dozens of unrelated stories. Do not bypass access
controls. No real articles have been selected by this implementation.

The intended benchmark is ten events / 32 reports:

| Family | Events | Reports | Purpose |
| --- | ---: | ---: | --- |
| A agreement | 2 | 6 | Independent overlap without invented conflicts |
| B numbers | 2 | 6 | Comparable conflicting quantities |
| C developing | 2 | 8 | Additions, updates and corrections |
| D attribution | 1 | 3 | Preserve who alleged, denied or explained |
| E weak evidence | 1 | 2 | A genuinely insufficient eligible-input snapshot |
| F syndication | 1 | 4 | Shared origins despite multiple publishers |
| G mixed support | 1 | 3 | Prevent unsupported information promotion |

Use two development events, preferably one A and one C, and eight assessment
events. Generic authoring validation allows a partial corpus. Only explicit
final-composition validation enforces quotas. Do not tune rules or replace hard
assessment events after viewing outcomes. Such changes need a new benchmark
version and visible results for the old version.

## 2. Freeze approved report inputs, not a benchmark yet

Report metadata includes ID, source ID, title, publisher ID/name, HTTPS URL,
publication/collection/source-freeze/occurrence timestamps, origin assessment,
content hash, local artifact path, storage attestation and truncation flags.
Canonical URLs are inert metadata. HTTPS syntax accepts ordinary article paths,
queries and percent encoding but forbids embedded credentials and other schemes.

Future approved snapshots may use artifacts/8w-v1/reports/<report-id>.txt.
Neither API nor CLI reads these referenced paths. Plaintext must be supplied
explicitly in `sources` in the local references JSON. That array maps report_id
to exact text. SHA-256 is computed over that UTF-8 string. Freeze line endings
before hashing; preserve case, punctuation and qualifying context thereafter.
`complete: false` requires a truncation explanation. Missing source/hash/date or
storage attestation remains visible in a draft and blocks annotated status.

Do not put real article bodies or unapproved excerpts into Git. Metadata itself
also requires privacy/redistribution review. Storage classifications are
synthetic, restricted_local, redistribution_approved and metadata_only. `approved`
is a human attestation, NOT a legal permission check. A metadata-only input must
contain only approved available text, not secretly embed a full body. Before real
storage, explicitly approve permissions and a Git exclusion policy for the local
reference files and snapshots. This step creates none of those real artifacts.

## 3. Verify timestamps

Use UTC ISO seconds/milliseconds, retaining native timezone reasoning in notes.
Publication/occurrence may be null. Collection and source-freeze may be pending
in drafts but must exist before annotated status. `date_fallback` is true exactly
when publication time is absent; `time_uncertain` remains explicit. Publication
and collection cannot exceed the event cutoff. Report chronology is not necessarily
occurrence chronology. Never infer an event date from publication order alone.

## 4. Assess origin independence

Record a nonempty rationale for every report. Distinct publishers alone prove
nothing. Document wire credits, original bylines, shared announcements, interviews
or firsthand observation. Use the same origin_group for known shared origins.

| Authoring classification | Scoring confidence |
| --- | --- |
| confirmed_independent | confirmed |
| likely_independent | uncertain |
| confirmed_shared_origin | confirmed, with shared origin_group |
| syndicated | confirmed, with shared origin_group |
| unknown | unknown |

The confidence describes the origin assessment, not factual reliability. Unknown
does not become independent. Mixed-origin reports need claim-level review notes;
the scoring evaluator has a coarse report-level group, not an automatic
independent-corroboration detector.

## 5. Write atomic claims and 6. equivalence groups

Claims contain proposition, report ID, type, attribution, modality, quantity/unit,
location, relevant_time, scope, uncertainty (none/qualified/unknown), equivalence
group and provisional/final review state. Include all essential scope and
qualification in the proposition itself. Projection preserves that wording; it
does not manufacture missing context from authoring metadata.

Synthetic example: "Officials reported seven injuries and the bridge reopened at
18:00" becomes two claims. "The operator expects reopening tomorrow" is a
prediction, not a completed reopening. "The agency denied causing the outage"
records a denial, not proof of innocence. A causal allegation retains its speaker.

Equivalent propositions share one group and recall target. Do not merge different
units, dates, places, speakers, negations or modalities. Exact duplicate identities
with different groups fail. Semantic paraphrase equivalence remains human-labelled.
Use deterministicId(prefix, approved identity) for stable optional IDs; preserve
IDs within a frozen version and allocate a new identity for changed snapshots.

An explicit equivalent relation requires both claims to share one equivalence
group. Genuine direct/temporal contradictions require different groups. These
structural checks do not infer semantic equivalence or create missing relations.
Normal updates, corrections, partial disagreements and excluded comparisons do
not automatically impose that exact-contradiction group-separation rule.

## 7. Link evidence

Each evidence row records ID, claim/report IDs, exact excerpt, UTF-16 start/end
offsets and support/contradict/insufficient. Bounds and source occurrence are
validated; occurrence never becomes semantic support automatically. An excerpt
mentioning the topic but not establishing the claim is insufficient. Include
denials and conditions instead of trimming them away. Evidence must be from its
claim's report. Cross-report agreement uses separate equivalent claims and their
own evidence, not an illegal cross-report evidence link.

Underlying evidence identity uses the scoring canonical claim identity, report,
UTF-16 start/end offsets and exact excerpt, never the annotation ID. Duplicate
annotations cannot disagree on support/contradict/insufficient, even when their
claim IDs are aliases for the same canonical claim. Agreeing annotations remain
in the authoring/review record, but projection emits only the lexically smallest
evidence ID per underlying relationship. Distinct spans or distinct canonical
claims remain separate. Direct reference validation enforces the same consistency
rule; scoring counts agreeing reference aliases once without mutating inputs.

## 8-10. Compare claims, updates, corrections and partial cases

Compare referent, applicable time, scope, location and units first. Synthetic:
"120 users disconnected at noon" vs "180 users disconnected at noon" can be a
direct conflict for the same area. "Closed Monday; reopened Tuesday" is a normal
update. "The revised notice replaces 20 with 30" is a correction, not automatically
a simultaneous conflict. All districts vs five districts can be partial disagreement.
Customers vs households without a reliable conversion is not comparable.

Authoring contradiction maps to conflict with direct/temporal classification;
partial_disagreement maps to conflict/partial. Temporal_update maps to
normal_update/none; correction and equivalent map to their matching kind/none.
Not_comparable and ambiguous map to excluded ambiguous relations with null
classification. Never force these into a contradiction. Provisional relations
cannot enter adjudicated references. Corrections/updates retain earlier/current
order; symmetric comparison duplicates cannot receive contradictory labels.

## 11-13. Define summary expectations

Choose required and optional proposition groups, not one mandatory gold summary.
Projection chooses the lexically first claim ID in each group deterministically.
Groups must exist and cannot be both required and optional. Record prohibited
settled assertions, salience notes, expected_abstention and a nonempty rationale.
Different grounded summaries can satisfy the same references.

Weak coverage or a single publisher does not automatically require abstention.
Expect insufficient_grounding only when the approved input truly lacks eligible
support under the actual contract. An expected-abstention reference may have no
claims/evidence. Do not delete valid evidence to manufacture that real-world case;
deliberate degradation must remain explicitly synthetic.

## 14-16. Independent A/B review and adjudication

Use project-local IDs, not personal information. A and B must be different people;
software can check distinct IDs but cannot prove this happened. Each annotates
every report, claim, evidence relationship, relation and summary expectation with
agree/disagree/uncertain plus notes. Complete reviews bind to the exact
materialFingerprint. A student may be primary reviewer, with a peer/supervisor as
the independent second reviewer. Do not mark pending placeholders complete.

Disagreements identify subject/category, whether resolution is required, resolution
and notes. Required disagreements cannot be excluded to bypass resolution. Any
disagree/uncertain reviewer decision requires a corresponding resolved required
adjudication before adjudicated status. Preserve original decisions; explain the
final choice rather than overwriting dissent. An adjudicator may be a reviewer
where appropriate, but must be named and document the resolution. Changed
reference material invalidates prior review fingerprints and needs renewed review.

## 17. Lifecycle and freeze

`draft -> annotated -> reviewed -> adjudicated -> frozen` is explicit history.
History must start at draft, advance one state at a time and have ordered dates.
Corpus status is the least advanced event status. API functions validate records;
they never mutate lifecycle or write files on your behalf.

- VALID_DRAFT: structurally valid partial authoring; pending fields visible.
- READY_FOR_REVIEW: complete annotated inputs and expectations, not peer approval.
- AWAITING_ADJUDICATION: both completed, fingerprint-bound reviews exist.
- READY_TO_FREEZE: final claim/relation labels and resolved adjudication; projection
  is checked through validateReferenceArtifact.
- FROZEN_VALID: additionally sealed hashes, matching versions and evaluator commit.

materialFingerprint covers event identity/scenario/split/cutoff/reports and all
reference data, excluding lifecycle and reviews to avoid circular bindings.
freezeFingerprint additionally covers both reviewer records and adjudication.
The event seal records that fingerprint, freeze timestamp, corpus and annotation
versions. The corpus seal timestamp must follow all event freezes.

## 18. Revise a benchmark explicitly

Changing frozen assessment content, origin metadata, labels or review outcomes
requires BOTH a new corpus version and annotation version, plus revision metadata
with the previous bundle fingerprint/versions, timestamp and reason. Preserve old
artifacts. Use validateTransition(previous, next), or the CLI --previous files,
to compare against the trusted prior version. Same-version history regression or
rewriting old entries is rejected. Starting a new reviewed revision may return to
draft with new review bindings and new seals.

Hashes are integrity checks, not signatures or an immutable audit service. A
caller could deliberately replace all files and seals; historical non-mutation
cannot be proven without the trusted previous bundle or an external version
record. The API/CLI does not write, sign, store or secretly retrieve that baseline.

## Offline APIs, CLI and exit codes

validateCorpus returns sanitized preparation state/counts/pending codes and a
bundle fingerprint. projectReferences(bundle, split) requires adjudicated/frozen
events in that split and calls the existing validateReferenceArtifact; it never
adds runs, summaries, provider output or scoring success. Authoring scope and
uncertainty stay in the source bundle; its digest/version are recorded in the
projection notes so no metadata change is silently invisible to artifact identity.

The CLI reads exactly five explicit JSON paths under evaluation/corpora/8w-v1/:

```powershell
node scripts/validate-quality-corpus.js `
  evaluation/corpora/8w-v1/manifest-template.json `
  evaluation/corpora/8w-v1/development-references-template.json `
  evaluation/corpora/8w-v1/assessment-references-template.json `
  evaluation/corpora/8w-v1/reviewer-annotations-template.json `
  evaluation/corpora/8w-v1/adjudications-template.json
```

Exit 0 means valid authoring at its explicitly reported state, NOT evaluation
passed. Exit 1 means invalid data/options or failed requested final/transition
checks. Append --final to enforce 10 events, 32 reports, 2 development/8 assessment
and all A-G quotas; by default all must be frozen. The explicit
--allow-provisional-development option permits non-frozen development only while
requiring all eight assessment events frozen. It does not make those development
references projectable or claim the entire benchmark is frozen.

--previous accepts another explicit set of five files for transition validation.
All supplied paths are checked before reads. URLs, traversal, drive/UNC paths,
backslashes and symlink escapes are rejected. Metadata snapshot paths are never
dereferenced. Reports omit text, excerpts, URLs, reviewer notes and machine paths.
No credential loaders, SDKs, DB configuration or external clients are imported.
The existing guard adds only the reviewed corpus suite/source/template reads,
with no network, credentials, database, writes or subprocess-policy expansion.

## Before real assessment preparation

Approve storage and Git exclusions; select and freeze actual permitted reports;
perform real independent annotation/adjudication; validate references and final
composition; freeze the assessment labels before seeing model output. Factual
truth remains unverified. No real human annotations or collection happened here.
Actual Gemini compatibility, the unresolved real-process lifecycle gate and any
future live authorization remain separate from corpus preparation.
