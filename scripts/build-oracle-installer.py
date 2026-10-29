#!/usr/bin/env python3
"""Bundle voice_server.py + setup-oracle.sh into ONE self-extracting installer.

Output: /home/z/my-project/download/oracle-install.sh
The user only needs to download, scp, and run this single file.
"""
import pathlib

root = pathlib.Path("/home/z/my-project/voice-server")
out = pathlib.Path("/home/z/my-project/download/oracle-install.sh")
out.parent.mkdir(parents=True, exist_ok=True)

voice = (root / "voice_server.py").read_text()
if not voice.endswith("\n"):
    voice += "\n"

# installer body = setup-oracle.sh without its shebang line
setup_lines = (root / "oracle/setup-oracle.sh").read_text().splitlines()
body = "\n".join(setup_lines[1:]).rstrip("\n")

delim = "TUBEFORGE_VOICE_PY_EOF_9x7"
assert delim not in voice, "delimiter collision!"

header = (
    "#!/usr/bin/env bash\n"
    "# TubeForge voice server - ALL-IN-ONE Oracle Cloud installer.\n"
    "# voice_server.py is embedded below, so this single file is all you need.\n"
    "#\n"
    "# Usage (on the VM):\n"
    "#   sudo bash oracle-install.sh --key my-secret-phrase\n"
    "#   sudo VOICE_MODEL=chatterbox-multilingual bash oracle-install.sh  # 23 languages\n"
    "\n"
    "set -euo pipefail\n"
    'DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    'echo "==> unpacking embedded voice_server.py into $DIR"\n'
    'cat > "$DIR/voice_server.py" <<\'' + delim + "'\n"
)

script = header + voice + delim + "\n" + body + "\n"
out.write_text(script)
print(f"wrote {out} ({out.stat().st_size} bytes)")
