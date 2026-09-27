"""Background jobs (Asia/Jakarta time). Each job runs once per day at or after its
time; fin_events records that it ran, so restarts don't repeat it."""

from __future__ import annotations

import asyncio
import calendar
import logging
from datetime import datetime, timedelta

from . import budget, config, emails, notify, reports
from .pb import PBError, pb

log = logging.getLogger("fin.scheduler")


def rp(n: int) -> str:
    return notify.rp(n)


async def job_close_periods(today: str):
    for item in await budget.close_finished_periods():
        p, closing = item["period"], item["closing"]
        if closing.get("demo"):
            continue
        swept = sum(s["amount"] for s in closing.get("swept", []))
        await budget.period_for()  # open the new month
        try:
            await reports.monthly_review(p)
        except Exception as e:  # AI may be busy; the report page can generate it later
            log.warning("monthly review not generated yet: %s", e)
        await notify.send("Monthly report is ready",
                          f"{p['start']} → {p['end']}: {rp(swept)} moved to savings. "
                          "Enter this month's income and plan your wallets.", "/#report/monthly", tag="monthly")


async def job_daily_report(today: str):
    if not await tracking_started(today):
        return
    if await budget.is_demo((await budget.period_for())["id"]):
        return
    data = await reports.daily(datetime.fromisoformat(today).date())
    if not data["total"] and not data["pending"]:
        body = f"No spending today. Safe to spend tomorrow: {rp(data['safe_tomorrow'])}."
    else:
        top = ", ".join(f"{c['category']['name']} {rp(c['amount'])}" for c in data["by_category"][:3])
        body = f"Spent {rp(data['total'])}" + (f" ({top})" if top else "") + \
            f". Safe to spend tomorrow: {rp(data['safe_tomorrow'])}."
        if data["pending"]:
            body += f" {data['pending']} to confirm."
    await notify.send("Today's spending", body, "/#report/daily", tag="daily")


async def job_pace(today: str):
    if not await tracking_started(today):
        return
    period = await budget.period_for()
    if await budget.is_demo(period["id"]):
        return
    s = await budget.summary(period)
    flex = [w for w in s["wallets"] if w["category"]["group"] in ("needs", "wants") and w["budget"]]
    budget_total = sum(w["budget"] for w in flex)
    spent = sum(w["spent"] for w in flex)
    elapsed = s["days_total"] - s["days_left"]
    if not budget_total or elapsed < 3:
        return
    pace = (spent / budget_total) / (elapsed / s["days_total"])
    if pace > 1.15:
        await notify.send("Spending ahead of pace",
                          f"{int(spent / budget_total * 100)}% of the flexible budget is used after "
                          f"{int(elapsed / s['days_total'] * 100)}% of the month. "
                          f"Safe to spend today: {rp(s['safe_today'])}.", "/#wallets", tag="pace")


async def tracking_started(today: str) -> bool:
    start = await pb.kv_get("tracking_start", "")
    return not start or today >= start


async def job_bills(today: str):
    if not await tracking_started(today):
        return
    t = datetime.fromisoformat(today).date()
    period = await budget.period_for()
    paid = {b["bill"] for b in await pb.all("fin_bill_payments", filter=f"period = '{period['id']}'")}
    start, end = budget.parse(period["start"]), budget.parse(period["end"])
    for b in await pb.all("fin_bills", filter="active = true"):
        if b["id"] in paid or not b.get("due_day"):
            continue
        # The due date inside the current budget month.
        due = None
        d = start
        while d <= end:
            if d.day == min(int(b["due_day"]), calendar.monthrange(d.year, d.month)[1]):
                due = d
                break
            d += timedelta(days=1)
        if not due:
            continue
        days = (due - t).days
        if days == 3:
            await notify.send(f"{b['name']} due in 3 days", f"{rp(b.get('amount') or 0)} on {due:%d %b}.",
                              "/#bills", tag=f"bill-{b['id']}")
        elif days < 0 and await pb.event_once(f"overdue:{period['id']}:{b['id']}:{today}"):
            await notify.send(f"{b['name']} is overdue", f"It was due {due:%d %b}. Mark it paid once it's done.",
                              "/#bills", tag=f"bill-{b['id']}")


async def job_pending(today: str):
    if await tracking_started(today):
        await notify.pending_reminder()


JOBS = [
    # (name, hour, minute, function)
    ("close_periods", 0, 5, job_close_periods),
    ("bills", 9, 0, job_bills),
    ("pending", 19, 0, lambda today: job_pending(today)),
    ("pace", 20, 0, job_pace),
    ("daily_report", 21, 0, job_daily_report),
]


async def tick():
    now = datetime.now(config.TZ)
    today = now.strftime("%Y-%m-%d")
    for name, hour, minute, fn in JOBS:
        if (now.hour, now.minute) < (hour, minute):
            continue
        # Don't fire long-missed jobs late at night (e.g. after a restart at 23:50).
        if name != "close_periods" and now.hour >= 23 and hour < 21:
            continue
        try:
            if await pb.event_once(f"job:{name}:{today}"):
                log.info("running job %s", name)
                await fn(today)
        except Exception:
            log.exception("job %s failed", name)


async def run():
    last_email_retry = 0.0
    while True:
        try:
            await tick()
            loop = asyncio.get_running_loop()
            if loop.time() - last_email_retry > 900:
                last_email_retry = loop.time()
                await emails.process_pending()
        except PBError as e:
            log.warning("scheduler: database unavailable: %s", e)
        except Exception:
            log.exception("scheduler tick failed")
        await asyncio.sleep(60)
