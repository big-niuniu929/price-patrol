# -*- coding: utf-8 -*-
"""电商平台 SP-API 客户端（签名规则与官方 Python SDK 一致）与本地模拟数据源。"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

log = logging.getLogger(__name__)


class JdApiError(RuntimeError):
    def __init__(self, status: int | None, payload: Any, message: str = ""):
        self.status = status
        self.payload = payload
        self.code = ""
        self.request_id = ""
        if isinstance(payload, dict):
            errors = payload.get("errorList") or []
            if errors:
                self.code = str(errors[0].get("code", ""))
            self.request_id = str(payload.get("requestId") or "")
        super().__init__(f"JD API error status={status} code={self.code} {message} {payload}")


@dataclass
class SkuPrice:
    product_id: str
    sku_id: str
    name: str
    price: float
    market_price: float | None
    coupon: float
    final_price: float
    stock: int | None
    raw: dict
    price_star: int | None = None
    competitive_power: str = ""
    hand_price_missing: bool = False


def parameter_convert(system_param: dict[str, str], query_param: dict[str, Any],
                      body_param: str | None, path_param: dict[str, Any]) -> dict[str, str]:
    """与官方 SDK SignatureCalculator.parameter_convert 等价。"""
    param_map: dict[str, str] = {"X-JOS-App-Key": system_param["appKey"]}
    if "accessToken" in system_param:
        param_map["X-JOS-Access-Token"] = system_param["accessToken"]
    param_map["X-JOS-Timestamp"] = system_param["timestamp"]
    if "signMethod" in system_param:
        param_map["X-JOS-Sign-Method"] = system_param["signMethod"]
    for key, value in (query_param or {}).items():
        param_map[key] = str(value)
    for key, value in (path_param or {}).items():
        param_map[urllib.parse.quote_plus(str(key))] = urllib.parse.quote_plus(str(value))
    if body_param is not None and body_param != "" and body_param != "{}":
        param_map["body"] = body_param
    return dict(sorted(param_map.items()))


def calculate_signature(secret: str, param_map: dict[str, str]) -> str:
    raw = secret
    for key, value in param_map.items():
        raw += key + str(value)
    raw += secret
    return hashlib.md5(raw.encode("utf-8")).hexdigest().upper()


class JdSpClient:
    """电商平台零售开放平台 SP-API 客户端。"""

    def __init__(self, app_key: str, app_secret: str, access_token: str,
                 host: str = "https://api-cn.shop.example.com/rest", identity: str = "vender",
                 timeout: int = 20):
        self.app_key = app_key
        self.app_secret = app_secret
        self.access_token = access_token
        self.host = host.rstrip("/")
        self.identity = identity
        self.timeout = timeout

    # ---------- 底层请求 ----------
    def request(self, method: str, path: str, *, path_params: dict[str, Any] | None = None,
                query: dict[str, Any] | None = None, body: dict | None = None) -> dict:
        path_params = path_params or {}
        query = {k: v for k, v in (query or {}).items() if v is not None}
        ts = str(int(time.time() * 1000))
        body_text = json.dumps(body, ensure_ascii=False, separators=(",", ":")) if body else None

        system = {"appKey": self.app_key, "accessToken": self.access_token, "timestamp": ts}
        params = parameter_convert(system, query, body_text, path_params)
        sign = calculate_signature(self.app_secret, params)

        url_path = path
        for key, value in path_params.items():
            url_path = url_path.replace("{" + key + "}", urllib.parse.quote_plus(str(value)))
        url = self.host + url_path
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)

        headers = {
            "X-JOS-App-Key": self.app_key,
            "X-JOS-Access-Token": self.access_token,
            "X-JOS-Timestamp": ts,
            "X-JOS-Sign": sign,
            "X-JOS-Sdk-Version": "python-v1",
            "Accept": "application/json",
        }
        if self.identity:
            headers["X-JOS-Request-Identity"] = self.identity
        data = None
        if body_text is not None:
            data = body_text.encode("utf-8")
            headers["Content-Type"] = "application/json;charset=utf-8"

        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
                payload = json.loads(text) if text else {}
                return payload
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                payload = json.loads(text)
            except Exception:
                payload = {"raw": text}
            raise JdApiError(e.code, payload) from None
        except Exception as e:
            raise JdApiError(None, None, repr(e)) from None

    # ---------- 业务接口 ----------
    def get_product(self, product_id: str | int, scene: str = "vc",
                    belong_biz_id: str | None = None) -> dict:
        query: dict[str, Any] = {"scene": scene, "spuSkuApplyGray": "true"}
        if belong_biz_id:
            query["belongBizId"] = belong_biz_id
        return self.request(
            "GET",
            "/sp-product/v0/products/{productId}",
            path_params={"productId": product_id},
            query=query,
        )

    def list_skus(self, scene: str = "shop", page_no: int = 1, page_size: int = 100) -> dict:
        return self.request(
            "GET",
            "/sp-product/v0/skus",
            query={"scene": scene, "pageNo": page_no, "pageSize": page_size},
        )

    def list_price_stars(self, sku_ids: list[str], page: int = 1, page_size: int = 100) -> dict:
        """价格星级 / 到手价（handPrice）。当前应用未开权限时会返回 403。"""
        return self.request(
            "GET",
            "/sp-product/v0/price-stars",
            query={
                "skuIdList": ",".join(str(x) for x in sku_ids),
                "page": page,
                "pageSize": page_size,
            },
        )


def _to_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_product_prices(payload: dict) -> list[SkuPrice]:
    """从 getProduct 返回中提取 SKU 价格。兼容 dict / list 两种 skuList。"""
    data = payload.get("data") or {}
    sku_list = data.get("skuList") or data.get("skus") or []
    if isinstance(sku_list, dict):
        sku_list = [sku_list]
    result: list[SkuPrice] = []
    for item in sku_list:
        price_info = item.get("priceInfo") or {}
        price = _to_float(price_info.get("jdPrice"))
        if price is None:
            price = _to_float(price_info.get("marketPrice"))
        if price is None:
            continue
        coupon = _to_float(price_info.get("vouchersPrice")) or 0.0
        final_price = round(price - coupon, 2)
        result.append(SkuPrice(
            product_id=str(item.get("productId") or ""),
            sku_id=str(item.get("skuId") or ""),
            name=str(item.get("skuName") or ""),
            price=price,
            market_price=_to_float(price_info.get("marketPrice")),
            coupon=coupon,
            final_price=final_price,
            stock=int(item["stockNum"]) if str(item.get("stockNum", "")).isdigit() else None,
            raw=item,
        ))
    return result


def parse_hand_prices(payload: dict) -> dict[str, float]:
    """从 price-stars 返回中提取 skuId -> handPrice（到手价）。"""
    data = payload.get("data") or []
    if isinstance(data, dict):
        data = data.get("data") or data.get("list") or []
    result: dict[str, float] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        sku_id = str(item.get("skuId") or "")
        hand = _to_float(item.get("handPrice"))
        if sku_id and hand is not None:
            result[sku_id] = hand
    return result


def parse_price_stars(payload: dict) -> dict[str, dict]:
    """price-stars 明细：skuId -> {hand_price, price_star, competitive_power}。"""
    data = payload.get("data") or []
    if isinstance(data, dict):
        data = data.get("data") or data.get("list") or []
    result: dict[str, dict] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        sku_id = str(item.get("skuId") or "")
        if not sku_id:
            continue
        hand = _to_float(item.get("handPrice"))
        star = item.get("priceStar")
        result[sku_id] = {
            "hand_price": hand,
            "price_star": int(star) if str(star).isdigit() else None,
            "competitive_power": str(item.get("competitivePower") or ""),
        }
    return result


class MockSource:
    """本地模拟数据源：不依赖电商平台接口，用来跑通整条链路。"""

    name = "mock"

    def fetch(self, store: Any, sku: dict) -> SkuPrice:
        seed = int(hashlib.md5(f"{sku['product_id']}-{date.today()}".encode()).hexdigest(), 16)
        base = float(sku["base_price"] or sku["threshold"] + 100)
        delta = (seed % 160) - 60  # -60 ~ +99
        price = round(base + delta, 2)
        coupon = [0.0, 100.0, 150.0, 200.0][seed % 4]
        final_price = round(price - coupon, 2)
        return SkuPrice(
            product_id=sku["product_id"],
            sku_id=sku["id"],
            name=sku["name"],
            price=price,
            market_price=round(price * 1.1, 2),
            coupon=coupon,
            final_price=final_price,
            stock=seed % 500,
            raw={"mock": True, "seed": seed},
            price_star=(seed % 5) + 1,
            competitive_power=["bad", "avg", "good", "excellent"][seed % 4],
        )


class JdSource:
    name = "jd"

    def __init__(self, client: JdSpClient, scene: str = "vc"):
        self.client = client
        self.scene = scene
        self._product_cache: dict[str, list[SkuPrice]] = {}

    def _get_product_prices(self, store: Any, spu: str) -> list[SkuPrice]:
        key = f"{store.id}:{spu}"
        if key not in self._product_cache:
            payload = self.client.get_product(
                spu, scene=self.scene,
                belong_biz_id=store.supplier_code or None,
            )
            prices = parse_product_prices(payload)
            if not prices:
                raise JdApiError(None, payload, "getProduct 未返回价格字段")
            self._product_cache[key] = prices
        return self._product_cache[key]

    def _apply_hand_price(self, store: Any, sku: Any, price: SkuPrice) -> SkuPrice:
        target = str(sku["product_id"])
        try:
            payload = self.client.list_price_stars([target])
            detail = parse_price_stars(payload).get(target) or {}
            hand = detail.get("hand_price")
            if hand is None:
                price.hand_price_missing = True
                price.raw["hand_price_error"] = "price-stars 未返回 handPrice"
                return price
            price.final_price = float(hand)
            price.coupon = round(max(price.price - float(hand), 0.0), 2)
            price.price_star = detail.get("price_star")
            price.competitive_power = detail.get("competitive_power") or ""
            price.raw = {**price.raw, "handPrice": hand, "priceStar": price.price_star,
                         "competitivePower": price.competitive_power}
            return price
        except JdApiError as e:
            price.hand_price_missing = True
            price.raw["hand_price_error"] = f"{e.code} {str(e.payload)[:200]}"
            log.warning("到手价获取失败 %s: %s", target, e)
            return price

    def fetch(self, store: Any, sku: dict) -> SkuPrice:
        target = str(sku["product_id"])
        spu_id = sku["spu_id"] if "spu_id" in sku.keys() else None
        spu = str(spu_id or target)
        prices = self._get_product_prices(store, spu)
        # getProduct 会返回该商品下所有 SKU：先按 skuId 精确命中，再退回 productId
        base = None
        for price in prices:
            if price.sku_id == target:
                base = price
                break
        if base is None:
            for price in prices:
                if price.product_id == target:
                    base = price
                    break
        if base is None:
            base = prices[0]
        return self._apply_hand_price(store, sku, base)


def build_source(config, mock: bool):
    if mock:
        return MockSource()
    secrets = config.secrets
    missing = [k for k in ("appKey", "appSecret", "accessToken") if not secrets.get(k)]
    if missing:
        raise RuntimeError("secrets.local.txt 缺少: " + ", ".join(missing))
    client = JdSpClient(
        secrets["appKey"], secrets["appSecret"], secrets["accessToken"],
        host=config.jd.host, identity=config.jd.request_identity,
    )
    return JdSource(client, scene=config.jd.scene)
