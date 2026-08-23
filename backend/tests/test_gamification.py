from __future__ import annotations

from backend.gamification import DAILY_STAR_CAP, GamificationStore


def test_first_query_reward_is_idempotent(tmp_path):
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    first = store.record_success("student", "SELECT 1", [])
    duplicate = store.record_success("student", "  select   1 ", [])
    assert first["stars_earned"] == 1
    assert duplicate["stars_earned"] == 0
    assert duplicate["stars"] == 1
    assert duplicate["today_unique_queries"] == 1
    assert any(item["code"] == "first_query" for item in first["new_achievements"])
    store.close()


def test_daily_cap_and_query_count(tmp_path):
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    for index in range(20):
        store.record_success("student", f"SELECT {index}", [])
    summary = store.record_success("student", "SELECT 999", [])
    assert summary["today_stars"] == DAILY_STAR_CAP
    assert summary["stars"] == DAILY_STAR_CAP
    assert summary["today_queries"] == 21
    store.close()


def test_leaderboard_orders_stars(tmp_path):
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    store.record_success("alice", "SELECT 1", [])
    store.record_success("bob", "SELECT 2", [])
    store.record_success("bob", "SELECT 3", [])
    board = store.leaderboard("day")
    assert board[0]["username"] == "bob"
    assert board[0]["stars"] > board[1]["stars"]
    store.close()


def test_all_time_leaderboard_carries_the_streak(tmp_path):
    """Ky `all` cong don tu truoc toi nay va mang them cot chuoi ngay.

    Cac ky theo lich chi doc `practice_daily` nen khong biet chuoi ngay; chung
    tra `streak = None` chu khong tra 0, de giao dien phan biet duoc "khong co so
    lieu" voi "chuoi bang khong".
    """
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    store.record_success("alice", "SELECT 1", [])
    store.record_success("bob", "SELECT 2", [])
    store.record_success("bob", "SELECT 3", [])

    board = store.leaderboard("all")
    assert [row["username"] for row in board] == ["bob", "alice"]
    assert board[0]["queries"] == 2
    assert board[0]["streak"] == 1
    assert store.leaderboard("day")[0]["streak"] is None
    store.close()


def test_only_cuts_before_the_limit(tmp_path):
    """`only` phai loc TRONG SQL, truoc `LIMIT`.

    Loc bang Python sau khi da lay ve la cach hong de mac nhat: xin 3 dong thi
    lay 3 roi bo bot con 1, va bang cut di ma khong co gi bao. Cang nhieu ten bi
    loai thi cang cut. Phep kiem nay dat hai nguoi bi loai len DAU bang de kieu
    hong do lo ra ngay.
    """
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    # gv1/gv2 nhieu diem nhat -> ho se chiem het cho neu loc sai thu tu.
    for name, runs in (("gv1", 5), ("gv2", 4), ("sv1", 3), ("sv2", 2), ("sv3", 1)):
        for index in range(runs):
            store.record_success(name, f"SELECT {name} {index}", [])

    for period in ("day", "week", "month", "all"):
        board = store.leaderboard(period, limit=3, only=frozenset({"sv1", "sv2", "sv3"}))
        names = [row["username"] for row in board]
        assert names == ["sv1", "sv2", "sv3"], f"ky {period}: {names}"
        assert [row["rank"] for row in board] == [1, 2, 3], f"ky {period} danh so sai"
    store.close()


def test_only_none_means_everyone_but_empty_means_nobody(tmp_path):
    """`None` va `frozenset()` PHAI khac nhau.

    Neu lan nhau thi mot lop chua co hoc vien nao se hien ra TOAN BO diem con
    sot trong kho - ke ca cua tai khoan da xoa tu lau.
    """
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    store.record_success("alice", "SELECT 1", [])
    assert [row["username"] for row in store.leaderboard("all")] == ["alice"]
    assert store.leaderboard("all", only=frozenset()) == []
    assert store.leaderboard("day", only=frozenset()) == []
    store.close()


def test_only_hides_names_the_roster_no_longer_knows(tmp_path):
    """Diem cua tai khoan da xoa khong duoc o lai bang.

    Kho nay giu diem theo TEN, khong co khoa ngoai toi tai khoan - nen xoa tai
    khoan khong xoa diem. Mot danh sach LOAI TRU se bo sot dung truong hop nay:
    khong ai con biet `cuu_giang_vien` tung la giang vien de ma loai.
    """
    store = GamificationStore(tmp_path / "rewards.sqlite3")
    for name in ("cuu_giang_vien", "da_nghi_hoc", "sv_dang_hoc"):
        store.record_success(name, f"SELECT '{name}'", [])
    board = store.leaderboard("all", only=frozenset({"sv_dang_hoc"}))
    assert [row["username"] for row in board] == ["sv_dang_hoc"]
    store.close()


def test_gamification_requires_session(anon_client):
    response = anon_client.get("/gamification/me")
    assert response.status_code == 401


def test_leaderboard_never_lists_instructors(client, instructor_client):
    """Bang xep hang la cua HOC VIEN, voi MOI vai tro dang xem.

    Giang vien luyen tap tren cung he thong (va phai the, de thu bai truoc khi
    giao), nen ho CO diem. Diem do khong thuoc ve bang thi dua cua lop.

    Phep kiem chay ca hai phien: neu viec loc bi day len giao dien thi phien
    giang vien se van thay minh, va hai nguoi se nhin hai bang khac nhau.
    """
    from .conftest import INSTRUCTOR_USER, STUDENT_USER

    # Ca hai cung chay mot query hop le -> ca hai cung co diem. Khong co buoc
    # nay thi bang rong va phep kiem xanh vi ly do sai.
    for session in (client, instructor_client):
        assert session.post("/query", json={"sql": "SELECT 1 AS n"}).status_code == 200

    for label, session in (("hoc vien", client), ("giang vien", instructor_client)):
        response = session.get("/gamification/leaderboard?period=all")
        assert response.status_code == 200, label
        names = [row["username"] for row in response.json()["entries"]]
        assert INSTRUCTOR_USER not in names, f"phien {label} thay giang vien: {names}"
        # Doi chung duong: bang that su co nguoi, nen phep kiem tren co nghia.
        assert STUDENT_USER in names, f"phien {label}: bang khong co hoc vien nao"


def test_leaderboard_rejects_an_unknown_period(client):
    response = client.get("/gamification/leaderboard?period=forever")
    assert response.status_code == 400
    assert response.json()["error_code"] == "E_INVALID_PERIOD"


def test_instructor_analytics_is_instructor_only(client, instructor_client):
    assert client.get("/admin/analytics/queries").status_code == 403
    response = instructor_client.get("/admin/analytics/queries")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "summary" in response.json()
