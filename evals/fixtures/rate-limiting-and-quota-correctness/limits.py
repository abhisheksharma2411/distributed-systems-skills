"""Rate limiting and spend caps for the inference API.

Two limits, enforced in one place:

  * requests per minute, from the plan the tenant is on
  * a monthly spend cap in cents, also from the plan
"""

import time
from collections import defaultdict

from .billing import price_cents
from .db import db
from .redis_client import redis

PLAN_RPM = {"free": 60, "pro": 600, "enterprise": 6000}

_window_counts: dict[tuple[str, int], int] = defaultdict(int)


def check_rate(tenant_id: str, plan: str) -> bool:
    """True if this request is within the tenant's requests-per-minute limit."""
    window = int(time.time() // 60)
    _window_counts[(tenant_id, window)] += 1
    return _window_counts[(tenant_id, window)] <= PLAN_RPM[plan]


def check_quota(tenant_id: str, estimated_tokens: int) -> bool:
    """True if this request fits inside the tenant's remaining monthly budget."""
    period = time.strftime("%Y-%m")
    try:
        spent = int(redis.get(f"spend:{tenant_id}:{period}") or 0)
    except Exception:
        return True

    cap = db.query_one(
        "SELECT cap_cents FROM tenant_plans WHERE tenant_id = %s", (tenant_id,)
    )["cap_cents"]
    return spent + price_cents(estimated_tokens) <= cap


def record_spend(tenant_id: str, actual_tokens: int) -> None:
    period = time.strftime("%Y-%m")
    redis.incrby(f"spend:{tenant_id}:{period}", price_cents(actual_tokens))


def guard(tenant_id: str, plan: str, estimated_tokens: int):
    if not check_rate(tenant_id, plan):
        return 429, {"error": "rate_limited", "retry_after": 60}
    if not check_quota(tenant_id, estimated_tokens):
        return 429, {"error": "rate_limited", "retry_after": 60}
    return None
