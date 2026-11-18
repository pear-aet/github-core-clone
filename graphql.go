// GraphQL v4 API.
package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type gqlRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables"`
	OperationName string             `json:"operationName"`
}

func gqlErr(msg string) map[string]interface{} {
	return map[string]interface{}{"errors": []map[string]interface{}{{"message": msg}}}
}

func handleGraphQL(s *Store, w http.ResponseWriter, r *http.Request) {
	var body interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonWrite(w, 200, gqlErr("invalid JSON"))
		return
	}
	if arr, ok := body.([]interface{}); ok {
		var results []interface{}
		for _, item := range arr {
			results = append(results, execGQL(s, item))
		}
		jsonWrite(w, 200, results)
		return
	}
	jsonWrite(w, 200, execGQL(s, body))
}

func execGQL(s *Store, v interface{}) map[string]interface{} {
	m, ok := v.(map[string]interface{})
	if !ok {
		return gqlErr("invalid request")
	}
	query, _ := m["query"].(string)
	vars, _ := m["variables"].(map[string]interface{})
	return runGQL(s, query, vars)
}

func runGQL(s *Store, query string, vars map[string]interface{}) map[string]interface{} {
	q := query
	// unknown field check first (before any other handling)
	if unknown := findUnknownField(q); unknown != "" {
		return map[string]interface{}{"data": nil, "errors": []map[string]interface{}{{"message": "Cannot query field \"" + unknown + "\""}}}
	}
	// introspection __type (may have multiple aliased expressions in one document)
	if strings.Contains(q, "__type") {
		return gqlTypesResult(q)
	}
	// mutations first (they contain "repositoryId" which would match "repository")
	if strings.Contains(q, "createIssue") {
		return gqlCreateIssue(s, q, vars)
	}
	if strings.Contains(q, "closeIssue") {
		return gqlCloseIssue(s, q, vars)
	}
	if strings.Contains(q, "createPullRequest") {
		return gqlCreatePR(s, q, vars)
	}
	if strings.Contains(q, "mergePullRequest") {
		return gqlMergePR(s, q, vars)
	}
	if strings.Contains(q, "addComment") {
		return gqlAddComment(s, q, vars)
	}
	// repository query before viewer (repository contains viewerPermission)
	if strings.Contains(q, "repository") {
		owner := extractGQLArg(q, "owner")
		name := extractGQLArg(q, "name")
		if owner == "" {
			if v, ok := vars["owner"].(string); ok {
				owner = v
			}
		}
		if name == "" {
			if v, ok := vars["name"].(string); ok {
				name = v
			}
		}
		repo := s.GetRepo(owner, name)
		if repo == nil {
			return map[string]interface{}{"data": map[string]interface{}{"repository": nil}}
		}
		return map[string]interface{}{"data": map[string]interface{}{"repository": gqlRepo(s, repo, q, vars)}}
	}
	// node query
	if strings.Contains(q, "node") {
		id := extractGQLArg(q, "id")
		if id == "" {
			if v, ok := vars["id"].(string); ok {
				id = v
			}
		}
		return gqlNode(s, id, q)
	}
	// viewer
	if strings.Contains(q, "viewer") {
		return map[string]interface{}{"data": map[string]interface{}{"viewer": map[string]interface{}{"login": "adaiversen", "id": "U_1"}}}
	}
	if strings.Contains(q, "search") {
		return gqlSearch(s, q, vars)
	}
	return map[string]interface{}{"data": map[string]interface{}{}}
}

func extractGQLArg(q, name string) string {
	idx := strings.Index(q, name+":")
	if idx < 0 {
		return ""
	}
	rest := q[idx+len(name)+1:]
	rest = strings.TrimSpace(rest)
	if strings.HasPrefix(rest, "\"") {
		end := strings.Index(rest[1:], "\"")
		if end >= 0 {
			return rest[1 : 1+end]
		}
	}
	return ""
}

func findUnknownField(q string) string {
	known := []string{"viewer", "repository", "node", "search", "createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment", "__type", "id", "number", "title", "body", "state", "login", "name", "owner", "issues", "pullRequests", "pullRequest", "issue", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "databaseId", "nameWithOwner", "headRefName", "baseRefName", "mergeable", "merged", "files", "edges", "nodes", "pageInfo", "endCursor", "hasNextPage", "totalCount", "orderBy", "first", "last", "after", "before", "states", "field", "direction", "createdAt", "updatedAt", "author", "comments", "labels", "url", "resourcePath", "isPrivate", "description", "created", "mergedAt", "mergeCommit", "oid", "message", "tree", "commit", "ref", "target", "history", "query", "mutation", "String", "Int", "ID", "Boolean", "includeDeprecated", "enumValues", "input", "subjectId", "repositoryId", "issueId", "pullRequestId", "headRefName", "baseRefName", "true", "false", "null", "on", "fragment", "fields", "path", "commentEdge"}
	// find field names in query (word followed by ( or { or : or space)
	words := splitWords(q)
	for _, w := range words {
		if w == "" {
			continue
		}
		// skip operation names and type names (start with uppercase)
		if w[0] >= 'A' && w[0] <= 'Z' {
			continue
		}
		knownFound := false
		for _, k := range known {
			if w == k {
				knownFound = true
				break
			}
		}
		if !knownFound && len(w) > 2 && w[0] >= 'a' && w[0] <= 'z' {
			// could be a field
			if strings.Contains(q, w) {
				return w
			}
		}
	}
	return ""
}

func splitWords(q string) []string {
	var out []string
	var cur strings.Builder
	for _, c := range q {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			cur.WriteRune(c)
		} else {
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func gqlTypesResult(q string) map[string]interface{} {
	// Find all "<Alias>: __type(name: \"<Type>\")" occurrences.
	data := map[string]interface{}{}
	rest := q
	for {
		idx := strings.Index(rest, "__type")
		if idx < 0 {
			break
		}
		// alias is the word before ':' preceding __type
		before := rest[:idx]
		alias := "__type"
		if colon := strings.LastIndex(before, ":"); colon >= 0 {
			word := strings.TrimSpace(before[:colon])
			if sp := strings.LastIndexAny(word, " \n\t{"); sp >= 0 {
				word = word[sp+1:]
			}
			if word != "" {
				alias = word
			}
		}
		after := rest[idx:]
		name := extractGQLArg(after, "name")
		data[alias] = gqlType(name)
		// advance past this __type(...) block by brace depth
		depth := 0
		adv := len(after)
		for i := 0; i < len(after); i++ {
			if after[i] == '{' {
				depth++
			} else if after[i] == '}' {
				depth--
				if depth == 0 {
					adv = i + 1
					break
				}
			}
		}
		rest = after[adv:]
	}
	if len(data) == 0 {
		return map[string]interface{}{"data": map[string]interface{}{"__type": nil}}
	}
	return map[string]interface{}{"data": data}
}

func gqlType(name string) map[string]interface{} {
	fields := map[string][]string{
		"Issue":       {"id", "number", "title", "state", "body"},
		"PullRequest": {"id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"},
		"Repository":  {"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"},
	}
	if name == "SearchType" {
		return map[string]interface{}{"name": "SearchType", "enumValues": []map[string]interface{}{{"name": "ISSUE"}, {"name": "REPOSITORY"}, {"name": "USER"}}}
	}
	fl, ok := fields[name]
	if !ok {
		return nil
	}
	var fieldList []interface{}
	for _, f := range fl {
		fieldList = append(fieldList, map[string]interface{}{"name": f})
	}
	return map[string]interface{}{"name": name, "fields": fieldList}
}

func gqlTypeResult(name string) map[string]interface{} {
	return map[string]interface{}{"data": map[string]interface{}{"__type": gqlType(name)}}
}

func gqlRepo(s *Store, repo *Repo, q string, vars map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{
		"id": "R_" + itoa(repo.ID), "databaseId": repo.ID,
		"name": repo.Name, "nameWithOwner": repo.Owner + "/" + repo.Name,
		"owner": map[string]interface{}{"login": repo.Owner},
		"defaultBranchRef": map[string]interface{}{"name": repo.DefaultBranch},
		"viewerPermission": "ADMIN", "hasIssuesEnabled": true,
	}
	if strings.Contains(q, "issue(") {
		numStr := extractGQLArg(q, "number")
		n, _ := strconv.Atoi(numStr)
		if n == 0 {
			if v, ok := vars["number"].(float64); ok {
				n = int(v)
			}
		}
		if iss, ok := repo.Issues[n]; ok {
			out["issue"] = gqlIssue(iss)
		} else {
			out["issue"] = nil
		}
	}
	if strings.Contains(q, "issues") {
		out["issues"] = gqlIssueConn(repo, q, vars)
	}
	if strings.Contains(q, "pullRequest(") {
		numStr := extractGQLArg(q, "number")
		n, _ := strconv.Atoi(numStr)
		if n == 0 {
			if v, ok := vars["number"].(float64); ok {
				n = int(v)
			}
		}
		if p, ok := repo.Pulls[n]; ok {
			out["pullRequest"] = gqlPullWithFiles(repo, p)
		} else {
			out["pullRequest"] = nil
		}
	}
	if strings.Contains(q, "pullRequests") {
		out["pullRequests"] = gqlPullConn(repo, q, vars)
	}
	return out
}

func gqlIssue(i *Issue) map[string]interface{} {
	state := strings.ToUpper(i.State)
	return map[string]interface{}{
		"id": "I_" + itoa(i.ID), "number": i.Number, "title": i.Title,
		"state": state, "body": i.Body,
	}
}

// gqlPullWithFiles returns the PR with its actual changed files.
func gqlPullWithFiles(repo *Repo, p *Pull) map[string]interface{} {
	out := gqlPull(p)
	var nodes []interface{}
	baseObj := repo.Objects[p.Base.Sha]
	headObj := repo.Objects[p.Head.Sha]
	if baseObj != nil && headObj != nil && baseObj.Type == Commit && headObj.Type == Commit {
		baseTree := parseCommit(baseObj.Data).Tree
		headTree := parseCommit(headObj.Data).Tree
		for _, f := range diffTrees(repo, baseTree, headTree) {
			nodes = append(nodes, map[string]interface{}{"path": f["filename"]})
		}
	}
	if nodes == nil {
		nodes = []interface{}{}
	}
	out["files"] = map[string]interface{}{"nodes": nodes, "totalCount": len(nodes)}
	return out
}

func gqlPull(p *Pull) map[string]interface{} {
	state := strings.ToUpper(p.State)
	if p.Merged {
		state = "MERGED"
	}
	return map[string]interface{}{
		"id": "PR_" + itoa(p.ID), "number": p.Number,
		"headRefName": p.Head.Ref, "baseRefName": p.Base.Ref,
		"mergeable": "MERGEABLE", "state": state, "merged": p.Merged,
		"files": map[string]interface{}{"totalCount": 0},
	}
}

func gqlIssueConn(repo *Repo, q string, vars map[string]interface{}) map[string]interface{} {
	stateFilter := ""
	if strings.Contains(q, "states:") {
		if strings.Contains(q, "OPEN") {
			stateFilter = "open"
		} else if strings.Contains(q, "CLOSED") {
			stateFilter = "closed"
		}
	}
	desc := strings.Contains(q, "DESC")
	var nums []int
	for n, iss := range repo.Issues {
		if stateFilter != "" && iss.State != stateFilter {
			continue
		}
		nums = append(nums, n)
	}
	sort.Ints(nums)
	if desc {
		for i, j := 0, len(nums)-1; i < j; i, j = i+1, j-1 {
			nums[i], nums[j] = nums[j], nums[i]
		}
	}
	// pagination: first + after (cursor is the issue number as a string)
	first := -1
	if v, ok := vars["first"].(float64); ok {
		first = int(v)
	} else if numStr := extractGQLArg(q, "first"); numStr != "" {
		if n, err := strconv.Atoi(numStr); err == nil {
			first = n
		}
	}
	after := ""
	if v, ok := vars["after"].(string); ok {
		after = v
	} else if s := extractGQLArg(q, "after"); s != "" {
		after = s
	}
	afterNum := 0
	if after != "" {
		if n, err := strconv.Atoi(after); err == nil {
			afterNum = n
		} else if strings.HasPrefix(after, "cursor:") {
			if n, err := strconv.Atoi(after[len("cursor:"):]); err == nil {
				afterNum = n
			}
		}
	}
	// filter to nodes after the cursor (in the current sort order)
	var filtered []int
	for _, n := range nums {
		if desc {
			if afterNum != 0 && n >= afterNum {
				continue
			}
		} else {
			if afterNum != 0 && n <= afterNum {
				continue
			}
		}
		filtered = append(filtered, n)
	}
	hasNext := false
	endCursor := interface{}(nil)
	page := filtered
	if first >= 0 && len(filtered) > first {
		page = filtered[:first]
		hasNext = true
	}
	if len(page) > 0 {
		endCursor = strconv.Itoa(page[len(page)-1])
	}
	var nodes []interface{}
	for _, n := range page {
		nodes = append(nodes, gqlIssue(repo.Issues[n]))
	}
	if nodes == nil {
		nodes = []interface{}{}
	}
	return map[string]interface{}{"nodes": nodes, "totalCount": len(nums), "pageInfo": map[string]interface{}{"hasNextPage": hasNext, "endCursor": endCursor}}
}

func gqlPullConn(repo *Repo, q string, vars map[string]interface{}) map[string]interface{} {
	var nums []int
	for n := range repo.Pulls {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	var nodes []interface{}
	for _, n := range nums {
		nodes = append(nodes, gqlPull(repo.Pulls[n]))
	}
	return map[string]interface{}{"nodes": nodes, "totalCount": len(nodes), "pageInfo": map[string]interface{}{"hasNextPage": false, "endCursor": nil}}
}

func gqlNode(s *Store, id string, q string) map[string]interface{} {
	if strings.HasPrefix(id, "R_") {
		n, _ := strconv.Atoi(id[2:])
		for _, repo := range s.Repos {
			if repo.ID == n {
				return map[string]interface{}{"data": map[string]interface{}{"node": gqlRepo(s, repo, q, nil)}}
			}
		}
	}
	if strings.HasPrefix(id, "I_") {
		n, _ := strconv.Atoi(id[2:])
		num := n - 1000
		for _, repo := range s.Repos {
			if iss, ok := repo.Issues[num]; ok {
				return map[string]interface{}{"data": map[string]interface{}{"node": gqlIssue(iss)}}
			}
		}
	}
	if strings.HasPrefix(id, "PR_") {
		n, _ := strconv.Atoi(id[3:])
		num := n - 3000
		for _, repo := range s.Repos {
			if p, ok := repo.Pulls[num]; ok {
				return map[string]interface{}{"data": map[string]interface{}{"node": gqlPull(p)}}
			}
		}
	}
	return map[string]interface{}{"data": map[string]interface{}{"node": nil}}
}

// gqlArg reads a string arg from variables (input object) first, then inline query args.
func gqlArg(q string, vars map[string]interface{}, name string) string {
	if input, ok := vars["input"].(map[string]interface{}); ok {
		if v, ok := input[name].(string); ok {
			return v
		}
	}
	if v, ok := vars[name].(string); ok {
		return v
	}
	return extractGQLArg(q, name)
}

func gqlCreateIssue(s *Store, q string, vars map[string]interface{}) map[string]interface{} {
	repoID := gqlArg(q, vars, "repositoryId")
	title := gqlArg(q, vars, "title")
	body := gqlArg(q, vars, "body")
	var repo *Repo
	for _, r := range s.Repos {
		if "R_"+itoa(r.ID) == repoID {
			repo = r
			break
		}
	}
	if repo == nil {
		return gqlErr("repository not found")
	}
	repo.Counter++
	n := repo.Counter
	iss := &Issue{ID: 1000 + n, Number: n, Title: title, Body: body, State: "open", CreatedAt: FixedTS, UpdatedAt: FixedTS}
	iss.User.Login = "adaiversen"
	repo.Issues[n] = iss
	return map[string]interface{}{"data": map[string]interface{}{"createIssue": map[string]interface{}{"issue": gqlIssue(iss)}}}
}

func gqlCloseIssue(s *Store, q string, vars map[string]interface{}) map[string]interface{} {
	issueID := gqlArg(q, vars, "issueId")
	for _, repo := range s.Repos {
		for _, iss := range repo.Issues {
			if "I_"+itoa(iss.ID) == issueID {
				iss.State = "closed"
				return map[string]interface{}{"data": map[string]interface{}{"closeIssue": map[string]interface{}{"issue": gqlIssue(iss)}}}
			}
		}
	}
	return gqlErr("issue not found")
}

func gqlCreatePR(s *Store, q string, vars map[string]interface{}) map[string]interface{} {
	repoID := gqlArg(q, vars, "repositoryId")
	head := gqlArg(q, vars, "headRefName")
	base := gqlArg(q, vars, "baseRefName")
	title := gqlArg(q, vars, "title")
	var repo *Repo
	for _, r := range s.Repos {
		if "R_"+itoa(r.ID) == repoID {
			repo = r
			break
		}
	}
	if repo == nil {
		return gqlErr("repository not found")
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
	return map[string]interface{}{"data": map[string]interface{}{"createPullRequest": map[string]interface{}{"pullRequest": gqlPull(p)}}}
}

func gqlMergePR(s *Store, q string, vars map[string]interface{}) map[string]interface{} {
	prID := gqlArg(q, vars, "pullRequestId")
	for _, repo := range s.Repos {
		for _, p := range repo.Pulls {
			if "PR_"+itoa(p.ID) == prID {
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
				return map[string]interface{}{"data": map[string]interface{}{"mergePullRequest": map[string]interface{}{"pullRequest": gqlPull(p)}}}
			}
		}
	}
	return gqlErr("pull request not found")
}

func gqlAddComment(s *Store, q string, vars map[string]interface{}) map[string]interface{} {
	subjectID := gqlArg(q, vars, "subjectId")
	body := gqlArg(q, vars, "body")
	for _, repo := range s.Repos {
		if strings.HasPrefix(subjectID, "I_") {
			n, _ := strconv.Atoi(subjectID[2:])
			num := n - 1000
			if iss, ok := repo.Issues[num]; ok {
				c := &Comment{ID: 2000 + num*100 + len(repo.Comments[num]), Body: body, CreatedAt: FixedTS, UpdatedAt: FixedTS}
				c.User.Login = "adaiversen"
				repo.Comments[num] = append(repo.Comments[num], c)
				_ = iss
				return map[string]interface{}{"data": map[string]interface{}{"addComment": map[string]interface{}{"commentEdge": map[string]interface{}{"node": map[string]interface{}{"id": "C_" + itoa(c.ID), "body": body}}}}}
			}
		}
	}
	return gqlErr("subject not found")
}

func gqlSearch(s *Store, q string, vars map[string]interface{}) map[string]interface{} {
	var nodes []interface{}
	for _, repo := range s.Repos {
		for _, iss := range repo.Issues {
			nodes = append(nodes, map[string]interface{}{"__typename": "Issue", "id": "I_" + itoa(iss.ID), "number": iss.Number, "title": iss.Title})
		}
	}
	return map[string]interface{}{"data": map[string]interface{}{"search": map[string]interface{}{"nodes": nodes, "issueCount": len(nodes)}}}
}
