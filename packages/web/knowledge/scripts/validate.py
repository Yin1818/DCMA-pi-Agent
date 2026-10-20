#!/usr/bin/env python3
"""Validate the generated JSONL index before it is exposed to an agent."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


REQUIRED = {"id", "source_id", "source_file", "locator", "title", "kind", "trust", "text", "agent_use"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, default=Path(__file__).parents[1] / "data" / "knowledge.jsonl")
    parser.add_argument("--root", type=Path, default=Path(__file__).parents[1] / "sources")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).parents[1] / "data" / "manifest.json")
    args = parser.parse_args()
    seen = set()
    sources = Counter()
    source_files = set()
    total = 0
    errors: list[str] = []
    for line_no, raw in enumerate(args.index.read_text(encoding="utf-8").splitlines(), 1):
        try:
            item = json.loads(raw)
        except json.JSONDecodeError as exc:
            errors.append(f"line {line_no}: invalid JSON ({exc})")
            continue
        total += 1
        missing = REQUIRED - item.keys()
        if missing:
            errors.append(f"line {line_no}: missing {sorted(missing)}")
        if item.get("id") in seen:
            errors.append(f"line {line_no}: duplicate id {item.get('id')}")
        seen.add(item.get("id"))
        if not str(item.get("text", "")).strip():
            errors.append(f"line {line_no}: empty text")
        if not isinstance(item.get("codes"), list) or not all(isinstance(code, str) for code in item.get("codes", [])):
            errors.append(f"line {line_no}: invalid codes")
        if item.get("page") is not None and not isinstance(item.get("page"), int):
            errors.append(f"line {line_no}: invalid page")
        if isinstance(item.get("source_file"), str):
            source_files.add(item["source_file"])
        sources[item.get("source_id", "")] += 1
    for source_file in sorted(source_files):
        if not (args.root / source_file).is_file():
            errors.append(f"missing source file: {source_file}")
    if args.manifest.exists():
        try:
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict):
                raise TypeError("manifest root must be an object")
            if manifest.get("record_count") != total:
                errors.append("manifest record_count does not match index")
            if not isinstance(manifest.get("sources"), list):
                raise TypeError("manifest sources must be a list")
            manifest_sources = set()
            for source in manifest["sources"]:
                if not isinstance(source, dict) or not isinstance(source.get("file"), str):
                    errors.append("manifest source entry is invalid")
                    continue
                manifest_sources.add(source["file"])
                source_path = args.root / source["file"]
                if not source_path.is_file():
                    errors.append(f"manifest source is missing: {source['file']}")
                    continue
                digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
                if digest != source.get("sha256") or source_path.stat().st_size != source.get("bytes"):
                    errors.append(f"manifest source fingerprint does not match: {source['file']}")
            if manifest_sources != source_files:
                errors.append("manifest sources do not match indexed sources")
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            errors.append(f"invalid manifest: {exc}")
    else:
        errors.append(f"manifest is missing: {args.manifest}")
    if errors:
        for error in errors:
            print(f"ERROR {error}")
        raise SystemExit(1)
    print(json.dumps({"ok": True, "records": total, "by_source": sources}, ensure_ascii=False))


if __name__ == "__main__":
    main()
