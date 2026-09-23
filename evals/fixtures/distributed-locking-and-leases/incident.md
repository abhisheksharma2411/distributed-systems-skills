# INC-2291 — merchant rollups doubled for 2026-03-14

**Symptom.** 31 of 4,100 merchants had `merchant_rollups.total_cents` exactly
double the sum of their settlements for the day. Finance found it during the
month-end close, eleven days later.

**What we know.**

- Both `app-7` and `app-11` logged "starting nightly rollup" for that day,
  eleven seconds apart. Neither logged an error.
- `app-7`'s JVM logged a 148-second stop-the-world pause beginning three
  seconds into its run. The pod's CPU was throttled to 4% for most of it.
- The lock key was present in Redis for the whole window. It was never
  observed missing.
- `app-11` finished normally. `app-7` resumed afterwards, finished its
  remaining merchants, and reported success.
- The 31 affected merchants are the tail of the settlement query's ordering —
  the ones `app-7` had not yet reached when it paused.

**Ruled out.** Duplicate settlement rows (checked, none). A retry of the cron
(checked, one trigger per replica per day, as designed). Clock skew between
`app-7` and `app-11` was under 400ms.

**Open question for review.** The lock was held throughout, and the job
re-checks that it still owns the lease before every write. We do not understand
how both replicas wrote.
