import { api, el, fmtDate, greeting, icon, markdown, rp, todayKey } from "./lib.js?v=__VERSION__"
import { meter, ring } from "./charts.js?v=__VERSION__"
import { go, state } from "./app.js?v=__VERSION__"
import { quickAdd } from "./inbox.js?v=__VERSION__"

export async function renderHome(page) {
  const [s, goals, bills] = await Promise.all([api("/summary"), api("/goals"), api("/bills")])
  const elapsed = s.days_total - s.days_left
  const fraction = s.days_total ? elapsed / s.days_total : 0

  const settings = el("button", { class: "icon-btn", type: "button", "aria-label": "Settings", onclick: () => go("settings") }, icon("gear"))
  const top = el("div", { class: "topbar" },
    el("div", {}, el("h1", { text: greeting() }),
      el("div", { class: "sub", text: `${state.me.username} · ${fmtDate(s.period.start)} – ${fmtDate(s.period.end)}` })),
    settings)

  const hero = el("div", { class: "card glass hero" },
    el("div", { class: "grow" },
      el("div", { class: "hero-label", text: "Safe to spend today" }),
      el("div", { class: "hero-value", text: rp(s.safe_today) }),
      el("div", { class: "hero-sub", text: s.days_left ? `From your Needs & Wants wallets, spread over ${s.days_left} day${s.days_left === 1 ? "" : "s"}.` : "This budget month has ended." })),
    el("div", { class: "ring-wrap" }, ring(fraction, `${elapsed} of ${s.days_total} days`),
      el("div", { class: "ring-text" }, el("span", {}, el("b", { text: String(s.days_left) }), "days left"))))

  const tiles = el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("div", { class: "tile-label", text: "Income" }), el("div", { class: "tile-value", text: rp(s.income) })),
    el("div", { class: "tile" }, el("div", { class: "tile-label", text: "Spent" }), el("div", { class: "tile-value", text: rp(s.spent) })),
    el("div", { class: `tile${s.to_assign ? " alert" : ""}` }, el("div", { class: "tile-label", text: s.to_assign < 0 ? "Over-assigned" : "To assign" }),
      el("div", { class: "tile-value", text: rp(Math.abs(s.to_assign)) })))

  const alerts = []
  if (!s.income) {
    alerts.push(banner("info", "calendar", "Enter this month's income", "Then plan your wallets for the month.", () => go("wallets/income")))
  } else if (s.to_assign > 0) {
    alerts.push(banner("warn", "wallet", `${rp(s.to_assign)} not assigned yet`, "Give every rupiah a job in your wallets.", () => go("wallets/plan")))
  } else if (s.to_assign < 0) {
    alerts.push(banner("danger", "alert", `Wallets exceed income by ${rp(-s.to_assign)}`, "Reduce some wallets so the plan fits.", () => go("wallets/plan")))
  }
  if (s.pending) {
    alerts.push(banner(s.pending >= 3 ? "warn" : "info", "inbox", `${s.pending} transaction${s.pending === 1 ? "" : "s"} to confirm`,
      "Check the category and attach the receipt.", () => go("inbox")))
  }
  const over = s.wallets.filter((w) => w.left < 0 && w.category.group !== "savings")
  if (over.length) {
    alerts.push(banner("danger", "alert", `${over.length} wallet${over.length === 1 ? " is" : "s are"} overspent`,
      over.map((w) => w.category.name).join(", ") + ". Move money to cover it.", () => go("wallets")))
  }
  const today = todayKey()
  const dueSoon = bills.bills.filter((b) => b.active && !b.paid && b.due_day && daysUntilDue(b.due_day, today) <= 3)
  if (dueSoon.length) {
    alerts.push(banner("warn", "calendar", `${dueSoon.length} bill${dueSoon.length === 1 ? "" : "s"} due soon`,
      dueSoon.map((b) => `${b.name} (${rp(b.amount)})`).join(", "), () => go("wallets/bills")))
  }

  // Wallets closest to running out (needs/wants), up to 5.
  const flex = s.wallets.filter((w) => w.budget > 0 && w.category.group !== "savings")
    .sort((a, b) => b.pct - a.pct).slice(0, 5)
  const walletList = el("div", { class: "list" }, flex.length ? flex.map((w) => walletRow(w, fraction)) :
    el("div", { class: "empty-state" }, el("p", { text: "Plan your wallets to see them here." })))

  const goalCards = goals.goals.map((g) => {
    const p = g.target ? Math.min(1, g.saved / g.target) : 0
    return el("div", { class: "wallet" },
      el("div", { class: "wallet-top" }, el("span", { class: "emoji", text: g.kind === "emergency" ? "🛟" : "🎯" }),
        el("span", { class: "wallet-name", text: g.name }), el("span", { class: "wallet-left", text: `${Math.round(p * 100)}%` })),
      meter(g.saved, g.target || 1),
      el("div", { class: "wallet-sub" }, el("span", { text: `${rp(g.saved)} saved` }), el("span", { text: g.target ? `of ${rp(g.target)}` : "" })))
  })

  const note = el("div", { class: "card ai-card", hidden: true })
  page.replaceChildren(top, hero, tiles, ...alerts,
    el("div", { class: "section" },
      el("div", { class: "section-head" }, el("h2", { text: "Wallets" }), el("a", { class: "link-btn", href: "#wallets", text: "All" })),
      walletList),
    goalCards.length ? el("div", { class: "section" },
      el("div", { class: "section-head" }, el("h2", { text: "Goals" }), el("a", { class: "link-btn", href: "#wallets/goals", text: "Manage" })),
      el("div", { class: "list" }, goalCards)) : null,
    el("div", { class: "section" }, note))

  const fab = el("button", { class: "fab", type: "button", "aria-label": "Add a transaction", onclick: () => quickAdd() }, icon("plus"))
  document.body.append(fab)

  // Today's AI note (cached server-side per day), loaded after the page shows.
  api(`/reports/daily?note=1`).then((d) => {
    if (d.note) {
      note.replaceChildren(el("div", { class: "ai-head" }, icon("spark"), "Today"), markdown(d.note))
      note.hidden = false
    }
  }).catch(() => {})
}

function daysUntilDue(day, todayStr) {
  const t = new Date(todayStr + "T00:00:00+07:00")
  const y = t.getUTCFullYear(), m = t.getUTCMonth()
  const last = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate()
  let due = new Date(Date.UTC(y, m, Math.min(day, last(y, m))))
  const today = new Date(Date.UTC(y, m, t.getUTCDate()))
  if (due < today) due = new Date(Date.UTC(y, m + 1, Math.min(day, last(y, m + 1))))
  return Math.round((due - today) / 86400000)
}

function banner(kind, ic, title, sub, onclick) {
  return el("button", { class: `banner ${kind}`, type: "button", onclick }, icon(ic),
    el("div", { class: "grow" }, el("div", { class: "banner-title", text: title }), el("div", { class: "banner-sub", text: sub })),
    icon("chevron"))
}

export function walletRow(w, fraction, onclick) {
  const c = w.category
  const row = el(onclick ? "button" : "div", { class: "wallet", type: onclick ? "button" : undefined, onclick },
    el("div", { class: "wallet-top" }, el("span", { class: "emoji", text: c.icon || "•" }),
      el("span", { class: "wallet-name", text: c.name }),
      w.left < 0 ? el("span", { class: "pill bad" }, icon("alert"), "Over") : null,
      el("span", { class: `wallet-left${w.left < 0 ? " neg" : ""}`, text: rp(w.left) })),
    meter(w.spent, w.budget, { pace: c.group === "savings" ? null : fraction }),
    el("div", { class: "wallet-sub" }, el("span", { text: `${rp(w.spent)} spent` }), el("span", { text: `of ${rp(w.budget)}` })))
  return row
}
