---
type: regex
pattern: 'waitForTimeout|networkidle|toPass|\.first\(|fixme|\.skip\(|test\.slow'
match: not_contains
target:
  source: file
  path: e2e/reports.spec.ts
---
