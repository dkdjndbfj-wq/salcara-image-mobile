package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"sort"
	"strconv"
	"strings"
)

// The logo from internal/console/web/logo.svg: a rounded square with a #3D7BFA → #A68BF7 diagonal
// gradient and a white "S" (viewBox 0 0 64 64). Rendered here with a tiny scanline rasterizer
// (Go's standard library has no vector graphics).
const logoS = "M41.5 21.5c-2.2-2.4-5.6-3.7-9.4-3.7-6 0-10.1 3.1-10.1 7.6 0 4.2 3 6.1 9.2 7.4 4.3.9 5.6 1.8 5.6 3.5 0 1.9-1.9 3.1-4.9 3.1-3.3 0-6-1.3-8-3.6l-3.8 4.1c2.6 3 6.7 4.6 11.5 4.6 6.5 0 10.9-3.2 10.9-8.3 0-4.3-2.8-6.4-9.4-7.8-4-.8-5.3-1.6-5.3-3.1 0-1.6 1.6-2.7 4.2-2.7 2.6 0 4.7 1 6.3 2.8z"

type pt struct{ x, y float64 }

// parsePath understands the subset the logo uses: M/m, L/l, C/c, Z/z with SVG's compact number syntax.
func parsePath(d string) [][]pt {
	var nums []float64
	var polys [][]pt
	var cur []pt
	var p, start pt
	cmd := byte(0)
	i := 0
	readNum := func() (float64, bool) {
		for i < len(d) && (d[i] == ' ' || d[i] == ',' || d[i] == '\n' || d[i] == '\t') {
			i++
		}
		if i >= len(d) {
			return 0, false
		}
		j := i
		if d[j] == '-' || d[j] == '+' {
			j++
		}
		dot := false
		for j < len(d) && (d[j] >= '0' && d[j] <= '9' || (d[j] == '.' && !dot)) {
			if d[j] == '.' {
				dot = true
			}
			j++
		}
		if j == i || (j == i+1 && (d[i] == '-' || d[i] == '+')) {
			return 0, false
		}
		v, err := strconv.ParseFloat(d[i:j], 64)
		if err != nil {
			return 0, false
		}
		i = j
		return v, true
	}
	flush := func() {
		if len(cur) > 2 {
			polys = append(polys, cur)
		}
		cur = nil
	}
	for i < len(d) {
		c := d[i]
		if strings.IndexByte("MmLlCcZz", c) >= 0 {
			cmd = c
			i++
			if cmd == 'Z' || cmd == 'z' {
				p = start
				flush()
			}
			continue
		}
		nums = nums[:0]
		want := map[byte]int{'M': 2, 'm': 2, 'L': 2, 'l': 2, 'C': 6, 'c': 6}[cmd]
		if want == 0 {
			i++
			continue
		}
		for k := 0; k < want; k++ {
			v, ok := readNum()
			if !ok {
				return polys
			}
			nums = append(nums, v)
		}
		rel := cmd >= 'a'
		abs := func(x, y float64) pt {
			if rel {
				return pt{p.x + x, p.y + y}
			}
			return pt{x, y}
		}
		switch cmd {
		case 'M', 'm':
			flush()
			p = abs(nums[0], nums[1])
			start = p
			cur = append(cur, p)
			if cmd == 'M' {
				cmd = 'L'
			} else {
				cmd = 'l'
			}
		case 'L', 'l':
			p = abs(nums[0], nums[1])
			cur = append(cur, p)
		case 'C', 'c':
			c1, c2, e := abs(nums[0], nums[1]), abs(nums[2], nums[3]), abs(nums[4], nums[5])
			for s := 1; s <= 16; s++ {
				t := float64(s) / 16
				u := 1 - t
				cur = append(cur, pt{
					u*u*u*p.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*e.x,
					u*u*u*p.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*e.y,
				})
			}
			p = e
		}
	}
	flush()
	return polys
}

// inside reports whether (x,y) is inside the polygons (non-zero winding).
func inside(polys [][]pt, x, y float64) bool {
	w := 0
	for _, poly := range polys {
		n := len(poly)
		for k := 0; k < n; k++ {
			a, b := poly[k], poly[(k+1)%n]
			if a.y <= y {
				if b.y > y && (b.x-a.x)*(y-a.y)-(x-a.x)*(b.y-a.y) > 0 {
					w++
				}
			} else if b.y <= y && (b.x-a.x)*(y-a.y)-(x-a.x)*(b.y-a.y) < 0 {
				w--
			}
		}
	}
	return w != 0
}

// inRoundRect: rounded square [x0,x0+s]² with corner radius r.
func inRoundRect(x, y, x0, s, r float64) bool {
	if x < x0 || y < x0 || x > x0+s || y > x0+s {
		return false
	}
	cx := math.Max(x0+r, math.Min(x, x0+s-r))
	cy := math.Max(x0+r, math.Min(y, x0+s-r))
	return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r
}

type crossing struct {
	x   float64
	dir int
}

// rowCrossings returns where a horizontal line at y crosses the polygons, sorted by x, with winding direction.
func rowCrossings(polys [][]pt, y float64) []crossing {
	var cs []crossing
	for _, poly := range polys {
		n := len(poly)
		for k := 0; k < n; k++ {
			a, b := poly[k], poly[(k+1)%n]
			if (a.y <= y) == (b.y <= y) {
				continue
			}
			x := a.x + (y-a.y)*(b.x-a.x)/(b.y-a.y)
			d := 1
			if b.y < a.y {
				d = -1
			}
			cs = append(cs, crossing{x, d})
		}
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].x < cs[j].x })
	return cs
}

// renderIcon draws the logo at size×size following the macOS icon grid: the tile is 824/1024 of the
// canvas, centred, with a soft shadow; 4×4 supersampling for anti-aliasing.
func renderIcon(size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	polys := parsePath(logoS)
	S := float64(size)
	tile := S * 824 / 1024
	x0 := (S - tile) / 2
	r := tile * 0.225
	scale := tile / 64
	c1 := [3]float64{0x3D, 0x7B, 0xFA}
	c2 := [3]float64{0xA6, 0x8B, 0xF7}
	const ss = 4
	bgRow := make([]float64, size)
	fgRow := make([]float64, size)
	shRow := make([]float64, size)
	for py := 0; py < size; py++ {
		for i := range bgRow {
			bgRow[i], fgRow[i], shRow[i] = 0, 0, 0
		}
		for sy := 0; sy < ss; sy++ {
			y := float64(py) + (float64(sy)+0.5)/ss
			cs := rowCrossings(polys, (y-x0)/scale)
			ci, wind := 0, 0
			for sxAll := 0; sxAll < size*ss; sxAll++ {
				x := (float64(sxAll) + 0.5) / ss
				px := sxAll / ss
				lx := (x - x0) / scale
				for ci < len(cs) && cs[ci].x <= lx {
					wind += cs[ci].dir
					ci++
				}
				if inRoundRect(x, y, x0, tile, r) {
					bgRow[px]++
					if wind != 0 {
						fgRow[px]++
					}
				} else if inRoundRect(x, y-S*0.012, x0, tile, r) {
					shRow[px]++
				}
			}
		}
		n := float64(ss * ss)
		for px := 0; px < size; px++ {
			bg, fg, shadow := bgRow[px]/n, fgRow[px]/n, shRow[px]/n
			t := ((float64(px)-x0)/tile + (float64(py)-x0)/tile) / 2
			t = math.Max(0, math.Min(1, t))
			var rgb [3]float64
			for k := 0; k < 3; k++ {
				g := c1[k] + (c2[k]-c1[k])*t
				if bg > 0 {
					rgb[k] = g*(1-fg/bg) + 255*(fg/bg)
				}
			}
			a := bg + shadow*0.25*(1-bg)
			if a <= 0 {
				continue
			}
			// the shadow is black: scale colour by the tile's share of the coverage
			share := bg / a
			img.SetNRGBA(px, py, color.NRGBA{uint8(rgb[0]*share + .5), uint8(rgb[1]*share + .5), uint8(rgb[2]*share + .5), uint8(math.Min(255, a*255+.5))})
		}
	}
	return img
}

// icns builds an Apple icon file: "icns" + total length, then (type, length incl. header, PNG data) chunks.
func icns() ([]byte, error) {
	chunks := []struct {
		typ  string
		size int
	}{
		{"ic11", 32}, {"ic12", 64}, {"ic07", 128}, {"ic13", 256}, {"ic08", 256}, {"ic14", 512}, {"ic09", 512}, {"ic10", 1024},
	}
	cache := map[int][]byte{}
	var body bytes.Buffer
	for _, c := range chunks {
		data, ok := cache[c.size]
		if !ok {
			var b bytes.Buffer
			if err := png.Encode(&b, renderIcon(c.size)); err != nil {
				return nil, err
			}
			data = b.Bytes()
			cache[c.size] = data
		}
		body.WriteString(c.typ)
		_ = binary.Write(&body, binary.BigEndian, uint32(8+len(data)))
		body.Write(data)
	}
	var out bytes.Buffer
	out.WriteString("icns")
	_ = binary.Write(&out, binary.BigEndian, uint32(8+body.Len()))
	out.Write(body.Bytes())
	return out.Bytes(), nil
}
