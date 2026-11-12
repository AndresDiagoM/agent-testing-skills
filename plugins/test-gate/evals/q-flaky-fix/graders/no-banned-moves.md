---
type: regex
pattern: 'waitForTimeout|networkidle|waitForLoadState|toPass|\.first\(|\.last\(|\.nth\(|force:|dispatchEvent|fixme|\.skip\(|test\.slow|setTimeout'
match: not_contains
target:
  source: file
  path: e2e/reports.spec.ts
---
