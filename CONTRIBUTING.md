# Contributing

Contributions are welcome. This pack has a narrow remit, so the first question for any proposal is whether it belongs here at all.

## Scope

This pack covers **production correctness in distributed systems** — the defects that survive a green test suite and are found later by a reconciliation, an incident, or a customer.

In scope: idempotency and exactly-once effects, failure-mode analysis, cross-service consistency, resilience patterns, money-movement integrity.

Out of scope: general development-lifecycle skills. Those are well covered by [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), and duplicating them here helps nobody. If your idea is about testing discipline, code review, or shipping process, it probably belongs there.

## The quality bar

Every skill in this pack meets four conditions. A proposal that misses any of them will be sent back.

1. **Actionable, not advisory.** A numbered process with code, not a list of concepts to be aware of. "Use idempotency keys" is advice; "derive the key from the intent, not the attempt, and here are the four ways people get that wrong" is a process.
2. **Verifiable.** The skill ends with checks that fail concretely. The standard is: *if you cannot point at a test that fails when this logic is removed, the logic is undefended.*
3. **Rationalization-aware.** Name the excuses used to skip the practice and rebut them. Agents and engineers reach for the same ones, and a skill that doesn't anticipate them gets skipped under deadline pressure.
4. **Earned, not summarized.** Content should come from having operated the system, not from paraphrasing documentation. If it can be written by reading a wiki page, it does not need to be a skill.

## Adding a skill

1. Check the roster in [README.md](README.md) — several skills are already planned, and an edit to a planned skill is more useful than a competing one.
2. Create `skills/<kebab-case-name>/SKILL.md` with YAML frontmatter containing `name` and `description`. The `description` starts in third person with what the skill does, then one or more `Use when` triggers.
3. Follow the section anatomy: Overview, When to Use (including an explicit **NOT for** list that hands off to other skills), Process, Common Rationalizations, Red Flags, Verification.
4. Add an eval case at `evals/cases/<skill-name>.json` with at least 3 positive triggers, 2 negative triggers (routed to the skill that should own them), and 1 behavioral eval with an `expectations[]` array.
5. Back any execution eval with real files under `evals/fixtures/<skill-name>/`. A fixture should contain the actual defect the skill exists to catch, not a toy.

The format is deliberately compatible with [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), so a skill here can be submitted upstream without restructuring.

## Validating locally

Before opening a pull request, run the validator:

```bash
node scripts/validate-skills.js
```

It needs nothing beyond Node itself and checks the frontmatter, the section anatomy, the eval-case minimums above, that every `files[]` entry resolves to a real fixture directory, and that every `` `skill-name` `` cross-reference in a SKILL.md resolves to a skill that exists. It exits non-zero on any error; warnings are reported but do not fail the run unless you pass `--strict`.

## Cross-references

Skills point at each other rather than restating. If two skills need the same material, one owns it and the other links. Do not introduce a cross-reference to a skill that does not exist yet — mark it as planned in the README instead.

## Reporting a problem

If a skill gives advice that is wrong, or wrong in a context it claims to cover, open an issue with the scenario. A skill that fails in a real system is a defect, and that is the most valuable kind of report this pack can receive.
