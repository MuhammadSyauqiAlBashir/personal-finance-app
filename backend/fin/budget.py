"""Budget months (cycles), wallet balances and the month-end sweep.

A cycle starts on a configurable day of the month (default 25) and ends the
day before the next start. Days 29-31 fall back to the month's last day in
short months. Each cycle is stored in fin_periods with explicit dates, so
changing the start day never rewrites past months.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import config
from .pb import pb, q

GROUPS = ("must", "needs", "wants", "savings")
# What the Inbox shows as "to confirm": purchases inside an e-wallet top-up are
# counted with their top-up, not separately.
PENDING_FILTER = "status = 'pending' && (parent = '' || parent.kind != 'topup')"


def today() -> date:
    return datetime.now(config.TZ).date()


def clamp_day(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def add_months(year: int, month: int, n: int) -> tuple[int, int]:
    m = month - 1 + n
    return year + m // 12, m % 12 + 1


def cycle_start_on_or_before(d: date, start_day: int) -> date:
    this = clamp_day(d.year, d.month, start_day)
    if d >= this:
        return this
    y, m = add_months(d.year, d.month, -1)
    return clamp_day(y, m, start_day)


def next_start_after(d: date, start_day: int) -> date:
    """The first cycle start strictly after d."""
    this = clamp_day(d.year, d.month, start_day)
    if this > d:
        return this
    y, m = add_months(d.year, d.month, 1)
    return clamp_day(y, m, start_day)


async def demo_period_ids() -> set[str]:
    """Budget months filled with demo data (preview only; ignored by the advisor,
    notifications, learning and the savings sweep)."""
    return set((await pb.kv_get("demo_periods", [])) or [])


async def is_demo(period_id: str) -> bool:
    return period_id in await demo_period_ids()


async def real_period() -> dict:
    """The current budget month, or the next real one while the current month is demo."""
    p = await period_for()
    demo = await demo_period_ids()
    while p["id"] in demo:
        p = await period_for(parse(p["end"]) + timedelta(days=1))
    return p


async def start_day() -> int:
    cfg = await pb.kv_get("cycle", {}) or {}
    day = int(cfg.get("start_day") or config.PAYDAY)
    return max(1, min(31, day))


def iso(d: date) -> str:
    return d.isoformat()


def parse(d: str) -> date:
    return date.fromisoformat(d[:10])


async def period_for(d: date | None = None, create: bool = True) -> dict | None:
    """The cycle containing day d, creating cycles as needed."""
    d = d or today()
    ds = iso(d)
    rec = await pb.first("fin_periods", f"start <= {q(ds)} && end >= {q(ds)}")
    if rec or not create:
        return rec
    day = await start_day()
    last = await pb.first("fin_periods", f"end < {q(ds)}", sort="-end")
    start = parse(last["end"]) + timedelta(days=1) if last else cycle_start_on_or_before(d, day)
    # Fill any gap cycle by cycle (e.g. the app wasn't opened for a while).
    while True:
        end = next_start_after(start, day) - timedelta(days=1)
        # A future cycle that already exists caps this one.
        later = await pb.first("fin_periods", f"start > {q(iso(start))}", sort="start")
        if later and parse(later["start"]) <= end:
            end = parse(later["start"]) - timedelta(days=1)
        rec = await pb.create("fin_periods", {"start": iso(start), "end": iso(end),
                                              "status": "closed" if end < today() else "open"})
        if start <= d <= end:
            return rec
        start = end + timedelta(days=1)


async def preview_cycle_change(new_day: int) -> dict:
    """What changes if the start day becomes new_day (applied from today)."""
    cur = await period_for()
    t = today()
    new_end = next_start_after(t, new_day) - timedelta(days=1)
    if new_end < parse(cur["start"]):
        new_end = parse(cur["start"])
    nxt_start = new_end + timedelta(days=1)
    nxt_end = next_start_after(nxt_start, new_day) - timedelta(days=1)
    return {
        "current": {"id": cur["id"], "start": cur["start"], "end": cur["end"], "new_end": iso(new_end)},
        "next": {"start": iso(nxt_start), "end": iso(nxt_end)},
    }


async def apply_cycle_change(new_day: int) -> dict:
    preview = await preview_cycle_change(new_day)
    cur = preview["current"]
    # Drop not-yet-started future cycles; they'll be recreated with the new day.
    for fut in await pb.all("fin_periods", filter=f"start > {q(cur['end'])}"):
        if not (await pb.list("fin_incomes", filter=f"period = {q(fut['id'])}", per_page=1))["items"]:
            await pb.delete("fin_periods", fut["id"])
    await pb.update("fin_periods", cur["id"], {"end": cur["new_end"]})
    await pb.kv_set("cycle", {"start_day": new_day})
    return preview


# ---------------------------------------------------------------------------
# Wallet balances
# ---------------------------------------------------------------------------

async def categories(include_archived: bool = False) -> list[dict]:
    filt = "" if include_archived else "archived = false"
    return await pb.all("fin_categories", filter=filt, sort="sort,name")


async def spent_by_category(period_id: str) -> dict[str, int]:
    """Confirmed spending per category in a cycle (expense splits only)."""
    txs = await pb.all("fin_transactions",
                       filter=f"period = {q(period_id)} && status = 'confirmed' && kind = 'expense'",
                       fields="id")
    ids = {t["id"] for t in txs}
    out: dict[str, int] = defaultdict(int)
    if not ids:
        return out
    for s in await pb.all("fin_splits", filter=f"transaction.period = {q(period_id)}",
                          fields="transaction,category,amount"):
        if s["transaction"] in ids:
            out[s["category"]] += int(s["amount"])
    return out


async def summary(period: dict) -> dict:
    pid = period["id"]
    cats = await categories(include_archived=True)
    incomes = await pb.all("fin_incomes", filter=f"period = {q(pid)}", sort="date")
    allocs = {a["category"]: int(a["amount"]) for a in await pb.all("fin_allocations", filter=f"period = {q(pid)}")}
    moves = await pb.all("fin_moves", filter=f"period = {q(pid)}")
    spent = await spent_by_category(pid)
    moved: dict[str, int] = defaultdict(int)
    for m in moves:
        moved[m["from_category"]] -= int(m["amount"])
        moved[m["to_category"]] += int(m["amount"])

    income_total = sum(int(i["amount"]) for i in incomes)
    start, end, t = parse(period["start"]), parse(period["end"]), today()
    days_total = (end - start).days + 1
    days_left = max(0, (end - t).days + 1) if start <= t <= end else (days_total if t < start else 0)
    elapsed = days_total - days_left

    wallets = []
    for c in cats:
        cid = c["id"]
        budget = allocs.get(cid, 0) + moved.get(cid, 0)
        if c.get("archived") and not budget and not spent.get(cid):
            continue
        s = spent.get(cid, 0)
        wallets.append({
            "category": {k: c.get(k) for k in ("id", "name", "group", "icon", "color", "archived")},
            "allocated": allocs.get(cid, 0), "moved": moved.get(cid, 0), "budget": budget, "spent": s,
            "left": budget - s,
            "pct": round(s / budget * 100, 1) if budget else (100.0 if s else 0.0),
            # Spending pace vs time: >1 means spending faster than the month is passing.
            "pace": round((s / budget) / (elapsed / days_total), 2) if budget and elapsed else None,
        })
    assigned = sum(allocs.values())
    flexible_left = sum(w["left"] for w in wallets if w["category"]["group"] in ("needs", "wants") and w["left"] > 0)
    by_group = {g: {"budget": 0, "spent": 0} for g in GROUPS}
    for w in wallets:
        g = by_group[w["category"]["group"]]
        g["budget"] += w["budget"]
        g["spent"] += w["spent"]
    pending = await pb.list("fin_transactions", filter=PENDING_FILTER, per_page=1, skip_total=False)
    return {
        "period": {k: period[k] for k in ("id", "start", "end", "status")},
        "demo": await is_demo(pid),
        "days_total": days_total, "days_left": days_left,
        "income": income_total, "incomes": incomes, "assigned": assigned, "to_assign": income_total - assigned,
        "spent": sum(spent.values()), "wallets": wallets, "groups": by_group,
        "safe_today": flexible_left // days_left if days_left else 0,
        "pending": pending.get("totalItems", 0),
    }


# ---------------------------------------------------------------------------
# Month end: sweep leftovers to savings goals
# ---------------------------------------------------------------------------

async def close_period(period: dict) -> dict:
    """Close a finished cycle: positive wallet leftovers go to savings.

    Order: the emergency fund until it reaches its target, then custom goals
    by their sort order until each is full; anything beyond that stays in the
    emergency fund. Negative wallets (overspending) reduce the total swept.
    """
    if period.get("status") == "closed" and period.get("closing"):
        return period["closing"]
    if await is_demo(period["id"]):
        closing = {"demo": True, "swept": [], "closed_at": datetime.now(config.TZ).isoformat()}
        await pb.update("fin_periods", period["id"], {"status": "closed", "closing": closing})
        return closing
    s = await summary(period)
    leftovers = {w["category"]["id"]: w["left"] for w in s["wallets"] if w["category"]["group"] != "savings"}
    unassigned = max(0, s["to_assign"])
    total = sum(leftovers.values()) + unassigned
    swept = []
    remaining = max(0, total)
    goals = await pb.all("fin_goals", filter="archived = false", sort="sort,created")
    emergency = next((g for g in goals if g["kind"] == "emergency"), None)
    order = ([emergency] if emergency else []) + [g for g in goals if g["kind"] == "custom"]
    for g in order:
        if remaining <= 0:
            break
        room = max(0, int(g.get("target") or 0) - int(g.get("saved") or 0)) if g.get("target") else remaining
        amt = min(room, remaining)
        if amt > 0:
            swept.append({"goal": g["id"], "name": g["name"], "amount": amt})
            remaining -= amt
    if remaining > 0 and emergency:
        swept.append({"goal": emergency["id"], "name": emergency["name"], "amount": remaining})
        remaining = 0
    for item in swept:
        g = await pb.get("fin_goals", item["goal"])
        await pb.update("fin_goals", g["id"], {"saved": int(g.get("saved") or 0) + item["amount"]})
        await pb.create("fin_goal_moves", {"goal": g["id"], "amount": item["amount"], "period": period["id"],
                                           "source": "sweep", "note": f"Leftovers {period['start']} → {period['end']}"})
    closing = {"leftovers": leftovers, "unassigned": unassigned, "total": total, "swept": swept,
               "not_swept": remaining, "closed_at": datetime.now(config.TZ).isoformat()}
    await pb.update("fin_periods", period["id"], {"status": "closed", "closing": closing})
    return closing


async def close_finished_periods() -> list[dict]:
    done = []
    for p in await pb.all("fin_periods", filter=f"status = 'open' && end < {q(iso(today()))}", sort="start"):
        done.append({"period": p, "closing": await close_period(p)})
    return done
