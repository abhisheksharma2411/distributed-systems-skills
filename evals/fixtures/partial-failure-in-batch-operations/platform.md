# Inventory sync — platform notes

**Source.** An SQS standard queue, `inventory.adjustments`. Each message is one
stock adjustment for one SKU. The Lambda consumer is configured with a batch
size of 10 and a visibility timeout of 60 seconds.

**Event source mapping.** Created from the console a year ago. Nobody has
opened its settings since; the Terraform for it is in `platform/` and has no
`function_response_types` block.

**Store.** DynamoDB table `inventory`, on-demand capacity. Writes go through
`batch_write_item`.

**Idempotency.** We key adjustments so a redelivery cannot double-count. The
key is built in `consumer.py`.

**Metrics.** `inventory.sync.batches_ok` is incremented once per successful
invocation. The dashboard built on it has read 99.98% for the last six months.

**Open incidents:**

- Warehouse reconciliation finds roughly 2% of SKUs drifting from the physical
  count every month. Nobody has reproduced it in staging.
- During a traffic spike in March the function ran to its 15-minute timeout
  repeatedly and the queue backed up. It cleared when the spike passed. The
  runbook now says "scale ahead of promotions".
- After a poison message last month we redrove the DLQ. Several SKUs that had
  been correct before the redrive were wrong afterwards.
