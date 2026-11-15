// git smart HTTP: info/refs advertisements, upload-pack (v0 + v2),
// receive-pack (v0). Packs are stored byte-exact; fetch sends full objects.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectClosure,
  isAncestor,
  objectId,
  parseTag,
  type Repo,
  type Store,
} from './store.ts';
import {
  decodeAllPktLines,
  decodePktLines,
  pktLine,
  readPack,
  sidebandPack,
  writePack,
} from './gitpack.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function send(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8');
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

function allRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') line.peeled = parseTag(obj.data).object;
    out.push(line);
  }
  return out;
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

const UPLOAD_V0_CAPS =
  'side-band-64k shallow thin-pack ofs-delta multi_ack multi_ack_detailed agent=forge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k ofs-delta delete-refs agent=forge/1.0';

/** v0 advertisement: service preamble, flush, then refs (first line carries caps). */
function v0Advertisement(service: string, contentType: string, repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), pktLine('', 'flush')];
  const refs = allRefs(repo);
  const tip = defaultTip(repo);
  const first = `${tip} HEAD\0${caps}\n`;
  chunks.push(pktLine(first));
  for (const ref of refs) chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
  chunks.push(pktLine('', 'flush'));
  void contentType;
  return Buffer.concat(chunks);
}

/** v2 advertisement for upload-pack: service preamble, version 2, capabilities. */
function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const chunks: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('', 'flush'),
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine('', 'flush'),
  ];
  return Buffer.concat(chunks);
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'unknown service');
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (service === 'git-upload-pack' && protocol === 'version=2') {
    send(res, 200, v2Advertisement(repo), UPLOAD_AD);
    return;
  }
  // receive-pack stays v0 even when v2 is requested.
  send(res, 200, v0Advertisement(service, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, repo), service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
}

// ---------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const lines = decodeAllPktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const line of lines) {
    if (line.kind === 'flush') {
      section += 1;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').trimEnd();
    const parts = text.split(' ');
    if (parts[0] === 'want') req.wants.push(parts[1]);
    else if (parts[0] === 'have') req.haves.push(parts[1]);
    else if (parts[0] === 'shallow') req.shallow.push(parts[1]);
    else if (parts[0] === 'deepen') req.depth = parseInt(parts[1], 10);
    void section;
  }
  return req;
}

function parseV2Fetch(body: Buffer): FetchRequest {
  const lines = decodeAllPktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  let seenCommand = false;
  for (const line of lines) {
    if (line.kind === 'flush') {
      if (seenCommand) break;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').trimEnd();
    if (text.startsWith('command=fetch')) {
      seenCommand = true;
      continue;
    }
    if (text.startsWith('command=')) continue;
    const parts = text.split(' ');
    if (parts[0] === 'want') req.wants.push(parts[1]);
    else if (parts[0] === 'have') req.haves.push(parts[1]);
    else if (parts[0] === 'shallow') req.shallow.push(parts[1]);
    else if (parts[0] === 'deepen') req.depth = parseInt(parts[1], 10);
    // thin-pack / no-progress / ofs-delta / agent= / object-format= / done: accepted, ignored.
  }
  return req;
}

interface FetchPlan {
  send: Set<string>;
  newShallow: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const stopAt = new Set(req.shallow);
  const held = collectClosure(repo, req.haves, undefined, stopAt);
  const wanted = collectClosure(repo, req.wants, req.depth, undefined);
  const send = new Set<string>();
  for (const oid of wanted.objects) {
    if (!held.objects.has(oid)) send.add(oid);
  }
  const acks: string[] = [];
  for (const have of req.haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  const unshallow: string[] = [];
  for (const oid of req.shallow) {
    if (wanted.objects.has(oid) && !wanted.shallow.includes(oid)) unshallow.push(oid);
  }
  return { send, newShallow: wanted.shallow, unshallow, acks };
}

function handleV0Fetch(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const chunks: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  for (const oid of plan.newShallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.size) {
    const pack = writePackFor(repo, plan.send);
    chunks.push(sidebandPack(pack));
  }
  chunks.push(pktLine('', 'flush'));
  return Buffer.concat(chunks);
}

function handleV2Fetch(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const chunks: Buffer[] = [];
  // acknowledgments: only when the client sent haves (real git goes straight
  // to the packfile sections when it sent none). Always end with 'ready':
  // NAK + ready means "nothing in common, here is the full closure".
  if (req.haves.length) {
    chunks.push(pktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
    chunks.push(pktLine('ready\n'));
    chunks.push(pktLine('', 'delim'));
  }
  // shallow-info
  if (plan.newShallow.length || plan.unshallow.length) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.newShallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktLine('', 'delim'));
  }
  // wanted-refs
  const wantedRefs: string[] = [];
  for (const want of req.wants) {
    for (const ref of allRefs(repo)) {
      if (ref.oid === want) wantedRefs.push(`${want} ${ref.name}\n`);
    }
  }
  if (wantedRefs.length) {
    chunks.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) chunks.push(pktLine(line));
    chunks.push(pktLine('', 'delim'));
  }
  // packfile: always present (real git requires the section even for an
  // empty pack); an empty send set still yields a valid 0-object pack.
  chunks.push(pktLine('packfile\n'));
  chunks.push(sidebandPack(writePackFor(repo, plan.send)));
  chunks.push(pktLine('', 'delim'));
  chunks.push(pktLine('', 'flush'));
  return Buffer.concat(chunks);
}

function writePackFor(repo: Repo, oids: Set<string>): Buffer {
  const objects: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[] = [];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic pack order: sort by oid so replays are byte-identical.
  objects.sort((a, b) => {
    const oa = objectId(a.type, a.data);
    const ob = objectId(b.type, b.data);
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  return writePack(objects);
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  try {
    const protocol = req.headers['git-protocol'];
    if (protocol === 'version=2') {
      // v2 multiplexes ls-refs and fetch on the same endpoint; the first
      // command line names which one this request is.
      const first = decodeAllPktLines(body).find((l) => l.kind === 'data');
      const command = first?.payload.toString('utf8').trimEnd() ?? '';
      if (command.startsWith('command=ls-refs')) {
        handleLsRefs(req, res, store, owner, repoName, body);
        return;
      }
      const parsed = parseV2Fetch(body);
      send(res, 200, handleV2Fetch(repo, parsed), UPLOAD_RESULT);
    } else {
      const parsed = parseV0Fetch(body);
      send(res, 200, handleV0Fetch(repo, parsed), UPLOAD_RESULT);
    }
  } catch (err) {
    sendText(res, 400, `bad request: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export function handleLsRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  try {
    const lines = decodeAllPktLines(body);
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines) {
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').trimEnd();
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    const chunks: Buffer[] = [];
    const tip = defaultTip(repo);
    const matches = (name: string): boolean =>
      prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (tip !== ZERO_OID) {
      if (matches('HEAD')) {
        chunks.push(pktLine(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
      for (const ref of allRefs(repo)) {
        if (!matches(ref.name)) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
        chunks.push(pktLine(`${line}\n`));
      }
    } else if (unborn) {
      chunks.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
    chunks.push(pktLine('', 'flush'));
    send(res, 200, Buffer.concat(chunks), UPLOAD_RESULT);
  } catch (err) {
    sendText(res, 400, `bad request: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const reportLines: string[] = [];
  try {
    // Split the body at the first flush pkt-line: commands before it, pack after.
    let flushEnd = -1;
    {
      let offset = 0;
      while (offset + 4 <= body.length) {
        const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
        if (Number.isNaN(len)) throw new Error('bad pkt-line in push');
        if (len === 0) {
          flushEnd = offset + 4;
          break;
        }
        offset += len;
      }
    }
    if (flushEnd < 0) throw new Error('push body has no flush after commands');
    const commandBody = body.subarray(0, flushEnd);
    const packBody = body.subarray(flushEnd);
    const commands: PushCommand[] = [];
    for (const line of decodePktLines(commandBody)) {
      if (line.kind !== 'data') continue;
      let text = line.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const parts = text.trimEnd().split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    // Unpack.
    let unpackOk = true;
    let unpackDetail = '';
    if (packBody.length > 0) {
      try {
        const objects = readPack(packBody);
        for (const obj of objects) {
          if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
    const results: { ref: string; ok: boolean; reason?: string }[] = [];
    if (!unpackOk) {
      for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      reportLines.push(`unpack ${unpackDetail}\n`);
    } else {
      reportLines.push('unpack ok\n');
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          // Delete.
          if (current === undefined) {
            results.push({ ref: cmd.ref, ok: false, reason: 'cannot delete a ref that does not exist' });
          } else if (current !== cmd.oldOid) {
            results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          } else {
            repo.refs.delete(cmd.ref);
            results.push({ ref: cmd.ref, ok: true });
          }
          continue;
        }
        const newObj = repo.objects.get(cmd.newOid);
        if (!newObj) {
          results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
          continue;
        }
        if (current === undefined) {
          if (cmd.oldOid !== ZERO_OID) {
            results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
            continue;
          }
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true });
          continue;
        }
        if (current !== cmd.oldOid) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        // Fast-forward check for commit-to-commit updates.
        const oldObj = repo.objects.get(cmd.oldOid);
        if (
          oldObj?.type === 'commit' &&
          newObj.type === 'commit' &&
          cmd.oldOid !== cmd.newOid &&
          !isAncestor(repo, cmd.oldOid, cmd.newOid)
        ) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true });
      }
    }
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
    }
    const reportStream = Buffer.concat([
      ...reportLines.map((line) => pktLine(line)),
      pktLine('', 'flush'),
    ]);
    const bodyOut = Buffer.concat([sidebandPack(reportStream), pktLine('', 'flush')]);
    send(res, 200, bodyOut, RECEIVE_RESULT);
  } catch (err) {
    sendText(res, 400, `bad request: ${err instanceof Error ? err.message : String(err)}`);
  }
}
