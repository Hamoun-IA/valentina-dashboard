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

from backend.voice_usage import log_voice_interaction, get_voice_stats
from backend import bridge_memory
from backend.lipsync import build_viseme_timeline

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
ELEVENLABS_TTS_TIMESTAMPS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/with-timestamps"
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


def _split_text_for_tts(text: str, max_chars: int = 4000) -> list[str]:
    """Split text into chunks suitable for ElevenLabs TTS (max ~5000 chars).
    Splits on sentence boundaries to keep natural prosody."""
    if len(text) <= max_chars:
        return [text]
    
    import re
    sentences = re.split(r'(?<=[.!?…])\s+', text)
    chunks = []
    current = ""
    for s in sentences:
        if len(current) + len(s) + 1 > max_chars and current:
            chunks.append(current.strip())
            current = s
        else:
            current = current + " " + s if current else s
    if current.strip():
        chunks.append(current.strip())
    return chunks if chunks else [text]


async def elevenlabs_tts_with_timestamps(text: str) -> tuple[bytes, list[dict]]:
    """
    Call ElevenLabs with-timestamps endpoint to get MP3 audio + character-level timings.
    Returns (audio_bytes, viseme_timeline).

    Timeline is already phoneme-expanded and viseme-mapped via backend.lipsync.
    For long text, splits into chunks and offsets subsequent timestamps.
    """
    import base64
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    text_chunks = _split_text_for_tts(text)

    audio_parts: list[bytes] = []
    full_timeline: list[dict] = []
    time_offset = 0.0

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        for text_chunk in text_chunks:
            payload = {
                "text": text_chunk,
                "model_id": ELEVENLABS_MODEL,
                "voice_settings": ELEVENLABS_SETTINGS,
            }
            resp = await client.post(ELEVENLABS_TTS_TIMESTAMPS_URL, json=payload, headers=headers)
            if resp.status_code != 200:
                logger.error(f"ElevenLabs timestamps error {resp.status_code}: {resp.text[:300]}")
                return b"", []
            data = resp.json()
            audio_b64 = data.get("audio_base64", "")
            audio_parts.append(base64.b64decode(audio_b64))

            align = data.get("alignment") or {}
            chars = align.get("characters", [])
            starts = align.get("character_start_times_seconds", [])
            ends = align.get("character_end_times_seconds", [])

            if chars and starts and ends:
                chunk_tl = build_viseme_timeline(text_chunk, chars, starts, ends)
                # Offset timings by cumulative position in the concatenated audio
                for ev in chunk_tl:
                    ev = dict(ev)
                    ev['t'] = round(ev['t'] + time_offset, 4)
                    full_timeline.append(ev)
                if ends:
                    time_offset += ends[-1] + 0.08  # gap between chunks

    return b"".join(audio_parts), full_timeline


async def elevenlabs_tts_stream(text: str):
    """Send text to ElevenLabs TTS and yield audio chunks.
    Splits long text into multiple requests to avoid character limits."""
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    
    text_chunks = _split_text_for_tts(text)
    
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        for text_chunk in text_chunks:
            payload = {
                "text": text_chunk,
                "model_id": ELEVENLABS_MODEL,
                "voice_settings": ELEVENLABS_SETTINGS,
            }
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
    # System prompt is rebuilt per-turn so we can inject query-relevant facts
    recent_turns = bridge_memory.load_recent_turns(limit=20)
    history: list[dict] = recent_turns[:]  # no system yet; injected per turn
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
            bridge_memory.log_turn("voice", "user", user_text)

            # Rebuild system prompt with query-relevant long-term facts
            system_prompt = bridge_memory.build_persona_system_prompt(current_query=user_text)
            turn_messages = [{"role": "system", "content": system_prompt}] + history

            # Stream LLM response (Grok with Gemini fallback)
            full_response = ""
            used_fallback = False
            model_used = XAI_MODEL

            try:
                logger.info(f"Calling Grok ({XAI_MODEL}) with {len(turn_messages)} messages")
                llm_gen = stream_grok(list(turn_messages))
                full_response = await _process_llm_stream(llm_gen, ws)
                logger.info(f"Grok response: {len(full_response)} chars")
            except Exception as e:
                logger.warning(f"Grok failed ({e}), falling back to Gemini")
                used_fallback = True
                model_used = "gemini-2.0-flash"
                try:
                    llm_gen = stream_gemini(list(turn_messages))
                    full_response = await _process_llm_stream(llm_gen, ws)
                    logger.info(f"Gemini fallback response: {len(full_response)} chars")
                except Exception as e2:
                    logger.error(f"Gemini also failed: {e2}")
                    await ws.send_text(json.dumps({"type": "error", "text": f"Both LLMs failed: {e2}"}))
                    history.pop()
                    continue

            # Save assistant response to history
            if full_response:
                history.append({"role": "assistant", "content": full_response})
                bridge_memory.log_turn("voice", "assistant", full_response, model=model_used)
                # Fire-and-forget fact extraction (runs in threadpool so TTS isn't blocked)
                try:
                    asyncio.create_task(
                        asyncio.to_thread(
                            bridge_memory.extract_and_store_facts,
                            user_text,
                            full_response,
                        )
                    )
                except Exception as e:
                    logger.debug(f"Fact extraction task launch failed: {e}")

            # Now do TTS with character-level timings → phoneme-based viseme timeline
            if full_response:
                try:
                    audio_bytes, viseme_timeline = await elevenlabs_tts_with_timestamps(full_response)
                    if viseme_timeline:
                        # Send the timeline BEFORE the audio so the client can prime it
                        await ws.send_text(json.dumps({
                            "type": "viseme_timeline",
                            "events": viseme_timeline,
                        }))
                    if audio_bytes:
                        # Send audio in chunks so the WS doesn't block on huge payloads
                        CHUNK = 8192
                        for i in range(0, len(audio_bytes), CHUNK):
                            await ws.send_bytes(audio_bytes[i:i+CHUNK])
                except Exception as e:
                    logger.error(f"TTS error: {e}")
                    await ws.send_text(json.dumps({"type": "error", "text": f"TTS error: {e}"}))

            # Log voice interaction
            if full_response:
                try:
                    log_voice_interaction(user_text, full_response, model_used, used_fallback)
                except Exception as log_err:
                    logger.error(f"Failed to log voice interaction: {log_err}")

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


@router.get("/api/voice-stats")
async def voice_stats_endpoint():
    """Return voice chat usage statistics."""
    return get_voice_stats()


@router.post("/api/voice/tts")
async def tts_endpoint(req: TTSRequest):
    """Test endpoint: convert text to speech via ElevenLabs."""
    async def audio_gen():
        async for chunk in elevenlabs_tts_stream(req.text):
            yield chunk

    return StreamingResponse(audio_gen(), media_type="audio/mpeg")
