// Shared helpers: API calls, formatting, DOM building, sheets, toasts.

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
// Views build child lists with optional parts (`cond ? node : null`); make
// append/replaceChildren skip those instead of printing "null".
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ["append", "replaceChildren"]) {
    const orig = proto[name]
    proto[name] = function (...nodes) {
      return orig.apply(this, nodes.flat().filter((n) => n !== null && n !== undefined && n !== false))
    }
  }
}

// el("div", {class: "x", onclick: fn}, child, "text", ...). Text is always set
// with textContent, never innerHTML, so data from emails can't inject markup.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === "class") node.className = v
    else if (k === "text") node.textContent = v
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v)
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v)
    else if (k === "value") node.value = v
    else if (k === "checked") node.checked = !!v
    else node.setAttribute(k, v === true ? "" : v)
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

export const SVGNS = "http://www.w3.org/2000/svg"
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v)
  for (const c of children.flat()) if (c) node.append(c)
  return node
}

// Small inline icons (stroke paths, 24x24).
const ICONS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  inbox: "M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z",
  wallet: "M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zm14 7h.01",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  plus: "M12 5v14M5 12h14",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  check: "M5 13l4 4L19 7",
  x: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  alert: "M12 9v4m0 4h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  send: "M4 12l16-8-6 16-3-7z",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  face: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 10v1M15 10v1M12 10v4h-1M9.5 16.5c1.5 1 3.5 1 5 0",
  split: "M6 3v6a6 6 0 0 0 6 6h6M18 15l-3-3M18 15l-3 3M6 21v-6",
  move: "M7 7h13M17 4l3 3-3 3M17 17H4M7 14l-3 3 3 3",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
}
export function icon(name, cls = "") {
  return svg("svg", { viewBox: "0 0 24 24", class: `ico ${cls}`, "aria-hidden": "true" }, svg("path", { d: ICONS[name] || "" }))
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat("id-ID")
export const rp = (n) => (n < 0 ? "−Rp" : "Rp") + nf.format(Math.abs(Math.round(n || 0)))
export function rpShort(n) {
  const a = Math.abs(n || 0)
  const sign = n < 0 ? "−" : ""
  const trim = (x) => (Math.round(x * 10) / 10).toString().replace(".", ",")
  if (a >= 1e9) return `${sign}${trim(a / 1e9)}M`
  if (a >= 1e6) return `${sign}${trim(a / 1e6)}jt`
  if (a >= 1e3) return `${sign}${Math.round(a / 1e3)}rb`
  return `${sign}${Math.round(a)}`
}
export const pct = (n) => `${Math.round(n || 0)}%`
// Full amount when short, compact (Rp24jt, Rp325rb) when it wouldn't fit a small tile.
export const rpFit = (n, max = 8) => (rp(n).length <= max ? rp(n) : (n < 0 ? "−Rp" : "Rp") + rpShort(Math.abs(n)))

export function parseDate(s) {
  if (!s) return null
  if (s.length === 10) return new Date(s + "T00:00:00+07:00")
  return new Date(String(s).replace(" ", "T"))
}
const TZ = "Asia/Jakarta"
export const fmtDate = (s, opts = { day: "numeric", month: "short" }) =>
  s ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }).format(parseDate(s)) : ""
export const fmtTime = (s) => s ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(parseDate(s)) : ""
export const fmtDay = (s) => fmtDate(s, { weekday: "short", day: "numeric", month: "short" })
export function localDateKey(s) {
  const d = parseDate(s)
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d) // YYYY-MM-DD
}
export const todayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date())
export function nowLocalInput() {
  const d = new Date()
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d)
  const g = (t) => parts.find((p) => p.type === t).value
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`
}
export function relTime(s) {
  const d = parseDate(s)
  const sec = (Date.now() - d.getTime()) / 1000
  if (sec < 60) return "just now"
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`
  return fmtDate(s)
}
export const greeting = () => {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date()))
  return h < 11 ? "Good morning" : h < 15 ? "Good afternoon" : h < 19 ? "Good evening" : "Good night"
}

// Money input: shows 1.250.000 while typing, value() gives the integer.
export function moneyInput(value = 0, props = {}) {
  const input = el("input", { inputmode: "numeric", autocomplete: "off", class: "money-input", ...props })
  const set = (n) => { input.value = n ? nf.format(n) : "" }
  input.addEventListener("input", () => {
    const n = Number(input.value.replace(/\D/g, "")) || 0
    const pos = input.value.length - input.selectionStart
    set(n)
    const p = Math.max(0, input.value.length - pos)
    try { input.setSelectionRange(p, p) } catch (_) {}
  })
  set(value)
  input.money = () => Number(input.value.replace(/\D/g, "")) || 0
  input.setMoney = set
  return input
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

let onAuthProblem = () => {}
export const setAuthHandler = (fn) => { onAuthProblem = fn }
// Requests that hit the Face ID lock wait here and are sent again once the person unlocks.
let unlockWaiters = []
export function resumeAfterUnlock() { const w = unlockWaiters; unlockWaiters = []; w.forEach((r) => r()) }

// After the app has been asleep a long time, iOS often reuses a connection the
// server already closed, so the first request fails. Retry quickly before
// reporting "no connection".
export async function fetchRetry(url, opts = {}, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, opts)
    } catch (err) {
      if (i >= tries - 1) throw new ApiError(0, "No connection. Check your internet.")
      await sleep(600 * (i + 1))
    }
  }
}

export async function api(path, { method = "GET", json, body, quiet = false } = {}) {
  const opts = { method, credentials: "same-origin", headers: { "X-Fin": "1" } }
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json"
    opts.body = JSON.stringify(json)
  } else if (body !== undefined) {
    opts.body = body
  }
  const res = await fetchRetry("/api" + path, opts, method === "GET" ? 3 : 1)  // never repeat a save
  let data = {}
  try { data = await res.json() } catch (_) {}
  if (res.status === 423 && !quiet && !arguments[1]?._retried) {
    // Locked before the server did anything (safe to resend): show Face ID, then send the same request again.
    onAuthProblem(423, data)
    await new Promise((r) => unlockWaiters.push(r))
    return api(path, { method, json, body, quiet, _retried: true })
  }
  if ((res.status === 401 || res.status === 423 || res.status === 403) && !quiet) onAuthProblem(res.status, data)
  if (!res.ok) throw new ApiError(res.status, data.error || `Something went wrong (${res.status}).`, data)
  return data
}

// ---------------------------------------------------------------------------
// Toast, sheets, confirm
// ---------------------------------------------------------------------------
let toastTimer
export function toast(msg, kind = "") {
  const t = $("#toast")
  t.textContent = msg
  t.className = `toast ${kind}`
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), 2800)
}

// A bottom sheet built on <dialog>. Returns {dialog, body, close}.
export function sheet(title, { tall = false, onClose } = {}) {
  const body = el("div", { class: "sheet-body" })
  const closeBtn = el("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("x"))
  const dialog = el("dialog", { class: `sheet${tall ? " tall" : ""}` },
    el("div", { class: "sheet-grab" }),
    el("div", { class: "sheet-head" }, el("h2", { text: title }), closeBtn), body)
  const close = () => { if (dialog.open) dialog.close() }
  closeBtn.onclick = close
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close() })
  dialog.addEventListener("close", () => { dialog.remove(); onClose && onClose() })
  document.body.append(dialog)
  dialog.setAttribute("tabindex", "-1")
  dialog.showModal()
  dialog.focus() // not the close button (avoids a focus ring on open)
  return { dialog, body, close, setTitle: (t) => { $("h2", dialog).textContent = t } }
}

// Two-tap confirm on a button (no browser dialogs).
export function armed(button, label, action) {
  let armedAt = 0
  const original = button.textContent
  button.addEventListener("click", async () => {
    if (Date.now() - armedAt > 3000) {
      armedAt = Date.now()
      button.textContent = label
      button.classList.add("armed")
      setTimeout(() => { if (Date.now() - armedAt >= 3000) { button.textContent = original; button.classList.remove("armed") } }, 3100)
      return
    }
    armedAt = 0
    button.classList.remove("armed")
    button.textContent = original
    await action()
  })
  return button
}

export async function busy(button, fn) {
  const was = button.disabled
  button.disabled = true
  button.classList.add("loading")
  try { return await fn() } finally { button.disabled = was; button.classList.remove("loading") }
}

// Very small, safe markdown for AI text: headings, bullets, bold, paragraphs.
export function markdown(text) {
  const root = el("div", { class: "md" })
  let list = null
  const inline = (s) => {
    const frag = document.createDocumentFragment()
    const parts = String(s).split(/(\*\*[^*]+\*\*)/g)
    for (const p of parts) {
      if (p.startsWith("**") && p.endsWith("**")) frag.append(el("strong", { text: p.slice(2, -2) }))
      else frag.append(document.createTextNode(p.replace(/\*([^*]+)\*/g, "$1")))
    }
    return frag
  }
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd()
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      if (!list) { list = el("ul"); root.append(list) }
      list.append(el("li", {}, inline(line.replace(/^\s*([-*•]|\d+\.)\s+/, ""))))
      continue
    }
    list = null
    if (!line.trim()) continue
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) root.append(el(h[1].length <= 2 ? "h3" : "h4", {}, inline(h[2])))
    else if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue
      const cells = line.split("|").slice(1, -1).map((c) => c.trim())
      let table = root.lastChild && root.lastChild.tagName === "DIV" && root.lastChild.classList.contains("md-table") ? root.lastChild.firstChild : null
      if (!table) { table = el("table"); root.append(el("div", { class: "md-table" }, table)) }
      table.append(el("tr", {}, cells.map((c) => el(table.children.length ? "td" : "th", {}, inline(c)))))
    } else root.append(el("p", {}, inline(line)))
  }
  return root
}

// Resize a photo in the browser before upload (max 1600px, JPEG ~0.82).
export async function shrinkImage(file, max = 1600) {
  if (!file.type.startsWith("image/")) throw new Error("Please choose a photo.")
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error("Couldn't open that photo."))
      i.src = url
    })
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82))
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Store per-device conveniences (never important data).
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch (_) { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (_) {} },
}
