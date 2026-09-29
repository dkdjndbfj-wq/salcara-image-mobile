// Command salcara-hub relays messages between the Salcara phone app and the
// desktop bridge, authenticating both with a sub2api relay API key.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"salcara/hub/internal/hub"
)

func env(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func envBool(name string) bool {
	v, _ := strconv.ParseBool(env(name, "false"))
	return v
}

func envDuration(name string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(env(name, "")); err == nil {
		return d
	}
	return def
}

func main() {
	addr := flag.String("addr", env("SALCARA_HUB_ADDR", "127.0.0.1:8787"), "listen address (env SALCARA_HUB_ADDR)")
	sub2api := flag.String("sub2api", env("SUB2API_URL", "http://127.0.0.1:8080"), "sub2api base URL (env SUB2API_URL)")
	dataDir := flag.String("data", env("SALCARA_HUB_DATA", "./data"), "data directory for devices.json; empty disables persistence (env SALCARA_HUB_DATA)")
	prefix := flag.String("prefix", env("SALCARA_HUB_PREFIX", "/salcara-hub"), "public path prefix (env SALCARA_HUB_PREFIX)")
	trustProxy := flag.Bool("trust-proxy", envBool("TRUST_PROXY"), "use X-Forwarded-For as client IP (env TRUST_PROXY)")
	downloads := flag.String("downloads", env("SALCARA_HUB_DOWNLOADS", ""), "folder served at /download/<file> (env SALCARA_HUB_DOWNLOADS; default <data>/downloads)")
	publicURL := flag.String("public-url", env("SALCARA_HUB_PUBLIC_URL", ""), "public hub URL for install scripts, e.g. https://relay.example.com/salcara-hub (env SALCARA_HUB_PUBLIC_URL; default: from the request)")
	cmdTimeout := flag.Duration("command-timeout", envDuration("SALCARA_HUB_COMMAND_TIMEOUT", 45*time.Second), "how long /app/commands waits for the bridge (env SALCARA_HUB_COMMAND_TIMEOUT)")
	logFormat := flag.String("log-format", env("SALCARA_HUB_LOG_FORMAT", "json"), "json or text (env SALCARA_HUB_LOG_FORMAT)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("salcara-hub", hub.Version)
		return
	}

	var handler slog.Handler = slog.NewJSONHandler(os.Stderr, nil)
	if *logFormat == "text" {
		handler = slog.NewTextHandler(os.Stderr, nil)
	}
	logger := slog.New(handler)
	slog.SetDefault(logger)

	if *downloads == "" && *dataDir != "" {
		*downloads = filepath.Join(*dataDir, "downloads")
	}
	if *publicURL != "" {
		if u, err := url.Parse(*publicURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			logger.Error("SALCARA_HUB_PUBLIC_URL must be an http(s) URL", "value", *publicURL)
			os.Exit(2)
		}
	}

	if *sub2api == "" {
		logger.Error("SUB2API_URL is required")
		os.Exit(2)
	}

	h, err := hub.New(hub.Config{
		Sub2APIURL:     *sub2api,
		DataDir:        *dataDir,
		Prefix:         *prefix,
		TrustProxy:     *trustProxy,
		DownloadsDir:   *downloads,
		PublicURL:      *publicURL,
		CommandTimeout: *cmdTimeout,
		HTTPClient:     &http.Client{Transport: &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second}},
		Logger:         logger,
	})
	if err != nil {
		logger.Error("init failed", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
		// No ReadTimeout/WriteTimeout: SSE streams are long-lived. Request bodies
		// get a per-request read deadline and each SSE write its own deadline.
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() {
		logger.Info("salcara-hub listening", "addr", *addr, "sub2api", *sub2api, "prefix", *prefix, "downloads", *downloads, "version", hub.Version)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "err", err)
			h.Close()
			os.Exit(1)
		}
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	h.Close() // ends SSE streams and pending commands, flushes devices.json
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		logger.Warn("shutdown", "err", err)
	}
	logger.Info("bye")
}
