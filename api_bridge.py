# -*- coding: utf-8 -*-
"""巡检第二轨道 · 官方价格 API 桥（多账号版）

稀缺资源：电商平台 SP-API 的 price-stars（普惠到手价）按「应用 + 授权店铺」隔离。
本桥支持多个应用账号：
  1. 默认账号：从「巡检智能体版\\service」的 secrets.local.txt 读取（原 品牌B 官方自营旗舰店）；
  2. 额外账号：读本目录下 accounts.local.json（例如 品牌B 大家电自营店）。

请求同一批 SKU 时会按顺序尝试所有账号，合并结果，并告诉插件每个 SKU 是哪个账号给的价。

运行：
  python api_bridge.py
  python api_bridge.py --port 18765
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SERVICE_DIR = Path(r"~/Desktop/巡检\巡检智能体版\service")
EXTRA_ACCOUNTS_FILE = HERE / "accounts.local.json"


def read_kv_secrets(path: Path) -> dict:
    data = {}
    if not path.exists():
        return data
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def build_clients(service_dir: Path):
    """返回 (clients, accounts, skipped, errors)。clients 里每项 = {name, client}。"""
    # 优先用包里自带的 vendor/patrol/jd_client.py，这样整个目录拷到别的电脑也能跑；
    # 没有 vendor 时再退回「巡检智能体版\service」。
    sys.path.insert(0, str(HERE / "vendor"))
    try:
        from patrol.jd_client import JdSpClient  # type: ignore
    except Exception:
        sys.path.insert(0, str(service_dir))
        from patrol.jd_client import JdSpClient  # type: ignore

    def make(entry: dict):
        return JdSpClient(
            entry.get("appKey", ""),
            entry.get("appSecret", ""),
            entry.get("accessToken", ""),
            identity=entry.get("identity") or "vender",
        )

    accounts = []
    skipped = []
    errors = []
    seen_keys = set()

    # 先读默认账号（secrets.local.txt），用于给 accounts.local.json 里缺凭据的账号兜底
    default_secret = None
    candidates = (
        HERE / "secrets.local.txt",
        service_dir / "secrets.local.txt",
        service_dir.parent / "secrets.local.txt",
    )
    for candidate in candidates:
        if candidate.exists():
            default_secret = read_kv_secrets(candidate)
            if default_secret.get("appKey") and default_secret.get("appSecret"):
                break

    # 1) 优先 accounts.local.json（工作台设置页保存的凭据是准的，避免 secrets 里的旧值覆盖它）
    if EXTRA_ACCOUNTS_FILE.exists():
        try:
            extra = json.loads(EXTRA_ACCOUNTS_FILE.read_text(encoding="utf-8-sig"))
        except Exception as exc:  # noqa: BLE001
            errors.append("accounts.local.json 解析失败：" + str(exc)[:200])
            extra = {}
        for item in extra.get("accounts", []) if isinstance(extra, dict) else []:
            entry = dict(item)
            name = entry.get("name") or str(entry.get("appKey", ""))[:8] or "未命名账号"
            if default_secret and str(entry.get("appKey") or "") == str(default_secret.get("appKey") or ""):
                if not entry.get("appSecret") and default_secret.get("appSecret"):
                    entry["appSecret"] = default_secret["appSecret"]
                if not entry.get("accessToken") and default_secret.get("accessToken"):
                    entry["accessToken"] = default_secret["accessToken"]
                if not entry.get("identity") and default_secret.get("identity"):
                    entry["identity"] = default_secret["identity"]
            if not (entry.get("appKey") and entry.get("appSecret") and entry.get("accessToken")):
                skipped.append(name + "（缺 appKey/appSecret/accessToken，已跳过）")
                continue
            app_key = str(entry.get("appKey"))
            if app_key in seen_keys:
                continue
            try:
                accounts.append({"name": name, "client": make(entry), "ready": True})
                seen_keys.add(app_key)
            except Exception as exc:  # noqa: BLE001
                errors.append(name + " 初始化失败：" + str(exc)[:200])

    # 2) 默认账号（secrets.local.txt）：只在 accounts.local.json 里没有同一个 appKey 时补充
    if default_secret and default_secret.get("appKey") and default_secret.get("appSecret"):
        app_key = str(default_secret.get("appKey"))
        if app_key not in seen_keys:
            entry = {
                "name": default_secret.get("name") or "品牌B官方自营旗舰店",
                "appKey": app_key,
                "appSecret": default_secret.get("appSecret", ""),
                "accessToken": default_secret.get("accessToken", ""),
                "identity": default_secret.get("identity") or "vender",
            }
            try:
                accounts.append({"name": entry["name"], "client": make(entry), "ready": True})
                seen_keys.add(app_key)
            except Exception as exc:  # noqa: BLE001
                errors.append("默认账号初始化失败：" + str(exc)[:200])
    elif not accounts:
        errors.append("默认账号凭据未找到（把 secrets.local.txt 放到本目录，或在设置里填 appKey/appSecret/accessToken）")

    return accounts, skipped, errors


def fetch_prices(accounts, skus):
    prices: dict[str, float] = {}
    sources: dict[str, str] = {}
    errors: list[str] = []
    for account in accounts:
        remaining = [sku for sku in skus if sku not in prices]
        if not remaining:
            break
        client = account["client"]
        client_errors = 0
        for i in range(0, len(remaining), 20):
            chunk = remaining[i:i + 20]
            try:
                payload = client.request(
                    "GET",
                    "/sp-product/v0/price-stars",
                    query={"skuIdList": ",".join(chunk), "page": "1", "pageSize": "50"},
                )
                data = payload.get("data")
                if isinstance(data, list):
                    for item in data:
                        hand = item.get("handPrice")
                        if hand is None:
                            continue
                        sku = str(item.get("skuId"))
                        try:
                            prices[sku] = float(hand)
                            sources[sku] = account["name"]
                        except (TypeError, ValueError):
                            pass
            except Exception as exc:  # noqa: BLE001
                client_errors += 1
                errors.append(account["name"] + "：" + str(exc)[:180])
        if client_errors:
            errors.append(account["name"] + " 有 " + str(client_errors) + " 组请求失败")
    missing = [sku for sku in skus if sku not in prices]
    return prices, sources, missing, errors


def load_accounts_file():
    if not EXTRA_ACCOUNTS_FILE.exists():
        return {"accounts": []}
    try:
        data = json.loads(EXTRA_ACCOUNTS_FILE.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("accounts.local.json 解析失败：" + str(exc)) from None
    if not isinstance(data, dict):
        data = {"accounts": []}
    if not isinstance(data.get("accounts"), list):
        data["accounts"] = []
    return data


def save_accounts_file(data):
    EXTRA_ACCOUNTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_default_account_saved():
    """把默认账号（secrets.local.txt）合并进 accounts.local.json，这样设置页能看到并编辑它。"""
    candidates = (
        HERE / "secrets.local.txt",
        DEFAULT_SERVICE_DIR / "secrets.local.txt",
        DEFAULT_SERVICE_DIR.parent / "secrets.local.txt",
    )
    default_secret = None
    for candidate in candidates:
        if candidate.exists():
            secret = read_kv_secrets(candidate)
            if secret.get("appKey") and secret.get("appSecret"):
                default_secret = secret
                break
    if not default_secret:
        return False
    app_key = default_secret.get("appKey", "")
    try:
        data = load_accounts_file()
    except RuntimeError:
        return False
    if any(str(item.get("appKey") or "") == app_key for item in data.get("accounts", [])):
        return False
    data.setdefault("accounts", []).append({
        "name": default_secret.get("name") or "品牌B官方自营旗舰店",
        "appKey": app_key,
        "appSecret": default_secret.get("appSecret", ""),
        "accessToken": default_secret.get("accessToken", ""),
        "refreshToken": default_secret.get("refreshToken", ""),
        "identity": default_secret.get("identity") or "vender",
    })
    save_accounts_file(data)
    return True


def update_credentials(original_name: str, name: str = "", app_key: str = "", app_secret: str = "",
                       access_token: str = "", refresh_token: str = "", identity: str = ""):
    """保存/新增一个账号到 accounts.local.json。

    - original_name：按名字/appKey 定位已有账号（空 = 新增）
    - name 非空且与原名不同 = 改名
    - 空字符串的凭据字段 = 保持原值
    """
    try:
        data = load_accounts_file()
    except RuntimeError as exc:
        raise RuntimeError(str(exc)) from None
    accounts = data.setdefault("accounts", [])
    hit = None
    if original_name:
        for item in accounts:
            if item.get("name") == original_name or item.get("appKey") == original_name:
                hit = item
                break
        if hit is None:
            raise KeyError("没有找到账号：" + original_name)
    if hit is None:
        # 新增账号必须字段齐全
        if not (app_key and app_secret and access_token):
            raise ValueError("新增账号需要填完整的 appKey / appSecret / accessToken")
        hit = {"name": name or app_key[:8], "appKey": "", "appSecret": "", "accessToken": "", "refreshToken": "", "identity": "vender"}
        accounts.append(hit)
    if name:
        hit["name"] = name
    if app_key:
        hit["appKey"] = app_key
    if app_secret:
        hit["appSecret"] = app_secret
    if access_token:
        hit["accessToken"] = access_token
    if refresh_token:
        hit["refreshToken"] = refresh_token
    if identity:
        hit["identity"] = identity
    save_accounts_file(data)
    return [a.get("name") for a in accounts]


def masked_accounts(accounts, loaded_names=None):
    """给工作台「设置」页展示用：不返回完整密钥，只返回掩码。"""
    loaded = set(loaded_names or [])
    out = []
    for item in accounts:
        name = item.get("name") or item.get("appKey", "")
        key = str(item.get("appKey") or "")
        token = str(item.get("accessToken") or "")
        out.append({
            "name": name,
            "appKeyMasked": (key[:6] + "…" + key[-4:]) if len(key) > 12 else key,
            "hasSecret": bool(item.get("appSecret")),
            "accessTokenTail": token[-6:] if token else "",
            "hasToken": bool(token),
            "identity": item.get("identity") or "vender",
            "loaded": name in loaded,
        })
    return out


class Handler(BaseHTTPRequestHandler):
    accounts = []
    skipped = []
    init_errors = []
    service_dir = None

    def _send(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, {})

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw or "{}")

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/api/accounts/credentials", "/api/accounts/secret"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            body = self._read_json_body()
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": "请求体不是 JSON：" + str(exc)[:200]})
            return

        name = str(body.get("name") or "").strip()
        original_name = str(body.get("originalName") or "").strip()
        app_key = str(body.get("appKey") or "").strip()
        app_secret = str(body.get("appSecret") or "").strip()
        access_token = str(body.get("accessToken") or "").strip()
        refresh_token = str(body.get("refreshToken") or "").strip()
        identity = str(body.get("identity") or "").strip()

        if len(app_key) and len(app_key) < 8:
            self._send(400, {"ok": False, "error": "appKey 看起来不完整"})
            return
        if len(app_secret) and len(app_secret) < 16:
            self._send(400, {"ok": False, "error": "appSecret 看起来不完整（一般为 32 位）"})
            return
        if len(access_token) and len(access_token) < 12:
            self._send(400, {"ok": False, "error": "accessToken 看起来不完整"})
            return
        if not any((app_key, app_secret, access_token, refresh_token)) and not original_name:
            self._send(400, {"ok": False, "error": "没有要保存的内容"})
            return
        try:
            names = update_credentials(original_name, name, app_key, app_secret, access_token, refresh_token, identity)
        except KeyError as exc:
            self._send(404, {"ok": False, "error": str(exc)})
            return
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"ok": False, "error": "写配置失败：" + str(exc)[:300]})
            return
        type(self).accounts, type(self).skipped, type(self).init_errors = build_clients(self.service_dir)
        self._send(200, {
            "ok": True,
            "updated": name or original_name,
            "config_accounts": names,
            "accounts": [a["name"] for a in self.accounts],
            "skipped": self.skipped,
            "errors": self.init_errors,
        })

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self._send(200, {
                "ok": True,
                "service": "patrol-second-track-api-bridge",
                "accounts": [a["name"] for a in self.accounts],
                "skipped": self.skipped,
                "init_errors": self.init_errors,
            })
            return
        if parsed.path == "/api/accounts":
            # 设置页展示用：不返回完整密钥，只返回掩码
            try:
                data = load_accounts_file()
            except Exception as exc:  # noqa: BLE001
                self._send(500, {"ok": False, "error": "读取 accounts.local.json 失败：" + str(exc)[:200]})
                return
            self._send(200, {
                "ok": True,
                "accounts": [a["name"] for a in self.accounts],
                "config": masked_accounts(data.get("accounts", []), [a["name"] for a in self.accounts]),
                "skipped": self.skipped,
                "init_errors": self.init_errors,
            })
            return
        if parsed.path == "/api/accounts/test":
            # 保存后自检：用指定 SKU 试取一次，确认 token 真的可用
            qs = urllib.parse.parse_qs(parsed.query)
            sku = (qs.get("sku", [""])[0] or "").strip()
            want = (qs.get("name", [""])[0] or "").strip()
            if not sku:
                self._send(400, {"ok": False, "error": "sku 参数为空"})
                return
            targets = self.accounts
            if want:
                targets = [a for a in self.accounts if a["name"] == want]
                if not targets:
                    self._send(404, {"ok": False, "error": "没有已启用的账号：" + want + "（可能 appKey/appSecret/accessToken 不全）"})
                    return
            try:
                prices, sources, missing, errors = fetch_prices(targets, [sku])
            except Exception as exc:  # noqa: BLE001
                self._send(500, {"ok": False, "error": str(exc)[:300]})
                return
            self._send(200, {
                "ok": sku in prices,
                "sku": sku,
                "price": prices.get(sku),
                "source": sources.get(sku),
                "missing": missing,
                "accounts": [a["name"] for a in self.accounts],
                "errors": self.init_errors + errors,
            })
            return
        if parsed.path == "/api/prices":
            qs = urllib.parse.parse_qs(parsed.query)
            raw = (qs.get("skus", [""])[0] or "").strip()
            skus = [s.strip() for s in raw.split(",") if s.strip()]
            if not skus:
                self._send(400, {"ok": False, "error": "skus 参数为空"})
                return
            try:
                prices, sources, missing, errors = fetch_prices(self.accounts, skus)
            except Exception as exc:  # noqa: BLE001
                self._send(500, {"ok": False, "error": str(exc)[:500]})
                return
            self._send(200, {
                "ok": True,
                "prices": prices,
                "sources": sources,
                "missing": missing,
                "accounts": [a["name"] for a in self.accounts],
                "skipped": self.skipped,
                "errors": self.init_errors + errors,
            })
            return
        self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, *args):  # noqa: D401
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--service-dir", default=str(DEFAULT_SERVICE_DIR))
    args = parser.parse_args()
    service_dir = Path(args.service_dir)

    # 单实例保护：端口已有健康响应时不再重复启动（Windows 的 SO_REUSEADDR 允许多进程抢同一端口）
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/healthz", timeout=2) as resp:
            if resp.status == 200:
                print(f"[api_bridge] 端口 {args.port} 已有 API 桥在运行，本次不重复启动。")
                return
    except Exception:
        pass

    print(f"[api_bridge] 默认凭据目录：{service_dir}")
    print(f"[api_bridge] 额外账号文件：{EXTRA_ACCOUNTS_FILE}")
    try:
        if ensure_default_account_saved():
            print("[api_bridge] 已把默认账号（secrets.local.txt）并入 accounts.local.json，可在插件设置页直接编辑")
    except Exception as exc:  # noqa: BLE001
        print(f"[api_bridge] 默认账号并入失败：{exc}")
    Handler.service_dir = service_dir
    Handler.accounts, Handler.skipped, Handler.init_errors = build_clients(service_dir)
    for account in Handler.accounts:
        print(f"[api_bridge] 已启用账号：{account['name']}")
    for skipped in Handler.skipped:
        print(f"[api_bridge] 跳过账号：{skipped}")
    for err in Handler.init_errors:
        print(f"[api_bridge] 初始化提示：{err}")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[api_bridge] listening on http://127.0.0.1:{args.port}")
    print("[api_bridge] /healthz  /api/prices?skus=SKU1,SKU2")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
