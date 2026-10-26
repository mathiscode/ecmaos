/** GNU diff's comparison: the equivalence-class search (compareseq), its boundary shifting, and the runs of changes it leaves. */

const SNAKE_LIMIT = 20
const OFFSET_MAX = 2 ** 30

/**
 * GNU's compareseq over the arrays `a` and `b` of equivalence classes: calls `del(i)` for a line of `a` with no counterpart and
 * `ins(j)` for one of `b`, in order.
 */
function compareseq(a, b, del, ins) {
  const size = a.length + b.length + 3
  const fd = new Int32Array(size)
  const bd = new Int32Array(size)
  const shift = b.length + 1
  const same = (x, y) => a[x] === b[y]

  function diag(xoff, xlim, yoff, ylim) {
    const dmin = xoff - ylim
    const dmax = xlim - yoff
    const fmid = xoff - yoff
    const bmid = xlim - ylim
    let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid
    const odd = ((fmid - bmid) & 1) !== 0
    fd[fmid + shift] = xoff
    bd[bmid + shift] = xlim
    for (let c = 1; ; c++) {
      if (fmin > dmin) fd[--fmin - 1 + shift] = -1
      else ++fmin
      if (fmax < dmax) fd[++fmax + 1 + shift] = -1
      else --fmax
      for (let d = fmax; d >= fmin; d -= 2) {
        const tlo = fd[d - 1 + shift]
        const thi = fd[d + 1 + shift]
        const x0 = tlo < thi ? thi : tlo + 1
        let x = x0
        let y = x0 - d
        while (x < xlim && y < ylim && same(x, y)) { x++; y++ }
        fd[d + shift] = x
        if (odd && bmin <= d && d <= bmax && bd[d + shift] <= x) return { xmid: x, ymid: y }
      }
      if (bmin > dmin) bd[--bmin - 1 + shift] = OFFSET_MAX
      else ++bmin
      if (bmax < dmax) bd[++bmax + 1 + shift] = OFFSET_MAX
      else --bmax
      for (let d = bmax; d >= bmin; d -= 2) {
        const tlo = bd[d - 1 + shift]
        const thi = bd[d + 1 + shift]
        const x0 = tlo < thi ? tlo : thi - 1
        let x = x0
        let y = x0 - d
        while (xoff < x && yoff < y && same(x - 1, y - 1)) { x--; y-- }
        bd[d + shift] = x
        if (!odd && fmin <= d && d <= fmax && x <= fd[d + shift]) return { xmid: x, ymid: y }
      }
    }
  }

  function run(xoff, xlim, yoff, ylim) {
    while (xoff < xlim && yoff < ylim && same(xoff, yoff)) { xoff++; yoff++ }
    while (xoff < xlim && yoff < ylim && same(xlim - 1, ylim - 1)) { xlim--; ylim-- }
    if (xoff === xlim) while (yoff < ylim) ins(yoff++)
    else if (yoff === ylim) while (xoff < xlim) del(xoff++)
    else {
      const { xmid, ymid } = diag(xoff, xlim, yoff, ylim)
      run(xoff, xmid, yoff, ymid)
      run(xmid, xlim, ymid, ylim)
    }
  }
  run(0, a.length, 0, b.length)
}

/** Which lines of each file are changed, as GNU computes it, from the equivalence classes of the lines of both */
export function changedLines(eq0, eq1) {
  const n0 = eq0.length
  const n1 = eq1.length
  const count0 = new Map()
  const count1 = new Map()
  for (const id of eq0) count0.set(id, (count0.get(id) ?? 0) + 1)
  for (const id of eq1) count1.set(id, (count1.get(id) ?? 0) + 1)
  // lines with no equal in the other file are changed for certain, and stay out of the search
  const keep0 = []
  const keep1 = []
  for (let i = 0; i < n0; i++) if (count1.has(eq0[i])) keep0.push(i)
  for (let j = 0; j < n1; j++) if (count0.has(eq1[j])) keep1.push(j)
  // arrays with a sentinel unchanged line on each side: line k is at k + 1
  const changed0 = new Uint8Array(n0 + 2).fill(1)
  const changed1 = new Uint8Array(n1 + 2).fill(1)
  changed0[0] = changed0[n0 + 1] = 0
  changed1[0] = changed1[n1 + 1] = 0
  for (const i of keep0) changed0[i + 1] = 0
  for (const j of keep1) changed1[j + 1] = 0
  compareseq(keep0.map(i => eq0[i]), keep1.map(j => eq1[j]), x => { changed0[keep0[x] + 1] = 1 }, y => { changed1[keep1[y] + 1] = 1 })
  shiftBoundaries(changed0, changed1, eq0, n0)
  shiftBoundaries(changed1, changed0, eq1, n1)
  return [changed0, changed1]
}

/**
 * GNU's `shift_boundaries`: a run of changed lines slides up or down past lines equal to the ones at its other end, so that
 * it merges with a neighbouring run, or, failing that, lines up with a run of changes in the other file.
 */
function shiftBoundaries(changed, other, equivs, length) {
  // changed[k + 1] is line k
  const c = k => changed[k + 1]
  const setC = (k, v) => { changed[k + 1] = v }
  const o = k => other[k + 1]
  let i = 0
  let j = 0
  const end = length
  for (;;) {
    while (i < end && !c(i)) {
      while (o(j++)) continue
      i++
    }
    if (i === end) break
    let start = i
    while (c(++i)) continue
    while (o(j)) j++
    let runlength
    let corresponding
    do {
      runlength = i - start
      while (start && equivs[start - 1] === equivs[i - 1]) {
        setC(--start, 1)
        setC(--i, 0)
        while (c(start - 1)) start--
        while (o(--j)) continue
      }
      corresponding = o(j - 1) ? i : end
      while (i !== end && equivs[start] === equivs[i]) {
        setC(start++, 0)
        setC(i++, 1)
        while (c(i)) i++
        while (o(++j)) corresponding = i
      }
    } while (runlength !== i - start)
    while (corresponding < i) {
      setC(--start, 1)
      setC(--i, 0)
      while (o(--j)) continue
    }
  }
}

/** The runs of changes as `{ line0, deleted, line1, inserted }` (line numbers from 0), in order */
export function scriptOf(changed0, changed1, n0, n1) {
  const script = []
  let i = 0
  let j = 0
  while (i < n0 || j < n1) {
    if (i < n0 && j < n1 && !changed0[i + 1] && !changed1[j + 1]) { i++; j++; continue }
    const line0 = i
    const line1 = j
    while (i < n0 && changed0[i + 1]) i++
    while (j < n1 && changed1[j + 1]) j++
    script.push({ line0, deleted: i - line0, line1, inserted: j - line1 })
  }
  return script
}
