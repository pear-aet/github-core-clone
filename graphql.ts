// GraphQL v4: a small parser + executor for the fixed documents the suite
// sends. POST /api/graphql {query, variables}; a JSON array of operations
// answers with an array of results in order. Unauthenticated -> 401 exactly.
// Unknown field -> HTTP 200 with an errors array naming the field.
// Unknown repository -> data.repository = null, no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TS,
  VIEWER,
  buildCommit,
  buildTreeFromPaths,
  countLines,
  flattenTree,
  lineDiff,
  mergeBase,
  parseCommit,
  storeObject,
  viewerIdent,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { mergeableState } from './rest.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$[]!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      if (raw.includes('.') || raw.includes('e') || raw.includes('E')) {
        tokens.push({ kind: 'float', value: parseFloat(raw) });
      } else {
        tokens.push({ kind: 'int', value: parseInt(raw, 10) });
      }
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type Value =
  | string
  | number
  | boolean
  | null
  | { kind: 'var'; name: string }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface FieldNode {
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  children: FieldNode[];
  typeCondition: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  fields: FieldNode[];
  varDefaults: Record<string, Value>;
}

export interface Fragment {
  typeCondition: string;
  fields: FieldNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  fragments = new Map<string, Fragment>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('unexpected end of query');
    this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`expected ${value}, got ${tok.kind === 'name' ? tok.value : JSON.stringify(tok)}`);
    }
  }

  expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected name, got ${tok.kind}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        const fields = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, fields });
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        kind = tok.value;
        this.next();
        // optional operation name
        const next = this.peek();
        if (next?.kind === 'name') this.next();
      }
      // optional variable definitions
      const varDefaults: Record<string, Value> = {};
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          this.expectPunct('$');
          const name = this.expectName();
          this.expectPunct(':');
          // type: a name, possibly wrapped in [] and !
          this.parseType();
          if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
            this.next();
            varDefaults[name] = this.parseValue();
          }
          if (this.pos >= this.tokens.length) break;
        }
        this.expectPunct(')');
      }
      const fields = this.parseSelectionSet();
      operations.push({ kind, fields, varDefaults });
    }
    return operations;
  }

  parseType(): void {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      fields.push(...this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  parseField(): FieldNode[] {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const children = this.parseSelectionSet();
        return [{ name: '', alias: null, args: [], children, typeCondition }];
      }
      if (next?.kind === 'name') {
        const name = this.next().value as string;
        const frag = this.fragments.get(name);
        if (!frag) throw new Error(`unknown fragment ${name}`);
        return frag.fields;
      }
      throw new Error('bad fragment spread');
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    // directives (@skip etc.): skip name + optional args
    const args: { name: string; value: Value }[] = [];
    while (this.peek()?.kind === 'punct' && (this.peek()?.value === '(' || this.peek()?.value === '@')) {
      if (this.peek()?.value === '@') {
        this.next();
        this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArgs();
        continue;
      }
      args.push(...this.parseArgs());
    }
    let children: FieldNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      children = this.parseSelectionSet();
    }
    return [{ name, alias, args, children, typeCondition: null }];
  }

  parseArgs(): { name: string; value: Value }[] {
    this.expectPunct('(');
    const args: { name: string; value: Value }[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      if (this.pos >= this.tokens.length) break;
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): Value {
    const tok = this.next();
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'int' || tok.kind === 'float') return tok.value;
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'var', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
        if (this.pos >= this.tokens.length) break;
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
        if (this.pos >= this.tokens.length) break;
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.kind}`);
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (value.kind === 'var') return variables[value.name] ?? null;
    if (value.kind === 'enum') return value.value;
    if (value.kind === 'list') return value.items.map((item) => resolveValue(item, variables));
    if (value.kind === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
  return value;
}

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoFromGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  const [owner, name] = decoded.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function issueFromGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return null;
  const m = decoded.key.match(/^(.+)\/(.+)#(\d+)$/);
  if (!m) return null;
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(m[3], 10));
  return issue ? { repo, issue } : null;
}

function pullFromGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  const m = decoded.key.match(/^(.+)\/(.+)#(\d+)$/);
  if (!m) return null;
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) return null;
  const pull = repo.pulls.get(parseInt(m[3], 10));
  return pull ? { repo, pull } : null;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPO_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
];

class Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[] = [];

  constructor(store: Store, variables: Record<string, unknown>) {
    this.store = store;
    this.variables = variables;
  }

  argValue(field: FieldNode, name: string): unknown {
    const arg = field.args.find((a) => a.name === name);
    return arg ? resolveValue(arg.value, this.variables) : undefined;
  }

  key(field: FieldNode): string {
    return field.alias ?? field.name;
  }

  unknownField(field: FieldNode, typeName: string): null {
    this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }

  select(fields: FieldNode[], obj: Record<string, unknown>, typeName: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.name === '') {
        // inline fragment: merge its children
        Object.assign(out, this.select(field.children, obj, typeName));
        continue;
      }
      if (field.name === '__typename') {
        out[this.key(field)] = typeName;
        continue;
      }
      if (!(field.name in obj)) {
        out[this.key(field)] = this.unknownField(field, typeName);
        continue;
      }
      const value = obj[field.name];
      if (typeof value === 'function') {
        out[this.key(field)] = (value as (f: FieldNode) => unknown)(field);
      } else {
        out[this.key(field)] = value;
      }
    }
    return out;
  }

  // -- root ---------------------------------------------------------------

  executeQuery(op: Operation): Record<string, unknown> {
    const root: Record<string, unknown> = {
      viewer: (field: FieldNode) => this.select(field.children, this.viewerObj(), 'User'),
      repository: (field: FieldNode) => {
        const owner = this.argValue(field, 'owner') as string;
        const name = this.argValue(field, 'name') as string;
        const repo = this.store.getRepo(owner, name);
        if (!repo) return null;
        return this.select(field.children, this.repoObj(repo), 'Repository');
      },
      node: (field: FieldNode) => {
        const id = this.argValue(field, 'id') as string;
        return this.resolveNode(id, field.children);
      },
      __type: (field: FieldNode) => {
        const name = this.argValue(field, 'name') as string;
        return this.introspectType(name, field.children);
      },
    };
    const out: Record<string, unknown> = {};
    for (const field of op.fields) {
      if (field.name === '') {
        Object.assign(out, this.select(field.children, root, 'Query'));
        continue;
      }
      if (!(field.name in root)) {
        out[this.key(field)] = this.unknownField(field, 'Query');
        continue;
      }
      const value = root[field.name];
      out[this.key(field)] = typeof value === 'function' ? (value as (f: FieldNode) => unknown)(field) : value;
    }
    return out;
  }

  viewerObj(): Record<string, unknown> {
    return {
      login: VIEWER.login,
      id: globalId('User', VIEWER.login),
      databaseId: VIEWER.id,
      name: VIEWER.name,
    };
  }

  repoObj(repo: Repo): Record<string, unknown> {
    const self = this;
    return {
      id: globalId('Repository', `${repo.owner}/${repo.name}`),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: (field: FieldNode) => self.select(field.children, { login: repo.owner }, 'User'),
      defaultBranchRef: (field: FieldNode) => {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return self.select(field.children, { name: repo.defaultBranch }, 'Ref');
      },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      issue: (field: FieldNode) => {
        const number = self.argValue(field, 'number') as number;
        const issue = repo.issues.get(number);
        if (!issue) return null;
        return self.select(field.children, self.issueObj(repo, issue), 'Issue');
      },
      issues: (field: FieldNode) => self.issuesConnection(repo, field),
      pullRequests: (field: FieldNode) => self.pullsConnection(repo, field),
      pullRequest: (field: FieldNode) => {
        const number = self.argValue(field, 'number') as number;
        const pull = repo.pulls.get(number);
        if (!pull) return null;
        return self.select(field.children, self.pullObj(repo, pull), 'PullRequest');
      },
    };
  }

  issueObj(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
      number: issue.number,
      title: issue.title,
      state: issue.state.toUpperCase(),
      body: issue.body,
    };
  }

  pullState(pull: Pull): string {
    if (pull.merged) return 'MERGED';
    return pull.state.toUpperCase();
  }

  pullObj(repo: Repo, pull: Pull): Record<string, unknown> {
    const self = this;
    return {
      id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
      number: pull.number,
      title: pull.title,
      state: self.pullState(pull),
      merged: pull.merged,
      headRefName: pull.head.ref,
      baseRefName: pull.base.ref,
      mergeable: mergeableState(repo, pull),
      files: (field: FieldNode) => {
        const first = self.argValue(field, 'first') as number | undefined;
        const files = self.diffFiles(repo, pull);
        const nodes = (first !== undefined ? files.slice(0, first) : files).map((f) => ({ path: f.filename }));
        const out: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'nodes') {
            out[self.key(child)] = nodes.map((n) => self.select(child.children, n, 'PullRequestFile'));
          } else if (child.name === 'totalCount') {
            out[self.key(child)] = files.length;
          }
        }
        return out;
      },
    };
  }

  issuesConnection(repo: Repo, field: FieldNode): Record<string, unknown> {
    const first = this.argValue(field, 'first') as number | undefined;
    const after = this.argValue(field, 'after') as string | undefined;
    const states = this.argValue(field, 'states') as string[] | undefined;
    const orderBy = this.argValue(field, 'orderBy') as { field?: string; direction?: string } | undefined;
    let issues = [...repo.issues.values()];
    const wanted = states && states.length ? new Set(states.map((s) => s.toUpperCase())) : new Set(['OPEN']);
    issues = issues.filter((i) => wanted.has(i.state.toUpperCase()));
    const desc = orderBy?.direction === 'DESC' || (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'DESC');
    issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
    let start = 0;
    if (after) {
      try {
        const cursorNum = parseInt(Buffer.from(after, 'base64').toString('utf8'), 10);
        const idx = issues.findIndex((i) => i.number === cursorNum);
        if (idx >= 0) start = idx + 1;
      } catch {
        // bad cursor: start from the beginning
      }
    }
    const page = first !== undefined ? issues.slice(start, start + first) : issues.slice(start);
    const hasNextPage = start + page.length < issues.length;
    const endCursor = page.length ? Buffer.from(String(page[page.length - 1].number), 'utf8').toString('base64') : null;
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'nodes') {
        out[this.key(child)] = page.map((i) => this.select(child.children, this.issueObj(repo, i), 'Issue'));
      } else if (child.name === 'pageInfo') {
        const info: Record<string, unknown> = {};
        for (const grand of child.children) {
          if (grand.name === 'hasNextPage') info[this.key(grand)] = hasNextPage;
          else if (grand.name === 'endCursor') info[this.key(grand)] = endCursor;
        }
        out[this.key(child)] = info;
      } else if (child.name === 'totalCount') {
        out[this.key(child)] = issues.length;
      }
    }
    return out;
  }

  pullsConnection(repo: Repo, field: FieldNode): Record<string, unknown> {
    const first = this.argValue(field, 'first') as number | undefined;
    const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    const page = first !== undefined ? pulls.slice(0, first) : pulls;
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'nodes') {
        out[this.key(child)] = page.map((p) => this.select(child.children, this.pullObj(repo, p), 'PullRequest'));
      } else if (child.name === 'pageInfo') {
        const info: Record<string, unknown> = {};
        for (const grand of child.children) {
          if (grand.name === 'hasNextPage') info[this.key(grand)] = page.length < pulls.length;
          else if (grand.name === 'endCursor') {
            info[this.key(grand)] = page.length
              ? Buffer.from(String(page[page.length - 1].number), 'utf8').toString('base64')
              : null;
          }
        }
        out[this.key(child)] = info;
      } else if (child.name === 'totalCount') {
        out[this.key(child)] = pulls.length;
      }
    }
    return out;
  }

  resolveNode(id: string, children: FieldNode[]): Record<string, unknown> | null {
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    if (decoded.type === 'Repository') {
      const [owner, name] = decoded.key.split('/');
      const repo = owner && name ? this.store.getRepo(owner, name) : undefined;
      if (!repo) return null;
      return this.select(children, this.repoObj(repo), 'Repository');
    }
    if (decoded.type === 'Issue') {
      const found = issueFromGlobalId(this.store, id);
      if (!found) return null;
      return this.select(children, this.issueObj(found.repo, found.issue), 'Issue');
    }
    if (decoded.type === 'PullRequest') {
      const found = pullFromGlobalId(this.store, id);
      if (!found) return null;
      return this.select(children, this.pullObj(found.repo, found.pull), 'PullRequest');
    }
    return null;
  }

  introspectType(name: string, children: FieldNode[]): Record<string, unknown> | null {
    const fields: Record<string, string[]> = {
      Issue: ISSUE_FIELDS,
      PullRequest: PULL_FIELDS,
      Repository: REPO_FIELDS,
    };
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === 'name') out[this.key(child)] = name;
      else if (child.name === 'fields') {
        const names = fields[name] ?? [];
        out[this.key(child)] = names.map((n) => {
          const entry: Record<string, unknown> = {};
          for (const grand of child.children) {
            if (grand.name === 'name') entry[this.key(grand)] = n;
          }
          return entry;
        });
      } else if (child.name === 'enumValues') {
        const values = name === 'SearchType' ? ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] : [];
        out[this.key(child)] = values.map((v) => {
          const entry: Record<string, unknown> = {};
          for (const grand of child.children) {
            if (grand.name === 'name') entry[this.key(grand)] = v;
          }
          return entry;
        });
      }
    }
    if (name !== 'Issue' && name !== 'PullRequest' && name !== 'Repository' && name !== 'SearchType') return null;
    return out;
  }

  diffFiles(repo: Repo, pull: Pull): { filename: string; additions: number; deletions: number }[] {
    const baseCommit = repo.objects.get(pull.base.sha);
    const headCommit = repo.objects.get(pull.head.sha);
    if (!baseCommit || !headCommit) return [];
    const baseTree = flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headTree = flattenTree(repo, parseCommit(headCommit.data).tree);
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    const out: { filename: string; additions: number; deletions: number }[] = [];
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      if (b && !h) {
        const blob = repo.objects.get(b.oid);
        out.push({ filename: path, additions: 0, deletions: blob ? countLines(blob.data) : 0 });
      } else if (!b && h) {
        const blob = repo.objects.get(h.oid);
        out.push({ filename: path, additions: blob ? countLines(blob.data) : 0, deletions: 0 });
      } else if (b && h && b.oid !== h.oid) {
        const blobB = repo.objects.get(b.oid);
        const blobH = repo.objects.get(h.oid);
        const diff = blobB && blobH ? lineDiff(blobB.data, blobH.data) : { additions: 1, deletions: 0 };
        out.push({ filename: path, additions: diff.additions, deletions: diff.deletions });
      }
    }
    return out;
  }

  // -- mutations ------------------------------------------------------------

  executeMutation(op: Operation): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of op.fields) {
      if (field.name === 'createIssue') out[this.key(field)] = this.mutateCreateIssue(field);
      else if (field.name === 'closeIssue') out[this.key(field)] = this.mutateCloseIssue(field);
      else if (field.name === 'createPullRequest') out[this.key(field)] = this.mutateCreatePullRequest(field);
      else if (field.name === 'mergePullRequest') out[this.key(field)] = this.mutateMergePullRequest(field);
      else if (field.name === 'addComment') out[this.key(field)] = this.mutateAddComment(field);
      else out[this.key(field)] = this.unknownField(field, 'Mutation');
    }
    return out;
  }

  private mutateInput(field: FieldNode): Record<string, unknown> {
    const input = this.argValue(field, 'input') as Record<string, unknown> | undefined;
    return input ?? {};
  }

  private mutateCreateIssue(field: FieldNode): Record<string, unknown> | null {
    const input = this.mutateInput(field);
    const repo = repoFromGlobalId(this.store, String(input.repositoryId ?? ''));
    if (!repo) {
      this.errors.push({ message: 'repository not found' });
      return null;
    }
    const title = String(input.title ?? '');
    if (!title) {
      this.errors.push({ message: 'title is required' });
      return null;
    }
    repo.counter += 1;
    const issue: Issue = {
      id: this.store.nextId(),
      number: repo.counter,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      user: { login: VIEWER.login },
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    };
    repo.issues.set(issue.number, issue);
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'issue') {
        out[this.key(child)] = this.select(child.children, this.issueObj(repo, issue), 'Issue');
      }
    }
    return out;
  }

  private mutateCloseIssue(field: FieldNode): Record<string, unknown> | null {
    const input = this.mutateInput(field);
    const found = issueFromGlobalId(this.store, String(input.issueId ?? ''));
    if (!found) {
      this.errors.push({ message: 'issue not found' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updated_at = FIXED_TS;
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'issue') {
        out[this.key(child)] = this.select(child.children, this.issueObj(found.repo, found.issue), 'Issue');
      }
    }
    return out;
  }

  private mutateCreatePullRequest(field: FieldNode): Record<string, unknown> | null {
    const input = this.mutateInput(field);
    const repo = repoFromGlobalId(this.store, String(input.repositoryId ?? ''));
    if (!repo) {
      this.errors.push({ message: 'repository not found' });
      return null;
    }
    const baseRef = String(input.baseRefName ?? '');
    const headRef = String(input.headRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      this.errors.push({ message: 'head or base branch does not exist' });
      return null;
    }
    repo.counter += 1;
    const pull: Pull = {
      id: this.store.nextId(),
      number: repo.counter,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      user: { login: VIEWER.login },
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    };
    repo.pulls.set(pull.number, pull);
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'pullRequest') {
        out[this.key(child)] = this.select(child.children, this.pullObj(repo, pull), 'PullRequest');
      }
    }
    return out;
  }

  private mutateMergePullRequest(field: FieldNode): Record<string, unknown> | null {
    const input = this.mutateInput(field);
    const found = pullFromGlobalId(this.store, String(input.pullRequestId ?? ''));
    if (!found) {
      this.errors.push({ message: 'pull request not found' });
      return null;
    }
    const { repo, pull } = found;
    if (pull.state !== 'open') {
      this.errors.push({ message: 'pull request is already closed' });
      return null;
    }
    if (mergeableState(repo, pull) === 'CONFLICTING') {
      this.errors.push({ message: 'merge conflict' });
      return null;
    }
    // Squash merge (same construction as REST).
    const base = mergeBase(repo, pull.base.sha, pull.head.sha);
    const baseCommit = repo.objects.get(pull.base.sha);
    const headCommit = repo.objects.get(pull.head.sha);
    if (!baseCommit || !headCommit) {
      this.errors.push({ message: 'missing tip' });
      return null;
    }
    const baseTipTree = flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headTree = flattenTree(repo, parseCommit(headCommit.data).tree);
    const merged = new Map<string, string>();
    for (const [path, entry] of baseTipTree) merged.set(path, entry.oid);
    if (base !== null) {
      const baseObj = repo.objects.get(base);
      if (baseObj) {
        const mergeBaseTree = flattenTree(repo, parseCommit(baseObj.data).tree);
        const paths = new Set([...mergeBaseTree.keys(), ...headTree.keys()]);
        for (const path of paths) {
          const b = mergeBaseTree.get(path)?.oid;
          const h = headTree.get(path)?.oid;
          if (b !== h) {
            if (h === undefined) merged.delete(path);
            else merged.set(path, h);
          }
        }
      }
    }
    const treeOid = buildTreeFromPaths(repo, merged);
    const commit = buildCommit(treeOid, [pull.base.sha], viewerIdent(), viewerIdent(), `${pull.title} (#${pull.number})`);
    const sha = storeObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_TS;
    pull.merge_commit_sha = sha;
    pull.updated_at = FIXED_TS;
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'pullRequest') {
        out[this.key(child)] = this.select(child.children, this.pullObj(repo, pull), 'PullRequest');
      }
    }
    return out;
  }

  private mutateAddComment(field: FieldNode): Record<string, unknown> | null {
    const input = this.mutateInput(field);
    const found = issueFromGlobalId(this.store, String(input.subjectId ?? ''));
    if (!found) {
      this.errors.push({ message: 'issue not found' });
      return null;
    }
    const body = String(input.body ?? '');
    const comment = {
      id: this.store.nextId(),
      body,
      user: { login: VIEWER.login },
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    const nodeObj = {
      id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`),
      body: comment.body,
    };
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'commentEdge') {
        const edge: Record<string, unknown> = {};
        for (const grand of child.children) {
          if (grand.name === 'node') {
            edge[this.key(grand)] = this.select(grand.children, nodeObj, 'IssueComment');
          }
        }
        out[this.key(child)] = edge;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function handleGraphql(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const auth = req.headers.authorization ?? '';
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? auth.match(/^token\s+(.+)$/i)?.[1] ?? null;
  if (presented === null || (expected !== '' && presented !== expected)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: Record<string, unknown>[] = [];
  for (const item of operations) {
    const query = (item as { query?: unknown }).query;
    const variables = ((item as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') {
      results.push({ errors: [{ message: 'query is required' }] });
      continue;
    }
    try {
      const parser = new Parser(tokenize(query));
      const ops = parser.parseDocument();
      const executor = new Executor(store, variables);
      const data: Record<string, unknown> = {};
      for (const op of ops) {
        const partial = op.kind === 'mutation' ? executor.executeMutation(op) : executor.executeQuery(op);
        Object.assign(data, partial);
      }
      const result: Record<string, unknown> = { data };
      if (executor.errors.length) result.errors = executor.errors;
      results.push(result);
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}
