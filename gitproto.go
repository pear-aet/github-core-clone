// git smart HTTP: info/refs + upload-pack (v0/v2) + receive-pack (v0).
package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

const gitUser = "Forge Bot <forge@forge.local>"

func gitTime() string { return "1767225600 +0000" }

func advertisedCapsV0(r *Repo, service string) string {
	caps := "report-status side-band-64k agent=forge"
	if service == "upload-pack" {
		caps = "side-band-64k agent=forge"
	}
	head := r.Refs["refs/heads/main"]
	if head == "" {
		for _, v := range r.Refs {
			head = v
			break
		}
	}
	if head == "" {
		head = ZeroOID
	}
	return head + " HEAD\x00" + caps + "\n"
}

func handleInfoRefs(r *Repo, service string, proto string) (int, string, []byte) {
	if service == "upload-pack" && proto == "v2" {
		var out []byte
		out = append(out, pktLineStr("# service=git-upload-pack\n")...)
		out = append(out, pktLine(nil, PktFlush)...)
		out = append(out, pktLineStr("version 2\n")...)
		out = append(out, pktLineStr("agent=forge/1.0\n")...)
		out = append(out, pktLineStr("ls-refs=unborn\n")...)
		out = append(out, pktLineStr("fetch=shallow\n")...)
		out = append(out, pktLineStr("object-format=sha1\n")...)
		out = append(out, pktLine(nil, PktFlush)...)
		return 200, "application/x-git-upload-pack-advertisement", out
	}
	var out []byte
	preamble := "# service=git-" + service + "\n"
	out = append(out, pktLineStr(preamble)...)
	out = append(out, pktLine(nil, PktFlush)...)
	head := r.Refs["refs/heads/main"]
	if head == "" {
		for _, v := range r.Refs {
			head = v
			break
		}
	}
	if service == "upload-pack" {
		if head == "" {
			out = append(out, pktLineStr(ZeroOID+" capabilities^{}\x00multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter agent=forge ls-refs=unborn\n")...)
		} else {
			out = append(out, pktLineStr(head+" HEAD\x00multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter agent=forge ls-refs=unborn\n")...)
			var names []string
			for name := range r.Refs {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				out = append(out, pktLineStr(r.Refs[name]+" "+name+"\n")...)
			}
		}
	} else {
		if head == "" {
			out = append(out, pktLineStr(ZeroOID+" capabilities^{}\x00report-status delete-refs side-band-64k quiet atomic ofs-delta agent=forge\n")...)
		} else {
			out = append(out, pktLineStr(head+" HEAD\x00report-status delete-refs side-band-64k quiet atomic ofs-delta agent=forge\n")...)
			var names []string
			for name := range r.Refs {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				out = append(out, pktLineStr(r.Refs[name]+" "+name+"\n")...)
			}
		}
	}
	out = append(out, pktLine(nil, PktFlush)...)
	return 200, "application/x-git-" + service + "-advertisement", out
}

type uploadReq struct {
	wants     []string
	haves     []string
	protocol  string
	lsRefs    bool
	unborn    bool
	filter    string
	deepen    int
	deepenRel int
	shallow   []string
	since     int64
}

func parseUploadPack(body []byte, proto string) uploadReq {
	req := uploadReq{protocol: proto}
	lines := decodeAllPktLines(body)
	for _, ln := range lines {
		if ln.Kind != PktData {
			continue
		}
		s := string(ln.Payload)
		s = strings.TrimRight(s, "\n")
		if strings.HasPrefix(s, "want ") {
			parts := strings.SplitN(s[5:], " ", 2)
			req.wants = append(req.wants, parts[0])
		} else if strings.HasPrefix(s, "have ") {
			req.haves = append(req.haves, strings.TrimSpace(s[5:]))
		} else if s == "done" {
		} else if strings.HasPrefix(s, "shallow ") {
			req.shallow = append(req.shallow, strings.TrimSpace(s[8:]))
		} else if strings.HasPrefix(s, "deepen ") {
			fmt.Sscanf(s[7:], "%d", &req.deepen)
		} else if strings.HasPrefix(s, "deepen-relative ") {
			fmt.Sscanf(s[16:], "%d", &req.deepenRel)
		} else if strings.HasPrefix(s, "filter ") {
			req.filter = s[7:]
		} else if s == "ls-refs" {
			req.lsRefs = true
		} else if s == "unborn" {
			req.unborn = true
		} else if strings.HasPrefix(s, "command=") {
			if strings.Contains(s, "ls-refs") {
				req.lsRefs = true
			}
		}
	}
	if req.deepenRel > 0 {
		req.deepen = req.deepenRel
	}
	return req
}

func handleUploadPack(r *Repo, body []byte, proto string) (int, []byte) {
	req := parseUploadPack(body, proto)
	if req.lsRefs {
		// v2 ls-refs: parse peel/symrefs/unborn/ref-prefix from the request
		peel := false
		symrefs := false
		unborn := false
		var prefixes []string
		for _, ln := range decodeAllPktLines(body) {
			if ln.Kind != PktData {
				continue
			}
			s := strings.TrimRight(string(ln.Payload), "\n")
			if s == "peel" {
				peel = true
			} else if s == "symrefs" {
				symrefs = true
			} else if s == "unborn" {
				unborn = true
			} else if strings.HasPrefix(s, "ref-prefix ") {
				prefixes = append(prefixes, s[len("ref-prefix "):])
			}
		}
		matches := func(name string) bool {
			if len(prefixes) == 0 {
				return true
			}
			for _, p := range prefixes {
				if strings.HasPrefix(name, p) {
					return true
				}
			}
			return false
		}
		var out []byte
		head := r.Refs["refs/heads/main"]
		if head != "" {
			if matches("HEAD") {
				line := head + " HEAD"
				if symrefs {
					line += " symref-target:refs/heads/main"
				}
				out = append(out, pktLineStr(line+"\n")...)
			}
			var names []string
			for name := range r.Refs {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				if !matches(name) {
					continue
				}
				line := r.Refs[name] + " " + name
				if peel {
					if obj := r.Objects[r.Refs[name]]; obj != nil && obj.Type == Tag {
						if peeled := parseTag(obj.Data).Object; peeled != "" {
							line += " peeled:" + peeled
						}
					}
				}
				out = append(out, pktLineStr(line+"\n")...)
			}
		} else if unborn {
			out = append(out, pktLineStr("unborn HEAD symref-target:refs/heads/main\n")...)
		}
		out = append(out, pktLine(nil, PktFlush)...)
		return 200, out
	}
	if len(req.wants) == 0 {
		return 200, append(pktLineStr("NAK\n"), pktLine(nil, PktFlush)...)
	}
	depth := -1
	if req.deepen > 0 {
		depth = req.deepen
	}
	// planFetch: exclude objects the client already has (haves)
	stopAt := make(map[string]bool)
	for _, s := range req.shallow {
		stopAt[s] = true
	}
	held, _ := collectClosure(r, req.haves, nil, stopAt)
	wanted, newShallow := collectClosure(r, req.wants, ptrInt(depth), nil)
	send := make(map[string]bool)
	for oid := range wanted {
		if !held[oid] {
			send[oid] = true
		}
	}
	var acks []string
	for _, have := range req.haves {
		if _, ok := r.Objects[have]; ok {
			acks = append(acks, have)
		}
	}
	var unshallow []string
	for _, oid := range req.shallow {
		if wanted[oid] {
			found := false
			for _, s := range newShallow {
				if s == oid {
					found = true
					break
				}
			}
			if !found {
				unshallow = append(unshallow, oid)
			}
		}
	}
	pack := writePackFor(r, send)
	if proto == "v2" {
		var out []byte
		// acknowledgments section (only when client sent haves)
		if len(req.haves) > 0 {
			out = append(out, pktLineStr("acknowledgments\n")...)
			if len(acks) > 0 {
				for _, ack := range acks {
					out = append(out, pktLineStr("ACK "+ack+"\n")...)
				}
			} else {
				out = append(out, pktLineStr("NAK\n")...)
			}
			out = append(out, pktLineStr("ready\n")...)
			out = append(out, pktLine(nil, PktDelim)...)
		}
		// shallow-info section
		if len(newShallow) > 0 || len(unshallow) > 0 {
			out = append(out, pktLineStr("shallow-info\n")...)
			for _, sh := range newShallow {
				out = append(out, pktLineStr("shallow "+sh+"\n")...)
			}
			for _, sh := range unshallow {
				out = append(out, pktLineStr("unshallow "+sh+"\n")...)
			}
			out = append(out, pktLine(nil, PktDelim)...)
		}
		// wanted-refs section
		var wantedRefs []string
		for _, want := range req.wants {
			for name, oid := range r.Refs {
				if oid == want {
					wantedRefs = append(wantedRefs, want+" "+name+"\n")
				}
			}
		}
		if len(wantedRefs) > 0 {
			out = append(out, pktLineStr("wanted-refs\n")...)
			for _, ref := range wantedRefs {
				out = append(out, pktLineStr(ref)...)
			}
			out = append(out, pktLine(nil, PktDelim)...)
		}
		// packfile section
		out = append(out, pktLineStr("packfile\n")...)
		out = append(out, sidebandPack(pack)...)
		out = append(out, pktLine(nil, PktFlush)...)
		return 200, out
	}
	// v0 fetch
	var out []byte
	if len(acks) > 0 {
		for _, ack := range acks {
			out = append(out, pktLineStr("ACK "+ack+"\n")...)
		}
	} else {
		out = append(out, pktLineStr("NAK\n")...)
	}
	for _, sh := range newShallow {
		out = append(out, pktLineStr("shallow "+sh+"\n")...)
	}
	for _, sh := range unshallow {
		out = append(out, pktLineStr("unshallow "+sh+"\n")...)
	}
	out = append(out, pktLine(nil, PktFlush)...)
	out = append(out, sidebandPack(pack)...)
	out = append(out, pktLine(nil, PktFlush)...)
	return 200, out
}

func ptrInt(v int) *int {
	if v < 0 {
		return nil
	}
	return &v
}

func handleReceivePack(r *Repo, body []byte) (int, []byte) {
	lines := decodeAllPktLines(body)
	var commands []struct {
		oldOID, newOID, ref string
	}
	packStart := -1
	for i, ln := range lines {
		if ln.Kind != PktData {
			continue
		}
		s := string(ln.Payload)
		// First command line carries capabilities after a NUL byte; strip them.
		if nul := strings.IndexByte(s, 0); nul >= 0 {
			s = s[:nul]
		}
		s = strings.TrimRight(s, "\n")
		if len(s) >= 82 && isHex(s[:40]) && isHex(s[41:81]) {
			parts := strings.SplitN(s, " ", 3)
			if len(parts) >= 3 {
				commands = append(commands, struct{ oldOID, newOID, ref string }{parts[0], parts[1], strings.TrimSpace(parts[2])})
			}
		}
		if len(s) >= 4 && string(s[:4]) == "PACK" {
			packStart = i
			break
		}
	}
	// find raw PACK in body
	packIdx := bytes.Index(body, []byte("PACK"))
	if packIdx >= 0 {
		objects, err := readPack(body[packIdx:])
		if err == nil {
			for _, obj := range objects {
				if _, ok := r.Objects[obj.OID]; !ok {
					r.Objects[obj.OID] = &GitObject{Type: obj.Type, Data: obj.Data}
				}
			}
		}
	}
	var results []string
	for _, cmd := range commands {
		cur, ok := r.Refs[cmd.ref]
		if !ok {
			cur = ZeroOID
		}
		if cmd.oldOID != ZeroOID && cur != cmd.oldOID {
			results = append(results, "ng "+cmd.ref+" non-fast-forward\n")
			continue
		}
		if cmd.newOID == ZeroOID {
			delete(r.Refs, cmd.ref)
			results = append(results, "ok "+cmd.ref+"\n")
			continue
		}
		if cmd.oldOID != ZeroOID && !isAncestor(r, cmd.oldOID, cmd.newOID) {
			results = append(results, "ng "+cmd.ref+" non-fast-forward\n")
			continue
		}
		if cmd.oldOID == ZeroOID {
			r.Refs[cmd.ref] = cmd.newOID
		} else {
			r.Refs[cmd.ref] = cmd.newOID
		}
		results = append(results, "ok "+cmd.ref+"\n")
	}
	var report []byte
	report = append(report, []byte("unpack ok\n")...)
	for _, res := range results {
		report = append(report, []byte(res)...)
	}
	var out []byte
	out = append(out, sidebandPack(report)...)
	out = append(out, pktLine(nil, PktFlush)...)
	_ = packStart
	return 200, out
}

func isHex(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func oidBytes(oid string) []byte {
	b, _ := hex.DecodeString(oid)
	return b
}
