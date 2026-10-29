# TubeForge Voice Server — Oracle Cloud Always Free (24/7, no PC)

Run the voice server on Oracle's **Always Free** Ampere A1 VM: 4 ARM CPUs,
24 GB RAM, up for months without sleep. $0 forever on the Always Free tier —
Chatterbox is MIT-licensed, safe for monetized channels.

This is the strongest of the three hosts:

| host          | always on | speed        | needs card        |
|---------------|-----------|--------------|-------------------|
| your laptop   | only when open | fastest CPU here | no |
| HF Space      | sleeps ~2 days idle | 2-4× slower | no |
| **Oracle VM** | **24/7**  | fast (4 ARM cores) | **only to verify identity** |

## Step 1 — Oracle Cloud signup (~10 min, $0 charged)

1. https://www.oracle.com/cloud/free/ → **Start for free**
2. A credit/debit card is required **only to verify you are human** — Always
   Free resources are never charged. (Set a billing alert anyway:
   Billing → Budgets → alert at $1.)
3. **Home region is permanent** — pick the closest to you (e.g. for West
   Africa: EU Paris or UK London are typically nearest).

## Step 2 — create the VM (~3 min)

1. Console → **Compute → Instances → Create instance**
2. Image: **Ubuntu 22.04** (or 24.04), Shape: **Ampere** →
   **VM.Standard.A1.Flex** → **4 OCPU / 24 GB** (the whole Always Free
   allowance). Add your SSH public key → **Create**.
   - "Out of capacity" error? It's free-tier demand — retry later the same
     day, or try a different availability domain.
3. On the instance page: **Attached VNICs → IPv4 Addresses → Edit →
   Reserved public IP** (keeps the URL stable across reboots).

## Step 3 — open port 8931 in the cloud firewall (console, once)

Networking → **Virtual cloud networks** → your VCN → **Security Lists** →
**Default Security List** → **Add Ingress Rules**:

- Source CIDR: `0.0.0.0/0` · IP Protocol: `TCP` · Destination port: `8931`

## Step 4 — install (2 commands on the VM)

From the folder containing this README (on your PC):

```bash
scp voice_server.py oracle/setup-oracle.sh ubuntu@<VM-PUBLIC-IP>:
ssh ubuntu@<VM-PUBLIC-IP>
sudo bash ~/setup-oracle.sh --key pick-a-secret-phrase
```

The script installs ffmpeg + CPU torch + Chatterbox, registers a
**systemd service** (auto-start on boot, auto-restart on crash), opens the
port locally, and prints your **Base URL** and **API key** at the end.
First start downloads the ~1.5 GB model — after ~2-5 min check:

```bash
curl http://localhost:8931/health     # → {"ok": true, ...}
journalctl -u tubeforge-voice -f      # live logs
```

For 23 languages instead of English: `sudo VOICE_MODEL=chatterbox-multilingual
bash ~/setup-oracle.sh` (or edit `/opt/tubeforge-voice/voice.env`, then
`sudo systemctl restart tubeforge-voice`).

## Step 5 — wire into TubeForge

Settings → AI Providers → Voiceover → **My Machine (self-hosted)**:

- **Base URL** = `http://<VM-PUBLIC-IP>:8931` (printed by the installer)
- **API key** = the `--key` secret you chose

Upload a voice sample on any video → Clone → narrate. Works from your
Vercel deployment with no tunnel and no PC.

## Honest notes

- **Idle reclamation:** Oracle may stop Always Free VMs that stay ~idle for
  a week straight (low CPU + network). Regular rendering keeps it busy; if
  it ever gets stopped, Instances → Start — voices and setup persist.
  A free daily ping to `http://<ip>:8931/health` (cron-job.org) adds cover.
- **HTTP, not HTTPS:** traffic to `http://<ip>:8931` is unencrypted — the
  `VOICE_KEY` protects against strangers, not against network snooping.
  Fine to start; if you later have any domain, put cloudflared on the VM
  for free HTTPS in 5 minutes.
- **RAM use is ~4-6 GB** of your 24 GB — the VM still has room for other
  free-tier projects.
