//go:build !darwin

package main

// macStartup is macOS-only (the Windows / Linux builds are single files the user places themselves).
func macStartup(bool) bool { return false }
