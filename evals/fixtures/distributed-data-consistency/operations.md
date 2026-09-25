# Order pipeline — operations notes

**Topology.** `orders` is a Postgres database owned by the order service. The
warehouse, inventory and notification services are separate HTTP APIs owned by
other teams. Events go to Kafka; the analytics and finance teams both consume
`order.paid`.

**Monitoring.** We alert on: 5xx rate per service, p99 latency, pod restarts,
Kafka consumer lag, and database connection-pool saturation. All green for the
last ninety days.

**Deploys.** Rolling, roughly six a week across the four services.

**Open tickets nobody has tied together:**

- Finance reconciles Stripe against `orders` monthly. For the last three months
  the count of charges in Stripe has exceeded the count of `paid` orders by a
  small number — 4, then 7, then 6. Nobody has found the pattern; the amounts
  are unremarkable and the customers are unrelated.
- Support has 11 tickets this quarter from customers charged for an order that
  the warehouse has no record of. Each was resolved by re-sending it by hand.
- The analytics team asked why `order.paid` event counts are consistently ~1%
  below the number of paid orders in the database. They assumed sampling.
- One customer received two confirmation emails for the same order after a
  deploy. We could not reproduce it.

**Question raised at the last review and not answered:** the order service is
healthy on every dashboard we have. Where are these going?
