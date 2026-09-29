// Package relay talks to the sub2api relay itself (GET /v1/usage: balance/quota/usage for an API key).
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrInvalidKey means the relay rejected the key (401/403).
var ErrInvalidKey = errors.New("Key 无效：中转站拒绝了这个 API Key")

var httpClient = &http.Client{Timeout: 15 * time.Second}

// Usage calls GET {root}/v1/usage with key and returns the decoded JSON object (fields vary by key mode:
// balance / quota_limited / subscription — callers render defensively).
func Usage(ctx context.Context, root, key string) (map[string]any, error) {
	if root == "" || key == "" {
		return nil, errors.New("请先填写中转站地址和 API Key")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, root+"/v1/usage", nil)
	if err != nil {
		return nil, fmt.Errorf("中转站地址无效：%w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", "SalcaraBridge")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连不上中转站：%w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, ErrInvalidKey
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("中转站返回 %d", resp.StatusCode)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, errors.New("这个地址看起来不是 sub2api 中转站（/v1/usage 返回的不是 JSON）")
	}
	return m, nil
}
