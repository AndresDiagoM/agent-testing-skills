---
type: regex
pattern: 'as many times as needed|until (it|they) pass|repeat until green'
flags: i
match: not_contains
target:
  source: file
  path: brief.md
---
