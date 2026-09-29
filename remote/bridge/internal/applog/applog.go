// Package applog is a size-rotating log file (bridge.log → bridge.log.1 at 5 MB).
package applog

import (
	"bufio"
	"os"
	"strings"
	"sync"
)

// MaxSize is the rotation threshold.
const MaxSize = 5 << 20

// File is an io.Writer that rotates itself.
type File struct {
	path string
	mu   sync.Mutex
	f    *os.File
	size int64
}

// Open opens (appends to) path.
func Open(path string) (*File, error) {
	l := &File{path: path}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *File) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	l.f = f
	l.size = 0
	if st != nil {
		l.size = st.Size()
	}
	return nil
}

// Write implements io.Writer.
func (l *File) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return len(p), nil
	}
	if l.size+int64(len(p)) > MaxSize {
		_ = l.f.Close()
		_ = os.Remove(l.path + ".1")
		_ = os.Rename(l.path, l.path+".1")
		if err := l.open(); err != nil {
			l.f = nil
			return len(p), nil
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

// Close closes the file.
func (l *File) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// Path is the current log file.
func (l *File) Path() string { return l.path }

// Tail returns the last n lines (looking into the rotated file if the current one is short).
func Tail(path string, n int) []string {
	lines := readLines(path)
	if len(lines) < n {
		lines = append(readLines(path+".1"), lines...)
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func readLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	// Only look at the last ~512 KB.
	if st, err := f.Stat(); err == nil && st.Size() > 512<<10 {
		_, _ = f.Seek(st.Size()-512<<10, 0)
	}
	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		out = append(out, strings.TrimRight(sc.Text(), "\r"))
	}
	return out
}
