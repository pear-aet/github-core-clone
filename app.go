// HTTP server: routing for git smart HTTP, REST, GraphQL, MCP.
package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
)

func checkAuth(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	return strings.HasPrefix(auth, "Bearer ") || strings.HasPrefix(auth, "token ")
}

func writeBytes(w http.ResponseWriter, code int, ct string, b []byte) {
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(code)
	w.Write(b)
}

func handleHTTP(s *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// /healthz boot probe
		if r.Method == "GET" && path == "/healthz" {
			jsonWrite(w, 200, map[string]interface{}{"ok": true})
			return
		}
		// git smart HTTP: /{owner}/{repo}.git/...
		if strings.Contains(path, ".git/") {
			idx := strings.Index(path, ".git/")
			prefix := path[:idx]
			suffix := path[idx+5:]
			parts := strings.Split(strings.Trim(prefix, "/"), "/")
			if len(parts) != 2 {
				jsonErr(w, 404, "Not Found")
				return
			}
			owner, repoName := parts[0], parts[1]
			repo := s.GetRepo(owner, repoName)
			if repo == nil {
				// 404 for info/refs, but stay up
				if strings.HasPrefix(suffix, "info/refs") {
					w.Header().Set("Content-Type", "text/plain")
					w.WriteHeader(404)
					w.Write([]byte("404 Not Found"))
					return
				}
				jsonErr(w, 404, "Not Found")
				return
			}
			if strings.HasPrefix(suffix, "info/refs") {
				service := r.URL.Query().Get("service")
				proto := "v0"
				if strings.Contains(r.Header.Get("Git-Protocol"), "version=2") {
					proto = "v2"
				}
				if service == "git-upload-pack" {
					code, ct, body := handleInfoRefs(repo, "upload-pack", proto)
					writeBytes(w, code, ct, body)
					return
				}
				if service == "git-receive-pack" {
					code, ct, body := handleInfoRefs(repo, "receive-pack", proto)
					writeBytes(w, code, ct, body)
					return
				}
				jsonErr(w, 400, "service required")
				return
			}
			body, _ := io.ReadAll(r.Body)
			if suffix == "git-upload-pack" {
				proto := "v0"
				if strings.Contains(r.Header.Get("Git-Protocol"), "version=2") {
					proto = "v2"
				}
				code, out := handleUploadPack(repo, body, proto)
				writeBytes(w, code, "application/x-git-upload-pack-result", out)
				return
			}
			if suffix == "git-receive-pack" {
				code, out := handleReceivePack(repo, body)
				writeBytes(w, code, "application/x-git-receive-pack-result", out)
				return
			}
			jsonErr(w, 404, "Not Found")
			return
		}
		// GraphQL
		if path == "/api/graphql" {
			if r.Method != "POST" {
				jsonErr(w, 405, "Method Not Allowed")
				return
			}
			if !checkAuth(r) {
				w.WriteHeader(401)
				w.Write([]byte(`{"message":"Requires authentication"}`))
				return
			}
			handleGraphQL(s, w, r)
			return
		}
		// MCP
		if path == "/mcp" {
			if r.Method != "POST" {
				jsonErr(w, 405, "Method Not Allowed")
				return
			}
			if !checkAuth(r) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(401)
				w.Write([]byte(`{"message":"Requires authentication"}`))
				return
			}
			handleMCP(s, w, r)
			return
		}
		// REST
		if strings.HasPrefix(path, "/api/v3/") {
			routeREST(s, w, r)
			return
		}
		// /done is polled on the env, not served here.
		jsonErr(w, 404, "Not Found")
	}
}

func startServer(s *Store) (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	go http.Serve(ln, handleHTTP(s))
	return port, nil
}

func readBody(r *http.Request) []byte {
	b, _ := io.ReadAll(r.Body)
	return b
}

func envURL() string { return os.Getenv("MAKEFUN_ENV_URL") }

var _ = bytes.MinRead
