# What pgTAP cannot show, and what to use instead

## Cannot show in a rolled-back single-session transaction
- real JWT verification and the `signInWithPassword` token flow;
- PostgREST and supabase-js behaviour: `PGRST*` errors, a denied update returning `[]`;
- effects after COMMIT: deferred constraints, commit-time triggers;
- concurrent sessions and advisory locks (say so explicitly in the file header);
- cookies and server-side clients.

## Decision table
| Question | Layer |
|---|---|
| Can user B read or update A's row? | pgTAP |
| Does the app get `[]` instead of an exception? | client-level test |
| Does my hand-written fake match PostgREST? | parity test |
| Do two writers race? | not covered: say so in the report |

## Client-level test (optional)
`assets/client-rls.test.ts.tmpl` (Vitest + supabase-js, unverified until run):
- keys and URL from env vars (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`), never literals;
- refuses any non-loopback URL;
- users created with runtime-generated emails and passwords by the admin API;
- **one** `signInWithPassword` per user per file (auth rate limits; a local limit raised in `config.toml` is only a
  safety net, not the fix);
- the other user's read returns `[]`, their update returns zero rows and the row is re-read with the service client;
- cleanup deletes only the users the file created.
It uses no browser, so the Windows Chromium quirk does not apply. It does not replace the e2e login-once rule of the
`test-gate` skill.

## Parity of doubles
When unit tests use a hand-written fake of supabase-js or PostgREST, run the same contract cases against the fake and
against the real local stack. Pattern: a shared contract file, a fake backend and a real backend (a dedicated
runtime-generated user and a user client), cases the fake cannot reproduce marked as gaps with a reason, and the
real half off unless an env flag is set and the stack is loopback.
