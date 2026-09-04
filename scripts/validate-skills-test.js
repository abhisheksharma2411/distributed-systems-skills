#!/usr/bin/env node
'use strict';

// Tests for the pure helpers in validate-skills.js. No dependencies beyond Node's
// own test runner.
//
// These exist because the fence bugs in #19 were all false *negatives*: the
// validator stayed green while silently skipping the rest of a file. A pass/fail
// check on the whole run cannot see that, so the stripper is exercised directly.
//
// Run: node --test scripts/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
} = require('./validate-skills.js');

// Built rather than written literally so this file does not contain fences that
// confuse the very tooling it is testing — including its own editors.
const B = '`'.repeat(3);
const T = '~'.repeat(3);
const MARKER = 'PROSE-AFTER';

/** Did prose following the block survive the strip? */
const proseSurvives = (lines) => stripFencedCode(lines.join('\n')).includes(MARKER);

test('an ordinary fenced block is stripped and the prose after it survives', () => {
  assert.equal(proseSurvives([B, 'secret-code', B, MARKER]), true);
  assert.equal(stripFencedCode([B, 'secret-code', B, MARKER].join('\n')).includes('secret-code'), false);
});

test('a ``` inside a ~~~ block does not close it (#19)', () => {
  // The desync that made everything after such a block count as fenced, so the
  // cross-reference rule stopped applying for the rest of the file — silently.
  assert.equal(proseSurvives([T, 'inside', B, 'still inside', T, MARKER]), true);
});

test('a ~~~ inside a ``` block does not close it either', () => {
  assert.equal(proseSurvives([B, 'inside', T, 'still inside', B, MARKER]), true);
});

test('a shorter run does not close a longer fence (#20)', () => {
  // ``` cannot close ````. Tracking length fixes this and the mixed-marker case
  // as one rule rather than two special cases.
  assert.equal(proseSurvives(['`'.repeat(4), 'inside', B, 'still inside', '`'.repeat(4), MARKER]), true);
});

test('a longer run does close a shorter fence, per CommonMark', () => {
  assert.equal(proseSurvives([B, 'inside', '`'.repeat(4), MARKER]), true);
});

test('four spaces of indent is an indented code block, not a fence (#20)', () => {
  // Writing an example of what a fence looks like must not open a real one.
  assert.equal(proseSurvives(['    ' + B, '    not really a fence', '', MARKER]), true);
});

test('up to three spaces of indent still opens a fence, per CommonMark', () => {
  for (const indent of ['', ' ', '  ', '   ']) {
    assert.equal(
      stripFencedCode([indent + B, 'secret-code', indent + B, MARKER].join('\n')).includes('secret-code'),
      false,
      `indent of ${indent.length} space(s) should still open a fence`
    );
  }
});

test('an unterminated fence swallows the rest of the file, deliberately', () => {
  // Reading too much as code costs a missed cross-reference; guessing where the
  // author meant it to close could produce a false one.
  assert.equal(proseSurvives([B, 'inside', MARKER]), false);
});

test('info strings on the opening fence are allowed', () => {
  assert.equal(proseSurvives([B + 'js', 'secret-code', B, MARKER]), true);
});

test('parseFrontmatter reads a well-formed header', () => {
  const fields = parseFrontmatter(
    ['---', 'name: some-skill', 'description: Does a thing. Use when you need it.', '---', '', 'Body.'].join('\n'),
    'SKILL.md'
  );
  assert.equal(fields.name, 'some-skill');
  assert.match(fields.description, /Use when/);
});

// -- routing: description collisions ---------------------------------------
//
// The threshold is only defensible if the numbers behind it are pinned. These
// are the four measurements quoted in validate-skills.js; if a change to the
// tokeniser moves them, that shows up here rather than as a threshold someone
// raises to make the build pass.

const FMA =
  'Enumerates the ways an operation can partially fail at design time, before the happy ' +
  'path is written, and specifies deliberate behavior for each one. Use when designing a ' +
  'feature or checkout flow that calls a database, queue, or third-party API. Use when ' +
  'asking what should happen if a dependency times out or is slow. Use when writing a ' +
  'design document or ADR for something with external dependencies. NOT for diagnosing ' +
  'something that is already broken.';

const IDEM =
  'Designs and reviews side-effecting operations so that retries, replays, and concurrent ' +
  'duplicates produce exactly one effect. Use when writing or reviewing code that charges ' +
  'money, sends messages, mutates inventory, or calls a non-transactional external API. ' +
  'Use when adding retries, queue consumers, webhooks, or agent tool calls that mutate ' +
  'state. Use when investigating duplicate charges, double-sent notifications, or drifted ' +
  'balances.';

// A sibling that legitimately overlaps in domain — issue #9 names this exact pair
// as one that "both legitimately match what happens when this dependency goes down".
const RESILIENCE =
  'Applies retry, timeout, circuit-breaker and bulkhead patterns so a failing dependency ' +
  'degrades the caller instead of taking it down. Use when adding retries or timeouts to ' +
  'an outbound call. Use when a slow dependency is causing cascading failures. Use when ' +
  'choosing a backoff strategy or deciding what to do when a circuit opens. NOT for ' +
  'enumerating failure modes at design time.';

// The bug: a description broad enough to outrank the skill that should win.
const OVER_BROAD =
  'Reviews any operation that calls a database, queue, or third-party API and specifies ' +
  'what should happen when it partially fails at design time, before the happy path is ' +
  'written. Use when designing a feature or checkout flow. Use when asking what happens ' +
  'if a dependency times out. Use when writing a design document or ADR.';

test('legitimately distinct skills score well under the threshold', () => {
  assert.ok(similarity(FMA, IDEM) < 0.15, `distinct pair scored ${similarity(FMA, IDEM)}`);
  assert.ok(similarity(FMA, RESILIENCE) < 0.15, `sibling pair scored ${similarity(FMA, RESILIENCE)}`);
  assert.ok(similarity(IDEM, RESILIENCE) < 0.15);
});

test('an over-broad description scores above the threshold', () => {
  const score = similarity(FMA, OVER_BROAD);
  assert.ok(score >= COLLISION_THRESHOLD, `over-broad description scored only ${score}`);
});

test('a reworded duplicate scores near 1', () => {
  const reworded = FMA.replace('Enumerates', 'Lists').replace('deliberate behavior', 'intentional behaviour');
  assert.ok(similarity(FMA, reworded) > 0.8);
});

test('the threshold sits in the gap between legitimate overlap and the bug', () => {
  // The property the number has to have. Stated as a test so raising it to
  // silence a real collision breaks something visible.
  const widestLegitimate = Math.max(
    similarity(FMA, IDEM), similarity(FMA, RESILIENCE), similarity(IDEM, RESILIENCE)
  );
  assert.ok(widestLegitimate < COLLISION_THRESHOLD, 'threshold would fail a legitimate pair');
  assert.ok(COLLISION_THRESHOLD < similarity(FMA, OVER_BROAD), 'threshold would miss the bug');
});

test('similarity is symmetric, and 1 only for identical content', () => {
  assert.equal(similarity(FMA, IDEM), similarity(IDEM, FMA));
  assert.equal(similarity(FMA, FMA), 1);
  assert.equal(similarity('', ''), 0);
});

test('shared boilerplate alone does not make two descriptions look alike', () => {
  // Every description in the pack contains `Use when` and `NOT for`. If that
  // scaffolding counted, every pair would float upward and the threshold would
  // have nowhere to sit.
  const a = 'Designs alpha. Use when doing the alpha work. NOT for beta.';
  const b = 'Reviews gamma. Use when doing the gamma task. NOT for delta.';
  assert.equal(similarity(a, b), 0, 'scaffolding alone should share nothing');
});

test('collisions are found between every pair, not just adjacent ones', () => {
  const found = findDescriptionCollisions({ 'a-skill': FMA, 'b-skill': IDEM, 'c-skill': OVER_BROAD });
  // a↔c collide; they are not adjacent once the names are sorted.
  assert.equal(found.length, 1);
  assert.equal(found[0].skill, 'a-skill');
  assert.equal(found[0].other, 'c-skill');
  assert.match(found[0].message, /cannot route/);
});

test('a distinct catalogue produces no collisions', () => {
  assert.deepEqual(findDescriptionCollisions({ fma: FMA, idem: IDEM, res: RESILIENCE }), []);
});

// -- routing: contradictory trigger claims ---------------------------------

const caseFor = (positive, negative) => ({ trigger: { positive, negative } });
const p = (prompt) => ({ prompt, top_k: 3 });

test('two skills claiming the same prompt as positive is a conflict', () => {
  const found = findTriggerConflicts({
    alpha: caseFor([p('charge the customer twice')], []),
    beta: caseFor([p('Charge the customer twice!')], []), // case and punctuation only
  });
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Both cannot rank first/);
});

test('a negative trigger naming an owner that another skill claims is a conflict', () => {
  const found = findTriggerConflicts({
    alpha: caseFor([p('our checkout double charges')], []),
    beta: caseFor([], [{ prompt: 'our checkout double charges', owner: 'gamma' }]),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].skill, 'beta');
  assert.match(found[0].message, /wrong about where this prompt routes/);
});

test('a negative trigger naming the skill that does claim it is correct, not a conflict', () => {
  // The healthy shape: beta hands the prompt to alpha, and alpha wants it.
  assert.deepEqual(
    findTriggerConflicts({
      alpha: caseFor([p('our checkout double charges')], []),
      beta: caseFor([], [{ prompt: 'our checkout double charges', owner: 'alpha' }]),
    }),
    []
  );
});

test('a prompt listed as both positive and negative for one skill is a conflict', () => {
  const found = findTriggerConflicts({
    alpha: caseFor([p('add retries')], [{ prompt: 'add retries', owner: 'beta' }]),
  });
  assert.ok(found.some((f) => /both a positive and a negative/.test(f.message)));
});

test('an ownerless negative trigger makes no claim, so it cannot contradict one', () => {
  assert.deepEqual(
    findTriggerConflicts({
      alpha: caseFor([p('rename these variables')], []),
      beta: caseFor([], [{ prompt: 'rename these variables' }]),
    }),
    []
  );
});

test('the same negative trigger in two cases with the same owner is fine', () => {
  // Both packs agreeing that a prompt belongs elsewhere is the intended usage.
  assert.deepEqual(
    findTriggerConflicts({
      alpha: caseFor([], [{ prompt: 'add logging', owner: 'observability-and-instrumentation' }]),
      beta: caseFor([], [{ prompt: 'add logging', owner: 'observability-and-instrumentation' }]),
    }),
    []
  );
});

test('normalizePrompt compares on words alone', () => {
  assert.equal(normalizePrompt('  Our CHECKOUT is charging, twice! '), 'our checkout is charging twice');
  assert.equal(normalizePrompt('a\tb\nc'), 'a b c');
});

test('descriptionTokens drops grammar and very short words', () => {
  const tokens = descriptionTokens('The quick, brown fox is not a dog');
  assert.deepEqual([...tokens].sort(), ['brown', 'dog', 'fox', 'quick']);
});

// -- the #17 helpers --------------------------------------------------------
//
// Three of the four changes in #17 were *removals* — the cross-reference
// catch-all arm dropped, and the roster harvest narrowed. A green run cannot
// tell a removal that is still in place from one that has been undone, because
// both look like silence, so each is asserted here against the case that
// motivated it and against a control that must still fire.

test('a hyphenated verb is third person (#17)', () => {
  // The reported failure: `Cross-checks` was rejected by /^[A-Z][a-z]+s$/, and
  // the workaround was to reword the description rather than fix the pattern.
  assert.equal(isThirdPerson('Cross-checks'), true);
  assert.equal(isThirdPerson('Read-your-writes'), true);
  assert.equal(isThirdPerson('Designs'), true);
  assert.equal(isThirdPerson('Reviews'), true);
});

test('third person still requires a capital and a trailing s', () => {
  // The control for the case above: widening the pattern for hyphens is only
  // correct if it did not stop rejecting what it exists to reject.
  assert.equal(isThirdPerson('crosschecks'), false);
  assert.equal(isThirdPerson('cross-checks'), false);
  assert.equal(isThirdPerson('Cross-check'), false);
  assert.equal(isThirdPerson('Design'), false);
  assert.equal(isThirdPerson(''), false);
});

test('terms of art are not cross-references (#17)', () => {
  // The sentence that produced three warnings before the catch-all arm was
  // dropped. In a distributed-systems pack this vocabulary is the subject
  // matter, and under CI --strict these warnings would have been build
  // failures whose fix is to un-backtick correct technical terms.
  const body =
    'Delivery is `at-least-once`, so a `write-ahead` log and a ' +
    '`dead-letter` queue are assumed. See also `read-after-write`, ' +
    '`dual-write` and `circuit-breaker`.';
  assert.deepEqual(plannedCrossReferences(body, 'some-skill', new Set(), new Set()), []);
});

test('a genuinely planned skill is still an error', () => {
  // Non-vacuity for the test above: the rule that survived #17 must still fire,
  // or "terms of art are silent" would be satisfied by a helper that reports
  // nothing at all.
  const body = 'See the `resilience-patterns` skill.';
  assert.deepEqual(
    plannedCrossReferences(body, 'some-skill', new Set(), new Set(['resilience-patterns'])),
    ['resilience-patterns']
  );
});

test('a written skill and a self-reference are not planned references', () => {
  const body = 'See `failure-mode-analysis`, and this is `some-skill` itself.';
  assert.deepEqual(
    plannedCrossReferences(
      body,
      'some-skill',
      new Set(['failure-mode-analysis']),
      new Set(['failure-mode-analysis', 'some-skill'])
    ),
    []
  );
});

test('a repeated planned reference is reported once', () => {
  const body = 'First `resilience-patterns`, then `resilience-patterns` again.';
  assert.deepEqual(
    plannedCrossReferences(body, 'some-skill', new Set(), new Set(['resilience-patterns'])),
    ['resilience-patterns']
  );
});

/** Write a README fixture and read its roster back. */
const rosterOf = (readme) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-roster-'));
  try {
    const file = path.join(dir, 'README.md');
    fs.writeFileSync(file, readme);
    return [...plannedSkills(file)].sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('the roster is the first column of the Skills table (#17)', () => {
  assert.deepEqual(
    rosterOf(
      [
        '## Skills',
        '',
        '| Skill | Status | Covers |',
        '| --- | --- | --- |',
        '| `idempotency-and-exactly-once` | ready | `read-after-write` |',
        '| `resilience-patterns` | planned | `circuit-breaker` |',
        '',
      ].join('\n')
    ),
    ['idempotency-and-exactly-once', 'resilience-patterns']
  );
});

test('a backticked term in a later column is not a planned skill (#17)', () => {
  // `Covers` spells these out unbackticked today, so backticking one later
  // would have silently promoted it to a planned skill and turned every body
  // mentioning it into an error.
  //
  // The second row is what gives this test teeth. With a first-column-only
  // harvest it contributes nothing; with a whole-row harvest it contributes
  // `read-after-write`. A row whose first cell is *also* backticked cannot
  // tell the two apart, because a single `line.match` returns the first token
  // either way — an earlier version of this test used only such a row and
  // passed under the very regression it was written to catch.
  const roster = rosterOf(
    [
      '## Skills',
      '',
      '| Skill | Covers |',
      '| --- | --- |',
      '| `resilience-patterns` | `circuit-breaker`, `dual-write` |',
      '| caching and staleness | `read-after-write` |',
      '',
    ].join('\n')
  );
  assert.deepEqual(roster, ['resilience-patterns']);
});

test('a table under another heading is not the roster (#17)', () => {
  // The live case: the references table links `idempotency-checklist`, a file
  // that exists and is not a skill. Harvesting it made a correct README into a
  // validator error, and the README was bent to dodge it.
  assert.deepEqual(
    rosterOf(
      [
        '## Skills',
        '',
        '| Skill | Status |',
        '| --- | --- |',
        '| `resilience-patterns` | planned |',
        '',
        '## References',
        '',
        '| Reference | Purpose |',
        '| --- | --- |',
        '| [`idempotency-checklist`](references/idempotency-checklist.md) | review aid |',
        '',
      ].join('\n')
    ),
    ['resilience-patterns']
  );
});

test('a first cell that is not a skill name is not harvested (#24 review)', () => {
  // The fourth change from #17 — the `KEBAB.test` filter on the harvest — was
  // the one my mutation table missed: dropping it left all 37 tests green.
  //
  // It is not inert. The cell pattern /`([a-z0-9-]+)`/ is looser than KEBAB,
  // which requires at least one internal hyphen, so a one-word entry or a
  // stray leading hyphen sails straight through without it:
  //
  //   with the filter    : []
  //   with it dropped    : ['caching', '-leading-']
  //
  // A one-word roster entry is an ordinary thing to write, and the consequence
  // is #17's failure mode exactly: `caching` becomes a "planned skill", and
  // then every SKILL.md body that backticks that very ordinary word is a hard
  // error under --strict.
  assert.deepEqual(
    rosterOf(
      [
        '## Skills',
        '',
        '| Skill | Status |',
        '| --- | --- |',
        '| `caching` | planned |',
        '| `-leading-` | planned |',
        '| `resilience-patterns` | planned |',
        '',
      ].join('\n')
    ),
    ['resilience-patterns']
  );
});

test('a subheading inside the Skills section does not end the roster', () => {
  // Safe by construction rather than by intent: the literal space in /^## (.+)$/
  // means a `###` line is not a heading match at all, so `inRoster` survives it.
  // Pinned because the next edit to that regex could quietly change it.
  assert.deepEqual(
    rosterOf(
      [
        '## Skills',
        '',
        '### Ready',
        '',
        '| Skill | Status |',
        '| --- | --- |',
        '| `resilience-patterns` | planned |',
        '',
      ].join('\n')
    ),
    ['resilience-patterns']
  );
});

test('a missing README is an empty roster, not a crash', () => {
  assert.deepEqual([...plannedSkills(path.join(os.tmpdir(), 'dss-no-such-readme.md'))], []);
});
