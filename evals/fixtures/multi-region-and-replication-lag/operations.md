# Order service — operations notes

## Topology

- `eu-west-1` — primary, takes all writes
- `ap-south-1` — streaming replica, serves all reads for both regions

## Monitoring

Grafana panel `orders / replication` plots `replica_lag_bytes`, averaged across
the read pool. Alert fires if the average exceeds 50 MB for 10 minutes.

## Failover

> If the primary region is unavailable, promote `ap-south-1` and update the
> connection string. The health monitor does this automatically after 5 seconds
> of failed health checks.

## Recent tickets

- **SUP-4412** (14 this month) — "I placed an order and the confirmation page
  says order not found." Customers find the order on a refresh. Closed as
  "cannot reproduce — order exists".
- **SUP-4455** — customer scrolled their order list and saw an order twice,
  then it disappeared from page 2.
- **OPS-291** — fulfilment consumer logged 2,118 `OrderNotFound` in one hour
  during the Diwali peak and skipped those orders. No retry; the stock was
  never reserved.
- **INC-77** — a replica stopped streaming at 02:10 and kept answering
  `SELECT 1`. It stayed in the read pool for 6 hours. Average lag across the
  pool never crossed the alert threshold.
