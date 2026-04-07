"""
Valentina Voice Chat — WebSocket + TTS endpoint
"""
import json
import asyncio
import logging
import os
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx

logger = logging.getLogger("valentina.voice_chat")

router = APIRouter()

# --- Config (loaded from environment) ---
SYSTEM_PROMPT = (
    "Tu es Valentina, une assistante IA française. Tu es directe, charmeuse, "
    "un peu sarcastique, et très compétente. Tu réponds de manière concise pour "
    "la conversation vocale (2-3 phrases max sauf si on te demande plus)."
)

XAI_API_KEY = os.environ.get("XAI_API_KEY", "")
XAI_URL = "https://api.x.ai/v1/chat/completions"
XAI_MODEL = "grok-4-1-fast-non-reasoning"

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key={GEMINI_KEY}"

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = "HuLbOdhRlvQQN8oPP0AJ"
ELEVENLABS_TTS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"
ELEVENLABS_MODEL = "eleven_multilingual_v2"
ELEVENLABS_SETTINGS = {"stability": 0.4, "similarity_boost": 0.8, "style": 0.6}

FIRST_TOKEN_TIMEOUT = 5.0


# --- LLM streaming helpers ---

async def stream_grok(messages: list[dict], timeout: float = FIRST_TOKEN_TIMEOUT):
    """Stream from xAI Grok. Yields text chunks. Raises on failure or timeout."""
    headers = {
        "Authorization": f"Bearer {XAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": XAI_MODEL,
        "messages": messages,
        "stream": True,
    }
    first_token_received = asyncio.Event()

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        async with client.stream("POST", XAI_URL, json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"Grok API error {resp.status_code}: {body[:300]}")

            async def line_reader():
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:].strip()
                        if data == "[DONE]":
                            return
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0].get("delta", {})
                            text = delta.get("content", "")
                            if text:
                                first_token_received.set()
                                yield text
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue

            # Wrap with first-token timeout
            gen = line_reader()
            # Wait for first token with timeout
            first_chunk_task = asyncio.ensure_future(_anext_or_none(gen))
            try:
                done, _ = await asyncio.wait({first_chunk_task}, timeout=timeout)
                if not done:
                    first_chunk_task.cancel()
                    raise asyncio.TimeoutError("Grok first token timeout")
                result = first_chunk_task.result()
                if result is not None:
                    yield result
            except asyncio.CancelledError:
                raise asyncio.TimeoutError("Grok first token timeout")

            # Stream remaining
            async for chunk in gen:
                yield chunk


async def _anext_or_none(agen):
    try:
        return await agen.__anext__()
    except StopAsyncIteration:
        return None


async def stream_gemini(messages: list[dict]):
    """Fallback: stream from Gemini Flash. Yields text chunks."""
    # Convert OpenAI-style messages to Gemini format
    contents = []
    for msg in messages:
        if msg["role"] == "system":
            contents.append({"role": "user", "parts": [{"text": f"[System instruction]: {msg['content']}"}]})
            contents.append({"role": "model", "parts": [{"text": "Compris, je suivrai ces instructions."}]})
        elif msg["role"] == "user":
            contents.append({"role": "user", "parts": [{"text": msg["content"]}]})
        elif msg["role"] == "assistant":
            contents.append({"role": "model", "parts": [{"text": msg["content"]}]})

    payload = {"contents": contents}

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        async with client.stream("POST", f"{GEMINI_URL}&alt=sse", json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"Gemini API error {resp.status_code}: {body[:300]}")
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data = line[6:].strip()
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                        candidates = chunk.get("candidates", [])
                        if candidates:
                            parts = candidates[0].get("content", {}).get("parts", [])
                            for part in parts:
                                text = part.get("text", "")
                                if text:
                                    yield text
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue


async def elevenlabs_tts_stream(text: str):
    """Send text to ElevenLabs TTS and yield audio chunks."""
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": ELEVENLABS_SETTINGS,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        async with client.stream("POST", ELEVENLABS_TTS_URL, json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                logger.error(f"ElevenLabs error {resp.status_code}: {body[:300]}")
                return
            async for chunk in resp.aiter_bytes(chunk_size=4096):
                yield chunk


# --- WebSocket endpoint ---

@router.websocket("/ws/voice-chat")
async def voice_chat_ws(ws: WebSocket):
    await ws.accept()
    history: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    logger.info("Voice chat WebSocket connected")

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "text": "Invalid JSON"}))
                continue

            if msg.get("type") != "user_message" or not msg.get("text", "").strip():
                await ws.send_text(json.dumps({"type": "error", "text": "Send {type: 'user_message', text: '...'}"}))
                continue

            user_text = msg["text"].strip()
            history.append({"role": "user", "content": user_text})

            # Stream LLM response (Grok with Gemini fallback)
            full_response = ""
            used_fallback = False

            try:
                llm_gen = stream_grok(list(history))
                full_response = await _process_llm_stream(llm_gen, ws)
            except Exception as e:
                logger.warning(f"Grok failed ({e}), falling back to Gemini")
                used_fallback = True
                try:
                    llm_gen = stream_gemini(list(history))
                    full_response = await _process_llm_stream(llm_gen, ws)
                except Exception as e2:
                    logger.error(f"Gemini also failed: {e2}")
                    await ws.send_text(json.dumps({"type": "error", "text": f"Both LLMs failed: {e2}"}))
                    # Remove user message from history on total failure
                    history.pop()
                    continue

            # Save assistant response to history
            if full_response:
                history.append({"role": "assistant", "content": full_response})

            # Now do TTS on the full response
            if full_response:
                try:
                    async for audio_chunk in elevenlabs_tts_stream(full_response):
                        await ws.send_bytes(audio_chunk)
                except Exception as e:
                    logger.error(f"TTS error: {e}")
                    await ws.send_text(json.dumps({"type": "error", "text": f"TTS error: {e}"}))

            await ws.send_text(json.dumps({
                "type": "response_complete",
                "fallback_used": used_fallback,
            }))

    except WebSocketDisconnect:
        logger.info("Voice chat WebSocket disconnected")
    except Exception as e:
        logger.error(f"Voice chat WebSocket error: {e}")
        try:
            await ws.close(code=1011, reason=str(e)[:120])
        except Exception:
            pass


async def _process_llm_stream(gen, ws: WebSocket) -> str:
    """Consume an async generator of text chunks, send them to the WebSocket, return full text."""
    full = ""
    async for chunk in gen:
        full += chunk
        await ws.send_text(json.dumps({"type": "text_chunk", "text": chunk}))
    return full


# --- REST TTS endpoint ---

class TTSRequest(BaseModel):
    text: str


@router.post("/api/voice/tts")
async def tts_endpoint(req: TTSRequest):
    """Test endpoint: convert text to speech via ElevenLabs."""
    async def audio_gen():
        async for chunk in elevenlabs_tts_stream(req.text):
            yield chunk

    return StreamingResponse(audio_gen(), media_type="audio/mpeg")
