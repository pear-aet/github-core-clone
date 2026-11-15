// MCP endpoint: POST /mcp, JSON-RPC 2.0, plain application/json responses.
// server/discover first (modern era), legacy initialize also answered.
// tools/call without Authorization -> HTTP 401 (checked before tool lookup).
// Body not JSON -> HTTP 400 with JSON-RPC error code -32700, id null.
// Unknown tool -> JSON-RPC -32601, HTTP 200. Missing args -> isError result.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_TS, VIEWER, type Repo, type Store } from './store.ts';
import { mergeableState, squashMerge } from './rest.ts';

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const presented = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? auth.match(/^token\s+(.+)$/i)?.[1] ?? null;
  if (presented === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

type RpcResult =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string };

function toolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): RpcResult {
  const owner = String(pick(args, 'owner', 'owner_login') ?? VIEWER.login);
  const repoName = String(pick(args, 'repo', 'repository') ?? '');
  const getRepo = (): Repo | undefined => (repoName ? store.getRepo(owner, repoName) : undefined);

  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(pick(args, 'name') ?? '');
      if (!repoNameArg) return { ok: true, result: toolError('name is required') };
      const repoOwner = String(pick(args, 'owner', 'owner_login') ?? VIEWER.login);
      if (store.getRepo(repoOwner, repoNameArg)) {
        return { ok: true, result: toolError(`repository ${repoOwner}/${repoNameArg} already exists`) };
      }
      const repo = store.createRepo(repoOwner, repoNameArg, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return {
        ok: true,
        result: toolResult({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          private: repo.private,
          default_branch: repo.defaultBranch,
        }),
      };
    }
    case 'get_repo': {
      const repo = getRepo();
      if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
      return {
        ok: true,
        result: toolResult({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
        }),
      };
    }
    case 'create_issue': {
      const repo = getRepo();
      if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
      const title = String(pick(args, 'title') ?? '');
      if (!title) return { ok: true, result: toolError('title is required') };
      repo.counter += 1;
      const issue = {
        id: store.nextId(),
        number: repo.counter,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        user: { login: VIEWER.login },
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      };
      repo.issues.set(issue.number, issue);
      return {
        ok: true,
        result: toolResult({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        }),
      };
    }
    case 'list_issues': {
      const repo = getRepo();
      if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
      const state = String(pick(args, 'state') ?? 'open');
      const issues = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return { ok: true, result: toolResult({ issues }) };
    }
    case 'create_pull_request': {
      const repo = getRepo();
      if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
      const title = String(pick(args, 'title') ?? '');
      const headRaw = String(pick(args, 'head') ?? '');
      const baseRaw = String(pick(args, 'base') ?? '');
      if (!title || !headRaw || !baseRaw) {
        return { ok: true, result: toolError('title, head and base are required') };
      }
      const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) {
        return { ok: true, result: toolError('head or base branch does not exist') };
      }
      repo.counter += 1;
      const pull = {
        id: store.nextId(),
        number: repo.counter,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        merged_at: null as string | null,
        merge_commit_sha: null as string | null,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        user: { login: VIEWER.login },
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      };
      repo.pulls.set(pull.number, pull);
      return {
        ok: true,
        result: toolResult({
          id: pull.id,
          number: pull.number,
          pull_number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: pull.head,
          base: pull.base,
        }),
      };
    }
    case 'merge_pull_request': {
      const repo = getRepo();
      if (!repo) return { ok: true, result: toolError(`repository ${owner}/${repoName} not found`) };
      const n = Number(pick(args, 'pull_number', 'number', 'pullNumber'));
      const pull = repo.pulls.get(n);
      if (!pull) return { ok: true, result: toolError(`pull request ${n} not found`) };
      if (pull.state !== 'open') return { ok: true, result: toolError('pull request is already closed') };
      if (mergeableState(repo, pull) === 'CONFLICTING') {
        return { ok: true, result: toolError('merge conflict') };
      }
      const sha = squashMerge(repo, pull);
      return {
        ok: true,
        result: toolResult({ merged: true, sha, state: 'closed', number: pull.number, pull_number: pull.number }),
      };
    }
    default:
      return { ok: false, code: -32601, message: `unknown tool: ${name}` };
  }
}

export function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const rpc = parsed as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = rpc.id ?? null;
  const method = rpc.method ?? '';

  // Notifications (no id) get a bare 200.
  if (rpc.id === undefined) {
    res.writeHead(200, { 'content-length': 0 });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-06-18'],
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === 'initialize') {
    const requested = (rpc.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested ?? '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? '';
    const args = params.arguments ?? {};
    const called = callTool(store, name, args);
    if (!called.ok) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: called.code, message: called.message } });
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, result: called.result });
    return;
  }

  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
}
