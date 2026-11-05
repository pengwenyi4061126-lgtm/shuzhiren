import asyncio
import pathlib
import sys
import time

import httpx
from fastapi import HTTPException


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "runtime" / "gateway"))
import app as gateway


class FailingClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, *_args, **_kwargs):
        raise httpx.ConnectError("failed to reach http://livetalking.internal/private-stream-key")

    async def get(self, *_args, **_kwargs):
        raise httpx.ConnectError("failed to reach http://livetalking.internal/private-stream-key")

    def stream(self, *_args, **_kwargs):
        raise httpx.ConnectError("failed to reach http://cosyvoice.internal/private-stream-key")


class RejectedResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return {"code": 1, "msg": "private-stream-key must not escape"}


class RejectingClient(FailingClient):
    async def post(self, *_args, **_kwargs):
        return RejectedResponse()

    async def get(self, *_args, **_kwargs):
        return RejectedResponse()


RealAsyncClient = httpx.AsyncClient


def upstream_answering(status: int, body: bytes):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers={"content-type": "application/json"})

    return lambda **kwargs: RealAsyncClient(transport=httpx.MockTransport(handler), **kwargs)


async def expect_detail(operation, expected: str) -> None:
    try:
        await operation
    except HTTPException as error:
        assert error.status_code == 502, error.status_code
        assert error.detail == expected, error.detail
        assert "private-stream-key" not in error.detail
    else:
        raise AssertionError("Gateway downstream failure must return HTTPException")


async def expect_cosyvoice_failure(expected: str, reason: str) -> None:
    try:
        await gateway.cosyvoice_synthesize("hello", gateway.VoiceSpec("voice"), time.monotonic() + 5)
    except gateway.CommandFailure as error:
        body = error.body()
        assert error.status_code == 502, error.status_code
        assert body["detail"] == expected and "private" not in body["detail"], body
        assert body["code"] == "command_failed_definite" and body["failure_source"] == "cosyvoice" and body["failure_reason"] == reason, body
    else:
        raise AssertionError("a CosyVoice failure must be reported as a definite command failure")


async def main() -> None:
    original_client = gateway.httpx.AsyncClient
    original_preview_url = gateway.PREVIEW_BROKER_URL
    original_preview_token = gateway.PREVIEW_BROKER_TOKEN
    gateway.RUNTIME_TOKEN = "e" * 32
    gateway.COSYVOICE_MODEL_KIND = "sft"
    try:
        gateway.PREVIEW_BROKER_URL = "https://preview-broker.example"
        gateway.PREVIEW_BROKER_TOKEN = "p" * 32
        gateway.httpx.AsyncClient = lambda **_kwargs: FailingClient()
        await expect_detail(gateway.livetalking_post("/interrupt_talk", {}), "LiveTalking request failed")
        await expect_detail(gateway.livetalking_get("/private"), "LiveTalking request failed")
        await expect_cosyvoice_failure("CosyVoice request failed", "cosyvoice_unreachable")
        await expect_detail(gateway.livetalking_audio("session", b"audio"), "LiveTalking audio request failed")
        await expect_detail(gateway.preview_broker_get("session"), "Preview broker request failed")

        gateway.httpx.AsyncClient = upstream_answering(500, b"private-stream-key traceback")
        await expect_cosyvoice_failure("CosyVoice rejected the synthesis request", "cosyvoice_http_status")
        gateway.httpx.AsyncClient = upstream_answering(200, b"\x01\x00\x02")
        await expect_cosyvoice_failure("CosyVoice returned incomplete audio", "cosyvoice_odd_audio_length")

        gateway.httpx.AsyncClient = lambda **_kwargs: RejectingClient()
        await expect_detail(gateway.livetalking_post("/interrupt_talk", {}), "LiveTalking rejected request")
        await expect_detail(gateway.livetalking_audio("session", b"audio"), "LiveTalking rejected audio request")

        for body in (b"not-json-private-stream-key", b"[1, 2]", b'"private-stream-key"', b"null"):
            gateway.httpx.AsyncClient = upstream_answering(200, body)
            await expect_detail(gateway.livetalking_post("/interrupt_talk", {}), "LiveTalking returned an invalid response")
            await expect_detail(gateway.livetalking_get("/private"), "LiveTalking returned an invalid response")
            await expect_detail(gateway.livetalking_audio("session", b"audio"), "LiveTalking returned an invalid response")
            await expect_detail(gateway.preview_broker_get("session"), "Preview broker returned an invalid response")
            assert await gateway.service_health("http://livetalking.internal", "/api/admin/sessions", expected_code=0) == {"available": False}
            await expect_detail(gateway.observation("session", f"Bearer {gateway.RUNTIME_TOKEN}"), "LiveTalking returned an invalid response")
            await expect_detail(gateway.preview("session", f"Bearer {gateway.RUNTIME_TOKEN}"), "LiveTalking returned an invalid response")

        for metrics in (b'{"code": 0, "data": [1]}', b'{"code": 0, "data": null}', b'{"code": 0, "data": {"sessions": 5}}', b'{"code": 0, "data": {"sessions": {"private-stream-key": 1}}}'):
            gateway.httpx.AsyncClient = upstream_answering(200, metrics)
            await expect_detail(gateway.observation("session", f"Bearer {gateway.RUNTIME_TOKEN}"), "LiveTalking returned an invalid response")
            await expect_detail(gateway.preview("session", f"Bearer {gateway.RUNTIME_TOKEN}"), "LiveTalking returned an invalid response")

        gateway.httpx.AsyncClient = upstream_answering(200, b'{"code": 0}')
        missing_metrics = await gateway.observation("session", f"Bearer {gateway.RUNTIME_TOKEN}")
        assert missing_metrics["session"]["active"] is False, "LiveTalking metrics without a data object still mean no active session"

        await check_livetalking_failure_classification()
    finally:
        gateway.httpx.AsyncClient = original_client
        gateway.PREVIEW_BROKER_URL = original_preview_url
        gateway.PREVIEW_BROKER_TOKEN = original_preview_token


def raising(error_type):
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type("private-stream-key", request=request)

    return lambda **kwargs: RealAsyncClient(transport=httpx.MockTransport(handler), **kwargs)


async def check_livetalking_failure_classification() -> None:
    """Requirement 19.5/19.7: each LiveTalking failure is either definitely not executed or uncertain."""
    cases = [
        (upstream_answering(404, b'{"detail": "session not found private-stream-key"}'), 502, "livetalking_client_error", True),
        (upstream_answering(400, b"{}"), 502, "livetalking_client_error", True),
        (upstream_answering(408, b"{}"), 502, "livetalking_retryable_status", False),
        (upstream_answering(429, b"{}"), 502, "livetalking_retryable_status", False),
        (upstream_answering(500, b"private-stream-key traceback"), 502, "livetalking_server_error", False),
        (upstream_answering(503, b"{}"), 502, "livetalking_server_error", False),
        (upstream_answering(302, b"{}"), 502, "livetalking_unexpected_status", False),
        (upstream_answering(200, b'{"code": 1}'), 502, "livetalking_business_rejected", True),
        (upstream_answering(200, b'{"code": -1}'), 502, "livetalking_business_rejected", True),
        (upstream_answering(200, b'{"code": "0"}'), 502, "livetalking_invalid_response", False),
        (upstream_answering(200, b'{"code": false}'), 502, "livetalking_invalid_response", False),
        (upstream_answering(200, b'{"msg": "ok"}'), 502, "livetalking_invalid_response", False),
        (upstream_answering(200, b"not-json-private-stream-key"), 502, "livetalking_invalid_response", False),
        (raising(httpx.ConnectError), 502, "livetalking_unreachable", True),
        (raising(httpx.ConnectTimeout), 502, "livetalking_unreachable", True),
        (raising(httpx.PoolTimeout), 502, "livetalking_unreachable", True),
        (raising(httpx.UnsupportedProtocol), 502, "livetalking_unreachable", True),
        (raising(httpx.ReadTimeout), 504, "livetalking_timeout", False),
        (raising(httpx.WriteTimeout), 504, "livetalking_timeout", False),
        (raising(httpx.ReadError), 502, "livetalking_connection_lost", False),
        (raising(httpx.RemoteProtocolError), 502, "livetalking_connection_lost", False),
    ]
    for client, status, reason, definite in cases:
        gateway.httpx.AsyncClient = client
        for operation in (lambda: gateway.livetalking_post("/set_audiotype", {}), lambda: gateway.livetalking_audio("session", b"audio")):
            try:
                await operation()
            except gateway.LiveTalkingFailure as error:
                assert (error.status_code, error.reason, error.definite) == (status, reason, definite), (reason, error.status_code, error.reason, error.definite)
                assert "private-stream-key" not in error.detail, error.detail
            else:
                raise AssertionError(f"{reason}: the LiveTalking failure must be classified")
    gateway.httpx.AsyncClient = upstream_answering(200, b'{"code": 0, "data": {}}')
    assert (await gateway.livetalking_post("/set_audiotype", {}))["code"] == 0


asyncio.run(main())

print("PASS  Runtime Gateway keeps downstream diagnostics out of API errors")
