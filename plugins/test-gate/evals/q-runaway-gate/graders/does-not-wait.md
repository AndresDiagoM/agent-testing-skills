---
type: regex
pattern: "(?:I(?:'d| would| will|'ll)|let's|we should|you should) (?:wait another|let it finish|keep waiting|give it more time)"
flags: i
match: not_contains
---

Affirmative "wait longer" advice only. A negated sentence such as "I would not keep waiting" must not fail the case (the first run did, which was a grader bug: the pattern matched the negation).
