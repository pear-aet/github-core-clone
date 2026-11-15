// REST v3 (api.github.com-compatible subset).
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
// Auth: Bearer <MAKEFUN_SHOP_TOKEN>; missing/wrong token -> 401.
// A repository belongs to the token's login; the same name under another
// owner is 404, never 403.

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
  parseTree,
  storeObject,
  viewerIdent,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  requestCounter += 1;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter}`,
    ...extraHeaders,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, status: number): void {
  requestCounter += 1;
  res.writeHead(status, { 'x-github-request-id': `req-${requestCounter}` });
  res.end();
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1];
  const token = auth.match(/^token\s+(.+)$/i);
  if (token) return token[1];
  return null;
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = tokenOf(req);
  if (presented === null) return false;
  if (expected === '') return true; // local runs without an env token accept any bearer
  return presented === expected;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1001, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.created_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: issue.user.login },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: mergeableState(repo, pull),
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    user: { login: pull.user.login },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** MERGEABLE / CONFLICTING / UNKNOWN for an open pull request. */
export function mergeableState(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return hasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/** The base branch's CURRENT tip (a PR created before an earlier merge must be judged against the tip as it stands now, not its creation-time snapshot). */
function currentBaseSha(repo: Repo, pull: Pull): string {
  return resolveBranchTip(repo, pull.base.ref) ?? pull.base.sha;
}

function hasConflict(repo: Repo, pull: Pull): boolean {
  const baseSha = currentBaseSha(repo, pull);
  const base = mergeBase(repo, baseSha, pull.head.sha);
  if (base === null) return false;
  const baseCommit = repo.objects.get(base);
  const baseTip = repo.objects.get(baseSha);
  const headTip = repo.objects.get(pull.head.sha);
  if (!baseCommit || !baseTip || !headTip) return false;
  const baseTree = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const baseTipTree = flattenTree(repo, parseCommit(baseTip.data).tree);
  const headTree = flattenTree(repo, parseCommit(headTip.data).tree);
  const paths = new Set([...baseTree.keys(), ...baseTipTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path)?.oid;
    const t = baseTipTree.get(path)?.oid;
    const h = headTree.get(path)?.oid;
    const baseChanged = b !== t;
    const headChanged = b !== h;
    if (baseChanged && headChanged && t !== h) return true;
  }
  return false;
}

function parseBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function resolveBranchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function resolveRefTip(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.objects.has(ref)) return ref;
  return undefined;
}

/** Commit a new tree state on `branch` (creating the branch if needed). */
function commitTree(
  repo: Repo,
  branch: string,
  files: Map<string, string>,
  message: string,
): string {
  const treeOid = buildTreeFromPaths(repo, files);
  const tip = resolveBranchTip(repo, branch);
  const parents = tip ? [tip] : [];
  const commit = buildCommit(treeOid, parents, viewerIdent(), viewerIdent(), message);
  const oid = storeObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

function filesAtTip(repo: Repo, branch: string): Map<string, string> {
  const tip = resolveBranchTip(repo, branch);
  if (!tip) return new Map();
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return new Map();
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const out = new Map<string, string>();
  for (const [path, entry] of flat) out.set(path, entry.oid);
  return out;
}

function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** Look up a path in a tree; returns {kind:'file', oid} | {kind:'dir', oid} | null. */
function lookupPath(
  repo: Repo,
  treeOid: string,
  segments: string[],
): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Buffer,
): boolean {
  if (!path.startsWith('/api/v3')) return false;
  const rest = path.slice('/api/v3'.length) || '/';
  const parts = rest.split('/').filter((s) => s.length > 0);
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  // API root: the starter answers it without auth; keep that.
  if (method === 'GET' && (rest === '/' || rest === '')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
      'x-oauth-scopes': 'repo, read:org',
    });
    return true;
  }

  if (!authorized(req)) {
    err(res, 401, 'Requires authentication');
    return true;
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    err(res, 400, 'Problems parsing JSON');
    return true;
  }
  const input = parsed.value;

  // GET /meta
  if (method === 'GET' && parts.length === 1 && parts[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /user
  if (method === 'GET' && parts.length === 1 && parts[0] === 'user') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: VIEWER.type,
    });
    return true;
  }

  // GET /user/repos (paginated) / POST /user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.listRepos(VIEWER.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const host = req.headers.host ?? 'localhost';
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      if (page < totalPages) {
        const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
        headers.link =
          `<${base}&page=${page + 1}>; rel="next", <${base}&page=${totalPages}>; rel="last"`;
      }
      sendJson(res, 200, slice.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name) {
        err(res, 400, 'name is required');
        return true;
      }
      if (store.getRepo(VIEWER.login, name)) {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return true;
      }
      const repo = store.createRepo(VIEWER.login, name, {
        private: input.private === true,
        description: typeof input.description === 'string' ? input.description : '',
      });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // POST /orgs/{org}/repos
  if (method === 'POST' && parts.length === 3 && parts[0] === 'orgs' && parts[2] === 'repos') {
    const org = decode(parts[1]);
    const name = typeof input.name === 'string' ? input.name : '';
    if (!name) {
      err(res, 400, 'name is required');
      return true;
    }
    if (store.getRepo(org, name)) {
      sendJson(res, 422, {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
      return true;
    }
    const repo = store.createRepo(org, name, {
      private: input.private === true,
      description: typeof input.description === 'string' ? input.description : '',
    });
    sendJson(res, 201, repoJson(repo));
    return true;
  }

  // GET /orgs/{org}
  if (method === 'GET' && parts.length === 2 && parts[0] === 'orgs') {
    sendJson(res, 200, { login: decode(parts[1]), id: 2000, type: 'Organization' });
    return true;
  }

  // /repos/{owner}/{name}/...
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = decode(parts[1]);
    const name = decode(parts[2]);
    const repo = store.getRepo(owner, name);
    const tail = parts.slice(3);

    // GET /repos/{o}/{r}
    if (method === 'GET' && tail.length === 0) {
      if (!repo) {
        err(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    // PATCH /repos/{o}/{r}
    if (method === 'PATCH' && tail.length === 0) {
      if (!repo) {
        err(res, 404, 'Not Found');
        return true;
      }
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.default_branch === 'string' && input.default_branch) {
        repo.defaultBranch = input.default_branch;
      }
      if (typeof input.name === 'string' && input.name && input.name !== repo.name) {
        store.deleteRepo(repo.owner, repo.name);
        repo.name = input.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    // DELETE /repos/{o}/{r}
    if (method === 'DELETE' && tail.length === 0) {
      if (!repo) {
        err(res, 404, 'Not Found');
        return true;
      }
      store.deleteRepo(owner, name);
      sendNoContent(res, 204);
      return true;
    }
    if (!repo) {
      err(res, 404, 'Not Found');
      return true;
    }

    // git refs
    if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      // GET /git/refs (list all)
      if (method === 'GET' && tail.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha } }));
        sendJson(res, 200, refs);
        return true;
      }
      // POST /git/refs {ref, sha}
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref || !sha || !repo.objects.has(sha)) {
          err(res, 422, 'Invalid ref or sha');
          return true;
        }
        if (repo.refs.has(ref)) {
          err(res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return true;
      }
      // GET /git/refs/heads/{branch}
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const branch = decode(tail[3]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          err(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } });
        return true;
      }
    }

    // branches
    if (tail.length >= 1 && tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
        sendJson(res, 200, branches);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = decode(tail[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          err(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha } });
        return true;
      }
    }

    // commits
    if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      const shaParam = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRefTip(repo, shaParam);
      if (!tip) {
        err(res, 404, 'Not Found');
        return true;
      }
      const list: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const oid = stack.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.data);
        const parseIdent = (line: string): { name: string; email: string; date: string } => {
          const m = line.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
          if (!m) return { name: line, email: '', date: FIXED_TS };
          return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
        };
        list.push({
          sha: oid,
          commit: {
            message: info.message,
            author: parseIdent(info.author),
            committer: parseIdent(info.committer),
            tree: { sha: info.tree },
          },
        });
        for (const parent of info.parents) stack.push(parent);
      }
      sendJson(res, 200, list);
      return true;
    }

    // contents
    if (tail.length >= 1 && tail[0] === 'contents') {
      const contentPath = tail.slice(1).map(decode).join('/');
      const branch = typeof query.get('ref') === 'string' && query.get('ref') ? query.get('ref')! : repo.defaultBranch;
      if (method === 'GET') {
        const tip = resolveRefTip(repo, branch);
        if (!tip) {
          err(res, 404, 'Not Found');
          return true;
        }
        const commitObj = repo.objects.get(tip);
        if (!commitObj || commitObj.type !== 'commit') {
          err(res, 404, 'Not Found');
          return true;
        }
        const treeOid = parseCommit(commitObj.data).tree;
        const segments = pathSegments(contentPath);
        if (segments.length === 0) {
          const obj = repo.objects.get(treeOid);
          const entries = obj ? parseTree(obj.data) : [];
          sendJson(res, 200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
          })));
          return true;
        }
        const found = lookupPath(repo, treeOid, segments);
        if (!found) {
          err(res, 404, 'Not Found');
          return true;
        }
        if (found.kind === 'dir') {
          const obj = repo.objects.get(found.oid);
          const entries = obj ? parseTree(obj.data) : [];
          sendJson(res, 200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${contentPath}/${e.name}`,
            sha: e.oid,
          })));
          return true;
        }
        const blob = repo.objects.get(found.oid);
        if (!blob) {
          err(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: found.oid,
          size: blob.data.length,
          name: segments[segments.length - 1],
          path: contentPath,
        });
        return true;
      }
      if (method === 'PUT') {
        const message = typeof input.message === 'string' ? input.message : 'Update file';
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        const putBranch = typeof input.branch === 'string' && input.branch ? input.branch : repo.defaultBranch;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        if (!contentB64) {
          err(res, 400, 'content is required');
          return true;
        }
        const files = filesAtTip(repo, putBranch);
        const existing = files.get(contentPath);
        if (existing && sha && sha !== existing) {
          err(res, 409, 'sha does not match');
          return true;
        }
        if (!existing && sha) {
          err(res, 409, 'sha does not match');
          return true;
        }
        const isUpdate = existing !== undefined;
        const blobOid = storeObject(repo, 'blob', Buffer.from(contentB64, 'base64'));
        files.set(contentPath, blobOid);
        const commitOid = commitTree(repo, putBranch, files, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            type: 'file',
            encoding: 'base64',
            content: contentB64,
            sha: blobOid,
            size: Buffer.from(contentB64, 'base64').length,
            name: pathSegments(contentPath).pop() ?? contentPath,
            path: contentPath,
          },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const message = typeof input.message === 'string' ? input.message : 'Delete file';
        const delBranch = typeof input.branch === 'string' && input.branch ? input.branch : repo.defaultBranch;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const files = filesAtTip(repo, delBranch);
        const existing = files.get(contentPath);
        if (!existing) {
          err(res, 404, 'Not Found');
          return true;
        }
        if (sha && sha !== existing) {
          err(res, 409, 'sha does not match');
          return true;
        }
        files.delete(contentPath);
        const commitOid = commitTree(repo, delBranch, files, message);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return true;
      }
    }

    // labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
        return true;
      }
      if (method === 'POST') {
        const name = typeof input.name === 'string' ? input.name : '';
        const color = typeof input.color === 'string' ? input.color : '000000';
        if (!name) {
          err(res, 400, 'name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          err(res, 422, 'Label already exists');
          return true;
        }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color });
        return true;
      }
    }

    // issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      // GET /issues/{n}/comments, POST /issues/{n}/comments
      if (tail.length === 3 && tail[2] === 'comments') {
        const n = parseInt(tail[1], 10);
        const issue = repo.issues.get(n);
        if (!issue) {
          err(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, (repo.comments.get(n) ?? []).map((c) => ({
            id: c.id, body: c.body, user: { login: c.user.login }, created_at: c.created_at, updated_at: c.updated_at,
          })));
          return true;
        }
        if (method === 'POST') {
          const commentBody = typeof input.body === 'string' ? input.body : '';
          if (!commentBody) {
            err(res, 400, 'body is required');
            return true;
          }
          const comment = {
            id: store.nextId(),
            body: commentBody,
            user: { login: VIEWER.login },
            created_at: FIXED_TS,
            updated_at: FIXED_TS,
          };
          const list = repo.comments.get(n) ?? [];
          list.push(comment);
          repo.comments.set(n, list);
          sendJson(res, 201, {
            id: comment.id, body: comment.body, user: { login: comment.user.login },
            created_at: comment.created_at, updated_at: comment.updated_at,
          });
          return true;
        }
      }
      // GET /issues/{n}, PATCH /issues/{n}
      if (tail.length === 2) {
        const n = parseInt(tail[1], 10);
        const issue = repo.issues.get(n);
        if (!issue) {
          err(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue, repo));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          issue.updated_at = FIXED_TS;
          sendJson(res, 200, issueJson(issue, repo));
          return true;
        }
      }
      // GET /issues (list), POST /issues
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          const items: Record<string, unknown>[] = [];
          for (const issue of repo.issues.values()) {
            if (state !== 'all' && issue.state !== state) continue;
            items.push(issueJson(issue, repo));
          }
          // GitHub's /issues list also carries pull requests.
          for (const pull of repo.pulls.values()) {
            const pullState = pull.merged || pull.state === 'closed' ? 'closed' : 'open';
            if (state !== 'all' && pullState !== state) continue;
            const asIssue = issueJson(
              {
                id: pull.id, number: pull.number, title: pull.title, body: pull.body,
                state: pullState, labels: [], user: pull.user,
                created_at: pull.created_at, updated_at: pull.updated_at,
              },
              repo,
            );
            asIssue.pull_request = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` };
            items.push(asIssue);
          }
          items.sort((a, b) => {
            const na = a.number as number;
            const nb = b.number as number;
            return direction === 'asc' ? na - nb : nb - na;
          });
          sendJson(res, 200, items);
          return true;
        }
        if (method === 'POST') {
          const title = typeof input.title === 'string' ? input.title : '';
          if (!title) {
            err(res, 400, 'title is required');
            return true;
          }
          const labels = Array.isArray(input.labels) ? (input.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              err(res, 422, `Label "${label}" does not exist`);
              return true;
            }
          }
          repo.counter += 1;
          const issue: Issue = {
            id: store.nextId(),
            number: repo.counter,
            title,
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            labels,
            user: { login: VIEWER.login },
            created_at: FIXED_TS,
            updated_at: FIXED_TS,
          };
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueJson(issue, repo));
          return true;
        }
      }
    }

    // pulls
    if (tail.length >= 1 && tail[0] === 'pulls') {
      // GET /pulls/{n}/files
      if (tail.length === 3 && tail[2] === 'files') {
        const n = parseInt(tail[1], 10);
        const pull = repo.pulls.get(n);
        if (!pull) {
          err(res, 404, 'Not Found');
          return true;
        }
        const files = diffFiles(repo, pull);
        sendJson(res, 200, files);
        return true;
      }
      // PUT /pulls/{n}/merge
      if (tail.length === 3 && tail[2] === 'merge') {
        const n = parseInt(tail[1], 10);
        const pull = repo.pulls.get(n);
        if (!pull) {
          err(res, 404, 'Not Found');
          return true;
        }
        if (pull.state !== 'open') {
          err(res, 409, 'Pull request is already closed');
          return true;
        }
        if (hasConflict(repo, pull)) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return true;
        }
        const squashSha = squashMerge(repo, pull);
        sendJson(res, 200, { sha: squashSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      // GET /pulls/{n}
      if (method === 'GET' && tail.length === 2) {
        const n = parseInt(tail[1], 10);
        const pull = repo.pulls.get(n);
        if (!pull) {
          err(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(pull, repo));
        return true;
      }
      // GET /pulls (list), POST /pulls
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          const items: Record<string, unknown>[] = [];
          for (const pull of repo.pulls.values()) {
            if (state !== 'all' && pull.state !== state) continue;
            items.push(pullJson(pull, repo));
          }
          items.sort((a, b) => {
            const na = a.number as number;
            const nb = b.number as number;
            return direction === 'asc' ? na - nb : nb - na;
          });
          sendJson(res, 200, items);
          return true;
        }
        if (method === 'POST') {
          const title = typeof input.title === 'string' ? input.title : '';
          const headRaw = typeof input.head === 'string' ? input.head : '';
          const baseRaw = typeof input.base === 'string' ? input.base : '';
          if (!title || !headRaw || !baseRaw) {
            err(res, 400, 'title, head and base are required');
            return true;
          }
          const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) {
            err(res, 422, 'head or base branch does not exist');
            return true;
          }
          repo.counter += 1;
          const pull: Pull = {
            id: store.nextId(),
            number: repo.counter,
            title,
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
          sendJson(res, 201, pullJson(pull, repo));
          return true;
        }
      }
    }
  }

  return false;
}

function diffFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseCommit = repo.objects.get(pull.base.sha);
  const headCommit = repo.objects.get(pull.head.sha);
  if (!baseCommit || !headCommit) return [];
  const baseTree = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const headTree = flattenTree(repo, parseCommit(headCommit.data).tree);
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    if (b && !h) {
      const blob = repo.objects.get(b.oid);
      const lines = blob ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (!b && h) {
      const blob = repo.objects.get(h.oid);
      const lines = blob ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b && h && b.oid !== h.oid) {
      const blobB = repo.objects.get(b.oid);
      const blobH = repo.objects.get(h.oid);
      const diff = blobB && blobH ? lineDiff(blobB.data, blobH.data) : { additions: 1, deletions: 0 };
      out.push({
        filename: path,
        status: 'modified',
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
      });
    }
  }
  return out;
}

/** Squash-merge a pull request: merged tree on top of the base tip. */
export function squashMerge(repo: Repo, pull: Pull): string {
  const baseSha = currentBaseSha(repo, pull);
  const base = mergeBase(repo, baseSha, pull.head.sha);
  const baseCommit = repo.objects.get(baseSha);
  const headCommit = repo.objects.get(pull.head.sha);
  if (!baseCommit || !headCommit) throw new Error('merge: missing tip');
  const baseTipTree = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const headTree = flattenTree(repo, parseCommit(headCommit.data).tree);
  const merged = new Map<string, string>();
  for (const [path, entry] of baseTipTree) merged.set(path, entry.oid);
  if (base !== null) {
    const baseTreeObj = repo.objects.get(base);
    if (baseTreeObj) {
      const mergeBaseTree = flattenTree(repo, parseCommit(baseTreeObj.data).tree);
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
  } else {
    for (const [path, entry] of headTree) merged.set(path, entry.oid);
  }
  const treeOid = buildTreeFromPaths(repo, merged);
  const message = `${pull.title} (#${pull.number})`;
  const commit = buildCommit(treeOid, [baseSha], viewerIdent(), viewerIdent(), message);
  const sha = storeObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = FIXED_TS;
  pull.merge_commit_sha = sha;
  pull.updated_at = FIXED_TS;
  return sha;
}
