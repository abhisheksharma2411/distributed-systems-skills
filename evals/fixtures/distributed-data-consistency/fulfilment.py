"""Order fulfilment: mark paid, tell the warehouse, notify the customer.

Called from the payment webhook once the provider confirms a charge.
"""

from .cache import cache
from .db import db
from .events import events
from .inventory import inventory
from .notify import notify


def mark_paid_and_fulfil(order_id: str) -> None:
    order = db.query_one("SELECT * FROM orders WHERE id = %s", (order_id,))

    with db.transaction():
        db.execute(
            "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = %s",
            (order_id,),
        )
        cache.delete(f"order:{order_id}")

    events.publish("order.paid", {"order_id": order_id, "total": order["total_cents"]})

    reservation = inventory.reserve(order["sku"], order["qty"])
    shipment = create_shipment(order_id, reservation["id"])
    notify.email(order["customer_email"], "order_confirmed", {"shipment": shipment["id"]})

    db.execute(
        "UPDATE orders SET status = 'fulfilled', shipment_id = %s WHERE id = %s",
        (shipment["id"], order_id),
    )


def create_shipment(order_id: str, reservation_id: str) -> dict:
    resp = warehouse.post("/shipments", json={"order": order_id, "reservation": reservation_id})
    resp.raise_for_status()
    return resp.json()


def rollback(order_id: str) -> None:
    """Undo a failed fulfilment."""
    db.execute("UPDATE orders SET status = 'paid', shipment_id = NULL WHERE id = %s", (order_id,))
