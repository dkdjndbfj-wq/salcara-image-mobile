// Command lipo joins thin 64-bit Mach-O executables into one universal ("fat") binary, like Apple's
// `lipo -create`, using only the Go standard library so macOS builds can be packaged on Linux.
//
//	go run ./tools/lipo -output SalcaraBridge-universal SalcaraBridge-macos-arm64 SalcaraBridge-macos-amd64
//
// Layout: a big-endian fat_header (FAT_MAGIC 0xcafebabe, nfat_arch) followed by one fat_arch per slice
// (cputype, cpusubtype, offset, size, align), then every slice copied byte for byte at an offset aligned
// to 2^14 (the arm64 page size; also valid for x86_64). Slices are never modified, so the ad-hoc code
// signature Go's linker puts into darwin/arm64 binaries stays valid. After writing, the file is parsed
// back with debug/macho and each slice compared with its input.
package main

import (
	"bytes"
	"debug/macho"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
)

const (
	fatMagic        = 0xcafebabe
	alignShift      = 14 // 16 KiB
	cpuTypeX86_64   = 0x01000007
	cpuTypeARM64    = 0x0100000c
	lcCodeSignature = 0x1d
)

type slice struct {
	name    string
	data    []byte
	cpu     uint32
	subcpu  uint32
	offset  uint32
	hasSign bool
}

// inspect reads the Mach-O header of a thin binary.
func inspect(name string, data []byte) (slice, error) {
	f, err := macho.NewFile(bytes.NewReader(data))
	if err != nil {
		return slice{}, fmt.Errorf("%s: not a thin Mach-O file: %w", name, err)
	}
	defer f.Close()
	if f.Magic != macho.Magic64 {
		return slice{}, fmt.Errorf("%s: only 64-bit Mach-O is supported", name)
	}
	s := slice{name: name, data: data, cpu: uint32(f.Cpu), subcpu: f.SubCpu}
	// Keep the raw subtype including capability bits (e.g. CPU_SUBTYPE_LIB64), as Apple's lipo does.
	s.subcpu = f.ByteOrder.Uint32(data[8:12])
	for _, l := range f.Loads {
		raw := l.Raw()
		if len(raw) >= 4 && f.ByteOrder.Uint32(raw[:4]) == lcCodeSignature {
			s.hasSign = true
		}
	}
	return s, nil
}

func alignUp(v, shift uint32) uint32 {
	a := uint32(1) << shift
	return (v + a - 1) &^ (a - 1)
}

func cpuName(c uint32) string {
	switch c {
	case cpuTypeARM64:
		return "arm64"
	case cpuTypeX86_64:
		return "x86_64"
	}
	return fmt.Sprintf("cpu(0x%x)", c)
}

// Fat builds the universal binary. Slices are ordered x86_64 first, then arm64 (Apple's order).
func Fat(inputs []slice) ([]byte, error) {
	if len(inputs) == 0 {
		return nil, errors.New("no input files")
	}
	seen := map[uint32]bool{}
	for _, s := range inputs {
		if seen[s.cpu] {
			return nil, fmt.Errorf("two slices for %s", cpuName(s.cpu))
		}
		seen[s.cpu] = true
	}
	sort.SliceStable(inputs, func(i, j int) bool { return inputs[i].cpu < inputs[j].cpu })
	off := alignUp(8+20*uint32(len(inputs)), alignShift)
	for i := range inputs {
		inputs[i].offset = off
		n := uint64(off) + uint64(len(inputs[i].data))
		if n > 1<<32-1 {
			return nil, errors.New("fat file larger than 4 GiB")
		}
		off = alignUp(uint32(n), alignShift)
	}
	last := inputs[len(inputs)-1]
	out := make([]byte, int(last.offset)+len(last.data))
	be := binary.BigEndian
	be.PutUint32(out[0:], fatMagic)
	be.PutUint32(out[4:], uint32(len(inputs)))
	for i, s := range inputs {
		h := out[8+20*i:]
		be.PutUint32(h[0:], s.cpu)
		be.PutUint32(h[4:], s.subcpu)
		be.PutUint32(h[8:], s.offset)
		be.PutUint32(h[12:], uint32(len(s.data)))
		be.PutUint32(h[16:], alignShift)
		copy(out[s.offset:], s.data)
	}
	return out, nil
}

// Verify parses fat back and checks each slice is byte-identical to its input.
func Verify(fat []byte, inputs []slice) error {
	ff, err := macho.NewFatFile(bytes.NewReader(fat))
	if err != nil {
		return fmt.Errorf("output is not a valid fat file: %w", err)
	}
	defer ff.Close()
	if len(ff.Arches) != len(inputs) {
		return fmt.Errorf("output has %d slices, want %d", len(ff.Arches), len(inputs))
	}
	for _, in := range inputs {
		found := false
		for _, a := range ff.Arches {
			if uint32(a.Cpu) != in.cpu {
				continue
			}
			found = true
			if a.Offset%(1<<alignShift) != 0 || a.Align != alignShift {
				return fmt.Errorf("%s: bad alignment", cpuName(in.cpu))
			}
			if !bytes.Equal(fat[a.Offset:a.Offset+a.Size], in.data) {
				return fmt.Errorf("%s: slice differs from %s", cpuName(in.cpu), in.name)
			}
		}
		if !found {
			return fmt.Errorf("%s missing in output", cpuName(in.cpu))
		}
	}
	return nil
}

func main() {
	output := flag.String("output", "", "universal binary to write")
	requireSig := flag.Bool("require-arm64-signature", true, "fail if the arm64 slice has no LC_CODE_SIGNATURE (Apple silicon refuses to run unsigned code)")
	flag.Parse()
	if *output == "" || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: lipo -output FAT THIN...")
		os.Exit(2)
	}
	var ins []slice
	for _, name := range flag.Args() {
		b, err := os.ReadFile(name)
		if err != nil {
			fail(err)
		}
		s, err := inspect(name, b)
		if err != nil {
			fail(err)
		}
		if s.cpu == cpuTypeARM64 && !s.hasSign && *requireSig {
			fail(fmt.Errorf("%s: arm64 slice has no LC_CODE_SIGNATURE (build with Go's internal linker, or sign it)", name))
		}
		ins = append(ins, s)
	}
	fat, err := Fat(ins)
	if err != nil {
		fail(err)
	}
	if err := Verify(fat, ins); err != nil {
		fail(err)
	}
	if err := os.WriteFile(*output, fat, 0o755); err != nil {
		fail(err)
	}
	for _, s := range ins {
		sig := "unsigned"
		if s.hasSign {
			sig = "ad-hoc signed (LC_CODE_SIGNATURE)"
		}
		fmt.Printf("  %-7s offset %-9d size %-9d subtype 0x%08x %s\n", cpuName(s.cpu), s.offset, len(s.data), s.subcpu, sig)
	}
	fmt.Printf("wrote %s (%d bytes)\n", *output, len(fat))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "lipo:", err)
	os.Exit(1)
}
