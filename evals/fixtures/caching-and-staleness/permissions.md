# Context: document service permission cache

## How this is deployed

- 12 API pods behind a load balancer, each with its own `PermissionCache`
  instance. There is no shared cache tier.
- `invalidate_user` is called from the share/unshare handler **on the pod that
  served that request**. There is no cross-pod invalidation channel.
- The authz service is the source of truth. Revocations there are immediate.

## Paths that reach this code

- **Document read** — `can_access(user, doc)` gates the response body. A `True`
  return sends the document; a `False` returns 403.
- **Page render** — `list_shared_with(user)` builds the sidebar, then
  `can_access` is called per document in the list.
- **Unshare** — an owner removes a collaborator. The authz service is updated
  synchronously, then `invalidate_user` runs.
- **Compliance offboarding** — a batch job revokes all of a departing
  employee's access directly against the authz service. It does not call into
  the document service at all.

## What operators have reported

- After an unshare, the removed collaborator can sometimes still open the
  document. It stops "after a few minutes". Support has been telling users to
  wait.
- During an incident last quarter, an offboarded employee's session continued
  returning documents after the compliance job had run. Nobody could reproduce
  it on a second attempt.
- The authz service saw a load spike at the top of the hour, which is when the
  scheduled report job starts and many caches expire together.
