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

const {
  stripFencedCode,
  parseFrontmatter,
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
