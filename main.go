// Entry lifecycle: bind an ephemeral port, register it with the env, poll until done, exit 0.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func retryDelay(attempt int) time.Duration {
	d := 250 * time.Millisecond
	for i := 0; i < attempt && i < 8; i++ {
		d *= 2
	}
	if d > 2*time.Second {
		d = 2 * time.Second
	}
	return d
}

func register(envURL string, port int) {
	body, _ := json.Marshal(map[string]int{"port": port})
	for attempt := 0; ; attempt++ {
		req, _ := http.NewRequest("POST", envURL+"/register", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 || resp.StatusCode == 409 {
				return
			}
			if resp.StatusCode == 400 || resp.StatusCode == 405 {
				fmt.Fprintln(os.Stderr, "register answered HTTP", resp.StatusCode)
				os.Exit(1)
			}
		}
		time.Sleep(retryDelay(attempt))
	}
}

func waitForDone(envURL string) {
	for attempt := 0; ; attempt++ {
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(envURL + "/done")
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 {
				var m map[string]interface{}
				if json.Unmarshal(body, &m) == nil {
					if done, ok := m["done"].(bool); ok && done {
						return
					}
				}
			}
		}
		time.Sleep(retryDelay(attempt))
	}
}

func main() {
	envURL := strings.TrimRight(os.Getenv("MAKEFUN_ENV_URL"), "/")
	if envURL == "" {
		fmt.Fprintln(os.Stderr, "[entry] MAKEFUN_ENV_URL is not set: there is no env to register with")
		os.Exit(1)
	}
	store := NewStore()
	port, err := startServer(store)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[entry]", err)
		os.Exit(1)
	}
	fmt.Printf("[entry] listening on port %d\n", port)
	register(envURL, port)
	fmt.Println("[entry] registered; waiting for the env to say done")
	waitForDone(envURL)
	fmt.Println("[entry] done")
}
