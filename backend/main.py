"""
Valentina Dashboard — FastAPI Backend
"""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))
import hermes_data as hd

from backend.voice_chat import router as voice_chat_router
from backend.providers.live_api import get_live_providers

app = FastAPI(title="Valentina Dashboard", version="1.0.0")
app.include_router(voice_chat_router)

@app.get("/api/providers/live")
async def providers_live():
    return await get_live_providers(force=False)

@app.post("/api/providers/refresh")
async def providers_refresh():
    return await get_live_providers(force=True)

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
    return FileResponse(str(frontend_dir / "sw.js"), media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/"})

@app.get("/")
def root():
    return FileResponse(str(frontend_dir / "index.html"))

@app.get("/voice")
def voice():
    return FileResponse(str(frontend_dir / "voice.html"))

@app.get("/avatar")
def avatar():
    return FileResponse(str(frontend_dir / "avatar.html"))
