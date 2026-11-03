import asyncio
import pathlib
import sys

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


class RejectedResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {"code": 1, "msg": "private-stream-key must not escape"}


class RejectingClient(FailingClient):
    async def post(self, *_args, **_kwargs):
        return RejectedResponse()

    async def get(self, *_args, **_kwargs):
        return RejectedResponse()


async def expect_detail(operation, expected: str) -> None:
    try:
        await operation
    except HTTPException as error:
        assert error.detail == expected
        assert "private-stream-key" not in error.detail
    else:
        raise AssertionError("Gateway downstream failure must return HTTPException")


async def main() -> None:
    original_client = gateway.httpx.AsyncClient
    try:
        gateway.httpx.AsyncClient = lambda **_kwargs: FailingClient()
        await expect_detail(gateway.livetalking_post("/private", {}), "LiveTalking request failed")
        await expect_detail(gateway.livetalking_get("/private"), "LiveTalking request failed")
        await expect_detail(gateway.cosyvoice_synthesize("hello", "voice"), "CosyVoice request failed")
        await expect_detail(gateway.livetalking_audio("session", b"audio"), "LiveTalking audio request failed")

        gateway.httpx.AsyncClient = lambda **_kwargs: RejectingClient()
        await expect_detail(gateway.livetalking_post("/private", {}), "LiveTalking rejected request")
        await expect_detail(gateway.livetalking_audio("session", b"audio"), "LiveTalking rejected audio request")
    finally:
        gateway.httpx.AsyncClient = original_client


asyncio.run(main())

print("PASS  Runtime Gateway keeps downstream diagnostics out of API errors")
