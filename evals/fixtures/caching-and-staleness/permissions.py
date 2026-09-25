"""Permission checks for the document service.

Moved behind a cache after the authz service became the p99 in document reads:
every page render fanned out one `can_access` call per document in the list,
and a 40-document page meant 40 round trips.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .authz import AuthzClient
from .metrics import timed

_TTL_SECONDS = 300


@dataclass
class _Entry:
    value: Any
    expires_at: float


class PermissionCache:
    """Process-local cache in front of the authz service."""

    def __init__(self, authz: AuthzClient) -> None:
        self._authz = authz
        self._entries: dict[str, _Entry] = {}

    def _get(self, key: str) -> Any | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.expires_at < time.time():
            del self._entries[key]
            return None
        return entry.value

    def _put(self, key: str, value: Any) -> None:
        self._entries[key] = _Entry(value=value, expires_at=time.time() + _TTL_SECONDS)

    @timed("permissions.can_access")
    def can_access(self, user_id: str, document_id: str) -> bool:
        """Whether `user_id` may read `document_id`."""
        key = f"can_access:{user_id}:{document_id}"
        cached = self._get(key)
        if cached is not None:
            return bool(cached)

        allowed = self._authz.check(user_id, document_id, action="read")
        self._put(key, allowed)
        return allowed

    @timed("permissions.list_shared")
    def list_shared_with(self, user_id: str) -> list[str]:
        """Document ids shared with this user.

        Cached on the same TTL as `can_access` so a page render is consistent
        with itself — the list and the per-document checks agree.
        """
        key = f"shared:{user_id}"
        cached = self._get(key)
        if cached is not None:
            return list(cached)

        shared = self._authz.list_documents(user_id, action="read")
        self._put(key, shared)
        return shared

    def invalidate_user(self, user_id: str) -> None:
        """Drop this user's entries after a share or unshare."""
        prefix_access = f"can_access:{user_id}:"
        for key in list(self._entries):
            if key.startswith(prefix_access) or key == f"shared:{user_id}":
                del self._entries[key]
