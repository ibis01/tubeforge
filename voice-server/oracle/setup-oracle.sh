#!/usr/bin/env bash
# ── TubeForge Voice Server — Oracle Cloud installer (Ubuntu + Oracle Linux) ──
#
# Target: an Oracle Cloud Always Free Ampere A1 VM running either
#   - Ubuntu 22.04/24.04 (apt), or
#   - Oracle Linux 8/9 (dnf/yum) — username is `opc` there, and the VM firewall
#     is firewalld instead of iptables-persistent. Both handled automatically.
#
# Usage (on the VM, after uploading voice_server.py next to this file):
#   sudo bash setup-oracle.sh --key my-secret-phrase
#   sudo bash setup-oracle.sh --key my-secret --port 8931
#   sudo VOICE_MODEL=chatterbox-multilingual bash setup-oracle.sh   # 23 languages
#
# What it does:
#   1. installs system packages (distro-aware)
#   2. creates /opt/tubeforge-voice with a venv, CPU torch, chatterbox-tts
#      (ARM64 note: the PyTorch CPU index has no aarch64 wheels, so we install
#       torch from PyPI there — PyPI's ARM64 torch builds are CPU-only anyway)
#   3. writes /opt/tubeforge-voice/voice.env (key + port, root-only readable)
#   4. installs a systemd service that auto-starts on boot and auto-restarts
#      on crashes, then opens the port in the VM's local firewall
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
  echo "Please run with sudo (needs package manager, /opt writes and firewall)."; exit 1
fi
if [[ ! -f "$(dirname "$0")/voice_server.py" ]]; then
  echo "voice_server.py not found next to setup-oracle.sh — upload both files to the VM first."; exit 1
fi

# A random key if none given (printed at the end, saved in voice.env)
KEY="${KEY:-${VOICE_KEY:-$(openssl rand -hex 16)}}"

APP_DIR="/opt/tubeforge-voice"

# ── distro detection ────────────────────────────────────────────────────────
PY="python3"
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
else
  echo "No supported package manager found (need apt-get, dnf or yum)."; exit 1
fi
echo "==> detected package manager: $PKG"

echo "==> [1/5] system packages"
export DEBIAN_FRONTEND=noninteractive
if [[ "$PKG" == "apt" ]]; then
  apt-get update -qq
  apt-get install -y -qq python3-venv python3-pip ffmpeg curl openssl \
    $(apt-cache show iptables-persistent >/dev/null 2>&1 && echo iptables-persistent || true) \
    >/dev/null
else
  # Oracle Linux / RHEL family. ffmpeg is not required by the voice server,
  # so we keep this lean; gcc as insurance for any source builds.
  "$PKG" install -y -q python3 python3-pip gcc gcc-c++ make curl openssl tar gzip
  # torch 2.6 needs python >= 3.9 (Oracle Linux 8's default python3 is 3.6)
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)' 2>/dev/null; then
    echo "    python3 is too old — enabling a newer python module ..."
    for MOD in python3.12 python3.11 python39; do
      if "$PKG" module list 2>/dev/null | grep -q "$MOD"; then
        "$PKG" module enable -y "$MOD" >/dev/null 2>&1 || true
        "$PKG" install -y -q "$MOD" "$MOD-pip" 2>/dev/null || "$PKG" install -y -q "$MOD"
        if [[ "$MOD" == "python39" ]]; then PY="python3.9"; else PY="$MOD"; fi
        echo "    using $PY"
        break
      fi
    done
  fi
fi

echo "==> [2/5] installing voice server into $APP_DIR"
mkdir -p "$APP_DIR"
cp -f "$(dirname "$0")/voice_server.py" "$APP_DIR/voice_server.py"

rm -rf "$APP_DIR/.venv"
if ! "$PY" -m venv "$APP_DIR/.venv" 2>/dev/null; then
  # RHEL images occasionally lack ensurepip — bootstrap pip manually
  "$PY" -m venv --without-pip "$APP_DIR/.venv"
  curl -sS https://bootstrap.pypa.io/get-pip.py | "$APP_DIR/.venv/bin/python" -q
fi
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
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT"/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "    firewalld: port $PORT/tcp opened"
elif command -v iptables >/dev/null 2>&1; then
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  fi
  echo "    iptables: port $PORT opened"
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
