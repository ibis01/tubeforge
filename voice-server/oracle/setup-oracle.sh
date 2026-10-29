#!/usr/bin/env bash
# ── TubeForge Voice Server — Oracle Cloud Always Free installer ─────────
#
# Target: an Oracle Cloud Always Free Ampere A1 VM running Ubuntu 22.04/24.04
# (ARM64) — but any Ubuntu box works (x86_64 included).
#
# Usage (on the VM, after uploading voice_server.py next to this file):
#   sudo bash setup-oracle.sh --key my-secret-phrase
#   sudo bash setup-oracle.sh --key my-secret --port 8931
#   sudo VOICE_MODEL=chatterbox-multilingual bash setup-oracle.sh   # 23 languages
#
# What it does:
#   1. installs ffmpeg + python venv tooling
#   2. creates /opt/tubeforge-voice with a venv, CPU torch, chatterbox-tts
#      (ARM64 note: the PyTorch CPU index has no aarch64 wheels, so we install
#       torch from PyPI there — PyPI's ARM64 torch builds are CPU-only anyway)
#   3. writes /opt/tubeforge-voice/voice.env (key + port, root-only readable)
#   4. installs a systemd service that auto-starts on boot and auto-restarts
#      on crashes, then opens the port in the VM's local iptables firewall
#      (the cloud-side Security List rule is a console step — see README)
#
# Re-run safe: everything is overwritten in place.

set -euo pipefail

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
  echo "Please run with sudo (needs apt, /opt writes and iptables)."; exit 1
fi
if [[ ! -f "$(dirname "$0")/voice_server.py" ]]; then
  echo "voice_server.py not found next to setup-oracle.sh — upload both files to the VM first."; exit 1
fi

# A random key if none given (printed at the end, saved in voice.env)
KEY="${KEY:-${VOICE_KEY:-$(openssl rand -hex 16)}}"

APP_DIR="/opt/tubeforge-voice"

echo "==> [1/5] system packages (ffmpeg, venv, curl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip ffmpeg curl openssl \
  $(apt-cache show iptables-persistent >/dev/null 2>&1 && echo iptables-persistent || true) \
  >/dev/null

echo "==> [2/5] installing voice server into $APP_DIR"
mkdir -p "$APP_DIR"
cp -f "$(dirname "$0")/voice_server.py" "$APP_DIR/voice_server.py"

python3 -m venv "$APP_DIR/.venv"
PIP="$APP_DIR/.venv/bin/pip"
"$PIP" install --upgrade pip -q

ARCH="$(uname -m)"
echo "    torch ($ARCH, CPU) ..."
if [[ "$ARCH" == "aarch64" ]]; then
  # PyPI aarch64 torch wheels are CPU-only builds
  "$PIP" install "torch==2.6.0" "torchaudio==2.6.0" -q
else
  "$PIP" install "torch==2.6.0" "torchaudio==2.6.0" \
    --index-url https://download.pytorch.org/whl/cpu -q \
    || "$PIP" install "torch==2.6.0" "torchaudio==2.6.0" -q
fi
echo "    chatterbox-tts + API deps (this can take a few minutes) ..."
"$PIP" install chatterbox-tts fastapi "uvicorn[standard]" -q

echo "==> [3/5] writing $APP_DIR/voice.env"
cat > "$APP_DIR/voice.env" <<EOF
VOICE_KEY=$KEY
VOICE_PORT=$PORT
EOF
chmod 600 "$APP_DIR/voice.env"

echo "==> [4/5] systemd service (starts on boot, restarts on crash)"
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
# Always Free VMs are modest — keep torch threads sane and logs light
Environment=OMP_NUM_THREADS=4

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now tubeforge-voice.service

echo "==> [5/5] opening port $PORT in the local firewall"
if command -v iptables >/dev/null 2>&1; then
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  fi
fi

PUBLIC_IP="$(curl -s --max-time 10 https://api.ipify.org || echo '<your-vm-public-ip>')"
cat <<EOF

════════════════════════════════════════════════════════════════════
  Voice server installing/starting in the background.

  ⚠ ONE CONSOLE STEP LEFT (cannot be done from this shell):
    OCI Console → Networking → Virtual cloud networks → your VCN →
    Security Lists → Default Security List → Add Ingress Rules:
      Source CIDR:  0.0.0.0/0
      IP Protocol:  TCP
      Destination port range:  $PORT

  Then in TubeForge → Settings → AI Providers → Voiceover:
    Provider : My Machine (self-hosted)
    Base URL : http://$PUBLIC_IP:$PORT
    API key  : $KEY

  Check status:    systemctl status tubeforge-voice
  Live logs:       journalctl -u tubeforge-voice -f
  First start downloads the ~1.5 GB Chatterbox model — give it 2-5 min,
  then:  curl http://localhost:$PORT/health   →  {"ok": true, ...}
════════════════════════════════════════════════════════════════════
EOF
