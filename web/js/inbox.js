import { api, armed, busy, el, fmtDay, fmtTime, icon, localDateKey, moneyInput, nowLocalInput, rp, sheet, sheetOpen, shrinkImage, store, toast } from "./lib.js?v=__VERSION__"
import { refreshBadge, route, state } from "./app.js?v=__VERSION__"

let categories = []
async function loadCategories() {
  categories = (await api("/categories")).categories
  return categories
}
const catById = (id) => categories.find((c) => c.id === id)

// What someone has filled in on a pending transaction but not confirmed yet (wallet lines, note, no-receipt reason).
// Kept on this device so it survives the sheet reloading (after adding a photo or saving details) and iOS restarting
// the app while the camera is open. Cleared on confirm / ignore / delete; old drafts expire after a week.
const DRAFTS = "fin.drafts"
const getDraft = (id) => store.get(DRAFTS, {})[id] || {}
function setDraft(id, patch) {
  const all = store.get(DRAFTS, {})
  for (const [k, v] of Object.entries(all)) if (Date.now() - (v.at || 0) > 7 * 86400e3) delete all[k]
  all[id] = { ...all[id], ...patch, at: Date.now() }
  store.set(DRAFTS, all)
}
function clearDraft(id) {
  const all = store.get(DRAFTS, {})
  delete all[id]
  store.set(DRAFTS, all)
}
// The transaction was confirmed meanwhile (other phone, or an older sheet): say so and close.
function doneElsewhere(err, tx, ctx) {
  if (err.status !== 409) return false
  clearDraft(tx.id)
  ctx.markChanged()
  toast(err.message)
  ctx.close()
  return true
}

const REASONS = ["Bank transfer", "Parking", "Street food", "Online invoice by email", "Lost it", "Other"]
const GROUP_NAME = { must: "Must spend", needs: "Needs", wants: "Wants", savings: "Savings" }

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
let listStatus = "pending"
let search = ""
// Select mode (To confirm tab): tick several transactions and confirm them together.
let selecting = false
const picked = new Map() // id -> transaction

export async function renderInbox(page, arg, _arg2, { quiet = false } = {}) {
  if (arg === "all" || arg === "ignored" || arg === "failed") listStatus = arg === "all" ? "confirmed" : arg
  await loadCategories()
  const query = `/transactions?status=${listStatus}&search=${encodeURIComponent(listStatus === "pending" ? "" : search)}`
  // quiet: refresh in place after a sheet closes. Fetch first and swap in one go (no skeleton), so the list keeps
  // its scroll position.
  const early = quiet ? await api(query) : null
  const refresh = () => renderInbox(page, null, null, { quiet: true })
  if (listStatus !== "pending") selecting = false
  const seg = el("div", { class: "segmented" })
  for (const [key, label] of [["pending", "To confirm"], ["confirmed", "Confirmed"], ["ignored", "Ignored"], ["failed", "Failed"]]) {
    seg.append(el("button", { type: "button", "aria-pressed": String(listStatus === key), text: label,
      onclick: () => { listStatus = key; renderInbox(page) } }))
  }
  const selectBtn = el("button", { class: "link-btn", type: "button", hidden: true, text: selecting ? "Cancel" : "Select",
    onclick: () => { selecting = !selecting; picked.clear(); refresh() } })
  const searchBox = el("input", { type: "search", placeholder: "Search merchant or note", value: search, enterkeyhint: "search" })
  searchBox.addEventListener("change", () => { search = searchBox.value; renderInbox(page) })
  const listWrap = el("div", {}, quiet ? null : el("div", { class: "skeleton", style: { height: "220px", marginTop: "14px" } }))
  page.replaceChildren(
    el("div", { class: "topbar" }, el("div", {}, el("h1", { text: "Inbox" }),
      el("div", { class: "sub", text: selecting ? "Tick the ones to confirm together." : "Bank emails, receipts and quick adds land here." })), selectBtn),
    seg, listStatus !== "pending" ? el("div", { style: { marginTop: "10px" } }, searchBox) : null, listWrap)
  if (!selecting) page.append(el("button", { class: "fab", type: "button", "aria-label": "Add a transaction", onclick: () => quickAdd() }, icon("plus")))

  const data = early || await api(query)
  const canBatch = listStatus === "pending" && data.items.filter(batchable).length >= 2
  selectBtn.hidden = !canBatch && !selecting
  if (!canBatch) selecting = false
  // Keep ticks that are still in the list (after a refresh), with their fresh data.
  for (const id of [...picked.keys()]) { const t = data.items.find((x) => x.id === id && batchable(x)); if (t) picked.set(id, t); else picked.delete(id) }
  listWrap.replaceChildren()
  if (!data.items.length) {
    listWrap.append(el("div", { class: "empty-state" }, el("div", { class: "big", text: listStatus === "pending" ? "🎉" : "🗂️" }),
      el("h3", { text: listStatus === "pending" ? "All caught up" : "Nothing here" }),
      el("p", { text: listStatus === "pending" ? "New bank transactions appear here within a few minutes." : "Try another filter." })))
    return
  }
  let day = ""
  let list = null
  for (const tx of data.items) {
    const d = localDateKey(tx.occurred_at)
    if (d !== day) {
      day = d
      listWrap.append(el("div", { class: "day-head", text: fmtDay(tx.occurred_at) }))
      list = el("div", { class: "list" })
      listWrap.append(list)
    }
    if (!selecting) { list.append(txRow(tx, () => openTransaction(tx.id, refresh))); continue }
    const ok = batchable(tx)
    const row = txRow(tx, () => {
      if (!ok) { toast("Open this one by itself: it needs a check, a split or its own steps."); return }
      if (picked.has(tx.id)) picked.delete(tx.id); else picked.set(tx.id, tx)
      mark()
      updateBar()
    })
    const mark = () => { row.classList.toggle("picked", picked.has(tx.id)); row.setAttribute("aria-pressed", String(picked.has(tx.id))) }
    row.classList.add(ok ? "pickable" : "no-pick")
    row.prepend(el("span", { class: "sel-check" }, icon("check")))
    mark()
    list.append(row)
  }
  if (!selecting) return
  // Bottom bar: count + total, select all, confirm.
  const info = el("div", { class: "grow" })
  const all = el("button", { class: "link-btn small", type: "button" })
  const go = el("button", { class: "btn primary", type: "button" })
  const updateBar = () => {
    const n = picked.size, total = [...picked.values()].reduce((a, t) => a + t.amount, 0)
    info.replaceChildren(el("b", { text: `${n} selected` }), el("div", { class: "muted small", text: n ? rp(total) : "Tap to tick" }))
    const every = data.items.filter(batchable)
    all.textContent = picked.size === every.length ? "Clear" : "All"
    all.onclick = () => {
      if (picked.size === every.length) picked.clear(); else for (const t of every) picked.set(t.id, t)
      refresh()
    }
    go.textContent = n ? `Confirm ${n}` : "Confirm"
    go.disabled = !n
  }
  go.onclick = () => confirmMany([...picked.values()], () => { picked.clear(); selecting = false; refresh() })
  updateBar()
  listWrap.append(el("div", { class: "select-bar" }, info, all, go))
}

// ---------------------------------------------------------------------------
// Confirm several at once: one wallet, one no-receipt reason and one note for all of them
// ---------------------------------------------------------------------------
// Only plain spending with nothing to check can go in a batch; the rest needs its own sheet.
function batchable(tx) {
  const f = tx.flags || {}
  const rec = (tx.receipts || [])[0]
  return tx.status === "pending" && tx.kind === "expense" && !f.possible_duplicate_of && !f.amount_check && !f.exceeds_topup &&
    !(rec && rec.match && rec.match.overall === "mismatch") && (tx.splits || []).length <= 1
}

function confirmMany(txs, onDone) {
  let confirmed = 0
  const sh = sheet(`Confirm ${txs.length} transactions`, { tall: true, key: "batch", onClose: () => { refreshBadge(); if (confirmed) onDone() } })
  if (!sh) return
  const total = txs.reduce((a, t) => a + t.amount, 0)
  const items = el("div", { class: "list" }, txs.map((t) => el("div", { class: "list-item" },
    el("div", { class: "li-main" }, el("div", { class: "li-title", text: t.merchant || t.description || "Transaction" }),
      el("div", { class: "li-sub", text: [t.account, fmtDay(t.occurred_at), fmtTime(t.occurred_at)].filter(Boolean).join(" · ") })),
    el("div", { class: "li-amount", text: rp(t.amount) }))))

  // Wallet: the shared AI suggestion if they all agree; "each one's suggestion" if they all have one but differ.
  const suggested = txs.map((t) => (t.ai || {}).category || "").map((c) => (catById(c) ? c : ""))
  const same = suggested.every((c) => c && c === suggested[0])
  const wallet = categorySelect(same ? suggested[0] : "")
  if (!same && suggested.every(Boolean)) {
    wallet.firstChild.after(el("option", { value: "*", text: "✨ Each one's suggested wallet" }))
    wallet.value = "*"
  }

  const missing = txs.filter((t) => t.receipt_state === "missing")
  let reason = ""
  const other = el("input", { placeholder: "Reason", maxlength: 200, hidden: true })
  const chips = el("div", { class: "reason-chips" }, REASONS.map((r) => el("button", { class: "chip", type: "button", text: r, onclick: (e) => {
    for (const c of chips.children) c.classList.toggle("on", c === e.currentTarget)
    other.hidden = r !== "Other"
    reason = r === "Other" ? other.value.trim() : r
  } })))
  other.addEventListener("input", () => { reason = other.value.trim() })
  const note = el("textarea", { maxlength: 1000, rows: 2, placeholder: "Optional, added to each one" })
  const msg = el("div", { class: "form-msg", role: "alert" })
  const label = el("span", { text: `Confirm ${txs.length}` })
  const go = el("button", { class: "btn primary wide", type: "button" }, icon("check"), label)
  go.onclick = () => busy(go, async () => {
    msg.replaceChildren()
    if (!wallet.value) { msg.textContent = "Choose a wallet."; return }
    if (missing.length && !reason) { msg.textContent = "Choose why there's no receipt."; return }
    const failed = []
    let already = 0
    for (const [i, t] of txs.entries()) {
      label.textContent = `Confirming ${i + 1} of ${txs.length}…`
      const category = wallet.value === "*" ? t.ai.category : wallet.value
      try {
        await api(`/transactions/${t.id}/confirm`, { method: "POST", json: { splits: [{ category, amount: t.amount }],
          waive_reason: t.receipt_state === "missing" ? reason : "", note: note.value.trim() || undefined } })
        confirmed++
        clearDraft(t.id)
      } catch (err) {
        if (err.status === 409) { already++; confirmed++; clearDraft(t.id) } else failed.push({ t, error: err.message })
      }
    }
    if (!failed.length) {
      toast(already ? `Confirmed ${confirmed - already}; ${already} already were` : `Confirmed ${confirmed}`, "good")
      sh.close()
      return
    }
    label.textContent = "Try the rest again"
    msg.replaceChildren(el("p", { text: `Confirmed ${confirmed}. These need a look (or open them one by one):` }),
      ...failed.map((f) => el("p", { text: `• ${f.t.merchant || "Transaction"} ${rp(f.t.amount)}: ${f.error}` })))
    txs = failed.map((f) => f.t)
  })

  sh.body.append(
    el("p", { class: "muted", style: { marginBottom: "12px" }, text: `${txs.length} transactions · ${rp(total)}. Each one stays its own transaction with its exact bank amount.` }),
    items,
    el("div", { class: "card", style: { marginTop: "12px" } }, el("div", { class: "card-title", text: "Wallet for all" }), wallet),
    missing.length ? el("div", { class: "card" }, el("div", { class: "card-title", text: "Receipt" }),
      el("p", { class: "muted small", text: missing.length === txs.length ? "None of these has a receipt. Why?" : `${missing.length} of these ${missing.length === 1 ? "has" : "have"} no receipt. Why?` }), chips, other) : null,
    el("div", { class: "card" }, el("div", { class: "card-title", text: "Note (optional)" }), note),
    el("div", { class: "sticky-actions" }, msg, go))
}

function txIcon(tx) {
  if (tx.kind === "transfer") return "🔁"
  if (tx.kind === "topup") return "👛"
  const cat = tx.splits && tx.splits.length ? catById(tx.splits[0].category) : catById((tx.ai || {}).category)
  return (cat && cat.icon) || "🧾"
}

export function txRow(tx, onclick) {
  const pills = []
  if (tx.status === "pending") {
    if (tx.kind === "topup") pills.push(el("span", { class: "pill warn", text: `${rp(tx.remaining)} to account` }))
    else if (tx.kind === "expense") {
      pills.push(tx.receipt_state === "attached" ? el("span", { class: "pill ok" }, icon("receipt"), "Receipt")
        : tx.receipt_state === "waived" ? el("span", { class: "pill", text: "No receipt" }) : el("span", { class: "pill warn" }, icon("receipt"), "Needs receipt"))
      const ai = tx.ai || {}
      const cat = catById(ai.category)
      if (cat) pills.push(el("span", { class: "pill ai", text: cat.name }))
      else if (ai.suggest_new) pills.push(el("span", { class: "pill ai", text: `New: ${ai.suggest_new.name}` }))
    }
    if (tx.flags && (tx.flags.possible_duplicate_of || tx.flags.amount_check || tx.flags.exceeds_topup)) pills.push(el("span", { class: "pill bad" }, icon("alert"), "Check"))
  } else if (tx.status === "ignored" && tx.flags && tx.flags.before_tracking_start) {
    pills.push(el("span", { class: "pill", text: `Before ${tx.flags.before_tracking_start}` }))
  } else if (tx.status === "confirmed" && tx.splits && tx.splits.length) {
    const names = tx.splits.map((s) => (catById(s.category) || {}).name).filter(Boolean)
    pills.push(el("span", { class: "pill", text: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] || "" }))
  }
  return el("button", { class: "list-item", type: "button", onclick },
    el("div", { class: "li-icon", text: txIcon(tx) }),
    el("div", { class: "li-main" },
      el("div", { class: "li-title", text: tx.merchant || tx.description || "Transaction" }),
      el("div", { class: "li-sub" }, el("span", { text: [tx.account, tx.owner ? `👤 ${ownerName(tx.owner)}` : "", tx.description && tx.description !== tx.merchant ? tx.description : "", fmtTime(tx.occurred_at)].filter(Boolean).join(" · ") })),
      tx.note ? el("div", { class: "li-note", text: `“${tx.note}”` }) : null,
      pills.length ? el("div", { class: "li-pills" }, ...pills) : null),
    el("div", { class: "li-right" }, el("div", { class: `li-amount${tx.kind === "transfer" ? " transfer" : ""}`, text: rp(tx.amount) })))
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------
// parent: the e-wallet top-up this purchase belongs to. onDone: runs after something was added (default: re-route).
export async function quickAdd(parent, onDone = () => route()) {
  if (!categories.length) await loadCategories()
  const sh = sheet(parent ? "Add a purchase" : "Add a transaction", { key: "add" })
  if (!sh) return
  const fileInput = el("input", { type: "file", accept: "image/*", hidden: true })
  const scan = el("button", { class: "btn primary wide", type: "button" }, icon("camera"), "Scan receipt or payment screenshot")
  const status = el("p", { class: "hint", style: { textAlign: "center" } })
  scan.onclick = () => fileInput.click()
  fileInput.onchange = async () => {
    const file = fileInput.files[0]
    if (!file) return
    await busy(scan, async () => {
      status.textContent = "Reading the photo…"
      try {
        const blob = await shrinkImage(file)
        const fd = new FormData()
        fd.append("file", blob, "receipt.jpg")
        const res = await api(parent ? `/transactions/${parent.id}/purchase` : "/transactions/from-receipt", { method: "POST", body: fd })
        sh.close()
        toast("Read the receipt. Check and confirm.", "good")
        openTransaction(res.transaction.id, onDone)
      } catch (err) {
        status.textContent = err.message
      }
    })
  }

  const amount = moneyInput(0, { placeholder: "0" })
  const merchant = el("input", { placeholder: "e.g. Warung Bu Sri", maxlength: 200 })
  const when = el("input", { type: "datetime-local", value: nowLocalInput() })
  const account = el("select", {}, ["Cash", "BCA", "Mandiri", "GoPay", "OVO", "ShopeePay", "DANA", "Other"].map((a) => el("option", { value: a, text: a })))
  const kind = el("select", {}, el("option", { value: "expense", text: "Spending" }), el("option", { value: "topup", text: "E-wallet top-up" }))
  const wallet = categorySelect("")
  wallet.options[0].textContent = "Wallet (optional; can choose when confirming)"
  const walletField = el("label", { class: "field" }, el("span", { text: "Wallet" }), wallet)
  // Receipt: a photo next (opens the transaction to attach it), or no receipt + reason. With a wallet and a reason,
  // "Add & confirm" finishes it here: no second screen.
  let reason = ""
  const other = el("input", { placeholder: "Reason", maxlength: 200, hidden: true })
  const chips = el("div", { class: "reason-chips" })
  const pick = (chip, r) => {
    for (const c of chips.children) c.classList.toggle("on", c === chip)
    other.hidden = r !== "Other"
    reason = r === "Other" ? other.value.trim() : r
    updateSave()
  }
  const photoChip = el("button", { class: "chip on", type: "button", text: "📷 Photo next" })
  photoChip.onclick = () => pick(photoChip, "")
  chips.append(photoChip, ...REASONS.map((r) => { const c = el("button", { class: "chip", type: "button", text: r }); c.onclick = () => pick(c, r); return c }))
  other.addEventListener("input", () => { reason = other.value.trim(); updateSave() })
  const receiptField = el("div", { class: "field" }, el("span", { text: "Receipt" }), chips, other)
  const isSpending = () => !!parent || kind.value === "expense"
  kind.addEventListener("change", () => { walletField.hidden = receiptField.hidden = !isSpending(); updateSave() })
  wallet.addEventListener("change", () => updateSave())
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn wide", type: "submit", text: "Add" })
  const oneStep = () => isSpending() && wallet.value && reason
  function updateSave() {
    save.textContent = oneStep() ? "Add & confirm" : "Add"
    save.classList.toggle("primary", !!oneStep())
  }
  const form = el("form", {},
    el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
    el("label", { class: "field" }, el("span", { text: parent ? "Where" : "Merchant or payee" }), merchant),
    el("label", { class: "field" }, el("span", { text: "When" }), when),
    parent ? null : el("div", { class: "row" },
      el("label", { class: "field grow" }, el("span", { text: "Paid from" }), account),
      el("label", { class: "field grow" }, el("span", { text: "Type" }), kind)),
    walletField, receiptField, msg, save)
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!amount.money()) { msg.textContent = "Enter the amount."; return }
    await busy(save, async () => {
      try {
        const tx = await api("/transactions", { method: "POST", json: {
          amount: amount.money(), merchant: merchant.value.trim(), occurred_at: when.value + ":00+07:00",
          account: parent ? parent.wallet : account.value, kind: parent ? "expense" : kind.value,
          wallet: !parent && kind.value === "topup" ? account.value : "", parent: parent ? parent.id : "",
          category: kind.value === "expense" || parent ? wallet.value : "" } })
        if (oneStep()) {
          try {
            await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: { splits: [{ category: wallet.value, amount: tx.amount }], waive_reason: reason } })
            sh.close()
            toast("Added and confirmed", "good")
            onDone()
            return
          } catch (err) { toast(err.message, "bad") } // saved but not confirmed: finish it in its sheet
        }
        sh.close()
        openTransaction(tx.id, onDone)
      } catch (err) { msg.textContent = err.message }
    })
  })
  sh.body.append(
    el("p", { class: "muted", style: { marginBottom: "12px" }, text: parent
      ? `Photo of the ${parent.wallet || "e-wallet"} order or receipt. The AI reads the shop, total and items.`
      : "For payments without a bank email: cash, some QRIS or e-wallet payments." }),
    scan, fileInput, status,
    el("div", { class: "day-head", style: { textAlign: "center" }, text: "or enter it manually" }), form)
}

// ---------------------------------------------------------------------------
// Transaction sheet
// ---------------------------------------------------------------------------
export async function openTransaction(id, onDone) {
  const key = `tx:${id}`
  if (sheetOpen(key)) return
  if (!categories.length) await loadCategories()
  const sh = sheet("Transaction", { tall: true, key, onClose: () => { refreshBadge(); if (changed && onDone) onDone() } })
  if (!sh) return
  let changed = false
  const reload = async () => {
    const tx = await api(`/transactions/${id}`)
    sh.setTitle(tx.kind === "topup" ? `${tx.wallet || "E-wallet"} top-up` : tx.kind === "transfer" ? "Transfer" : "Transaction")
    sh.body.replaceChildren(await txBody(tx, { reload, close: () => sh.close(), markChanged: () => { changed = true } }))
  }
  sh.body.append(el("div", { class: "skeleton", style: { height: "300px" } }))
  try { await reload() } catch (err) { sh.body.replaceChildren(el("p", { class: "form-msg", text: err.message })) }
}

async function txBody(tx, ctx) {
  const box = el("div", { class: "stack-v" })
  const pending = tx.status === "pending"
  // Header
  box.append(el("div", {},
    el("div", { class: "tx-amount", text: rp(tx.amount) }),
    el("div", { style: { fontSize: "18px", fontWeight: 650, marginTop: "2px" }, text: tx.merchant || tx.description || "—" }),
    el("div", { class: "row wrap", style: { marginTop: "8px" } },
      el("span", { class: `pill ${tx.status === "confirmed" ? "ok" : tx.status === "pending" ? "warn" : ""}`, text: tx.status }),
      el("span", { class: "pill", text: tx.source === "email" ? "Bank email" : tx.source === "screenshot" ? "From photo" : "Added by hand" }),
      tx.confirmed_by ? el("span", { class: "pill", text: `Confirmed by ${tx.confirmed_by}` }) : null)))
  box.append(el("dl", { class: "kv card" },
    el("dt", { text: "When" }), el("dd", { text: `${fmtDay(tx.occurred_at)}, ${fmtTime(tx.occurred_at)}` }),
    tx.account ? el("dt", { text: "Account" }) : null, tx.account ? el("dd", { text: tx.account }) : null,
    tx.description ? el("dt", { text: "Type" }) : null, tx.description ? el("dd", { text: tx.description }) : null,
    tx.holder && !tx.holder.includes("[owner]") ? el("dt", { text: "Holder" }) : null,
    tx.holder && !tx.holder.includes("[owner]") ? el("dd", { text: tx.holder }) : null,
    tx.note && tx.status !== "pending" ? el("dt", { text: "Note" }) : null,
    tx.note && tx.status !== "pending" ? el("dd", { text: tx.note }) : null))

  if (tx.bank_details) box.append(bankCard(tx, ctx))

  // Flags
  const flags = tx.flags || {}
  if (flags.possible_duplicate_of && pending) {
    const ignoreBtn = el("button", { class: "btn small", type: "button", text: "Ignore this one" })
    ignoreBtn.onclick = () => busy(ignoreBtn, async () => { await api(`/transactions/${tx.id}/ignore`, { method: "POST" }); clearDraft(tx.id); ctx.markChanged(); toast("Ignored as duplicate"); ctx.close() })
    box.append(el("div", { class: "banner warn flag" }, icon("alert"), el("div", { class: "grow" },
      el("div", { class: "banner-title", text: "Possible duplicate" }),
      el("div", { class: "banner-sub", text: "Another transaction has the same amount within 10 minutes (e.g. a shop order paid via an e-wallet sends two emails)." })), ignoreBtn))
  }
  for (const key of ["amount_check", "exceeds_topup"]) {
    if (flags[key] && pending) box.append(el("div", { class: "banner warn flag" }, icon("alert"), el("div", { class: "grow" }, el("div", { class: "banner-sub", text: flags[key] }))))
  }

  if (tx.kind === "transfer") box.append(transferSection(tx, ctx))
  else if (tx.kind === "topup") box.append(topupSection(tx, ctx))
  else box.append(...expenseSections(tx, ctx))

  if (tx.email_info) {
    const text = el("div", { class: "email-text", hidden: true, text: tx.email_info.body })
    const t = el("button", { class: "link-btn small", type: "button", text: `Show the bank email (read by ${tx.email_info.method === "ai" ? "AI" : "rules"})` })
    t.onclick = () => { text.hidden = !text.hidden }
    box.append(el("div", {}, t, text))
  }

  // Secondary actions
  const actions = el("div", { class: "row wrap", style: { marginTop: "6px" } })
  if (tx.status === "confirmed") {
    const undo = el("button", { class: "btn small", type: "button", text: "Undo confirmation" })
    undo.onclick = () => busy(undo, async () => { await api(`/transactions/${tx.id}/unconfirm`, { method: "POST" }); ctx.markChanged(); await ctx.reload() })
    actions.append(undo)
  } else if (tx.status === "pending") {
    const ig = el("button", { class: "btn small", type: "button", text: "Ignore" })
    actions.append(armed(ig, "Tap again to ignore", async () => { await api(`/transactions/${tx.id}/ignore`, { method: "POST" }); clearDraft(tx.id); ctx.markChanged(); toast("Ignored"); ctx.close() }))
    if (tx.source !== "email") {
      const del = el("button", { class: "btn small danger", type: "button", text: "Delete" })
      actions.append(armed(del, "Tap again to delete", async () => { await api(`/transactions/${tx.id}`, { method: "DELETE" }); clearDraft(tx.id); ctx.markChanged(); toast("Deleted"); ctx.close() }))
    }
  } else if (tx.status === "ignored") {
    const r = el("button", { class: "btn small", type: "button", text: "Restore to inbox" })
    r.onclick = () => busy(r, async () => { await api(`/transactions/${tx.id}/restore`, { method: "POST" }); ctx.markChanged(); await ctx.reload() })
    actions.append(r)
  }
  box.append(actions)
  return box
}

function transferSection(tx, ctx) {
  const box = el("div", { class: "card" }, el("p", { text: "A move between your own accounts. It doesn't touch any wallet." }))
  if (tx.status === "pending") {
    const ok = el("button", { class: "btn primary wide", type: "button", style: { marginTop: "12px" } }, icon("check"), "Confirm transfer")
    ok.onclick = () => busy(ok, async () => {
      try { await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: {} }); ctx.markChanged(); toast("Confirmed", "good"); ctx.close() }
      catch (err) { if (!doneElsewhere(err, tx, ctx)) toast(err.message, "bad") }
    })
    const notTransfer = el("button", { class: "link-btn small", type: "button", style: { marginTop: "10px" }, text: "It's actually spending" })
    notTransfer.onclick = async () => { await api(`/transactions/${tx.id}`, { method: "PATCH", json: { kind: "expense" } }); await api(`/transactions/${tx.id}/recategorize`, { method: "POST" }); ctx.markChanged(); await ctx.reload() }
    box.append(ok, notTransfer)
  }
  return box
}

function topupSection(tx, ctx) {
  const box = el("div", { class: "stack-v" })
  const accounted = tx.accounted || 0
  box.append(el("div", { class: "card" },
    el("div", { class: "row between" }, el("span", { class: "muted", text: "Accounted for" }), el("strong", { text: `${rp(accounted)} of ${rp(tx.amount)}` })),
    el("div", { class: "meter", style: { marginTop: "10px" } }, el("div", { class: "meter-fill", style: { width: `${Math.min(100, (accounted / Math.max(1, tx.amount)) * 100)}%` } })),
    el("p", { class: "hint", text: tx.remaining > 0 ? `${rp(tx.remaining)} still to account for. Add each purchase with its receipt.` :
      tx.remaining < 0 ? `Purchases exceed the top-up by ${rp(-tx.remaining)}.` : "Fully accounted for." })))
  if (tx.purchases && tx.purchases.length) {
    const again = () => { ctx.markChanged(); return ctx.reload() }
    box.append(el("div", { class: "list" }, tx.purchases.map((p) => txRow(p, () => openTransaction(p.id, again)))))
  }
  if (tx.status === "pending") {
    // After adding or confirming a purchase, this top-up sheet refreshes right away (it used to stay stale underneath).
    box.append(el("button", { class: "btn primary wide", type: "button", onclick: () => quickAdd(tx, () => { ctx.markChanged(); return ctx.reload() }) }, icon("camera"), "Add a purchase"))
    if (tx.remaining > 0) {
      const sel = categorySelect("")
      const close = el("button", { class: "btn wide", type: "button", text: `Close: put the remaining ${rp(tx.remaining)} in…` })
      const msg = el("p", { class: "form-msg" })
      close.onclick = () => busy(close, async () => {
        if (!sel.value) { msg.textContent = "Choose a wallet for the rest."; return }
        try { await api(`/transactions/${tx.id}/close`, { method: "POST", json: { category: sel.value } }); ctx.markChanged(); toast("Top-up closed", "good"); ctx.close() }
        catch (err) { if (!doneElsewhere(err, tx, ctx)) msg.textContent = err.message }
      })
      box.append(el("div", { class: "card" }, el("p", { class: "muted small", text: "Spent the rest on small things without receipts?" }),
        el("div", { style: { margin: "10px 0" } }, sel), close, msg))
    } else if (tx.remaining <= 0) {
      const ok = el("button", { class: "btn primary wide", type: "button" }, icon("check"), "Confirm top-up")
      const msg = el("p", { class: "form-msg" })
      ok.onclick = () => busy(ok, async () => {
        try { await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: {} }); ctx.markChanged(); toast("Confirmed", "good"); ctx.close() }
        catch (err) { if (!doneElsewhere(err, tx, ctx)) msg.textContent = err.message }
      })
      box.append(ok, msg)
    }
  }
  return box
}

function categorySelect(value, onchange) {
  const sel = el("select", { onchange })
  sel.append(el("option", { value: "", text: "Choose a wallet…" }))
  for (const g of ["must", "needs", "wants", "savings"]) {
    const og = el("optgroup", { label: GROUP_NAME[g] })
    for (const c of categories.filter((c) => c.group === g)) og.append(el("option", { value: c.id, text: `${c.icon || ""} ${c.name}`.trim() }))
    if (og.children.length) sel.append(og)
  }
  sel.value = value || ""
  return sel
}

function expenseSections(tx, ctx) {
  const pending = tx.status === "pending"
  const draft = pending ? getDraft(tx.id) : {}
  const out = []

  // ---- Receipt ----
  const receiptCard = el("div", { class: "card" }, el("div", { class: "card-title", text: "Receipt" }))
  const rec = tx.receipts && tx.receipts[0]
  if (rec) {
    receiptCard.append(el("img", { class: "receipt-thumb", src: `/api/receipts/${rec.id}/image?thumb=1`, alt: "Receipt photo", loading: "lazy",
      onclick: () => window.open(`/api/receipts/${rec.id}/image`, "_blank") }))
    const m = rec.match || {}
    const mark = (v) => v === "ok" ? el("span", { class: "pill ok" }, icon("check"), "Match") : v === "mismatch" ? el("span", { class: "pill bad" }, icon("x"), "Differs")
      : v === "different" ? el("span", { class: "pill warn", text: "Different name" }) : el("span", { class: "pill", text: "Unknown" })
    const verdict = m.overall === "match" ? el("span", { class: "pill ok" }, icon("check"), "Receipt matches")
      : m.overall === "mismatch" ? el("span", { class: "pill bad" }, icon("alert"), "Receipt doesn't match")
      : m.overall === "not_a_receipt" ? el("span", { class: "pill bad", text: "Not a receipt?" }) : el("span", { class: "pill", text: "Partly checked" })
    receiptCard.append(el("div", { class: "row between", style: { marginTop: "10px" } }, verdict,
      rec.drive_state === "uploaded" ? el("span", { class: "pill ok", text: "Saved to Drive" }) : null))
    receiptCard.append(el("div", { class: "match" }, el("span", { class: "h", text: "Check" }), el("span"), el("span"),
      el("span", { text: "Amount" }), mark(m.amount), el("span"),
      el("span", { text: "Date" }), mark(m.date), el("span"),
      el("span", { text: "Merchant" }), mark(m.merchant), el("span")))
    if (pending) {
      const remove = el("button", { class: "link-btn small", type: "button", style: { marginTop: "10px" }, text: "Remove photo" })
      remove.onclick = async () => { await api(`/receipts/${rec.id}`, { method: "DELETE" }); ctx.markChanged(); await ctx.reload() }
      receiptCard.append(remove)
    }
  } else if (tx.receipt_state === "waived") {
    receiptCard.append(el("p", { text: `No receipt: ${tx.waive_reason || "—"}` }))
  }
  out.push(receiptCard)

  // Waive (no receipt) choice, shown when missing.
  let waiveReason = ""
  const waiveBox = el("div", { hidden: true })
  if (pending && !rec && tx.receipt_state !== "waived") {
    const file = el("input", { type: "file", accept: "image/*", hidden: true })
    const add = el("button", { class: "btn primary wide", type: "button" }, icon("camera"), "Add receipt photo")
    const status = el("p", { class: "hint" })
    add.onclick = () => file.click()
    file.onchange = () => busy(add, async () => {
      if (!file.files[0]) return
      status.textContent = "Reading the receipt…"
      try {
        const blob = await shrinkImage(file.files[0])
        const fd = new FormData()
        fd.append("file", blob, "receipt.jpg")
        const res = await api(`/transactions/${tx.id}/receipt`, { method: "POST", body: fd })
        ctx.markChanged()
        if (res.extracted && res.extracted.error) toast(res.extracted.error, "bad")
        await ctx.reload()
      } catch (err) { status.textContent = err.message }
    })
    const noReceipt = el("button", { class: "link-btn small", type: "button", text: "I don't have a receipt" })
    const chips = el("div", { class: "reason-chips" })
    const other = el("input", { placeholder: "Reason", maxlength: 200, hidden: true })
    const pick = (r) => {
      for (const c of chips.children) c.classList.toggle("on", c.textContent === r)
      other.hidden = r !== "Other"
      waiveReason = r === "Other" ? other.value.trim() : r
    }
    for (const r of REASONS) {
      const chip = el("button", { class: "chip", type: "button", text: r })
      chip.onclick = () => { pick(r); setDraft(tx.id, { waive: { chip: r, other: other.value } }) }
      chips.append(chip)
    }
    other.addEventListener("input", () => { waiveReason = other.value.trim(); setDraft(tx.id, { waive: { chip: "Other", other: other.value } }) })
    waiveBox.append(el("p", { class: "muted small", text: "Why is there no receipt?" }), chips, other)
    noReceipt.onclick = () => {
      waiveBox.hidden = !waiveBox.hidden
      if (waiveBox.hidden) { waiveReason = ""; setDraft(tx.id, { waive: null }) }
    }
    if (draft.waive) { other.value = draft.waive.other || ""; pick(draft.waive.chip); waiveBox.hidden = false }
    receiptCard.append(add, file, status, el("div", { style: { marginTop: "8px" } }, noReceipt), waiveBox)
  }

  // ---- Category / split ----
  const ai = tx.ai || {}
  const splitCard = el("div", { class: "card" })
  const rows = el("div")
  const leftInfo = el("p", { class: "split-left" })
  const saveSplits = () => setDraft(tx.id, { splits: [...rows.children].map((r) => ({ category: r._sel.value, amount: r._amount.money() })) })
  const recalc = () => {
    const sum = [...rows.children].reduce((s, r) => s + r._amount.money(), 0)
    const diff = tx.amount - sum
    leftInfo.textContent = diff === 0 ? "✓ Adds up" : diff > 0 ? `${rp(diff)} left to split` : `${rp(-diff)} too much`
    leftInfo.className = `split-left ${diff === 0 ? "ok" : "bad"}`
  }
  const addRow = (cat, amount) => {
    const sel = categorySelect(cat, saveSplits)
    const amt = moneyInput(amount)
    amt.addEventListener("input", () => { recalc(); saveSplits() })
    const rm = el("button", { class: "icon-btn", type: "button", "aria-label": "Remove" }, icon("x"))
    const row = el("div", { class: "split-row" }, sel, el("div", { class: "money-wrap" }, amt), rm)
    row._sel = sel
    row._amount = amt
    rm.onclick = () => { if (rows.children.length > 1) { row.remove(); recalc(); saveSplits() } }
    rows.append(row)
    recalc()
  }
  if (pending && draft.splits && draft.splits.length) {
    // What this person chose before the sheet reloaded. A single line follows the (possibly edited) amount.
    const lines = draft.splits.length === 1 ? [{ ...draft.splits[0], amount: tx.amount }] : draft.splits
    for (const s of lines) addRow(s.category, s.amount)
  } else if (tx.status === "confirmed" || (tx.splits && tx.splits.length)) {
    for (const s of tx.splits) addRow(s.category, s.amount)
  } else if (ai.splits && ai.splits.length) {
    for (const s of ai.splits) addRow(s.category_id, s.amount)
  } else {
    addRow(ai.category || "", tx.amount)
  }
  const head = el("div", { class: "row between" }, el("div", { class: "card-title", text: "Wallet" }),
    ai.source && ai.source !== "none" && pending ? el("span", { class: "pill ai" }, icon("spark"),
      ai.source === "learned" ? "Learned" : `AI ${Math.round((ai.confidence || 0) * 100)}%`) : null)
  splitCard.append(head)
  if (ai.reason && pending) splitCard.append(el("p", { class: "muted small", style: { margin: "-2px 0 10px" }, text: ai.reason }))
  splitCard.append(rows)
  if (pending) {
    const split = el("button", { class: "btn small", type: "button" }, icon("split"), "Split")
    split.onclick = () => {
      const sum = [...rows.children].reduce((s, r) => s + r._amount.money(), 0)
      addRow("", Math.max(0, tx.amount - sum))
      saveSplits()
    }
    splitCard.append(el("div", { class: "row between" }, leftInfo, split))
    if (ai.suggest_new && !ai.category) {
      const create = el("button", { class: "btn small", type: "button", text: `Create "${ai.suggest_new.name}"` })
      create.onclick = () => busy(create, async () => {
        const c = await api("/categories", { method: "POST", json: { name: ai.suggest_new.name, group: ai.suggest_new.group, icon: "🏷️" } })
        await loadCategories()
        const first = rows.children[0]
        const replacement = categorySelect(c.id, saveSplits)
        first._sel.replaceWith(replacement)
        first._sel = replacement
        saveSplits()
        toast(`Created ${c.name}`, "good")
        create.remove()
      })
      splitCard.append(el("div", { class: "banner info", style: { marginTop: "8px" } }, icon("spark"),
        el("div", { class: "grow" }, el("div", { class: "banner-title", text: "New category suggested" }),
          el("div", { class: "banner-sub", text: `${ai.suggest_new.name} (${GROUP_NAME[ai.suggest_new.group] || ai.suggest_new.group})` })), create))
    }
  } else {
    for (const r of rows.children) { r._sel.disabled = true; r._amount.disabled = true; r.lastChild.hidden = true }
  }
  out.push(splitCard)

  // ---- Edit details (pending only) ----
  if (pending) {
    const amount = moneyInput(tx.amount)
    const merchant = el("input", { value: tx.merchant || "", maxlength: 200 })
    const save = el("button", { class: "btn small", type: "button", text: "Save details" })
    const details = el("details", { class: "card" }, el("summary", { class: "muted", text: "Edit amount or merchant" }),
      el("div", { style: { marginTop: "12px" } },
        el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
        el("label", { class: "field" }, el("span", { text: "Merchant" }), merchant), save))
    save.onclick = () => busy(save, async () => {
      await api(`/transactions/${tx.id}`, { method: "PATCH", json: { amount: amount.money(), merchant: merchant.value.trim() } })
      ctx.markChanged()
      toast("Saved")
      await ctx.reload()
    })
    out.push(details)

    // ---- Note (optional) ----
    const noteIn = el("textarea", { maxlength: 1000, rows: 2, placeholder: "e.g. Birthday dinner for Ibu; split with Andi" })
    noteIn.value = draft.note ?? tx.note ?? ""
    noteIn.addEventListener("input", () => setDraft(tx.id, { note: noteIn.value }))
    out.push(el("div", { class: "card" }, el("div", { class: "card-title", text: "Note (optional)" }), noteIn,
      el("p", { class: "hint", text: "Shown in the Inbox and in the monthly report." })))

    // ---- Confirm ----
    const msg = el("p", { class: "form-msg", role: "alert" })
    const confirm = el("button", { class: "btn primary wide", type: "button" }, icon("check"), "Confirm")
    confirm.onclick = () => busy(confirm, async () => {
      msg.textContent = ""
      const splits = [...rows.children].map((r) => ({ category: r._sel.value, amount: r._amount.money() }))
      if (splits.some((s) => !s.category)) { msg.textContent = "Choose a wallet for every line."; return }
      if (rec && rec.match && rec.match.overall === "mismatch") {
        if (!confirm.dataset.ok) { confirm.dataset.ok = "1"; msg.textContent = "The receipt doesn't match this transaction. Fix the amount above, or tap Confirm again to keep it as is."; return }
      }
      try {
        await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: { splits, waive_reason: waiveReason, note: noteIn.value.trim() } })
        clearDraft(tx.id)
        ctx.markChanged()
        toast("Confirmed", "good")
        ctx.close()
      } catch (err) { if (!doneElsewhere(err, tx, ctx)) msg.textContent = err.message }
    })
    out.push(el("div", { class: "sticky-actions" }, msg, confirm))
  }
  return out
}


// ---------------------------------------------------------------------------
// Bank details (read from the bank email when the transaction is opened)
// ---------------------------------------------------------------------------
let membersCache = null
async function members() {
  if (!membersCache) { try { membersCache = (await api("/members")).members || [] } catch (_) { membersCache = [] } }
  return membersCache
}
export function ownerName(username) {
  const me = state.me && state.me.username
  return username === me ? "you" : username
}

function bankCard(tx, ctx) {
  const d = tx.bank_details || {}
  const from = d.from || {}, to = d.to || {}
  const rows = []
  const row = (label, value, extra) => { if (value || extra) rows.push(el("dt", { text: label }), el("dd", {}, value || "", extra || "")) }
  // From: bank account + whose account it is
  const ownerBox = el("span", { class: "owner-pick" })
  const drawOwner = async () => {
    const list = await members()
    const cur = tx.owner || ""
    ownerBox.replaceChildren(
      ...(cur ? [el("span", { class: "pill ok", text: `👤 ${ownerName(cur)}` })] : [el("span", { class: "small muted", text: "Whose account?" })]),
      ...list.filter((m) => m.username !== cur).map((m) => el("button", { class: "chip small", type: "button", text: ownerName(m.username),
        onclick: async () => {
          await api("/account-owner", { method: "POST", json: { account: d.account_key, username: m.username } })
          tx.owner = m.username; ctx.markChanged(); toast(`${from.label || "This account"} → ${ownerName(m.username)}`); drawOwner()
        } })))
  }
  if (d.account_key) drawOwner()
  row("From", [from.label, from.product].filter(Boolean).join(" · "), d.account_key ? ownerBox : null)
  if (from.holder) row("Account name", from.holder)
  // To
  const toBits = [to.name, to.bank && to.account ? `${to.bank} ${to.account}` : to.account || to.bank].filter(Boolean)
  row(tx.kind === "topup" ? "Top-up to" : tx.kind === "transfer" ? "Sent to" : "Paid to", toBits.join(" · "),
    to.own ? el("span", { class: "pill", style: { marginLeft: "6px" }, text: "your own account" }) : null)
  if (to.holder) row("Name on account", to.holder)
  if (to.location) row("Location", to.location)
  if (to.via) row("Via", `${to.via}${d.type && /qris/i.test(d.type) ? " (QRIS)" : ""}`)
  if (to.kind) row("Paid with", to.kind)
  // Money
  if (d.amount != null && (d.fee || d.amount !== d.total)) row("Amount", rp(d.amount))
  if (d.fee) row("Fee", rp(d.fee))
  if (d.total != null) row("Total", el("b", { text: rp(d.total) }))
  if (d.type && d.type !== tx.description) row("Type", d.type)
  row("Status", d.status)
  row("Bank time", d.when)
  if (d.purpose) row("Purpose", d.purpose)
  if (d.note) row("Note on transfer", d.note)
  for (const [k, v] of Object.entries(d.refs || {})) row(k, el("span", { class: "mono", text: v }))
  row("Sent by", d.channel)
  const card = el("div", { class: "card bank-card" }, el("div", { class: "bank-head" }, el("span", { class: `bank-badge ${(d.bank || "").toLowerCase()}`, text: d.bank || "Bank" }), el("b", { text: "Bank details" })),
    el("dl", { class: "kv" }, ...rows))
  if ((d.all || []).length) {
    const all = el("dl", { class: "kv small", hidden: true }, ...d.all.flatMap(([k, v]) => v ? [el("dt", { text: k }), el("dd", { text: v })] : [el("dd", { class: "full", text: k })]))
    const t = el("button", { class: "link-btn small", type: "button", text: "Every line from the email" })
    t.onclick = () => { all.hidden = !all.hidden }
    card.append(t, all)
  }
  return card
}
