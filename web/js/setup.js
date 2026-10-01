import { api, busy, el, icon, moneyInput, rp, todayKey, toast } from "./lib.js?v=__VERSION__"
import { enablePush, go, registerPasskey } from "./app.js?v=__VERSION__"
import { planSheet } from "./wallets.js?v=__VERSION__"

const STEPS = ["profile", "cycle", "categories", "bills", "goals", "income", "plan", "device"]
const GROUPS = [["must", "Must spend"], ["needs", "Needs"], ["wants", "Wants"], ["savings", "Savings"]]

export async function renderSetup(root, step) {
  step = STEPS.includes(step) ? step : "profile"
  const i = STEPS.indexOf(step)
  const next = () => go(`setup/${STEPS[i + 1]}`)
  const back = i ? el("button", { class: "icon-btn", type: "button", "aria-label": "Back", onclick: () => go(`setup/${STEPS[i - 1]}`) }, icon("back")) : el("span")
  const skip = el("button", { class: "link-btn", type: "button", text: "Skip", onclick: next })
  const header = el("div", {},
    el("div", { class: "row between" }, back, el("span", { class: "muted small", text: `Step ${i + 1} of ${STEPS.length}` }), step === "device" ? el("span") : skip),
    el("div", { class: "steps" }, STEPS.map((_, j) => el("span", { class: j <= i ? "done" : "" }))))
  const body = el("div")
  root.replaceChildren(header, body)
  await ({ profile, cycle, categories, bills, goals, income, plan, device })[step](body, next)
  const sv = document.getElementById("setupView"); if (sv) sv.scrollTop = 0
}

function title(t, lead) {
  return [el("h1", { class: "setup-title", text: t }), el("p", { class: "setup-lead", text: lead })]
}

// ---- 1. Profile -----------------------------------------------------------
async function profile(body, next) {
  const { profile: p } = await api("/profile")
  const f = (key, label, placeholder, area = true) => {
    const input = el(area ? "textarea" : "input", { placeholder, maxlength: 1000 })
    input.value = p[key] || ""
    input.dataset.key = key
    return el("label", { class: "field" }, el("span", { text: label }), input)
  }
  const fields = [
    f("household", "Your household", "e.g. Married couple, one child (2 y.o.), renting an apartment"),
    f("city", "City", "e.g. South Jakarta", false),
    f("work", "Work & income", "e.g. Both employed; salaries on the 25th"),
    f("values", "Values & obligations", "e.g. Muslim; zakat 2.5%; avoid interest-based debt"),
    f("priorities", "Money priorities", "e.g. Emergency fund first, then a house down payment by 2028"),
  ]
  const names = el("input", { placeholder: "e.g. Muhammad Syauqi Al Bashir, Bella", maxlength: 300, value: (p.names || []).join(", ") })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Continue" })
  save.onclick = () => busy(save, async () => {
    const data = { ...p }
    for (const w of fields) { const i = w.querySelector("[data-key]"); data[i.dataset.key] = i.value.trim() }
    data.names = names.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6)
    await api("/profile", { method: "PUT", json: data })
    next()
  })
  body.append(...title("Tell the advisor about you", "This context shapes the AI's category and budget suggestions. You can change it any time."),
    ...fields, el("label", { class: "field" }, el("span", { text: "Your full names (hidden from the AI)" }), names,
      el("p", { class: "hint", text: "Masked in bank emails before the AI sees them, and used to spot transfers between your own accounts." })), save)
}

// ---- 2. Cycle -------------------------------------------------------------
async function cycle(body, next) {
  const { start_day } = await api("/settings/cycle")
  const day = el("input", { type: "number", min: 1, max: 31, value: start_day, inputmode: "numeric" })
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Continue" })
  save.onclick = () => busy(save, async () => {
    try { await api("/settings/cycle", { method: "PUT", json: { start_day: Number(day.value) } }); next() }
    catch (err) { msg.textContent = err.message }
  })
  body.append(...title("When does your month start?", "Usually payday. The budget month runs from this day to the day before it next month."),
    el("label", { class: "field" }, el("span", { text: "Start day (1–31)" }), day), msg, save)
}

// ---- 3. Categories --------------------------------------------------------
async function categories(body, next) {
  const { categories: existing } = await api("/categories")
  const rows = el("div")
  const addRow = (c = { icon: "🏷️", name: "", group: "needs", hints: "" }) => {
    const ic = el("input", { class: "emoji-input", value: c.icon || "🏷️", maxlength: 4, "aria-label": "Icon" })
    const name = el("input", { value: c.name, maxlength: 60, placeholder: "Name" })
    const group = el("select", {}, GROUPS.map(([g, l]) => el("option", { value: g, text: l })))
    group.value = c.group
    const rm = el("button", { class: "icon-btn", type: "button", "aria-label": "Remove" }, icon("x"))
    const row = el("div", { class: "cat-edit" }, ic, name, group, rm)
    row._get = () => ({ icon: ic.value.trim(), name: name.value.trim(), group: group.value, hints: c.hints || "" })
    rm.onclick = () => row.remove()
    rows.append(row)
  }
  const aiNote = el("div", { class: "card ai-card", hidden: true })
  const suggest = el("button", { class: "btn wide", type: "button" }, icon("spark"), existing.length ? "Suggest more with AI" : "Suggest categories with AI")
  suggest.onclick = () => busy(suggest, async () => {
    try {
      const out = await api("/categories/suggest", { method: "POST" })
      const have = new Set([...rows.children].map((r) => r._get().name.toLowerCase()).concat(existing.map((c) => c.name.toLowerCase())))
      for (const c of out.categories) if (!have.has(c.name.toLowerCase())) addRow(c)
      if (out.note) { aiNote.hidden = false; aiNote.replaceChildren(el("div", { class: "ai-head" }, icon("spark"), "Advisor"), el("p", { text: out.note })) }
    } catch (err) { toast(err.message, "bad") }
  })
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Save and continue" })
  save.onclick = () => busy(save, async () => {
    const cats = [...rows.children].map((r) => r._get()).filter((c) => c.name)
    try {
      if (cats.length) await api("/categories/bulk", { method: "POST", json: { categories: cats } })
      if (!existing.length && !cats.length) { msg.textContent = "Add at least a few categories (or let the AI suggest them)."; return }
      next()
    } catch (err) { msg.textContent = err.message }
  })
  body.append(...title("Your wallets", "Each category is an envelope you fill every month. Must spend = fixed bills, Needs = essentials, Wants = lifestyle, Savings = goals."))
  if (existing.length) {
    body.append(el("div", { class: "card", style: { marginBottom: "12px" } }, el("div", { class: "card-title", text: `You have ${existing.length}` }),
      el("p", { class: "muted", text: existing.map((c) => `${c.icon || ""} ${c.name}`).join(" · ") })))
  }
  body.append(suggest, aiNote, el("div", { style: { marginTop: "12px" } }, rows),
    el("button", { class: "btn small", type: "button", style: { margin: "4px 0 16px" }, onclick: () => addRow() }, icon("plus"), "Add row"), msg, save)
  if (!existing.length) suggest.click()
}

// ---- 4. Bills -------------------------------------------------------------
async function bills(body, next) {
  const [{ bills: list }, { categories: cats }] = await Promise.all([api("/bills"), api("/categories")])
  const listBox = el("div", { class: "list", style: { marginBottom: "12px" } }, list.length ? list.map((b) => el("div", { class: "list-item" },
    el("div", { class: "li-main" }, el("div", { class: "li-title", text: b.name }), el("div", { class: "li-sub", text: `Due day ${b.due_day}` })),
    el("div", { class: "li-amount", text: rp(b.amount) }))) : el("div", { class: "empty-state" }, el("p", { text: "No bills yet." })))
  const name = el("input", { placeholder: "e.g. Rent, PLN electricity, Car installment", maxlength: 120 })
  const cat = el("select", {}, cats.filter((c) => c.group === "must" || c.group === "needs").map((c) => el("option", { value: c.id, text: `${c.icon || ""} ${c.name}` })))
  const amount = moneyInput(0)
  const day = el("input", { type: "number", min: 1, max: 31, value: 1, inputmode: "numeric" })
  const msg = el("p", { class: "form-msg" })
  const add = el("button", { class: "btn wide", type: "button" }, icon("plus"), "Add bill")
  add.onclick = () => busy(add, async () => {
    try {
      await api("/bills", { method: "POST", json: { name: name.value.trim(), category: cat.value, amount: amount.money(), due_day: Number(day.value), active: true, match_hint: "" } })
      renderSetup(document.querySelector("#setupView"), "bills")
    } catch (err) { msg.textContent = err.message }
  })
  body.append(...title("Must-spend bills", "Fixed monthly costs you can't skip. They're planned first and you'll get a reminder 3 days before each is due."),
    listBox, el("div", { class: "card" },
      el("label", { class: "field" }, el("span", { text: "Bill" }), name),
      el("label", { class: "field" }, el("span", { text: "Wallet" }), cat),
      el("div", { class: "row" }, el("label", { class: "field grow" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
        el("label", { class: "field", style: { width: "96px" } }, el("span", { text: "Due day" }), day)), msg, add),
    el("button", { class: "btn primary wide", type: "button", style: { marginTop: "16px" }, onclick: next, text: "Continue" }))
}

// ---- 5. Goals -------------------------------------------------------------
async function goals(body, next) {
  const { goals: list } = await api("/goals")
  const { bills: billList } = await api("/bills")
  const monthlyMust = billList.reduce((a, b) => a + (b.amount || 0), 0)
  const hasEmergency = list.some((g) => g.kind === "emergency")
  const target = moneyInput(hasEmergency ? list.find((g) => g.kind === "emergency").target : monthlyMust * 6)
  const gName = el("input", { placeholder: "e.g. House down payment", maxlength: 120 })
  const gTarget = moneyInput(0)
  const gDate = el("input", { type: "date" })
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Continue" })
  save.onclick = () => busy(save, async () => {
    try {
      if (!hasEmergency && target.money()) await api("/goals", { method: "POST", json: { kind: "emergency", name: "Emergency fund", target: target.money(), target_date: "" } })
      if (gName.value.trim()) await api("/goals", { method: "POST", json: { kind: "custom", name: gName.value.trim(), target: gTarget.money(), target_date: gDate.value || "" } })
      next()
    } catch (err) { msg.textContent = err.message }
  })
  body.append(...title("Savings goals", "Month-end leftovers go to the emergency fund until it's full, then to your goals."),
    el("div", { class: "card" }, el("div", { class: "card-title", text: "🛟 Emergency fund" }),
      hasEmergency ? el("p", { text: `Already set: target ${rp(list.find((g) => g.kind === "emergency").target)}` }) :
        el("div", {}, el("div", { class: "money-wrap" }, target),
          el("p", { class: "hint", text: monthlyMust ? `Suggested: 6 × your must-spend bills (${rp(monthlyMust)}/month). Add more if needs are large.` : "Guidance: 3–6 months of must-spend + needs." }))),
    el("div", { class: "card" }, el("div", { class: "card-title", text: "🎯 Another goal (optional)" }),
      el("label", { class: "field" }, el("span", { text: "Name" }), gName),
      el("div", { class: "row" }, el("label", { class: "field grow" }, el("span", { text: "Target" }), el("div", { class: "money-wrap" }, gTarget)),
        el("label", { class: "field grow" }, el("span", { text: "By (optional)" }), gDate))),
    msg, save)
}

// ---- 6. Income ------------------------------------------------------------
async function income(body, next) {
  const s = await api("/summary")
  const amount = moneyInput(0)
  const source = el("input", { placeholder: "e.g. Salary Bashir", maxlength: 120 })
  const date = el("input", { type: "date", value: todayKey() })
  const msg = el("p", { class: "form-msg" })
  const add = el("button", { class: "btn wide", type: "button" }, icon("plus"), "Add income")
  add.onclick = () => busy(add, async () => {
    try {
      await api("/incomes", { method: "POST", json: { amount: amount.money(), source: source.value.trim(), date: date.value } })
      renderSetup(document.querySelector("#setupView"), "income")
    } catch (err) { msg.textContent = err.message }
  })
  body.append(...title("This month's income", `Budget month ${s.period.start} → ${s.period.end}. Enter each salary or income you received (or will receive) this month.`),
    s.incomes.length ? el("div", { class: "list", style: { marginBottom: "12px" } }, s.incomes.map((i) => el("div", { class: "list-item" },
      el("div", { class: "li-main" }, el("div", { class: "li-title", text: i.source })), el("div", { class: "li-amount", text: rp(i.amount) })))) : null,
    el("div", { class: "card" },
      el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
      el("label", { class: "field" }, el("span", { text: "Source" }), source),
      el("label", { class: "field" }, el("span", { text: "Date" }), date), msg, add),
    el("button", { class: "btn primary wide", type: "button", style: { marginTop: "16px" }, onclick: next, text: `Continue${s.income ? ` with ${rp(s.income)}` : ""}` }))
}

// ---- 7. Plan --------------------------------------------------------------
async function plan(body, next) {
  const s = await api("/summary")
  const open = el("button", { class: "btn primary wide", type: "button" }, icon("wallet"), "Plan my wallets")
  open.onclick = () => planSheet(s, { onSaved: next })
  body.append(...title("Give every rupiah a job", "The advisor proposes amounts from your income, bills, goals and profile. Adjust until there's Rp0 left to assign."),
    el("div", { class: "card glass hero" }, el("div", {}, el("div", { class: "hero-label", text: "Income to assign" }), el("div", { class: "hero-value", text: rp(s.income) }))),
    el("div", { style: { marginTop: "16px" } }, open))
}

// ---- 8. Device ------------------------------------------------------------
async function device(body) {
  const pushBtn = el("button", { class: "btn wide", type: "button" }, icon("bell"), "Turn on notifications")
  pushBtn.onclick = () => busy(pushBtn, async () => {
    try { await enablePush(); await api("/push/test", { method: "POST" }); pushBtn.replaceChildren(icon("check"), "Notifications on") }
    catch (err) { toast(err.message, "bad") }
  })
  const faceBtn = el("button", { class: "btn wide", type: "button" }, icon("face"), "Set up Face ID lock")
  faceBtn.onclick = () => busy(faceBtn, async () => {
    try { await registerPasskey(); faceBtn.replaceChildren(icon("check"), "Face ID set up") }
    catch (err) { toast(err.name === "NotAllowedError" ? "Cancelled" : err.message, "bad") }
  })
  const finish = el("button", { class: "btn primary wide", type: "button", text: "Finish" })
  finish.onclick = () => busy(finish, async () => { await api("/setup/done", { method: "POST" }); toast("All set! 🎉", "good"); go("home") })
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone
  body.append(...title("This phone", "Notifications tell you about new transactions, wallets running low, bills and reports. Face ID keeps the app locked when you're away."),
    standalone ? null : el("div", { class: "banner warn" }, icon("alert"), el("div", { class: "grow" },
      el("div", { class: "banner-title", text: "Install the app first" }),
      el("div", { class: "banner-sub", text: "In Safari: Share → Add to Home Screen, then open it from the icon. iPhone only sends notifications to installed apps." }))),
    el("div", { class: "stack-v", style: { margin: "14px 0" } }, pushBtn, faceBtn), finish)
}
