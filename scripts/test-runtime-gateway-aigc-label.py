"""Runtime Gateway /healthz passes LiveTalking's AIGC explicit label state through, fail closed.

Usage: python3 scripts/test-runtime-gateway-aigc-label.py (needs runtime/gateway/requirements.lock).
LiveTalking is an httpx MockTransport; only enabled true from GET /api/admin/aigc-label reads as enabled.
"""

import asyncio
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway  # noqa: E402

RealAsyncClient = httpx.AsyncClient


def answer(label_response):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cosyvoice":
            return httpx.Response(200, json={})
        if request.url.path == "/api/admin/aigc-label":
            if isinstance(label_response, Exception):
                raise label_response
            return label_response
        return httpx.Response(200, json={"code": 0, "data": {"sessions": []}})
    return handler


async def health_with(label_response) -> tuple[int, dict]:
    transport = httpx.MockTransport(answer(label_response))
    gateway.httpx.AsyncClient = lambda *args, **kwargs: RealAsyncClient(*args, transport=transport, **{key: value for key, value in kwargs.items() if key != "transport"})
    try:
        response = await gateway.healthz()
    finally:
        gateway.httpx.AsyncClient = RealAsyncClient
    return response.status_code, json.loads(response.body)


async def main() -> None:
    enabled = {"enabled": True, "text": "本直播由AI数字人生成", "position": "top-right", "font": "NotoSansCJK-Bold.ttc", "frames_labelled": 1500, "frames_dropped": 0, "last_error": None}
    status, body = await health_with(httpx.Response(200, json={"code": 0, "data": enabled}))
    label = body["dependencies"]["livetalking"]["aigc_label"]
    assert label == {"enabled": True, "reported": True, "text": "本直播由AI数字人生成", "position": "top-right", "frames_labelled": 1500, "last_error": None}, label
    assert body["dependencies"]["livetalking"]["available"] is True
    print("PASS  /healthz passes through an enabled AIGC label with its text, position and frame count")

    cases = [
        ("disabled", httpx.Response(200, json={"code": 0, "data": {**enabled, "enabled": False, "last_error": "font_missing"}}), True, "font_missing"),
        ("enabled as a string", httpx.Response(200, json={"code": 0, "data": {**enabled, "enabled": "true"}}), True, None),
        ("no label field (unpatched image)", httpx.Response(200, json={"code": 0, "data": {}}), True, None),
        ("route missing", httpx.Response(404, json={"code": -1}), False, "livetalking_unavailable"),
        ("business error", httpx.Response(200, json={"code": -1, "msg": "x"}), False, "livetalking_unavailable"),
        ("unreachable", httpx.ConnectError("refused"), False, "livetalking_unavailable"),
    ]
    for name, response, reported, error in cases:
        _, body = await health_with(response)
        label = body["dependencies"]["livetalking"]["aigc_label"]
        assert label["enabled"] is False and label["reported"] is reported and label["last_error"] == error, (name, label)
    print("PASS  /healthz reports the AIGC label disabled for a disabled, malformed, missing or unreachable LiveTalking label endpoint")
    _, body = await health_with(httpx.ConnectError("refused"))
    assert body["status"] == status_of(body), "the label passthrough does not change the Gateway health status"
    print("PASS  the AIGC label passthrough leaves the Gateway health status unchanged")


def status_of(body: dict) -> str:
    dependencies = body["dependencies"]
    ok = dependencies["livetalking"]["available"] and (not gateway.COSYVOICE_REQUIRED or dependencies["cosyvoice"]["available"]) and (not gateway.RUNTIME_COMMAND_JOURNAL_REQUIRED or dependencies["command_journal"]["available"])
    return "ok" if ok else "degraded"


if __name__ == "__main__":
    asyncio.run(main())
