import { $, $$, api, el, fetchRetry, icon, resumeAfterUnlock, setAuthHandler } from "./lib.js?v=__VERSION__"
import { renderHome } from "./home.js?v=__VERSION__"
import { renderInbox, openTransaction } from "./inbox.js?v=__VERSION__"
import { renderWallets } from "./wallets.js?v=__VERSION__"
import { renderReports } from "./reports.js?v=__VERSION__"
import { renderAdvisor } from "./advisor.js?v=__VERSION__"
import { renderSettings } from "./settings.js?v=__VERSION__"
import { renderSetup } from "./setup.js?v=__VERSION__"

export const state = { me: null, locked: false }

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function show(which) {
  $("#splash").hidden = true
  for (const id of ["authView", "lockView", "setupView", "appView"]) $(`#${id}`).hidden = id !== which
}

for (const span of $$(".tab-ico")) span.replaceWith(icon(span.dataset.icon))

const ROUTES = {
  home: renderHome, inbox: renderInbox, wallets: renderWallets, reports: renderReports,
  advisor: renderAdvisor, settings: renderSettings,
}

let rendering = 0
export async function route() {
  if (!state.me || state.locked) return
  const pg = document.getElementById("page")
  if (pg) pg.scrollTop = 0
  const hash = location.hash.replace(/^#/, "") || "home"
  const [name, arg, arg2] = hash.split("/")
  if (name === "setup") { show("setupView"); return renderSetup($("#setupView"), arg) }
  show("appView")
  const tab = name === "tx" || name === "pending" ? "inbox" : name === "report" ? "reports" : ROUTES[name] ? name : "home"
  for (const a of $$(".tabbar a")) a.classList.toggle("on", a.dataset.tab === tab)
  // Each navigation renders into its own fresh container. If an older, slower
  // render finishes later it only fills its own (detached) container, so it can
  // never overwrite the screen you're on now.
  const my = ++rendering
  const page = el("div", { class: "view" })
  $("#page").replaceChildren(page)
  try {
    await ROUTES[tab](page, name === "report" ? arg : name === "tx" ? null : arg, arg2)
    if (my !== rendering) return
    if (name === "tx" && arg) openTransaction(arg)
  } catch (err) {
    if (err.status === 401 || err.status === 423 || err.status === 403) return
    page.replaceChildren(el("div", { class: "empty-state" }, el("div", { class: "big", text: "😕" }),
      el("h3", { text: "Couldn't load this page" }), el("p", { text: err.message }),
      el("button", { class: "btn small", style: { marginTop: "14px" }, onclick: route, text: "Try again" })))
  }
  refreshBadge()
}
window.addEventListener("hashchange", route)

export function go(hash) {
  if (location.hash === `#${hash}`) route()
  else location.hash = hash
}

export async function refreshBadge() {
  try {
    const data = await api("/transactions?status=pending", { quiet: true })
    const b = $("#pendingBadge")
    b.textContent = data.total > 99 ? "99+" : String(data.total)
    b.hidden = !data.total
    if ("setAppBadge" in navigator) navigator.setAppBadge(data.total).catch(() => {})
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function renderAuth(message = "") {
  show("authView")
  const user = el("input", { name: "username", autocomplete: "username", autocapitalize: "none", autocorrect: "off",
    spellcheck: "false", maxlength: 32, required: true })
  const pass = el("input", { name: "password", type: "password", autocomplete: "current-password", maxlength: 72, required: true })
  const msg = el("p", { class: "form-msg", role: "alert", text: message })
  const submit = el("button", { class: "btn primary wide", type: "submit", text: "Log in" })
  const form = el("form", { novalidate: true },
    el("label", { class: "field" }, el("span", { text: "Username" }), user),
    el("label", { class: "field" }, el("span", { text: "Password" }), pass), msg, submit,
    el("p", { class: "hint", style: { textAlign: "center", marginTop: "14px" },
      text: "Same account as lyrsync. New here? Register there, and the admin adds you." }))
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    msg.textContent = ""
    submit.disabled = true
    try {
      const data = await api("/login", { method: "POST", json: { username: user.value.trim().toLowerCase(), password: pass.value }, quiet: true })
      pass.value = ""
      state.me = data.user
      await afterLogin()
    } catch (err) {
      msg.textContent = err.message
    } finally {
      submit.disabled = false
    }
  })
  $("#authView").replaceChildren(el("div", { class: "card auth-card" },
    el("div", { class: "brand" }, el("img", { src: "/icons/icon-192.png", width: 64, height: 64, alt: "" }),
      el("h1", { text: "Financial Management" }), el("p", { text: "Your household money, in one place." })), form))
}

// ---------------------------------------------------------------------------
// Face ID lock
// ---------------------------------------------------------------------------
const b64u = {
  toBuf: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer,
  fromBuf: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
}

function credToJSON(cred) {
  if (cred.toJSON) { try { return cred.toJSON() } catch (_) {} }
  const r = cred.response
  const out = { id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults() }
  out.response = { clientDataJSON: b64u.fromBuf(r.clientDataJSON) }
  if (r.attestationObject) {
    out.response.attestationObject = b64u.fromBuf(r.attestationObject)
    if (r.getTransports) out.response.transports = r.getTransports()
  } else {
    out.response.authenticatorData = b64u.fromBuf(r.authenticatorData)
    out.response.signature = b64u.fromBuf(r.signature)
    if (r.userHandle) out.response.userHandle = b64u.fromBuf(r.userHandle)
  }
  return out
}

export async function registerPasskey() {
  if (!window.PublicKeyCredential) throw new Error("This device doesn't support Face ID sign-in here.")
  const opts = await api("/passkey/register/options", { method: "POST" })
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON ? PublicKeyCredential.parseCreationOptionsFromJSON(opts) : {
    ...opts, challenge: b64u.toBuf(opts.challenge), user: { ...opts.user, id: b64u.toBuf(opts.user.id) },
    excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })),
  }
  const cred = await navigator.credentials.create({ publicKey })
  await api("/passkey/register/verify", { method: "POST", json: { credential: credToJSON(cred), name: navigator.platform || "iPhone" } })
}

async function unlockWithPasskey() {
  const opts = await api("/passkey/auth/options", { method: "POST", quiet: true })
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON ? PublicKeyCredential.parseRequestOptionsFromJSON(opts) : {
    ...opts, challenge: b64u.toBuf(opts.challenge),
    allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })),
  }
  const cred = await navigator.credentials.get({ publicKey })
  await api("/passkey/auth/verify", { method: "POST", json: { credential: credToJSON(cred) }, quiet: true })
}

let lockSeq = 0
function renderLock() {
  lockSeq++
  state.locked = true
  // If the app (or setup) is open, lock on top of it so nothing typed is lost; otherwise show the lock page.
  const overlay = !$("#appView").hidden || !$("#setupView").hidden
  if (overlay) { $("#lockView").classList.add("lock-overlay"); $("#lockView").hidden = false } else { $("#lockView").classList.remove("lock-overlay"); show("lockView") }
  const msg = el("p", { class: "form-msg", role: "alert" })
  const btn = el("button", { class: "btn primary wide", type: "button" }, icon("face"), "Unlock with Face ID")
  const tryUnlock = async () => {
    msg.textContent = ""
    btn.disabled = true
    try {
      await unlockWithPasskey()
      state.locked = false
      if (overlay) { $("#lockView").hidden = true; $("#lockView").classList.remove("lock-overlay"); resumeAfterUnlock() }
      else await afterLogin()
    } catch (err) {
      msg.textContent = err.name === "NotAllowedError" ? "Face ID was cancelled. Try again." : err.message
    } finally {
      btn.disabled = false
    }
  }
  btn.onclick = tryUnlock
  // Try Face ID straight away. iOS only allows this right after the app opens; if it refuses (it fails instantly,
  // before any Face ID sheet), quietly leave the button for a tap.
  const auto = async () => {
    if (!window.PublicKeyCredential || state.lockAuto === lockSeq) return
    state.lockAuto = lockSeq
    const t0 = Date.now()
    msg.textContent = ""
    btn.disabled = true
    try {
      await unlockWithPasskey()
      state.locked = false
      if (overlay) { $("#lockView").hidden = true; $("#lockView").classList.remove("lock-overlay"); resumeAfterUnlock() }
      else await afterLogin()
    } catch (err) {
      if (!(err.name === "NotAllowedError" && Date.now() - t0 < 1500)) msg.textContent = err.name === "NotAllowedError" ? "Face ID was cancelled. Tap to try again." : err.message
    } finally {
      btn.disabled = false
    }
  }
  setTimeout(auto, 250)
  const logout = el("button", { class: "link-btn", type: "button", style: { marginTop: "16px" }, text: "Log out instead" })
  logout.onclick = async () => { await api("/logout", { method: "POST", quiet: true }).catch(() => {}); state.me = null; state.locked = false; renderAuth() }
  $("#lockView").replaceChildren(el("div", { class: "card lock-card" }, icon("lock", "big"),
    el("h2", { text: "Locked" }), el("p", { class: "muted", style: { margin: "6px 0 18px" }, text: "Your finances are protected. Unlock to continue." }),
    btn, msg, logout))
}

// Size the app to the real window height (see #appView in app.css). Re-measured on rotate/resize, but not while the
// keyboard is open (then the visual viewport shrinks and the frame should stay put).
function fitHeight() {
  const h = Math.max(window.innerHeight, document.documentElement.clientHeight)
  const kb = window.visualViewport && window.visualViewport.height < h * 0.75
  if (!kb) document.documentElement.style.setProperty("--app-h", `${h}px`)
}
fitHeight()
window.addEventListener("resize", fitHeight)
window.addEventListener("orientationchange", () => setTimeout(fitHeight, 300))
window.addEventListener("pageshow", fitHeight)

// No pinch / double-tap zoom (iOS ignores user-scalable=no in some cases), and keep the page itself from drifting
// after the keyboard closes (that's what lifted the tab bar).
for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, (e) => e.preventDefault(), { passive: false })
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })
const settle = () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0) }
window.visualViewport && window.visualViewport.addEventListener("resize", () => setTimeout(settle, 60))
document.addEventListener("focusout", () => setTimeout(settle, 120))
window.addEventListener("hashchange", settle)

// While someone is actively typing/tapping, tell the server once a minute so a long form doesn't lock mid-way.
let lastInput = Date.now()
for (const ev of ["keydown", "input", "pointerdown", "touchstart", "scroll"]) document.addEventListener(ev, () => { lastInput = Date.now() }, { passive: true, capture: true })
setInterval(() => {
  if (state.me && !state.locked && !document.hidden && Date.now() - lastInput < 4 * 60 * 1000) api("/alive", { method: "POST", quiet: true }).catch(() => {})
}, 60 * 1000)

// Lock right away when the app goes to the background for a while.
let hiddenAt = 0
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { hiddenAt = Date.now(); return }
  if (state.me && !state.locked && hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) {
    try {
      const me = await api("/me", { quiet: true })
      if (me.locked) renderLock()
    } catch (_) {}
  }
  if (state.me && !state.locked) refreshBadge()
})

setAuthHandler((status, data) => {
  if (status === 423) { if (!state.locked) renderLock() }
  else if (status === 401) { state.me = null; renderAuth(data.error || "Please log in.") }
  else if (status === 403 && /access/.test(data.error || "")) { state.me = null; renderAuth(data.error) }
})

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Notifications need the Home Screen app (Share → Add to Home Screen), iOS 16.4 or later.")
  }
  const perm = await Notification.requestPermission()
  if (perm !== "granted") throw new Error("Notifications are blocked. Allow them in Settings → Notifications → Finance.")
  const reg = await navigator.serviceWorker.ready
  const { key } = await api("/push/key")
  const keyBytes = new Uint8Array(b64u.toBuf(key))
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes })
  const j = sub.toJSON()
  await api("/push/subscribe", { method: "POST", json: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 300) } })
}

export async function pushStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported"
  if (Notification.permission === "denied") return "blocked"
  const reg = await navigator.serviceWorker.ready
  return (await reg.pushManager.getSubscription()) ? "on" : "off"
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function afterLogin() {
  const setup = await api("/setup")
  if (!setup.done && !location.hash.startsWith("#setup")) location.hash = "setup"
  await route()
}

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "navigate" && e.data.url) location.hash = e.data.url.split("#")[1] || "home"
    })
  }
  try {
    const res = await fetchRetry("/api/me", { credentials: "same-origin" }, 4)
    const data = await res.json().catch(() => ({}))
    if (res.status === 200) {
      state.me = data.user
      if (data.locked) return renderLock()
      await afterLogin()
    } else {
      renderAuth(res.status === 403 ? data.error : "")
    }
  } catch (_) {
    renderAuth("No connection yet. Retrying when you're back online…")
    window.addEventListener("online", () => boot(), { once: true })
    setTimeout(() => { if (!state.me) boot() }, 5000)
  }
}

boot()
