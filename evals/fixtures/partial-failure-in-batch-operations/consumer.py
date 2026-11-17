"""SQS consumer for inventory adjustments.

One message is one stock adjustment for one SKU. Batch size is 10.
"""

import os
import time

import boto3

import metrics_client

ddb = boto3.client("dynamodb")
metrics = metrics_client.client
TABLE = os.environ["INVENTORY_TABLE"]
MAX_ATTEMPTS = 25


def adjustment_key(context):
    """Idempotency key, so a redelivery cannot double-count an adjustment."""
    return f"inventory-adjust:{context.aws_request_id}"


def handler(event, context):
    key = adjustment_key(context)
    if already_applied(key):
        return

    requests = []
    for record in event["Records"]:
        body = parse(record["body"])
        requests.append(
            {
                "PutRequest": {
                    "Item": {
                        "sku": {"S": body["sku"]},
                        "delta": {"N": str(body["delta"])},
                        "updated_at": {"S": body["ts"]},
                    }
                }
            }
        )

    write_all(requests)
    mark_applied(key)
    metrics.increment("inventory.sync.batches_ok")


def write_all(requests):
    """Write the batch, retrying until DynamoDB accepts it."""
    batch = {TABLE: requests}
    for attempt in range(MAX_ATTEMPTS):
        try:
            resp = ddb.batch_write_item(RequestItems=batch)
            if resp["ResponseMetadata"]["HTTPStatusCode"] == 200:
                return
        except Exception as exc:  # noqa: BLE001
            print(f"batch write attempt {attempt} failed: {exc}")
            time.sleep(2**attempt)
    print("giving up on batch")
