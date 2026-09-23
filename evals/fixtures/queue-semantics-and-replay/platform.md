# Order pipeline — platform notes

**Broker.** Kafka. The platform team's onboarding doc says the cluster is
"configured for exactly-once semantics" — `processing.guarantee=exactly_once_v2`
is set on the Streams applications.

**Topics.** `orders.placed`, 12 partitions, keyed by `order_id`.
`orders.placed.dlq` has **30 days** retention.

**Idempotency.** The payments provider supports an `Idempotency-Key`. Our
`charge_customer` sends one derived from the order id, and the keys table has a
sweeper that deletes rows after **48 hours**.

**Consumers.** 6 replicas, deployed on merge to main — roughly 3× a day.

**Open incidents:**

- Support has 4 tickets this month from customers who never received an order
  they were charged for. We have not reproduced it.
- Finance flagged 9 double charges dated the day after the last DLQ drain.
- One partition stopped advancing for 40 minutes last week. It cleared after a
  restart. Nobody found the cause.
