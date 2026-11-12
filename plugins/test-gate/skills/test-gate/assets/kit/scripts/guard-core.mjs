// @ts-check
// guard-core.mjs: pure core of e2e-guard.mjs (no git, no disk). Finds the ways an agent (a "healer") makes a failing test
// pass by weakening it instead of fixing the code: fewer assertions, skipped tests, bigger timeouts, retries, broader
// locators, looser matchers, deleted tests, sleeps. It compares the OLD and NEW text of every changed test file.
// Plain ESM, Node 20+, no dependencies. Design adopted from a reference project's test-guard (decision D16).
//
// Severity: BLOCK (exit 1 unless approved), REVIEW (a heuristic, never blocks), APPROVED (a BLOCK/REVIEW that has a
// `// test-guard: approved <reason>` comment that THIS change added on its line or just above it; `-- ...` in SQL). Count
// based findings (removed assertions/tests) are approved only by a newly added comment inside the removal hunk or within
// 3 lines of it / of the test() that lost the assertions, preferably `test-guard: approved-removal <n> <reason>` (n >=
// the number removed). The marker must open a comment; pre-existing approvals never approve anything new.
// The v0.1 line scanner (scanSource, judgeHits, ratchet baseline) lives at the end of this file and serves `--all`.

/**
 * @typedef {'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i'} Category
 * @typedef {'BLOCK' | 'REVIEW' | 'APPROVED'} Severity
 * @typedef {{ category: Category, rule: string, severity: Severity, baseSeverity: 'BLOCK' | 'REVIEW', file: string, line: number,
 *   message: string, old?: string, new?: string, approval?: { reason: string, line: number } }} Finding
 * @typedef {{ status: 'A' | 'M' | 'D' | 'R', oldPath: string | null, path: string, oldText: string | null, newText: string | null }} FilePair
 * @typedef {{ assertionHelpers: string[], arrayAssertionHelpers: string[], maxNewTimeoutMs: number, extraTestFiles: string[],
 *   approvedDeletions: Array<string | { path: string, reason?: string }>, testIgnore: string[] }} GuardConfig
 * @typedef {{ ok: boolean, counts: { files: number, block: number, approved: number, review: number }, findings: Finding[],
 *   approvals: Array<{ file: string, line: number, rule: string, reason: string }> }} GuardReport
 */




/** Always out of the suite, whatever the Playwright config says (generated drafts, parked `*.disabled` files). */
export const ALWAYS_OUT_OF_SUITE = ['**/generated/**', '**/*.disabled'];

/** @type {GuardConfig} */
export const DEFAULT_CONFIG = {
  // Functions that wrap assertions: a call counts as one assertion (moving an expect into a helper is not a loss).
  assertionHelpers: [],
  // Subset whose array argument holds one assertion per element: helper(page, [a, b]) counts 2.
  arrayAssertionHelpers: [],
  maxNewTimeoutMs: 5000,
  extraTestFiles: [],
  approvedDeletions: [],
  testIgnore: [],
};


// ------------------------------------------------------------------------------------------------- which files count

const TEST_FILE = [
  /\.(?:spec|test)\.[cm]?[jt]sx?$/,
  /\.e2e\.[cm]?[jt]sx?$/,
  /\.(?:setup|teardown)\.[cm]?[jt]sx?$/,
  /(?:^|\/)supabase\/tests\/.*\.sql$/,
  /(?:^|\/)playwright\.config\.[^/]+$/,
  /(?:^|\/)vitest\.config\.[^/]+$/,
];

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const normPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function isTestFile(path, config = DEFAULT_CONFIG) {
  const p = normPath(path);
  return TEST_FILE.some((re) => re.test(p)) || config.extraTestFiles.some((g) => globToRegExp(g).test(p));
}

const isSql = (path) => /\.sql$/i.test(path);

/** String literals of the `testIgnore:` expression(s) of a Playwright config text (data only, nothing is executed). */
export function parseTestIgnore(configText) {
  const out = [];
  for (const m of configText.matchAll(/\btestIgnore\s*:/g)) {
    let depth = 0;
    let quote = '';
    let seg = '';
    for (let i = m.index + m[0].length; i < configText.length; i++) {
      const c = configText[i];
      if (quote) {
        seg += c;
        if (c === '\\') seg += configText[++i] ?? '';
        else if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '[' || c === '(' || c === '{') depth++;
      else if (c === ']' || c === ')' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ',' || c === ';') && depth === 0) break;
      seg += c;
    }
    for (const lit of seg.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) out.push(lit[2]);
  }
  return out;
}

/** True when `path` matches an ignore glob (a glob without `/` matches by file name at any depth). */
export function isOutOfSuite(path, config = DEFAULT_CONFIG) {
  const p = normPath(path);
  return [...ALWAYS_OUT_OF_SUITE, ...(config.testIgnore ?? [])].some((g) => {
    const glob = normPath(g);
    return globToRegExp(glob).test(p) || (!glob.startsWith('**/') && !glob.startsWith('/') && globToRegExp(`**/${glob}`).test(p));
  });
}

// ------------------------------------------------------------------------------------------------------------ masking

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'await', 'yield']);

const keepNl = (c) => (c === '\n' ? '\n' : ' ');

/**
 * Same length and same newlines as `src`, but comments and the CONTENT of strings, templates and regex literals are
 * blanked, so `expect(` inside a comment or a fixture string is never counted and columns still line up with `src`.
 */
export function maskTs(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let lastSig = '';
  let word = '';
  let lastWord = '';
  const sig = (c) => {
    if (/[\w$]/.test(c)) word += c;
    else if (word) {
      lastWord = word;
      word = '';
    }
    if (!/\s/.test(c)) lastSig = c;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) out.push(keepNl(src[i++]));
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(' ', keepNl(src[i + 1]));
          i += 2;
        } else {
          out.push(' ');
          i++;
        }
      }
      if (src[i] === c) {
        out.push(c);
        i++;
      }
      sig(c);
      continue;
    }
    if (c === '`') {
      out.push(c);
      i++;
      let depth = 0;
      while (i < n && !(src[i] === '`' && depth === 0)) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          out.push(' ', keepNl(src[i + 1]));
          i += 2;
          continue;
        }
        if (ch === '$' && src[i + 1] === '{') depth++;
        else if (ch === '}' && depth > 0) depth--;
        out.push(keepNl(ch));
        i++;
      }
      if (src[i] === '`') {
        out.push('`');
        i++;
      }
      sig('`');
      continue;
    }
    if (c === '/') {
      const regexAllowed = REGEX_PREV.has(lastSig) || (/[A-Za-z]/.test(lastSig) && REGEX_AFTER_WORD.has(lastWord) && word === '');
      if (regexAllowed && !/[\w$]$/.test(word)) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') j++;
          else if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            ok = true;
            break;
          }
          j++;
        }
        if (ok) {
          out.push('/');
          for (let k = i + 1; k < j; k++) out.push(' ');
          out.push('/');
          i = j + 1;
          sig('/');
          continue;
        }
      }
    }
    out.push(c);
    sig(c);
    i++;
  }
  return out.join('');
}

/** SQL twin of maskTs: `--` and block comments, '...' strings and $tag$...$tag$ bodies are blanked. */
export function maskSql(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) out.push(keepNl(src[i++]));
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      out.push(c);
      i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") {
          out.push(' ', ' ');
          i += 2;
        } else if (src[i] === "'") break;
        else out.push(keepNl(src[i++]));
      }
      if (i < n) {
        out.push("'");
        i++;
      }
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 40));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end !== -1) {
          out.push(tag);
          for (let k = i + tag.length; k < end; k++) out.push(keepNl(src[k]));
          out.push(tag);
          i = end + tag.length;
          continue;
        }
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// ------------------------------------------------------------------------------------------------------- line diffing


/** Changed regions between two line arrays (compared trimmed). Common prefix and suffix are trimmed, the rest is an LCS. */
export function diffBlocks(a, b) {
  const ta = a.map((l) => l.trim());
  const tb = b.map((l) => l.trim());
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
  const n = ta.length - pre - suf;
  const m = tb.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > 4_000_000) return [{ oldStart: pre, oldEnd: pre + n, newStart: pre, newEnd: pre + m }];
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ta[pre + i] === tb[pre + j] ? (t[(i + 1) * w + j + 1]) + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const blocks = [];
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && ta[pre + i] === tb[pre + j]) {
      flush();
      i++;
      j++;
    } else {
      const block = cur ?? { oldStart: pre + i, oldEnd: pre + i, newStart: pre + j, newEnd: pre + j };
      cur = block;
      if (j < m && (i >= n || (t[i * w + j + 1]) >= (t[(i + 1) * w + j]))) {
        j++;
        block.newEnd = pre + j;
      } else {
        i++;
        block.oldEnd = pre + i;
      }
    }
  }
  flush();
  return blocks;
}

// Trailing comments (an added approval, a reworded note) must not stop an edited statement from pairing with its old self.
const normalizeForPair = (l) =>
  l
    .replace(/\s(?:\/\/|--)\s.*$/, '')
    .trim()
    .replace(/[\d_]+(?:\.\d+)?/g, '0')
    .replace(/\s+/g, ' ');

function bigrams(s) {
  const m = new Map ();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  for (const [g, c] of ga) inter += Math.min(c, gb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}


const PAIR_THRESHOLD = 0.5;

/** Lines added/removed between two texts, with moved lines cancelled and edited lines paired. */
export function computeChange(oldLines, newLines) {
  const blocks = diffBlocks(oldLines, newLines);
  const removedBy = new Map ();
  for (const b of blocks) {
    for (let i = b.oldStart; i < b.oldEnd; i++) {
      const key = (oldLines[i]).trim();
      const list = removedBy.get(key);
      if (list) list.push(i);
      else removedBy.set(key, [i]);
    }
  }
  const cancelledOld = new Set();
  const cancelledNew = new Set();
  for (const b of blocks) {
    for (let j = b.newStart; j < b.newEnd; j++) {
      const key = (newLines[j]).trim();
      if (key === '') continue;
      const list = removedBy.get(key);
      const i = list?.shift();
      if (i !== undefined) {
        cancelledOld.add(i);
        cancelledNew.add(j);
      }
    }
  }
  const change = { removed: [], added: [], pairs: [], anchorOf: new Map(), hunkOf: new Map() };
  for (const b of blocks) {
    const rem = [];
    const add = [];
    for (let i = b.oldStart; i < b.oldEnd; i++) if (!cancelledOld.has(i) && (oldLines[i]).trim() !== '') rem.push(i);
    for (let j = b.newStart; j < b.newEnd; j++) if (!cancelledNew.has(j) && (newLines[j]).trim() !== '') add.push(j);
    for (const i of rem) {
      change.anchorOf.set(i, Math.min(b.newStart, Math.max(0, newLines.length - 1)));
      change.hunkOf.set(i, [b.newStart, b.newEnd]);
    }
    change.removed.push(...rem);
    change.added.push(...add);
    if (rem.length && add.length) {
      const nr = rem.map((i) => normalizeForPair(oldLines[i]));
      const na = add.map((j) => normalizeForPair(newLines[j]));
      if (rem.length * add.length <= 40_000) {
        const cand = [];
        for (let x = 0; x < rem.length; x++) for (let y = 0; y < add.length; y++) cand.push([dice(nr[x], na[y]), x, y]);
        cand.sort((p, q) => q[0] - p[0] || p[1] - q[1] || p[2] - q[2]);
        const usedR = new Set();
        const usedA = new Set();
        for (const [score, x, y] of cand) {
          if (score < PAIR_THRESHOLD) break;
          if (usedR.has(x) || usedA.has(y)) continue;
          usedR.add(x);
          usedA.add(y);
          change.pairs.push([rem[x], add[y]]);
        }
      } else {
        const byKey = new Map ();
        nr.forEach((k, x) => {
          const list = byKey.get(k);
          if (list) list.push(x);
          else byKey.set(k, [x]);
        });
        na.forEach((k, y) => {
          const x = byKey.get(k)?.shift();
          if (x !== undefined) change.pairs.push([rem[x], add[y]]);
        });
      }
    }
  }
  return change;
}

// ------------------------------------------------------------------------------------------------------- approvals

// The marker must follow a comment opener: `//` or `/*` anywhere, `--` / `#` after whitespace, `*` at the start of a line.
const APPROVAL = /(?:\/\/|\/\*|(?:^|\s)(?:--|#)|^\s*\*)\s*test-guard:\s*approved(?!-removal)\b[\s:,-]*(.*?)\s*(?:\*\/)?\s*$/;
/** `test-guard: approved-removal <n> <reason>`: approves up to n removed assertions/tests. */
const APPROVAL_REMOVAL = /(?:\/\/|\/\*|(?:^|\s)(?:--|#)|^\s*\*)\s*test-guard:\s*approved-removal\s+(\d+)\s+(.*?)\s*(?:\*\/)?\s*$/;



function approvalAt(lines, i, ctx, explicit) {
  const line = lines[i] ?? '';
  if (ctx.added && !ctx.added.has(i)) return null;
  const m = (explicit ? APPROVAL_REMOVAL : APPROVAL).exec(line);
  if (!m) return null;
  const pos = m.index + Math.max(0, m[0].search(/\S/));
  const maskedLine = ctx.masked?.[i];
  if (maskedLine !== undefined) {
    // A real comment is blanked by the masker and sits outside every string (quote delimiters of the prefix pair up).
    if (maskedLine[pos] !== undefined && maskedLine[pos] !== ' ') return null;
    if (((maskedLine.slice(0, pos).match(/['"`]/g) ?? []).length & 1) === 1) return null;
  }
  const comment = line.slice(pos).trim();
  if (ctx.oldText !== undefined && ctx.oldText.includes(comment)) return null;
  const reason = (explicit ? (m[2] ?? '') : (m[1] ?? '')).trim();
  if (!reason) return null;
  return explicit ? { reason, line: i + 1, n: Number(m[1]) } : { reason, line: i + 1 };
}

/** An approval on the line itself or in the comment lines / statement lines directly above it (max 8 lines up). */
export function findApproval(lines, idx, ctx = {}) {
  const own = approvalAt(lines, idx, ctx, false);
  if (own) return own;
  for (let i = idx - 1; i >= 0 && idx - i <= 8; i--) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || /;\s*$/.test(t.replace(/\s*(?:\/\/|--).*$/, ''))) break;
    const found = approvalAt(lines, i, ctx, false);
    if (found) return found;
  }
  return null;
}

/**
 * Approval of a count based finding (removed assertions/tests): a comment this change ADDED, inside one of the windows
 * (the removal hunk, or at most 3 lines around the removal anchor / the test() that lost assertions). The explicit form
 * `approved-removal <n> <reason>` needs n >= `need`; the plain `approved <reason>` form is accepted too, with the same anchoring.
 */
export function findAnchoredApproval(lines, windows, need, ctx) {
  const seen = new Set();
  for (const [lo, hi] of windows) for (let i = Math.max(0, lo); i <= Math.min(lines.length - 1, hi); i++) seen.add(i);
  for (const i of [...seen].sort((a, b) => a - b)) {
    const explicit = approvalAt(lines, i, ctx, true);
    if (explicit && (need === undefined || (explicit.n) >= need)) return explicit;
    const generic = approvalAt(lines, i, ctx, false);
    if (generic) return generic;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------------------- rules

const NOT_AFTER = '(?<![\\w$.])';
// `expect(async () => {...}).toPass()` is a retry wrapper, not an assertion: the expects inside it count on their own.
const ASSERT_TS = [new RegExp(`${NOT_AFTER}expect(?:\\.(?:soft|poll))?\\s*\\((?!\\s*(?:async\\b|\\([^)]*\\)\\s*=>|\\w+\\s*=>))`, 'g'), new RegExp(`${NOT_AFTER}assert(?:\\.\\w+)?\\s*\\(`, 'g'), new RegExp(`${NOT_AFTER}expectTypeOf\\s*\\(`, 'g')];
const PGTAP_NAMES =
  '(?:ok|is|isnt|pass|fail|cmp_ok|isa_ok|is_\\w+|isnt_\\w+|has_\\w+|hasnt_\\w+|\\w+_are|results_(?:eq|ne)|(?:set|bag)_(?:eq|ne|has|hasnt)|row_eq|throws_\\w+|lives_ok|performs_\\w+|col_\\w+|fk_ok|can|cannot|policy_\\w+|function_returns|trigger_is|\\w+_privs_are)';
const ASSERT_SQL = new RegExp(`${NOT_AFTER}${PGTAP_NAMES}\\s*\\(`, 'gi');
const PLAN = /(?<![\w$.])plan\s*\(\s*(\d+)\s*\)/gi;

/** Elements of the first `[...]` that follows `from` on the line (top-level commas + 1), or 1 when it is not one line. */
function arrayElements(line, from) {
  const open = line.indexOf('[', from);
  if (open === -1) return 1;
  let depth = 0;
  let commas = 0;
  let filled = false;
  for (let i = open + 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') {
      if (depth === 0) return filled ? commas + 1 - (/,\s*$/.test(line.slice(open + 1, i)) ? 1 : 0) : 1;
      depth--;
    } else if (ch === ',' && depth === 0) commas++;
    else if (!/\s/.test(ch)) filled = true;
  }
  return 1;
}

const escapeRe = (h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Assertion count per line of an already masked text, helper calls included. */
export function assertionsPerLine(masked, sql, helpers, arrayHelpers = []) {
  const helperRe = helpers.length ? new RegExp(`(?<![\\w$])(${helpers.map(escapeRe).join('|')})\\s*\\(`, 'g') : null;
  const arrays = new Set(arrayHelpers);
  return masked.map((line) => {
    let n = 0;
    if (sql) n += (line.match(ASSERT_SQL) ?? []).length;
    else {
      for (const re of ASSERT_TS) n += (line.match(re) ?? []).length;
      if (helperRe) {
        for (const m of line.matchAll(helperRe)) {
          if (/(?:function|async|class|get|set)\s+$/.test(line.slice(0, m.index))) continue;
          n += arrays.has(m[1]) ? arrayElements(line, m.index + m[0].length) : 1;
        }
      }
    }
    return n;
  });
}

const TEST_CALL = /(?<![\w$.])(?:test|it)(?:\.only)?\s*\(|(?<![\w$.])(?:test|it)\.each\b/g;
const SKIP_TS = [
  /(?<![\w$.])(?:test|it|describe|suite)(?:\.\w+)*?\.(skip|fixme|only|fail|todo|skipIf)\b/,
  /(?<![\w$.])(xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /(?<![\w$])(testIgnore|grepInvert)\s*:/,
];
const SKIP_SQL = /(?<![\w$.])(skip|todo|todo_start|todo_skip)\s*\(/i;
const TIMEOUT_KEY = /\b(timeout|testTimeout|hookTimeout|actionTimeout|navigationTimeout|globalTimeout|teardownTimeout|expectTimeout)\s*:\s*([\w$.*\s]+?)\s*(?=[,})\n;]|$)/;
const TIMEOUT_CALL = /\b(?:test\.setTimeout|setTimeout|setDefaultTimeout|setDefaultNavigationTimeout|vi\.setConfig)\s*\(\s*([\w$.*\s]+?)\s*,?\s*\)/;
const CONST_NUM = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([\w$.*\s]+?)\s*;?\s*$/;
const SLOW = /(?<![\w$.])test\.slow\s*\(/;
const RETRY = /\b(retries|retry)\s*:\s*([^,}\n]+)/;
const SLEEP = [/\.waitForTimeout\s*\(/, /(?<![\w$.])sleep\s*\(/, /new\s+Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\s*\(/];
const TOPASS = /\.toPass\s*\(/;
const LOCATOR_FIRST =/\.(?:first|last)\s*\(\s*\)|\.nth\s*\(/;

/**
 * Evaluates `45_000`, `10 * 1000`, `1e4`, and names of simple numeric consts of the same file (`consts`). NaN when it is
 * anything else. 0 means "no timeout" and becomes Infinity.
 */
export function evalMs(expr, consts) {
  const s = expr.trim();
  if (s === '') return NaN;
  let v = 1;
  for (const part of s.split('*')) {
    const t = part.trim();
    let x;
    if (/^[0-9_.e]+$/.test(t)) x = Number(t.replace(/_/g, ''));
    else if (/^[A-Za-z_$][\w$]*$/.test(t) && consts?.has(t)) x = consts.get(t);
    else return NaN;
    if (Number.isNaN(x)) return NaN;
    v *= x;
  }
  return v === 0 ? Infinity : v;
}

/** `const X = 60_000;` declarations of a masked file (value in ms; evaluated in order, so `const B = A * 2` works). */
export function numericConsts(masked) {
  const consts = new Map ();
  for (const line of masked) {
    const m = CONST_NUM.exec(line);
    if (!m) continue;
    const v = evalMs(m[2], consts);
    if (!Number.isNaN(v)) consts.set(m[1], v);
  }
  return consts;
}

/** The timeout (ms, Infinity for 0, 'slow' for test.slow()) a masked statement sets, or null. */
export function timeoutOf(masked, consts) {
  if (SLOW.test(masked)) return 'slow';
  // Masked on purpose: a `timeout: 30_000` inside a string or a comment is not a timeout.
  const key = TIMEOUT_KEY.exec(masked);
  if (key) {
    const v = evalMs(key[2], consts);
    if (!Number.isNaN(v)) return v;
  }
  const call = TIMEOUT_CALL.exec(masked);
  if (call) {
    const v = evalMs(call[1], consts);
    if (!Number.isNaN(v)) return v;
  }
  return null;
}

/** `waitForLoadState('networkidle')` or `waitUntil: 'networkidle'`: code in the masked line, the string in the raw one. */
function isNetworkIdle(masked, raw) {
  return /\b(?:waitForLoadState\s*\(|waitUntil\s*:)/.test(masked) && /['"`]networkidle['"`]/.test(raw);
}

const fmtMs = (v) => (v === null ? 'default' : v === 'slow' ? 'test.slow()' : v === Infinity ? 'no timeout' : `${v}`);

/** Highest retry count a masked line configures (conditional expressions count their biggest branch), or null. */
export function retriesOf(masked) {
  const m = RETRY.exec(masked);
  if (!m) return null;
  const nums = [...(m[2]).matchAll(/\d+/g)].map((x) => Number(x[0]));
  return nums.length ? Math.max(...nums) : null;
}


export function parseMatcher(masked, raw) {
  const m = /\.(not\.)?(to[A-Z]\w*)\s*\(/.exec(masked);
  if (!m) return null;
  const open = m.index + m[0].length;
  let depth = 1;
  let j = open;
  while (j < raw.length && depth > 0) {
    const ch = raw[j];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    j++;
  }
  return { not: Boolean(m[1]), name: m[2], args: raw.slice(open, depth === 0 ? j - 1 : j).trim() };
}

/** Higher = stricter. Matchers that are not here are not compared. */
const STRICTNESS = {
  toStrictEqual: 5,
  toEqual: 4,
  toBe: 4,
  toHaveText: 4,
  toHaveValue: 4,
  toHaveLength: 4,
  toHaveCount: 4,
  toHaveURL: 4,
  toHaveTitle: 4,
  toHaveAttribute: 4,
  toHaveClass: 4,
  toBeNull: 4,
  toBeUndefined: 4,
  toMatchObject: 3,
  toContain: 3,
  toContainEqual: 3,
  toContainText: 3,
  toMatch: 3,
  toBeCloseTo: 3,
  toHaveProperty: 3,
  toBeGreaterThan: 2,
  toBeGreaterThanOrEqual: 2,
  toBeLessThan: 2,
  toBeLessThanOrEqual: 2,
  toBeVisible: 2,
  toBeEnabled: 2,
  toBeAttached: 1,
  toBeTruthy: 1,
  toBeFalsy: 1,
  toBeDefined: 1,
};

const isRegexArg = (a) => /^\//.test(a);
const regexSource = (a) => {
  const end = a.lastIndexOf('/');
  return end > 0 ? a.slice(1, end) : a.slice(1);
};
/** Regex bodies that match any string: `.`, `.+`, `.*` (with or without ^ $). */
const MATCH_ANYTHING = /^\^?\.[+*]?\$?$/;
const LOOSE_BITS = /\.\*|\.\+|\\w\*|\\S\*|\||\?|\[\^/g;

/** Why `to` is a weaker assertion than `from` (heuristic), or null. */
export function looseningReason(from, to) {
  if (from.not !== to.not) return from.not ? 'negation removed (.not dropped)' : 'negation added (.not)';
  if (isRegexArg(to.args) && MATCH_ANYTHING.test(regexSource(to.args)) && !(isRegexArg(from.args) && MATCH_ANYTHING.test(regexSource(from.args)))) return `${from.name} -> ${to.name}: regex now matches anything`;
  if (from.name !== to.name) {
    const a = STRICTNESS[from.name];
    const b = STRICTNESS[to.name];
    if (a !== undefined && b !== undefined && b < a) return `${from.name} -> ${to.name}`;
    return null;
  }
  if (from.name === 'toBeCloseTo') {
    const pa = Number(from.args.split(',')[1]?.trim() ?? '2');
    const pb = Number(to.args.split(',')[1]?.trim() ?? '2');
    if (Number.isFinite(pa) && Number.isFinite(pb) && pb < pa) return `toBeCloseTo precision ${pa} -> ${pb}`;
    return null;
  }
  const fa = from.args;
  const fb = to.args;
  // `toHaveText('x')` -> `toHaveText()`: the value argument is gone (an options object `{ timeout }` is not a value).
  if (fa !== '' && !fa.startsWith('{') && fb === '') return `${from.name}: argument removed`;
  if (!isRegexArg(fa) && isRegexArg(fb) && /^['"`]/.test(fa)) return `${from.name}: exact string -> regex`;
  if (isRegexArg(fa) && isRegexArg(fb) && fa !== fb) {
    const sa = regexSource(fa);
    const sb = regexSource(fb);
    if ((sa.startsWith('^') && !sb.startsWith('^')) || (sa.endsWith('$') && !sb.endsWith('$'))) return `${from.name}: regex anchor removed`;
    if ((sb.match(LOOSE_BITS) ?? []).length > (sa.match(LOOSE_BITS) ?? []).length) return `${from.name}: regex made looser (.*, ?, |)`;
    if (sa.length >= 8 && sb.length < sa.length * 0.6) return `${from.name}: regex much shorter`;
  }
  return null;
}

const STRONG_LOCATOR = /\.(?:getByTestId|getByRole|getByLabel)\s*\(/;
const WEAK_LOCATOR = /\.(?:locator|getByText|getByPlaceholder|getByTitle|getByAltText)\s*\(/;

// ---------------------------------------------------------------------------------------------------------- analysis

/** Lines of a file (CRLF normalised); an absent or empty file has none. */
function splitLines(text) {
  const t = (text ?? '').replace(/\r\n/g, '\n');
  return t === '' ? [] : t.split('\n');
}

function takeFromPool(pool, line) {
  const key = line.trim();
  const n = pool.get(key) ?? 0;
  if (key === '' || n <= 0) return false;
  pool.set(key, n - 1);
  return true;
}



function sev(category) {
  return category === 'e' || category === 'f' ? 'REVIEW' : 'BLOCK';
}

/** Lines around a removal in which an approval comment may sit. */
const APPROVAL_REACH = 3;

// ------------------------------------------------------------------------------------------------------- statements


const parenDepth = (m) => {
  let d = 0;
  for (const c of m) {
    if (c === '(' || c === '[') d++;
    else if (c === ')' || c === ']') d--;
  }
  return d;
};

const braceDepth = (m) => (m.match(/\{/g) ?? []).length - (m.match(/\}/g) ?? []).length;

/**
 * Splits a file into statements: a line plus the lines that continue it (open parens/brackets, or a `.method()` chain on
 * the next line), up to `;` or an unclosed `{`. The first line is always taken whole, so a one-liner is its own statement.
 */
export function segmentStatements(masked, raw) {
  const stmts = [];
  const of = new Array(masked.length).fill(0);
  const MAX_LINES = 12;
  for (let i = 0; i < masked.length; ) {
    let end = i;
    let m = masked[i];
    let r = raw[i];
    while (end + 1 < masked.length && end - i < MAX_LINES && !m.includes(';') && braceDepth(m) <= 0) {
      const next = masked[end + 1];
      if (next.trim() === '') break;
      const chain = /^\s*\??\./.test(next);
      if (!(parenDepth(m) > 0 || chain)) break;
      end++;
      m += ` ${next}`;
      r += ` ${raw[end] }`;
    }
    const st = { start: i, end, masked: m, raw: r };
    stmts.push(st);
    for (let k = i; k <= end; k++) of[k] = stmts.length - 1;
    i = end + 1;
  }
  return { stmts, of };
}

/** Index of the paren that closes the one opened at `open` in a masked text, or -1. */
function matchParen(m, open) {
  let d = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === '(') d++;
    else if (m[i] === ')' && --d === 0) return i;
  }
  return -1;
}

const EXPECT_CALL = /(?<![\w$.])expect(?:\.(?:soft|poll))?\s*\(/g;

/** True when the text between a call's parens has a top-level comma followed by something: a second argument. */
function hasSecondArgument(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(i + 1).trim() !== '';
  }
  return false;
}

/**
 * `expect(...)...catch(` or `expect(...)...then(ok, onRejected)`: the failure of the assertion is swallowed.
 * `.then(null, fn)`, `.then(undefined, fn)` and `.then(fn, fn)` all hand the rejection to the second callback;
 * a `.then(fn)` with one argument does not.
 */
export function isSwallowedAssertion(masked) {
  for (const m of masked.matchAll(EXPECT_CALL)) {
    const close = matchParen(masked, m.index + m[0].length - 1);
    if (close === -1) continue;
    const rest = masked.slice(close + 1);
    if (/\.\s*catch\s*\(/.test(rest)) return true;
    for (const t of rest.matchAll(/\.\s*then\s*\(/g)) {
      const open = t.index + t[0].length - 1;
      const end = matchParen(rest, open);
      if (end !== -1 && hasSecondArgument(rest.slice(open + 1, end))) return true;
    }
  }
  return false;
}

const LITERAL_SUBJECT = /(?<![\w$.])expect(?:\.soft)?\s*\(\s*(?:true|false|null|undefined|-?\d[\w.]*|(['"`])\s*\1)\s*(?:,[^)]*)?\)\s*\.\s*(?:not\s*\.\s*)?to[A-Z]/g;

/** `expect(true).toBe(true)`: the subject is a literal, so the assertion can never fail for a reason in the app. */
export function isTautology(masked, raw) {
  for (const m of masked.matchAll(LITERAL_SUBJECT)) {
    if (m[1] === '`' && raw.slice(m.index, m.index + m[0].length).includes('${')) continue;
    return true;
  }
  return false;
}

const EXPECT_START = String.raw`(?:await\s+)?expect(?:\.(?:soft|poll))?\s*\(`;
/** `cond && expect(...)`, `cond || expect(...)`, `cond ?? expect(...)`: the right side only runs sometimes. */
const SHORT_CIRCUIT_EXPECT = new RegExp(String.raw`(?:&&|\|\||\?\?)\s*(?:\(\s*)?${EXPECT_START}`);
/** A lone `?` (not optional chaining, not `??`): the statement has a ternary. */
const TERNARY = /(?<!\?)\?(?![.?])/;
const TERNARY_EXPECT = new RegExp(String.raw`[?:]\s*(?:\(\s*)?${EXPECT_START}`);
const IF_THEN_EXPECT = new RegExp(String.raw`^\s*(?:\{\s*)?${EXPECT_START}`);

/**
 * The assertion of this statement only runs sometimes: `if (cond) await expect(...)` (also `if (cond) { await expect(...)`),
 * `cond && expect(...)`, `cond || expect(...)`, `cond ?? expect(...)`, or a ternary with an expect in one branch.
 */
export function isConditionalAssertion(masked) {
  for (const m of masked.matchAll(/(?<![\w$.])if\s*\(/g)) {
    const close = matchParen(masked, m.index + m[0].length - 1);
    if (close !== -1 && IF_THEN_EXPECT.test(masked.slice(close + 1))) return true;
  }
  if (SHORT_CIRCUIT_EXPECT.test(masked)) return true;
  return TERNARY.test(masked) && TERNARY_EXPECT.test(masked);
}

const IF_OPEN = /^\s*(?:\}\s*else\s+)?if\s*\(.*\)\s*\{\s*$/;
/** `if (cond)` or `else` alone on a line: the next statement is its body. */
const IF_BODY_NEXT = /^\s*(?:\}\s*)?(?:else\s+)?(?:if\s*\(.*\)|else)\s*$/;

/**
 * For each line, whether its first character sits inside the braces of an `if` / `else if` / `else` block.
 * Works on masked text (strings and comments blanked), so a brace inside a string cannot confuse it.
 */
export function ifEnclosure(masked) {
  const text = masked.join('\n');
  const stack = [];
  let inIf = 0;
  let line = 0;
  const out = [false];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(text[k])) k--;
      let isIf = false;
      if (text[k] === ')') {
        let d = 0;
        let o = k;
        for (; o >= 0; o--) {
          if (text[o] === ')') d++;
          else if (text[o] === '(' && --d === 0) break;
        }
        isIf = o > 0 && /(?<![\w$.])if\s*$/.test(text.slice(Math.max(0, o - 12), o));
      } else if (k >= 3 && /(?<![\w$.])else$/.test(text.slice(Math.max(0, k - 5), k + 1))) isIf = true;
      stack.push(isIf);
      if (isIf) inIf++;
    } else if (c === '}') {
      if (stack.pop()) inIf--;
    } else if (c === '\n') {
      line++;
      out[line] = inIf > 0;
    }
  }
  return out;
}

const STARTS_WITH_EXPECT = new RegExp(String.raw`^\s*${EXPECT_START}`);

/**
 * The assertion of this statement only runs sometimes, by its own text (if / && / ?:) or by its context: it starts with
 * expect and sits inside an if/else block, or right under an `if (cond)` / `else` line.
 */
function isGuarded(mask, enclosure, st) {
  if (isConditionalAssertion(st.masked)) return true;
  if (!STARTS_WITH_EXPECT.test(st.masked)) return false;
  if (enclosure[st.start]) return true;
  let p = st.start - 1;
  while (p >= 0 && (mask[p]).trim() === '') p--;
  const prev = p >= 0 ? (mask[p]) : '';
  return IF_OPEN.test(prev) || IF_BODY_NEXT.test(prev);
}

/** Lines of the new file that sit at the same place as an old line (outside every changed block): new index -> old index. */
function alignedLines(oldLen, newLen, blocks) {
  const map = new Map ();
  let o = 0;
  let n = 0;
  for (const b of [...blocks, { oldStart: oldLen, oldEnd: oldLen, newStart: newLen, newEnd: newLen }]) {
    while (n < b.newStart && o < b.oldStart) map.set(n++, o++);
    o = b.oldEnd;
    n = b.newEnd;
  }
  return map;
}

function analyzePair(pair, config, pool) {
  const sql = isSql(pair.path);
  const oldText = (pair.oldText ?? '').replace(/\r\n/g, '\n');
  const newText = (pair.newText ?? '').replace(/\r\n/g, '\n');
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const mask = sql ? maskSql : maskTs;
  const oldMask = mask(oldText).split('\n');
  const newMask = mask(newText).split('\n');
  const isNew = pair.status === 'A';
  const change = computeChange(oldLines, newLines);
  const addedIdx = new Set(change.added);
  const ctx = { masked: newMask, added: addedIdx, oldText };
  const drafts = [];
  const file = pair.path;
  const add = (category, rule, line0, message, scope, extra = {}) =>
    drafts.push({ category, rule, baseSeverity: sev(category), file, line: Math.max(1, line0 + 1), message, scope, ...extra });
  const firstAnchor = () => {
    const a = change.removed.map((i) => change.anchorOf.get(i)).filter((x) => x !== undefined);
    return a.length ? Math.min(...a) : 0;
  };
  /** Approval windows of removed old lines: their hunk, or the lines around the removal anchor and the test() that lost them. */
  const windowsFor = (removed, withTest) => {
    const out = [];
    for (const i of removed) {
      const [hs, he] = change.hunkOf.get(i) ?? [0, 0];
      out.push([hs - APPROVAL_REACH, Math.max(hs, he - 1) + APPROVAL_REACH]);
      if (!withTest) continue;
      let t = Math.min(change.anchorOf.get(i) ?? 0, newMask.length - 1);
      while (t >= 0 && (newMask[t]?.match(TEST_CALL) ?? []).length === 0) t--;
      if (t >= 0) out.push([t - APPROVAL_REACH, t + APPROVAL_REACH]);
    }
    return out;
  };

  // (a) assertions and pgTAP plan
  if (!isNew) {
    const oa = assertionsPerLine(oldMask, sql, config.assertionHelpers, config.arrayAssertionHelpers);
    const na = assertionsPerLine(newMask, sql, config.assertionHelpers, config.arrayAssertionHelpers);
    const before = oa.reduce((s, x) => s + x, 0);
    const after = na.reduce((s, x) => s + x, 0);
    // An assertion line that reappears verbatim in another changed file was moved, not lost.
    const lost = [];
    let movedCount = 0;
    for (const i of change.removed) {
      const k = oa[i];
      if (k === 0) continue;
      if (takeFromPool(pool, oldLines[i])) movedCount += k;
      else lost.push(i);
    }
    if (after + movedCount < before) {
      const moved = movedCount ? `, ${movedCount} moved to other files` : '';
      const where = lost.length ? `; removed at old line ${lost.slice(0, 8).map((i) => i + 1).join(', ')}${lost.length > 8 ? ', ...' : ''}` : '';
      const windows = windowsFor(lost.length ? lost : change.removed, true);
      add('a', 'assertions-removed', firstAnchor(), `assertions ${before} -> ${after} (-${before - after}${moved})${where}`, 'anchored', { old: `${before}`, new: `${after}`, windows, need: before - after });
    }
    if (sql) {
      const plan = (lines) => lines.reduce((s, l) => s + [...l.matchAll(PLAN)].reduce((t, m) => t + Number(m[1]), 0), 0);
      const po = plan(oldMask);
      const pn = plan(newMask);
      if (pn < po) {
        const at = newMask.findIndex((l) => /(?<![\w$.])plan\s*\(/i.test(l));
        const where = at === -1 ? firstAnchor() : at;
        add('a', 'plan-decreased', where, `pgTAP plan(${po}) -> plan(${pn})`, 'anchored', { old: `${po}`, new: `${pn}`, windows: [[where - APPROVAL_REACH, where + APPROVAL_REACH]] });
      }
    }
  }

  // (g) fewer test( / it( blocks
  if (!isNew && !sql) {
    const count = (lines) => lines.reduce((s, l) => s + (l.match(TEST_CALL) ?? []).length, 0);
    const before = count(oldMask);
    const after = count(newMask);
    const removedTests = change.removed.filter((i) => (oldMask[i]?.match(TEST_CALL) ?? []).length > 0);
    const movedTests = removedTests.filter((i) => takeFromPool(pool, oldLines[i])).length;
    if (after + movedTests < before) {
      add('g', 'tests-removed', firstAnchor(), `test()/it() blocks ${before} -> ${after} (-${before - after}${movedTests ? `, ${movedTests} moved to other files` : ''})`, 'anchored', {
        old: `${before}`,
        new: `${after}`,
        windows: windowsFor(removedTests.length ? removedTests : change.removed, false),
        need: before - after,
      });
    }
  }

  const skipRe = sql ? [SKIP_SQL] : SKIP_TS;
  const pairedOld = new Map (change.pairs.map(([o, n]) => [n, o]));
  const sortedAdded = [...addedIdx].sort((x, y) => x - y);
  for (const j of sortedAdded) {
    const m = newMask[j];
    const raw = newLines[j];
    if (m.trim() === '') continue;

    const pairedIdx = pairedOld.get(j);
    // The same pattern on the old line means the statement was edited, not that the marker is new.
    const existed = (re) => pairedIdx !== undefined && re.test(oldMask[pairedIdx]);

    // (b) skip / fixme / only / fail / todo
    for (const re of skipRe) {
      const hit = re.exec(m);
      if (hit && !existed(re)) {
        add('b', 'skip-added', j, `skip/only marker added: ${hit[0].trim()}`, 'line', { new: raw.trim() });
        break;
      }
    }

    // (d) retries
    if (!sql) {
      const r = retriesOf(m);
      if (r !== null && r > 0) {
        const o = pairedOld.get(j);
        const before = o === undefined ? null : retriesOf(oldMask[o]);
        if (before === null || r > before) add('d', 'retries-added', j, `retries ${before ?? 0} -> ${r}`, 'line', { old: `${before ?? 0}`, new: `${r}` });
      }
    }

    // (h) toPass: a retry wrapper, for polling server state only (UI waits use the ready signal)
    if (!sql && TOPASS.test(m) && !existed(TOPASS)) add('h', 'topass-added', j, 'toPass() added: it retries an assertion; wait on a signal instead (toPass is for server state only)', 'line', { new: raw.trim() });

    // (e) .first() / .last() / .nth()
    if (!isNew && !sql && LOCATOR_FIRST.test(m) && !existed(LOCATOR_FIRST)) add('e', 'locator-broadened', j, 'positional locator added (.first()/.last()/.nth()): a broader match can hide a wrong element', 'line', { new: raw.trim() });
  }

  // (i) secret-looking literals on added lines (rule 13: generate values at run time). Placeholder-style values only warn.
  if (!sql) {
    for (const h of scanSource(file, newText).filter((x) => x.rule === 'secret')) {
      if (!addedIdx.has(h.line - 1)) continue;
      add('i', 'secret-literal', h.line - 1, h.severity === 'hard' ? 'secret-looking literal: generate it at run time or read it from the environment' : 'password-like placeholder literal: prefer a value generated at run time', 'line', { new: h.text, baseSeverity: h.severity === 'hard' ? 'BLOCK' : 'REVIEW' });
    }
  }

  // Statement level rules: a statement split over several lines is matched as one (`waitForLoadState(\n 'networkidle'\n)`).
  if (!sql) {
    const newSeg = segmentStatements(newMask, newLines);
    const oldSeg = segmentStatements(oldMask, oldLines);
    const newEnc = ifEnclosure(newMask);
    const oldEnc = ifEnclosure(oldMask);
    const newConsts = numericConsts(newMask);
    const oldConsts = numericConsts(oldMask);
    const seen = new Set();
    for (const j of sortedAdded) {
      const si = newSeg.of[j];
      if (seen.has(si)) continue;
      seen.add(si);
      const st = newSeg.stmts[si];
      if (st.masked.trim() === '') continue;
      // The old statement this one was edited from (through any of its added lines that pair with an old line).
      let oldSt;
      for (let k = st.start; k <= st.end && !oldSt; k++) {
        const o = addedIdx.has(k) ? pairedOld.get(k) : undefined;
        if (o !== undefined) oldSt = oldSeg.stmts[oldSeg.of[o]];
      }
      const existed = (re) => oldSt !== undefined && re.test(oldSt.masked);

      // (h) sleeps and networkidle
      const sleep = SLEEP.find((re) => re.test(st.masked));
      if (sleep && existed(sleep)) {
        // edited, not new
      } else if (sleep) add('h', 'sleep-added', j, 'fixed wait added (waitForTimeout/sleep): wait on a signal instead', 'line', { new: st.raw.trim() });
      else if (isNetworkIdle(st.masked, st.raw) && !(oldSt && isNetworkIdle(oldSt.masked, oldSt.raw))) add('h', 'networkidle-added', j, "'networkidle' wait added: wait on the hydration/page-ready marker instead", 'line', { new: st.raw.trim() });

      // (a) assertions that cannot fail
      if (isSwallowedAssertion(st.masked) && !(oldSt && isSwallowedAssertion(oldSt.masked))) add('a', 'assertion-swallowed', j, 'assertion followed by .catch(): its failure is swallowed', 'line', { new: st.raw.trim() });
      if (isTautology(st.masked, st.raw) && !(oldSt && isTautology(oldSt.masked, oldSt.raw))) add('a', 'assertion-tautology', j, 'assertion on a literal (expect(true).toBe(true)): it can never fail', 'line', { new: st.raw.trim() });

      // (f) assertions that may not run. The enclosing context of the edited statement is compared with the one of its
      // old self: an expect that was unconditional and got wrapped in an if / && / ?: is new; an edited guarded one is not.
      if (isGuarded(newMask, newEnc, st) && !(oldSt && isGuarded(oldMask, oldEnc, oldSt))) add('f', 'assertion-conditional', j, 'assertion inside an if: it may never run (review)', 'line', { new: st.raw.trim() });

      if (isNew) continue;

      // (c) bigger timeouts
      const t = timeoutOf(st.masked, newConsts);
      if (t !== null) {
        const before = oldSt === undefined ? null : timeoutOf(oldSt.masked, oldConsts);
        const bigger = (a, b) => {
          if (b === 'slow') return a !== 'slow';
          if (a === 'slow') return false;
          return a === null ? b > 5000 : b > a;
        };
        if (oldSt !== undefined && bigger(before, t)) add('c', 'timeout-increased', j, `timeout ${fmtMs(before)} -> ${fmtMs(t)}`, 'line', { old: fmtMs(before), new: fmtMs(t) });
        else if (oldSt === undefined && (t === 'slow' || t > config.maxNewTimeoutMs)) add('c', 'timeout-added', j, `new timeout ${fmtMs(t)} (above ${config.maxNewTimeoutMs} ms, nothing to compare with)`, 'line', { new: fmtMs(t) });
      }

      // (c) a const used as a timeout got bigger (`const SLOW = 5_000` -> `60_000`): the usages did not change
      const decl = CONST_NUM.exec(st.masked);
      if (decl && oldSt) {
        const name = decl[1];
        const oldDecl = CONST_NUM.exec(oldSt.masked);
        const now = newConsts.get(name);
        const was = oldDecl && oldDecl[1] === name ? oldConsts.get(name) : undefined;
        const use = new RegExp(`\\b(?:[Tt]imeout\\s*:|(?:setTimeout|setDefaultTimeout|setDefaultNavigationTimeout)\\s*\\()\\s*(?:[\\w$.]+\\s*\\*\\s*)*${name.replace(/\$/g, '\\$')}(?![\\w$])`);
        if (now !== undefined && was !== undefined && now > was && use.test(newMask.join('\n'))) add('c', 'timeout-increased', j, `timeout const ${name} ${fmtMs(was)} -> ${fmtMs(now)}`, 'line', { old: fmtMs(was), new: fmtMs(now) });
      }
    }

    // (f) an expect line that did not change but now sits inside a newly added if block (or under an added `if (c)` line)
    const aligned = alignedLines(oldLines.length, newLines.length, diffBlocks(oldLines, newLines));
    const flaggedOpeners = new Set();
    for (const st of newSeg.stmts) {
      if (!STARTS_WITH_EXPECT.test(st.masked) || !isGuarded(newMask, newEnc, st)) continue;
      let touched = false;
      for (let k = st.start; k <= st.end; k++) touched ||= addedIdx.has(k);
      const oi = aligned.get(st.start);
      if (touched || oi === undefined) continue;
      const oldSt = oldSeg.stmts[oldSeg.of[oi]];
      if (oldSt === undefined || isGuarded(oldMask, oldEnc, oldSt)) continue;
      // Report on the added line that opened the guard (where a reviewer looks, and where an approval comment goes).
      let q = st.start - 1;
      while (q >= 0 && !addedIdx.has(q)) q--;
      const at = q >= 0 ? q : st.start;
      if (flaggedOpeners.has(at)) continue;
      flaggedOpeners.add(at);
      add('f', 'assertion-conditional', at, 'existing assertion now sits inside an if: it may never run (review)', 'line', { new: (newLines[at]).trim() });
    }

    // (f) an assertion inside a try/catch: the catch can swallow its failure
    const text = newMask.join('\n');
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const lineOf = (off) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid]) <= off) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const hasExpect = (s) => new RegExp(EXPECT_CALL.source).test(s);
    for (const tm of text.matchAll(/(?<![\w$.])try\s*\{/g)) {
      const open = tm.index + tm[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) {
          close = i;
          break;
        }
      }
      if (close === -1 || !/^\s*catch\b/.test(text.slice(close + 1)) || !hasExpect(text.slice(open + 1, close))) continue;
      const tryLine = lineOf(tm.index);
      let at = addedIdx.has(tryLine) ? tryLine : -1;
      for (let k = tryLine + 1; at === -1 && k <= lineOf(close); k++) if (addedIdx.has(k) && hasExpect(newMask[k])) at = k;
      if (at !== -1) add('f', 'assertion-in-try', at, 'assertion inside try/catch: the catch can swallow its failure (review)', 'line', { new: (newLines[at]).trim() });
    }
  }

  // (e)/(f) edited statements
  if (!isNew && !sql) {
    for (const [o, n] of change.pairs) {
      const om = oldMask[o];
      const nm = newMask[n];
      if (STRONG_LOCATOR.test(om) && !STRONG_LOCATOR.test(nm) && WEAK_LOCATOR.test(nm)) {
        add('e', 'locator-weakened', n, 'getByTestId/getByRole/getByLabel replaced by a CSS/text locator', 'line', { old: (oldLines[o]).trim(), new: (newLines[n]).trim() });
      }
      const mo = parseMatcher(om, oldLines[o]);
      const mn = parseMatcher(nm, newLines[n]);
      if (mo && mn) {
        const why = looseningReason(mo, mn);
        if (why) add('f', 'assertion-loosened', n, `assertion looser: ${why} (review)`, 'line', { old: (oldLines[o]).trim(), new: (newLines[n]).trim() });
      }
    }
  }
  return { drafts, newLines, ctx };
}

function approvalsFor(draft, newLines, ctx) {
  if (draft.scope === 'anchored') return findAnchoredApproval(newLines, draft.windows ?? [], draft.need, ctx);
  return findApproval(newLines, draft.line - 1, ctx);
}

/** Analyzes changed test files. Pure: the caller supplies the old and new text of every file. */
export function analyze(pairs, config = DEFAULT_CONFIG) {
  const findings = [];
  // Lines added anywhere in this change set, to recognise tests/assertions that moved from one file to another.
  const pool = new Map ();
  for (const pair of pairs) {
    if (pair.status === 'D') continue;
    const nl = splitLines(pair.newText);
    for (const j of computeChange(splitLines(pair.oldText), nl).added) pool.set((nl[j]).trim(), (pool.get((nl[j]).trim()) ?? 0) + 1);
  }
  const listedDeletion = (...paths) =>
    config.approvedDeletions
      .map((d) => (typeof d === 'string' ? { path: d, reason: 'approved in kit.config.json (guard.approvedDeletions)' } : { path: d.path, reason: d.reason ?? 'approved in kit.config.json (guard.approvedDeletions)' }))
      .find((d) => paths.some((p) => p !== null && normPath(d.path) === normPath(p)));
  const fileGone = (pair, message) => {
    const listed = listedDeletion(pair.path, pair.oldPath);
    findings.push({
      category: 'g',
      rule: 'test-file-deleted',
      severity: listed ? 'APPROVED' : 'BLOCK',
      baseSeverity: 'BLOCK',
      file: pair.path,
      line: 0,
      message,
      ...(listed ? { approval: { reason: listed.reason, line: 0 } } : {}),
    });
  };
  for (const pair of pairs) {
    if (pair.status === 'D') {
      if (/\.(?:spec|test|e2e)\./.test(pair.path) || isTestFile(pair.path, config)) fileGone(pair, 'test file deleted');
      continue;
    }
    // A test file renamed to a path the suite does not run is a deletion in disguise.
    if (pair.status === 'R' && pair.oldPath && isTestFile(pair.oldPath, config) && !isOutOfSuite(pair.oldPath, config) && (!isTestFile(pair.path, config) || isOutOfSuite(pair.path, config))) {
      fileGone(pair, `test file renamed out of the suite (${pair.oldPath} -> ${pair.path})`);
      continue;
    }
    const { drafts, newLines, ctx } = analyzePair(pair, config, pool);
    for (const { scope, windows, need, ...draft } of drafts) {
      const approval = approvalsFor({ scope, windows, need, ...draft }, newLines, ctx);
      findings.push({ ...draft, severity: approval ? 'APPROVED' : draft.baseSeverity, ...(approval ? { approval: { reason: approval.reason, line: approval.line } } : {}) });
    }
  }
  const order = { BLOCK: 0, REVIEW: 1, APPROVED: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity] || x.file.localeCompare(y.file) || x.line - y.line);
  const counts = {
    files: pairs.length,
    block: findings.filter((f) => f.severity === 'BLOCK').length,
    approved: findings.filter((f) => f.severity === 'APPROVED').length,
    review: findings.filter((f) => f.severity === 'REVIEW').length,
  };
  return {
    ok: counts.block === 0,
    counts,
    findings,
    approvals: findings.filter((f) => f.approval).map((f) => ({ file: f.file, line: f.line, rule: f.rule, reason: (f.approval).reason })),
  };
}

// ------------------------------------------------------------------------------------------------------------ output

const MAX_PER_SEVERITY = 60;

/** Human summary. The last line is machine readable. */
export function formatReport(report, meta = {}) {
  const lines = [];
  const row = (f) => {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    const detail = f.old !== undefined && f.new !== undefined && f.category !== 'a' && f.category !== 'g' ? ` [${f.old} -> ${f.new}]` : '';
    return `  ${f.severity.padEnd(8)} ${f.category} ${f.rule.padEnd(20)} ${where}  ${f.message}${detail}${f.approval ? `  (approved: ${f.approval.reason})` : ''}`;
  };
  for (const s of ['BLOCK', 'REVIEW', 'APPROVED']) {
    const list = report.findings.filter((f) => f.severity === s);
    if (!list.length) continue;
    lines.push(`${s} (${list.length})`);
    for (const f of list.slice(0, MAX_PER_SEVERITY)) lines.push(row(f));
    if (list.length > MAX_PER_SEVERITY) lines.push(`  ... ${list.length - MAX_PER_SEVERITY} more (use --json)`);
  }
  if (report.counts.block > 0) {
    lines.push('', 'Weakening a test to make it pass is not a fix. Fix the code, or if the change is truly intended add a NEW comment `// test-guard: approved <reason>` (`-- test-guard: approved <reason>` in SQL) on or above the line; for removed assertions/tests put `// test-guard: approved-removal <n> <reason>` (n >= how many were removed) inside the change or within 3 lines of it. Deleted or renamed-away test files: guard.approvedDeletions in kit.config.json.');
  }
  lines.push(`${lines.length ? '\n' : ''}e2e-guard: BLOCK=${report.counts.block} APPROVED=${report.counts.approved} REVIEW=${report.counts.review} files=${report.counts.files}${meta.base ? ` base=${meta.base}` : ''}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ line scanner (--all)
// The v0.1 scanner: every line of every file, comments ignored. Used by `--all` with the ratchet baseline, and for the
// secret-looking-literal rule in diff mode. Hard hits: waitForTimeout, networkidle, toPass, fixme, unconditional skip, retries > 0, secrets.

export const HARD_RULES = ['waitForTimeout', 'networkidle', 'toPass', 'fixme', 'skip', 'retries', 'secret'];

/**
 * @typedef {{ rule: string, severity: 'hard' | 'warn', file: string, line: number, text: string }} Hit
 */

/**
 * Blanks comments (keeps newlines and string contents) so line numbers survive.
 * @param {string} src
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  /** @type {string | null} */
  let quote = null;
  while (i < src.length) {
    const c = /** @type {string} */ (src[i]);
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && n !== undefined) {
        out += n;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/**
 * First argument text of the call whose "(" is at `open`, or null when the call has no arguments.
 * @param {string} text @param {number} open
 */
function firstArg(text, open) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = /** @type {string} */ (text[i]);
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i).trim() || null;
    } else if (c === ',' && depth === 1) return text.slice(start, i).trim();
  }
  return text.slice(start).trim() || null;
}

/** Hyphenated words with at least two alphabetic segments ('local-dev-password-123'): a human placeholder, not a key. @param {string} v */
function isPlaceholder(v) {
  const parts = v.split('-');
  return parts.length >= 3 && parts.every((p) => /^[a-z0-9]+$/i.test(p)) && parts.filter((p) => /^[a-z]{3,}$/i.test(p)).length >= 2;
}

const SECRET_NAME =/(pass(?:word|wd)?|secret|api[_-]?key|token|authorization|private[_-]?key)/i;

/**
 * Scans one file's source (comments are ignored).
 * @param {string} file posix path used in the report
 * @param {string} source
 * @returns {Hit[]}
 */
export function scanSource(file, source) {
  const text = stripComments(source);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  /** @param {number} offset */
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (/** @type {number} */ (lineStarts[mid]) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const srcLines = source.split(/\r?\n/);
  /** @type {Hit[]} */
  const hits = [];
  /** @param {string} rule @param {'hard' | 'warn'} severity @param {number} offset */
  const add = (rule, severity, offset) => {
    const line = lineOf(offset);
    hits.push({ rule, severity, file, line, text: (srcLines[line - 1] ?? '').trim().slice(0, 160) });
  };
  for (const m of text.matchAll(/\.waitForTimeout\s*\(/g)) add('waitForTimeout', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/['"`]networkidle['"`]/g)) add('networkidle', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\.toPass\s*\(/g)) add('toPass', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\.fixme\s*\(/g)) add('fixme', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\bretries\s*:\s*([^,}\n]*)/g)) {
    if (/\b[1-9]\d*\b/.test(/** @type {string} */ (m[1]))) add('retries', 'hard', m.index ?? 0);
  }
  for (const m of text.matchAll(/\bdescribe(?:\.\w+)*\.skip\b/g)) add('skip', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\b(?:test|it)\.skip\b(\s*\()?/g)) {
    if (!m[1]) continue; // a bare reference, not a call
    const idx = m.index ?? 0;
    const arg = firstArg(text, idx + m[0].length - 1);
    // No argument, a string title or a literal true: the test never runs. Anything else is decided at run time.
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    // `if (cond) test.skip(true, 'why')` is decided at run time, whatever the literal says.
    const guarded = /\bif\s*\(.*\)\s*$|&&\s*$|\?\s*$/.test(text.slice(lineStart, idx));
    const unconditional = !guarded && (arg === null || /^['"`]/.test(arg) || arg === 'true');
    add('skip', unconditional ? 'hard' : 'warn', idx);
  }
  for (const m of text.matchAll(/\.first\s*\(\s*\)/g)) add('first', 'warn', m.index ?? 0);
  for (const m of text.matchAll(/(['"]?)([A-Za-z_][\w-]*)\1\s*[:=]\s*(['"`])([^'"`\s$\\]{8,})\3/g)) {
    if (!SECRET_NAME.test(/** @type {string} */ (m[2]))) continue;
    const lineText = srcLines[lineOf(m.index ?? 0) - 1] ?? '';
    if (/process\.env|import\.meta\.env/.test(lineText)) continue;
    // Placeholder-style values (hyphenated words such as 'local-dev-password-123') only warn: rule 13 still says to generate
    // values at run time. Any other password-like literal is a hard failure.
    add('secret', isPlaceholder(/** @type {string} */ (m[4])) ? 'warn' : 'hard', m.index ?? 0);
  }
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|\bsk_(?:live|test)_[A-Za-z0-9]{12,}|\bAKIA[0-9A-Z]{16}\b/g)) add('secret', 'hard', m.index ?? 0);
  // One line may match two secret patterns: keep one hit per rule and line.
  const seen = new Set();
  return hits
    .filter((h) => {
      const key = `${h.rule}:${h.line}:${h.severity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}

/**
 * Counts of hard hits per rule and per file.
 * @param {Hit[]} hits
 */
export function countHard(hits) {
  /** @type {Record<string, number>} */
  const total = {};
  /** @type {Record<string, Record<string, number>>} */
  const files = {};
  for (const h of hits) {
    if (h.severity !== 'hard') continue;
    total[h.rule] = (total[h.rule] ?? 0) + 1;
    const perFile = (files[h.rule] ??= {});
    perFile[h.file] = (perFile[h.file] ?? 0) + 1;
  }
  return { total, files };
}

/**
 * Applies the ratchet baseline to the hard hits of an `--all` scan. Counts may only go down.
 * @param {Hit[]} hits @param {{ baseline: any | null }} ctx
 * @returns {{ failing: Hit[], allowed: Hit[], lowered: string[] }}
 */
export function judgeHits(hits, { baseline }) {
  const open = hits.filter((h) => h.severity === 'hard');
  if (!baseline) return { failing: open, allowed: [], lowered: [] };
  const { files } = countHard(open);
  /** @type {Hit[]} */
  const failing = [];
  /** @type {Hit[]} */
  const allowed = [];
  for (const h of open) {
    const base = baseline.files?.[h.rule]?.[h.file] ?? 0;
    const now = files[h.rule]?.[h.file] ?? 0;
    // Over its baseline: every hit of that rule in that file is listed (which one is new cannot be told from counts alone).
    if (now > base) failing.push(h);
    else allowed.push(h);
  }
  /** @type {string[]} */
  const lowered = [];
  for (const [rule, perFile] of Object.entries(baseline.files ?? {})) {
    for (const [file, n] of Object.entries(/** @type {Record<string, number>} */ (perFile))) {
      const now = files[rule]?.[file] ?? 0;
      if (now < n) lowered.push(`${rule} in ${file}: ${n} -> ${now}`);
    }
  }
  return { failing, allowed, lowered };
}

