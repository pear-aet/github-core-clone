// In-memory store + git object model. Deterministic fixed timestamps.
package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"sort"
	"strings"
)

const ZeroOID = "0000000000000000000000000000000000000000"
const FixedTS = "2026-01-01T00:00:00Z"
const FixedEpoch = 1767225600

type ObjType string

const (
	Commit ObjType = "commit"
	Tree   ObjType = "tree"
	Blob   ObjType = "blob"
	Tag    ObjType = "tag"
)

type GitObject struct {
	Type ObjType
	Data []byte
}

type Issue struct {
	ID        int      `json:"id"`
	Number    int      `json:"number"`
	Title     string   `json:"title"`
	Body      string   `json:"body"`
	State     string   `json:"state"`
	Labels    []string `json:"labels"`
	User      struct{ Login string `json:"login"` } `json:"user"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

type Pull struct {
	ID             int    `json:"id"`
	Number         int    `json:"number"`
	Title          string `json:"title"`
	Body           string `json:"body"`
	State          string `json:"state"`
	Merged         bool   `json:"merged"`
	MergedAt       *string `json:"merged_at"`
	MergeCommitSha *string `json:"merge_commit_sha"`
	Head           struct {
		Ref string `json:"ref"`
		Sha string `json:"sha"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
		Sha string `json:"sha"`
	} `json:"base"`
	User      struct{ Login string `json:"login"` } `json:"user"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type Comment struct {
	ID        int    `json:"id"`
	Body      string `json:"body"`
	User      struct{ Login string `json:"login"` } `json:"user"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type Repo struct {
	ID            int
	Owner         string
	Name          string
	Private       bool
	Description   string
	DefaultBranch string
	CreatedAt     string
	Refs          map[string]string
	Objects       map[string]*GitObject
	Issues        map[int]*Issue
	Pulls         map[int]*Pull
	Labels        map[string]struct{ Name, Color string }
	Comments      map[int][]*Comment
	Counter       int
}

type Store struct {
	Repos       map[string]*Repo
	NextRepoID  int
	NextObjID   int
}

func NewStore() *Store {
	return &Store{Repos: make(map[string]*Repo), NextRepoID: 5000, NextObjID: 1}
}

func (s *Store) key(owner, name string) string { return owner + "/" + name }

func (s *Store) GetRepo(owner, name string) *Repo { return s.Repos[s.key(owner, name)] }

func (s *Store) CreateRepo(owner, name string, priv bool, desc string) *Repo {
	r := &Repo{
		ID: s.NextRepoID, Owner: owner, Name: name, Private: priv, Description: desc,
		DefaultBranch: "main", CreatedAt: FixedTS,
		Refs: make(map[string]string), Objects: make(map[string]*GitObject),
		Issues: make(map[int]*Issue), Pulls: make(map[int]*Pull),
		Labels: make(map[string]struct{ Name, Color string }),
		Comments: make(map[int][]*Comment),
	}
	s.NextRepoID++
	s.Repos[s.key(owner, name)] = r
	return r
}

func sha1Hex(data []byte) string {
	h := sha1.Sum(data)
	return hex.EncodeToString(h[:])
}

func objectID(typ ObjType, data []byte) string {
	header := []byte(string(typ) + " " + itoa(len(data)) + "\x00")
	h := sha1.New()
	h.Write(header)
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func storeObject(r *Repo, typ ObjType, data []byte) string {
	oid := objectID(typ, data)
	if _, ok := r.Objects[oid]; !ok {
		r.Objects[oid] = &GitObject{Type: typ, Data: data}
	}
	return oid
}

type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

func sortTreeEntries(in []TreeEntry) []TreeEntry {
	out := make([]TreeEntry, len(in))
	copy(out, in)
	sort.Slice(out, func(i, j int) bool {
		ki := out[i].Name
		if out[i].Mode == "40000" {
			ki += "/"
		}
		kj := out[j].Name
		if out[j].Mode == "40000" {
			kj += "/"
		}
		return ki < kj
	})
	return out
}

func buildTree(entries []TreeEntry) []byte {
	var b []byte
	for _, e := range sortTreeEntries(entries) {
		b = append(b, []byte(e.Mode+" "+e.Name+"\x00")...)
		raw, _ := hex.DecodeString(e.OID)
		b = append(b, raw...)
	}
	return b
}

func parseTree(data []byte) []TreeEntry {
	var out []TreeEntry
	off := 0
	for off < len(data) {
		sp := indexByte(data[off:], ' ')
		if sp < 0 {
			break
		}
		nul := indexByte(data[off+sp+1:], 0)
		if nul < 0 {
			break
		}
		mode := string(data[off : off+sp])
		name := string(data[off+sp+1 : off+sp+1+nul])
		oid := hex.EncodeToString(data[off+sp+1+nul+1 : off+sp+1+nul+21])
		out = append(out, TreeEntry{Mode: mode, Name: name, OID: oid})
		off = off + sp + 1 + nul + 21
	}
	return out
}

func indexByte(b []byte, c byte) int {
	for i, v := range b {
		if v == c {
			return i
		}
	}
	return -1
}

type CommitInfo struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

// flattenTree returns a map of path -> blob OID for a tree (recursive).
func flattenTree(r *Repo, treeOID string, prefix string, out map[string]string) {
	obj := r.Objects[treeOID]
	if obj == nil || obj.Type != Tree {
		return
	}
	for _, e := range parseTree(obj.Data) {
		path := prefix + e.Name
		if e.Mode == "40000" {
			flattenTree(r, e.OID, path+"/", out)
		} else {
			out[path] = e.OID
		}
	}
}

// diffTrees returns the changed files between base and head trees.
func diffTrees(r *Repo, baseTree, headTree string) []map[string]interface{} {
	base := make(map[string]string)
	head := make(map[string]string)
	flattenTree(r, baseTree, "", base)
	flattenTree(r, headTree, "", head)
	var files []map[string]interface{}
	for path, headOID := range head {
		baseOID, ok := base[path]
		if !ok {
			additions := countLines(r, headOID)
			files = append(files, map[string]interface{}{"filename": path, "status": "added", "additions": additions, "deletions": 0, "changes": additions})
		} else if baseOID != headOID {
			additions := countLines(r, headOID)
			deletions := countLines(r, baseOID)
			files = append(files, map[string]interface{}{"filename": path, "status": "modified", "additions": additions, "deletions": deletions, "changes": additions + deletions})
		}
	}
	for path := range base {
		if _, ok := head[path]; !ok {
			deletions := countLines(r, base[path])
			files = append(files, map[string]interface{}{"filename": path, "status": "removed", "additions": 0, "deletions": deletions, "changes": deletions})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i]["filename"].(string) < files[j]["filename"].(string) })
	return files
}

func countLines(r *Repo, oid string) int {
	obj := r.Objects[oid]
	if obj == nil {
		return 0
	}
	return bytes.Count(obj.Data, []byte("\n")) + 1
}

func parseCommit(data []byte) CommitInfo {
	text := string(data)
	split := strings.Index(text, "\n\n")
	header, message := text, ""
	if split >= 0 {
		header, message = text[:split], text[split+2:]
	}
	info := CommitInfo{Message: message}
	for _, line := range strings.Split(header, "\n") {
		switch {
		case strings.HasPrefix(line, "tree "):
			info.Tree = strings.TrimSpace(line[5:])
		case strings.HasPrefix(line, "parent "):
			info.Parents = append(info.Parents, strings.TrimSpace(line[7:]))
		case strings.HasPrefix(line, "author "):
			info.Author = line[7:]
		case strings.HasPrefix(line, "committer "):
			info.Committer = line[10:]
		}
	}
	return info
}

func buildCommit(tree string, parents []string, author, committer, message string) []byte {
	var sb strings.Builder
	sb.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		sb.WriteString("parent " + p + "\n")
	}
	sb.WriteString("author " + author + "\n")
	sb.WriteString("committer " + committer + "\n")
	sb.WriteString("\n" + message)
	return []byte(sb.String())
}

type TagInfo struct {
	Object  string
	Type    string
	Tag     string
	Tagger  string
	Message string
}

func parseTag(data []byte) TagInfo {
	text := string(data)
	split := strings.Index(text, "\n\n")
	header, message := text, ""
	if split >= 0 {
		header, message = text[:split], text[split+2:]
	}
	info := TagInfo{Message: message}
	for _, line := range strings.Split(header, "\n") {
		switch {
		case strings.HasPrefix(line, "object "):
			info.Object = strings.TrimSpace(line[7:])
		case strings.HasPrefix(line, "type "):
			info.Type = strings.TrimSpace(line[5:])
		case strings.HasPrefix(line, "tag "):
			info.Tag = strings.TrimSpace(line[4:])
		case strings.HasPrefix(line, "tagger "):
			info.Tagger = line[7:]
		}
	}
	return info
}

// collectClosure walks from tips and returns reachable objects + shallow boundary.
func collectClosure(r *Repo, tips []string, depth *int, stopAt map[string]bool) (map[string]bool, []string) {
	objects := make(map[string]bool)
	var shallow []string
	type item struct {
		oid string
		gen int
	}
	queue := []item{}
	seenCommit := make(map[string]bool)
	for _, tip := range tips {
		if tip != ZeroOID {
			queue = append(queue, item{tip, 0})
		}
	}
	collectTree := func(treeOID string) {
		stack := []string{treeOID}
		for len(stack) > 0 {
			oid := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if objects[oid] {
				continue
			}
			obj := r.Objects[oid]
			if obj == nil || obj.Type != Tree {
				continue
			}
			objects[oid] = true
			for _, e := range parseTree(obj.Data) {
				if e.Mode == "40000" {
					stack = append(stack, e.OID)
				} else {
					objects[e.OID] = true
				}
			}
		}
	}
	head := 0
	for head < len(queue) {
		it := queue[head]
		head++
		obj := r.Objects[it.oid]
		if obj == nil {
			continue
		}
		if obj.Type == Tag {
			if !objects[it.oid] {
				objects[it.oid] = true
				tag := parseTag(obj.Data)
				queue = append(queue, item{tag.Object, it.gen})
			}
			continue
		}
		if obj.Type != Commit {
			objects[it.oid] = true
			continue
		}
		if seenCommit[it.oid] {
			continue
		}
		seenCommit[it.oid] = true
		objects[it.oid] = true
		c := parseCommit(obj.Data)
		collectTree(c.Tree)
		atCutoff := depth != nil && it.gen >= *depth-1
		stopped := stopAt != nil && stopAt[it.oid]
		if atCutoff {
			shallow = append(shallow, it.oid)
		}
		if !atCutoff && !stopped {
			for _, p := range c.Parents {
				queue = append(queue, item{p, it.gen + 1})
			}
		}
	}
	return objects, shallow
}

func isAncestor(r *Repo, ancestor, descendant string) bool {
	if ancestor == descendant {
		return true
	}
	seen := make(map[string]bool)
	stack := []string{descendant}
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if oid == ancestor {
			return true
		}
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := r.Objects[oid]
		if obj == nil {
			continue
		}
		if obj.Type == Tag {
			stack = append(stack, parseTag(obj.Data).Object)
			continue
		}
		if obj.Type != Commit {
			continue
		}
		stack = append(stack, parseCommit(obj.Data).Parents...)
	}
	return false
}
