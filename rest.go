// REST v3 API.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

var fixedUser = map[string]interface{}{"login": "adaiversen", "id": 1, "type": "User"}

func jsonWrite(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-GitHub-Request-Id", "req-"+fmt.Sprint(code)+"-"+FixedTS)
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	jsonWrite(w, code, map[string]string{"message": msg})
}

func ownerOf(r *http.Request) string {
	if strings.Contains(r.Header.Get("Authorization"), "Bearer ") {
		return "adaiversen"
	}
	return "adaiversen"
}

func repoJSON(r *Repo) map[string]interface{} {
	return map[string]interface{}{
		"id": r.ID, "node_id": "R_" + itoa(r.ID),
		"name": r.Name, "full_name": r.Owner + "/" + r.Name,
		"owner": fixedUser, "private": r.Private,
		"description": r.Description,
		"default_branch": r.DefaultBranch,
		"created_at": r.CreatedAt, "updated_at": FixedTS,
		"html_url": "https://github.com/" + r.Owner + "/" + r.Name,
		"clone_url": "https://github.com/" + r.Owner + "/" + r.Name + ".git",
		"has_issues": true, "has_projects": true, "has_wiki": true,
		"license": map[string]string{"key": "mit", "name": "MIT License", "spdx_id": "MIT"},
	}
}

func issueJSON(r *Repo, i *Issue) map[string]interface{} {
	var labels []interface{}
	for _, name := range i.Labels {
		color := "000000"
		if l, ok := r.Labels[name]; ok {
			color = l.Color
		}
		labels = append(labels, map[string]interface{}{"name": name, "color": color})
	}
	if labels == nil {
		labels = []interface{}{}
	}
	return map[string]interface{}{
		"id": i.ID, "node_id": "I_" + itoa(i.ID), "number": i.Number,
		"title": i.Title, "body": i.Body, "state": i.State,
		"labels": labels, "user": i.User,
		"created_at": i.CreatedAt, "updated_at": i.UpdatedAt,
	}
}

func pullJSON(p *Pull) map[string]interface{} {
	return map[string]interface{}{
		"id": p.ID, "node_id": "PR_" + itoa(p.ID), "number": p.Number,
		"title": p.Title, "body": p.Body, "state": p.State, "merged": p.Merged,
		"merged_at": p.MergedAt, "merge_commit_sha": p.MergeCommitSha,
		"head": p.Head, "base": p.Base, "user": p.User,
		"created_at": p.CreatedAt, "updated_at": p.UpdatedAt,
		"mergeable": true, "mergeable_state": "clean",
	}
}

func routeREST(s *Store, w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	if !strings.HasPrefix(path, "/api/v3/") {
		return false
	}
	rest := path[len("/api/v3/"):]
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	owner := ownerOf(r)
	// GET /api/v3/ (root)
	if r.Method == "GET" && (rest == "" || rest == "/") {
		w.Header().Set("X-OAuth-Scopes", "repo")
		jsonWrite(w, 200, map[string]interface{}{"message": "forge", "version": "1.0.0"})
		return true
	}
	// GET /api/v3/meta
	if r.Method == "GET" && len(parts) == 1 && parts[0] == "meta" {
		jsonWrite(w, 200, map[string]interface{}{"installed_version": "1.0.0"})
		return true
	}
	// POST /user/repos
	if r.Method == "POST" && len(parts) == 2 && parts[0] == "user" && parts[1] == "repos" {
		var body struct {
			Name string `json:"name"`
			Private bool `json:"private"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonErr(w, 400, "Invalid JSON")
			return true
		}
		if body.Name == "" {
			jsonErr(w, 422, "name is required")
			return true
		}
		if s.GetRepo(owner, body.Name) != nil {
			jsonErr(w, 422, "Repository already exists")
			return true
		}
		repo := s.CreateRepo(owner, body.Name, body.Private, body.Description)
		jsonWrite(w, 201, repoJSON(repo))
		return true
	}
	// GET /user/repos
	if r.Method == "GET" && len(parts) == 2 && parts[0] == "user" && parts[1] == "repos" {
		perPage := 30
		if v := r.URL.Query().Get("per_page"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				perPage = n
			}
		}
		page := 1
		if v := r.URL.Query().Get("page"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				page = n
			}
		}
		var all []interface{}
		for _, repo := range s.Repos {
			if repo.Owner == owner {
				all = append(all, repoJSON(repo))
			}
		}
		sort.Slice(all, func(i, j int) bool {
			return all[i].(map[string]interface{})["name"].(string) < all[j].(map[string]interface{})["name"].(string)
		})
		total := len(all)
		start := (page - 1) * perPage
		if start > total {
			start = total
		}
		end := start + perPage
		if end > total {
			end = total
		}
		list := all[start:end]
		if list == nil {
			list = []interface{}{}
		}
		// Link header for pagination (absolute URL)
		if end < total {
			nextURL := *r.URL
			q := nextURL.Query()
			q.Set("page", strconv.Itoa(page+1))
			q.Set("per_page", strconv.Itoa(perPage))
			nextURL.RawQuery = q.Encode()
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			absURL := fmt.Sprintf("%s://%s%s", scheme, r.Host, nextURL.String())
			w.Header().Set("Link", fmt.Sprintf("<%s>; rel=\"next\"", absURL))
		}
		jsonWrite(w, 200, list)
		return true
	}
	// GET /user
	if r.Method == "GET" && len(parts) == 1 && parts[0] == "user" {
		jsonWrite(w, 200, fixedUser)
		return true
	}
	if len(parts) >= 2 && parts[0] == "repos" {
		repo := s.GetRepo(parts[0+1-1], parts[1])
		_ = repo
		repo = s.GetRepo(parts[1-1], parts[1])
		// parts[0]=="repos", parts[1]=owner, parts[2]=repo
		if len(parts) < 3 {
			jsonErr(w, 404, "Not Found")
			return true
		}
		repo = s.GetRepo(parts[1], parts[2])
		rest := parts[3:]
		return routeRepo(s, repo, parts[1], parts[2], rest, w, r)
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func routeRepo(s *Store, repo *Repo, owner, name string, rest []string, w http.ResponseWriter, r *http.Request) bool {
	if repo == nil {
		jsonErr(w, 404, "Not Found")
		return true
	}
	if repo.Private && !checkAuth(r) {
		jsonErr(w, 401, "Requires authentication")
		return true
	}
	if len(rest) == 0 {
		if r.Method == "GET" {
			jsonWrite(w, 200, repoJSON(repo))
		} else if r.Method == "PATCH" {
			var body struct {
				Description *string `json:"description"`
				DefaultBranch *string `json:"default_branch"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.Description != nil {
				repo.Description = *body.Description
			}
			if body.DefaultBranch != nil {
				repo.DefaultBranch = *body.DefaultBranch
			}
			jsonWrite(w, 200, repoJSON(repo))
		} else if r.Method == "DELETE" {
			delete(s.Repos, s.key(owner, name))
			w.WriteHeader(204)
		} else {
			jsonErr(w, 405, "Method Not Allowed")
		}
		return true
	}
	switch rest[0] {
	case "git":
		return routeGit(s, repo, owner, name, rest[1:], w, r)
	case "issues":
		return routeIssues(repo, rest[1:], w, r)
	case "pulls":
		return routePulls(s, repo, owner, name, rest[1:], w, r)
	case "contents":
		return routeContents(repo, rest[1:], w, r)
	case "labels":
		return routeLabels(repo, rest[1:], w, r)
	case "branches":
		if r.Method == "GET" {
			var list []interface{}
			for ref, oid := range repo.Refs {
				if strings.HasPrefix(ref, "refs/heads/") {
					list = append(list, map[string]interface{}{
						"name": strings.TrimPrefix(ref, "refs/heads/"),
						"commit": map[string]string{"sha": oid},
					})
				}
			}
			jsonWrite(w, 200, list)
		}
		return true
	case "commits":
		return routeCommits(repo, rest[1:], w, r)
	case "tags":
		if r.Method == "GET" {
			var list []interface{}
			for ref, oid := range repo.Refs {
				if strings.HasPrefix(ref, "refs/tags/") {
					list = append(list, map[string]interface{}{"name": strings.TrimPrefix(ref, "refs/tags/"), "commit": map[string]string{"sha": oid}})
				}
			}
			jsonWrite(w, 200, list)
		}
		return true
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func routeGit(s *Store, repo *Repo, owner, name string, rest []string, w http.ResponseWriter, r *http.Request) bool {
	if len(rest) == 0 {
		jsonErr(w, 404, "Not Found")
		return true
	}
	switch rest[0] {
	case "refs":
		if r.Method == "GET" {
			if len(rest) == 1 {
				var list []interface{}
				for ref, oid := range repo.Refs {
					list = append(list, map[string]interface{}{"ref": ref, "object": map[string]string{"sha": oid, "type": "commit"}})
				}
				jsonWrite(w, 200, list)
				return true
			}
			ref := "refs/" + strings.Join(rest[1:], "/")
			oid, ok := repo.Refs[ref]
			if !ok {
				jsonErr(w, 404, "Not Found")
				return true
			}
			jsonWrite(w, 200, map[string]interface{}{"ref": ref, "object": map[string]string{"sha": oid, "type": "commit"}})
			return true
		}
		if r.Method == "POST" {
			var body struct {
				Ref string `json:"ref"`
				Sha string `json:"sha"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			repo.Refs[body.Ref] = body.Sha
			jsonWrite(w, 201, map[string]interface{}{"ref": body.Ref, "object": map[string]string{"sha": body.Sha, "type": "commit"}})
			return true
		}
		if r.Method == "PATCH" && len(rest) >= 2 {
			ref := "refs/" + strings.Join(rest[1:], "/")
			var body struct {
				Sha string `json:"sha"`
				Force bool `json:"force"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			repo.Refs[ref] = body.Sha
			jsonWrite(w, 200, map[string]interface{}{"ref": ref, "object": map[string]string{"sha": body.Sha, "type": "commit"}})
			return true
		}
		if r.Method == "DELETE" && len(rest) >= 2 {
			ref := "refs/" + strings.Join(rest[1:], "/")
			delete(repo.Refs, ref)
			w.WriteHeader(204)
			return true
		}
	case "commits":
		if r.Method == "GET" && len(rest) == 2 {
			oid := rest[1]
			obj := repo.Objects[oid]
			if obj == nil || obj.Type != Commit {
				jsonErr(w, 404, "Not Found")
				return true
			}
			c := parseCommit(obj.Data)
			jsonWrite(w, 200, map[string]interface{}{
				"sha": oid, "message": c.Message, "tree": map[string]string{"sha": c.Tree},
				"author": map[string]string{"name": "Forge Bot", "date": FixedTS},
				"committer": map[string]string{"name": "Forge Bot", "date": FixedTS},
			})
			return true
		}
		if r.Method == "POST" {
			var body struct {
				Message string `json:"message"`
				Tree string `json:"tree"`
				Parents []string `json:"parents"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			author := gitUser + " " + gitTime()
			data := buildCommit(body.Tree, body.Parents, author, author, body.Message)
			oid := storeObject(repo, Commit, data)
			jsonWrite(w, 201, map[string]interface{}{"sha": oid, "message": body.Message, "tree": map[string]string{"sha": body.Tree}})
			return true
		}
	case "trees":
		if r.Method == "GET" && len(rest) == 2 {
			oid := rest[1]
			obj := repo.Objects[oid]
			if obj == nil || obj.Type != Tree {
				jsonErr(w, 404, "Not Found")
				return true
			}
			entries := parseTree(obj.Data)
			var tree []interface{}
			for _, e := range entries {
				tree = append(tree, map[string]interface{}{"path": e.Name, "mode": e.Mode, "type": "blob", "sha": e.OID})
			}
			jsonWrite(w, 200, map[string]interface{}{"sha": oid, "tree": tree})
			return true
		}
		if r.Method == "POST" {
			var body struct {
				Tree []struct {
					Path string `json:"path"`
					Mode string `json:"mode"`
					Type string `json:"type"`
					Sha string `json:"sha"`
				} `json:"tree"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			var entries []TreeEntry
			for _, t := range body.Tree {
				entries = append(entries, TreeEntry{Mode: t.Mode, Name: t.Path, OID: t.Sha})
			}
			oid := storeObject(repo, Tree, buildTree(entries))
			jsonWrite(w, 201, map[string]interface{}{"sha": oid, "tree": body.Tree})
			return true
		}
	case "blobs":
		if r.Method == "GET" && len(rest) == 2 {
			oid := rest[1]
			obj := repo.Objects[oid]
			if obj == nil || obj.Type != Blob {
				jsonErr(w, 404, "Not Found")
				return true
			}
			jsonWrite(w, 200, map[string]interface{}{"sha": oid, "content": base64.StdEncoding.EncodeToString(obj.Data), "encoding": "base64", "size": len(obj.Data)})
			return true
		}
		if r.Method == "POST" {
			var body struct {
				Content string `json:"content"`
				Encoding string `json:"encoding"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			data := []byte(body.Content)
			if body.Encoding == "base64" {
				data, _ = base64.StdEncoding.DecodeString(body.Content)
			}
			oid := storeObject(repo, Blob, data)
			jsonWrite(w, 201, map[string]interface{}{"sha": oid, "size": len(data)})
			return true
		}
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func routeIssues(repo *Repo, rest []string, w http.ResponseWriter, r *http.Request) bool {
	if len(rest) == 0 {
		if r.Method == "GET" {
			state := r.URL.Query().Get("state")
			direction := r.URL.Query().Get("direction")
			var list []interface{}
			nums := sortedIssueNums(repo)
			if direction == "desc" {
				for i, j := 0, len(nums)-1; i < j; i, j = i+1, j-1 {
					nums[i], nums[j] = nums[j], nums[i]
				}
			}
			for _, n := range nums {
				iss := repo.Issues[n]
				if state != "" && state != "all" && iss.State != state {
					continue
				}
				list = append(list, issueJSON(repo, iss))
			}
			if list == nil {
				list = []interface{}{}
			}
			jsonWrite(w, 200, list)
			return true
		}
		if r.Method == "POST" {
			var body struct {
				Title string `json:"title"`
				Body string `json:"body"`
				Labels []string `json:"labels"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			for _, label := range body.Labels {
				if _, ok := repo.Labels[label]; !ok {
					jsonErr(w, 422, "Validation Failed: label does not exist")
					return true
				}
			}
			repo.Counter++
			n := repo.Counter
			iss := &Issue{ID: 1000 + n, Number: n, Title: body.Title, Body: body.Body, State: "open", Labels: body.Labels, CreatedAt: FixedTS, UpdatedAt: FixedTS}
			iss.User.Login = "adaiversen"
			repo.Issues[n] = iss
			jsonWrite(w, 201, issueJSON(repo, iss))
			return true
		}
	}
	if len(rest) == 1 {
		n, err := strconv.Atoi(rest[0])
		if err != nil {
			jsonErr(w, 404, "Not Found")
			return true
		}
		iss, ok := repo.Issues[n]
		if !ok {
			jsonErr(w, 404, "Not Found")
			return true
		}
		if r.Method == "GET" {
			jsonWrite(w, 200, issueJSON(repo, iss))
			return true
		}
		if r.Method == "PATCH" {
			var body struct {
				Title *string `json:"title"`
				Body *string `json:"body"`
				State *string `json:"state"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.Title != nil {
				iss.Title = *body.Title
			}
			if body.Body != nil {
				iss.Body = *body.Body
			}
			if body.State != nil {
				iss.State = *body.State
			}
			iss.UpdatedAt = FixedTS
			jsonWrite(w, 200, issueJSON(repo, iss))
			return true
		}
	}
	if len(rest) == 2 && rest[1] == "comments" {
		n, _ := strconv.Atoi(rest[0])
		if r.Method == "GET" {
			var list []interface{}
			for _, c := range repo.Comments[n] {
				list = append(list, map[string]interface{}{"id": c.ID, "body": c.Body, "user": c.User, "created_at": c.CreatedAt, "updated_at": c.UpdatedAt})
			}
			jsonWrite(w, 200, list)
			return true
		}
		if r.Method == "POST" {
			var body struct{ Body string `json:"body"` }
			json.NewDecoder(r.Body).Decode(&body)
			c := &Comment{ID: 2000 + n*100 + len(repo.Comments[n]), Body: body.Body, CreatedAt: FixedTS, UpdatedAt: FixedTS}
			c.User.Login = "adaiversen"
			repo.Comments[n] = append(repo.Comments[n], c)
			jsonWrite(w, 201, map[string]interface{}{"id": c.ID, "body": c.Body, "user": c.User, "created_at": c.CreatedAt, "updated_at": c.UpdatedAt})
			return true
		}
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func sortedIssueNums(repo *Repo) []int {
	var nums []int
	for n := range repo.Issues {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	return nums
}

func sortedPullNums(repo *Repo) []int {
	var nums []int
	for n := range repo.Pulls {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	return nums
}

func routePulls(s *Store, repo *Repo, owner, name string, rest []string, w http.ResponseWriter, r *http.Request) bool {
	if len(rest) == 0 {
		if r.Method == "GET" {
			state := r.URL.Query().Get("state")
			if state == "" {
				state = "open"
			}
			var list []interface{}
			for _, n := range sortedPullNums(repo) {
				p := repo.Pulls[n]
				if state != "all" && p.State != state {
					continue
				}
				list = append(list, pullJSON(p))
			}
			if list == nil {
				list = []interface{}{}
			}
			jsonWrite(w, 200, list)
			return true
		}
		if r.Method == "POST" {
			var body struct {
				Title string `json:"title"`
				Body string `json:"body"`
				Head string `json:"head"`
				Base string `json:"base"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			repo.Counter++
			n := repo.Counter
			p := &Pull{ID: 3000 + n, Number: n, Title: body.Title, Body: body.Body, State: "open", CreatedAt: FixedTS, UpdatedAt: FixedTS}
			p.User.Login = "adaiversen"
			p.Head.Ref = body.Head
			p.Head.Sha = repo.Refs["refs/heads/"+body.Head]
			p.Base.Ref = body.Base
			p.Base.Sha = repo.Refs["refs/heads/"+body.Base]
			repo.Pulls[n] = p
			jsonWrite(w, 201, pullJSON(p))
			return true
		}
	}
	if len(rest) >= 1 {
		n, err := strconv.Atoi(rest[0])
		if err != nil {
			jsonErr(w, 404, "Not Found")
			return true
		}
		p, ok := repo.Pulls[n]
		if !ok {
			jsonErr(w, 404, "Not Found")
			return true
		}
		if len(rest) == 1 {
			if r.Method == "GET" {
				jsonWrite(w, 200, pullJSON(p))
				return true
			}
			if r.Method == "PATCH" {
				var body struct {
					Title *string `json:"title"`
					Body *string `json:"body"`
					State *string `json:"state"`
				}
				json.NewDecoder(r.Body).Decode(&body)
				if body.Title != nil {
					p.Title = *body.Title
				}
				if body.Body != nil {
					p.Body = *body.Body
				}
				if body.State != nil {
					p.State = *body.State
				}
				p.UpdatedAt = FixedTS
				jsonWrite(w, 200, pullJSON(p))
				return true
			}
		}
		if len(rest) == 2 && rest[1] == "merge" && r.Method == "PUT" {
			headSha := p.Head.Sha
			baseSha := p.Base.Sha
			// conflict check: if the base branch moved since the PR was created,
			// and both the PR head and the new base tip changed the same file differently, it's a conflict
			currentBase := repo.Refs["refs/heads/"+p.Base.Ref]
			if currentBase != "" && currentBase != baseSha {
				baseObj := repo.Objects[baseSha]
				curObj := repo.Objects[currentBase]
				headObj := repo.Objects[headSha]
				if baseObj != nil && curObj != nil && headObj != nil && baseObj.Type == Commit && curObj.Type == Commit && headObj.Type == Commit {
					baseTree := parseCommit(baseObj.Data).Tree
					curTree := parseCommit(curObj.Data).Tree
					headTree := parseCommit(headObj.Data).Tree
					baseFiles := make(map[string]string)
					curFiles := make(map[string]string)
					headFiles := make(map[string]string)
					flattenTree(repo, baseTree, "", baseFiles)
					flattenTree(repo, curTree, "", curFiles)
					flattenTree(repo, headTree, "", headFiles)
					conflict := false
					for path, headOID := range headFiles {
						baseOID, inBase := baseFiles[path]
						curOID, inCur := curFiles[path]
						headChanged := !inBase || baseOID != headOID
						curChanged := (!inBase && inCur) || (inBase && inCur && baseOID != curOID) || (inBase && !inCur)
						if headChanged && curChanged && headOID != curOID {
							conflict = true
							break
						}
					}
					if conflict {
						jsonErr(w, 405, "Merge conflict")
						return true
					}
				}
			}
			headCommit := repo.Objects[headSha]
			baseCommit := repo.Objects[baseSha]
			var mergeTree string
			var parents []string
			if headCommit != nil && headCommit.Type == Commit {
				mergeTree = parseCommit(headCommit.Data).Tree
				// first parent is the current base tip (may have moved since PR creation)
				firstParent := baseSha
				if currentBase != "" && currentBase != baseSha {
					firstParent = currentBase
				}
				parents = []string{firstParent, headSha}
			}
			if baseCommit != nil && baseCommit.Type == Commit {
				_ = baseCommit
			}
			author := gitUser + " " + gitTime()
			mergeData := buildCommit(mergeTree, parents, author, author, "Merge pull request #"+itoa(n))
			mergeOID := storeObject(repo, Commit, mergeData)
			repo.Refs["refs/heads/"+p.Base.Ref] = mergeOID
			p.Merged = true
			p.State = "closed"
			now := FixedTS
			p.MergedAt = &now
			p.MergeCommitSha = &mergeOID
			jsonWrite(w, 200, map[string]interface{}{"merged": true, "sha": mergeOID, "message": "Pull Request successfully merged"})
			return true
		}
		if len(rest) == 2 && rest[1] == "files" && r.Method == "GET" {
			p := repo.Pulls[n]
			if p == nil {
				jsonErr(w, 404, "Not Found")
				return true
			}
			var files []map[string]interface{}
			baseObj := repo.Objects[p.Base.Sha]
			headObj := repo.Objects[p.Head.Sha]
			if baseObj != nil && headObj != nil && baseObj.Type == Commit && headObj.Type == Commit {
				baseTree := parseCommit(baseObj.Data).Tree
				headTree := parseCommit(headObj.Data).Tree
				files = diffTrees(repo, baseTree, headTree)
			}
			if files == nil {
				files = []map[string]interface{}{}
			}
			jsonWrite(w, 200, files)
			return true
		}
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func routeContents(repo *Repo, rest []string, w http.ResponseWriter, r *http.Request) bool {
	path := strings.Join(rest, "/")
	branch := r.URL.Query().Get("ref")
	if branch == "" {
		branch = repo.DefaultBranch
	}
	// For writes, the branch comes from the JSON body, not the query.
	if r.Method == "PUT" || r.Method == "POST" || r.Method == "DELETE" {
		var probe struct {
			Branch string `json:"branch"`
		}
		bodyBytes, _ := io.ReadAll(r.Body)
		json.Unmarshal(bodyBytes, &probe)
		if probe.Branch != "" {
			branch = probe.Branch
		}
		// restore the body for the handler below
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}
	headOID := repo.Refs["refs/heads/"+branch]
	var treeOID string
	var parents []string
	if headOID == "" {
		// Empty repo: start from an empty tree, no parents.
		treeOID = storeObject(repo, Tree, buildTree(nil))
		parents = []string{}
	} else {
		headObj := repo.Objects[headOID]
		if headObj == nil || headObj.Type != Commit {
			jsonErr(w, 404, "Not Found")
			return true
		}
		treeOID = parseCommit(headObj.Data).Tree
		parents = []string{headOID}
	}
	if r.Method == "GET" {
		if headOID == "" {
			jsonErr(w, 404, "Not Found")
			return true
		}
		entry, ok := findInTree(repo, treeOID, path)
		if !ok {
			jsonErr(w, 404, "Not Found")
			return true
		}
		obj := repo.Objects[entry.OID]
		if obj == nil {
			jsonErr(w, 404, "Not Found")
			return true
		}
		if obj.Type == Tree {
			var list []interface{}
			for _, e := range parseTree(obj.Data) {
				list = append(list, map[string]interface{}{"name": e.Name, "path": path + "/" + e.Name, "sha": e.OID, "type": "dir", "size": 0})
			}
			jsonWrite(w, 200, list)
			return true
		}
		jsonWrite(w, 200, map[string]interface{}{
			"name": entry.Name, "path": path, "sha": entry.OID, "type": "file",
			"content": base64.StdEncoding.EncodeToString(obj.Data), "encoding": "base64", "size": len(obj.Data),
		})
		return true
	}
	if r.Method == "PUT" || r.Method == "POST" {
		var body struct {
			Message string `json:"message"`
			Content string `json:"content"`
			Sha string `json:"sha"`
			Branch string `json:"branch"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		br := body.Branch
		if br == "" {
			br = branch
		}
		// stale sha check: if the file exists and the provided sha doesn't match, 409
		if body.Sha != "" && headOID != "" {
			if entry, ok := findInTree(repo, treeOID, path); ok {
				if entry.OID != body.Sha {
					jsonErr(w, 409, "sha does not match the current file")
					return true
				}
			}
		}
		data, _ := base64.StdEncoding.DecodeString(body.Content)
		blobOID := storeObject(repo, Blob, data)
		newTree := updateTree(repo, treeOID, path, blobOID)
		author := gitUser + " " + gitTime()
		commitData := buildCommit(newTree, parents, author, author, body.Message)
		commitOID := storeObject(repo, Commit, commitData)
		repo.Refs["refs/heads/"+br] = commitOID
		jsonWrite(w, 201, map[string]interface{}{
			"content": map[string]interface{}{"name": path, "path": path, "sha": blobOID, "type": "file", "encoding": "base64", "size": len(data)},
			"commit": map[string]interface{}{"sha": commitOID, "message": body.Message},
		})
		return true
	}
	if r.Method == "DELETE" {
		var body struct {
			Message string `json:"message"`
			Sha string `json:"sha"`
			Branch string `json:"branch"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		br := body.Branch
		if br == "" {
			br = branch
		}
		newTree := deleteFromTree(repo, treeOID, path)
		author := gitUser + " " + gitTime()
		commitData := buildCommit(newTree, parents, author, author, body.Message)
		commitOID := storeObject(repo, Commit, commitData)
		repo.Refs["refs/heads/"+br] = commitOID
		jsonWrite(w, 200, map[string]interface{}{"commit": map[string]interface{}{"sha": commitOID, "message": body.Message}})
		return true
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func findInTree(repo *Repo, treeOID, path string) (TreeEntry, bool) {
	parts := strings.Split(path, "/")
	cur := treeOID
	for i, part := range parts {
		obj := repo.Objects[cur]
		if obj == nil || obj.Type != Tree {
			return TreeEntry{}, false
		}
		found := false
		for _, e := range parseTree(obj.Data) {
			if e.Name == part {
				if i == len(parts)-1 {
					return e, true
				}
				cur = e.OID
				found = true
				break
			}
		}
		if !found {
			return TreeEntry{}, false
		}
	}
	return TreeEntry{}, false
}

func updateTree(repo *Repo, treeOID, path, blobOID string) string {
	parts := strings.Split(path, "/")
	return updateTreeRec(repo, treeOID, parts, blobOID)
}

func updateTreeRec(repo *Repo, treeOID string, parts []string, blobOID string) string {
	var entries []TreeEntry
	if obj := repo.Objects[treeOID]; obj != nil && obj.Type == Tree {
		entries = parseTree(obj.Data)
	}
	found := false
	for i, e := range entries {
		if e.Name == parts[0] {
			found = true
			if len(parts) == 1 {
				entries[i].OID = blobOID
				entries[i].Mode = "100644"
			} else {
				entries[i].OID = updateTreeRec(repo, e.OID, parts[1:], blobOID)
			}
			break
		}
	}
	if !found {
		if len(parts) == 1 {
			entries = append(entries, TreeEntry{Mode: "100644", Name: parts[0], OID: blobOID})
		} else {
			emptyTree := storeObject(repo, Tree, buildTree(nil))
			sub := updateTreeRec(repo, emptyTree, parts[1:], blobOID)
			entries = append(entries, TreeEntry{Mode: "40000", Name: parts[0], OID: sub})
		}
	}
	return storeObject(repo, Tree, buildTree(entries))
}

func deleteFromTree(repo *Repo, treeOID, path string) string {
	parts := strings.Split(path, "/")
	return deleteFromTreeRec(repo, treeOID, parts)
}

func deleteFromTreeRec(repo *Repo, treeOID string, parts []string) string {
	var entries []TreeEntry
	if obj := repo.Objects[treeOID]; obj != nil && obj.Type == Tree {
		entries = parseTree(obj.Data)
	}
	var out []TreeEntry
	for _, e := range entries {
		if e.Name == parts[0] {
			if len(parts) > 1 {
				e.OID = deleteFromTreeRec(repo, e.OID, parts[1:])
				out = append(out, e)
			}
			continue
		}
		out = append(out, e)
	}
	return storeObject(repo, Tree, buildTree(out))
}

func routeLabels(repo *Repo, rest []string, w http.ResponseWriter, r *http.Request) bool {
	if r.Method == "GET" {
		var list []interface{}
		for name, l := range repo.Labels {
			list = append(list, map[string]interface{}{"name": name, "color": l.Color})
		}
		jsonWrite(w, 200, list)
		return true
	}
	if r.Method == "POST" {
		var body struct {
			Name string `json:"name"`
			Color string `json:"color"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		repo.Labels[body.Name] = struct{ Name, Color string }{body.Name, body.Color}
		jsonWrite(w, 201, map[string]interface{}{"name": body.Name, "color": body.Color})
		return true
	}
	jsonErr(w, 404, "Not Found")
	return true
}

func routeCommits(repo *Repo, rest []string, w http.ResponseWriter, r *http.Request) bool {
	if r.Method == "GET" {
		sha := r.URL.Query().Get("sha")
		if sha == "" {
			sha = repo.Refs["refs/heads/"+repo.DefaultBranch]
		} else if oid, ok := repo.Refs["refs/heads/"+sha]; ok {
			// sha param may be a branch name
			sha = oid
		}
		var list []interface{}
		seen := make(map[string]bool)
		stack := []string{sha}
		for len(stack) > 0 {
			oid := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[oid] {
				continue
			}
			seen[oid] = true
			obj := repo.Objects[oid]
			if obj == nil || obj.Type != Commit {
				continue
			}
			c := parseCommit(obj.Data)
			list = append(list, map[string]interface{}{"sha": oid, "commit": map[string]interface{}{"message": c.Message, "author": map[string]interface{}{"name": "Forge Bot", "date": FixedTS}}})
			stack = append(stack, c.Parents...)
		}
		if list == nil {
			list = []interface{}{}
		}
		jsonWrite(w, 200, list)
		return true
	}
	jsonErr(w, 404, "Not Found")
	return true
}
