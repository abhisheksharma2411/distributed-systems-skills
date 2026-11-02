"""Order service. Runs in eu-west-1 (primary) and ap-south-1 (replica).

Reads were moved off the primary last quarter to cut p99 on the order list.
"""

import time

import db  # db.primary() and db.replica() return connections
import events


def create_order(customer_id: str, items: list, region: str) -> dict:
    with db.primary() as conn:
        row = conn.execute(
            "INSERT INTO orders (customer_id, items, status) "
            "VALUES (%s, %s, 'placed') RETURNING *",
            (customer_id, items),
        ).fetchone()

    # Fires from whichever region served the request. The consumer reads the
    # order back from its own regional replica.
    events.publish("order.placed", {"order_id": row["id"], "region": region})
    return row


def get_order(order_id: str) -> dict:
    """Used by the confirmation page after checkout, and by the order list."""
    with db.replica() as conn:
        row = conn.execute("SELECT * FROM orders WHERE id = %s", (order_id,)).fetchone()
    if row is None:
        raise OrderNotFound(order_id)
    return row


def list_orders(customer_id: str, page: int) -> list:
    """Paginated. The UI fetches page 1, then page 2 as the user scrolls."""
    with db.replica() as conn:
        return conn.execute(
            "SELECT * FROM orders WHERE customer_id = %s "
            "ORDER BY created_at DESC LIMIT 50 OFFSET %s",
            (customer_id, page * 50),
        ).fetchall()


def handle_order_placed(event: dict) -> None:
    """Fulfilment consumer, running in ap-south-1."""
    order = get_order(event["order_id"])
    fulfilment.reserve_stock(order["items"])


def replica_healthy(conn) -> bool:
    """Health check for the read pool. Runs every 10s per replica."""
    try:
        conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def failover_if_primary_down() -> None:
    """Invoked by the regional health monitor."""
    if not _primary_responds(timeout=5):
        db.promote("ap-south-1")
        alert.page("promoted ap-south-1 after primary health check failed")


def _primary_responds(timeout: int) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with db.primary() as conn:
                conn.execute("SELECT 1")
            return True
        except Exception:
            time.sleep(0.5)
    return False
