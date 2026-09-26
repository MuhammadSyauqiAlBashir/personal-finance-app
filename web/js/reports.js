import { api, busy, el, fmtDate, icon, markdown, rp, todayKey } from "./lib.js?v=__VERSION__"
import { GROUP_COLOR, GROUP_LABEL, bucketOf, burnup, columns, figure, hbars, heatmap, legend, meter, rule503020, table } from "./charts.js?v=__VERSION__"
import { go } from "./app.js?v=__VERSION__"

const TABS = [["monthly", "Monthly"], ["daily", "Daily"], ["trends", "Trends"], ["forecast", "Forecast"]]
let current = { tab: "monthly", period: "", day: "" }

export async function renderReports(page, tab) {
  if (tab && TABS.some(([k]) => k === tab)) current.tab = tab
  const seg = el("div", { class: "segmented" }, TABS.map(([k, label]) =>
    el("button", { type: "button", "aria-pressed": String(current.tab === k), text: label, onclick: () => { current.tab = k; renderReports(page) } })))
  const body = el("div", { style: { marginTop: "14px" } }, el("div", { class: "skeleton", style: { height: "320px" } }))
  page.replaceChildren(el("div", { class: "topbar" }, el("div", {}, el("h1", { text: "Reports" }),
    el("div", { class: "sub", text: "Where the money went, and where it's heading." }))), seg, body)
  const render = { monthly, daily, trends, forecast }[current.tab]
  await render(body)
}

function statTile(label, value, delta) {
  return el("div", { class: "big-stat" }, el("div", { class: "tile-label", text: label }), el("div", { class: "v", text: value }),
    delta ? el("div", { class: `d ${delta.cls || ""}`, text: delta.text }) : null)
}

function demoBanner(text) {
  return el("div", { class: "banner demo" }, icon("alert"), el("div", { class: "grow" },
    el("div", { class: "banner-title", text: "Demo data" }),
    el("div", { class: "banner-sub", text: text || "Made-up numbers to preview the reports. The advisor ignores it; remove it in Settings." })))
}

function aiCard(title, text) {
  return el("div", { class: "card ai-card" }, el("div", { class: "ai-head" }, icon("spark"), title), markdown(text))
}

// ---------------------------------------------------------------------------
// Monthly
// ---------------------------------------------------------------------------
async function monthly(body) {
  const [{ periods }, demo] = await Promise.all([api("/periods"), api("/demo")])
  const demoIds = new Set(demo.periods)
  if (!current.period) current.period = (periods.find((p) => p.start <= todayKey() && p.end >= todayKey()) || periods[0] || {}).id || ""
  const picker = el("select", { onchange: () => { current.period = picker.value; body.style.opacity = 0.5; monthly(body).finally(() => { body.style.opacity = 1 }) } },
    periods.map((p) => el("option", { value: p.id, text: `${fmtDate(p.start, { day: "numeric", month: "short", year: "numeric" })} – ${fmtDate(p.end)}${demoIds.has(p.id) ? " (demo)" : p.status === "open" ? " (current)" : ""}` })))
  picker.value = current.period
  const d = await api(`/reports/monthly?period=${current.period}`)

  const prevTotal = d.wallets.reduce((a, w) => a + (w.prev_spent || 0), 0)
  const change = prevTotal ? (d.spent - prevTotal) / prevTotal : null
  const saved = (d.closing && d.closing.swept) ? d.closing.swept.reduce((a, s) => a + s.amount, 0) : d.groups.savings.budget
  const tiles = el("div", { class: "report-hero" },
    statTile("Income", rp(d.income)),
    statTile("Spent", rp(d.spent), change === null ? null : { text: `${change >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(change * 100))}% vs last month`, cls: change > 0.05 ? "up-bad" : change < -0.05 ? "down-good" : "" }),
    statTile(d.closing ? "Moved to savings" : "Planned savings", rp(saved)),
    statTile("Receipts", `${d.receipts.attached}/${d.receipts.attached + d.receipts.waived + d.receipts.missing}`,
      { text: d.receipts.waived ? `${d.receipts.waived} without receipt` : "all with proof" }))

  // AI review
  const review = el("div")
  const showReview = (text) => review.replaceChildren(aiCard("Advisor's review", text))
  if (d.review) showReview(d.review)
  else {
    const gen = el("button", { class: "btn wide", type: "button" }, icon("spark"), "Write this month's review")
    gen.onclick = () => busy(gen, async () => {
      try { showReview((await api(`/reports/monthly/review?period=${current.period}`, { method: "POST" })).review) }
      catch (err) { review.append(el("p", { class: "form-msg", text: err.message })) }
    })
    review.append(el("div", { class: "card ai-card" }, el("div", { class: "ai-head" }, icon("spark"), "Advisor's review"),
      el("p", { class: "muted", style: { marginBottom: "12px" }, text: "A short analysis of the month with concrete changes for next month." }), gen))
  }

  // Budget vs actual (meters, sorted by % used)
  const ws = d.wallets.filter((w) => (w.budget || w.spent) && w.category.group !== "savings").sort((a, b) => b.pct - a.pct)
  const budgetVsActual = figure("Budget vs actual", "Each wallet this month; the tick marks where spending should be by today",
    el("div", {}, ws.map((w) => el("div", { class: "bva" },
      el("div", { class: "bva-top" }, el("span", { class: "bva-name", text: `${w.category.icon || ""} ${w.category.name}` }),
        el("span", { class: "bva-amt", text: `${rp(w.spent)} / ${rp(w.budget)}` })),
      meter(w.spent, w.budget, { pace: d.days_total ? (d.days_total - d.days_left) / d.days_total : null }),
      w.left < 0 ? el("div", { class: "bva-over" }, icon("alert"), w.budget ? `Over by ${rp(-w.left)}` : "No budget planned") : null))),
    table(["Wallet", "Budget", "Spent", "Left"], ws.map((w) => [w.category.name, rp(w.budget), rp(w.spent), rp(w.left)])))

  const byCat = d.wallets.filter((w) => w.spent > 0).sort((a, b) => b.spent - a.spent)
  const spending = figure("Spending by wallet", `${rp(d.spent)} in total`,
    hbars(byCat.slice(0, 10).map((w) => ({ label: w.category.name, icon: w.category.icon, value: w.spent }))),
    table(["Wallet", "Spent", "Last month"], byCat.map((w) => [w.category.name, rp(w.spent), rp(w.prev_spent || 0)])))

  const heat = figure("Spending calendar", "Daily totals; darker = quieter, brighter = bigger days", heatmap(d.days),
    table(["Day", "Spent"], d.days.map((x) => [fmtDate(x.date, { weekday: "short", day: "numeric", month: "short" }), rp(x.amount)])))

  const maxDay = d.weekday_avg.reduce((m, x, i) => (x.amount > d.weekday_avg[m].amount ? i : m), 0)
  const weekday = figure("Average by weekday", `You spend most on ${d.weekday_avg[maxDay].day}s`,
    columns(d.weekday_avg.map((x) => x.day), [{ key: "avg", label: "Average", color: "var(--s1)", values: d.weekday_avg.map((x) => x.amount) }], { height: 160, highlight: maxDay }),
    table(["Day", "Average"], d.weekday_avg.map((x) => [x.day, rp(x.amount)])))

  const notes = d.notes && d.notes.length ? el("div", { class: "section" },
    el("div", { class: "section-head" }, el("h2", { text: "Notes" }), el("span", { class: "muted small", text: `${d.notes.length} this month` })),
    el("div", { class: "list" }, d.notes.map((n) => el("div", { class: "list-item" },
      el("div", { class: "li-main" }, el("div", { class: "li-title", text: n.note }),
        el("div", { class: "li-sub", text: `${fmtDate(n.date)} · ${n.merchant || "—"}` })),
      el("div", { class: "li-amount", text: rp(n.amount) }))))) : null

  const merchants = d.top_merchants.length ? figure("Top merchants", "Where most of the money went",
    hbars(d.top_merchants.map((m) => ({ label: m.merchant, value: m.amount })), { color: "var(--s1)" }),
    table(["Merchant", "Spent"], d.top_merchants.map((m) => [m.merchant, rp(m.amount)]))) : null

  body.replaceChildren(el("div", { style: { marginBottom: "12px" } }, picker), d.demo ? demoBanner() : null, tiles,
    el("div", { class: "section" }, review),
    el("div", { class: "section" }, rule503020(d.rule_50_30_20)),
    el("div", { class: "section" }, budgetVsActual, spending, heat, weekday, merchants), notes)
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------
async function daily(body) {
  if (!current.day) current.day = todayKey()
  const d = await api(`/reports/daily?day=${current.day}&note=1`)
  const shift = (n) => {
    const t = new Date(current.day + "T12:00:00+07:00")
    t.setUTCDate(t.getUTCDate() + n)
    current.day = t.toISOString().slice(0, 10)
    body.style.opacity = 0.5
    daily(body).finally(() => { body.style.opacity = 1 })
  }
  const nav = el("div", { class: "row between", style: { marginBottom: "12px" } },
    el("button", { class: "icon-btn", type: "button", "aria-label": "Previous day", onclick: () => shift(-1) }, icon("back")),
    el("strong", { text: fmtDate(current.day, { weekday: "long", day: "numeric", month: "long" }) }),
    el("button", { class: "icon-btn", type: "button", "aria-label": "Next day", disabled: current.day >= todayKey(), onclick: () => shift(1) }, icon("chevron")))
  const vs = d.vs_pace
  const hero = el("div", { class: "card glass hero" }, el("div", { class: "grow" },
    el("div", { class: "hero-label", text: "Spent" }), el("div", { class: "hero-value", text: rp(d.total) }),
    el("div", { class: "hero-sub", text: d.daily_pace ? `Daily pace for Needs & Wants: ${rp(d.daily_pace)}${vs !== null ? ` · today ${Math.round(vs * 100)}% of it` : ""}` : "Plan your wallets to see a daily pace." })))
  const parts = [nav, d.demo ? demoBanner() : null, hero]
  if (d.note) parts.push(el("div", { class: "section" }, aiCard("Advisor", d.note)))
  if (d.by_category.length) {
    parts.push(el("div", { class: "section" }, figure("By wallet", null,
      hbars(d.by_category.map((c) => ({ label: c.category.name, icon: c.category.icon, value: c.amount }))),
      table(["Wallet", "Spent"], d.by_category.map((c) => [c.category.name, rp(c.amount)])))))
    parts.push(el("div", { class: "section" }, el("div", { class: "section-head" }, el("h2", { text: "Biggest" })),
      el("div", { class: "list" }, d.biggest.map((b) => el("div", { class: "list-item" }, el("div", { class: "li-icon", text: b.category.icon || "🧾" }),
        el("div", { class: "li-main" }, el("div", { class: "li-title", text: b.merchant || "—" }), el("div", { class: "li-sub", text: b.category.name || "" })),
        el("div", { class: "li-amount", text: rp(b.amount) }))))))
  } else {
    parts.push(el("div", { class: "empty-state" }, el("div", { class: "big", text: "🌿" }), el("h3", { text: "No confirmed spending" }),
      el("p", { text: d.pending ? `${d.pending} transaction(s) still waiting to be confirmed.` : "A quiet day." })))
  }
  if (d.pending) parts.push(el("button", { class: "banner warn", type: "button", onclick: () => go("inbox") }, icon("inbox"),
    el("div", { class: "grow" }, el("div", { class: "banner-title", text: `${d.pending} to confirm` }), el("div", { class: "banner-sub", text: "Unconfirmed spending isn't counted yet." })), icon("chevron")))
  body.replaceChildren(...parts)
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------
async function trends(body) {
  const d = await api("/reports/trends?months=6")
  if (d.periods.length < 2) {
    body.replaceChildren(el("div", { class: "empty-state" }, el("div", { class: "big", text: "📈" }), el("h3", { text: "Trends need two months" }),
      el("p", { text: "Come back after your first full budget month." })))
  }
  const labels = d.periods.map((p) => fmtDate(p.period.start, { month: "short" }) + (p.demo ? "*" : ""))
  const buckets = ["needs", "wants", "savings"]
  const series = buckets.map((b) => ({ key: b, label: GROUP_LABEL[b], color: GROUP_COLOR[b],
    values: d.periods.map((p) => Object.entries(p.groups).reduce((a, [g, v]) => a + (bucketOf(g) === b ? v : 0), 0)) }))
  const stack = figure("Spending by month", "Needs (incl. must spend), Wants and Savings wallets",
    columns(labels, series, { stacked: true, height: 200, highlight: labels.length - 1 }),
    table(["Month", "Needs", "Wants", "Savings", "Income"], d.periods.map((p, i) => [labels[i], ...series.map((s) => rp(s.values[i])), rp(p.income)])),
    legend(series.map((s) => ({ label: s.label, color: s.color }))))
  const saveRate = figure("Kept from income", "Income minus spending, each month",
    columns(labels, [{ key: "kept", label: "Kept", color: "var(--s3)", values: d.periods.map((p) => Math.max(0, p.income - p.spent)) }], { height: 150, highlight: labels.length - 1 }),
    table(["Month", "Income", "Spent", "Kept"], d.periods.map((p, i) => [labels[i], rp(p.income), rp(p.spent), rp(p.income - p.spent)])))

  // One wallet over time.
  const cats = Object.values(d.categories).filter((c) => d.periods.some((p) => p.by_category[c.id]))
  const pick = el("select", {}, cats.map((c) => el("option", { value: c.id, text: `${c.icon || ""} ${c.name}` })))
  const holder = el("div")
  const drawCat = () => {
    const id = pick.value
    const vals = d.periods.map((p) => p.by_category[id] || 0)
    holder.replaceChildren(columns(labels, [{ key: id, label: d.categories[id].name, color: "var(--s1)", values: vals }], { height: 150, highlight: labels.length - 1 }))
  }
  pick.onchange = drawCat
  const perCat = cats.length ? figure("One wallet over time", null, el("div", {}, el("div", { style: { marginBottom: "10px" } }, pick), holder)) : null
  if (cats.length) drawCat()
  const demoNote = d.periods.some((p) => p.demo) ? demoBanner("Months marked * are demo data.") : null
  if (d.periods.length >= 2) body.replaceChildren(demoNote, stack, saveRate, perCat)
  else body.append(stack)
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------
async function forecast(body) {
  const [f, m] = await Promise.all([api("/reports/forecast?note=1"), api("/reports/monthly")])
  const left = f.income - f.projected_total
  const hero = el("div", { class: "report-hero" },
    statTile("Projected month total", rp(f.projected_total), { text: `likely ${rp(f.projected_range[0])} – ${rp(f.projected_range[1])}` }),
    statTile(left >= 0 ? "Likely left over" : "Likely short", rp(Math.abs(left)), { text: `vs income ${rp(f.income)}`, cls: left < 0 ? "up-bad" : "down-good" }))
  const flexBudget = m.wallets.filter((w) => w.category.group === "needs" || w.category.group === "wants").reduce((a, w) => a + w.budget, 0)
  const chart = figure("Spending so far and projection", `Needs & Wants · average ${rp(f.daily_average)} a day`,
    burnup({ days: m.days.map((x) => ({ date: x.date, amount: x.amount })), budget: flexBudget, projection: f.projected_flexible,
      range: [Math.max(0, f.projected_flexible - (f.projected_range[1] - f.projected_total)), f.projected_flexible + (f.projected_range[1] - f.projected_total)],
      daysTotal: m.days_total, start: m.period.start }),
    table(["Day", "Spent that day"], m.days.map((x) => [fmtDate(x.date), rp(x.amount)])),
    legend([{ label: "Spent so far", color: "var(--s1)", line: true }, { label: "Even pace to budget", color: "var(--muted)", line: true }]))
  const parts = [f.demo ? demoBanner("This month is demo data, so this forecast is only a preview. Real forecasts start with October.") : null, hero]
  if (!f.enough_data) parts.push(el("div", { class: "banner info" }, icon("alert"), el("div", { class: "grow" },
    el("div", { class: "banner-title", text: "Early estimate" }), el("div", { class: "banner-sub", text: "Forecasts get reliable after about a week of confirmed spending." }))))
  if (f.note) parts.push(el("div", { class: "section" }, aiCard("Advisor", f.note)))
  parts.push(el("div", { class: "section" }, chart))
  const risky = f.wallets.filter((w) => w.runs_out || w.over_by)
  parts.push(el("div", { class: "section" }, el("div", { class: "section-head" }, el("h2", { text: "Wallets at risk" })),
    risky.length ? el("div", { class: "list" }, risky.map((w) => el("div", { class: "list-item" }, el("div", { class: "li-icon", text: w.category.icon || "•" }),
      el("div", { class: "li-main" }, el("div", { class: "li-title", text: w.category.name }),
        el("div", { class: "li-sub", text: w.runs_out ? `Runs out around ${fmtDate(w.runs_out)}` : "On track" })),
      el("div", { class: "li-right" }, el("div", { class: "li-amount", text: w.over_by ? `+${rp(w.over_by)}` : "" }), el("div", { class: "muted small", text: w.over_by ? "over, projected" : "" })))))
      : el("div", { class: "card" }, el("p", { class: "muted", text: "No wallet is projected to run out this month. 👍" }))))
  if (f.unpaid_bills.length) {
    parts.push(el("div", { class: "section" }, el("div", { class: "section-head" }, el("h2", { text: "Bills still to pay" })),
      el("div", { class: "list" }, f.unpaid_bills.map((b) => el("div", { class: "list-item" }, el("div", { class: "li-icon", text: "📅" }),
        el("div", { class: "li-main" }, el("div", { class: "li-title", text: b.name }), el("div", { class: "li-sub", text: `Due day ${b.due_day}` })),
        el("div", { class: "li-amount", text: rp(b.amount) }))))))
  }
  if (f.goals.length) {
    parts.push(el("div", { class: "section" }, el("div", { class: "section-head" }, el("h2", { text: "Goals outlook" })),
      el("div", { class: "list" }, f.goals.map((g) => el("div", { class: "wallet" },
        el("div", { class: "wallet-top" }, el("span", { class: "emoji", text: g.kind === "emergency" ? "🛟" : "🎯" }), el("span", { class: "wallet-name", text: g.name }),
          el("span", { class: "wallet-left", text: g.target ? `${Math.round((g.saved / g.target) * 100)}%` : "" })),
        meter(g.saved, g.target || 1),
        el("div", { class: "hint", text: g.months_to_go === 0 ? "Reached 🎉" : g.months_to_go ? `About ${g.months_to_go} month${g.months_to_go === 1 ? "" : "s"} to go at ${rp(g.monthly_rate)}/month${g.target_date ? ` (target ${fmtDate(g.target_date, { month: "short", year: "numeric" })})` : ""}` : "Needs a month of savings history for an estimate." }))))))
  }
  body.replaceChildren(...parts)
}
