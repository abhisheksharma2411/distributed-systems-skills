# Changelog

Notable changes to this skill pack.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track the catalogue: a minor bump adds or materially reworks a skill.

## [0.1.0] — 2026-08-21

First tagged release. Two of the ten planned skills are complete, each with
eval coverage and a real fixture.

### Skills

- **`idempotency-and-exactly-once`** — retry-safe side effects, dedup stores,
  atomic claims, divergence detection, reconciliation, and retention as a
  correctness parameter rather than a cleanup detail.
- **`failure-mode-analysis`** — enumerating partial failures at design time,
  before the happy path is written: the three-outcome table, blast radius, and
  the degradation ladder.

### References

- **Idempotency review checklist** (`references/idempotency-checklist.md`) — the
  seven verification checks as a standalone pre-merge gate, each item a yes/no
  question with a named piece of evidence, so "considered" cannot pass as an
  answer. Contributed by @shaurya703 in #18.

### Evals

Each skill ships a case under `evals/cases/` with positive triggers, negative
triggers routed to the skill that should own them, and behavioural evals backed
by a fixture under `evals/fixtures/`.

### Compatibility

The format is deliberately compatible with
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), so
skills developed here can be submitted upstream unchanged.
`idempotency-and-exactly-once` was
[submitted there as PR #479](https://github.com/addyosmani/agent-skills/pull/479)
and merged, passing that repository's full validator suite with zero errors and
zero warnings.

[0.1.0]: https://github.com/abhisheksharma2411/distributed-systems-skills/releases/tag/v0.1.0
