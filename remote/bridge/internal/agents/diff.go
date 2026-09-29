package agents

import (
	"fmt"
	"strings"
)

// splitLines splits text into lines without their trailing newline ("" → no lines).
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

type diffOp struct {
	kind byte // ' ', '-', '+'
	text string
}

// lineDiff computes a line-level edit script (LCS). Large inputs fall back to "remove all, add all".
func lineDiff(a, b []string) []diffOp {
	// Trim common prefix/suffix first; edits are usually small.
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	var ops []diffOp
	for _, l := range a[:pre] {
		ops = append(ops, diffOp{' ', l})
	}
	ma, mb := a[pre:len(a)-suf], b[pre:len(b)-suf]
	n, m := len(ma), len(mb)
	if n*m > 4_000_000 {
		for _, l := range ma {
			ops = append(ops, diffOp{'-', l})
		}
		for _, l := range mb {
			ops = append(ops, diffOp{'+', l})
		}
	} else {
		// dp[i][j] = LCS length of ma[i:], mb[j:]
		dp := make([][]int32, n+1)
		for i := range dp {
			dp[i] = make([]int32, m+1)
		}
		for i := n - 1; i >= 0; i-- {
			for j := m - 1; j >= 0; j-- {
				if ma[i] == mb[j] {
					dp[i][j] = dp[i+1][j+1] + 1
				} else if dp[i+1][j] >= dp[i][j+1] {
					dp[i][j] = dp[i+1][j]
				} else {
					dp[i][j] = dp[i][j+1]
				}
			}
		}
		i, j := 0, 0
		for i < n || j < m {
			switch {
			case i < n && j < m && ma[i] == mb[j]:
				ops = append(ops, diffOp{' ', ma[i]})
				i++
				j++
			case j < m && (i == n || dp[i][j+1] > dp[i+1][j]):
				ops = append(ops, diffOp{'+', mb[j]})
				j++
			default:
				ops = append(ops, diffOp{'-', ma[i]})
				i++
			}
		}
	}
	for _, l := range a[len(a)-suf:] {
		ops = append(ops, diffOp{' ', l})
	}
	return ops
}

// hunks renders ops as unified-diff hunks with 3 lines of context. startA/startB are the 1-based line
// numbers of ops[0] in the old/new file.
func hunks(ops []diffOp, startA, startB int) string {
	const ctx = 3
	var sb strings.Builder
	idx := 0
	for idx < len(ops) {
		// find next change
		for idx < len(ops) && ops[idx].kind == ' ' {
			idx++
		}
		if idx >= len(ops) {
			break
		}
		from := idx - ctx
		if from < 0 {
			from = 0
		}
		// extend to cover changes separated by <= 2*ctx context lines
		to := idx
		for to < len(ops) {
			if ops[to].kind != ' ' {
				to++
				continue
			}
			k := to
			for k < len(ops) && ops[k].kind == ' ' {
				k++
			}
			if k < len(ops) && k-to <= 2*ctx {
				to = k
				continue
			}
			to += min(ctx, k-to)
			break
		}
		// count line numbers before `from`
		la, lb := startA, startB
		for _, op := range ops[:from] {
			if op.kind != '+' {
				la++
			}
			if op.kind != '-' {
				lb++
			}
		}
		ca, cb := 0, 0
		for _, op := range ops[from:to] {
			if op.kind != '+' {
				ca++
			}
			if op.kind != '-' {
				cb++
			}
		}
		if ca == 0 {
			la--
		}
		if cb == 0 {
			lb--
		}
		fmt.Fprintf(&sb, "@@ -%d,%d +%d,%d @@\n", la, ca, lb, cb)
		for _, op := range ops[from:to] {
			sb.WriteByte(op.kind)
			sb.WriteString(op.text)
			sb.WriteByte('\n')
		}
		idx = to
	}
	return sb.String()
}

func diffHeader(oldPath, newPath string) string {
	a, b := "a/"+strings.TrimPrefix(oldPath, "/"), "b/"+strings.TrimPrefix(newPath, "/")
	if oldPath == "" {
		a = "/dev/null"
	}
	if newPath == "" {
		b = "/dev/null"
	}
	return "--- " + a + "\n+++ " + b + "\n"
}

// unifiedDiff diffs two whole texts (empty old = new file).
func unifiedDiff(path, oldText, newText string) string {
	oldPath := path
	if oldText == "" {
		oldPath = ""
	}
	body := hunks(lineDiff(splitLines(oldText), splitLines(newText)), 1, 1)
	if body == "" {
		return ""
	}
	return diffHeader(oldPath, path) + body
}

// editDiff renders one string replacement; fileText (if known) locates the line number of oldStr.
func editDiff(oldStr, newStr, fileText string) string {
	start := 1
	if fileText != "" && oldStr != "" {
		if i := strings.Index(fileText, oldStr); i >= 0 {
			start = strings.Count(fileText[:i], "\n") + 1
		}
	}
	return hunks(lineDiff(splitLines(oldStr), splitLines(newStr)), start, start)
}

// addedFileDiff shows a whole new file.
func addedFileDiff(path, content string) string { return unifiedDiff(path, "", content) }

// normalizeCodexDiff makes Codex FileUpdateChange.diff a proper unified diff with headers.
func normalizeCodexDiff(path, kind, movePath, diff string) string {
	if strings.HasPrefix(diff, "---") || strings.HasPrefix(diff, "diff ") {
		return diff
	}
	switch kind {
	case "add":
		if strings.HasPrefix(diff, "@@") {
			return diffHeader("", path) + diff
		}
		return addedFileDiff(path, diff)
	case "delete":
		if strings.HasPrefix(diff, "@@") {
			return diffHeader(path, "") + diff
		}
		return diffHeader(path, "") + hunks(lineDiff(splitLines(diff), nil), 1, 1)
	default:
		np := path
		if movePath != "" {
			np = movePath
		}
		return diffHeader(path, np) + diff
	}
}
