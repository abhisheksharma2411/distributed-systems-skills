"""Operational script: drain the dead-letter topic back into fulfilment.

Used after an incident once the downstream is healthy again. Last run was
eleven days after the messages were dead-lettered.
"""

from .db import db
from .fulfilment import charge_customer, reserve_stock
from .queue import consumer


def replay_dlq() -> int:
    replayed = 0
    for msg in consumer.drain("orders.placed.dlq"):
        order = msg.value
        reserve_stock(order["sku"], order["qty"])
        charge = charge_customer(order["customer_id"], order["total_cents"])
        db.execute(
            "UPDATE orders SET status = 'fulfilled', charge_id = %s WHERE id = %s",
            (charge["id"], order["id"]),
        )
        replayed += 1
    return replayed
