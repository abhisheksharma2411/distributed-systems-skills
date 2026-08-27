#!/usr/bin/env node
'use strict';

// Every relative markdown link must point at a file that exists.
//
// A dead link in a skills pack is a silent failure: the agent following the
// reference simply does not get it, and nothing reports that it was missing.
// External (http/https), anchor-only (#section) and mailto links are left alone —
// this checks the one class we can verify offline and are responsible for.
//
// No dependencies beyond Node itself. Exit code 1 if any link is broken.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github']);

// [text](target) — target captured up to a closing paren or a whitespace-title.
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Markdown files, recursively, excluding infrastructure directories. */
function markdownFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...markdownFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.md')) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

// GitHub resolves `../../issues/12` against the repository root rather than the
// filesystem, so these are working links that no local path can satisfy. Treated
// as external because that is what they are — the check would otherwise report
// every issue reference in the README as broken, which is the fastest way to get
// a link checker switched off.
const GITHUB_RELATIVE_RE =
  /^(?:\.\.\/)+(?:issues|pull|pulls|discussions|wiki|releases|commit|commits|compare|blob|tree|labels|milestone|projects|actions|security)(?:\/|$)/;

const broken = [];
let checked = 0;

for (const file of markdownFiles(ROOT)) {
  const body = fs.readFileSync(file, 'utf8');
  for (const match of body.matchAll(LINK_RE)) {
    const target = match[1];
    // Anchor-only links stay inside a rendered page; we cannot resolve headings here.
    if (target.startsWith('#') || isExternal(target) || GITHUB_RELATIVE_RE.test(target)) continue;

    // A trailing anchor still identifies a real file, so resolve the path part.
    const [pathPart] = target.split('#');
    if (!pathPart) continue;

    checked += 1;
    const resolved = path.resolve(path.dirname(file), pathPart);
    if (!fs.existsSync(resolved)) {
      broken.push(`${path.relative(ROOT, file)} -> ${target}`);
    }
  }
}

for (const entry of broken) console.error(`ERROR broken link: ${entry}`);

const summary = `${checked} relative link(s) checked: ${broken.length} broken`;
if (broken.length > 0) {
  console.error(summary);
  process.exit(1);
}
console.log(summary);
