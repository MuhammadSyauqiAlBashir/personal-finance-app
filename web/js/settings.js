import { api, armed, busy, el, fmtDate, icon, moneyInput, relTime, sheet, toast } from "./lib.js?v=__VERSION__"
import { enablePush, go, pushStatus, registerPasskey, route, state } from "./app.js?v=__VERSION__"
import { billsSheet, goalsSheet } from "./wallets.js?v=__VERSION__"

const GROUPS = [["must", "Must spend"], ["needs", "Needs"], ["wants", "Wants"], ["savings", "Savings"]]

function item(ic, title, sub, onclick) {
  return el("button", { class: "list-item", type: "button", onclick },
    el("div", { class: "li-icon" }, /^[a-z]+$/.test(ic) ? icon(ic) : ic),
    el("div", { class: "li-main" }, el("div", { class: "li-title", text: title }), sub ? el("div", { class: "li-sub", text: sub }) : null), icon("chevron"))
}

export async function renderSettings(page) {
  const [push, pk, cycle] = await Promise.all([pushStatus().catch(() => "unsupported"), api("/passkeys"), api("/settings/cycle")])
  const pushSub = { on: "On for this device", off: "Off. Tap to turn on", blocked: "Blocked in iPhone Settings", unsupported: "Install to Home Screen first" }[push]
  page.replaceChildren(
    el("div", { class: "topbar" }, el("button", { class: "icon-btn", type: "button", "aria-label": "Back", onclick: () => go("home") }, icon("back")),
      el("h1", { class: "grow", text: "Settings" })),
    el("div", { class: "section-head" }, el("h2", { text: "Household" })),
    el("div", { class: "list" },
      item("👨‍👩‍👧", "Family profile", "Context for the AI advisor", () => profileSheet()),
      item("calendar", "Budget cycle", `Starts on day ${cycle.start_day} of each month`, () => cycleSheet(cycle.start_day)),
      item("🏷️", "Categories", "Add, edit, archive or merge wallets", () => categoriesSheet()),
      item("📅", "Must-spend bills", "Rent, utilities, installments", () => billsSheet()),
      item("target", "Goals", "Emergency fund and savings goals", () => goalsSheet()),
      item("👥", "Members", "Who can use this app", () => membersSheet())),
    el("div", { class: "section-head section" }, el("h2", { text: "This device" })),
    el("div", { class: "list" },
      item("bell", "Notifications", pushSub, async () => {
        try {
          await enablePush()
          await api("/push/test", { method: "POST" })
          toast("Notifications are on. A test is on its way.", "good")
          renderSettings(page)
        } catch (err) { toast(err.message, "bad") }
      }),
      item("face", "Face ID lock", pk.passkeys.length ? `${pk.passkeys.length} passkey${pk.passkeys.length === 1 ? "" : "s"}. Asks after 1 hour away` : "Off. Tap to set up", () => passkeySheet(pk.passkeys, page)),
      item("lock", "Lock now", null, async () => { await api("/lock", { method: "POST" }); location.reload() })),
    el("div", { class: "section-head section" }, el("h2", { text: "Data" })),
    el("div", { class: "list" },
      item("mail", "Bank emails", "What arrived and how it was read", () => emailSheet()),
      item("🧭", "Setup guide", "Run the first-time setup again", () => go("setup")),
      demoItem(page)),
    el("div", { class: "section" }, (() => {
      const b = el("button", { class: "btn wide danger", type: "button", text: `Log out (${state.me.username})` })
      b.onclick = async () => { await api("/logout", { method: "POST" }).catch(() => {}); location.hash = ""; location.reload() }
      return b
    })()))
}

function demoItem(page) {
  if (state.me.role !== "admin") return null
  const row = el("div", { class: "list-item", hidden: true })
  api("/demo").then((d) => {
    if (!d.periods.length) return
    const b = el("button", { class: "btn small danger", type: "button", text: "Remove" })
    armed(b, "Sure?", async () => {
      const r = await api("/demo", { method: "DELETE" })
      toast(`Removed ${r.removed_transactions} demo transactions`, "good")
      renderSettings(page)
    })
    row.replaceChildren(el("div", { class: "li-icon", text: "🧪" }),
      el("div", { class: "li-main" }, el("div", { class: "li-title", text: "Demo data" }),
        el("div", { class: "li-sub", text: `${d.periods.length} demo month${d.periods.length === 1 ? "" : "s"} for previewing reports` })), b)
    row.hidden = false
  }).catch(() => {})
  return row
}

// ---------------------------------------------------------------------------
// Family profile
// ---------------------------------------------------------------------------
export async function profileSheet(onSaved) {
  const sh = sheet("Family profile", { tall: true })
  const { profile } = await api("/profile")
  const f = (key, label, placeholder, area = true) => {
    const input = el(area ? "textarea" : "input", { placeholder, maxlength: key === "notes" ? 3000 : 1000 })
    input.value = profile[key] || ""
    input.dataset.key = key
    return el("label", { class: "field" }, el("span", { text: label }), input)
  }
  const names = el("input", { placeholder: "e.g. Muhammad Syauqi Al Bashir, Bella", maxlength: 300 })
  names.value = (profile.names || []).join(", ")
  const fields = [
    f("household", "Household", "e.g. Married couple, one child (2 y.o.), living in a rented apartment"),
    f("city", "City", "e.g. South Jakarta", false),
    f("work", "Work & income", "e.g. Both employed; salaries on the 25th; yearly bonus in March"),
    f("dependants", "Family you support", "e.g. Send Rp1jt/month to parents"),
    f("values", "Values & obligations", "e.g. Muslim; zakat 2.5%; avoid interest-based debt"),
    f("priorities", "Priorities", "e.g. Emergency fund first, then house down payment by 2028"),
    f("notes", "Anything else", "e.g. Car tax due every August; Lebaran costs ~Rp8jt"),
  ]
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Save profile" })
  save.onclick = () => busy(save, async () => {
    const body = {}
    for (const w of fields) { const i = w.querySelector("[data-key]"); body[i.dataset.key] = i.value.trim() }
    body.names = names.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6)
    try { await api("/profile", { method: "PUT", json: body }); sh.close(); toast("Profile saved", "good"); if (onSaved) onSaved() }
    catch (err) { msg.textContent = err.message }
  })
  sh.body.append(el("p", { class: "muted", style: { marginBottom: "14px" }, text: "The advisor uses this to tailor suggestions. Keep it general; no account numbers." }),
    ...fields,
    el("label", { class: "field" }, el("span", { text: "Your full names (hidden from the AI)" }), names,
      el("p", { class: "hint", text: "Masked in bank emails before anything is sent to the AI, and used to recognise transfers between your own accounts." })),
    el("div", { class: "sticky-actions" }, msg, save))
}

// ---------------------------------------------------------------------------
// Budget cycle
// ---------------------------------------------------------------------------
export function cycleSheet(currentDay, onSaved) {
  const sh = sheet("Budget cycle")
  const day = el("input", { type: "number", min: 1, max: 31, value: currentDay, inputmode: "numeric" })
  const preview = el("div", { class: "card", hidden: true })
  const msg = el("p", { class: "form-msg" })
  const check = el("button", { class: "btn wide", type: "button", text: "Preview" })
  const apply = el("button", { class: "btn primary wide", type: "button", text: "Apply", disabled: true })
  check.onclick = () => busy(check, async () => {
    msg.textContent = ""
    try {
      const p = await api("/settings/cycle/preview", { method: "POST", json: { start_day: Number(day.value) } })
      preview.hidden = false
      preview.replaceChildren(el("dl", { class: "kv" },
        el("dt", { text: "This month" }), el("dd", { text: `${fmtDate(p.current.start)} – ${fmtDate(p.current.new_end)}${p.current.new_end !== p.current.end ? ` (was ${fmtDate(p.current.end)})` : ""}` }),
        el("dt", { text: "Next month" }), el("dd", { text: `${fmtDate(p.next.start)} – ${fmtDate(p.next.end)}` })),
        el("p", { class: "hint", text: "Past months keep their dates." }))
      apply.disabled = false
    } catch (err) { msg.textContent = err.message }
  })
  day.addEventListener("input", () => { apply.disabled = true; preview.hidden = true })
  apply.onclick = () => busy(apply, async () => {
    try { await api("/settings/cycle", { method: "PUT", json: { start_day: Number(day.value) } }); sh.close(); toast("Budget cycle updated", "good"); if (onSaved) onSaved(); else route() }
    catch (err) { msg.textContent = err.message }
  })
  sh.body.append(el("p", { class: "muted", style: { marginBottom: "12px" }, text: "The day your budget month starts, usually payday. Days 29–31 use the last day in shorter months." }),
    el("label", { class: "field" }, el("span", { text: "Start day (1–31)" }), day), check, preview, msg, apply)
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export async function categoriesSheet() {
  const sh = sheet("Categories", { tall: true })
  const render = async () => {
    const { categories } = await api("/categories?archived=true")
    const active = categories.filter((c) => !c.archived), archived = categories.filter((c) => c.archived)
    sh.body.replaceChildren(
      el("p", { class: "muted", style: { marginBottom: "12px" }, text: "Each category is a wallet. The AI files transactions into these and suggests new ones only when nothing fits." }),
      ...GROUPS.map(([g, label]) => {
        const cs = active.filter((c) => c.group === g)
        return cs.length ? el("div", {}, el("div", { class: "group-head" }, el("span", { text: label })),
          el("div", { class: "list" }, cs.map((c) => item(c.icon || "•", c.name, c.hints || "", () => categoryForm(c, active, render))))) : null
      }),
      el("button", { class: "btn wide", type: "button", style: { marginTop: "14px" }, onclick: () => categoryForm(null, active, render) }, icon("plus"), "Add category"),
      archived.length ? el("div", {}, el("div", { class: "group-head" }, el("span", { text: "Archived" })),
        el("div", { class: "list" }, archived.map((c) => {
          const b = el("button", { class: "btn small", type: "button", text: "Restore" })
          b.onclick = () => busy(b, async () => { await api(`/categories/${c.id}/restore`, { method: "POST" }); render() })
          return el("div", { class: "list-item" }, el("div", { class: "li-icon", text: c.icon || "•" }), el("div", { class: "li-main" }, el("div", { class: "li-title", text: c.name })), b)
        }))) : null)
  }
  await render()
}

function categoryForm(c, all, done) {
  const sh = sheet(c ? "Edit category" : "New category")
  const iconIn = el("input", { class: "emoji-input", value: c ? c.icon : "🏷️", maxlength: 4, "aria-label": "Icon" })
  const name = el("input", { value: c ? c.name : "", maxlength: 60, placeholder: "e.g. Groceries" })
  const group = el("select", {}, GROUPS.map(([g, l]) => el("option", { value: g, text: l })))
  group.value = c ? c.group : "needs"
  const hints = el("input", { value: c ? c.hints : "", maxlength: 500, placeholder: "What belongs here (helps the AI)" })
  const def = moneyInput(c ? c.default_amount : 0)
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn primary wide", type: "button", text: "Save" })
  save.onclick = () => busy(save, async () => {
    const body = { name: name.value.trim(), group: group.value, icon: iconIn.value.trim(), hints: hints.value.trim(), default_amount: def.money(), sort: c ? c.sort : 0 }
    try { await api(c ? `/categories/${c.id}` : "/categories", { method: c ? "PATCH" : "POST", json: body }); sh.close(); done() }
    catch (err) { msg.textContent = err.message }
  })
  sh.body.append(
    el("div", { class: "row" }, el("label", { class: "field", style: { width: "76px" } }, el("span", { text: "Icon" }), iconIn),
      el("label", { class: "field grow" }, el("span", { text: "Name" }), name)),
    el("label", { class: "field" }, el("span", { text: "Group" }), group),
    el("label", { class: "field" }, el("span", { text: "Covers" }), hints),
    el("label", { class: "field" }, el("span", { text: "Usual monthly amount (optional)" }), el("div", { class: "money-wrap" }, def)), msg, save)
  if (c) {
    const others = all.filter((o) => o.id !== c.id)
    const into = el("select", {}, others.map((o) => el("option", { value: o.id, text: `${o.icon || ""} ${o.name}` })))
    const merge = el("button", { class: "btn small", type: "button", text: "Merge" })
    armed(merge, "Sure?", async () => { await api(`/categories/${c.id}/merge`, { method: "POST", json: { into: into.value } }); sh.close(); toast("Merged", "good"); done() })
    const del = el("button", { class: "btn wide danger", type: "button", text: "Delete or archive" })
    armed(del, "Tap again (archives if used)", async () => {
      const r = await api(`/categories/${c.id}`, { method: "DELETE" })
      sh.close()
      toast(r.archived ? "Archived (it has history)" : "Deleted")
      done()
    })
    sh.body.append(el("div", { class: "day-head", text: "Merge into another category" }), el("div", { class: "row" }, el("div", { class: "grow" }, into), merge),
      el("div", { style: { marginTop: "16px" } }, del))
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
async function membersSheet() {
  const sh = sheet("Members")
  const render = async () => {
    const { members } = await api("/members")
    const list = el("div", { class: "list" }, members.map((m) => {
      const rm = state.me.role === "admin" && m.user !== state.me.id ? el("button", { class: "btn small danger", type: "button", text: "Remove" }) : null
      if (rm) armed(rm, "Sure?", async () => { await api(`/members/${m.id}`, { method: "DELETE" }); render() })
      return el("div", { class: "list-item" }, el("div", { class: "li-icon", text: "👤" }),
        el("div", { class: "li-main" }, el("div", { class: "li-title", text: m.username }), el("div", { class: "li-sub", text: `Since ${fmtDate(m.created)}` })), rm)
    }))
    sh.body.replaceChildren(el("p", { class: "muted", style: { marginBottom: "12px" }, text: "Everyone here sees and confirms all household transactions." }), list)
    if (state.me.role === "admin") {
      const u = el("input", { placeholder: "username (e.g. bells)", autocapitalize: "none", maxlength: 32 })
      const msg = el("p", { class: "form-msg" })
      const add = el("button", { class: "btn primary", type: "button", text: "Add" })
      add.onclick = () => busy(add, async () => {
        try { await api("/members", { method: "POST", json: { username: u.value.trim().toLowerCase() } }); toast("Added", "good"); render() }
        catch (err) { msg.textContent = err.message }
      })
      sh.body.append(el("div", { class: "day-head", text: "Add a member" }), el("div", { class: "row" }, el("div", { class: "grow" }, u), add), msg,
        el("p", { class: "hint", text: "They register at lyrsync.bashir.my.id first, and you approve them there." }))
    }
  }
  await render()
}

// ---------------------------------------------------------------------------
// Face ID (passkeys)
// ---------------------------------------------------------------------------
function passkeySheet(keys, page) {
  const sh = sheet("Face ID lock")
  const add = el("button", { class: "btn primary wide", type: "button" }, icon("face"), keys.length ? "Add this device" : "Set up Face ID")
  const msg = el("p", { class: "form-msg" })
  add.onclick = () => busy(add, async () => {
    try { await registerPasskey(); sh.close(); toast("Face ID is set up", "good"); renderSettings(page) }
    catch (err) { msg.textContent = err.name === "NotAllowedError" ? "Cancelled." : err.name === "InvalidStateError" ? "This device is already set up." : err.message }
  })
  sh.body.append(el("p", { class: "muted", style: { marginBottom: "12px" },
    text: "After 1 hour away, the app (and the server) stays locked until Face ID confirms it's you. Uses a passkey stored in your iCloud Keychain." }),
    el("div", { class: "list" }, keys.map((k) => {
      const rm = el("button", { class: "btn small danger", type: "button", text: "Remove" })
      armed(rm, "Sure?", async () => { await api(`/passkeys/${k.id}`, { method: "DELETE" }); sh.close(); renderSettings(page) })
      return el("div", { class: "list-item" }, el("div", { class: "li-icon" }, icon("face")),
        el("div", { class: "li-main" }, el("div", { class: "li-title", text: k.name || "Passkey" }), el("div", { class: "li-sub", text: `Added ${fmtDate(k.created)}` })), rm)
    })), el("div", { style: { marginTop: "12px" } }, add), msg)
}

// ---------------------------------------------------------------------------
// Email log
// ---------------------------------------------------------------------------
async function emailSheet() {
  const sh = sheet("Bank emails", { tall: true })
  let samples = false
  const render = async () => {
    const { emails } = await api(`/emails?samples=${samples}`)
    const seg = el("div", { class: "segmented", style: { marginBottom: "12px" } },
      el("button", { type: "button", "aria-pressed": String(!samples), text: "Real", onclick: () => { samples = false; render() } }),
      el("button", { type: "button", "aria-pressed": String(samples), text: "Samples", onclick: () => { samples = true; render() } }))
    sh.body.replaceChildren(seg, emails.length ? el("div", { class: "list" }, emails.map((e) => {
      const p = e.parsed || {}
      const pill = e.status === "parsed" ? el("span", { class: "pill ok", text: e.method === "ai" ? "Read by AI" : "Read by rules" })
        : e.status === "skipped" ? el("span", { class: "pill", text: "Not a transaction" }) : el("span", { class: "pill bad", text: e.status })
      return el("div", { class: "list-item" }, el("div", { class: "li-main" },
        el("div", { class: "li-title", text: e.subject || "(no subject)" }),
        el("div", { class: "li-sub" }, el("span", { text: relTime(e.received_at || e.created) }), pill,
          p.amount ? el("span", { text: `Rp${Number(p.amount).toLocaleString("id-ID")}${p.merchant ? " · " + p.merchant : ""}` }) : null),
        e.error ? el("div", { class: "hint", text: e.error }) : null))
    })) : el("div", { class: "empty-state" }, el("p", { text: "No emails yet." })))
  }
  await render()
}
