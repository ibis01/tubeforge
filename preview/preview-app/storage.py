"""
Voice profile storage — tracks named speaker reference audio files.

Stored on the persistent volume so cloned voices survive container restarts.
Format: data/voice_profiles/<name>.wav (or .mp3)
        data/voice_profiles/.registry.json   (name -> filename mapping)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


class VoiceProfileStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.registry_file = self.root / ".registry.json"

    # ------------------------------------------------------------------ #
    def _load(self) -> dict[str, str]:
        if not self.registry_file.is_file():
            return {}
        try:
            return json.loads(self.registry_file.read_text())
        except json.JSONDecodeError:
            return {}

    def _save(self, data: dict[str, str]) -> None:
        self.registry_file.write_text(json.dumps(data, indent=2))

    # ------------------------------------------------------------------ #
    def register(self, name: str, filename: str) -> None:
        data = self._load()
        data[name] = filename
        self._save(data)

    def path_for(self, name: str) -> Optional[Path]:
        data = self._load()
        if name not in data:
            return None
        p = self.root / data[name]
        return p if p.is_file() else None

    def exists(self, name: str) -> bool:
        return self.path_for(name) is not None

    def list_all(self) -> list[dict]:
        data = self._load()
        return [
            {"name": n, "file": f, "size_bytes": (self.root / f).stat().st_size}
            for n, f in sorted(data.items())
            if (self.root / f).is_file()
        ]

    def delete(self, name: str) -> bool:
        data = self._load()
        if name not in data:
            return False
        p = self.root / data[name]
        if p.is_file():
            p.unlink()
        del data[name]
        self._save(data)
        return True
