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

const { stripFencedCode, parseFrontmatter } = require('./validate-skills.js');

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
