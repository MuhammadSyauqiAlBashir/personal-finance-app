/// <reference path="../pb_data/types.d.ts" />
// Financial Management: household finance collections, prefixed `fin_`.
//
// Only the finance backend touches these collections. It signs in as a
// dedicated service user (users.role = "service"), so every rule below is
// "service only". People never reach these collections directly; the backend
// checks that they are household members first. This keeps the finance data
// away from other apps' logins and vice versa.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const role = users.fields.getByName("role")
  if (role && !role.values.includes("service")) {
    role.values = [...role.values, "service"]
    app.save(users)
  }

  const SERVICE = "@request.auth.role = 'service'"
  const rules = { listRule: SERVICE, viewRule: SERVICE, createRule: SERVICE, updateRule: SERVICE, deleteRule: SERVICE }
  const created = () => ({ type: "autodate", name: "created", onCreate: true, onUpdate: false })
  const updated = () => ({ type: "autodate", name: "updated", onCreate: true, onUpdate: true })
  const text = (name, max = 500, extra = {}) => ({ type: "text", name, max, ...extra })
  const num = (name, extra = {}) => ({ type: "number", name, ...extra })
  const money = (name, extra = {}) => ({ type: "number", name, onlyInt: true, ...extra })
  const json = (name, maxSize = 200000) => ({ type: "json", name, maxSize })
  const bool = (name) => ({ type: "bool", name })
  const date = (name, extra = {}) => ({ type: "date", name, ...extra })
  const select = (name, values, extra = {}) => ({ type: "select", name, values, maxSelect: 1, ...extra })
  const rel = (name, collection, extra = {}) => ({
    type: "relation", name, collectionId: collection.id, maxSelect: 1, cascadeDelete: false, ...extra,
  })

  const make = (name, fields, indexes = []) => {
    const c = new Collection({ type: "base", name, ...rules, fields: [...fields, created(), updated()], indexes })
    app.save(c)
    return c
  }

  // Household membership (who may use the app). Username kept here so the
  // service user never needs to read the users collection.
  const members = make("fin_members", [
    rel("user", users, { required: true, cascadeDelete: true }),
    text("username", 64, { required: true }),
  ], ["CREATE UNIQUE INDEX idx_fin_members_user ON fin_members (user)"])

  // Small key/value settings: family profile, app config, scheduler state.
  make("fin_kv", [
    text("key", 100, { required: true }),
    json("value", 500000),
  ], ["CREATE UNIQUE INDEX idx_fin_kv_key ON fin_kv (key)"])

  const categories = make("fin_categories", [
    text("name", 60, { required: true }),
    select("group", ["must", "needs", "wants", "savings"], { required: true }),
    text("icon", 16),
    text("color", 16),
    money("default_amount", { min: 0 }),
    text("hints", 500), // what belongs here, used in AI prompts
    num("sort", { onlyInt: true }),
    bool("archived"),
  ], ["CREATE UNIQUE INDEX idx_fin_categories_name ON fin_categories (name COLLATE NOCASE)"])

  // Budget months run payday to the day before the next payday.
  const periods = make("fin_periods", [
    text("start", 10, { required: true }), // YYYY-MM-DD (Asia/Jakarta)
    text("end", 10, { required: true }), // inclusive
    select("status", ["open", "closed"], { required: true }),
    json("closing"), // leftovers swept at close
  ], ["CREATE UNIQUE INDEX idx_fin_periods_start ON fin_periods (start)"])

  make("fin_incomes", [
    rel("period", periods, { required: true, cascadeDelete: true }),
    money("amount", { required: true, min: 1 }),
    text("source", 120, { required: true }),
    text("date", 10),
    text("note", 500),
    text("created_by", 64),
  ])

  make("fin_allocations", [
    rel("period", periods, { required: true, cascadeDelete: true }),
    rel("category", categories, { required: true }),
    money("amount", { min: 0 }),
  ], ["CREATE UNIQUE INDEX idx_fin_alloc_period_cat ON fin_allocations (period, category)"])

  // Money moved between wallets during a month (e.g. to cover overspending).
  make("fin_moves", [
    rel("period", periods, { required: true, cascadeDelete: true }),
    rel("from_category", categories, { required: true }),
    rel("to_category", categories, { required: true }),
    money("amount", { required: true, min: 1 }),
    text("note", 300),
    text("created_by", 64),
  ])

  const emails = make("fin_emails", [
    text("gmail_id", 100, { required: true }),
    bool("is_sample"),
    text("sender", 300),
    text("subject", 500),
    date("received_at"),
    text("body", 60000), // redacted (account/card numbers masked)
    select("status", ["new", "parsed", "skipped", "failed", "error"], { required: true }),
    select("method", ["rules", "ai", "none"]),
    json("parsed"),
    text("error", 1000),
  ], ["CREATE UNIQUE INDEX idx_fin_emails_gmail ON fin_emails (gmail_id)"])

  const transactions = make("fin_transactions", [
    select("status", ["pending", "confirmed", "ignored", "failed"], { required: true }),
    select("kind", ["expense", "income", "transfer"], { required: true }),
    money("amount", { required: true, min: 0 }),
    date("occurred_at", { required: true }),
    rel("period", periods),
    text("merchant", 200),
    text("description", 1000),
    text("account", 40), // BCA, Mandiri, Cash
    select("source", ["email", "manual", "screenshot"], { required: true }),
    rel("email", emails),
    json("ai"), // {category, confidence, suggest_new, reason, model}
    select("receipt_state", ["missing", "attached", "waived"], { required: true }),
    text("waive_reason", 200),
    json("flags"), // {possible_duplicate_of, amount_check, ...}
    text("note", 1000),
    text("created_by", 64),
    text("confirmed_by", 64),
    date("confirmed_at"),
  ], [
    "CREATE INDEX idx_fin_tx_status ON fin_transactions (status)",
    "CREATE INDEX idx_fin_tx_period ON fin_transactions (period)",
    "CREATE INDEX idx_fin_tx_occurred ON fin_transactions (occurred_at)",
  ])

  make("fin_splits", [
    rel("transaction", transactions, { required: true, cascadeDelete: true }),
    rel("category", categories, { required: true }),
    money("amount", { required: true, min: 0 }),
    text("note", 300),
  ], ["CREATE INDEX idx_fin_splits_tx ON fin_splits (transaction)"])

  make("fin_receipts", [
    rel("transaction", transactions, { required: true, cascadeDelete: true }),
    {
      type: "file", name: "image", maxSelect: 1, maxSize: 15 * 1024 * 1024, protected: true,
      mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["480x0"],
    },
    json("extracted"),
    json("match"),
    text("drive_file_id", 200),
    select("drive_state", ["pending", "uploaded", "failed", "skipped"]),
    text("uploaded_by", 64),
  ], ["CREATE INDEX idx_fin_receipts_tx ON fin_receipts (transaction)"])

  const bills = make("fin_bills", [
    text("name", 120, { required: true }),
    rel("category", categories, { required: true }),
    money("amount", { min: 0 }),
    num("due_day", { onlyInt: true, min: 1, max: 31 }),
    bool("active"),
    text("match_hint", 200), // merchant text that identifies the payment
  ])

  make("fin_bill_payments", [
    rel("bill", bills, { required: true, cascadeDelete: true }),
    rel("period", periods, { required: true, cascadeDelete: true }),
    rel("transaction", transactions, { cascadeDelete: true }),
  ], ["CREATE UNIQUE INDEX idx_fin_billpay ON fin_bill_payments (bill, period)"])

  const goals = make("fin_goals", [
    select("kind", ["emergency", "custom"], { required: true }),
    text("name", 120, { required: true }),
    money("target", { min: 0 }),
    text("target_date", 10),
    money("saved", { min: 0 }),
    num("sort", { onlyInt: true }),
    bool("archived"),
  ])

  make("fin_goal_moves", [
    rel("goal", goals, { required: true, cascadeDelete: true }),
    money("amount", { required: true }), // negative = withdrawal
    rel("period", periods),
    select("source", ["sweep", "manual"], { required: true }),
    text("note", 300),
    text("created_by", 64),
  ])

  // Learned merchant -> category from confirmations.
  make("fin_merchant_rules", [
    text("merchant_key", 200, { required: true }),
    rel("category", categories, { required: true }),
    num("count", { onlyInt: true, min: 0 }),
  ], ["CREATE UNIQUE INDEX idx_fin_merchant_key ON fin_merchant_rules (merchant_key)"])

  make("fin_push_subs", [
    rel("user", users, { required: true, cascadeDelete: true }),
    text("endpoint", 1000, { required: true }),
    text("p256dh", 200, { required: true }),
    text("auth", 100, { required: true }),
    text("ua", 300),
  ], ["CREATE UNIQUE INDEX idx_fin_push_endpoint ON fin_push_subs (endpoint)"])

  make("fin_passkeys", [
    rel("user", users, { required: true, cascadeDelete: true }),
    text("cred_id", 1000, { required: true }),
    text("public_key", 2000, { required: true }),
    num("sign_count", { onlyInt: true, min: 0 }),
    text("name", 100),
  ], ["CREATE UNIQUE INDEX idx_fin_passkeys_cred ON fin_passkeys (cred_id)"])

  make("fin_reports", [
    select("kind", ["daily", "monthly"], { required: true }),
    text("key", 20, { required: true }), // YYYY-MM-DD, or the period start
    json("data", 500000),
    text("ai_text", 20000),
  ], ["CREATE UNIQUE INDEX idx_fin_reports_key ON fin_reports (kind, key)"])

  make("fin_chat", [
    rel("user", users, { required: true, cascadeDelete: true }),
    select("role", ["user", "assistant"], { required: true }),
    text("content", 20000, { required: true }),
  ], ["CREATE INDEX idx_fin_chat_user ON fin_chat (user, created)"])

  // Dedupe for notifications and scheduled jobs ("sent daily report for X").
  make("fin_events", [
    text("key", 200, { required: true }),
  ], ["CREATE UNIQUE INDEX idx_fin_events_key ON fin_events (key)"])
}, (app) => {
  const names = [
    "fin_events", "fin_chat", "fin_reports", "fin_passkeys", "fin_push_subs", "fin_merchant_rules",
    "fin_goal_moves", "fin_goals", "fin_bill_payments", "fin_bills", "fin_receipts", "fin_splits",
    "fin_transactions", "fin_emails", "fin_moves", "fin_allocations", "fin_incomes", "fin_periods",
    "fin_categories", "fin_kv", "fin_members",
  ]
  for (const name of names) {
    try { app.delete(app.findCollectionByNameOrId(name)) } catch (_) {}
  }
})
