# Distributed Systems Skills

Agent skills for the correctness problems that only show up in production: retries that double-charge, replays that drift a ledger, partial failures that leave two systems disagreeing.

Most agent skill packs cover the development lifecycle — testing, review, refactoring, docs. This one covers the part that gets discovered by finance three months later.

> Distilled from fifteen years building commerce, pricing, payments, and fulfillment systems at scale — including idempotent payout pipelines serving 500M+ daily users and order pipelines at 20K TPM.

## Skills

| Skill | Covers | Status |
|---|---|---|
| [`idempotency-and-exactly-once`](skills/idempotency-and-exactly-once/SKILL.md) | Retry-safe side effects, dedup stores, atomic claims, reconciliation | ✅ Ready |
| `failure-mode-analysis` | Enumerating partial failures before writing the happy path; blast radius; graceful degradation | 🚧 Planned |
| `distributed-data-consistency` | Sagas, outbox pattern, compensations, read-after-write, dual-write elimination | 🚧 Planned |
| `resilience-patterns` | Timeouts, backoff, jitter, circuit breakers, bulkheads, backpressure, load shedding | 🚧 Planned |
| `money-movement-correctness` | Ledger invariants, double-entry, settlement windows, dispute handling, audit trails | 🚧 Planned |

## Design principles

Each skill follows the same contract:

- **Actionable, not advisory.** A process with steps and code, not a list of concepts to be aware of.
- **Verifiable.** Every skill ends with checks that fail concretely — "if you can't point at a test that breaks when this logic is removed, the logic is undefended."
- **Rationalization-aware.** Each skill names the excuses used to skip it, with rebuttals. Agents and engineers reach for the same ones.
- **Cross-referenced, not duplicated.** Skills point at each other rather than restating.

## Installation

Copy the skill directory into your agent's skills path:

```bash
# Claude Code
cp -r skills/idempotency-and-exactly-once ~/.claude/skills/

# Or install the whole pack
git clone https://github.com/abhisheksharma2411/distributed-systems-skills
cp -r distributed-systems-skills/skills/* ~/.claude/skills/
```

## Evals

Each skill ships an eval case under [`evals/cases/`](evals/cases/) defining positive triggers, negative triggers (routed to the skill that should own them), and behavioral expectations, backed by a real fixture under [`evals/fixtures/`](evals/fixtures/). See [`evals/README.md`](evals/README.md) for the format and the minimum bar.

The format is deliberately compatible with [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), so skills developed here can be submitted upstream unchanged. `idempotency-and-exactly-once` has been [submitted there as PR #479](https://github.com/addyosmani/agent-skills/pull/479), where it passes that repo's full validator suite (`validate-skills`, `validate-reference-links`, `validate-artifact-paths`, `validate-commands`, and `run-evals --min-rank1 80`) with zero errors and zero warnings.

## Roadmap

The skills above are the knowledge layer. The capability layer — an MCP server that inspects a running system for these properties rather than advising about them — is in progress: reading dedup stores, checking retry and timeout configuration, and replaying an effect ledger to answer *"did this agent double-charge anyone?"*

## License

MIT
