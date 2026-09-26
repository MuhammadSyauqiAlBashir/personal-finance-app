// Hand-drawn SVG charts. Rules (dataviz method): thin marks, 4px rounded ends
// anchored on the baseline, hairline solid grid, one tooltip per mark or a
// crosshair, a legend for 2+ series, a table view for every chart, text in
// text colours (never the series colour). Palette validated against the dark
// card surface #15171d.

import { el, rp, rpShort, svg, fmtDate } from "./lib.js"

export const GROUP_COLOR = { needs: "var(--s1)", wants: "var(--s2)", savings: "var(--s3)" }
export const GROUP_LABEL = { needs: "Needs", wants: "Wants", savings: "Savings", must: "Must spend" }
// Must-spend counts as needs in the 50/30/20 view.
export const bucketOf = (group) => (group === "must" ? "needs" : group)

// ---------------------------------------------------------------------------
// Tooltip (one shared element)
// ---------------------------------------------------------------------------
let tip
function tooltip() {
  if (!tip) {
    tip = el("div", { class: "chart-tip", role: "status" })
    tip.hidden = true
    document.body.append(tip)
  }
  return tip
}
export function showTip(x, y, rows, title) {
  const t = tooltip()
  t.replaceChildren()
  if (title) t.append(el("div", { class: "tip-title", text: title }))
  for (const r of rows) {
    t.append(el("div", { class: "tip-row" },
      r.color ? el("span", { class: "tip-key", style: { background: r.color } }) : null,
      el("strong", { text: r.value }), el("span", { class: "tip-label", text: r.label || "" })))
  }
  t.hidden = false
  const w = t.offsetWidth, h = t.offsetHeight
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))
  const top = y - h - 14 < 8 ? y + 18 : y - h - 14
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
}
export function hideTip() { if (tip) tip.hidden = true }
window.addEventListener("scroll", hideTip, { passive: true })

function bindTip(node, getRows, title) {
  const show = (e) => {
    const r = node.getBoundingClientRect()
    const x = e && e.clientX !== undefined && e.type !== "focus" ? e.clientX : r.left + r.width / 2
    const y = e && e.clientY !== undefined && e.type !== "focus" ? e.clientY : r.top
    node.classList.add("hot")
    showTip(x, y, getRows(), typeof title === "function" ? title() : title)
  }
  const hide = () => { node.classList.remove("hot"); hideTip() }
  node.addEventListener("pointerenter", show)
  node.addEventListener("pointermove", show)
  node.addEventListener("pointerleave", hide)
  node.addEventListener("focus", show)
  node.addEventListener("blur", hide)
  node.setAttribute("tabindex", "0")
}

// ---------------------------------------------------------------------------
// Figure: title + optional legend + chart + table-view toggle
// ---------------------------------------------------------------------------
export function figure(title, subtitle, chart, table, legend) {
  const tableWrap = el("div", { class: "table-view", hidden: true }, table)
  const toggle = el("button", { class: "link-btn small", type: "button", text: "Table" })
  toggle.onclick = () => {
    tableWrap.hidden = !tableWrap.hidden
    chart.hidden = !tableWrap.hidden
    toggle.textContent = tableWrap.hidden ? "Table" : "Chart"
  }
  return el("figure", { class: "chart-card" },
    el("div", { class: "chart-head" },
      el("div", {}, el("h3", { text: title }), subtitle ? el("p", { class: "muted", text: subtitle }) : null),
      table ? toggle : null),
    legend || null, chart, table ? tableWrap : null)
}

export function legend(items) {
  return el("div", { class: "legend" }, items.map((i) =>
    el("span", { class: "legend-item" }, el("span", { class: `swatch ${i.line ? "line" : ""}`, style: { background: i.color } }), i.label)))
}

export function table(headers, rows) {
  return el("div", { class: "tbl-wrap" }, el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, headers.map((h, i) => el("th", { class: i ? "num" : "", text: h })))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: i ? "num" : "", text: c })))))))
}

// Nice axis maximum and ticks.
function niceMax(v) {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
  return step * p
}

// Rounded top/right end, square at the baseline.
function barPath(x, y, w, h, r, horizontal) {
  r = Math.min(r, horizontal ? h / 2 : w / 2, horizontal ? w : h)
  if (w <= 0 || h <= 0) return ""
  if (horizontal) {
    return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`
  }
  return `M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`
}

// ---------------------------------------------------------------------------
// Horizontal bars (one series): spending by category, top merchants
// ---------------------------------------------------------------------------
export function hbars(items, { color = "var(--s1)", valueFmt = rp } = {}) {
  // items: [{label, value, icon?}]
  const max = Math.max(1, ...items.map((i) => i.value))
  const wrap = el("div", { class: "hbars" })
  for (const it of items) {
    const w = Math.max(1.5, (it.value / max) * 100)
    const bar = el("div", { class: "hbar-track" }, el("div", { class: "hbar", style: { width: `${w}%`, background: color } }))
    const row = el("div", { class: "hbar-row" },
      el("div", { class: "hbar-label" }, it.icon ? el("span", { class: "emoji", text: it.icon }) : null, el("span", { text: it.label })),
      bar, el("div", { class: "hbar-value", text: valueFmt(it.value) }))
    bindTip(row, () => [{ value: rp(it.value), label: it.label, color }])
    wrap.append(row)
  }
  return wrap
}

// ---------------------------------------------------------------------------
// Meter: budget vs spent for one wallet (same-ramp track, status when over)
// ---------------------------------------------------------------------------
export function meter(spent, budget, { pace } = {}) {
  const ratio = budget > 0 ? spent / budget : spent > 0 ? 1.01 : 0
  const state = ratio > 1 ? "critical" : ratio >= 0.8 ? "warning" : "ok"
  const fill = el("div", { class: `meter-fill ${state}`, style: { width: `${Math.min(100, ratio * 100)}%` } })
  const track = el("div", { class: `meter ${state}` }, fill)
  if (pace !== undefined && pace !== null && budget > 0) {
    // Where spending "should" be by today.
    track.append(el("div", { class: "meter-pace", style: { left: `${Math.min(100, pace * 100)}%` }, title: "Today's pace" }))
  }
  return track
}

// ---------------------------------------------------------------------------
// Stacked horizontal bar vs targets (50/30/20)
// ---------------------------------------------------------------------------
export function rule503020(rule) {
  const keys = ["needs", "wants", "savings"]
  const make = (field) => {
    const row = el("div", { class: "stack" })
    let total = 0
    for (const k of keys) {
      const v = Math.max(0, rule[k][field])
      total += v
      const seg = el("div", { class: "stack-seg", style: { flexGrow: v || 0.0001, background: GROUP_COLOR[k] } })
      if (v >= 12) seg.append(el("span", { class: "stack-label", text: `${Math.round(v)}%` }))
      bindTip(seg, () => [{ value: `${Math.round(rule[k][field])}%`, label: `${GROUP_LABEL[k]} (${field === "actual" ? "actual" : "target"})`, color: GROUP_COLOR[k] }])
      row.append(seg)
    }
    if (total < 100) row.append(el("div", { class: "stack-seg rest", style: { flexGrow: 100 - total } }))
    return row
  }
  const chart = el("div", { class: "stack-chart" },
    el("div", { class: "stack-line" }, el("span", { class: "stack-name", text: "You" }), make("actual")),
    el("div", { class: "stack-line" }, el("span", { class: "stack-name", text: "50/30/20" }), make("target")))
  return figure("Needs · Wants · Savings", "Share of income, compared with the 50/30/20 guideline",
    chart,
    table(["Bucket", "You", "Guideline"], keys.map((k) => [GROUP_LABEL[k], `${Math.round(rule[k].actual)}%`, `${rule[k].target}%`])),
    legend(keys.map((k) => ({ label: GROUP_LABEL[k], color: GROUP_COLOR[k] }))))
}

// ---------------------------------------------------------------------------
// Columns (one series or stacked groups): weekday average, 6-month trends
// ---------------------------------------------------------------------------
export function columns(cats, series, { height = 180, stacked = false, labelEvery = 1, highlight = -1 } = {}) {
  // cats: x labels; series: [{key,label,color,values:[]}]
  const W = 340, H = height, padL = 36, padB = 24, padT = 12
  const totals = cats.map((_, i) => series.reduce((s, se) => s + (stacked ? se.values[i] : 0), 0))
  const max = niceMax(stacked ? Math.max(...totals, 1) : Math.max(1, ...series.flatMap((s) => s.values)))
  const plotW = W - padL - 6, plotH = H - padB - padT
  const band = plotW / cats.length
  const barW = Math.min(24, band * (stacked ? 0.55 : 0.6 / series.length))
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" })
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4
    root.append(svg("line", { x1: padL, x2: W - 4, y1: y, y2: y, class: i ? "grid" : "baseline" }))
    root.append(svg("text", { x: padL - 6, y: y + 4, class: "axis", "text-anchor": "end" }, document.createTextNode(i ? rpShort((max * i) / 4) : "0")))
  }
  cats.forEach((c, i) => {
    const cx = padL + band * i + band / 2
    if (i % labelEvery === 0 || i === cats.length - 1) {
      root.append(svg("text", { x: cx, y: H - 6, class: `axis${i === highlight ? " strong" : ""}`, "text-anchor": "middle" }, document.createTextNode(c)))
    }
    let base = padT + plotH
    const group = svg("g", { class: "col-group" })
    series.forEach((se, si) => {
      const v = se.values[i] || 0
      const h = (v / max) * plotH
      if (stacked) {
        if (h > 0) {
          const top = si === series.length - 1 || series.slice(si + 1).every((s2) => !(s2.values[i] > 0))
          const gap = si ? 2 : 0
          group.append(svg("path", { d: top ? barPath(cx - barW / 2, base - h, barW, Math.max(0, h - gap), 4, false)
            : `M${cx - barW / 2},${base - gap}v-${Math.max(0, h - gap)}h${barW}v${Math.max(0, h - gap)}z`, fill: se.color, class: "mark" }))
          base -= h
        }
      } else {
        const x = cx - (barW * series.length) / 2 + si * (barW + 2)
        group.append(svg("path", { d: barPath(x, base - h, barW, h, 4, false), fill: se.color,
          class: `mark${highlight >= 0 && i !== highlight ? " dim" : ""}` }))
      }
    })
    const hit = svg("rect", { x: cx - band / 2, y: padT, width: band, height: plotH, class: "hit" })
    group.append(hit)
    bindTip(group, () => series.map((se) => ({ value: rp(se.values[i] || 0), label: se.label, color: se.color }))
      .concat(stacked ? [{ value: rp(totals[i]), label: "Total" }] : []), c)
    root.append(group)
  })
  return root
}

// ---------------------------------------------------------------------------
// Burn-up: cumulative spending vs even pace, with a forecast band
// ---------------------------------------------------------------------------
export function burnup({ days, budget, projection, range, daysTotal, start }) {
  // days: [{date, amount}] from the cycle start to today
  const W = 340, H = 200, padL = 40, padB = 24, padT = 14
  const cum = []
  let s = 0
  for (const d of days) { s += d.amount; cum.push(s) }
  const top = niceMax(Math.max(budget || 0, projection || 0, (range && range[1]) || 0, s, 1))
  const plotW = W - padL - 8, plotH = H - padB - padT
  const x = (i) => padL + (plotW * i) / Math.max(1, daysTotal - 1)
  const y = (v) => padT + plotH - (v / top) * plotH
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" })
  for (let i = 0; i <= 4; i++) {
    const yy = padT + plotH - (plotH * i) / 4
    root.append(svg("line", { x1: padL, x2: W - 6, y1: yy, y2: yy, class: i ? "grid" : "baseline" }))
    root.append(svg("text", { x: padL - 6, y: yy + 4, class: "axis", "text-anchor": "end" }, document.createTextNode(i ? rpShort((top * i) / 4) : "0")))
  }
  const startDate = new Date(start + "T00:00:00+07:00")
  const dayLabel = (i) => fmtDate(new Date(startDate.getTime() + i * 86400000).toISOString())
  root.append(svg("text", { x: padL, y: H - 6, class: "axis" }, document.createTextNode(dayLabel(0))))
  root.append(svg("text", { x: W - 8, y: H - 6, class: "axis", "text-anchor": "end" }, document.createTextNode(dayLabel(daysTotal - 1))))
  if (budget) {
    // Even pace: straight line from 0 to the budget at month end.
    root.append(svg("line", { x1: x(0), y1: y(0), x2: x(daysTotal - 1), y2: y(budget), class: "pace-line" }))
    root.append(svg("text", { x: W - 8, y: y(budget) - 6, class: "axis", "text-anchor": "end" }, document.createTextNode(`Budget ${rpShort(budget)}`)))
  }
  const last = cum.length - 1
  if (range && last >= 0 && last < daysTotal - 1) {
    const [lo, hi] = range
    root.append(svg("path", { d: `M${x(last)},${y(s)}L${x(daysTotal - 1)},${y(hi)}L${x(daysTotal - 1)},${y(lo)}Z`, class: "band" }))
    root.append(svg("line", { x1: x(last), y1: y(s), x2: x(daysTotal - 1), y2: y(projection), class: "proj-line" }))
    root.append(svg("circle", { cx: x(daysTotal - 1), cy: y(projection), r: 4, class: "proj-dot" }))
  }
  if (cum.length) {
    const d = cum.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")
    root.append(svg("path", { d: `${d}L${x(last)},${y(0)}L${x(0)},${y(0)}Z`, class: "area" }))
    root.append(svg("path", { d, class: "line" }))
    root.append(svg("circle", { cx: x(last), cy: y(s), r: 4.5, class: "end-dot" }))
  }
  // Crosshair layer.
  const cross = svg("line", { y1: padT, y2: padT + plotH, class: "crosshair", visibility: "hidden" })
  const hit = svg("rect", { x: padL, y: padT, width: plotW, height: plotH, class: "hit" })
  root.append(cross, hit)
  const move = (e) => {
    const r = root.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.max(0, Math.min(daysTotal - 1, Math.round(((px - padL) / plotW) * (daysTotal - 1))))
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible")
    const rows = []
    if (i <= last) rows.push({ value: rp(cum[i]), label: "spent so far", color: "var(--s1)" })
    if (budget) rows.push({ value: rp((budget * i) / Math.max(1, daysTotal - 1)), label: "even pace", color: "var(--muted)" })
    if (i === daysTotal - 1 && projection) rows.push({ value: rp(projection), label: "projected" })
    showTip(e.clientX, r.top + (y(i <= last ? cum[i] : projection || 0) / H) * r.height, rows, dayLabel(i))
  }
  hit.addEventListener("pointermove", move)
  hit.addEventListener("pointerdown", move)
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip() })
  return root
}

// ---------------------------------------------------------------------------
// Calendar heatmap (sequential blue)
// ---------------------------------------------------------------------------
const RAMP = ["var(--seq0)", "var(--seq1)", "var(--seq2)", "var(--seq3)", "var(--seq4)", "var(--seq5)"]
export function heatmap(days) {
  // days: [{date: YYYY-MM-DD, amount}]
  const max = Math.max(1, ...days.map((d) => d.amount))
  const grid = el("div", { class: "heat" })
  for (const w of ["M", "T", "W", "T", "F", "S", "S"]) grid.append(el("div", { class: "heat-head", text: w }))
  if (days.length) {
    const first = new Date(days[0].date + "T00:00:00+07:00")
    const offset = (first.getUTCDay() + 6) % 7 // Monday first
    for (let i = 0; i < offset; i++) grid.append(el("div", { class: "heat-cell empty" }))
  }
  for (const d of days) {
    const lvl = d.amount ? Math.min(5, 1 + Math.floor((d.amount / max) * 4.999)) : 0
    const cell = el("div", { class: "heat-cell", style: { background: RAMP[lvl] } },
      el("span", { class: "heat-day", text: String(Number(d.date.slice(8))) }))
    bindTip(cell, () => [{ value: rp(d.amount), label: "spent" }], fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" }))
    grid.append(cell)
  }
  const scale = el("div", { class: "heat-scale" }, el("span", { class: "muted", text: "Less" }),
    RAMP.map((c) => el("span", { class: "heat-swatch", style: { background: c } })), el("span", { class: "muted", text: "More" }))
  return el("div", {}, grid, scale)
}

// ---------------------------------------------------------------------------
// Progress ring (month elapsed) for the hero card
// ---------------------------------------------------------------------------
export function ring(fraction, label) {
  const r = 26, c = 2 * Math.PI * r
  return svg("svg", { viewBox: "0 0 64 64", class: "ring", role: "img", "aria-label": label },
    svg("circle", { cx: 32, cy: 32, r, class: "ring-track" }),
    svg("circle", { cx: 32, cy: 32, r, class: "ring-fill", "stroke-dasharray": `${c * Math.min(1, fraction)} ${c}`, transform: "rotate(-90 32 32)" }))
}
