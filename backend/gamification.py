"""Server-side practice rewards for the SQL console."""
from __future__ import annotations

import datetime as dt
import hashlib
import sqlite3
import threading
from pathlib import Path
from typing import Any

DAILY_STAR_CAP = 20
ACHIEVEMENTS = {
    "first_query": ("First Query", "Run your first successful SQL query."),
    "schema_explorer": ("Schema Explorer", "Use five different tables."),
    "join_builder": ("Join Builder", "Run a successful query that uses JOIN."),
    "aggregation": ("Aggregation", "Run a successful query with GROUP BY."),
    "week_streak": ("One Week", "Practice on seven consecutive days."),
    "month_streak": ("One Month", "Practice on thirty consecutive days."),
}


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def _query_hash(sql: str) -> str:
    normalised = " ".join(sql.lower().split())
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


class GamificationStore:
    """SQLite store kept separate from the read-only DuckDB datasets."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        with self._connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS practice_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    practice_date TEXT NOT NULL,
                    query_hash TEXT NOT NULL,
                    tables_used TEXT NOT NULL DEFAULT '',
                    query_kind TEXT NOT NULL DEFAULT 'query',
                    created_at TEXT NOT NULL,
                    UNIQUE(username, practice_date, query_hash)
                );
                CREATE TABLE IF NOT EXISTS practice_daily (
                    username TEXT NOT NULL,
                    practice_date TEXT NOT NULL,
                    successful_queries INTEGER NOT NULL DEFAULT 0,
                    unique_queries INTEGER NOT NULL DEFAULT 0,
                    stars_earned INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(username, practice_date)
                );
                CREATE TABLE IF NOT EXISTS user_rewards (
                    username TEXT PRIMARY KEY,
                    stars INTEGER NOT NULL DEFAULT 0,
                    diamonds INTEGER NOT NULL DEFAULT 0,
                    current_streak INTEGER NOT NULL DEFAULT 0,
                    longest_streak INTEGER NOT NULL DEFAULT 0,
                    last_practice_date TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS user_achievements (
                    username TEXT NOT NULL,
                    achievement_code TEXT NOT NULL,
                    earned_at TEXT NOT NULL,
                    PRIMARY KEY(username, achievement_code)
                );
                """
            )
            con.commit()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.path), timeout=10.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA busy_timeout=10000")
        return con

    @property
    def _con(self) -> sqlite3.Connection:
        con = getattr(self._local, "con", None)
        if con is None:
            con = self._connect()
            self._local.con = con
        return con

    def close(self) -> None:
        con = getattr(self._local, "con", None)
        if con is not None:
            con.close()
            self._local.con = None

    def record_success(self, username: str, sql: str, tables_used: list[str]) -> dict[str, Any]:
        today = _today()
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        query_hash = _query_hash(sql)
        lowered = " ".join(sql.lower().split())
        kind = "join" if " join " in f" {lowered} " else "aggregation" if "group by" in lowered else "query"
        with self._write_lock:
            con = self._con
            con.execute("BEGIN IMMEDIATE")
            try:
                reward = con.execute(
                    "SELECT stars, diamonds, current_streak, longest_streak, last_practice_date "
                    "FROM user_rewards WHERE username = ?",
                    (username,),
                ).fetchone()
                if reward is None:
                    con.execute("INSERT INTO user_rewards(username, updated_at) VALUES (?, ?)", (username, now))
                    reward = con.execute(
                        "SELECT stars, diamonds, current_streak, longest_streak, last_practice_date "
                        "FROM user_rewards WHERE username = ?", (username,)
                    ).fetchone()
                event = con.execute(
                    "SELECT 1 FROM practice_events WHERE username=? AND practice_date=? AND query_hash=?",
                    (username, today, query_hash),
                ).fetchone()
                daily = con.execute(
                    "SELECT successful_queries, unique_queries, stars_earned FROM practice_daily "
                    "WHERE username=? AND practice_date=?", (username, today)
                ).fetchone()
                if daily is None:
                    con.execute("INSERT INTO practice_daily(username, practice_date) VALUES (?, ?)", (username, today))
                    daily = (0, 0, 0)
                successful, unique, earned = map(int, daily)
                successful += 1
                stars_earned = 0
                if event is None:
                    unique += 1
                    if earned < DAILY_STAR_CAP:
                        stars_earned = min(1 if unique == 1 else 2, DAILY_STAR_CAP - earned)
                        con.execute(
                            "INSERT INTO practice_events(username, practice_date, query_hash, tables_used, query_kind, created_at) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            (username, today, query_hash, ",".join(sorted(tables_used)), kind, now),
                        )
                con.execute(
                    "UPDATE practice_daily SET successful_queries=?, unique_queries=?, stars_earned=? "
                    "WHERE username=? AND practice_date=?",
                    (successful, unique, earned + stars_earned, username, today),
                )
                current, longest, last_date = int(reward[2]), int(reward[3]), reward[4]
                if last_date != today:
                    yesterday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
                    current = current + 1 if last_date == yesterday else 1
                longest = max(longest, current)
                total_stars = int(reward[0]) + stars_earned
                diamonds = int(reward[1]) + (1 if total_stars // 100 > int(reward[0]) // 100 else 0)
                con.execute(
                    "UPDATE user_rewards SET stars=?, diamonds=?, current_streak=?, longest_streak=?, "
                    "last_practice_date=?, updated_at=? WHERE username=?",
                    (total_stars, diamonds, current, longest, today, now, username),
                )
                unlocked = self._unlock_achievements(con, username, current, kind, now)
                con.commit()
            except Exception:
                con.rollback()
                raise
        return self.summary(username, stars_earned=stars_earned, unlocked=unlocked)

    def _unlock_achievements(self, con: sqlite3.Connection, username: str, streak: int, kind: str, now: str) -> list[dict[str, str]]:
        successful = con.execute(
            "SELECT COALESCE(SUM(successful_queries), 0) FROM practice_daily WHERE username=?",
            (username,),
        ).fetchone()[0]
        table_names: set[str] = set()
        for row in con.execute("SELECT tables_used FROM practice_events WHERE username=?", (username,)):
            table_names.update(filter(None, row[0].split(",")))
        candidates: list[str] = []
        if successful >= 1:
            candidates.append("first_query")
        if len(table_names) >= 5:
            candidates.append("schema_explorer")
        if kind == "join":
            candidates.append("join_builder")
        if kind == "aggregation":
            candidates.append("aggregation")
        if streak >= 7:
            candidates.append("week_streak")
        if streak >= 30:
            candidates.append("month_streak")
        unlocked: list[dict[str, str]] = []
        for code in candidates:
            cur = con.execute(
                "INSERT OR IGNORE INTO user_achievements(username, achievement_code, earned_at) VALUES (?, ?, ?)",
                (username, code, now),
            )
            if cur.rowcount:
                unlocked.append({"code": code, "name": ACHIEVEMENTS[code][0], "description": ACHIEVEMENTS[code][1]})
        return unlocked

    def summary(self, username: str, *, stars_earned: int = 0, unlocked: list[dict[str, str]] | None = None) -> dict[str, Any]:
        today = _today()
        reward = self._con.execute(
            "SELECT stars, diamonds, current_streak, longest_streak FROM user_rewards WHERE username=?",
            (username,),
        ).fetchone()
        daily = self._con.execute(
            "SELECT successful_queries, unique_queries, stars_earned FROM practice_daily "
            "WHERE username=? AND practice_date=?", (username, today)
        ).fetchone()
        achievements = self._con.execute(
            "SELECT achievement_code, earned_at FROM user_achievements WHERE username=? ORDER BY earned_at DESC",
            (username,),
        ).fetchall()
        return {
            "stars": int(reward[0]) if reward else 0,
            "diamonds": int(reward[1]) if reward else 0,
            "current_streak": int(reward[2]) if reward else 0,
            "longest_streak": int(reward[3]) if reward else 0,
            "today_queries": int(daily[0]) if daily else 0,
            "today_unique_queries": int(daily[1]) if daily else 0,
            "today_stars": int(daily[2]) if daily else 0,
            "stars_earned": stars_earned,
            "new_achievements": unlocked or [],
            "achievements": [
                {"code": row[0], "name": ACHIEVEMENTS.get(row[0], (row[0], ""))[0], "earned_at": row[1]}
                for row in achievements
            ],
        }

    def leaderboard(
        self,
        period: str = "week",
        limit: int = 20,
        only: "frozenset[str] | set[str] | tuple[str, ...] | None" = None,
    ) -> list[dict[str, Any]]:
        """Bang xep hang, gioi han trong `only`.

        CHO PHEP chu khong LOAI TRU, va su khac biet la thuc chat. Danh sach loai
        tru chi chan duoc nhung ai NGUOI GOI CON BIET la phai chan; diem cua mot
        tai khoan da xoa thi khong ai nhan ra nua va no o lai bang mai mai. Kho
        nay giu diem theo TEN, khong co khoa ngoai toi tai khoan, nen ten mo coi
        la chuyen binh thuong - khong phai truong hop hiem.

        `only=None` nghia la khong gioi han (dung cho test cua chinh kho nay).
        `only=frozenset()` nghia la KHONG AI - bang rong, khong phai bang day du.
        Hai cai do khac nhau, va lan nhau se lo het diem ra.

        Loc TRONG SQL, TRUOC `LIMIT`: xin 20 roi bo bot se ra bang ngan hon 20 ma
        khong co gi bao.
        """
        limit = max(1, min(int(limit), 100))
        keep = None if only is None else tuple(only)
        if keep is not None and not keep:
            return []
        # Placeholder dung so phan tu. Khong bao gio noi chuoi ten vao SQL: ten
        # dang nhap do nguoi khac dat, va `admin_cli import-csv` nhan ca file
        # danh sach lop tu ben ngoai.
        holes = ",".join("?" * len(keep)) if keep else ""

        if period == "all":
            # Diem va chuoi ngay la so TICH LUY, nam o `user_rewards`, khong
            # cong lai duoc tu `practice_daily`: mot ngay bo tap lam dut chuoi,
            # va phep cong khong biet dieu do.
            rows = self._con.execute(
                "SELECT r.username, r.stars, COALESCE(d.queries, 0), r.current_streak "
                "FROM user_rewards r "
                "LEFT JOIN (SELECT username, SUM(successful_queries) AS queries "
                "           FROM practice_daily GROUP BY username) d "
                "  ON d.username = r.username "
                + (f"WHERE r.username IN ({holes}) " if keep else "")
                + "ORDER BY r.stars DESC, COALESCE(d.queries, 0) DESC, r.username ASC LIMIT ?",
                (*(keep or ()), limit),
            ).fetchall()
            return [
                {
                    "rank": index,
                    "username": row[0],
                    "stars": int(row[1]),
                    "queries": int(row[2]),
                    "streak": int(row[3]),
                }
                for index, row in enumerate(rows, 1)
            ]

        today = dt.date.fromisoformat(_today())
        start = today if period == "day" else today.replace(day=1) if period == "month" else today - dt.timedelta(days=today.weekday())
        rows = self._con.execute(
            "SELECT username, SUM(stars_earned) stars, SUM(successful_queries) queries "
            "FROM practice_daily WHERE practice_date >= ? "
            + (f"AND username IN ({holes}) " if keep else "")
            + "GROUP BY username ORDER BY stars DESC, queries DESC, username ASC LIMIT ?",
            (start.isoformat(), *(keep or ()), limit),
        ).fetchall()
        return [
            {"rank": index, "username": row[0], "stars": int(row[1]), "queries": int(row[2]), "streak": None}
            for index, row in enumerate(rows, 1)
        ]
