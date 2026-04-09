"""Valentina Dashboard FastAPI backend."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).parent))
import hermes_data as hd

from backend.providers.live_api import get_live_providers
from backend.subscription_usage import get_subscription_usage
from backend.voice_chat import router as voice_chat_router
from backend.zai_tracker import get_stats, log_usage

ZAI_PROXY_URL = "https://api.z.ai/api/anthropic/v1/messages"
ZAI_PROXY_TIMEOUT = httpx.Timeout(600.0)
FORWARDED_HEADERS = (
    "x-api-key",
    "anthropic-version",
    "content-type",
    "anthropic-beta",
)

app = FastAPI(title="Valentina Dashboard", version="1.0.0")
app.include_router(voice_chat_router)


def _forward_headers(request: Request) -> dict[str, str]:
    """Pick the supported upstream headers from the incoming request."""
    headers: dict[str, str] = {}
    for header in FORWARDED_HEADERS:
        value = request.headers.get(header)
        if value:
            headers[header] = value
    if "content-type" not in headers:
        headers["content-type"] = "application/json"
    return headers


def _extract_usage(payload: dict) -> tuple[int, int]:
    """Read Anthropic-style usage from a non-streaming response."""
    usage = payload.get("usage") or {}
    return int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0)


def _extract_stream_usage(payload: dict) -> tuple[int | None, int | None]:
    """Read usage fragments from a streaming event payload."""
    usage = payload.get("usage")
    if usage is None:
        usage = (payload.get("message") or {}).get("usage")
    if usage is None:
        usage = (payload.get("delta") or {}).get("usage")
    if usage is None:
        return None, None
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    return (
        int(input_tokens) if input_tokens is not None else None,
        int(output_tokens) if output_tokens is not None else None,
    )


def _parse_sse_event(block: str) -> tuple[str | None, dict | None]:
    """Parse one SSE event block into its event name and JSON payload."""
    event_name = None
    data_lines: list[str] = []
    for line in block.splitlines():
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if not data_lines:
        return event_name, None
    data = "\n".join(data_lines)
    if data == "[DONE]":
        return event_name, None
    try:
        return event_name, json.loads(data)
    except json.JSONDecodeError:
        return event_name, None


async def _log_usage_async(model: str | None, input_tokens: int, output_tokens: int, status: int) -> None:
    """Write a usage row without blocking the event loop."""
    await asyncio.to_thread(log_usage, model, input_tokens, output_tokens, status)


@app.get("/api/providers/live")
async def providers_live():
    return await get_live_providers(force=False)


@app.post("/api/providers/refresh")
async def providers_refresh():
    return await get_live_providers(force=True)


@app.options("/zai/proxy/v1/messages")
async def zai_proxy_options() -> Response:
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": ", ".join(FORWARDED_HEADERS),
            "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
    )


@app.post("/zai/proxy/v1/messages")
async def zai_proxy_messages(request: Request):
    """Forward Claude-compatible requests to Z.ai and track usage locally."""
    body = await request.json()
    headers = _forward_headers(request)
    model = body.get("model")

    if body.get("stream"):
        client = httpx.AsyncClient(timeout=ZAI_PROXY_TIMEOUT)
        try:
            upstream_request = client.build_request("POST", ZAI_PROXY_URL, headers=headers, json=body)
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError as exc:
            await _log_usage_async(model, 0, 0, 502)
            return JSONResponse(status_code=502, content={"error": f"Upstream request failed: {exc}"})

        if upstream.status_code >= 400:
            error_body = await upstream.aread()
            await _log_usage_async(model, 0, 0, upstream.status_code)
            response = Response(
                content=error_body,
                status_code=upstream.status_code,
                media_type=upstream.headers.get("content-type"),
                headers={"Access-Control-Allow-Origin": "*"},
            )
            await upstream.aclose()
            await client.aclose()
            return response

        async def event_stream():
            buffer = ""
            input_tokens = 0
            output_tokens = 0
            status_to_log = upstream.status_code
            try:
                async for chunk in upstream.aiter_text():
                    buffer += chunk
                    while "\n\n" in buffer:
                        block, buffer = buffer.split("\n\n", 1)
                        event_name, payload = _parse_sse_event(block)
                        if payload and event_name in {"message_start", "message_delta"}:
                            maybe_input, maybe_output = _extract_stream_usage(payload)
                            if maybe_input is not None:
                                input_tokens = maybe_input
                            if maybe_output is not None:
                                output_tokens = maybe_output
                        yield f"{block}\n\n"
                if buffer:
                    event_name, payload = _parse_sse_event(buffer)
                    if payload and event_name in {"message_start", "message_delta"}:
                        maybe_input, maybe_output = _extract_stream_usage(payload)
                        if maybe_input is not None:
                            input_tokens = maybe_input
                        if maybe_output is not None:
                            output_tokens = maybe_output
                    yield buffer
            except httpx.HTTPError:
                status_to_log = 502
                raise
            finally:
                await _log_usage_async(model, input_tokens, output_tokens, status_to_log)
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(
            event_stream(),
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "text/event-stream"),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    try:
        async with httpx.AsyncClient(timeout=ZAI_PROXY_TIMEOUT) as client:
            upstream = await client.post(ZAI_PROXY_URL, headers=headers, json=body)
    except httpx.HTTPError as exc:
        await _log_usage_async(model, 0, 0, 502)
        return JSONResponse(status_code=502, content={"error": f"Upstream request failed: {exc}"})

    if upstream.status_code >= 400:
        await _log_usage_async(model, 0, 0, upstream.status_code)
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    payload = upstream.json()
    input_tokens, output_tokens = _extract_usage(payload)
    await _log_usage_async(model, input_tokens, output_tokens, upstream.status_code)
    return JSONResponse(
        status_code=upstream.status_code,
        content=payload,
        headers={"Access-Control-Allow-Origin": "*"},
    )


# API Routes
@app.get("/api/overview")
def overview():
    return hd.get_overview()


@app.get("/api/sessions")
def sessions(limit: int = 20):
    return hd.get_sessions(limit)


@app.get("/api/providers")
def providers():
    return hd.get_providers_status()


@app.get("/api/tokens-by-provider")
def tokens_by_provider():
    return hd.get_token_usage_by_provider()


@app.get("/api/activity")
def activity(days: int = 7):
    return hd.get_activity_timeline(days)


@app.get("/api/tools")
def tools():
    return hd.get_tool_usage()


@app.get("/api/cron")
def cron():
    return hd.get_cron_jobs()


@app.get("/api/zai/usage")
async def zai_usage():
    """Return locally tracked Z.ai usage stats."""
    return await asyncio.to_thread(get_stats)


@app.get("/api/subscriptions/usage")
async def subscriptions_usage():
    """Return locally parsed subscription usage for Codex and Claude Code."""
    return await asyncio.to_thread(get_subscription_usage)


# Serve frontend
frontend_dir = Path(__file__).parent.parent / "frontend"
app.mount("/css", StaticFiles(directory=str(frontend_dir / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(frontend_dir / "js")), name="js")
app.mount("/assets", StaticFiles(directory=str(frontend_dir / "assets")), name="assets")


@app.get("/manifest.json")
def manifest():
    return FileResponse(str(frontend_dir / "manifest.json"), media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(
        str(frontend_dir / "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/")
def root():
    return FileResponse(str(frontend_dir / "index.html"))


@app.get("/voice")
def voice():
    return FileResponse(str(frontend_dir / "voice.html"))


@app.get("/avatar")
def avatar():
    return FileResponse(str(frontend_dir / "avatar.html"))
