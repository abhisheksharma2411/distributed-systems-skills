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
function plannedSkills() {
  const planned = new Set();
  if (!fs.existsSync(README)) return planned;
  let inRoster = false;
  for (const line of fs.readFileSync(README, 'utf8').split('\n')) {
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

function checkSkill(name, existing, planned) {
  const file = rel(path.join(SKILLS_DIR, name, 'SKILL.md'));
  const abs = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(abs)) {
    error(file, 'SKILL.md is missing');
    return;
  }
  const content = fs.readFileSync(abs, 'utf8');

  // -- frontmatter --------------------------------------------------------
  const fm = parseFrontmatter(content, file);
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
      // Hyphens allowed: "Cross-checks" is third person too, and rejecting it
      // pushed descriptions toward worse wording to satisfy the pattern.
      if (!/^[A-Z][A-Za-z]*(?:-[A-Za-z]+)*s$/.test(firstWord)) {
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
  // that is on the roster but not written yet.
  //
  // A backticked kebab token that names no roster skill is left alone. In a
  // distributed-systems pack that vocabulary IS the subject matter — one true
  // sentence about `at-least-once` delivery, a `write-ahead` log and a
  // `dead-letter` queue produced three warnings, and `exactly-once`,
  // `read-after-write`, `dual-write` and `circuit-breaker` behave the same way.
  // With this wired into CI under --strict they would be build failures, and the
  // fix a contributor reaches for is to un-backtick correct technical terms.
  // Unknown tokens are prose, upstream skills, or terms of art; none is an error.
  const body = stripFencedCode(content.slice(content.indexOf('\n---') + 4));
  const seen = new Set();
  for (const m of body.matchAll(/`([a-z0-9-]+)`/g)) {
    const ref = m[1];
    if (!KEBAB.test(ref) || ref === name || seen.has(ref)) continue;
    seen.add(ref);
    if (existing.has(ref)) continue;
    if (planned.has(ref)) {
      error(file, `cross-reference to planned skill \`${ref}\` — CONTRIBUTING: do not cross-reference a skill that does not exist yet`);
    }
  }
}

function checkEvalCase(name) {
  const abs = path.join(CASES_DIR, `${name}.json`);
  const file = rel(abs);
  if (!fs.existsSync(abs)) {
    error(file, `missing eval case for skill \`${name}\``);
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    error(file, `does not parse as JSON: ${e.message}`);
    return;
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

  for (const name of skills) {
    checkSkill(name, existing, planned);
    checkEvalCase(name);
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

main();
