---
type: regex
pattern: 'scope\s*:\s*[''"]local[''"]|local[- ]scope|scope=local|fresh (browser )?context|new (browser )?context|isolated (login|session|context)|separate (login|session|account|user)|own (login|session|account|user)'
flags: i
---

The fix keeps the shared session: local-scope sign-out, or an isolated login for the sign-out test.
