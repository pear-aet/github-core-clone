// In-memory store + git object model for the forge.
// Determinism: every timestamp the forge itself emits is the fixed trial time
// (competition.yaml: two runs on one instance must leave the same state export).
// Client-built objects are stored byte-exact and never re-serialized.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const FIXED_TS = '2026-01-01T00:00:00Z';
export const FIXED_EPOCH = 1767225600;

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const STRANGER = { login: 'olgabauer', id: 1002 } as const;
export const ORG = 'faint-meadow-org';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  created_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, Comment[]>;
  counter: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextObjectId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string } = {}): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      created_at: FIXED_TS,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      counter: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  nextId(): number {
    return this.nextObjectId++;
  }
}

// ---------------------------------------------------------------------------
// git object helpers
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + data). */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${FIXED_EPOCH} +0000`;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export interface Closure {
  /** Every object id reachable (commits, trees, blobs, tags). */
  objects: Set<string>;
  /** Commits at the depth cutoff (the shallow boundary), in walk order. */
  shallow: string[];
}

/**
 * Walk from `tips` and collect the closure.
 * `depth` limits commit generations: depth 1 = tip commits only (plus their
 * trees/blobs); depth undefined = the full history. `stopAt` lists commits
 * whose parents are not walked (the client's shallow boundaries): the commit
 * itself and its tree/blobs are still collected.
 */
export function collectClosure(
  repo: Repo,
  tips: string[],
  depth?: number,
  stopAt?: Set<string>,
): Closure {
  const objects = new Set<string>();
  const shallow: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  const seenCommit = new Set<string>();
  for (const tip of tips) {
    if (tip !== ZERO_OID) queue.push({ oid: tip, gen: 0 });
  }
  const collectTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (objects.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') continue;
      objects.add(oid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  };
  // Index pointer instead of queue.shift(): shift() re-indexes the whole
  // array on every dequeue (O(n) each, O(n^2) total for a big closure).
  let head = 0;
  while (head < queue.length) {
    const { oid, gen } = queue[head++]!;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!objects.has(oid)) {
        objects.add(oid);
        const tag = parseTag(obj.data);
        queue.push({ oid: tag.object, gen });
      }
      continue;
    }
    if (obj.type !== 'commit') {
      objects.add(oid);
      continue;
    }
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    objects.add(oid);
    const commit = parseCommit(obj.data);
    collectTree(commit.tree);
    const atCutoff = depth !== undefined && gen >= depth - 1;
    const stopped = stopAt !== undefined && stopAt.has(oid);
    if (atCutoff) shallow.push(oid);
    if (!atCutoff && !stopped) {
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return { objects, shallow };
}

/** Is `ancestor` reachable from `descendant` (or equal)? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Best common ancestor of two commits (the one closest to both tips). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [{ oid: a, gen: 0 }];
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const { oid, gen } = queue[head++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    ancestorsA.set(oid, gen);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  let best: string | null = null;
  let bestGen = Infinity;
  const queueB: { oid: string; gen: number }[] = [{ oid: b, gen: 0 }];
  const seenB = new Set<string>();
  let headB = 0;
  while (headB < queueB.length) {
    const { oid, gen } = queueB[headB++]!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) {
      const total = gen + (ancestorsA.get(oid) ?? 0);
      if (total < bestGen) {
        bestGen = total;
        best = oid;
      }
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push({ oid: parent, gen: gen + 1 });
  }
  return best;
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build nested trees from a flat path -> blob oid map. Returns the root tree oid. */
export function buildTreeFromPaths(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Line counts for a simple line-multiset diff (additions, deletions). */
export function lineDiff(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  const countLines = (buf: Buffer): Map<string, number> => {
    const map = new Map<string, number>();
    const text = buf.toString('utf8');
    const lines = text === '' ? [] : text.split('\n');
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const ma = countLines(a);
  const mb = countLines(b);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of mb) additions += Math.max(0, n - (ma.get(line) ?? 0));
  for (const [line, n] of ma) deletions += Math.max(0, n - (mb.get(line) ?? 0));
  return { additions, deletions };
}

export function countLines(buf: Buffer): number {
  const text = buf.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}
