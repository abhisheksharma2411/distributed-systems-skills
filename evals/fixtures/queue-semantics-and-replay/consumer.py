"""Order-events consumer.

Subscribes to the `orders.placed` topic and fulfils each order: reserve stock,
charge the customer, send the confirmation. Runs 6 replicas.
"""

import logging

from .fulfilment import charge_customer, reserve_stock, send_confirmation
from .queue import consumer

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5


def handle(msg) -> None:
    order = msg.value
    msg.ack()

    try:
        reserve_stock(order["sku"], order["qty"])
        charge = charge_customer(order["customer_id"], order["total_cents"])
        send_confirmation(order["customer_id"], charge["id"])
    except Exception:
        log.exception("order %s failed", order["id"])
        raise


def run() -> None:
    for msg in consumer.subscribe("orders.placed", auto_ack=True):
        attempt = 0
        while True:
            try:
                handle(msg)
                break
            except Exception:
                attempt += 1
                if attempt >= MAX_ATTEMPTS:
                    log.error("giving up on order %s", msg.value["id"])
                    break
