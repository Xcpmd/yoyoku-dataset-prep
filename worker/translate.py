#!/usr/bin/env python3
"""Translate prompt tags with Baidu Translate, falling back to MyMemory.

Reads one JSON object from stdin:
  {"texts": ["long hair"], "to": "zh", "appid": "...", "key": "..."}
Writes one JSON object to stdout:
  {"translations": ["长发"], "provider": "baidu" | "mymemory"}
Only the Python standard library is required.
"""
from __future__ import annotations

import hashlib
import html
import json
import sys
import time
import urllib.parse
import urllib.request

# Windows 默认控制台编码可能是 cp936；Rust 端按 UTF-8 读取 stdout，
# 因此 stdin/stdout/stderr 都强制使用 UTF-8，避免中文翻译结果乱码。
for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

USER_AGENT = "Yoyoku-Dataset-Prep/1.0 (+local prompt translator)"


def request_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=18) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def translate_baidu(texts: list[str], to: str, appid: str, key: str) -> list[str]:
    query = "\n".join(texts)
    if len(query.encode("utf-8")) > 5500:
        raise ValueError("文本过长，无法使用百度批量翻译")
    salt = str(int(time.time() * 1000))
    sign = hashlib.md5(f"{appid}{query}{salt}{key}".encode("utf-8")).hexdigest()
    params = urllib.parse.urlencode(
        {
            "q": query,
            "from": "auto",
            "to": "zh" if to == "zh" else "en",
            "appid": appid,
            "salt": salt,
            "sign": sign,
        }
    )
    data = request_json(f"https://fanyi-api.baidu.com/api/trans/vip/translate?{params}")
    if data.get("error_code"):
        raise ValueError(data.get("error_msg") or f"百度翻译错误 {data.get('error_code')}")
    results = data.get("trans_result") or []
    translations = [str(item.get("dst") or "") for item in results]
    if len(translations) != len(texts):
        raise ValueError("百度翻译返回数量与输入不一致")
    return translations


def translate_mymemory(texts: list[str], to: str) -> list[str]:
    pair = "en|zh-CN" if to == "zh" else "zh-CN|en"
    results: list[str] = []
    for text in texts:
        params = urllib.parse.urlencode({"q": text, "langpair": pair})
        data = request_json(f"https://api.mymemory.translated.net/get?{params}")
        translated = (data.get("responseData") or {}).get("translatedText") or ""
        results.append(html.unescape(str(translated)).strip())
        time.sleep(0.15)
    return results


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        texts = [str(item).strip() for item in payload.get("texts") or [] if str(item).strip()]
        to = "en" if payload.get("to") == "en" else "zh"
        if not texts:
            raise ValueError("没有需要翻译的文本")
        appid = str(payload.get("appid") or "").strip()
        key = str(payload.get("key") or "").strip()
        if appid and key:
            try:
                translations = translate_baidu(texts, to, appid, key)
                provider = "baidu"
            except Exception:
                translations = translate_mymemory(texts, to)
                provider = "mymemory"
        else:
            translations = translate_mymemory(texts, to)
            provider = "mymemory"
        print(json.dumps({"translations": translations, "provider": provider}, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
