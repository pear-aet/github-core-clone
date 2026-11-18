// MCP endpoint: JSON-RPC 2.0.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type mcpRequest struct {
	JSONRPC string                 `json:"jsonrpc"`
	ID      interface{}            `json:"id"`
	Method  string                 `json:"method"`
	Params  map[string]interface{} `json:"params"`
}

func mcpResult(id interface{}, result interface{}) map[string]interface{} {
	return map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": result}
}

func mcpError(id interface{}, code int, msg string) map[string]interface{} {
	return map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": map[string]interface{}{"code": code, "message": msg}}
}

func handleMCP(s *Store, w http.ResponseWriter, r *http.Request) {
	var req mcpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]interface{}{"jsonrpc": "2.0", "id": nil, "error": map[string]interface{}{"code": -32700, "message": "Parse error"}})
		return
	}
	switch req.Method {
	case "initialize", "server/discover":
		jsonWrite(w, 200, mcpResult(req.ID, map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"supportedVersions": []string{"2024-11-05", "2025-03-26", "2025-06-18"},
			"capabilities": map[string]interface{}{"tools": map[string]interface{}{}},
			"serverInfo": map[string]interface{}{"name": "forge", "version": "1.0.0"},
		}))
		return
	case "tools/list":
		jsonWrite(w, 200, mcpResult(req.ID, map[string]interface{}{"tools": mcpTools()}))
		return
	case "tools/call":
		name, _ := req.Params["name"].(string)
		if !isKnownTool(name) {
			jsonWrite(w, 200, mcpError(req.ID, -32602, "Unknown tool: "+name))
			return
		}
		args, _ := req.Params["arguments"].(map[string]interface{})
		res, errMsg := mcpCall(s, name, args)
		if errMsg != "" {
			jsonWrite(w, 200, mcpResult(req.ID, map[string]interface{}{"content": []map[string]interface{}{{"type": "text", "text": errMsg}}, "isError": true}))
			return
		}
		jsonWrite(w, 200, mcpResult(req.ID, map[string]interface{}{"content": []map[string]interface{}{{"type": "text", "text": res}}, "structuredContent": map[string]interface{}{"result": res}}))
		return
	case "notifications/initialized", "notifications/cancelled":
		jsonWrite(w, 200, mcpResult(req.ID, map[string]interface{}{}))
		return
	}
	jsonWrite(w, 200, mcpError(req.ID, -32601, "Method not found"))
}

func isKnownTool(name string) bool {
	for _, t := range mcpTools() {
		if t["name"] == name {
			return true
		}
	}
	return false
}

func mcpTools() []map[string]interface{} {
	str := func(desc string) map[string]interface{} { return map[string]interface{}{"type": "string", "description": desc} }
	bool := func(desc string) map[string]interface{} { return map[string]interface{}{"type": "boolean", "description": desc} }
	schema := func(props map[string]interface{}, req []string) map[string]interface{} {
		return map[string]interface{}{"type": "object", "properties": props, "required": req}
	}
	return []map[string]interface{}{
		{"name": "create_repo", "description": "Create a repository", "inputSchema": schema(map[string]interface{}{
			"owner": str("Owner login (defaults to the authenticated user)"), "name": str("Repository name"),
			"description": str("Repository description"), "private": bool("Whether the repository is private"),
		}, []string{"name"})},
		{"name": "get_repo", "description": "Get a repository by owner and name.", "inputSchema": schema(map[string]interface{}{
			"owner": str("Owner login"), "repo": str("Repository name"),
		}, []string{"owner", "repo"})},
		{"name": "create_issue", "description": "Create an issue in a repository.", "inputSchema": schema(map[string]interface{}{
			"owner": str("Owner login"), "repo": str("Repository name"),
			"title": str("Issue title"), "body": str("Issue body"),
		}, []string{"owner", "repo", "title"})},
		{"name": "list_issues", "description": "List issues in a repository.", "inputSchema": schema(map[string]interface{}{
			"owner": str("Owner login"), "repo": str("Repository name"),
			"state": str("Issue state filter"),
		}, []string{"owner", "repo"})},
		{"name": "create_pull_request", "description": "Create a pull request.", "inputSchema": schema(map[string]interface{}{
			"owner": str("Owner login"), "repo": str("Repository name"),
			"title": str("Pull request title"), "head": str("Head branch"), "base": str("Base branch"),
		}, []string{"owner", "repo", "title", "head", "base"})},
		{"name": "merge_pull_request", "description": "Merge a pull request.", "inputSchema": schema(map[string]interface{}{
			"owner": str("Owner login"), "repo": str("Repository name"),
			"number": map[string]interface{}{"type": "integer", "description": "Pull request number"},
		}, []string{"owner", "repo", "number"})},
	}
}

func mcpCall(s *Store, name string, args map[string]interface{}) (string, string) {
	switch name {
	case "create_repo":
		repoName, _ := args["repo"].(string)
		if repoName == "" {
			repoName, _ = args["name"].(string)
		}
		owner, _ := args["owner"].(string)
		if owner == "" {
			owner = "adaiversen"
		}
		if repoName == "" {
			return "", "name is required"
		}
		if s.GetRepo(owner, repoName) != nil {
			return "", "repository already exists"
		}
		repo := s.CreateRepo(owner, repoName, false, "")
		return "created repository " + repo.Owner + "/" + repo.Name, ""
	case "get_repo":
		owner, _ := args["owner"].(string)
		repoName, _ := args["repo"].(string)
		if repoName == "" {
			repoName, _ = args["name"].(string)
		}
		if owner == "" {
			owner = "adaiversen"
		}
		repo := s.GetRepo(owner, repoName)
		if repo == nil {
			return "", "repository not found"
		}
		return "repository " + repo.Owner + "/" + repo.Name + " (id " + strconv.Itoa(repo.ID) + ")", ""
	case "create_issue":
		owner, _ := args["owner"].(string)
		repoName, _ := args["repo"].(string)
		if repoName == "" {
			repoName, _ = args["name"].(string)
		}
		if owner == "" {
			owner = "adaiversen"
		}
		repo := s.GetRepo(owner, repoName)
		if repo == nil {
			return "", "repository not found"
		}
		title, _ := args["title"].(string)
		body, _ := args["body"].(string)
		repo.Counter++
		n := repo.Counter
		iss := &Issue{ID: 1000 + n, Number: n, Title: title, Body: body, State: "open", CreatedAt: FixedTS, UpdatedAt: FixedTS}
		iss.User.Login = "adaiversen"
		repo.Issues[n] = iss
		return "created issue #" + strconv.Itoa(n) + ": " + title, ""
	case "list_issues":
		owner, _ := args["owner"].(string)
		repoName, _ := args["repo"].(string)
		if repoName == "" {
			repoName, _ = args["name"].(string)
		}
		if owner == "" {
			owner = "adaiversen"
		}
		repo := s.GetRepo(owner, repoName)
		if repo == nil {
			return "", "repository not found"
		}
		var titles []string
		for _, n := range sortedIssueNums(repo) {
			titles = append(titles, "#"+strconv.Itoa(n)+" "+repo.Issues[n].Title)
		}
		return strings.Join(titles, "\n"), ""
	case "create_pull_request":
		owner, _ := args["owner"].(string)
		repoName, _ := args["repo"].(string)
		if repoName == "" {
			repoName, _ = args["name"].(string)
		}
		if owner == "" {
			owner = "adaiversen"
		}
		repo := s.GetRepo(owner, repoName)
		if repo == nil {
			return "", "repository not found"
		}
		title, _ := args["title"].(string)
		head, _ := args["head"].(string)
		base, _ := args["base"].(string)
		if base == "" {
			base = repo.DefaultBranch
		}
		repo.Counter++
		n := repo.Counter
		p := &Pull{ID: 3000 + n, Number: n, Title: title, State: "open", CreatedAt: FixedTS, UpdatedAt: FixedTS}
		p.User.Login = "adaiversen"
		p.Head.Ref = head
		p.Head.Sha = repo.Refs["refs/heads/"+head]
		p.Base.Ref = base
		p.Base.Sha = repo.Refs["refs/heads/"+base]
		repo.Pulls[n] = p
		return "created pull request #" + strconv.Itoa(n) + ": " + title, ""
	case "merge_pull_request":
		owner, _ := args["owner"].(string)
		repoName, _ := args["repo"].(string)
		if repoName == "" {
			repoName, _ = args["name"].(string)
		}
		if owner == "" {
			owner = "adaiversen"
		}
		repo := s.GetRepo(owner, repoName)
		if repo == nil {
			return "", "repository not found"
		}
		num := 0
		if f, ok := args["number"].(float64); ok {
			num = int(f)
		}
		p, ok := repo.Pulls[num]
		if !ok {
			return "", "pull request not found"
		}
		headSha := p.Head.Sha
		baseSha := p.Base.Sha
		var mergeTree string
		var parents []string
		if headObj := repo.Objects[headSha]; headObj != nil && headObj.Type == Commit {
			mergeTree = parseCommit(headObj.Data).Tree
			parents = []string{baseSha, headSha}
		}
		author := gitUser + " " + gitTime()
		mergeData := buildCommit(mergeTree, parents, author, author, "Merge pull request #"+itoa(p.Number))
		mergeOID := storeObject(repo, Commit, mergeData)
		repo.Refs["refs/heads/"+p.Base.Ref] = mergeOID
		p.Merged = true
		p.State = "closed"
		now := FixedTS
		p.MergedAt = &now
		p.MergeCommitSha = &mergeOID
		return "merged pull request #" + strconv.Itoa(num), ""
	}
	return "", "unknown tool: " + name
}
