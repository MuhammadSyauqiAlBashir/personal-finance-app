import { api, armed, busy, el, fmtDay, fmtTime, icon, localDateKey, moneyInput, nowLocalInput, rp, sheet, shrinkImage, toast } from "./lib.js?v=__VERSION__"
import { refreshBadge, route } from "./app.js?v=__VERSION__"

let categories = []
async function loadCategories() {
  categories = (await api("/categories")).categories
  return categories
}
const catById = (id) => categories.find((c) => c.id === id)

const REASONS = ["Bank transfer", "Parking", "Street food", "Online invoice by email", "Lost it", "Other"]
const GROUP_NAME = { must: "Must spend", needs: "Needs", wants: "Wants", savings: "Savings" }

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
let listStatus = "pending"
let search = ""

export async function renderInbox(page, arg) {
  if (arg === "all" || arg === "ignored" || arg === "failed") listStatus = arg === "all" ? "confirmed" : arg
  await loadCategories()
  const seg = el("div", { class: "segmented" })
  for (const [key, label] of [["pending", "To confirm"], ["confirmed", "Confirmed"], ["ignored", "Ignored"], ["failed", "Failed"]]) {
    seg.append(el("button", { type: "button", "aria-pressed": String(listStatus === key), text: label,
      onclick: () => { listStatus = key; renderInbox(page) } }))
  }
  const searchBox = el("input", { type: "search", placeholder: "Search merchant or note", value: search, enterkeyhint: "search" })
  searchBox.addEventListener("change", () => { search = searchBox.value; renderInbox(page) })
  const listWrap = el("div", {}, el("div", { class: "skeleton", style: { height: "220px", marginTop: "14px" } }))
  page.replaceChildren(
    el("div", { class: "topbar" }, el("div", {}, el("h1", { text: "Inbox" }),
      el("div", { class: "sub", text: "Bank emails, receipts and quick adds land here." }))),
    seg, listStatus !== "pending" ? el("div", { style: { marginTop: "10px" } }, searchBox) : null, listWrap)
  document.body.append(el("button", { class: "fab", type: "button", "aria-label": "Add a transaction", onclick: () => quickAdd() }, icon("plus")))

  const data = await api(`/transactions?status=${listStatus}&search=${encodeURIComponent(listStatus === "pending" ? "" : search)}`)
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
    list.append(txRow(tx, () => openTransaction(tx.id, () => renderInbox(page))))
  }
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
  } else if (tx.status === "confirmed" && tx.splits && tx.splits.length) {
    const names = tx.splits.map((s) => (catById(s.category) || {}).name).filter(Boolean)
    pills.push(el("span", { class: "pill", text: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] || "" }))
  }
  return el("button", { class: "list-item", type: "button", onclick },
    el("div", { class: "li-icon", text: txIcon(tx) }),
    el("div", { class: "li-main" },
      el("div", { class: "li-title", text: tx.merchant || tx.description || "Transaction" }),
      el("div", { class: "li-sub" }, el("span", { text: [tx.account, fmtTime(tx.occurred_at)].filter(Boolean).join(" · ") }), ...pills)),
    el("div", { class: "li-right" }, el("div", { class: `li-amount${tx.kind === "transfer" ? " transfer" : ""}`, text: rp(tx.amount) })))
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------
export function quickAdd(parent) {
  const sh = sheet(parent ? "Add a purchase" : "Add a transaction")
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
        openTransaction(res.transaction.id, () => route())
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
  const msg = el("p", { class: "form-msg" })
  const save = el("button", { class: "btn wide", type: "submit", text: "Add" })
  const form = el("form", {},
    el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
    el("label", { class: "field" }, el("span", { text: parent ? "Where" : "Merchant or payee" }), merchant),
    el("label", { class: "field" }, el("span", { text: "When" }), when),
    parent ? null : el("div", { class: "row" },
      el("label", { class: "field grow" }, el("span", { text: "Paid from" }), account),
      el("label", { class: "field grow" }, el("span", { text: "Type" }), kind)),
    msg, save)
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!amount.money()) { msg.textContent = "Enter the amount."; return }
    await busy(save, async () => {
      try {
        const tx = await api("/transactions", { method: "POST", json: {
          amount: amount.money(), merchant: merchant.value.trim(), occurred_at: when.value + ":00+07:00",
          account: parent ? parent.wallet : account.value, kind: parent ? "expense" : kind.value,
          wallet: !parent && kind.value === "topup" ? account.value : "", parent: parent ? parent.id : "" } })
        sh.close()
        openTransaction(tx.id, () => route())
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
  if (!categories.length) await loadCategories()
  const sh = sheet("Transaction", { tall: true, onClose: () => { refreshBadge(); if (changed && onDone) onDone() } })
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
    tx.holder ? el("dt", { text: "Holder" }) : null, tx.holder ? el("dd", { text: tx.holder }) : null))

  // Flags
  const flags = tx.flags || {}
  if (flags.possible_duplicate_of && pending) {
    const ignoreBtn = el("button", { class: "btn small", type: "button", text: "Ignore this one" })
    ignoreBtn.onclick = () => busy(ignoreBtn, async () => { await api(`/transactions/${tx.id}/ignore`, { method: "POST" }); ctx.markChanged(); toast("Ignored as duplicate"); ctx.close() })
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
    actions.append(armed(ig, "Tap again to ignore", async () => { await api(`/transactions/${tx.id}/ignore`, { method: "POST" }); ctx.markChanged(); toast("Ignored"); ctx.close() }))
    if (tx.source !== "email") {
      const del = el("button", { class: "btn small danger", type: "button", text: "Delete" })
      actions.append(armed(del, "Tap again to delete", async () => { await api(`/transactions/${tx.id}`, { method: "DELETE" }); ctx.markChanged(); toast("Deleted"); ctx.close() }))
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
    ok.onclick = () => busy(ok, async () => { await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: {} }); ctx.markChanged(); toast("Confirmed", "good"); ctx.close() })
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
    box.append(el("div", { class: "list" }, tx.purchases.map((p) => txRow(p, () => openTransaction(p.id, ctx.reload)))))
  }
  if (tx.status === "pending") {
    box.append(el("button", { class: "btn primary wide", type: "button", onclick: () => quickAdd(tx) }, icon("camera"), "Add a purchase"))
    if (tx.remaining > 0) {
      const sel = categorySelect("")
      const close = el("button", { class: "btn wide", type: "button", text: `Close: put the remaining ${rp(tx.remaining)} in…` })
      const msg = el("p", { class: "form-msg" })
      close.onclick = () => busy(close, async () => {
        if (!sel.value) { msg.textContent = "Choose a wallet for the rest."; return }
        try { await api(`/transactions/${tx.id}/close`, { method: "POST", json: { category: sel.value } }); ctx.markChanged(); toast("Top-up closed", "good"); ctx.close() }
        catch (err) { msg.textContent = err.message }
      })
      box.append(el("div", { class: "card" }, el("p", { class: "muted small", text: "Spent the rest on small things without receipts?" }),
        el("div", { style: { margin: "10px 0" } }, sel), close, msg))
    } else if (tx.remaining <= 0) {
      const ok = el("button", { class: "btn primary wide", type: "button" }, icon("check"), "Confirm top-up")
      const msg = el("p", { class: "form-msg" })
      ok.onclick = () => busy(ok, async () => {
        try { await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: {} }); ctx.markChanged(); toast("Confirmed", "good"); ctx.close() }
        catch (err) { msg.textContent = err.message }
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
    for (const r of REASONS) {
      const chip = el("button", { class: "chip", type: "button", text: r })
      chip.onclick = () => {
        for (const c of chips.children) c.classList.remove("on")
        chip.classList.add("on")
        other.hidden = r !== "Other"
        waiveReason = r === "Other" ? "" : r
      }
      chips.append(chip)
    }
    other.addEventListener("input", () => { waiveReason = other.value.trim() })
    waiveBox.append(el("p", { class: "muted small", text: "Why is there no receipt?" }), chips, other)
    noReceipt.onclick = () => { waiveBox.hidden = !waiveBox.hidden; if (waiveBox.hidden) waiveReason = "" }
    receiptCard.append(add, file, status, el("div", { style: { marginTop: "8px" } }, noReceipt), waiveBox)
  }

  // ---- Category / split ----
  const ai = tx.ai || {}
  const splitCard = el("div", { class: "card" })
  const rows = el("div")
  const leftInfo = el("p", { class: "split-left" })
  const recalc = () => {
    const sum = [...rows.children].reduce((s, r) => s + r._amount.money(), 0)
    const diff = tx.amount - sum
    leftInfo.textContent = diff === 0 ? "✓ Adds up" : diff > 0 ? `${rp(diff)} left to split` : `${rp(-diff)} too much`
    leftInfo.className = `split-left ${diff === 0 ? "ok" : "bad"}`
  }
  const addRow = (cat, amount) => {
    const sel = categorySelect(cat)
    const amt = moneyInput(amount)
    amt.addEventListener("input", recalc)
    const rm = el("button", { class: "icon-btn", type: "button", "aria-label": "Remove" }, icon("x"))
    const row = el("div", { class: "split-row" }, sel, el("div", { class: "money-wrap" }, amt), rm)
    row._sel = sel
    row._amount = amt
    rm.onclick = () => { if (rows.children.length > 1) { row.remove(); recalc() } }
    rows.append(row)
    recalc()
  }
  if (tx.status === "confirmed" || (tx.splits && tx.splits.length)) {
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
    }
    splitCard.append(el("div", { class: "row between" }, leftInfo, split))
    if (ai.suggest_new && !ai.category) {
      const create = el("button", { class: "btn small", type: "button", text: `Create "${ai.suggest_new.name}"` })
      create.onclick = () => busy(create, async () => {
        const c = await api("/categories", { method: "POST", json: { name: ai.suggest_new.name, group: ai.suggest_new.group, icon: "🏷️" } })
        await loadCategories()
        const first = rows.children[0]
        const replacement = categorySelect(c.id)
        first._sel.replaceWith(replacement)
        first._sel = replacement
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
    const note = el("input", { value: tx.note || "", maxlength: 1000, placeholder: "Optional" })
    const save = el("button", { class: "btn small", type: "button", text: "Save details" })
    const details = el("details", { class: "card" }, el("summary", { class: "muted", text: "Edit amount, merchant or note" }),
      el("div", { style: { marginTop: "12px" } },
        el("label", { class: "field" }, el("span", { text: "Amount" }), el("div", { class: "money-wrap" }, amount)),
        el("label", { class: "field" }, el("span", { text: "Merchant" }), merchant),
        el("label", { class: "field" }, el("span", { text: "Note" }), note), save))
    save.onclick = () => busy(save, async () => {
      await api(`/transactions/${tx.id}`, { method: "PATCH", json: { amount: amount.money(), merchant: merchant.value.trim(), note: note.value.trim() } })
      ctx.markChanged()
      toast("Saved")
      await ctx.reload()
    })
    out.push(details)

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
        await api(`/transactions/${tx.id}/confirm`, { method: "POST", json: { splits, waive_reason: waiveReason } })
        ctx.markChanged()
        toast("Confirmed", "good")
        ctx.close()
      } catch (err) { msg.textContent = err.message }
    })
    out.push(el("div", { class: "sticky-actions" }, msg, confirm))
  }
  return out
}
