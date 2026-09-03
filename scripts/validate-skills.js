#!/usr/bin/env node
'use strict';

// Local validator for this pack. No dependencies beyond Node itself.
//
// Checks, per CONTRIBUTING.md:
//   structure        - frontmatter with exactly `name` and `description`,
//                      kebab-case name matching the directory, third-person
//                      description with a `Use when` trigger, required sections
//   eval cases       - a case file per skill, trigger/eval minimums, fixture
//                      directories that exist
//   cross-references - every `skill-name` reference in a SKILL.md resolves
//   routing          - descriptions distinct enough to route, and no two eval
//                      cases contradicting each other about who owns a prompt
//
// Exit code: 1 if any error (or any warning with --strict), 0 otherwise.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const CASES_DIR = path.join(ROOT, 'evals', 'cases');
const FIXTURES_DIR = path.join(ROOT, 'evals', 'fixtures');
const README = path.join(ROOT, 'README.md');

const REQUIRED_SECTIONS = [
  'Overview',
  'When to Use',
  'Process',
  'Common Rationalizations',
  'Red Flags',
  'Verification',
];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const STRICT = process.argv.includes('--strict');

const errors = [];
const warnings = [];
const error = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

const rel = (p) => path.relative(ROOT, p);

function listSkillDirs() {
  if (!fs.existsSync(SKILLS_DIR)) {
    error('skills/', 'directory does not exist');
    return [];
  }
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Skills listed in the README roster: the FIRST COLUMN of table rows under the
// `## Skills` heading.
//
// Scoped rather than reading every backticked token in every table row. The
// roster is not the only table in the README — `references/` is another, and its
// rows name skills in the second column and artifacts in the first. Harvesting
// those made `idempotency-checklist` a "planned skill", so any skill body that
// backticked it would have errored with "cross-reference to planned skill" about
// a file that exists and is not a skill. That is not hypothetical: it turned up
// while the references table was being written, and was dodged by un-backticking
// the link text — a README bending around a validator heuristic.
// `readmePath` is a parameter only so the roster scoping can be exercised
// against a fixture README; every production caller uses the default.
function plannedSkills(readmePath = README) {
  const planned = new Set();
  if (!fs.existsSync(readmePath)) return planned;
  let inRoster = false;
  for (const line of fs.readFileSync(readmePath, 'utf8').split('\n')) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      inRoster = heading[1].trim() === 'Skills';
      continue;
    }
    if (!inRoster || !line.trimStart().startsWith('|')) continue;
    // `| cell | cell |` splits to ['', ' cell ', ' cell ', ''] — [1] is the first.
    const firstCell = line.split('|')[1];
    if (firstCell === undefined) continue;
    const m = firstCell.match(/`([a-z0-9-]+)`/);
    if (m && KEBAB.test(m[1])) planned.add(m[1]);
  }
  return planned;
}

// Hyphens allowed: "Cross-checks" is third person too, and rejecting it pushed
// descriptions toward worse wording to satisfy the pattern (#17).
function isThirdPerson(firstWord) {
  return /^[A-Z][A-Za-z]*(?:-[A-Za-z]+)*s$/.test(firstWord);
}

// The cross-reference rule, as the only rule CONTRIBUTING actually states: a
// backticked kebab token is an error when it names a roster skill that has not
// been written yet, and is left alone otherwise. Returns the offending refs in
// source order, deduplicated.
//
// There is deliberately no catch-all arm for unknown tokens (#17). In a
// distributed-systems pack that vocabulary IS the subject matter — one true
// sentence about `at-least-once` delivery, a `write-ahead` log and a
// `dead-letter` queue produced three warnings, and `exactly-once`,
// `read-after-write`, `dual-write` and `circuit-breaker` behave the same way.
// Wired into CI under --strict those are build failures, and the fix a
// contributor reaches for is to un-backtick correct technical terms. Unknown
// tokens are prose, upstream skills, or terms of art; none is an error.
function plannedCrossReferences(body, selfName, existing, planned) {
  const found = [];
  const seen = new Set();
  for (const m of body.matchAll(/`([a-z0-9-]+)`/g)) {
    const ref = m[1];
    if (!KEBAB.test(ref) || ref === selfName || seen.has(ref)) continue;
    seen.add(ref);
    if (existing.has(ref)) continue;
    if (planned.has(ref)) found.push(ref);
  }
  return found;
}

// Minimal frontmatter parser: top-level `key: value` scalars only, which is
// all the format allows. Returns null (and records errors) on failure.
function parseFrontmatter(content, file) {
  if (!content.startsWith('---\n')) {
    error(file, 'missing YAML frontmatter');
    return null;
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    error(file, 'frontmatter is not closed with ---');
    return null;
  }
  const fields = {};
  for (const line of content.slice(4, end).split('\n')) {
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) {
      error(file, `frontmatter line does not parse as \`key: value\`: ${line.trim()}`);
      return null;
    }
    fields[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return fields;
}

// Remove fenced code blocks so their contents are not read as prose.
//
// Tracks which marker opened the block and how long it was, per CommonMark: a
// fence closes only on the SAME character, repeated at least as many times.
// Toggling on any fence-looking line instead desynchronises the moment a block
// contains the other marker — and a ``` line inside a ~~~ example is an ordinary
// thing to write in a repository of skills about writing markdown. The
// consequence was that everything after such a block counted as fenced, so the
// planned-skill cross-reference rule stopped applying for the rest of the file
// while the run stayed green. A false negative, which is the direction nobody
// notices. See issue #19 for the three reproductions.
//
// At most three spaces of indent, per CommonMark — `^\\s*` was wrong. Four or more spaces is an
// indented code block, not a fence, so a line like `    ```` in an example of what a fence looks
// like opened a real one. It only bites when the indented run is unpaired, which is exactly what
// demonstrating a fence produces, and in a repository of skills about writing markdown that is a
// plausible thing to write. Tabs come out right for free, since CommonMark counts one as four
// columns.
//
// An unterminated fence swallows the remainder of the file. That is deliberate:
// the alternative is guessing where the author meant it to close, and reading
// too much as code only ever costs a missed cross-reference, never a false one.
function stripFencedCode(body) {
  const out = [];
  /** @type {{ marker: string, length: number } | null} */
  let fence = null;
  for (const line of body.split('\n')) {
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (opener && opener[1][0] === fence.marker && opener[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (opener) {
      fence = { marker: opener[1][0], length: opener[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// -- routing --------------------------------------------------------------
//
// Routing failures are the dominant real-world skill bug, and they are quiet:
// nothing errors, the wrong skill just answers. Two flavours, per issue #9 — a
// description missing the vocabulary users actually type (false negative), and
// an over-broad description outranking the right skill (false positive). With
// two skills there is nothing to collide with; the collisions arrive around
// five, which is when nobody is looking for them any more.

// Words carrying no routing signal: ordinary grammar, plus the `Use when` and
// `NOT for` scaffolding every description in this pack shares by construction.
// Leaving those in floats every pair's score by roughly a constant, which
// narrows the gap the threshold has to sit in.
const STOP_WORDS = new Set(
  `a an the and or of to for in on at is are be been being use used when where
   not with that this it its as by from into over under after before if then
   than so do does doing what which who whom whose how why can could should
   would may might must will shall you your we our they their he she his her
   them us me my but also about`.split(/\s+/).filter(Boolean)
);

/** Content words of a description, for overlap comparison. */
function descriptionTokens(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

/** Jaccard overlap of two descriptions: 0 shares nothing, 1 is identical. */
function similarity(a, b) {
  const A = descriptionTokens(a);
  const B = descriptionTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

// Measured on this pack rather than picked, because a threshold nobody can
// justify gets raised the first time it fires:
//
//   failure-mode-analysis vs idempotency-and-exactly-once   0.10  distinct
//   failure-mode-analysis vs a drafted resilience-patterns  0.08  sibling domain
//   failure-mode-analysis vs a deliberately over-broad one  0.48  the bug
//   failure-mode-analysis vs itself, lightly reworded       0.88  duplicate
//
// 0.35 sits in the gap — three times the widest legitimate overlap, and clear
// of the over-broad case. The test suite pins all four numbers, so a change to
// the tokeniser that quietly moves them fails there rather than here.
const COLLISION_THRESHOLD = 0.35;

// Returns findings rather than recording them, so the rule can be exercised
// directly on a table of descriptions. Inferring it from validator output would
// only ever prove the green case, and a collision check that cannot fire is the
// same as no collision check.
function findDescriptionCollisions(descriptions) {
  const found = [];
  const names = Object.keys(descriptions).sort();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const score = similarity(descriptions[names[i]], descriptions[names[j]]);
      if (score < COLLISION_THRESHOLD) continue;
      found.push({
        skill: names[i],
        other: names[j],
        score,
        message:
          'description overlaps `' + names[j] + '` at ' + score.toFixed(2) +
            ' (limit ' + COLLISION_THRESHOLD + '). Two descriptions this close cannot route ' +
          'reliably — whichever happens to rank higher takes prompts belonging to the ' +
          'other, and nothing errors when it does. Narrow both, and give each a NOT ' +
          'clause naming the other.',
      });
    }
  }
  return found;
}

/** Compare prompts on words alone: punctuation and case are not routing signal. */
function normalizePrompt(prompt) {
  return String(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A negative trigger carrying an `owner` is a claim about where a prompt
// routes. Two cases can make contradictory claims, and the contradiction is
// invisible in either file on its own — which is the whole reason to check it
// across the set rather than per file.
function findTriggerConflicts(cases) {
  const found = [];
  const positives = new Map(); // prompt -> [skill]
  const negatives = new Map(); // prompt -> [{ skill, owner }]

  for (const name of Object.keys(cases).sort()) {
    const trigger = cases[name].trigger || {};
    for (const t of Array.isArray(trigger.positive) ? trigger.positive : []) {
      if (!t || typeof t.prompt !== 'string') continue;
      const key = normalizePrompt(t.prompt);
      if (!positives.has(key)) positives.set(key, []);
      positives.get(key).push(name);
    }
    for (const t of Array.isArray(trigger.negative) ? trigger.negative : []) {
      if (!t || typeof t.prompt !== 'string') continue;
      const key = normalizePrompt(t.prompt);
      if (!negatives.has(key)) negatives.set(key, []);
      negatives.get(key).push({ skill: name, owner: t.owner });
    }
  }

  for (const [prompt, claimants] of positives) {
    if (claimants.length < 2) continue;
    found.push({
      skill: claimants[0],
      message:
        'positive trigger "' + prompt + '" is also a positive trigger for `' +
        claimants.slice(1).join('`, `') + '`. Both cannot rank first, so one case is ' +
        'asserting a routing result the other contradicts. Give the prompt to whichever ' +
        'skill should win it, and make it a negative trigger of the others.',
    });
  }

  for (const [prompt, claims] of negatives) {
    const claimants = positives.get(prompt) || [];
    for (const claim of claims) {
      if (claimants.includes(claim.skill)) {
        found.push({
          skill: claim.skill,
          message: '"' + prompt + '" is listed as both a positive and a negative trigger',
        });
      }
      if (typeof claim.owner !== 'string') continue;
      for (const claimant of claimants) {
        if (claimant === claim.owner) continue;
        found.push({
          skill: claim.skill,
          message:
            'negative trigger "' + prompt + '" names `' + claim.owner + '` as its owner, ' +
            'but `' + claimant + '` claims the same prompt as a positive trigger. One of ' +
            'the two cases is wrong about where this prompt routes.',
        });
      }
    }
  }
  return found;
}

function checkSkill(name, existing, planned) {
  const file = rel(path.join(SKILLS_DIR, name, 'SKILL.md'));
  const abs = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(abs)) {
    error(file, 'SKILL.md is missing');
    return null;
  }
  const content = fs.readFileSync(abs, 'utf8');

  // -- frontmatter --------------------------------------------------------
  const fm = parseFrontmatter(content, file);
  const description = fm && typeof fm.description === 'string' ? fm.description : null;
  if (fm) {
    const keys = Object.keys(fm).sort();
    if (keys.join(',') !== 'description,name') {
      error(file, `frontmatter must contain exactly \`name\` and \`description\`, found: ${keys.join(', ') || '(none)'}`);
    }
    if (fm.name !== undefined) {
      if (!KEBAB.test(fm.name)) {
        error(file, `\`name\` is not kebab-case: ${fm.name}`);
      }
      if (fm.name !== name) {
        error(file, `\`name\` (${fm.name}) does not match directory name (${name})`);
      }
    }
    if (fm.description !== undefined) {
      const firstWord = fm.description.split(/\s+/)[0] || '';
      if (!isThirdPerson(firstWord)) {
        error(file, `description must start in third person (e.g. "Designs", "Reviews"), found: "${firstWord}"`);
      }
      if (!/\bUse when\b/.test(fm.description)) {
        error(file, 'description must contain at least one `Use when` trigger');
      }
    }
  }

  // -- required sections --------------------------------------------------
  const headings = new Set(
    [...content.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  );
  for (const section of REQUIRED_SECTIONS) {
    if (!headings.has(section)) {
      error(file, `required section missing: ## ${section}`);
    }
  }

  // -- cross-references ---------------------------------------------------
  // Only the rule CONTRIBUTING actually states: do not cross-reference a skill
  // that is on the roster but not written yet. See `plannedCrossReferences`
  // for why an unknown token is deliberately not reported at all.
  const body = stripFencedCode(content.slice(content.indexOf('\n---') + 4));
  for (const ref of plannedCrossReferences(body, name, existing, planned)) {
    error(file, `cross-reference to planned skill \`${ref}\` — CONTRIBUTING: do not cross-reference a skill that does not exist yet`);
  }

  return description;
}

function checkEvalCase(name) {
  const abs = path.join(CASES_DIR, `${name}.json`);
  const file = rel(abs);
  if (!fs.existsSync(abs)) {
    error(file, `missing eval case for skill \`${name}\``);
    return null;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    error(file, `does not parse as JSON: ${e.message}`);
    return null;
  }

  if (data.skill_name !== name) {
    error(file, `skill_name (${data.skill_name}) does not match file name (${name})`);
  }

  const positive = data.trigger && Array.isArray(data.trigger.positive) ? data.trigger.positive : [];
  const negative = data.trigger && Array.isArray(data.trigger.negative) ? data.trigger.negative : [];
  if (positive.length < 3) {
    error(file, `at least 3 positive triggers required, found ${positive.length}`);
  }
  if (negative.length < 2) {
    error(file, `at least 2 negative triggers required, found ${negative.length}`);
  }

  // An `owner` is what turns a negative trigger from a vague "not this one" into
  // a routing assertion: it names the skill that should have won, so an
  // over-broad description shows up as a regression against a stated expectation
  // rather than as a complaint nobody can act on. Owners are frequently skills
  // outside this pack, so existence is not checked — only that the claim is
  // well-formed and not self-referential.
  const owned = negative.filter((t) => t && typeof t.owner === 'string' && t.owner.trim() !== '');
  if (owned.length < 2) {
    error(
      file,
      `at least 2 negative triggers must name an \`owner\`, found ${owned.length}. ` +
        'Without one, a negative trigger records that this skill lost a prompt but not ' +
        'who should have won it, which is the half that catches an over-broad description.'
    );
  }
  for (const t of owned) {
    if (!KEBAB.test(t.owner)) {
      error(file, `negative trigger owner is not kebab-case: ${t.owner}`);
    }
    if (t.owner === name) {
      error(
        file,
        `negative trigger "${t.prompt}" names this skill as its own owner — it cannot ` +
          'both belong here and be a prompt this skill should lose.'
      );
    }
  }

  const evals = Array.isArray(data.evals) ? data.evals : [];
  const behavioral = evals.filter((e) => Array.isArray(e.expectations) && e.expectations.length > 0);
  if (behavioral.length < 1) {
    error(file, 'at least 1 behavioral eval with a populated expectations[] is required');
  }

  for (const ev of evals) {
    for (const fixture of Array.isArray(ev.files) ? ev.files : []) {
      const dir = path.join(FIXTURES_DIR, fixture);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        error(file, `eval ${ev.id}: files[] entry \`${fixture}\` does not resolve to a directory under evals/fixtures/`);
      } else if (fs.readdirSync(dir).length === 0) {
        warn(file, `eval ${ev.id}: fixture directory \`${fixture}\` is empty`);
      }
    }
  }

  return data;
}

function checkOrphans(skills) {
  if (fs.existsSync(CASES_DIR)) {
    for (const f of fs.readdirSync(CASES_DIR)) {
      if (f.endsWith('.json') && !skills.includes(f.replace(/\.json$/, ''))) {
        warn(rel(path.join(CASES_DIR, f)), 'case file has no corresponding skill');
      }
    }
  }
  if (fs.existsSync(FIXTURES_DIR)) {
    for (const d of fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && !skills.includes(d.name)) {
        warn(rel(path.join(FIXTURES_DIR, d.name)), 'fixture directory has no corresponding skill');
      }
    }
  }
}

function main() {
  const skills = listSkillDirs();
  const existing = new Set(skills);
  const planned = plannedSkills();

  const descriptions = {};
  const cases = {};
  for (const name of skills) {
    const description = checkSkill(name, existing, planned);
    if (description) descriptions[name] = description;
    const data = checkEvalCase(name);
    if (data) cases[name] = data;
  }
  // Cross-skill, so they run once over the collected set rather than per skill.
  for (const f of findDescriptionCollisions(descriptions)) {
    error(rel(path.join(SKILLS_DIR, f.skill, 'SKILL.md')), f.message);
  }
  for (const f of findTriggerConflicts(cases)) {
    error(rel(path.join(CASES_DIR, f.skill + '.json')), f.message);
  }
  checkOrphans(skills);

  for (const e of errors) console.error(`ERROR ${e}`);
  for (const w of warnings) console.error(`WARN  ${w}`);

  const summary = `${skills.length} skill(s) checked: ${errors.length} error(s), ${warnings.length} warning(s)`;
  if (errors.length > 0 || (STRICT && warnings.length > 0)) {
    console.error(summary);
    process.exit(1);
  }
  console.log(summary);
}

// Run only as a CLI. Required as a module (by the test suite) this exports the pure
// helpers instead, so `stripFencedCode` can be exercised directly rather than inferred
// from validator output — the fence bugs in #19 were all false *negatives*, which a
// pass/fail check on the whole run cannot see.
if (require.main === module) {
  main();
} else {
  module.exports = {
    stripFencedCode,
    parseFrontmatter,
    plannedSkills,
    isThirdPerson,
    plannedCrossReferences,
    descriptionTokens,
    similarity,
    normalizePrompt,
    findDescriptionCollisions,
    findTriggerConflicts,
    COLLISION_THRESHOLD,
  };
}
