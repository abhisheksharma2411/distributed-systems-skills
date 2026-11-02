# Recovery A/B — week 3 readout

**Owner:** payments-recovery
**Ramp:** 5% → 20% → 50% over three weeks, bumped on the Monday of each week
**Decision due:** Friday

## Headline

Hybrid recovers **4.1% more** failed invoices than decider (p = 0.03).
Recommendation on the table is to ramp to 100% next week.

## Numbers

| | invoices planned | invoices executed | recovered |
|---|---|---|---|
| hybrid arm | 18,402 | 19,951 | 7,104 |
| decider arm | 18,377 | 16,828 | 5,702 |

Planned counts are from `recovery.planned`, executed from `recovery.executed`.

## Questions raised in review, not yet resolved

- **The planned and executed totals do not match per arm.** Hybrid executed
  about 1,550 more than it planned; decider executed about 1,550 fewer. The
  overall totals reconcile. Analytics suggested the counters are tagged at
  different points in the flow and that the gap is probably a tagging
  artefact — nobody has traced an individual invoice end to end.
- **The effect looked larger in week 1 (6.2%) than week 3 (4.1%).** Assumed to
  be the usual novelty decay.
- **Ops turned `adaptive_retry` off for about four hours** on the Wednesday of
  week 2, during a provider incident. The readout includes that period; it was
  not thought to matter because the A/B flag stayed on.
- Two invoices in the hybrid arm have attempt histories where the gaps between
  attempts match neither ladder. Filed as a data quality issue.
