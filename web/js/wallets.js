import { api, armed, busy, el, fmtDate, icon, markdown, moneyInput, rp, sheet, todayKey, toast } from "./lib.js?v=__VERSION__"
import { meter } from "./charts.js?v=__VERSION__"
import { walletRow } from "./home.js?v=__VERSION__"
import { route } from "./app.js?v=__VERSION__"

const GROUPS = [["must", "Must spend"], ["needs", "Needs"], ["wants", "Wants"], ["savings", "Savings"]]

export async function renderWallets(page, sub) {
  const s = await api("/summary")
  const fraction = s.days_total ? (s.days_total - s.days_left) / s.days_total : 0

  const actions = el("div", { class: "chips", style: { marginBottom: "12px" } },
    chip("Plan wallets", "wallet", () => planSheet(s)),
    chip("Income", "calendar", () => incomeSheet(s)),
    chip("Move money", "move", () => moveSheet(s)),
    chip("Bills", "receipt", () => billsSheet()),
    chip("Goals", "target", () => goalsSheet()))

  const status = s.to_assign === 0 && s.income
    ? el("div", { class: "banner info" }, icon("check"), el("div", { class: "grow" }, el("div", { class: "banner-title", text: "Every rupiah has a job" }),
      el("div", { class: "banner-sub", text: `${rp(s.income)} income fully assigned.` })))
    : el("button", { class: `banner ${s.to_assign < 0 ? "danger" : "warn"}`, type: "button", onclick: () => s.income ? planSheet(s) : incomeSheet(s) },
      icon(s.income ? "wallet" : "calendar"), el("div", { class: "grow" },
        el("div", { class: "banner-title", text: !s.income ? "Enter this month's income" : s.to_assign > 0 ? `${rp(s.to_assign)} left to assign` : `Over-assigned by ${rp(-s.to_assign)}` }),
        el("div", { class: "banner-sub", text: !s.income ? "Then give every rupiah a job." : "Tap to plan your wallets." })), icon("chevron"))

  const lists = []
  for (const [g, label] of GROUPS) {
    const ws = s.wallets.filter((w) => w.category.group === g && (w.budget || w.spent))
    if (!ws.length) continue
    const budget = ws.reduce((a, w) => a + w.budget, 0), spent = ws.reduce((a, w) => a + w.spent, 0)
    lists.push(el("div", { class: "section" },
      el("div", { class: "section-head" }, el("h2", { text: label }), el("span", { class: "muted small", text: `${rp(spent)} of ${rp(budget)}` })),
      el("div", { class: "list" }, ws.map((w) => walletRow(w, fraction, () => walletSheet(w, s))))))
  }
  if (!lists.length) {
    lists.push(el("div", { class: "empty-state" }, el("div", { class: "big", text: "👛" }), el("h3", { text: "No wallets planned yet" }),
      el("p", { text: "Enter income, then plan how it's split." })))
  }

  page.replaceChildren(
    el("div", { class: "topbar" }, el("div", {}, el("h1", { text: "Wallets" }),
      el("div", { class: "sub", text: `${fmtDate(s.period.start)} – ${fmtDate(s.period.end)} · ${s.days_left} days left` }))),
    actions, status, ...lists)

  if (sub === "plan") planSheet(s)
  else if (sub === "income") incomeSheet(s)
  else if (sub === "bills") billsSheet()
  else if (sub === "goals") goalsSheet()
}

function chip(label, ic, onclick) {
  return el("button", { class: "chip", type: "button", onclick }, icon(ic), label)
}

// ---------------------------------------------------------------------------
// Wallet detail
// ---------------------------------------------------------------------------
async function walletSheet(w, s) {
  const sh = sheet(`${w.category.icon || ""} ${w.category.name}`.trim())
  sh.body.append(el("div", { class: "card" },
    el("div", { class: "row between" }, el("span", { class: "muted", text: "Left this month" }),
      el("strong", { class: w.left < 0 ? "wallet-left neg" : "", text: rp(w.left) })),
    meter(w.spent, w.budget, { pace: w.category.group === "savings" ? null : (s.days_total - s.days_left) / s.days_total }),
    el("dl", { class: "kv", style: { marginTop: "12px" } },
      el("dt", { text: "Planned" }), el("dd", { text: rp(w.allocated) }),
      w.moved ? el("dt", { text: "Moved in/out" }) : null, w.moved ? el("dd", { text: rp(w.moved) }) : null,
      el("dt", { text: "Spent" }), el("dd", { text: rp(w.spent) }),
      w.pace ? el("dt", { text: "Pace" }) : null, w.pace ? el("dd", { text: w.pace > 1.1 ? `Faster than the month (${w.pace}×)` : w.pace < 0.9 ? "Slower than the month" : "On pace" }) : null)))
  if (w.left < 0) {
    sh.body.append(el("button", { class: "btn primary wide", type: "button", style: { marginTop: "12px" }, onclick: () => { sh.close(); moveSheet(s, w.category.id, -w.left) } },
      icon("move"), `Cover ${rp(-w.left)} from another wallet`))
  }
  const tx = await api(`/transactions?status=confirmed&period=${s.period.id}`)
  const mine = tx.items.filter((t) => (t.splits || []).some((sp) => sp.category === w.category.id))
  sh.body.append(el("div", { class: "day-head", text: "Spending this month" }),
    mine.length ? el("div", { class: "list" }, mine.map((t) => {
      const amt = t.splits.filter((sp) => sp.category === w.category.id).reduce((a, sp) => a + sp.amount, 0)
      return el("div", { class: "list-item" }, el("div", { class: "li-main" }, el("div", { class: "li-title", text: t.merchant || t.description || "—" }),
        el("div", { class: "li-sub", text: fmtDate(t.occurred_at) })), el("div", { class: "li-amount", text: rp(amt) }))
    })) : el("p", { class: "muted", text: "Nothing yet." }))
}

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------
function incomeSheet(s) {
  const sh = sheet("Income this month")
  const list = el("div", { class: "list" }, s.incomes.length ? s.incomes.map((i) => {
    const del = el("button", { class: "icon-btn", type: "button", "aria-label": "Remove" }, icon("trash"))
    armed(del, "?", async () => { await api(`/incomes/${i.id}`, { method: "DELETE" }); sh.close(); toast("Removed"); route() })
    return el("div", { class: "list-item" }, el("div", { class: "li-icon", text: "💰" }),
      el("div", { class: "li-main" }, el("div", { class: "li-title", text: i.source }), el("div", { class: "li-sub", text: `${fmtDate(i.date)}${i.created_by ? " · " + i.created_by : ""}` })),
      el("div", { class: "li-amount", text: rp(i.amount) }), del)
  }) : el("div", { class: "empty-state" }, el("p", { text: "No income entered yet." })))
  const amount = moneyInput(0, { placeholder: "0" })
  const source = el("input", { placeholder: "e.g. Salary Bashir", maxlength: 120 })
  const date = el("input", { type: "date", value: todayKey() })
  const msg = el("p", { class: "form-msg" })
  const add = el("button", { class: "btn primary wide", type: "submit", text: "Add income" })
  const form = el("form", {},
    el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
    el("label", { class: "field" }, el("span", { text: "Source" }), source),
    el("label", { class: "field" }, el("span", { text: "Date received" }), date), msg, add)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    busy(add, async () => {
      if (!amount.money() || !source.value.trim()) { msg.textContent = "Enter the amount and source."; return }
      try {
        await api("/incomes", { method: "POST", json: { amount: amount.money(), source: source.value.trim(), date: date.value } })
        sh.close()
        toast("Income added", "good")
        await route()
      } catch (err) { msg.textContent = err.message }
    })
  })
  sh.body.append(el("p", { class: "muted", style: { marginBottom: "12px" }, text: `Total ${rp(s.income)}` }), list,
    el("div", { class: "day-head", text: "Add income" }), form)
}

// ---------------------------------------------------------------------------
// Plan (zero-based allocation), with the AI advisor's suggestion
// ---------------------------------------------------------------------------
export async function planSheet(s, { onSaved } = {}) {
  const sh = sheet("Plan wallets", { tall: true })
  const cats = (await api("/categories")).categories
  const current = Object.fromEntries(s.wallets.map((w) => [w.category.id, w.allocated]))
  const inputs = {}
  const leftBar = el("div", { class: "banner assign-bar" })
  const update = () => {
    const assigned = Object.values(inputs).reduce((a, i) => a + i.money(), 0)
    const left = s.income - assigned
    leftBar.className = `banner assign-bar ${left === 0 ? "info" : left < 0 ? "danger" : "warn"}`
    leftBar.replaceChildren(icon(left === 0 ? "check" : "wallet"), el("div", { class: "grow" },
      el("div", { class: "banner-title", text: left === 0 ? "Rp0 left to assign 🎉" : left > 0 ? `${rp(left)} left to assign` : `${rp(-left)} over your income` }),
      el("div", { class: "banner-sub", text: `Income ${rp(s.income)} · assigned ${rp(assigned)}` })))
  }
  const groups = el("div")
  for (const [g, label] of GROUPS) {
    const cs = cats.filter((c) => c.group === g)
    if (!cs.length) continue
    groups.append(el("div", { class: "group-head" }, el("span", { text: label })))
    groups.append(el("div", { class: "list" }, cs.map((c) => {
      const inp = moneyInput(current[c.id] || 0, { placeholder: "0", "aria-label": c.name })
      inp.addEventListener("input", update)
      inputs[c.id] = inp
      return el("div", { class: "alloc-row" }, el("span", { class: "emoji", text: c.icon || "•" }),
        el("span", { class: "grow", style: { fontWeight: 600 }, text: c.name }), el("div", { class: "money-wrap" }, inp))
    })))
  }
  const aiBox = el("div", { class: "card ai-card", hidden: true })
  const suggest = el("button", { class: "btn wide", type: "button" }, icon("spark"), "Ask the advisor for a plan")
  suggest.onclick = () => busy(suggest, async () => {
    aiBox.hidden = false
    aiBox.replaceChildren(el("div", { class: "ai-head" }, icon("spark"), "Advisor"), el("p", { class: "muted", text: "Thinking about your income, bills, goals and history… (up to a minute)" }))
    try {
      const plan = await api(`/allocations/suggest?period=${s.period.id}`, { method: "POST" })
      for (const inp of Object.values(inputs)) inp.setMoney(0)
      for (const a of plan.allocations) if (inputs[a.category_id]) inputs[a.category_id].setMoney(a.amount)
      update()
      aiBox.replaceChildren(el("div", { class: "ai-head" }, icon("spark"), "Advisor's plan (filled in below, adjust freely)"), markdown(plan.summary))
    } catch (err) {
      aiBox.replaceChildren(el("p", { class: "form-msg", text: err.message }))
    }
  })
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button" }, icon("check"), "Save plan")
  save.onclick = () => busy(save, async () => {
    try {
      await api("/allocations", { method: "PUT", json: { period: s.period.id,
        allocations: Object.entries(inputs).map(([category, i]) => ({ category, amount: i.money() })) } })
      sh.close()
      toast("Plan saved", "good")
      if (onSaved) onSaved()
      else await route()
    } catch (err) { msg.textContent = err.message }
  })
  if (!s.income) sh.body.append(el("div", { class: "banner warn" }, icon("alert"), el("div", { class: "grow" }, el("div", { class: "banner-title", text: "No income entered yet" }),
    el("div", { class: "banner-sub", text: "Add this month's income first, so the plan can add up." }))))
  sh.body.append(leftBar, suggest, aiBox, groups, el("div", { class: "sticky-actions" }, msg, save))
  update()
}

// ---------------------------------------------------------------------------
// Move money between wallets
// ---------------------------------------------------------------------------
function moveSheet(s, toId = "", amountDefault = 0) {
  const sh = sheet("Move money")
  const opts = (sel) => {
    for (const [g, label] of GROUPS) {
      const og = el("optgroup", { label })
      for (const w of s.wallets.filter((w) => w.category.group === g)) og.append(el("option", { value: w.category.id, text: `${w.category.icon || ""} ${w.category.name} (${rp(w.left)} left)` }))
      if (og.children.length) sel.append(og)
    }
    return sel
  }
  const from = opts(el("select", {}, el("option", { value: "", text: "From…" })))
  const to = opts(el("select", {}, el("option", { value: "", text: "To…" })))
  to.value = toId
  const amount = moneyInput(amountDefault)
  const note = el("input", { placeholder: "Why (optional)", maxlength: 300 })
  const msg = el("p", { class: "form-msg" })
  const go_ = el("button", { class: "btn primary wide", type: "button" }, icon("move"), "Move")
  go_.onclick = () => busy(go_, async () => {
    try {
      await api("/moves", { method: "POST", json: { period: s.period.id, from_category: from.value, to_category: to.value, amount: amount.money(), note: note.value } })
      sh.close()
      toast("Moved", "good")
      await route()
    } catch (err) { msg.textContent = err.message }
  })
  sh.body.append(el("p", { class: "muted", style: { marginBottom: "12px" }, text: "Cover overspending, or shift money when plans change. Totals stay the same." }),
    el("label", { class: "field" }, el("span", { text: "From" }), from),
    el("label", { class: "field" }, el("span", { text: "To" }), to),
    el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
    el("label", { class: "field" }, el("span", { text: "Note" }), note), msg, go_)
}

// ---------------------------------------------------------------------------
// Bills (must spend)
// ---------------------------------------------------------------------------
export async function billsSheet() {
  const sh = sheet("Must-spend bills", { tall: true })
  const render = async () => {
    const [{ bills }, { categories }] = await Promise.all([api("/bills"), api("/categories")])
    const list = el("div", { class: "list" }, bills.length ? bills.map((b) => {
      const cat = categories.find((c) => c.id === b.category)
      const paidBtn = el("button", { class: `pill ${b.paid ? "ok" : "warn"}`, type: "button", text: b.paid ? "Paid ✓" : "Unpaid" })
      paidBtn.onclick = async (e) => { e.stopPropagation(); await api(`/bills/${b.id}/paid`, { method: "POST", json: { paid: !b.paid } }); render() }
      return el("button", { class: "list-item", type: "button", onclick: () => billForm(b, categories, render) },
        el("div", { class: "li-icon", text: (cat && cat.icon) || "📅" }),
        el("div", { class: "li-main" }, el("div", { class: "li-title", text: b.name }), el("div", { class: "li-sub", text: `Due day ${b.due_day} · ${cat ? cat.name : ""}${b.active ? "" : " · paused"}` })),
        el("div", { class: "li-right" }, el("div", { class: "li-amount", text: rp(b.amount) }), paidBtn))
    }) : el("div", { class: "empty-state" }, el("p", { text: "Add rent, electricity, installments, insurance…" })))
    sh.body.replaceChildren(el("p", { class: "muted", style: { marginBottom: "12px" },
      text: "Fixed monthly obligations. Planned first, reminded 3 days before they're due, and marked paid automatically when a matching payment is confirmed." }),
      list, el("button", { class: "btn wide", type: "button", style: { marginTop: "12px" }, onclick: () => billForm(null, categories, render) }, icon("plus"), "Add bill"))
  }
  await render()
}

function billForm(b, categories, done) {
  const sh = sheet(b ? "Edit bill" : "New bill")
  const name = el("input", { value: b ? b.name : "", maxlength: 120, placeholder: "e.g. Apartment rent" })
  const cat = el("select", {}, categories.filter((c) => c.group === "must" || c.group === "needs").map((c) => el("option", { value: c.id, text: `${c.icon || ""} ${c.name}` })))
  if (b) cat.value = b.category
  const amount = moneyInput(b ? b.amount : 0)
  const day = el("input", { type: "number", min: 1, max: 31, value: b ? b.due_day : 1, inputmode: "numeric" })
  const hint = el("input", { value: b ? b.match_hint : "", maxlength: 200, placeholder: "e.g. PLN (text in the payment's merchant)" })
  const active = el("input", { type: "checkbox", checked: b ? b.active : true })
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Save" })
  save.onclick = () => busy(save, async () => {
    const body = { name: name.value.trim(), category: cat.value, amount: amount.money(), due_day: Number(day.value), active: active.checked, match_hint: hint.value.trim() }
    try {
      await api(b ? `/bills/${b.id}` : "/bills", { method: b ? "PATCH" : "POST", json: body })
      sh.close()
      done()
    } catch (err) { msg.textContent = err.message }
  })
  sh.body.append(el("label", { class: "field" }, el("span", { text: "Name" }), name),
    el("label", { class: "field" }, el("span", { text: "Wallet" }), cat),
    el("div", { class: "row" }, el("label", { class: "field grow" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
      el("label", { class: "field", style: { width: "96px" } }, el("span", { text: "Due day" }), day)),
    el("label", { class: "field" }, el("span", { text: "Recognise payment by (optional)" }), hint),
    el("div", { class: "toggle" }, el("span", { text: "Active" }), el("label", { class: "switch" }, active, el("span"))), msg, save)
  if (b) {
    const del = el("button", { class: "btn wide danger", type: "button", style: { marginTop: "8px" }, text: "Delete bill" })
    sh.body.append(armed(del, "Tap again to delete", async () => { await api(`/bills/${b.id}`, { method: "DELETE" }); sh.close(); done() }))
  }
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------
export async function goalsSheet() {
  const sh = sheet("Goals", { tall: true })
  const render = async () => {
    const [{ goals }, fc] = await Promise.all([api("/goals"), api("/reports/forecast").catch(() => ({ goals: [] }))])
    const eta = Object.fromEntries((fc.goals || []).map((g) => [g.id, g]))
    const cards = goals.map((g) => {
      const p = g.target ? Math.min(1, g.saved / g.target) : 0
      const e = eta[g.id]
      const when = e && e.months_to_go ? `about ${e.months_to_go} month${e.months_to_go === 1 ? "" : "s"} to go at ${rp(e.monthly_rate)}/month` : e && e.months_to_go === 0 ? "Reached 🎉" : "Not enough history for an estimate yet"
      return el("button", { class: "wallet", type: "button", onclick: () => goalForm(g, render) },
        el("div", { class: "wallet-top" }, el("span", { class: "emoji", text: g.kind === "emergency" ? "🛟" : "🎯" }),
          el("span", { class: "wallet-name", text: g.name }), el("span", { class: "wallet-left", text: `${Math.round(p * 100)}%` })),
        meter(g.saved, g.target || 1),
        el("div", { class: "wallet-sub" }, el("span", { text: `${rp(g.saved)} of ${rp(g.target)}` }), el("span", { text: g.target_date ? `by ${fmtDate(g.target_date, { month: "short", year: "numeric" })}` : "" })),
        el("div", { class: "hint", text: when }))
    })
    const hasEmergency = goals.some((g) => g.kind === "emergency")
    sh.body.replaceChildren(el("p", { class: "muted", style: { marginBottom: "12px" },
      text: "At the end of each budget month, leftovers go to the emergency fund until it's full, then to your goals in order." }),
      el("div", { class: "list" }, cards.length ? cards : el("div", { class: "empty-state" }, el("p", { text: "No goals yet." }))),
      el("div", { class: "row", style: { marginTop: "12px" } },
        hasEmergency ? null : el("button", { class: "btn grow", type: "button", onclick: () => goalForm({ kind: "emergency", name: "Emergency fund", target: 0, saved: 0 }, render, true) }, "🛟 Emergency fund"),
        el("button", { class: "btn grow", type: "button", onclick: () => goalForm({ kind: "custom", name: "", target: 0, saved: 0 }, render, true) }, icon("plus"), "Goal")))
  }
  await render()
}

function goalForm(g, done, isNew = false) {
  const sh = sheet(isNew ? "New goal" : g.name)
  const name = el("input", { value: g.name, maxlength: 120, placeholder: "e.g. House down payment" })
  const target = moneyInput(g.target)
  const date = el("input", { type: "date", value: g.target_date || "" })
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Save" })
  save.onclick = () => busy(save, async () => {
    try {
      const body = { kind: g.kind, name: name.value.trim(), target: target.money(), target_date: date.value || "" }
      await api(isNew ? "/goals" : `/goals/${g.id}`, { method: isNew ? "POST" : "PATCH", json: body })
      sh.close()
      done()
    } catch (err) { msg.textContent = err.message }
  })
  sh.body.append(
    g.kind === "emergency" ? el("p", { class: "hint", style: { marginBottom: "12px" }, text: "Common guidance: 3–6 months of must-spend + needs (6 if you have one income or dependants)." }) : null,
    el("label", { class: "field" }, el("span", { text: "Name" }), name),
    el("label", { class: "field" }, el("span", { text: "Target" }), el("div", { class: "money-wrap" }, target)),
    el("label", { class: "field" }, el("span", { text: "Target date (optional)" }), date), msg, save)
  if (!isNew) {
    const amt = moneyInput(0)
    const add = el("button", { class: "btn small", type: "button", text: "Add" })
    const take = el("button", { class: "btn small", type: "button", text: "Withdraw" })
    const move = (sign, btn) => busy(btn, async () => {
      try { await api(`/goals/${g.id}/move`, { method: "POST", json: { amount: sign * amt.money(), note: sign > 0 ? "Added by hand" : "Withdrawn" } }); sh.close(); toast("Updated", "good"); done() }
      catch (err) { msg.textContent = err.message }
    })
    add.onclick = () => move(1, add)
    take.onclick = () => move(-1, take)
    const del = el("button", { class: "btn wide danger", type: "button", style: { marginTop: "8px" }, text: "Archive goal" })
    sh.body.append(el("div", { class: "day-head", text: `Saved: ${rp(g.saved)}` }),
      el("div", { class: "row" }, el("div", { class: "money-wrap grow" }, amt), add, take),
      armed(del, "Tap again to archive", async () => { await api(`/goals/${g.id}`, { method: "DELETE" }); sh.close(); done() }))
  }
}
