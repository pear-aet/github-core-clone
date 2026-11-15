// The forge's HTTP surface: git smart HTTP at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp,
// plus the /healthz boot probe. main.ts (the lifecycle) is untouched.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let fallbackRequestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  fallbackRequestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-fallback-${fallbackRequestCounter}`,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body =
          method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const action = gitMatch[3];
          if (method === 'GET' && action === 'info/refs') {
            handleInfoRefs(req, res, store, owner, repoName, url.searchParams.get('service') ?? '');
            return;
          }
          if (method === 'POST' && action === 'git-upload-pack') {
            handleUploadPack(req, res, store, owner, repoName, body);
            return;
          }
          if (method === 'POST' && action === 'git-receive-pack') {
            handleReceivePack(req, res, store, owner, repoName, body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          handleGraphql(store, req, res, body);
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          handleMcp(store, req, res, body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const handled = handleRest(store, req, res, method, path, url.searchParams, body);
          if (handled) return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        else res.end();
      }
    })();
  });
}
