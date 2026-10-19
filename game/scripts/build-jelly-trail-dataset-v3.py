#!/usr/bin/env python3
"""Build the Jelly Trail Academy v3 teaching dataset from the v2 source."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd


DEFAULT_SOURCE = (
    Path.home()
    / "Downloads/DA_Game_Teaching_Data/Jelly_Trail_Academy_v2_STUDENT_DELIVERY"
    / "synthetic_jelly_trail_academy_v2"
)
DEFAULT_OUTPUT = Path.home() / "Downloads/DA_Game_Teaching_Data/Jelly_Trail_Academy_v3_DELIVERY"
TABLES = [
    "users",
    "tutorial_steps",
    "sessions",
    "player_daily",
    "level_metadata",
    "level_attempts",
    "booster_events",
    "purchases",
    "ad_events",
    "campaign_spend",
    "liveops_events",
    "ab_assignments",
    "daily_kpi",
]
SEA = {"VN", "TH", "PH", "ID"}
BAD_RELEASE = pd.Timestamp("2026-07-30")
HOTFIX_RELEASE = pd.Timestamp("2026-08-15")


def stable_fraction(value: str) -> float:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def require_clean_output(output: Path) -> None:
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)


def load_tables(source: Path) -> dict[str, pd.DataFrame]:
    tables = {name: pd.read_csv(source / "data" / f"{name}.csv") for name in TABLES}
    expected = json.loads((source / "manifest.json").read_text(encoding="utf-8"))["tables"]
    for name, frame in tables.items():
        expected_rows = expected[f"{name}.csv"]
        if len(frame) != expected_rows:
            raise ValueError(f"{name}: expected {expected_rows} rows, found {len(frame)}")
    return tables


def add_tutorial_sessions(tables: dict[str, pd.DataFrame]) -> None:
    users = tables["users"].set_index("user_id")
    sessions = tables["sessions"].copy()
    tutorials = tables["tutorial_steps"].copy()
    first_session = (
        sessions.sort_values(["user_id", "event_date", "session_id"])
        .drop_duplicates(["user_id", "event_date"])
        .set_index(["user_id", "event_date"])["session_id"]
        .to_dict()
    )
    new_sessions: list[dict[str, object]] = []
    tutorial_session: dict[str, str] = {}
    for user_id, group in tutorials.groupby("user_id", sort=False):
        install_date = str(group.iloc[0]["install_date"])
        session_id = first_session.get((user_id, install_date))
        if session_id is None:
            session_id = f"jta_session_v3_tutorial_{user_id.rsplit('_', 1)[-1]}"
            profile = users.loc[user_id]
            start = f"{install_date}T09:00:00"
            new_sessions.append(
                {
                    "session_id": session_id,
                    "user_id": user_id,
                    "session_start": start,
                    "event_date": install_date,
                    "event_time": start,
                    "duration_minutes": 5,
                    "entry_screen": "tutorial",
                    "app_version": profile["app_version_install"],
                    "platform": profile["platform"],
                    "country": profile["country"],
                }
            )
        tutorial_session[user_id] = session_id
    tutorials["session_id"] = tutorials["user_id"].map(tutorial_session)
    if new_sessions:
        sessions = pd.concat([sessions, pd.DataFrame(new_sessions, columns=sessions.columns)], ignore_index=True)
    tables["sessions"] = sessions
    tables["tutorial_steps"] = tutorials


def assign_runtime_versions(tables: dict[str, pd.DataFrame]) -> None:
    users = tables["users"].set_index("user_id")
    sessions = tables["sessions"].copy()

    def version_for(row: pd.Series) -> str:
        installed = str(users.loc[row["user_id"], "app_version_install"])
        day = pd.Timestamp(row["event_date"])
        score = stable_fraction(str(row["user_id"]))
        if day >= HOTFIX_RELEASE and (installed == "2.1.1" or score < 0.72):
            return "2.1.1"
        if day >= BAD_RELEASE and (installed == "2.1.0" or score < 0.78):
            return "2.1.0"
        return installed

    sessions["app_version"] = sessions.apply(version_for, axis=1)
    tables["sessions"] = sessions
    session_versions = sessions.set_index("session_id")["app_version"]
    for name in ["tutorial_steps", "level_attempts", "purchases", "ad_events"]:
        frame = tables[name].copy()
        frame["app_version"] = frame["session_id"].map(session_versions)
        if frame["app_version"].isna().any():
            raise ValueError(f"{name}: missing runtime version after session join")
        tables[name] = frame

    attempts = tables["level_attempts"].set_index("attempt_id")
    boosters = tables["booster_events"].copy()
    boosters["app_version"] = boosters["attempt_id"].map(attempts["app_version"])
    tables["booster_events"] = boosters

    session_day_versions = (
        sessions.sort_values(["user_id", "event_date", "session_id"])
        .drop_duplicates(["user_id", "event_date"], keep="last")
        .set_index(["user_id", "event_date"])["app_version"]
        .to_dict()
    )
    daily = tables["player_daily"].copy()
    daily["app_version"] = [
        session_day_versions.get((user_id, day), version)
        for user_id, day, version in zip(daily["user_id"], daily["activity_date"], daily["app_version"])
    ]
    tables["player_daily"] = daily


def apply_hotfix_progression_signal(tables: dict[str, pd.DataFrame]) -> None:
    attempts = tables["level_attempts"].copy()
    mask = attempts["app_version"].isin(["2.1.0", "2.1.1"]) & attempts["level_id"].isin([28, 29, 30])
    for index in attempts.index[mask]:
        row = attempts.loc[index]
        affected = row["platform"] == "Android" and row["country"] in SEA
        if affected and row["app_version"] == "2.1.0":
            target_win_rate = 0.52
        elif affected and row["app_version"] == "2.1.1":
            target_win_rate = 0.64
        else:
            target_win_rate = 0.72
        won = stable_fraction(f"v3-outcome:{row['attempt_id']}") < target_win_rate
        if won:
            attempts.at[index, "result"] = "complete"
            moves_left = max(1, int(row["moves_left"]))
            attempts.at[index, "moves_left"] = moves_left
            attempts.at[index, "moves_used"] = max(1, int(row["moves_limit"]) - moves_left)
            attempts.at[index, "extra_moves_offered"] = 0
            attempts.at[index, "extra_moves_purchased"] = 0
        else:
            if row["result"] == "complete":
                attempts.at[index, "result"] = "fail_out_of_moves"
            attempts.at[index, "moves_used"] = int(row["moves_limit"])
            attempts.at[index, "moves_left"] = 0
    tables["level_attempts"] = attempts


def schedule_events_within_sessions(tables: dict[str, pd.DataFrame]) -> None:
    sessions = tables["sessions"].copy()
    tutorials = tables["tutorial_steps"].copy()
    attempts = tables["level_attempts"].copy()
    ads = tables["ad_events"].copy()
    purchases = tables["purchases"].copy()
    boosters = tables["booster_events"].copy()

    tutorial_groups = tutorials.groupby("session_id").groups
    attempt_groups = attempts.groupby("session_id").groups
    ad_groups = ads.groupby("session_id").groups
    purchase_groups = purchases.groupby("session_id").groups

    attempt_times: dict[str, datetime] = {}
    session_starts: dict[str, datetime] = {}
    for session_index, session in sessions.iterrows():
        session_id = str(session["session_id"])
        original_start = pd.Timestamp(session["event_time"]).to_pydatetime()
        day_start = datetime.combine(original_start.date(), datetime.min.time())
        cursor = 20
        pending: list[tuple[str, int, int]] = []
        tutorial_indices = sorted(
            tutorial_groups.get(session_id, []),
            key=lambda i: (int(tutorials.at[i, "step_id"]), str(tutorials.at[i, "user_id"])),
        )
        for index in tutorial_indices:
            pending.append(("tutorial", int(index), cursor))
            cursor += 25

        attempt_indices = sorted(
            attempt_groups.get(session_id, []), key=lambda i: str(attempts.at[i, "attempt_id"])
        )
        for index in attempt_indices:
            pending.append(("attempt", int(index), cursor))
            cursor += max(10, int(attempts.at[index, "duration_sec"])) + 10

        for index in sorted(ad_groups.get(session_id, []), key=lambda i: str(ads.at[i, "ad_id"])):
            pending.append(("ad", int(index), cursor))
            cursor += 15
        for index in sorted(
            purchase_groups.get(session_id, []), key=lambda i: str(purchases.at[i, "transaction_id"])
        ):
            pending.append(("purchase", int(index), cursor))
            cursor += 15

        required_seconds = max(int(session["duration_minutes"]) * 60, cursor + 20)
        duration_minutes = max(1, math.ceil(required_seconds / 60))
        latest_start = day_start + timedelta(days=1, seconds=-(duration_minutes * 60 + 1))
        start = min(max(original_start, day_start), latest_start)
        session_starts[session_id] = start
        sessions.at[session_index, "session_start"] = start.isoformat(timespec="seconds")
        sessions.at[session_index, "event_time"] = start.isoformat(timespec="seconds")
        sessions.at[session_index, "event_date"] = start.date().isoformat()
        sessions.at[session_index, "duration_minutes"] = duration_minutes

        for kind, index, offset in pending:
            event_time = start + timedelta(seconds=offset)
            target = {"tutorial": tutorials, "attempt": attempts, "ad": ads, "purchase": purchases}[kind]
            target.at[index, "event_time"] = event_time.isoformat(timespec="seconds")
            target.at[index, "event_date"] = event_time.date().isoformat()
            if kind == "tutorial":
                target.at[index, "install_date"] = event_time.date().isoformat()
            if kind == "attempt":
                attempt_times[str(target.at[index, "attempt_id"])] = event_time

    for index, booster in boosters.iterrows():
        attempt_time = attempt_times[str(booster["attempt_id"])]
        duration = int(attempts.loc[attempts["attempt_id"] == booster["attempt_id"], "duration_sec"].iloc[0])
        event_time = attempt_time + timedelta(seconds=max(1, min(30, duration // 2)))
        boosters.at[index, "event_time"] = event_time.isoformat(timespec="seconds")
        boosters.at[index, "event_date"] = event_time.date().isoformat()

    tables["sessions"] = sessions
    tables["tutorial_steps"] = tutorials
    tables["level_attempts"] = attempts
    tables["ad_events"] = ads
    tables["purchases"] = purchases
    tables["booster_events"] = boosters


def rebuild_player_daily_and_kpi(tables: dict[str, pd.DataFrame]) -> None:
    sessions = tables["sessions"].copy()
    daily = tables["player_daily"].copy()
    users = tables["users"].set_index("user_id")
    session_rollup = (
        sessions.groupby(["user_id", "event_date"], as_index=False)
        .agg(sessions=("session_id", "count"), playtime_minutes=("duration_minutes", "sum"))
    )
    last_versions = (
        sessions.sort_values(["user_id", "event_date", "event_time"])
        .drop_duplicates(["user_id", "event_date"], keep="last")
        .set_index(["user_id", "event_date"])["app_version"]
        .to_dict()
    )
    daily_index = {(row.user_id, row.activity_date): index for index, row in daily.iterrows()}
    attempts = tables["level_attempts"]
    boosters = tables["booster_events"]
    purchases = tables["purchases"]
    ads = tables["ad_events"]

    new_rows: list[dict[str, object]] = []
    for row in session_rollup.itertuples(index=False):
        key = (row.user_id, row.event_date)
        version = last_versions[key]
        if key in daily_index:
            index = daily_index[key]
            daily.at[index, "sessions"] = int(row.sessions)
            daily.at[index, "playtime_minutes"] = int(row.playtime_minutes)
            daily.at[index, "app_version"] = version
            continue
        profile = users.loc[row.user_id]
        day_attempts = attempts[(attempts["user_id"] == row.user_id) & (attempts["event_date"] == row.event_date)]
        day_purchases = purchases[(purchases["user_id"] == row.user_id) & (purchases["event_date"] == row.event_date)]
        day_ads = ads[(ads["user_id"] == row.user_id) & (ads["event_date"] == row.event_date)]
        install_date = pd.Timestamp(profile["install_date"])
        activity_date = pd.Timestamp(row.event_date)
        new_rows.append(
            {
                "user_id": row.user_id,
                "install_date": install_date.date().isoformat(),
                "activity_date": activity_date.date().isoformat(),
                "cohort_day": (activity_date - install_date).days,
                "platform": profile["platform"],
                "country": profile["country"],
                "channel": profile["channel"],
                "campaign_id": profile["campaign_id"],
                "app_version": version,
                "sessions": int(row.sessions),
                "playtime_minutes": int(row.playtime_minutes),
                "max_level": int(day_attempts["level_id"].max()) if len(day_attempts) else 1,
                "boosters_used": int(((boosters["user_id"] == row.user_id) & (boosters["event_date"] == row.event_date)).sum()),
                "extra_moves_purchased": int(day_attempts["extra_moves_purchased"].sum()),
                "crash_count": int((day_attempts["result"] == "crash").sum()),
                "iap_revenue": round(float(day_purchases.loc[day_purchases["is_refund"] == 0, "price_usd"].sum()), 2),
                "ad_revenue": round(float(day_ads["revenue_usd"].sum()), 4),
            }
        )
    if new_rows:
        daily = pd.concat([daily, pd.DataFrame(new_rows, columns=daily.columns)], ignore_index=True)
    daily = daily.sort_values(["user_id", "activity_date"]).reset_index(drop=True)
    tables["player_daily"] = daily

    daily_dates = pd.to_datetime(daily["activity_date"])
    installs = tables["users"].groupby("install_date").size()
    records: list[dict[str, object]] = []
    for day, frame in daily.assign(_date=daily_dates).groupby("_date", sort=True):
        dau = frame["user_id"].nunique()
        iap = round(float(frame["iap_revenue"].sum()), 2)
        ad_revenue = round(float(frame["ad_revenue"].sum()), 2)
        records.append(
            {
                "date": day.date().isoformat(),
                "dau": dau,
                "new_users": int(installs.get(day.date().isoformat(), 0)),
                "sessions": int(frame["sessions"].sum()),
                "playtime_minutes": int(frame["playtime_minutes"].sum()),
                "iap_revenue": iap,
                "ad_revenue": ad_revenue,
                "crash_count": int(frame["crash_count"].sum()),
                "arpdau": round((iap + ad_revenue) / dau, 4) if dau else 0,
            }
        )
    tables["daily_kpi"] = pd.DataFrame(records, columns=tables["daily_kpi"].columns)


def enrich_experiment_design(tables: dict[str, pd.DataFrame]) -> None:
    assignments = tables["ab_assignments"].copy()
    attempts = tables["level_attempts"].copy()
    offered = attempts[attempts["extra_moves_offered"] == 1].sort_values(["user_id", "event_time"])
    first_exposure = offered.drop_duplicates("user_id").set_index("user_id")["event_time"]
    assignments["eligible_at"] = assignments["assigned_at"]
    assignments["exposed_at"] = assignments["user_id"].map(first_exposure)
    assignments["exposure_status"] = assignments["exposed_at"].notna().map({True: "exposed", False: "not_exposed"})
    assignments["eligibility_rule"] = "deterministic 8000-user install sample"
    assignments["primary_metric"] = "extra_move_purchase_per_assigned_user_d0_6"
    assignments["guardrail_metric"] = "d7_retention"
    assignments["analysis_window_days"] = 7
    tables["ab_assignments"] = assignments


def sanitize_student_metadata(tables: dict[str, pd.DataFrame]) -> None:
    levels = tables["level_metadata"].copy()
    levels["teaching_note"] = "Match-3 progression level; diagnose performance from event outcomes."
    tables["level_metadata"] = levels


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sqlite(tables: dict[str, pd.DataFrame], path: Path) -> None:
    with sqlite3.connect(path) as connection:
        for name in TABLES:
            tables[name].to_sql(name, connection, if_exists="replace", index=False)
        connection.execute("create unique index idx_users_user_id on users(user_id)")
        connection.execute("create unique index idx_sessions_session_id on sessions(session_id)")
        connection.execute("create unique index idx_attempts_attempt_id on level_attempts(attempt_id)")
        connection.execute("create index idx_daily_user_day on player_daily(user_id, activity_date)")


def student_readme() -> str:
    return """# Jelly Trail Academy v3 — Student Dataset

Public-safe synthetic data for learning game data analysis. No real company,
player, or product data is included.

## Scenario

Product performance changed across three releases: `2.0.2`, `2.1.0`, and
`2.1.1`. Product, marketing, game design, and LiveOps have competing
hypotheses. Use the data to identify what changed, where it changed, what is
merely correlated, and which action should be tested next.

## Suggested learning flow

1. Validate grain, keys, dates, and joins.
2. Establish DAU, sessions/DAU, playtime/DAU, revenue, and ARPDAU.
3. Analyze tutorial activation and progression.
4. Build maturity-safe D1 and D7 install cohorts.
5. Separate acquisition mix from product performance.
6. Evaluate the randomized experiment using an intent-to-treat population.
7. Present an evidence-led RCA with uncertainty and follow-up metrics.

## Package contents

- `data/*.csv`: clean teaching tables
- `jelly_trail_academy_v3_game_da.sqlite`: the same clean tables in SQLite
- `docs/data_dictionary.md`: grain and metric definitions
- `docs/analysis_questions.md`: neutral investigation prompts
- `docs/experiment_design.md`: A/B design and analysis guardrails
- `sql/sanity_checks.sql`: structural checks that do not reveal the answer
- `manifest.json`: row counts, hashes, data window, and version notes

Use the separate messy extension only after completing the clean-base module.
"""


def data_dictionary() -> str:
    return """# Data Dictionary — Jelly Trail Academy v3

## Time and identity rules

- Event-level tables use `event_date` and ISO `event_time`.
- A non-empty `session_id` identifies the session that contains the event.
- Session containment means `session.event_time <= event.event_time <=
  session.event_time + duration_minutes`.
- `app_version_install` is the install cohort version. Event-table
  `app_version` is the runtime version and may change when a returning user
  upgrades.
- Aggregate/calendar tables use date fields only.

## Tables and grain

- `users`: one row per install.
- `tutorial_steps`: one row per reached tutorial step, ordered by `step_id`.
- `sessions`: one row per play session.
- `player_daily`: one active user per calendar day.
- `level_metadata`: one row per level.
- `level_attempts`: one row per attempt.
- `booster_events`: one row per booster use linked to an attempt.
- `purchases`: one row per transaction; `level_id_if_relevant` is nullable.
- `ad_events`: one row per ad impression.
- `campaign_spend`: one row per date × campaign × country × target platform.
- `liveops_events`: one row per event calendar definition.
- `ab_assignments`: one row per user × experiment assignment.
- `daily_kpi`: one row per calendar day for reconciliation.

## Metric definitions

- DAU = distinct active users in `player_daily` by `activity_date`.
- Sessions/DAU = `SUM(sessions) / DAU`.
- ARPDAU = `SUM(iap_revenue + ad_revenue) / DAU`.
- Dk retention = mature install-cohort users active on exact `cohort_day = k`
  divided by all installs eligible to have reached day k.
- Dk maturity = `install_date <= max_data_date - k days`.
- Win rate = completed attempts divided by all attempts.
- Extra-move conversion = purchased offers divided by offers, with the unit of
  analysis stated explicitly.
- D7 ROI proxy = cohort revenue on days 0–6 divided by matched spend, minus 1.

Rates should use ratios of sums. Missing or immature observations are not zero.
"""


def analysis_questions() -> str:
    return """# Analysis Questions — Jelly Trail Academy v3

1. Which KPI changed most materially across the release windows?
2. Where does the tutorial funnel lose users, and for which segments?
3. Which levels or failure modes explain progression friction?
4. Do D1 and D7 move after controlling for cohort maturity and acquisition mix?
5. Is revenue movement driven by audience, payer behavior, ads, or product mix?
6. Are paid channels intrinsically weaker, or are their cohorts exposed to a
   product problem?
7. Do LiveOps periods coincide with lifts, and what prevents a causal claim?
8. Does the experiment improve its primary metric without harming D7 retention?
9. Which findings remain descriptive, and what test would establish causality?
10. Recommend a 48-hour action, a two-week measurement plan, and a two-month
    roadmap. Include owner, evidence, uncertainty, and stop conditions.
"""


def experiment_design() -> str:
    return """# Experiment Design — Extra-moves offer timing

- Unit of randomization: user
- Population: deterministic 8,000-user sample assigned on install day
- Variants: control after three fails; early offer after one fail
- Primary metric: extra-move purchases per assigned user during D0–D6
- Guardrail: exact-day D7 retention among mature assigned users
- Analysis: intent-to-treat; do not filter to exposed users for the primary read
- Exposure: first observed attempt with `extra_moves_offered = 1`
- Maturity: include D7 only when assignment date is at least seven days before
  the maximum dataset date

Report sample ratio, effect size, confidence interval, and the complete planned
population before inspecting segment cuts. Exposure-based analysis is secondary
because exposure is post-randomization behavior.
"""


def sanity_checks_sql() -> str:
    return """-- Jelly Trail Academy v3 structural checks

SELECT 'integrity' AS check_name, CASE WHEN (SELECT COUNT(*) FROM users) > 0 THEN 'ok' ELSE 'fail' END AS result;

SELECT 'duplicate_users' AS check_name, COUNT(*) AS failures
FROM (SELECT user_id FROM users GROUP BY user_id HAVING COUNT(*) > 1);

SELECT 'orphan_sessions' AS check_name, COUNT(*) AS failures
FROM sessions s LEFT JOIN users u USING(user_id) WHERE u.user_id IS NULL;

SELECT 'events_outside_session' AS check_name, COUNT(*) AS failures FROM (
  SELECT l.attempt_id
  FROM level_attempts l JOIN sessions s USING(session_id)
  WHERE datetime(l.event_time) < datetime(s.event_time)
     OR datetime(l.event_time) > datetime(s.event_time, '+' || s.duration_minutes || ' minutes')
  UNION ALL
  SELECT a.ad_id FROM ad_events a JOIN sessions s USING(session_id)
  WHERE datetime(a.event_time) < datetime(s.event_time)
     OR datetime(a.event_time) > datetime(s.event_time, '+' || s.duration_minutes || ' minutes')
  UNION ALL
  SELECT p.transaction_id FROM purchases p JOIN sessions s USING(session_id)
  WHERE datetime(p.event_time) < datetime(s.event_time)
     OR datetime(p.event_time) > datetime(s.event_time, '+' || s.duration_minutes || ' minutes')
  UNION ALL
  SELECT t.user_id || ':' || t.step_id FROM tutorial_steps t JOIN sessions s USING(session_id)
  WHERE datetime(t.event_time) < datetime(s.event_time)
     OR datetime(t.event_time) > datetime(s.event_time, '+' || s.duration_minutes || ' minutes')
);

SELECT 'tutorial_time_inversions' AS check_name, COUNT(*) AS failures
FROM tutorial_steps earlier JOIN tutorial_steps later USING(user_id)
WHERE CAST(later.step_id AS INTEGER) = CAST(earlier.step_id AS INTEGER) + 1
  AND datetime(later.event_time) < datetime(earlier.event_time);

SELECT 'cohort_day_mismatch' AS check_name, COUNT(*) AS failures
FROM player_daily
WHERE CAST(julianday(activity_date) - julianday(install_date) AS INTEGER) != CAST(cohort_day AS INTEGER);

SELECT app_version_install, COUNT(*) AS installs,
       SUM(CASE WHEN date(install_date) <= date((SELECT MAX(activity_date) FROM player_daily), '-7 days') THEN 1 ELSE 0 END) AS d7_mature
FROM users GROUP BY app_version_install ORDER BY app_version_install;

SELECT variant, COUNT(*) AS assigned,
       SUM(CASE WHEN exposure_status='exposed' THEN 1 ELSE 0 END) AS exposed
FROM ab_assignments GROUP BY variant ORDER BY variant;
"""


def instructor_guide() -> str:
    return """# Jelly Trail Academy v3 — Instructor Guide

Keep this folder separate from student delivery.

## Intended teaching signal

The strongest evidence points to release-specific product friction concentrated
in Android SEA. Investigate tutorial step 4 and levels 28–30 in Jelly Jungle.
Version 2.1.1 should show tutorial recovery and a measurable, partial progression
recovery among returning users who upgraded.

## Teaching cautions

- Install version and runtime version answer different questions.
- D7 must exclude immature cohorts.
- Repeated attempts are not independent users.
- LiveOps overlap is descriptive, not proof of lift.
- The A/B primary read is intent-to-treat; exposed-only analysis is secondary.
- Do not reveal the target segment or level band before the investigation.

The messy extension intentionally introduces duplicate delivery, missing paid
attribution, late-arriving records, refunds, and a schema extension. Its exact
injections are documented in `messy-extension-key.md`.
"""


def answer_key() -> str:
    return """# Instructor Answer Key — Jelly Trail Academy v3

Expected RCA chain:

1. Establish release-level audience and revenue movement.
2. Isolate the activation regression at tutorial step 4 for Android SEA on
   2.1.0, then observe recovery on 2.1.1.
3. Isolate lower completion and greater failure pressure at Jelly Jungle levels
   28–30 for Android SEA on 2.1.0.
4. Compare returning users on 2.1.1 to show partial progression recovery.
5. Recalculate D1/D7 using install cohorts and mature denominators.
6. Separate acquisition cost/mix from downstream product outcomes.
7. Treat LiveOps overlays as hypotheses and the randomized experiment as a
   distinct decision with confidence intervals and guardrails.

Accept alternative conclusions when the student states grain, denominator,
uncertainty, and evidence consistently.
"""


def signal_checks_sql() -> str:
    return """-- Instructor-only signal checks

SELECT app_version, platform,
       CASE WHEN country IN ('VN','TH','PH','ID') THEN 'SEA' ELSE 'Other' END region,
       ROUND(AVG(CASE WHEN step_completed=1 THEN 1.0 ELSE 0 END), 3) completion,
       COUNT(*) rows
FROM tutorial_steps WHERE step_id=4
GROUP BY app_version, platform, region ORDER BY app_version, platform, region;

SELECT app_version, platform,
       CASE WHEN country IN ('VN','TH','PH','ID') THEN 'SEA' ELSE 'Other' END region,
       ROUND(AVG(CASE WHEN result='complete' THEN 1.0 ELSE 0 END), 3) win_rate,
       COUNT(*) attempts
FROM level_attempts WHERE level_id IN (28,29,30)
GROUP BY app_version, platform, region ORDER BY app_version, platform, region;
"""


def write_clean_delivery(tables: dict[str, pd.DataFrame], output: Path) -> Path:
    root = output / "teaching-materials" / "student" / "synthetic_jelly_trail_academy_v3"
    data_dir = root / "data"
    docs_dir = root / "docs"
    sql_dir = root / "sql"
    data_dir.mkdir(parents=True)
    docs_dir.mkdir()
    sql_dir.mkdir()
    for name in TABLES:
        tables[name].to_csv(data_dir / f"{name}.csv", index=False)
    sqlite_path = root / "jelly_trail_academy_v3_game_da.sqlite"
    write_sqlite(tables, sqlite_path)
    (root / "README.md").write_text(student_readme(), encoding="utf-8")
    (docs_dir / "data_dictionary.md").write_text(data_dictionary(), encoding="utf-8")
    (docs_dir / "analysis_questions.md").write_text(analysis_questions(), encoding="utf-8")
    (docs_dir / "experiment_design.md").write_text(experiment_design(), encoding="utf-8")
    (sql_dir / "sanity_checks.sql").write_text(sanity_checks_sql(), encoding="utf-8")
    source_counts = {f"{name}.csv": len(tables[name]) for name in TABLES}
    file_hashes = {f"data/{name}.csv": sha256(data_dir / f"{name}.csv") for name in TABLES}
    file_hashes[sqlite_path.name] = sha256(sqlite_path)
    manifest = {
        "dataset_version": "3.0",
        "game": "Jelly Trail Academy",
        "studio": "Jellybridge Learning Lab",
        "synthetic": True,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "data_window": {"start": "2026-07-01", "end": "2026-08-29", "days": 60},
        "tables": source_counts,
        "sha256": file_hashes,
        "v3_changes": [
            "All linked events occur inside their sessions.",
            "Tutorial timestamps preserve step order.",
            "Runtime app-version migrations are represented separately from install cohorts.",
            "World names are consistent between metadata, events, and documentation.",
            "Student prompts are separated from instructor answers.",
            "A/B eligibility, exposure, primary metric, guardrail, and maturity are declared.",
            "A separate messy extension supports advanced data-quality teaching.",
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return root


def write_instructor_materials(output: Path) -> None:
    root = output / "teaching-materials" / "instructor"
    root.mkdir()
    (root / "instructor-guide.md").write_text(instructor_guide(), encoding="utf-8")
    (root / "answer-key.md").write_text(answer_key(), encoding="utf-8")
    (root / "validation-signal-checks.sql").write_text(signal_checks_sql(), encoding="utf-8")


def write_messy_extension(tables: dict[str, pd.DataFrame], output: Path) -> None:
    root = output / "teaching-materials" / "messy-extension"
    data_dir = root / "data"
    data_dir.mkdir(parents=True)

    users = tables["users"].copy()
    paid = users[users["channel"] != "Organic"].sort_values("user_id")
    gap_ids = set(paid.head(150)["user_id"])
    users.loc[users["user_id"].isin(gap_ids), "campaign_id"] = pd.NA
    users = pd.concat([users, users.sort_values("user_id").head(25)], ignore_index=True)
    users.to_csv(data_dir / "users.csv", index=False)

    purchases = tables["purchases"].copy()
    purchases["original_transaction_id"] = pd.NA
    refunds = purchases.sort_values("transaction_id").head(24).copy()
    refunds["original_transaction_id"] = refunds["transaction_id"]
    refunds["transaction_id"] = [f"jta_refund_{index:08d}" for index in range(1, len(refunds) + 1)]
    refunds["is_refund"] = 1
    duplicates = purchases.sort_values("transaction_id").iloc[24:32].copy()
    purchases = pd.concat([purchases, refunds, duplicates], ignore_index=True)
    purchases.to_csv(data_dir / "purchases.csv", index=False)

    ads = tables["ad_events"].copy()
    ads.loc[ads.sort_values("ad_id").head(75).index, "session_id"] = pd.NA
    ads = pd.concat([ads, ads.sort_values("ad_id").iloc[75:175]], ignore_index=True)
    ads.to_csv(data_dir / "ad_events.csv", index=False)

    attempts = tables["level_attempts"].copy()
    event_time = pd.to_datetime(attempts["event_time"])
    attempts["ingested_at"] = event_time + pd.Timedelta(minutes=5)
    late_indices = attempts.sort_values("attempt_id").head(250).index
    late_days = [3 + (index % 8) for index in range(len(late_indices))]
    attempts.loc[late_indices, "ingested_at"] = event_time.loc[late_indices] + pd.to_timedelta(late_days, unit="D")
    attempts["ingested_at"] = attempts["ingested_at"].dt.strftime("%Y-%m-%dT%H:%M:%S")
    attempts = pd.concat([attempts, attempts.sort_values("attempt_id").iloc[250:350]], ignore_index=True)
    attempts.to_csv(data_dir / "level_attempts.csv", index=False)

    (root / "README.md").write_text(
        """# Jelly Trail Academy v3 — Messy Extension

Use these four CSV files as replacements for the same clean-base tables. The
remaining clean tables are unchanged. This extension intentionally contains
realistic delivery, attribution, refund, lateness, and schema-quality problems.

Student task: profile the files, define canonical deduplication and late-data
policies, reconcile revenue, and document which issues change business metrics.
Do not assume every missing value or repeated row has the same treatment.
""",
        encoding="utf-8",
    )
    (output / "teaching-materials" / "instructor" / "messy-extension-key.md").write_text(
        """# Messy Extension — Instructor Key

- `users.csv`: 25 duplicate user rows and 150 missing paid campaign IDs.
- `purchases.csv`: 24 refund transactions, 8 duplicate deliveries, and a new
  `original_transaction_id` column.
- `ad_events.csv`: 75 missing session IDs and 100 duplicate deliveries.
- `level_attempts.csv`: 250 records delivered 3–10 days late, 100 duplicate
  deliveries, and a new `ingested_at` field.

Require students to preserve raw data, produce a cleaned model, and quantify
metric impact instead of editing source files in place.
""",
        encoding="utf-8",
    )


def write_build_outputs(output: Path, validation: dict[str, object], clean_root: Path) -> None:
    report_root = output / "build-report"
    generator_root = output / "generator"
    report_root.mkdir()
    generator_root.mkdir()

    (report_root / "build-validation.json").write_text(
        json.dumps(validation, indent=2),
        encoding="utf-8",
    )
    summary = f"""# Jelly Trail Academy v3 — Build Report

- Status: passed
- Clean dataset: `{clean_root.relative_to(output)}`
- Clean event rows outside sessions: {sum(validation['outside_sessions'].values())}
- Tutorial timestamp inversions: {validation['tutorial_inversions']}
- Cohort-day mismatches: {validation['cohort_day_mismatches']}
- Android SEA level 28–30 attempt counts: {json.dumps(validation['progression_attempts_android_sea'])}
- Android SEA level 28–30 win rates: {json.dumps(validation['progression_win_rates_android_sea'])}

The machine-readable validation result is in `build-validation.json`. Rebuild
from source with the script stored separately in `../generator/`.
"""
    (report_root / "build-summary.md").write_text(summary, encoding="utf-8")
    shutil.copy2(Path(__file__), generator_root / "build-jelly-trail-dataset-v3.py")


def validate_clean(tables: dict[str, pd.DataFrame]) -> dict[str, object]:
    keys = {
        "users": ["user_id"],
        "sessions": ["session_id"],
        "player_daily": ["user_id", "activity_date"],
        "level_attempts": ["attempt_id"],
        "booster_events": ["booster_event_id"],
        "purchases": ["transaction_id"],
        "ad_events": ["ad_id"],
        "ab_assignments": ["user_id", "experiment_id"],
    }
    duplicates = {name: int(tables[name].duplicated(fields).sum()) for name, fields in keys.items()}
    if any(duplicates.values()):
        raise ValueError(f"Clean-key duplicates: {duplicates}")

    users = set(tables["users"]["user_id"])
    sessions = tables["sessions"].copy()
    session_ids = set(sessions["session_id"])
    for name in ["tutorial_steps", "level_attempts", "booster_events", "purchases", "ad_events"]:
        frame = tables[name]
        if not set(frame["user_id"]).issubset(users):
            raise ValueError(f"{name}: orphan user")
        if not set(frame["session_id"]).issubset(session_ids):
            raise ValueError(f"{name}: orphan session")

    session_window = sessions[["session_id", "event_time", "duration_minutes"]].copy()
    session_window["start"] = pd.to_datetime(session_window["event_time"])
    session_window["end"] = session_window["start"] + pd.to_timedelta(session_window["duration_minutes"], unit="m")
    outside: dict[str, int] = {}
    for name in ["tutorial_steps", "level_attempts", "booster_events", "purchases", "ad_events"]:
        merged = tables[name].merge(session_window[["session_id", "start", "end"]], on="session_id")
        event_time = pd.to_datetime(merged["event_time"])
        outside[name] = int(((event_time < merged["start"]) | (event_time > merged["end"])).sum())
    if any(outside.values()):
        raise ValueError(f"Events outside sessions: {outside}")

    tutorial = tables["tutorial_steps"].copy()
    tutorial["event_time"] = pd.to_datetime(tutorial["event_time"])
    pivot = tutorial.pivot(index="user_id", columns="step_id", values="event_time")
    inversions = 0
    for step in range(1, 5):
        present = pivot[step].notna() & pivot[step + 1].notna()
        inversions += int((present & (pivot[step + 1] < pivot[step])).sum())
    if inversions:
        raise ValueError(f"Tutorial time inversions: {inversions}")

    daily = tables["player_daily"].copy()
    cohort_mismatch = int(
        (
            (pd.to_datetime(daily["activity_date"]) - pd.to_datetime(daily["install_date"])).dt.days
            != daily["cohort_day"]
        ).sum()
    )
    if cohort_mismatch:
        raise ValueError(f"Cohort-day mismatches: {cohort_mismatch}")

    attempts = tables["level_attempts"]
    band = attempts[attempts["level_id"].isin([28, 29, 30])]
    affected = band[(band["platform"] == "Android") & band["country"].isin(SEA)]
    rates = {}
    counts = {}
    for version in ["2.0.2", "2.1.0", "2.1.1"]:
        selected = affected[affected["app_version"] == version]
        rates[version] = float((selected["result"] == "complete").mean()) if len(selected) else 0
        counts[version] = len(selected)
    if min(counts.values()) < 200:
        raise ValueError(f"Progression comparison lacks coverage: {counts}")
    if not (rates["2.0.2"] > rates["2.1.1"] > rates["2.1.0"]):
        raise ValueError(f"Progression story is not baseline > hotfix > bad release: {rates}")
    if not 0.58 <= rates["2.1.1"] <= 0.70 or not 0.46 <= rates["2.1.0"] <= 0.58:
        raise ValueError(f"Progression effect sizes are outside teaching bounds: {rates}")

    world_values = set(attempts.loc[attempts["level_id"].isin([28, 29, 30]), "world_name"])
    if world_values != {"Jelly Jungle"}:
        raise ValueError(f"Unexpected world names for levels 28-30: {world_values}")

    return {
        "duplicates": duplicates,
        "outside_sessions": outside,
        "tutorial_inversions": inversions,
        "cohort_day_mismatches": cohort_mismatch,
        "progression_attempts_android_sea": counts,
        "progression_win_rates_android_sea": {key: round(value, 4) for key, value in rates.items()},
    }


def main() -> None:
    args = parse_args()
    require_clean_output(args.output)
    tables = load_tables(args.source)
    add_tutorial_sessions(tables)
    assign_runtime_versions(tables)
    apply_hotfix_progression_signal(tables)
    schedule_events_within_sessions(tables)
    rebuild_player_daily_and_kpi(tables)
    enrich_experiment_design(tables)
    sanitize_student_metadata(tables)
    validation = validate_clean(tables)
    clean_root = write_clean_delivery(tables, args.output)
    write_instructor_materials(args.output)
    write_messy_extension(tables, args.output)
    write_build_outputs(args.output, validation, clean_root)
    print(json.dumps({"output": str(args.output), "clean_dataset": str(clean_root), **validation}, indent=2))


if __name__ == "__main__":
    main()
