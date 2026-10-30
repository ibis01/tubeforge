#!/usr/bin/env python3
"""Bundle voice_server.py + an ORACLE LINUX (dnf-free) installer into ONE file.

Output: /home/z/my-project/download/oracle-install-ol.sh
Distro-agnostic: uses uv-managed Python 3.11 + static ffmpeg, zero dnf/apt.
"""
import pathlib

root = pathlib.Path("/home/z/my-project/voice-server")
out = pathlib.Path("/home/z/my-project/download/oracle-install-ol.sh")
out.parent.mkdir(parents=True, exist_ok=True)

voice = (root / "voice_server.py").read_text()
if not voice.endswith("\n"):
    voice += "\n"

body = r'''
set -euo pipefail
export HOME="${HOME:-/root}"
export PATH="/usr/local/bin:$PATH"

PORT="8931"
KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)  KEY="$2";  shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown argument: $1 (use --key / --port)"; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (Run command does this automatically)."; exit 1
fi
if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then
  echo "curl and tar are required (present on a default Oracle Linux image)."; exit 1
fi

KEY="${KEY:-${VOICE_KEY:-$(openssl rand -hex 16 2>/dev/null || head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')}}"
APP_DIR="/opt/tubeforge-voice"
mkdir -p "$APP_DIR"
cp -f "$(cd "$(dirname "$0")" && pwd)/voice_server.py" "$APP_DIR/voice_server.py" 2>/dev/null \
  || cp -f voice_server.py "$APP_DIR/voice_server.py" 2>/dev/null || true
[[ -f "$APP_DIR/voice_server.py" ]] || { echo "voice_server.py unpack failed"; exit 1; }

export UV_PYTHON_INSTALL_DIR="$APP_DIR/pythons"
export UV_CACHE_DIR="$APP_DIR/.uvcache"

echo "==> [1/5] static ffmpeg (optional, skipped on failure)"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64) FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
  x86_64)  FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
  *)       FFURL="" ;;
esac
if [[ -n "$FFURL" ]] && ! command -v ffmpeg >/dev/null; then
  T="$(mktemp -d)"
  if curl -sSL --max-time 120 "$FFURL" -o "$T/ff.tar.xz" \
     && tar -xJf "$T/ff.tar.xz" -C "$T" \
     && install -m 0755 "$T"/ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg \
     && install -m 0755 "$T"/ffmpeg-*-static/ffprobe /usr/local/bin/ffprobe; then
    echo "    ffmpeg installed"
  else
    echo "    ffmpeg skipped (not required by the voice server)"
  fi
  rm -rf "$T"
fi

echo "==> [2/5] uv + managed Python 3.11 (no dnf needed)"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UVBIN="$(find /root /home -maxdepth 3 -type f -name uv 2>/dev/null | head -1)"
  [[ -n "$UVBIN" ]] && install -m 0755 "$UVBIN" /usr/local/bin/uv
fi
command -v uv >/dev/null || { echo "uv installation failed"; exit 1; }
uv venv --python 3.11 "$APP_DIR/.venv"

echo "==> [3/5] installing torch + Chatterbox (few minutes, ~2 GB)"
uv pip install --python "$APP_DIR/.venv/bin/python" "torch==2.6.0" "torchaudio==2.6.0"
uv pip install --python "$APP_DIR/.venv/bin/python" chatterbox-tts fastapi "uvicorn[standard]"

echo "==> [4/5] voice.env + systemd service"
cat > "$APP_DIR/voice.env" <<EOF
VOICE_KEY=$KEY
VOICE_PORT=$PORT
EOF
chmod 600 "$APP_DIR/voice.env"

cat > /etc/systemd/system/tubeforge-voice.service <<EOF
[Unit]
Description=TubeForge voice server (Chatterbox, self-hosted)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$APP_DIR/voice.env
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python $APP_DIR/voice_server.py --host 0.0.0.0
Restart=always
RestartSec=5
Environment=OMP_NUM_THREADS=4

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now tubeforge-voice.service

echo "==> [5/5] opening port $PORT in the local firewall"
iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
iptables-save > /etc/sysconfig/iptables 2>/dev/null || true

PUBLIC_IP="$(curl -s --max-time 10 https://api.ipify.org || echo '<your-vm-public-ip>')"
cat <<EOF

====================================================================
  Voice server installing/starting in the background.

  ONE CONSOLE STEP LEFT (cannot be done from this shell):
    OCI Console -> Networking -> Virtual cloud networks -> your VCN ->
    Security Lists -> Default Security List -> Add Ingress Rules:
      Source CIDR:  0.0.0.0/0
      IP Protocol:  TCP
      Destination port range:  $PORT

  Then in TubeForge -> Settings -> AI Providers -> Voiceover:
    Provider : My Machine (self-hosted)
    Base URL : http://$PUBLIC_IP:$PORT
    API key  : $KEY

  Check status:    systemctl status tubeforge-voice
  Live logs:       journalctl -u tubeforge-voice -f
  First start downloads the ~1.5 GB Chatterbox model - give it 2-5 min,
  then:  curl http://localhost:$PORT/health   ->  {"ok": true, ...}
====================================================================
EOF
'''

delim = "TUBEFORGE_VOICE_PY_EOF_9x7"
assert delim not in voice, "delimiter collision!"

header = (
    "#!/usr/bin/env bash\n"
    "# TubeForge voice server - ALL-IN-ONE installer for ORACLE LINUX (also any RHEL-family).\n"
    "# No dnf/apt needed: uv-managed Python 3.11 + static ffmpeg. ARM64 and x86_64.\n"
    "#\n"
    "# Usage (as root, e.g. via OCI Run command):\n"
    "#   bash oracle-install-ol.sh --key my-secret-phrase\n"
    "\n"
    'DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    'echo "==> unpacking embedded voice_server.py into $DIR"\n'
    'cat > "$DIR/voice_server.py" <<\'' + delim + "'\n"
)

script = header + voice + delim + "\n" + body.lstrip("\n")
out.write_text(script)
print(f"wrote {out} ({out.stat().st_size} bytes)")
