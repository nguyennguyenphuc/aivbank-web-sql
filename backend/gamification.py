"""Server-side practice rewards for the SQL console."""
from __future__ import annotations

import datetime as dt
import hashlib
from typing import Any

from psycopg_pool import ConnectionPool

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
    """Kho diem tren PostgreSQL, trong database `aivb_app`.

    TACH khoi hai database du lieu co chu dinh: `restore.py` dung lai
    `aivb_student` / `aivb_instructor` moi lan nap dump, nen de diem o do
    la mat toan bo lich su luyen tap cua lop ma khong ai nhan ra cho toi
    luc hoc vien hoi. Xem `database/schema/16_app_database.sql`.
    """

    def __init__(self, conninfo: str, *, pool_max: int = 6, pool_min: int = 1) -> None:
        """Pool that su, theo dung khuon `backend/db.py`.

        Ban cu giu MOT `psycopg.connect` tho cho MOI luong OS trong
        `threading.local()`, khong bao gio dong va khong bao gio tai tao. FastAPI
        chay endpoint dong bo tren threadpool cua anyio (mac dinh 40 luong), nen
        moi luong tung phuc vu `/query` hay `/gamification/*` ghim VINH VIEN mot
        ket noi. `aivb_app_rw` co `CONNECTION LIMIT`, va `AuthStore` cung an vao
        do - ket cuc la `FATAL: too many connections for role "aivb_app_rw"`.
        `close()` thi chi dong ket noi cua LUONG GOI, va no duoc goi mot lan luc
        tat may tu luong event-loop, nen ca phan con lai ro sach.

        `autocommit=True` la co y, KHONG phai `autocommit=False`: voi
        autocommit tat thi mot `SELECT` tran cung mo giao dich, va ta phai trong
        vao commit-luc-thoat cua pool. Dung, nhung do la CUNG HINH DANG voi con
        bug - chi can mot `return` som trong khoi la quay lai "idle in
        transaction". Voi `autocommit=True` duong DOC khong the de lai mot giao
        dich mo du thoat kieu gi; duong GHI thi mo giao dich TUONG MINH bang
        `con.transaction()`.
        """
        self.conninfo = conninfo
        self._pool = ConnectionPool(
            conninfo=conninfo,
            min_size=max(1, pool_min),
            max_size=max(1, pool_max),
            timeout=5.0,
            max_lifetime=1800.0,
            max_idle=300.0,
            # Duong tai tao khi ket noi chet (postgres restart, dut mang).
            # Ban cu khong co gi tuong duong: handle chet nam mai trong
            # `threading.local()` va moi loi goi sau do tren luong do deu hong.
            check=ConnectionPool.check_connection,
            kwargs={"autocommit": True},
            open=False,
            name="aivb-app-gamification",
        )
        # KHONG `wait=True`: diem so la thu co the thieu. `aivb_app` chua len thi
        # dich vu van phai khoi dong duoc - `/query` quan trong hon `/gamification`.
        self._pool.open()

    def close(self) -> None:
        try:
            self._pool.close()
        except Exception:  # pragma: no cover - dang tat may
            pass

    def record_success(self, username: str, sql: str, tables_used: list[str]) -> dict[str, Any]:
        today = _today()
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        query_hash = _query_hash(sql)
        lowered = " ".join(sql.lower().split())
        kind = "join" if " join " in f" {lowered} " else "aggregation" if "group by" in lowered else "query"
        with self._pool.connection() as con:
            # Giao dich TUONG MINH: pool phat ket noi `autocommit=True`, nen
            # khong co giao dich ngam nao het.
            #
            # Khoa theo HANG (`FOR UPDATE`) thay cho `threading.Lock` toan tien
            # trinh: khoa Python vo dung ngay khi uvicorn chay hon mot worker,
            # va no xep hang ca lop sau lung mot hoc vien.
            with con.transaction():
                con.execute(
                    "INSERT INTO app.user_rewards(username, updated_at) VALUES (%s, %s) "
                    "ON CONFLICT (username) DO NOTHING",
                    (username, now),
                )
                reward = con.execute(
                    "SELECT stars, diamonds, current_streak, longest_streak, last_practice_date "
                    "FROM app.user_rewards WHERE username = %s FOR UPDATE",
                    (username,),
                ).fetchone()
                event = con.execute(
                    "SELECT 1 FROM app.practice_events WHERE username=%s AND practice_date=%s AND query_hash=%s",
                    (username, today, query_hash),
                ).fetchone()
                daily = con.execute(
                    "SELECT successful_queries, unique_queries, stars_earned FROM app.practice_daily "
                    "WHERE username=%s AND practice_date=%s", (username, today)
                ).fetchone()
                if daily is None:
                    con.execute(
                        "INSERT INTO app.practice_daily(username, practice_date) VALUES (%s, %s) "
                        "ON CONFLICT DO NOTHING",
                        (username, today),
                    )
                    daily = (0, 0, 0)
                successful, unique, earned = map(int, daily)
                successful += 1
                stars_earned = 0
                if event is None:
                    unique += 1
                    if earned < DAILY_STAR_CAP:
                        stars_earned = min(1 if unique == 1 else 2, DAILY_STAR_CAP - earned)
                        con.execute(
                            "INSERT INTO app.practice_events(username, practice_date, query_hash, tables_used, query_kind, created_at) "
                            "VALUES (%s, %s, %s, %s, %s, %s)",
                            (username, today, query_hash, ",".join(sorted(tables_used)), kind, now),
                        )
                con.execute(
                    "UPDATE app.practice_daily SET successful_queries=%s, unique_queries=%s, stars_earned=%s "
                    "WHERE username=%s AND practice_date=%s",
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
                    "UPDATE app.user_rewards SET stars=%s, diamonds=%s, current_streak=%s, longest_streak=%s, "
                    "last_practice_date=%s, updated_at=%s WHERE username=%s",
                    (total_stars, diamonds, current, longest, today, now, username),
                )
                unlocked = self._unlock_achievements(con, username, current, kind, now)
            # Da COMMIT (thoat `con.transaction()`). Doc lai tren CHINH ket noi
            # nay - KHONG duoc goi `self.summary()` cong khai o day: do la muon
            # ket noi THU HAI trong khi con giu cai thu nhat, va `pool_max` lan
            # goi dong thoi moi cai giu mot cai roi cho cai nua = deadlock cho
            # toi khi `timeout` no.
            return self._summary_on(
                con, username, stars_earned=stars_earned, unlocked=unlocked
            )

    def _unlock_achievements(self, con, username: str, streak: int, kind: str, now: str) -> list[dict[str, str]]:
        successful = con.execute(
            "SELECT COALESCE(SUM(successful_queries), 0) FROM app.practice_daily WHERE username=%s",
            (username,),
        ).fetchone()[0]
        # Quet moi `practice_events` cua hoc vien CHI de dem so bang khac nhau -
        # va chi de tra loi mot cau hoi da tra loi xong: da mo khoa
        # `schema_explorer` chua. Mot hoc vien 5000 su kien phai tra gia cho
        # phep quet do tren MOI lan Run neu khong co cho chan nay.
        already_explorer = con.execute(
            "SELECT 1 FROM app.user_achievements "
            "WHERE username=%s AND achievement_code='schema_explorer'",
            (username,),
        ).fetchone() is not None
        table_names: set[str] = set()
        if not already_explorer:
            for row in con.execute(
                "SELECT tables_used FROM app.practice_events WHERE username=%s",
                (username,),
            ):
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
                "INSERT INTO app.user_achievements(username, achievement_code, earned_at) "
                "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (username, code, now),
            )
            if cur.rowcount:
                unlocked.append({"code": code, "name": ACHIEVEMENTS[code][0], "description": ACHIEVEMENTS[code][1]})
        return unlocked

    def summary(self, username: str, *, stars_earned: int = 0, unlocked: list[dict[str, str]] | None = None) -> dict[str, Any]:
        with self._pool.connection() as con:
            return self._summary_on(
                con, username, stars_earned=stars_earned, unlocked=unlocked
            )

    def _summary_on(self, con, username: str, *, stars_earned: int = 0, unlocked: list[dict[str, str]] | None = None) -> dict[str, Any]:
        today = _today()
        reward = con.execute(
            "SELECT stars, diamonds, current_streak, longest_streak FROM app.user_rewards WHERE username=%s",
            (username,),
        ).fetchone()
        daily = con.execute(
            "SELECT successful_queries, unique_queries, stars_earned FROM app.practice_daily "
            "WHERE username=%s AND practice_date=%s", (username, today)
        ).fetchone()
        achievements = con.execute(
            "SELECT achievement_code, earned_at FROM app.user_achievements WHERE username=%s ORDER BY earned_at DESC",
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
        # `["%s"] * n` chu KHONG phai `"%s" * n`: placeholder cua psycopg dai
        # HAI ky tu, nen `",".join("%s%s%s")` se noi tung KY TU va ra
        # `%,s,%,s,%,s`. Ban SQLite dung `?` mot ky tu nen khong dinh.
        holes = ",".join(["%s"] * len(keep)) if keep else ""

        # MOT ket noi cho ca hai nhanh `period`, va tra lai pool khi thoat.
        # Ban cu doc bang `self._con` - ket noi thread-local `autocommit=False`
        # khong bao gio commit/rollback, nen moi luong nam "idle in
        # transaction" vinh vien: ghim snapshot, chan VACUUM tren schema `app`.
        with self._pool.connection() as con:
            if period == "all":
                # Diem va chuoi ngay la so TICH LUY, nam o `user_rewards`, khong
                # cong lai duoc tu `practice_daily`: mot ngay bo tap lam dut chuoi,
                # va phep cong khong biet dieu do.
                rows = con.execute(
                    "SELECT r.username, r.stars, COALESCE(d.queries, 0), r.current_streak "
                    "FROM app.user_rewards r "
                    "LEFT JOIN (SELECT username, SUM(successful_queries) AS queries "
                    "           FROM app.practice_daily GROUP BY username) d "
                    "  ON d.username = r.username "
                    + (f"WHERE r.username IN ({holes}) " if keep else "")
                    + "ORDER BY r.stars DESC, COALESCE(d.queries, 0) DESC, r.username ASC LIMIT %s",
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
            rows = con.execute(
                "SELECT username, SUM(stars_earned) stars, SUM(successful_queries) queries "
                "FROM app.practice_daily WHERE practice_date >= %s "
                + (f"AND username IN ({holes}) " if keep else "")
                + "GROUP BY username ORDER BY stars DESC, queries DESC, username ASC LIMIT %s",
                (start.isoformat(), *(keep or ()), limit),
            ).fetchall()
            return [
                {"rank": index, "username": row[0], "stars": int(row[1]), "queries": int(row[2]), "streak": None}
                for index, row in enumerate(rows, 1)
            ]
