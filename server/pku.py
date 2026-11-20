"""PKU IAAA + wproc shuttle client.

This is a small re-implementation of the login and reservation calls used by
Marchkov Helper:

  IAAA getPublicKey -> RSA(PKCS#1 v1.5) password -> oauthlogin
  -> wproc cas-login -> session cookies -> reservation APIs

Credentials are only kept in memory (for transparent re-login when a wproc
cookie expires) and are never written to disk by this module.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import random
import secrets
import threading
from typing import Any

import requests

IAAA_BASE = "https://iaaa.pku.edu.cn"
IAAA_OAUTH_URL = f"{IAAA_BASE}/iaaa/oauth.jsp"
IAAA_PUBLIC_KEY_URL = f"{IAAA_BASE}/iaaa/getPublicKey.do"
IAAA_LOGIN_URL = f"{IAAA_BASE}/iaaa/oauthlogin.do"
WPROC_BASE = "https://wproc.pku.edu.cn"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
# Beijing time; avoids depending on the machine's local timezone / tzdata.
TZ = dt.timezone(dt.timedelta(hours=8))


class PkuError(Exception):
    """An error returned by IAAA/wproc or the network."""


# --------------------------------------------------------------------- IAAA RSA
# IAAA no longer accepts a plaintext password: its login page fetches an RSA
# public key, encrypts the password with PKCS#1 v1.5 and posts the base64
# ciphertext.  Plaintext still gets HTTP 200, but with
# {"success": false, "errors": {"code": "E01", ...}} - so it looks like a
# wrong password even when the password is correct.  Keep this tiny DER/RSA
# implementation here so the service needs no extra crypto dependency.
def _der_tlv(data: bytes, pos: int) -> tuple[int, bytes, int]:
    """Read one DER TLV record, returning (tag, value, next_position)."""
    if pos + 2 > len(data):
        raise ValueError("数据被截断")
    tag = data[pos]
    length = data[pos + 1]
    pos += 2
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or pos + count > len(data):
            raise ValueError("长度字段无效")
        length = int.from_bytes(data[pos : pos + count], "big")
        pos += count
    if pos + length > len(data):
        raise ValueError("数据被截断")
    return tag, data[pos : pos + length], pos + length


def rsa_public_numbers(pem: str) -> tuple[int, int]:
    """Return (modulus, exponent) from a PEM PUBLIC KEY (SPKI) block."""
    body = "".join(
        line.strip()
        for line in pem.strip().splitlines()
        if line.strip() and not line.strip().startswith("-----")
    )
    der = base64.b64decode(body)
    tag, spki, _ = _der_tlv(der, 0)
    if tag != 0x30:
        raise ValueError("公钥不是 SEQUENCE")
    _, _, pos = _der_tlv(spki, 0)  # AlgorithmIdentifier
    tag, bit_string, _ = _der_tlv(spki, pos)
    if tag != 0x03 or not bit_string or bit_string[0] != 0:
        raise ValueError("公钥缺少 BIT STRING")
    tag, rsa_key, _ = _der_tlv(bit_string, 1)
    if tag != 0x30:
        raise ValueError("公钥不是 RSAPublicKey")
    tag, modulus, pos = _der_tlv(rsa_key, 0)
    tag_e, exponent, _ = _der_tlv(rsa_key, pos)
    if tag != 0x02 or tag_e != 0x02:
        raise ValueError("公钥缺少模数或指数")
    return int.from_bytes(modulus, "big"), int.from_bytes(exponent, "big")


def rsa_encrypt_password(pem: str, password: str) -> str:
    """Encrypt password the way IAAA's login page (JSEncrypt) does."""
    try:
        modulus, exponent = rsa_public_numbers(pem)
    except (ValueError, TypeError) as exc:
        raise PkuError(f"IAAA 公钥解析失败：{exc}") from exc

    message = password.encode("utf-8")
    size = (modulus.bit_length() + 7) // 8
    if len(message) > size - 11:
        raise PkuError("密码过长，无法用 IAAA 公钥加密")

    # PKCS#1 v1.5: 0x00 || 0x02 || non-zero padding || 0x00 || message
    padding = bytearray()
    while len(padding) < size - 3 - len(message):
        padding.append(secrets.randbelow(255) + 1)
    block = b"\x00\x02" + bytes(padding) + b"\x00" + message
    cipher = pow(int.from_bytes(block, "big"), exponent, modulus)
    return base64.b64encode(cipher.to_bytes(size, "big")).decode("ascii")


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
    def _fetch_public_key(self) -> str:
        """Fetch the RSA key IAAA now requires passwords to be encrypted with."""
        try:
            response = self.session.get(
                IAAA_PUBLIC_KEY_URL,
                headers={
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": IAAA_OAUTH_URL,
                },
                timeout=20,
            )
        except requests.RequestException as exc:
            raise PkuError("连不上 IAAA 获取登录公钥，请检查网络") from exc
        if response.status_code != 200:
            raise PkuError(
                f"获取 IAAA 登录公钥失败：HTTP {response.status_code}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise PkuError("获取 IAAA 登录公钥失败：返回内容不是 JSON") from exc
        key = payload.get("key")
        if not payload.get("success") or not key:
            raise PkuError("获取 IAAA 登录公钥失败：IAAA 没有返回公钥")
        return str(key)

    def login(
        self, username: str, password: str, keep_password: bool = True
    ) -> None:
        with self._lock:
            self.session.cookies.clear()
            # IAAA rejects the plaintext password since the 2025 rewrite; it
            # must be RSA-encrypted with the key from getPublicKey.do.
            encrypted = rsa_encrypt_password(self._fetch_public_key(), password)

            try:
                response = self.session.post(
                    IAAA_LOGIN_URL,
                    data={
                        "appid": "wproc",
                        "userName": username,
                        "password": encrypted,
                        "randCode": "",
                        "smsCode": "",
                        "otpCode": "",
                        "redirUrl": (
                            f"{WPROC_BASE}/site/login/cas-login"
                            f"?redirect_url={WPROC_BASE}/v2/reserve/"
                        ),
                    },
                    headers={
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": IAAA_OAUTH_URL,
                    },
                    timeout=20,
                    allow_redirects=False,
                )
            except requests.RequestException as exc:
                raise PkuError("连不上 IAAA，请检查网络") from exc
            if response.status_code != 200:
                raise PkuError(f"IAAA 登录失败：HTTP {response.status_code}")
            try:
                payload = response.json()
            except ValueError as exc:
                raise PkuError("IAAA 登录失败：返回内容不是 JSON") from exc

            # IAAA answers {"success": false, "errors": {"code", "msg"}} on
            # failure; the old "m"/"e" fields are gone, which is why every
            # failure used to be reported as "账号或密码错误".
            if payload.get("success") is not True:
                errors = payload.get("errors") or {}
                code = str(errors.get("code") or "")
                message = str(
                    errors.get("msg")
                    or payload.get("m")
                    or payload.get("e")
                    or "账号或密码错误"
                )
                if code == "E01":
                    raise PkuError(
                        "IAAA 登录失败：账号或密码错误；若确认密码正确，请先在"
                        "浏览器登录 iaaa.pku.edu.cn 完成短信/微信二次验证后重试"
                    )
                suffix = f"（{code}）" if code else ""
                raise PkuError(f"IAAA 登录失败：{message}{suffix}")

            token = payload.get("token")
            if not token:
                raise PkuError("IAAA 登录失败：响应里没有 token")

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
        """Return the currently reserved rides.

        wproc's "我的预约" page no longer shows its list when the request
        leaves ``date_sta``/``date_end`` unset; Marchkov's bus-list page
        always sends an explicit window.  Do the same here instead of
        depending on the server-side default.
        """
        today = dt.datetime.now(TZ).date()
        params = {
            "p": 1,
            "page_size": 0,
            "status": 2,
            "sort_time": "true",
            "sort": "asc",
            "date_sta": today.isoformat(),
            "date_end": (today + dt.timedelta(days=6)).isoformat(),
        }
        try:
            payload = self._request(
                "GET", "/site/reservation/my-list-time", params=params
            )
            rows = list((payload.get("d") or {}).get("data") or [])
        except PkuError:
            rows = []

        if rows:
            return rows

        # Same fallback as the mobile "我的预约" page: ask for every status
        # inside the window and keep only active reservations (status 7).
        params.update({"status": 0, "sort": "desc"})
        try:
            payload = self._request(
                "GET", "/site/reservation/my-list-time", params=params
            )
        except PkuError:
            return []
        rows = list((payload.get("d") or {}).get("data") or [])
        return [row for row in rows if str(row.get("status")) == "7"]

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
