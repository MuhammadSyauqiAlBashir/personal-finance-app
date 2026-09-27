"""API: categories, profile, cycle, income, wallet plan, moves, bills, goals, members."""

from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import advisor, ai, budget
from .pb import pb, q
from .security import User, admin, member

router = APIRouter(prefix="/api")

PB_ID = re.compile(r"^[a-z0-9]{15}$")
GROUP = r"^(must|needs|wants|savings)$"


def rid(value: str) -> str:
    if not PB_ID.match(value or ""):
        raise HTTPException(404, "Not found.")
    return value


def ai_error(e: Exception):
    raise HTTPException(503, f"The AI is unavailable right now ({str(e)[:120]}). Try again in a minute.")


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------

class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    group: str = Field(pattern=GROUP)
    icon: str = Field(default="", max_length=16)
    color: str = Field(default="", max_length=16, pattern=r"^(#[0-9a-fA-F]{6})?$")
    default_amount: int = Field(default=0, ge=0, le=10_000_000_000)
    hints: str = Field(default="", max_length=500)
    sort: int = Field(default=0, ge=0, le=10000)


@router.get("/categories")
async def list_categories(archived: bool = False, user: User = Depends(member)):
    return {"categories": await budget.categories(include_archived=archived)}


@router.post("/categories")
async def create_category(body: CategoryIn, user: User = Depends(member)):
    return await pb.create("fin_categories", {**body.model_dump(), "name": body.name.strip(), "archived": False})


@router.patch("/categories/{cid}")
async def update_category(cid: str, body: CategoryIn, user: User = Depends(member)):
    return await pb.update("fin_categories", rid(cid), {**body.model_dump(), "name": body.name.strip()})


async def category_in_use(cid: str) -> bool:
    for coll, field in (("fin_splits", "category"), ("fin_allocations", "category"), ("fin_bills", "category"),
                        ("fin_moves", "from_category"), ("fin_moves", "to_category")):
        if (await pb.list(coll, filter=f"{field} = {q(cid)}", per_page=1))["items"]:
            return True
    return False


@router.delete("/categories/{cid}")
async def delete_category(cid: str, user: User = Depends(member)):
    """Delete if unused; otherwise archive so past reports keep working."""
    rid(cid)
    if await category_in_use(cid):
        await pb.update("fin_categories", cid, {"archived": True})
        return {"archived": True}
    for rule in await pb.all("fin_merchant_rules", filter=f"category = {q(cid)}"):
        await pb.delete("fin_merchant_rules", rule["id"])
    await pb.delete("fin_categories", cid)
    return {"deleted": True}


@router.post("/categories/{cid}/restore")
async def restore_category(cid: str, user: User = Depends(member)):
    return await pb.update("fin_categories", rid(cid), {"archived": False})


class MergeIn(BaseModel):
    into: str


@router.post("/categories/{cid}/merge")
async def merge_category(cid: str, body: MergeIn, user: User = Depends(member)):
    """Move everything from category cid into another, then archive cid."""
    src, dst = rid(cid), rid(body.into)
    if src == dst:
        raise HTTPException(400, "Pick a different category.")
    for coll, fields in (("fin_splits", ("category",)), ("fin_bills", ("category",)),
                         ("fin_merchant_rules", ("category",)), ("fin_moves", ("from_category", "to_category"))):
        for f in fields:
            for rec in await pb.all(coll, filter=f"{f} = {q(src)}"):
                await pb.update(coll, rec["id"], {f: dst})
    for a in await pb.all("fin_allocations", filter=f"category = {q(src)}"):
        other = await pb.first("fin_allocations", f"period = {q(a['period'])} && category = {q(dst)}")
        if other:
            await pb.update("fin_allocations", other["id"], {"amount": int(other["amount"]) + int(a["amount"])})
            await pb.delete("fin_allocations", a["id"])
        else:
            await pb.update("fin_allocations", a["id"], {"category": dst})
    await pb.update("fin_categories", src, {"archived": True})
    return {"ok": True}


@router.post("/categories/suggest")
async def suggest_categories(user: User = Depends(member)):
    try:
        return await advisor.starter_categories()
    except ai.AIUnavailable as e:
        ai_error(e)


class BulkCategories(BaseModel):
    categories: list[CategoryIn] = Field(max_length=60)


@router.post("/categories/bulk")
async def bulk_categories(body: BulkCategories, user: User = Depends(member)):
    existing = {c["name"].lower() for c in await budget.categories(include_archived=True)}
    created = []
    for i, c in enumerate(body.categories):
        if c.name.strip().lower() in existing:
            continue
        created.append(await pb.create("fin_categories", {**c.model_dump(), "name": c.name.strip(),
                                                          "sort": c.sort or (i + 1) * 10, "archived": False}))
        existing.add(c.name.strip().lower())
    return {"created": len(created)}


# ---------------------------------------------------------------------------
# Family profile and settings
# ---------------------------------------------------------------------------

class Profile(BaseModel):
    household: str = Field(default="", max_length=1000)
    city: str = Field(default="", max_length=200)
    work: str = Field(default="", max_length=1000)
    dependants: str = Field(default="", max_length=1000)
    values: str = Field(default="", max_length=1000)
    priorities: str = Field(default="", max_length=1000)
    notes: str = Field(default="", max_length=3000)
    names: list[str] = Field(default_factory=list, max_length=6)  # hidden from the AI


@router.get("/profile")
async def get_profile(user: User = Depends(member)):
    return {"profile": await pb.kv_get("profile", {}) or {}}


@router.put("/profile")
async def put_profile(body: Profile, user: User = Depends(member)):
    await pb.kv_set("profile", body.model_dump())
    return {"ok": True}


@router.get("/settings/cycle")
async def get_cycle(user: User = Depends(member)):
    return {"start_day": await budget.start_day()}


class CycleIn(BaseModel):
    start_day: int = Field(ge=1, le=31)


@router.post("/settings/cycle/preview")
async def preview_cycle(body: CycleIn, user: User = Depends(member)):
    return await budget.preview_cycle_change(body.start_day)


@router.put("/settings/cycle")
async def set_cycle(body: CycleIn, user: User = Depends(member)):
    return await budget.apply_cycle_change(body.start_day)


@router.get("/setup")
async def setup_state(user: User = Depends(member)):
    """What the first-time setup still needs."""
    profile = await pb.kv_get("profile", {}) or {}
    cats = await budget.categories()
    period = await budget.period_for()
    incomes = await pb.list("fin_incomes", filter=f"period = {q(period['id'])}", per_page=1)
    return {
        "profile": bool(profile.get("household") or profile.get("city")),
        "cycle": bool(await pb.kv_get("cycle")),
        "categories": len(cats),
        "goals": len(await pb.all("fin_goals", filter="archived = false")),
        "income": bool(incomes["items"]),
        "done": bool(await pb.kv_get("setup_done")),
    }


@router.post("/setup/done")
async def setup_done(user: User = Depends(member)):
    await pb.kv_set("setup_done", True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Periods, summary, income, allocations, moves
# ---------------------------------------------------------------------------

@router.get("/summary")
async def summary(period: str = "", user: User = Depends(member)):
    p = await pb.get("fin_periods", rid(period)) if period else await budget.period_for()
    return await budget.summary(p)


@router.get("/periods")
async def periods(user: User = Depends(member)):
    await budget.period_for()
    return {"periods": await pb.all("fin_periods", sort="-start", fields="id,start,end,status")}


class IncomeIn(BaseModel):
    amount: int = Field(gt=0, le=10_000_000_000)
    source: str = Field(min_length=1, max_length=120)
    date: date
    note: str = Field(default="", max_length=500)


@router.post("/incomes")
async def add_income(body: IncomeIn, user: User = Depends(member)):
    period = await budget.period_for(body.date)
    return await pb.create("fin_incomes", {"period": period["id"], "amount": body.amount, "source": body.source,
                                           "date": body.date.isoformat(), "note": body.note,
                                           "created_by": user.username})


@router.patch("/incomes/{iid}")
async def edit_income(iid: str, body: IncomeIn, user: User = Depends(member)):
    period = await budget.period_for(body.date)
    return await pb.update("fin_incomes", rid(iid), {"period": period["id"], "amount": body.amount,
                                                     "source": body.source, "date": body.date.isoformat(),
                                                     "note": body.note})


@router.delete("/incomes/{iid}")
async def delete_income(iid: str, user: User = Depends(member)):
    await pb.delete("fin_incomes", rid(iid))
    return {"ok": True}


class AllocationItem(BaseModel):
    category: str
    amount: int = Field(ge=0, le=10_000_000_000)


class AllocationsIn(BaseModel):
    period: str
    allocations: list[AllocationItem] = Field(max_length=100)


@router.put("/allocations")
async def set_allocations(body: AllocationsIn, user: User = Depends(member)):
    pid = rid(body.period)
    current = {a["category"]: a for a in await pb.all("fin_allocations", filter=f"period = {q(pid)}")}
    for item in body.allocations:
        cid = rid(item.category)
        if cid in current:
            if int(current[cid]["amount"]) != item.amount:
                await pb.update("fin_allocations", current[cid]["id"], {"amount": item.amount})
        elif item.amount:
            await pb.create("fin_allocations", {"period": pid, "category": cid, "amount": item.amount})
    return await budget.summary(await pb.get("fin_periods", pid))


@router.post("/allocations/suggest")
async def suggest_allocations(period: str = "", user: User = Depends(member)):
    p = await pb.get("fin_periods", rid(period)) if period else await budget.period_for()
    try:
        return await advisor.suggest_allocations(p)
    except ai.AIUnavailable as e:
        ai_error(e)


class MoveIn(BaseModel):
    period: str
    from_category: str
    to_category: str
    amount: int = Field(gt=0, le=10_000_000_000)
    note: str = Field(default="", max_length=300)


@router.post("/moves")
async def move_money(body: MoveIn, user: User = Depends(member)):
    if body.from_category == body.to_category:
        raise HTTPException(400, "Pick two different wallets.")
    await pb.create("fin_moves", {"period": rid(body.period), "from_category": rid(body.from_category),
                                  "to_category": rid(body.to_category), "amount": body.amount,
                                  "note": body.note, "created_by": user.username})
    return await budget.summary(await pb.get("fin_periods", body.period))


@router.delete("/moves/{mid}")
async def undo_move(mid: str, user: User = Depends(member)):
    await pb.delete("fin_moves", rid(mid))
    return {"ok": True}


@router.get("/moves")
async def list_moves(period: str, user: User = Depends(member)):
    return {"moves": await pb.all("fin_moves", filter=f"period = {q(rid(period))}", sort="-created")}


# ---------------------------------------------------------------------------
# Bills (must spend) and goals
# ---------------------------------------------------------------------------

class BillIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: str
    amount: int = Field(ge=0, le=10_000_000_000)
    due_day: int = Field(ge=1, le=31)
    active: bool = True
    match_hint: str = Field(default="", max_length=200)


@router.get("/bills")
async def list_bills(user: User = Depends(member)):
    period = await budget.period_for()
    paid = {b["bill"]: b for b in await pb.all("fin_bill_payments", filter=f"period = {q(period['id'])}")}
    bills = await pb.all("fin_bills", sort="due_day,name")
    return {"bills": [{**b, "paid": b["id"] in paid, "paid_tx": paid.get(b["id"], {}).get("transaction")}
                      for b in bills]}


@router.post("/bills")
async def add_bill(body: BillIn, user: User = Depends(member)):
    return await pb.create("fin_bills", {**body.model_dump(), "category": rid(body.category)})


@router.patch("/bills/{bid}")
async def edit_bill(bid: str, body: BillIn, user: User = Depends(member)):
    return await pb.update("fin_bills", rid(bid), {**body.model_dump(), "category": rid(body.category)})


@router.delete("/bills/{bid}")
async def delete_bill(bid: str, user: User = Depends(member)):
    await pb.delete("fin_bills", rid(bid))
    return {"ok": True}


class BillPaidIn(BaseModel):
    paid: bool
    transaction: str = ""


@router.post("/bills/{bid}/paid")
async def mark_bill(bid: str, body: BillPaidIn, user: User = Depends(member)):
    period = await budget.period_for()
    rec = await pb.first("fin_bill_payments", f"bill = {q(rid(bid))} && period = {q(period['id'])}")
    if body.paid and not rec:
        await pb.create("fin_bill_payments", {"bill": bid, "period": period["id"],
                                              "transaction": rid(body.transaction) if body.transaction else None})
    elif not body.paid and rec:
        await pb.delete("fin_bill_payments", rec["id"])
    return {"ok": True}


class GoalIn(BaseModel):
    kind: str = Field(pattern=r"^(emergency|custom)$")
    name: str = Field(min_length=1, max_length=120)
    target: int = Field(ge=0, le=100_000_000_000)
    target_date: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    sort: int = Field(default=0, ge=0, le=10000)


@router.get("/goals")
async def list_goals(user: User = Depends(member)):
    return {"goals": await pb.all("fin_goals", filter="archived = false", sort="sort,created")}


@router.post("/goals")
async def add_goal(body: GoalIn, user: User = Depends(member)):
    if body.kind == "emergency" and await pb.first("fin_goals", "kind = 'emergency' && archived = false"):
        raise HTTPException(400, "There is already an emergency fund.")
    return await pb.create("fin_goals", {**body.model_dump(), "saved": 0, "archived": False})


@router.patch("/goals/{gid}")
async def edit_goal(gid: str, body: GoalIn, user: User = Depends(member)):
    return await pb.update("fin_goals", rid(gid), body.model_dump(exclude={"kind"}))


@router.delete("/goals/{gid}")
async def archive_goal(gid: str, user: User = Depends(member)):
    await pb.update("fin_goals", rid(gid), {"archived": True})
    return {"ok": True}


class GoalMoveIn(BaseModel):
    amount: int = Field(ge=-100_000_000_000, le=100_000_000_000)
    note: str = Field(default="", max_length=300)


@router.post("/goals/{gid}/move")
async def goal_move(gid: str, body: GoalMoveIn, user: User = Depends(member)):
    """Add to (positive) or withdraw from (negative) a goal by hand."""
    g = await pb.get("fin_goals", rid(gid))
    new = int(g.get("saved") or 0) + body.amount
    if new < 0:
        raise HTTPException(400, "Can't withdraw more than is saved.")
    period = await budget.period_for()
    await pb.create("fin_goal_moves", {"goal": gid, "amount": body.amount, "period": period["id"],
                                       "source": "manual", "note": body.note, "created_by": user.username})
    return await pb.update("fin_goals", gid, {"saved": new})


@router.get("/goals/{gid}/moves")
async def goal_moves(gid: str, user: User = Depends(member)):
    return {"moves": await pb.all("fin_goal_moves", filter=f"goal = {q(rid(gid))}", sort="-created")}


# ---------------------------------------------------------------------------
# Household members (admin)
# ---------------------------------------------------------------------------

@router.get("/members")
async def list_members(user: User = Depends(member)):
    return {"members": await pb.all("fin_members", sort="created", fields="id,user,username,created")}


class MemberIn(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-z0-9_]+$")


@router.post("/members")
async def add_member(body: MemberIn, user: User = Depends(admin)):
    # The service user can't read other users, so ask PocketBase as the admin.
    status, data = await pb.raw("GET", "/api/collections/users/records", user.token,
                                params={"filter": f"username = {q(body.username)}", "perPage": 1})
    items = data.get("items", []) if status == 200 else []
    if not items:
        raise HTTPException(404, "No account with that username.")
    u = items[0]
    if u.get("role") == "service":
        raise HTTPException(400, "That's a service account.")
    if not u.get("approved"):
        raise HTTPException(400, "Approve that account first (lyrsync → Approvals).")
    if await pb.first("fin_members", f"user = {q(u['id'])}"):
        return {"ok": True}
    await pb.create("fin_members", {"user": u["id"], "username": u["username"]})
    return {"ok": True}


@router.delete("/members/{mid}")
async def remove_member(mid: str, user: User = Depends(admin)):
    m = await pb.get("fin_members", rid(mid))
    if m["user"] == user.id:
        raise HTTPException(400, "You can't remove yourself.")
    await pb.delete("fin_members", mid)
    return {"ok": True}
