# github-core-clone-01 — a GitHub-compatible forge

A single-process, stdlib-only Node 22 server that speaks four GitHub
surfaces on one port:

- **git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack`
  (protocol v0 and v2, incl. `ls-refs`, shallow/deepen, sideband-64k) and
  `git-receive-pack` (report-status, fast-forward enforcement, per-ref
  ok/ng reports). Packs are written with full objects and read back with
  REF_DELTA / OFS_DELTA resolution; objects round-trip byte-exact.
- **REST v3** under `/api/v3` — repos, refs, branches, commits, contents
  (create/update/delete with blob-sha checks), labels, issues, comments,
  pull requests (incl. 3-way mergeability and squash merge), pagination
  with `Link` headers. Every reply is JSON with `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql` — viewer, repository, node, `__type`
  introspection, issues/pull-requests connections with cursor pagination,
  and the create/close-issue, create/merge-PR, add-comment mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0, `server/discover` + `initialize`,
  `tools/list` (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request) and `tools/call` returning
  both `content` text and `structuredContent`.

Auth is one bearer token (`MAKEFUN_SHOP_TOKEN`); a repository belongs to
the login the token names, so the same name under another owner is 404,
never 403. All state is in memory and every timestamp the forge itself
emits is fixed, so two runs on one instance leave the same state.

## Run it

```sh
node main.ts
```

`main.ts` is the entry <-> env lifecycle (bind an ephemeral port, register
it with `$MAKEFUN_ENV_URL`, wait for `/done`); the server is `app.ts`.
There is nothing to install: only `node:http`, `node:crypto` and
`node:zlib` from the standard library.
