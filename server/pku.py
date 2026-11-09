"""PKU IAAA + wproc shuttle client.

This is a small re-implementation of the login and reservation calls used by
Marchkov Helper:

  IAAA oauthlogin -> wproc cas-login -> session cookies -> reservation APIs

Credentials are only kept in memory (for transparent re-login when a wproc
cookie expires) and are never written to disk by this module.
"""

from __future__ import annotations

import datetime as dt
import json
import random
import threading
from typing import Any

import requests

IAAA_BASE = "https://iaaa.pku.edu.cn"
WPROC_BASE = "https://wproc.pku.edu.cn"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
# Beijing time; avoids depending on the machine's local timezone / tzdata.
TZ = dt.timezone(dt.timedelta(hours=8))


class PkuError(Exception):
    """An error returned by IAAA/wproc or the network."""


class PkuClient:
    """A single PKU account session.

    A Flask process can hold several of these (one per browser login).  All
    HTTP calls are serialised through ``self._lock`` because requests.Session
    is not thread-safe.
    """

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.username: str | None = None
        self._password: str | None = None
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ login
    def login(
        self, username: str, password: str, keep_password: bool = True
    ) -> None:
        with self._lock:
            self.session.cookies.clear()

            response = self.session.post(
                f"{IAAA_BASE}/iaaa/oauthlogin.do",
                data={
                    "appid": "wproc",
                    "userName": username,
                    "password": password,
                    "redirUrl": (
                        f"{WPROC_BASE}/site/login/cas-login"
                        f"?redirect_url={WPROC_BASE}/v2/reserve/"
                    ),
                },
                timeout=20,
                allow_redirects=False,
            )
            if response.status_code != 200:
                raise PkuError(f"IAAA 登录失败：HTTP {response.status_code}")
            try:
                payload = response.json()
            except ValueError as exc:
                raise PkuError("IAAA 登录失败：返回内容不是 JSON") from exc

            token = payload.get("token")
            if not token:
                message = payload.get("m") or payload.get("e") or "账号或密码错误"
                raise PkuError(f"IAAA 登录失败：{message}")

            redirect = self.session.get(
                f"{WPROC_BASE}/site/login/cas-login",
                params={
                    "redirect_url": f"{WPROC_BASE}/v2/reserve/",
                    "_rand": f"{random.random():.16f}",
                    "token": token,
                },
                timeout=20,
                allow_redirects=False,
            )
            if redirect.status_code not in (200, 302):
                raise PkuError(f"wproc 登录失败：HTTP {redirect.status_code}")

            # Verify while the password is still not stored.  This prevents a
            # failed verification from triggering an endless re-login loop.
            self.username = username
            self._password = None
            self.my_reservations()
            self._password = password if keep_password else None

    def logout(self) -> None:
        with self._lock:
            self.session.cookies.clear()
            self.username = None
            self._password = None

    def _relogin(self) -> bool:
        if not self.username or not self._password:
            return False
        self.login(self.username, self._password, keep_password=True)
        return True

    # ---------------------------------------------------------------- request
    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        retry: bool = True,
    ) -> dict[str, Any]:
        url = path if path.startswith("http") else f"{WPROC_BASE}{path}"
        with self._lock:
            response = self.session.request(
                method,
                url,
                params=params,
                data=data,
                timeout=20,
                allow_redirects=True,
                headers={"Referer": f"{WPROC_BASE}/v2/reserve/"},
            )

        content_type = response.headers.get("Content-Type", "")
        if response.status_code == 401 or "text/html" in content_type:
            if retry and self._relogin():
                return self._request(
                    method, path, params=params, data=data, retry=False
                )
            raise PkuError("会话已失效，请重新登录")
        if response.status_code != 200:
            raise PkuError(f"请求失败：HTTP {response.status_code}")

        try:
            payload = response.json()
        except ValueError as exc:
            if retry and self._relogin():
                return self._request(
                    method, path, params=params, data=data, retry=False
                )
            raise PkuError("接口返回的不是 JSON，可能登录已失效") from exc

        # List/QR endpoints report success with ``e: 0``; launch and cancel
        # report it with ``m: "操作成功"`` instead.  Accept either shape.
        message = payload.get("m")
        if payload.get("e") != 0 and message != "操作成功":
            raise PkuError(str(message or "接口返回错误"))
        return payload

    # ------------------------------------------------------------------- APIs
    def my_reservations(self) -> list[dict[str, Any]]:
        payload = self._request(
            "GET",
            "/site/reservation/my-list-time",
            params={
                "p": 1,
                "page_size": 0,
                "status": 2,
                "sort_time": "true",
                "sort": "asc",
            },
        )
        return list((payload.get("d") or {}).get("data") or [])

    def list_buses(self, date: str) -> list[dict[str, Any]]:
        payload = self._request(
            "GET",
            "/site/reservation/list-page",
            params={"hall_id": 1, "time": date, "p": 1, "page_size": 0},
        )
        return list((payload.get("d") or {}).get("list") or [])

    def get_qr(self, reservation_id: str) -> str:
        payload = self._request(
            "GET",
            "/site/reservation/get-sign-qrcode",
            params={"id": reservation_id},
        )
        code = (payload.get("d") or {}).get("code")
        if not code:
            raise PkuError("接口没有返回二维码")
        return str(code)

    def get_temp_qr(self, resource_id: str, text: str) -> str:
        payload = self._request(
            "GET",
            "/site/reservation/get-sign-qrcode",
            params={"type": 1, "resource_id": resource_id, "text": text},
        )
        code = (payload.get("d") or {}).get("code")
        if not code:
            raise PkuError("接口没有返回临时二维码")
        return str(code)

    def reserve(self, resource_id: str, date: str, period: str) -> dict[str, str]:
        try:
            period_value = int(period)
        except (TypeError, ValueError) as exc:
            raise PkuError("预约时段参数无效") from exc
        payload = self._request(
            "POST",
            "/site/reservation/launch",
            data={
                "resource_id": resource_id,
                "data": json.dumps(
                    [
                        {
                            "date": date,
                            "period": period_value,
                            "sub_resource_id": 0,
                        }
                    ]
                ),
            },
        )
        result = payload.get("d") or {}
        return {
            "id": str(result.get("id", "")),
            "hall_appointment_data_id": str(
                result.get("hall_appointment_data_id", "")
            ),
        }

    def cancel(self, appointment_id: str, data_id: str) -> None:
        self._request(
            "POST",
            "/site/reservation/single-time-cancel",
            data={"appointment_id": appointment_id, "data_id[0]": data_id},
        )

    def history(self, start: str, end: str) -> list[dict[str, Any]]:
        rides: list[dict[str, Any]] = []
        for status in (4, 5):
            payload = self._request(
                "GET",
                "/site/reservation/my-list-time",
                params={
                    "p": 1,
                    "page_size": 0,
                    "status": status,
                    "sort_time": "true",
                    "sort": "desc",
                    "date_sta": start,
                    "date_end": end,
                },
            )
            rides.extend((payload.get("d") or {}).get("data") or [])

        seen: set[Any] = set()
        unique: list[dict[str, Any]] = []
        for ride in rides:
            ride_id = ride.get("id")
            if ride_id in seen:
                continue
            seen.add(ride_id)
            unique.append(ride)
        unique.sort(
            key=lambda item: str(item.get("appointment_tim", "")), reverse=True
        )
        return unique
