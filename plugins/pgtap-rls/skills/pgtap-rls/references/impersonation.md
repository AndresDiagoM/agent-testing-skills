# Impersonation: one recipe

Three statements, always in this order, inside the file's `begin; ... rollback;`:

```sql
reset role;
select set_config('request.jwt.claims', '{"sub":"<owner-uuid>","role":"authenticated"}', true);
set local role authenticated;
```

`set_config(..., true)` and `set local role` last until the transaction ends, so `rollback` cleans both.

## Why this form
- `reset role` first: after `set local role authenticated` the session is no longer a superuser and cannot switch to
  another role.
- Claims are one JSON document in `request.jwt.claims`. It carries `sub`, `role`, `app_metadata`, anything
  `auth.jwt()` reads. A per-claim setting such as `request.jwt.claim.sub` is the legacy form, not used here.
- Build claims from ids: `jsonb_build_object('sub', '<uuid>', 'role', 'authenticated')::text` when a value comes from a variable.

## Roles
| Actor | Claims | Use |
|---|---|---|
| owner | `{"sub":"<A>","role":"authenticated"}` | allow cases and positive controls |
| other user | `{"sub":"<B>","role":"authenticated"}` | deny cases |
| anon | `{"role":"anon"}` (no `sub`), then `set local role anon` | deny cases |
| service_role | `{"role":"service_role"}`, then `set local role service_role` | seed, read back, one positive control (it bypasses RLS) |

Policies that read other claims (`auth.jwt() -> 'app_metadata' ->> 'k'`): add those keys to the JSON.

## Pitfalls
- **Stale claims.** `reset role; set local role anon;` without new claims leaves the previous user's claims set, so
  `auth.uid()` still returns that user while the role is anon, and a policy missing `to authenticated` stays hidden.
  Set claims on every switch.
- **Passing ids across roles.** Seed other users' rows as the migration role (before the first switch) or as that
  user. To carry ids over: `create temp table ids as select ...; grant select on ids to authenticated;`. Forgetting
  the grant yields `42501` that looks like an RLS result.
- **Triggers on `auth.users`** (profile rows, default data) fire on fixture inserts. Say so in the file header.
- **No literals that look like secrets:** ids are fixed UUID constants per file (`isolation-and-speed.md`), emails are
  `<file>-<role>@test.local`, and no token strings appear anywhere.
