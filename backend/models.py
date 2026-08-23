"""Request / response schemas. These are the API contract in code form."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    sql: str = Field(..., description="A single read-only SELECT statement.")
    dataset: str | None = Field(
        default=None,
        description=(
            "Which teaching dataset to run against. Omit for the default one, "
            "so a client written before datasets existed keeps working."
        ),
    )
    max_rows: int | None = Field(
        default=None,
        ge=1,
        description="Client-requested row cap. Clamped to the server maximum.",
    )


class QueryResponse(BaseModel):
    ok: Literal[True] = True
    columns: list[str]
    column_types: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    row_limit: int
    elapsed_ms: float
    tables_used: list[str]
    executed_sql: str
    gamification: dict[str, Any] | None = None


class ErrorResponse(BaseModel):
    ok: Literal[False] = False
    error_code: str
    message: str


class ColumnOut(BaseModel):
    name: str
    type: str
    nullable: bool
    primary_key: bool


class TableSummary(BaseModel):
    name: str
    column_count: int


class TableDetail(BaseModel):
    """One table. Used *nested* inside SchemaResponse, so it carries no `ok`."""

    name: str
    columns: list[ColumnOut]
    row_count: int | None = None


class TableDetailResponse(TableDetail):
    """Top-level body of GET /schema/tables/{table_name}.

    Same fields as TableDetail plus the `ok: true` marker that API_CONTRACT.md
    Â§2 promises for *every* successful response. It is a separate model so that
    the nested table objects in GET /schema stay free of a redundant per-table
    `ok` (one per table in the caller's catalog - 77 for a Full v5.1.6.4 student).
    """

    ok: Literal[True] = True


class TableListResponse(BaseModel):
    ok: Literal[True] = True
    table_count: int
    tables: list[TableSummary]

class MartSummary(BaseModel):
    name: str
    column_count: int
    row_count: int | None = None

class MartListResponse(BaseModel):
    ok: Literal[True] = True
    mart_count: int
    marts: list[MartSummary]


class SchemaResponse(BaseModel):
    ok: Literal[True] = True
    table_count: int
    tables: list[TableDetail]


class HealthResponse(BaseModel):
    ok: bool
    status: Literal["healthy", "degraded"]
    version: str
    table_count: int
    max_rows: int
    query_timeout_s: float


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


class SessionInfo(BaseModel):
    """Everything the UI is allowed to know about the current session.

    Deliberately absent: the session token (HttpOnly cookie only), the dataset
    file path, and any count of tables the caller cannot see.
    """

    ok: Literal[True] = True
    username: str
    role: Literal["STUDENT", "INSTRUCTOR"]
    must_change_password: bool
    expires_at: float
    idle_timeout_s: float
    absolute_timeout_s: float


class LogoutResponse(BaseModel):
    ok: Literal[True] = True
    message: str = "Signed out."


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=1, max_length=256)


class PasswordChangeResponse(BaseModel):
    ok: Literal[True] = True
    message: str
    # The change rotates the session, so the UI keeps working without a
    # re-login; every OTHER session for that user is revoked.
    sessions_revoked: int


class AuditEntryResponse(BaseModel):
    ok: Literal[True] = True
    count: int
    entries: list[dict[str, Any]]

class GamificationResponse(BaseModel):
    ok: Literal[True] = True
    summary: dict[str, Any]

class LeaderboardResponse(BaseModel):
    ok: Literal[True] = True
    period: str
    entries: list[dict[str, Any]]

class InstructorAnalyticsResponse(BaseModel):
    ok: Literal[True] = True
    summary: dict[str, Any]
    recent: list[dict[str, Any]]


class DatasetSummary(BaseModel):
    """Mot bo du lieu ma phien hien tai dung duoc."""

    name: str
    label: str
    #: 'VND_INT' | 'USD_DEC'. Frontend doc de dinh dang so tien. AIV Bank la
    #: VND so nguyen va KHONG BAO GIO duoc lam tron (API_CONTRACT.md muc 7);
    #: SupplyChain la USD co phan thap phan. Doan sai lam sai tien tren man hinh.
    currency: str
    table_count: int
    #: False khi database cua bo nay khong mo duoc luc khoi dong. Noi ra thay vi
    #: de frontend doan tu mot danh sach bang rong.
    available: bool


class DatasetListResponse(BaseModel):
    ok: Literal[True] = True
    default: str
    datasets: list[DatasetSummary]
