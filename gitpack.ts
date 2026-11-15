// pkt-line framing and packfile read/write for git smart HTTP.
// Pack writing sends full objects only (no deltas); pack reading resolves
// REF_DELTA and OFS_DELTA so any client-built pack unpacks.

import { inflateSync, deflateSync } from 'node:zlib';
import { sha1Hex, objectId, type GitObject, type ObjType, type Repo } from './store.ts';

export const PKT_LINE_MAX = 65520;

export interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Encode one pkt-line. `flush` -> '0000', `delim` -> '0001'. */
export function pktLine(data: Buffer | string, kind: 'data' | 'flush' | 'delim' = 'data'): Buffer {
  if (kind === 'flush') return Buffer.from('0000', 'ascii');
  if (kind === 'delim') return Buffer.from('0001', 'ascii');
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** Decode all pkt-lines in a buffer. Stops at the first flush (inclusive). */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at offset ${offset}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return out;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Decode pkt-lines without stopping at a flush (the whole body). */
export function decodeAllPktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at offset ${offset}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Wrap pack bytes in sideband band-1 pkt-lines (max 65515 data bytes each). */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let i = offset + 1;
  while (buf[offset] & 0x80) {
    value = ((value + 1) << 7) | (buf[i] & 0x7f);
    i += 1;
    offset = i - 1;
  }
  return { value, next: i };
}

function readSizeEncoding(buf: Buffer, offset: number): { type: number; size: number; next: number } {
  const first = buf[offset];
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let i = offset + 1;
  while (buf[offset] & 0x80) {
    size |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
    offset = i - 1;
  }
  return { type, size, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  const resultSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/** Parse a packfile into objects (deltas resolved). Throws on bad checksum/format. */
export function readPack(pack: Buffer): PackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');
  const objects: PackObject[] = [];
  const byOffset = new Map<number, PackObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    const { type, size, next } = readSizeEncoding(pack, offset);
    offset = next;
    if (type === 6 || type === 7) {
      // OFS_DELTA (6) or REF_DELTA (7): resolve after the base is known.
      let baseOid: string | null = null;
      let baseOffset = -1;
      if (type === 7) {
        baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else {
        const { value, next: after } = readVarint(pack, offset);
        offset = after;
        baseOffset = startOffset - value;
      }
      const consumed = zlibConsumed(pack, offset);
      const delta = inflateSync(pack.subarray(offset, offset + consumed));
      offset += consumed;
      const base = baseOid !== null ? objects.find((o) => o.oid === baseOid) : byOffset.get(baseOffset);
      if (!base) throw new Error('delta base not found in pack');
      const data = applyDelta(base.data, delta);
      const obj: PackObject = { oid: objectId(base.type, data), type: base.type, data };
      objects.push(obj);
      byOffset.set(startOffset, obj);
      void size;
    } else {
      const typeName = TYPE_NAMES[type];
      if (!typeName) throw new Error(`unknown pack object type ${type}`);
      const consumed = zlibConsumed(pack, offset);
      const data = inflateSync(pack.subarray(offset, offset + consumed));
      if (data.length !== size) throw new Error('object size mismatch in pack');
      offset += consumed;
      const obj: PackObject = { oid: objectId(typeName, data), type: typeName, data };
      objects.push(obj);
      byOffset.set(startOffset, obj);
    }
  }
  return objects;
}

/** How many bytes the zlib stream at `offset` occupies (deflate stream end). */
function zlibConsumed(buf: Buffer, offset: number): number {
  // Node has no stream-length API, so binary-search the smallest prefix that
  // inflates cleanly. The predicate is monotone (a shorter prefix of a
  // truncated stream is also truncated; a longer prefix past the stream end
  // is ignored), so the search converges on the true stream length.
  const hi = buf.length - offset;
  let probe = 1;
  let ok = false;
  while (probe <= hi) {
    try {
      inflateSync(buf.subarray(offset, offset + probe));
      ok = true;
      break;
    } catch {
      if (probe >= hi) break;
      probe = Math.min(probe * 2, hi);
    }
  }
  if (!ok) throw new Error('unterminated zlib stream in pack');
  let lo = Math.floor(probe / 2) + 1;
  let hiBound = probe;
  while (lo < hiBound) {
    const mid = Math.floor((lo + hiBound) / 2);
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      hiBound = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Write a packfile of full objects (no deltas). */
export function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const typeCodes: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    const typeCode = typeCodes[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Build a pack from a repo's objects for the given oid set (full objects only). */
export function packFromRepo(repo: Repo, oids: Set<string>): Buffer {
  const objects: { type: ObjType; data: Buffer }[] = [];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return writePack(objects);
}
