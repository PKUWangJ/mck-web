"""Local HTTP service for the Marchkov web helper.

Run this on the always-on machine.  It listens on 127.0.0.1 by default and is
published to the phone through Tailscale Serve:

    tailscale serve --bg 8787

The service holds PKU credentials only in RAM.  The browser never talks to
iaaa/wproc directly; it talks to this service with a bearer token.
"""

from __future__ import annotations

import base64
import datetime as dt
import io
import os
import re
import secrets
import threading
import time
from typing import Any

import qrcode
import qrcode.image.svg
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from waitress import serve

from pku import PkuClient, PkuError, TZ

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

SITE_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "docs"))

app = Flask(__name__, static_folder=SITE_DIR, static_url_path="")

_allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
if not _allowed_origins:
    _allowed_origins = [
        "http://127.0.0.1:8787",
        "http://localhost:8787",
    ]

CORS(
    app,
    resources={r"/api/*": {"origins": _allowed_origins}},
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "OPTIONS"],
    max_age=600,
)

SESSIONS: dict[str, dict[str, Any]] = {}
SESSIONS_LOCK = threading.Lock()
SESSION_TTL = int(os.getenv("SESSION_TTL_SECONDS", str(7 * 24 * 3600)))


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------- helpers
def now() -> dt.datetime:
    return dt.datetime.now(TZ)


def today() -> str:
    return now().strftime("%Y-%m-%d")


def cleanup_sessions() -> None:
    cutoff = time.time() - SESSION_TTL
    with SESSIONS_LOCK:
        expired = [
            token for token, session in SESSIONS.items()
            if session["created"] < cutoff
        ]
        for token in expired:
            SESSIONS.pop(token, None)


def current_session() -> dict[str, Any]:
    cleanup_sessions()
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise ApiError("未登录", 401)
    token = auth[7:].strip()
    with SESSIONS_LOCK:
        session = SESSIONS.get(token)
        if session is not None:
            # Sliding expiry: the TTL counts inactivity, so a phone that is
            # used daily does not suddenly demand a new login.
            session["created"] = time.time()
    if session is None:
        raise ApiError("登录已失效，请重新登录", 401)
    return session


def qr_data_uri(code: str) -> str:
    """Render the QR code as an SVG data URI.

    Rendering server-side keeps the frontend dependency-free and lets the
    browser cache the last QR image for offline use.
    """
    image = qrcode.make(
        code,
        image_factory=qrcode.image.svg.SvgPathImage,
        box_size=10,
        border=2,
    )
    buffer = io.BytesIO()
    image.save(buffer)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def normalize_time(value: Any) -> str:
    text = str(value or "").strip().replace("T", " ")
    return text[:16] if len(text) >= 16 else text


DATE_RE = re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})")
TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")


def normalize_date(value: Any) -> str:
    """Return a zero-padded YYYY-MM-DD, ignoring any time part."""
    match = DATE_RE.search(str(value or ""))
    if not match:
        return ""
    return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"


def normalize_clock(value: Any) -> str:
    """Return a zero-padded HH:MM, ignoring any date / seconds around it."""
    match = TIME_RE.search(str(value or ""))
    if not match:
        return ""
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def normalize_datetime(value: Any) -> str:
    text = str(value or "").strip().replace("T", " ")
    date_part = normalize_date(text)
    time_part = normalize_clock(text)
    if date_part and time_part:
        return f"{date_part} {time_part}"
    return normalize_time(value)


def first_period_id(raw: dict[str, Any]) -> str:
    """Return the per-period id needed by the cancel endpoint.

    ``my-list-time`` rows are not consistent here: some carry a top-level
    ``hall_appointment_data_id`` (what Marchkov's ride page reads), others
    only expose the periods as ``periodList`` / ``period_list`` with ``id``
    or ``data_id`` entries (what Marchkov's bus list and the wproc pages
    read).  Without this fallback the cancel button is hidden even though
    the reservation is active.
    """
    periods = raw.get("periodList")
    if not isinstance(periods, list) or not periods:
        periods = raw.get("period_list")
    if not isinstance(periods, list):
        return ""
    for period in periods:
        if not isinstance(period, dict):
            continue
        value = period.get("id") or period.get("data_id")
        if value:
            return str(value)
    return ""


def reservation_payload(raw: dict[str, Any]) -> dict[str, Any]:
    data_id = raw.get("hall_appointment_data_id") or first_period_id(raw)
    return {
        "id": str(raw.get("id", "")),
        "data_id": str(data_id or ""),
        "route": raw.get("resource_name", ""),
        "time": normalize_datetime(raw.get("appointment_tim", "")),
        "status": raw.get("status_name", ""),
        "sign_time": normalize_datetime(raw.get("appointment_sign_time", "")),
    }


def history_payload(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(raw.get("id", "")),
        "route": raw.get("resource_name", ""),
        "time": normalize_datetime(raw.get("appointment_tim", "")),
        "status": raw.get("status_name", ""),
        "sign_time": normalize_datetime(raw.get("appointment_sign_time", "")),
    }


# ----------------------------------------------------------------------- routes
@app.get("/api/health")
def api_health():
    return jsonify(
        {
            "ok": True,
            "service": "mck-helper",
            "time": now().isoformat(timespec="seconds"),
        }
    )


@app.post("/api/login")
def api_login():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not username or not password:
        raise ApiError("请输入账号和密码")

    client = PkuClient()
    try:
        client.login(username, password, keep_password=True)
    except PkuError as exc:
        raise ApiError(str(exc), 401) from exc

    token = secrets.token_urlsafe(32)
    with SESSIONS_LOCK:
        SESSIONS[token] = {
            "client": client,
            "created": time.time(),
            "username": username,
        }
    return jsonify({"token": token, "username": username})


@app.post("/api/logout")
def api_logout():
    auth = request.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.startswith("Bearer ") else ""
    with SESSIONS_LOCK:
        session = SESSIONS.pop(token, None)
    if session is not None:
        try:
            session["client"].logout()
        except Exception:
            pass
    return jsonify({"ok": True})


@app.get("/api/qr")
def api_qr():
    session = current_session()
    client: PkuClient = session["client"]
    day = normalize_date(request.args.get("date")) or today()
    scope = str(request.args.get("scope") or "today").strip().lower()
    include_all = scope == "all"

    try:
        raw_items = client.my_reservations()
    except PkuError as exc:
        raise ApiError(str(exc), 502) from exc

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_items:
        info = reservation_payload(raw)
        info_day = normalize_date(info["time"])
        if not info["id"] or not info_day:
            continue
        # The QR tab asks for "all": every reservation from today onwards, so
        # several boarding codes can live on one page.  Past days are dropped
        # because their codes can no longer be used.  The default stays on
        # today's codes for older clients and direct API calls.
        if include_all:
            if info_day < today():
                continue
        elif info_day != day:
            continue
        if info["id"] in seen:
            continue
        seen.add(info["id"])
        try:
            code = client.get_qr(info["id"])
            items.append(
                {
                    **info,
                    "code_type": "乘车码",
                    "qr": qr_data_uri(code),
                }
            )
        except PkuError as exc:
            items.append(
                {
                    **info,
                    "code_type": "乘车码",
                    "qr": None,
                    "error": str(exc),
                }
            )

    items.sort(key=lambda item: item["time"])
    return jsonify(
        {
            "updated": now().isoformat(timespec="seconds"),
            "date": day,
            "scope": "all" if include_all else "today",
            "items": items,
        }
    )


@app.get("/api/reservations")
def api_reservations():
    session = current_session()
    client: PkuClient = session["client"]
    try:
        raw_items = client.my_reservations()
    except PkuError as exc:
        raise ApiError(str(exc), 502) from exc
    return jsonify({"items": [reservation_payload(raw) for raw in raw_items]})


@app.get("/api/buses")
def api_buses():
    session = current_session()
    client: PkuClient = session["client"]
    day = normalize_date(request.args.get("date")) or today()

    try:
        raw_buses = client.list_buses(day)
    except PkuError as exc:
        raise ApiError(str(exc), 502) from exc

    slots: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for bus in raw_buses:
        bus_id = str(bus.get("id", ""))
        route = str(bus.get("name", ""))
        table = bus.get("table") or {}
        for rows in table.values():
            for slot in rows or []:
                row = slot.get("row") or {}
                try:
                    margin = int(row.get("margin", 0))
                except (TypeError, ValueError):
                    margin = 0
                if margin <= 0:
                    continue
                # abscissa is a date; yaxis is a time and may include
                # seconds ("22:00:00").  Normalise both so the frontend can
                # match a bus against a reservation by "date + HH:MM".
                date_str = normalize_date(slot.get("abscissa"))
                time_str = normalize_clock(slot.get("yaxis"))
                if not date_str or not time_str:
                    continue
                # list-page returns a multi-day timetable.  The page requests
                # one date at a time, so drop the other days; otherwise past
                # slots from today appear under tomorrow and look "departed".
                if date_str != day:
                    continue
                time_id = str(slot.get("time_id", ""))
                key = (date_str, time_str, bus_id, time_id)
                if key in seen:
                    continue
                seen.add(key)
                slots.append(
                    {
                        "route": route,
                        "bus_id": bus_id,
                        "time_id": time_id,
                        "date": date_str,
                        "time": time_str,
                        "appointment_time": f"{date_str} {time_str}".strip(),
                        "status": row.get("status"),
                        "margin": margin,
                    }
                )

    slots.sort(key=lambda item: (item["route"], item["appointment_time"]))
    return jsonify({"date": day, "items": slots})


@app.post("/api/reserve")
def api_reserve():
    session = current_session()
    client: PkuClient = session["client"]
    body = request.get_json(silent=True) or {}
    resource_id = str(body.get("resource_id") or "")
    date = str(body.get("date") or today())
    period = str(body.get("period") or "")
    if not resource_id or not period:
        raise ApiError("缺少预约参数")

    try:
        result = client.reserve(resource_id, date, period)
    except PkuError as exc:
        raise ApiError(str(exc), 502) from exc
    return jsonify(result)


@app.post("/api/cancel")
def api_cancel():
    session = current_session()
    client: PkuClient = session["client"]
    body = request.get_json(silent=True) or {}
    appointment_id = str(body.get("appointment_id") or "")
    data_id = str(body.get("data_id") or "")
    if not appointment_id or not data_id:
        raise ApiError("缺少取消参数")

    try:
        client.cancel(appointment_id, data_id)
    except PkuError as exc:
        raise ApiError(str(exc), 502) from exc
    return jsonify({"ok": True})


@app.get("/api/history")
def api_history():
    session = current_session()
    client: PkuClient = session["client"]
    end = request.args.get("end") or today()
    start = request.args.get("start")
    if not start:
        start = (
            dt.date.fromisoformat(end) - dt.timedelta(days=30)
        ).isoformat()

    try:
        raw_items = client.history(start, end)
    except PkuError as exc:
        raise ApiError(str(exc), 502) from exc
    return jsonify(
        {
            "start": start,
            "end": end,
            "items": [history_payload(raw) for raw in raw_items],
        }
    )


# --------------------------------------------------------------- error handling
@app.errorhandler(ApiError)
def handle_api_error(exc: ApiError):
    return jsonify({"error": str(exc)}), exc.status


@app.errorhandler(PkuError)
def handle_pku_error(exc: PkuError):
    return jsonify({"error": str(exc)}), 502


# ------------------------------------------------------------- static frontend
@app.route("/api/<path:path>", methods=["GET", "POST"])
def api_not_found(path: str):
    """Keep unknown API paths JSON instead of falling through to index.html."""
    raise ApiError("Not found", 404)


@app.get("/")
def index():
    return send_from_directory(SITE_DIR, "index.html")


@app.get("/<path:path>")
def static_or_index(path: str):
    target = os.path.normpath(os.path.join(SITE_DIR, path))
    if not target.startswith(SITE_DIR + os.sep):
        raise ApiError("Not found", 404)
    if os.path.isfile(target):
        return send_from_directory(SITE_DIR, path)
    return send_from_directory(SITE_DIR, "index.html")


def main() -> None:
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8787"))
    print(f"mck-helper listening on http://{host}:{port}", flush=True)
    serve(app, host=host, port=port, threads=8)


if __name__ == "__main__":
    main()
