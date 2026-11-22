// mend: one command-line tool that applies the edits AI models write, in four
// formats, to a tree of text files. Node 22, the standard library alone. Run as
// `node main.ts [options] [PATCH]` with the working directory as the root of
// the tree. SPEC.md is the whole contract; this file implements it.
//
// The four formats are a unified diff (often with wrong line numbers),
// SEARCH/REPLACE blocks, the V4A patch format, and JSON text-editor tool
// calls. Each edit names old lines that are found at the first of three
// matching tiers, and every file is changed or nothing is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: the patch cannot be read in its format. `line` is the full
 *  `error: parse <N>` line to print. */
class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed. `code` is the failure code, `path` the path the failure
 *  concerns, as the patch wrote it. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  the empty piece after a final `\n` dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file's text as lines, its line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function readLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function writeLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it. `now` holds the changed paths (null: the
 *  file is deleted); anything else is read from disk when first needed. */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  read(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.read(p);
  }
  /** Write the new text of a path (creating parents), or delete it when null. */
  writeFile(p: string): void {
    const now = this.now.get(p);
    if (now === null || now === undefined) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* already gone */
      }
      return;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, now);
  }
  /** Every path whose text changed, including deletions, in byte order. */
  changedPaths(): string[] {
    const out: string[] = [];
    for (const [p, now] of this.now) {
      const orig = this.read(p);
      if (now === null) {
        if (orig !== null) out.push(p);
      } else if (orig === null || orig !== now) {
        out.push(p);
      }
    }
    out.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return out;
  }
  /** The output lines for the changed paths: `A` a file that did not exist
   *  and now does, `D` one that existed and now does not, `M` one that
   *  existed and still does with other bytes, and a move as one
   *  `R old -> new` line when the old path existed before the patch and does
   *  not after it, and the new path did not exist before it and does after
   *  it. Sorted by the path (the new path for a move). */
  outputEntries(moves: [string, string][]): { sortKey: string; line: string }[] {
    const entries: { sortKey: string; line: string }[] = [];
    const handled = new Set<string>();
    for (const [oldP, newP] of moves) {
      const oldOrig = this.read(oldP);
      const oldNow = this.now.get(oldP);
      const newOrig = this.read(newP);
      const newNow = this.now.get(newP);
      if (oldOrig !== null && oldNow === null && newOrig === null && newNow !== null && newNow !== undefined) {
        entries.push({ sortKey: newP, line: `R ${oldP} -> ${newP}` });
        handled.add(oldP);
        handled.add(newP);
      }
    }
    for (const [p, now] of this.now) {
      if (handled.has(p)) continue;
      const orig = this.read(p);
      if (now === null) {
        if (orig === null) continue;
        entries.push({ sortKey: p, line: `D ${p}` });
      } else if (orig === null) {
        entries.push({ sortKey: p, line: `A ${p}` });
      } else if (orig !== now) {
        entries.push({ sortKey: p, line: `M ${p}` });
      }
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));
    return entries;
  }
}

type EditFn = (tree: WorkTree, moves: [string, string][]) => void;

/** Do two lines match at a tier? Tier 0 is exact, tier 1 ignores trailing
 *  spaces and tabs, tier 2 ignores leading and trailing spaces and tabs. */
function lineMatches(o: string, f: string, tier: number): boolean {
  if (tier === 0) return o === f;
  if (tier === 1) return trimTrail(o) === trimTrail(f);
  return trimBoth(o) === trimBoth(f);
}

/** Every 0-based position where `old` occurs in `lines` at `tier`. */
function findOccurrences(lines: string[], old: string[], tier: number): number[] {
  const found: number[] = [];
  if (old.length === 0 || old.length > lines.length) return found;
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineMatches(old[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (0, 1, 2; only 0 when strict) at which `old` occurs at
 *  least once in `lines`, with its positions, or null when it never occurs. */
function firstTier(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = findOccurrences(lines, old, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** The first tier at which a single line `want` occurs at or after `from`
 *  in `lines`, with its first position, or null. */
function firstTierSingle(lines: string[], want: string, from: number, strict: boolean): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineMatches(want, lines[i]!, t)) return { tier: t, at: i };
    }
  }
  return null;
}

/** One line of a replacement: `text` as the patch wrote it, and, for a
 *  context line, the index of the old line it stands for. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines to write for a replacement: context lines are the file's own
 *  matched lines, never the patch's; at tier 2 every other line is
 *  re-indented, the leading spaces and tabs of the patch's first old line
 *  replaced by those of the file's first matched line. */
function replacementLines(nw: NewLine[], fileLines: string[], at: number, tier: number, oldFirst: string): string[] {
  const f = leadWs(fileLines[at] ?? '');
  const p = leadWs(oldFirst);
  return nw.map((e) => {
    if (e.ctx !== null) return fileLines[at + e.ctx]!;
    let line = e.text;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    return line;
  });
}

/** One body line of a unified hunk: `ctx` a context line, `old` a `-` line,
 *  `new` a `+` line, `bs` a `\` line. `text` is the line without its first
 *  character; `raw` is the patch line as written. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path a `--- ` or `+++ ` line names: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed.
 *  `/dev/null` is no file; a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function bodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '', raw: line };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1), raw: line };
  if (c === '-') return { kind: 'old', text: line.slice(1), raw: line };
  if (c === '+') return { kind: 'new', text: line.slice(1), raw: line };
  return { kind: 'bs', text: line.slice(1), raw: line };
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

/** The old and new lines a hunk body names, and, for each new line, the
 *  index of the old line it stands for when it is a context line. */
function hunkLines(body: BodyLine[]): { old: string[]; nw: NewLine[]; lastNewBs: boolean } {
  const old: string[] = [];
  const nw: NewLine[] = [];
  let lastNewBs = false;
  for (let i = 0; i < body.length; i += 1) {
    const item = body[i]!;
    if (item.kind === 'ctx') {
      old.push(item.text);
      nw.push({ text: item.text, ctx: old.length - 1 });
      lastNewBs = body[i + 1]?.kind === 'bs';
    } else if (item.kind === 'old') {
      old.push(item.text);
    } else if (item.kind === 'new') {
      nw.push({ text: item.text, ctx: null });
      lastNewBs = body[i + 1]?.kind === 'bs';
    }
  }
  return { old, nw, lastNewBs };
}

/** Apply one hunk to a file's lines. Returns the new file and the length
 *  change (new lines minus old lines) for the section's running offset. */
function applyHunk(file: FileLines, hunk: Hunk, strict: boolean, d: number, path: string): { file: FileLines; delta: number } {
  const { old, nw, lastNewBs } = hunkLines(hunk.body);
  const lines = file.lines;
  if (old.length === 0) {
    const at = Math.min(hunk.a + d, lines.length);
    const ins = nw.map((e) => e.text);
    const out = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
    let final = file.final;
    if (at === lines.length && ins.length > 0) final = !lastNewBs;
    return { file: { lines: out, br: file.br, final }, delta: nw.length };
  }
  const found = firstTier(lines, old, strict);
  if (found === null) throw new EditFault('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.at[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of found.at) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const rep = replacementLines(nw, lines, best, found.tier, old[0]!);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + old.length)];
  let final = file.final;
  if (best + old.length === lines.length) {
    final = nw.length > 0 ? !lastNewBs : true;
  }
  return { file: { lines: out, br: file.br, final }, delta: nw.length - old.length };
}

/** One unified section as an edit. */
function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): EditFn {
  return (tree, moves) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    const isCreate = oldP === null || sec.newFileMode;
    const isDelete = newP === null || sec.deletedFileMode;
    if (isCreate) {
      if (newP === null) return;
      if (!isSafe(newP)) throw new EditFault('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const made: string[] = [];
      let lastBs = false;
      for (const hunk of sec.hunks) {
        for (let i = 0; i < hunk.body.length; i += 1) {
          const item = hunk.body[i]!;
          if (item.kind === 'new') {
            made.push(item.text);
            lastBs = hunk.body[i + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newP, writeLines({ lines: made, br: '\n', final: made.length > 0 ? !lastBs : false }));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
      if (!isSafe(newP)) throw new EditFault('unsafe', newP);
      if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      let f = readLines(tree.get(oldP)!);
      let d = 0;
      for (const hunk of sec.hunks) {
        const r = applyHunk(f, hunk, strict, d, oldP);
        f = r.file;
        d += r.delta;
      }
      tree.now.set(newP, writeLines(f));
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
    if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
    let f = readLines(tree.get(oldP)!);
    let d = 0;
    for (const hunk of sec.hunks) {
      const r = applyHunk(f, hunk, strict, d, oldP);
      f = r.file;
      d += r.delta;
    }
    tree.now.set(oldP, writeLines(f));
  };
}

/** Read a patch as unified diffs: one edit per section. */
function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let hunk: Hunk | null = null;
  const blankSection = (): UnifiedSection => ({
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  });
  const finishBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && last.raw.trim() === '') hunk.body.pop();
        else break;
      }
      hunk = null;
    }
  };
  const finishSection = (): void => {
    finishBody();
    if (sec !== null) {
      sections.push(sec);
      sec = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const nxt = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      finishSection();
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      sec = blankSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && nxt !== undefined && nxt.startsWith('+++ ')) {
      if (sec !== null && hunk === null && sec.hunks.length === 0 && sec.pairOld === null && sec.pairNew === null) {
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(nxt);
        i += 2;
        continue;
      }
      finishSection();
      sec = blankSection();
      sec.pairOld = headerPath(line);
      sec.pairNew = headerPath(nxt);
      i += 2;
      continue;
    }
    if (hunk !== null) {
      if (isBodyLine(line)) {
        hunk.body.push(bodyLine(line));
        i += 1;
        continue;
      }
      finishBody();
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      i += 1;
      continue;
    }
    if (sec === null) {
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (sec.hunks.length === 0) throw new ParseFault(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (sec.hunks.length === 0) sec.pairNew = headerPath(line);
      i += 1;
      continue;
    }
    if (sec.hunks.length === 0 && line.startsWith('rename from ')) {
      sec.renameFrom = line.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (sec.hunks.length === 0 && line.startsWith('rename to ')) {
      sec.renameTo = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (sec.hunks.length === 0 && line.startsWith('new file mode')) {
      sec.newFileMode = true;
      i += 1;
      continue;
    }
    if (sec.hunks.length === 0 && line.startsWith('deleted file mode')) {
      sec.deletedFileMode = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  finishSection();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, writeLines({ lines: [...newLines], br: '\n', final: newLines.length > 0 }));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const f = readLines(cur);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.at.length > 1) throw new EditFault('ambiguous', path);
    const at = found.at[0]!;
    const nw: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = replacementLines(nw, f.lines, at, found.tier, oldLines[0]!);
    const out = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, writeLines({ lines: out, br: f.br, final: f.final }));
  };
}

/** Read a patch as SEARCH/REPLACE blocks: one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an anchor (a line to find, or null), its body lines, and
 *  whether `*** End of File` anchors it to the end of the file. */
interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, body: string[]): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, writeLines({ lines: [...body], br: '\n', final: body.length > 0 }));
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.now.set(path, null);
  };
}

/** Apply one V4A chunk to a file's lines, from the cursor. Returns the new
 *  lines and the cursor just after the lines written. */
function applyV4aChunk(lines: string[], chunk: V4aChunk, cursor: number, strict: boolean, path: string): { lines: string[]; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const found = firstTierSingle(lines, chunk.anchor, cur, strict);
    if (found === null) throw new EditFault('no-match', path);
    cur = found.at + 1;
  }
  const { old, nw } = hunkLines(chunk.body);
  if (old.length === 0) {
    const at = chunk.eof ? lines.length : cur;
    const ins = nw.map((e) => e.text);
    const out = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
    return { lines: out, cursor: at + ins.length };
  }
  let chosen: { tier: number; at: number } | null = null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, old, t).filter((p) => p >= cur);
    if (chunk.eof) {
      const eofPos = occ.find((p) => p + old.length === lines.length);
      if (eofPos !== undefined) {
        chosen = { tier: t, at: eofPos };
        break;
      }
    } else if (occ.length > 0) {
      chosen = { tier: t, at: occ[0]! };
      break;
    }
  }
  if (chosen === null) throw new EditFault('no-match', path);
  const rep = replacementLines(nw, lines, chosen.at, chosen.tier, old[0]!);
  const out = [...lines.slice(0, chosen.at), ...rep, ...lines.slice(chosen.at + old.length)];
  return { lines: out, cursor: chosen.at + rep.length };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): EditFn {
  return (tree, moves) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = readLines(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4aChunk(lines, chunk, cursor, strict, path);
      lines = r.lines;
      cursor = r.cursor;
    }
    const out = writeLines({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a patch as a V4A patch: one edit per section. */
function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const body: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          body.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          body.push('');
          i += 1;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(v4aAddEdit(path, body));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateIdx = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      const endChunk = (eof: boolean): void => {
        if (chunk !== null) {
          chunk.eof = eof;
          chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (chunk === null) throw new ParseFault(`error: parse ${i + 1}`);
          endChunk(true);
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          endChunk(false);
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) chunk = { anchor: null, body: [], eof: false };
          chunk.body.push(bodyLine(l));
          i += 1;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 1}`);
      }
      endChunk(false);
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0) {
          const b = lc.body[lc.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '' && b.raw.trim() === '') lc.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${updateIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new ParseFault(`error: parse ${i + 1}`);
  }
  return edits;
}

/** How many times a substring occurs in a text, counting overlapping ones. */
function countSub(text: string, sub: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    const p = text.indexOf(sub, idx);
    if (p === -1) return count;
    count += 1;
    idx = p + 1;
  }
}

/** One JSON tool call as an edit. */
function jsonCallEdit(call: JsonCall): EditFn {
  if (call.kind === 'str_replace') {
    return (tree) => {
      const path = call.path;
      if (!isSafe(path)) throw new EditFault('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new EditFault('missing', path);
      const f = readLines(cur);
      let text = cur;
      let oldS = call.oldStr;
      let newS = call.newStr;
      if (f.br === '\r\n') {
        text = cur.replace(/\r\n/g, '\n');
        oldS = call.oldStr.replace(/\r\n/g, '\n');
        newS = call.newStr.replace(/\r\n/g, '\n');
      }
      const count = countSub(text, oldS);
      if (count === 0) throw new EditFault('no-match', path);
      if (count > 1) throw new EditFault('ambiguous', path);
      const at = text.indexOf(oldS);
      let result = text.slice(0, at) + newS + text.slice(at + oldS.length);
      if (f.br === '\r\n') result = result.replace(/\n/g, '\r\n');
      tree.now.set(path, result);
    };
  }
  if (call.kind === 'insert') {
    return (tree) => {
      const path = call.path;
      if (!isSafe(path)) throw new EditFault('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new EditFault('missing', path);
      const f = readLines(cur);
      const line = call.line;
      if (line < 0 || line > f.lines.length) throw new EditFault('no-match', path);
      const out = [...f.lines];
      out.splice(line, 0, ...call.text);
      tree.now.set(path, writeLines({ lines: out, br: f.br, final: f.final }));
    };
  }
  return (tree) => {
    const path = call.path;
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, call.fileText);
  };
}

/** A JSON tool call parsed from one line or one array element. */
type JsonCall =
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; line: number; text: string[] }
  | { kind: 'create'; path: string; fileText: string };

function jsonCallFrom(obj: unknown): JsonCall | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str === undefined) return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: '' };
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'insert', path: o.path, line: o.insert_line, text: splitPatch(o.new_str) };
  }
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'create', path: o.path, fileText: o.file_text };
  }
  return null;
}

/** Read a patch as JSON: one call per line, or one array of calls. */
function parseJson(text: string, strict: boolean): EditFn[] {
  void strict;
  const lines = splitPatch(text);
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    const arrayLine = first + 1;
    let arr: unknown;
    try {
      arr = JSON.parse(text.trim());
    } catch {
      throw new ParseFault(`error: parse ${arrayLine}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) throw new ParseFault(`error: parse ${arrayLine}`);
    const edits: EditFn[] = [];
    for (const el of arr) {
      const call = jsonCallFrom(el);
      if (call === null) throw new ParseFault(`error: parse ${arrayLine}`);
      edits.push(jsonCallEdit(call));
    }
    return edits;
  }
  const edits: EditFn[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseFault(`error: parse ${i + 1}`);
    }
    const call = jsonCallFrom(obj);
    if (call === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(jsonCallEdit(call));
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** Guess the format from the patch text, in the order section 4 gives. */
function detectFormat(text: string): string | null {
  const lines = splitPatch(text);
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  const head = lines[first]!;
  if (head.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = head.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search_replace';
  }
  for (let j = 0; j < lines.length; j += 1) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) return 'unified';
  }
  return null;
}

/** The patch and its format, from the command line and the input stream. */
function readInput(args: string[]): { text: string; format: string | null; strict: boolean; check: boolean } {
  let file: string | null = null;
  let format: string | null = null;
  let strict = false;
  let check = false;
  let dashdash = false;
  let seenFormat = false;
  let seenStrict = false;
  let seenCheck = false;
  for (const a of args) {
    if (dashdash) {
      if (file === null) file = a;
      continue;
    }
    if (a === '--') {
      dashdash = true;
      continue;
    }
    if (a === '--strict') {
      if (seenStrict) throw new ParseFault('error: usage');
      seenStrict = true;
      strict = true;
      continue;
    }
    if (a === '--check') {
      if (seenCheck) throw new ParseFault('error: usage');
      seenCheck = true;
      check = true;
      continue;
    }
    if (a.startsWith('--format=')) {
      if (seenFormat) throw new ParseFault('error: usage');
      seenFormat = true;
      const v = a.slice('--format='.length);
      if (v === 'auto') {
        format = null;
        continue;
      }
      if (v === 'unified' || v === 'v4a' || v === 'json') {
        format = v;
        continue;
      }
      if (v === 'search-replace') {
        format = 'search_replace';
        continue;
      }
      throw new ParseFault('error: usage');
    }
    if (a.startsWith('--')) throw new ParseFault('error: usage');
    if (a.startsWith('-') && a.length > 1) throw new ParseFault('error: usage');
    if (file === null) {
      file = a;
      continue;
    }
    throw new ParseFault('error: usage');
  }
  let text: string;
  if (file === null || file === '-') {
    text = readFileSync(0, 'utf8');
  } else {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new ParseFault('error: no-patch');
    }
  }
  return { text, format, strict, check };
}

/** Run the CLI: parse, apply atomically, and return the exit code and output. */
function run(argv: string[]): { code: number; out: string[] } {
  let input: { text: string; format: string | null; strict: boolean; check: boolean };
  try {
    input = readInput(argv);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree(process.cwd());
  let edits: EditFn[];
  try {
    const fmt = input.format ?? detectFormat(input.text);
    if (fmt === null) throw new ParseFault('error: format');
    if (fmt === 'unified') edits = parseUnified(splitPatch(input.text), input.strict);
    else if (fmt === 'search_replace') edits = parseSearchReplace(splitPatch(input.text), input.strict);
    else if (fmt === 'v4a') edits = parseV4a(splitPatch(input.text), input.strict);
    else edits = parseJson(input.text, input.strict);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const moves: [string, string][] = [];
  const failures: { code: string; path: string }[] = [];
  for (const edit of edits) {
    try {
      edit(tree, moves);
    } catch (e) {
      if (e instanceof EditFault) {
        failures.push({ code: e.code, path: e.path });
      } else {
        throw e;
      }
    }
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  if (!input.check) {
    for (const path of tree.changedPaths()) tree.writeFile(path);
  }
  const entries = tree.outputEntries(moves);
  const lines = entries.map((e) => e.line);
  lines.push(entries.length === 1 ? 'ok: 1 file' : `ok: ${entries.length} files`);
  return { code: 0, out: lines };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
