"""
TubeForge Voice-Clone API — PREVIEW BUILD
Slimmed-down main.py that uses stub_tts instead of the real XTTS-v2 model.
Same API surface as the production app so you can exercise every endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Header,
    UploadFile,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .stub_tts import get_tts
from .storage import VoiceProfileStore

# --------------------------------------------------------------------------- #
# App + config
# --------------------------------------------------------------------------- #

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("tubeforge.voice")

app = FastAPI(
    title="TubeForge Voice-Clone API (PREVIEW)",
    version="0.1.0-preview",
    description=(
        "Preview build of the TubeForge voice-clone backend. "
        "Same API surface as production, but uses a stub TTS engine that "
        "generates a short tone instead of running XTTS-v2. "
        "All endpoints work end-to-end — test the full clone -> synthesize -> "
        "poll -> download flow."
    ),
)

API_KEY = os.getenv("API_KEY", "preview-key")
MAX_TEXT_LENGTH = int(os.getenv("MAX_TEXT_LENGTH", "5000"))
JOB_TIMEOUT = int(os.getenv("JOB_TIMEOUT", "600"))

DATA_DIR = Path(os.getenv("PREVIEW_DATA_DIR", "/home/z/my-project/preview/data"))
VOICE_DIR = DATA_DIR / "voice_profiles"
OUTPUT_DIR = DATA_DIR / "outputs"
VOICE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

store = VoiceProfileStore(VOICE_DIR)
JOBS: dict[str, dict] = {}


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #

def require_auth(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail=f"invalid or missing API key (preview key: {API_KEY})")
    return True


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_TEXT_LENGTH)
    voice: str = Field(..., description="name of a registered voice profile")
    language: str = Field("en", max_length=8)
    speed: float = Field(1.0, ge=0.5, le=2.0)


# --------------------------------------------------------------------------- #
# Background TTS job
# --------------------------------------------------------------------------- #

async def run_synthesis(job_id: str, req: SynthesizeRequest):
    JOBS[job_id]["status"] = "processing"
    try:
        tts = get_tts()
        ref_path = store.path_for(req.voice)
        if not ref_path:
            raise FileNotFoundError(f"voice profile '{req.voice}' not found")

        out_path = OUTPUT_DIR / f"{job_id}.wav"

        def _do():
            tts.tts_to_file(
                text=req.text,
                speaker_wav=str(ref_path),
                language=req.language,
                speed=req.speed,
                file_path=str(out_path),
            )

        loop = asyncio.get_event_loop()
        await asyncio.wait_for(loop.run_in_executor(None, _do), timeout=JOB_TIMEOUT)

        JOBS[job_id].update(
            status="completed",
            output=f"/outputs/{job_id}.wav",
            bytes=out_path.stat().st_size,
        )
        log.info("job %s completed (%.1f KB)", job_id, out_path.stat().st_size / 1024)

    except Exception as exc:
        JOBS[job_id].update(status="failed", error=str(exc))
        log.exception("job %s failed", job_id)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

@app.get("/", response_class=HTMLResponse)
def root():
    """Tiny landing page so visiting the URL in a browser shows something useful."""
    return f"""
<!doctype html>
<html><head>
<meta charset="utf-8">
<title>TubeForge Voice-Clone API (PREVIEW)</title>
<style>
body {{ font-family: ui-sans-serif, system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #222; }}
code, pre {{ background: #f4f4f4; padding: 4px 8px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 13px; }}
pre {{ padding: 12px; overflow-x: auto; }}
h1 {{ font-size: 24px; }}
h2 {{ font-size: 18px; margin-top: 32px; }}
.note {{ background: #fff7e6; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 4px; }}
.ok {{ background: #ecfdf3; border-left: 4px solid #10b981; padding: 12px 16px; margin: 16px 0; border-radius: 4px; }}
table {{ border-collapse: collapse; width: 100%; margin: 16px 0; }}
td, th {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 14px; }}
th {{ background: #fafafa; }}
.api-key {{ font-weight: bold; color: #10b981; }}
</style>
</head><body>
<h1>TubeForge Voice-Clone API (PREVIEW)</h1>
<div class="note">
<b>Preview mode</b> — this build uses a stub TTS engine that generates a short
sine tone instead of the real XTTS-v2 model. Every endpoint works end-to-end;
only the audio content is fake. The production build on the Oracle Cloud box
will produce real speech.
</div>

<h2>API key</h2>
<div class="ok">Your preview API key: <code class="api-key">{API_KEY}</code></div>

<h2>Quick test (run from another terminal)</h2>
<pre># 1. Clone a voice (use any .wav or .mp3 file as a "reference")
curl -X POST http://localhost:8000/clone \\
  -H "X-API-Key: {API_KEY}" \\
  -F "name=demo" \\
  -F "file=@/path/to/reference.wav"

# 2. Synthesize text
curl -X POST http://localhost:8000/synthesize \\
  -H "X-API-Key: {API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{{"text":"Hello from TubeForge.","voice":"demo"}}'

# 3. Poll for completion (replace with the job_id returned above)
curl http://localhost:8000/jobs/&lt;job_id&gt; -H "X-API-Key: {API_KEY}"

# 4. Download the result
curl -o output.wav http://localhost:8000/outputs/&lt;job_id&gt;.wav -H "X-API-Key: {API_KEY}"
</pre>

<h2>Endpoints</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
<tr><td>GET</td><td><code>/health</code></td><td>Liveness probe (no auth)</td></tr>
<tr><td>GET</td><td><code>/docs</code></td><td>Interactive Swagger UI</td></tr>
<tr><td>POST</td><td><code>/clone</code></td><td>Upload reference clip, register voice</td></tr>
<tr><td>POST</td><td><code>/synthesize</code></td><td>Text -> async TTS job</td></tr>
<tr><td>GET</td><td><code>/jobs/{{id}}</code></td><td>Poll job status</td></tr>
<tr><td>GET</td><td><code>/jobs</code></td><td>List all jobs</td></tr>
<tr><td>GET</td><td><code>/voices</code></td><td>List voice profiles</td></tr>
<tr><td>DELETE</td><td><code>/voices/{{name}}</code></td><td>Delete a voice profile</td></tr>
<tr><td>GET</td><td><code>/outputs/{{file}}</code></td><td>Download generated audio</td></tr>
</table>

<h2>Explore interactively</h2>
<p>Open <a href="/docs"><code>/docs</code></a> for the full Swagger UI — authorize with the API key above and click through every endpoint.</p>

</body></html>
"""


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": get_tts(peek=True) is not None, "mode": "preview"}


@app.post("/clone", dependencies=[Depends(require_auth)])
async def clone_voice(
    name: str = Form(..., min_length=2, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$"),
    file: UploadFile = File(...),
):
    if file.content_type not in {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"}:
        raise HTTPException(400, f"unsupported content type: {file.content_type}")

    suffix = ".wav" if "wav" in (file.content_type or "") else ".mp3"
    save_path = VOICE_DIR / f"{name}{suffix}"
    with save_path.open("wb") as f:
        f.write(await file.read())

    store.register(name, save_path.name)
    log.info("registered voice profile '%s' -> %s", name, save_path)
    return {"status": "ok", "voice": name, "file": save_path.name, "size": save_path.stat().st_size}


@app.post("/synthesize", dependencies=[Depends(require_auth)])
async def synthesize(req: SynthesizeRequest, background: BackgroundTasks):
    if not store.exists(req.voice):
        raise HTTPException(404, f"voice profile '{req.voice}' not found. POST /clone first.")

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {
        "id": job_id,
        "status": "queued",
        "text_length": len(req.text),
        "voice": req.voice,
        "language": req.language,
    }
    background.add_task(run_synthesis, job_id, req)
    return {"job_id": job_id, "status": "queued", "poll": f"/jobs/{job_id}"}


@app.get("/jobs/{job_id}", dependencies=[Depends(require_auth)])
def job_status(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "job not found")
    return JOBS[job_id]


@app.get("/jobs", dependencies=[Depends(require_auth)])
def list_jobs():
    return {"jobs": list(JOBS.values())}


@app.get("/voices", dependencies=[Depends(require_auth)])
def list_voices():
    return {"voices": store.list_all()}


@app.delete("/voices/{name}", dependencies=[Depends(require_auth)])
def delete_voice(name: str):
    if not store.exists(name):
        raise HTTPException(404, "voice not found")
    store.delete(name)
    return {"status": "deleted", "voice": name}


@app.get("/outputs/{filename}", dependencies=[Depends(require_auth)])
def download_output(filename: str):
    if not filename.endswith(".wav") or "/" in filename or ".." in filename:
        raise HTTPException(400, "invalid filename")
    path = OUTPUT_DIR / filename
    if not path.is_file():
        raise HTTPException(404, "output not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)
