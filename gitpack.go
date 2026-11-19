// pkt-line framing and packfile read/write.
package main

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"sync"
)

type PktKind int

const (
	PktData PktKind = iota
	PktFlush
	PktDelim
	PktResponseEnd
)

type PktLine struct {
	Kind    PktKind
	Payload []byte
}

func pktLine(data []byte, kind PktKind) []byte {
	switch kind {
	case PktFlush:
		return []byte("0000")
	case PktDelim:
		return []byte("0001")
	}
	if data == nil {
		data = []byte{}
	}
	l := len(data) + 4
	return append([]byte(fmt.Sprintf("%04x", l)), data...)
}

func pktLineStr(s string) []byte { return pktLine([]byte(s), PktData) }

func decodePktLines(buf []byte) []PktLine {
	var out []PktLine
	off := 0
	for off+4 <= len(buf) {
		n, err := strconv.ParseInt(string(buf[off:off+4]), 16, 32)
		if err != nil {
			break
		}
		if n == 0 {
			out = append(out, PktLine{Kind: PktFlush})
			return out
		}
		if n == 1 {
			out = append(out, PktLine{Kind: PktDelim})
			off += 4
			continue
		}
		if n == 2 {
			out = append(out, PktLine{Kind: PktResponseEnd})
			off += 4
			continue
		}
		if off+int(n) > len(buf) {
			break
		}
		out = append(out, PktLine{Kind: PktData, Payload: buf[off+4 : off+int(n)]})
		off += int(n)
	}
	return out
}

func decodeAllPktLines(buf []byte) []PktLine {
	var out []PktLine
	off := 0
	for off+4 <= len(buf) {
		n, err := strconv.ParseInt(string(buf[off:off+4]), 16, 32)
		if err != nil {
			break
		}
		if n == 0 {
			out = append(out, PktLine{Kind: PktFlush})
			off += 4
			continue
		}
		if n == 1 {
			out = append(out, PktLine{Kind: PktDelim})
			off += 4
			continue
		}
		if n == 2 {
			out = append(out, PktLine{Kind: PktResponseEnd})
			off += 4
			continue
		}
		if off+int(n) > len(buf) {
			break
		}
		out = append(out, PktLine{Kind: PktData, Payload: buf[off+4 : off+int(n)]})
		off += int(n)
	}
	return out
}

func sidebandPack(pack []byte) []byte {
	var out []byte
	for off := 0; off < len(pack); {
		end := off + 65515
		if end > len(pack) {
			end = len(pack)
		}
		chunk := append([]byte{1}, pack[off:end]...)
		out = append(out, pktLine(chunk, PktData)...)
		off = end
	}
	return out
}

var typeNames = map[int]ObjType{1: Commit, 2: Tree, 3: Blob, 4: Tag}
var typeCodes = map[ObjType]int{Commit: 1, Tree: 2, Blob: 3, Tag: 4}

func readVarint(buf []byte, off int) (int, int) {
	v := int(buf[off] & 0x7f)
	i := off + 1
	for buf[off]&0x80 != 0 {
		v = ((v + 1) << 7) | int(buf[i]&0x7f)
		i++
		off = i - 1
	}
	return v, i
}

func readSizeEncoding(buf []byte, off int) (int, int, int) {
	first := buf[off]
	typ := int((first >> 4) & 0x07)
	size := int(first & 0x0f)
	shift := uint(4)
	i := off + 1
	for buf[off]&0x80 != 0 {
		size |= int(buf[i]&0x7f) << shift
		shift += 7
		i++
		off = i - 1
	}
	return typ, size, i
}

func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readVarint := func() int {
		v := 0
		shift := uint(0)
		for {
			b := delta[off]
			off++
			v |= int(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
		}
		return v
	}
	baseSize := readVarint()
	resultSize := readVarint()
	if baseSize != len(base) {
		return nil, errors.New("delta base size mismatch")
	}
	var parts [][]byte
	total := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			copyOff, copySize := 0, 0
			for i := 0; i < 4; i++ {
				if op&(1<<uint(i)) != 0 {
					copyOff |= int(delta[off]) << (8 * uint(i))
					off++
				}
			}
			for i := 0; i < 3; i++ {
				if op&(0x10<<uint(i)) != 0 {
					copySize |= int(delta[off]) << (8 * uint(i))
					off++
				}
			}
			if copySize == 0 {
				copySize = 0x10000
			}
			parts = append(parts, base[copyOff:copyOff+copySize])
			total += copySize
		} else if op != 0 {
			parts = append(parts, delta[off:off+int(op)])
			off += int(op)
			total += int(op)
		} else {
			return nil, errors.New("delta opcode 0")
		}
	}
	out := bytes.Join(parts, nil)
	if len(out) != resultSize || total != resultSize {
		return nil, errors.New("delta result size mismatch")
	}
	return out, nil
}

type PackObject struct {
	OID  string
	Type ObjType
	Data []byte
}

func readPack(pack []byte) ([]PackObject, error) {
	if len(pack) < 12 || string(pack[:4]) != "PACK" {
		return nil, errors.New("not a packfile")
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	count := binary.BigEndian.Uint32(pack[8:12])
	trailer := hex.EncodeToString(pack[len(pack)-20:])
	if trailer != sha1Hex(pack[:len(pack)-20]) {
		return nil, errors.New("pack trailer checksum mismatch")
	}
	var objects []PackObject
	byOffset := make(map[int]*PackObject)
	byOID := make(map[string]*PackObject)
	off := 12
	for i := uint32(0); i < count; i++ {
		startOff := off
		typ, size, next := readSizeEncoding(pack, off)
		off = next
		if typ == 6 || typ == 7 {
			var baseOID string
			baseOff := -1
			if typ == 7 {
				baseOID = hex.EncodeToString(pack[off : off+20])
				off += 20
			} else {
				v, after := readVarint(pack, off)
				off = after
				baseOff = startOff - v
			}
			delta, consumed, err := inflateFrom(pack, off)
			if err != nil {
				return nil, err
			}
			off += consumed
			var base *PackObject
			if typ == 7 {
				base = byOID[baseOID]
			} else {
				base = byOffset[baseOff]
			}
			if base == nil {
				return nil, errors.New("delta base not found in pack")
			}
			data, err := applyDelta(base.Data, delta)
			if err != nil {
				return nil, err
			}
			obj := PackObject{OID: objectID(base.Type, data), Type: base.Type, Data: data}
			objects = append(objects, obj)
			byOffset[startOff] = &objects[len(objects)-1]
			byOID[obj.OID] = &objects[len(objects)-1]
			_ = size
		} else {
			typeName, ok := typeNames[typ]
			if !ok {
				return nil, fmt.Errorf("unknown pack object type %d", typ)
			}
			data, consumed, err := inflateFrom(pack, off)
			if err != nil {
				return nil, err
			}
			if len(data) != size {
				return nil, errors.New("object size mismatch in pack")
			}
			off += consumed
			obj := PackObject{OID: objectID(typeName, data), Type: typeName, Data: data}
			objects = append(objects, obj)
			byOffset[startOff] = &objects[len(objects)-1]
			byOID[obj.OID] = &objects[len(objects)-1]
		}
	}
	return objects, nil
}

func inflateFrom(buf []byte, off int) ([]byte, int, error) {
	br := bytes.NewReader(buf[off:])
	zr, err := zlib.NewReader(br)
	if err != nil {
		return nil, 0, err
	}
	data, err := io.ReadAll(zr)
	zr.Close()
	if err != nil {
		return nil, 0, err
	}
	// The zlib reader never over-reads: the bytes.Reader position is exactly
	// the end of this stream, so one inflate gives both data and length.
	consumed := len(buf) - off - br.Len()
	return data, consumed, nil
}

func inflate(b []byte) ([]byte, error) {
	r, err := zlib.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}

var zlibWriterPool = sync.Pool{New: func() interface{} { return zlib.NewWriter(io.Discard) }}

func deflate(b []byte) []byte {
	var buf bytes.Buffer
	w := zlibWriterPool.Get().(*zlib.Writer)
	w.Reset(&buf)
	w.Write(b)
	w.Close()
	zlibWriterPool.Put(w)
	return buf.Bytes()
}

func writePack(objects []PackObject) []byte {
	var buf bytes.Buffer
	buf.WriteString("PACK")
	binary.Write(&buf, binary.BigEndian, uint32(2))
	binary.Write(&buf, binary.BigEndian, uint32(len(objects)))
	for _, obj := range objects {
		typeCode := typeCodes[obj.Type]
		size := len(obj.Data)
		first := byte((typeCode << 4) | (size & 0x0f))
		rem := size >> 4
		if rem > 0 {
			first |= 0x80
		}
		buf.WriteByte(first)
		for rem > 0 {
			b := byte(rem & 0x7f)
			rem >>= 7
			if rem > 0 {
				b |= 0x80
			}
			buf.WriteByte(b)
		}
		buf.Write(deflate(obj.Data))
	}
	body := buf.Bytes()
	trailer, _ := hex.DecodeString(sha1Hex(body))
	return append(body, trailer...)
}

func writePackFor(r *Repo, oids map[string]bool) []byte {
	sorted := make([]string, 0, len(oids))
	for oid := range oids {
		sorted = append(sorted, oid)
	}
	sort.Strings(sorted)
	var objects []PackObject
	for _, oid := range sorted {
		if obj, ok := r.Objects[oid]; ok {
			objects = append(objects, PackObject{OID: oid, Type: obj.Type, Data: obj.Data})
		}
	}
	return writePack(objects)
}
