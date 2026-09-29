package main

import (
	"bytes"
	"debug/macho"
	"encoding/binary"
	"testing"
)

// thin builds a minimal 64-bit Mach-O (header + optional LC_CODE_SIGNATURE) padded to size.
func thin(cpu, sub uint32, signed bool, size int, fill byte) []byte {
	le := binary.LittleEndian
	var cmds []byte
	if signed {
		c := make([]byte, 16)
		le.PutUint32(c[0:], lcCodeSignature)
		le.PutUint32(c[4:], 16)
		cmds = append(cmds, c...)
	}
	h := make([]byte, 32)
	le.PutUint32(h[0:], macho.Magic64)
	le.PutUint32(h[4:], cpu)
	le.PutUint32(h[8:], sub)
	le.PutUint32(h[12:], uint32(macho.TypeExec))
	n := uint32(0)
	if signed {
		n = 1
	}
	le.PutUint32(h[16:], n)
	le.PutUint32(h[20:], uint32(len(cmds)))
	b := append(h, cmds...)
	for len(b) < size {
		b = append(b, fill)
	}
	return b
}

func TestFatRoundTrip(t *testing.T) {
	arm, err := inspect("arm", thin(cpuTypeARM64, 0, true, 40000, 0xAA))
	if err != nil {
		t.Fatal(err)
	}
	x86, err := inspect("x86", thin(cpuTypeX86_64, 0x80000003, false, 20001, 0xBB))
	if err != nil {
		t.Fatal(err)
	}
	if !arm.hasSign || x86.hasSign {
		t.Fatalf("signature detection: arm=%v x86=%v", arm.hasSign, x86.hasSign)
	}
	if x86.subcpu != 0x80000003 {
		t.Fatalf("capability bits lost: %#x", x86.subcpu)
	}
	ins := []slice{arm, x86}
	fat, err := Fat(ins)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(fat, ins); err != nil {
		t.Fatal(err)
	}
	be := binary.BigEndian
	if be.Uint32(fat[0:]) != 0xcafebabe || be.Uint32(fat[4:]) != 2 {
		t.Fatal("bad fat header")
	}
	// x86_64 first, both 16 KiB aligned, no overlap.
	if be.Uint32(fat[8:]) != cpuTypeX86_64 || be.Uint32(fat[28:]) != cpuTypeARM64 {
		t.Fatal("slice order")
	}
	o1, s1, o2 := be.Uint32(fat[16:]), be.Uint32(fat[20:]), be.Uint32(fat[36:])
	if o1 != 16384 || o2%16384 != 0 || o2 < o1+s1 || be.Uint32(fat[24:]) != 14 {
		t.Fatalf("offsets %d %d %d", o1, s1, o2)
	}
	ff, err := macho.NewFatFile(bytes.NewReader(fat))
	if err != nil {
		t.Fatal(err)
	}
	if len(ff.Arches) != 2 || ff.Arches[1].Cpu != macho.CpuArm64 {
		t.Fatalf("%+v", ff.Arches)
	}
	if _, err := Fat([]slice{arm, arm}); err == nil {
		t.Fatal("duplicate arch accepted")
	}
	if _, err := inspect("junk", []byte("#!/bin/sh\n")); err == nil {
		t.Fatal("junk accepted")
	}
}
