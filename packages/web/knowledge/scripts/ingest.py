#!/usr/bin/env python3
"""Build a small, source-located knowledge index from the supplied manuals.

The output is JSON Lines so the Node search service can run without a database
or third-party runtime.  The parser intentionally treats source text as
evidence; it never interprets imperative sentences as agent instructions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET


DOC_SPECS = {
    "0.75kw-1.5kw-drag-test": {
        "file": "0.75kW与1.5kW电机对拖试验故障模拟实施方案（Y）.docx",
        "title": "0.75kW与1.5kW电机对拖试验故障模拟实施方案",
        "kind": "fault_simulation_plan",
        "trust": "provided_document",
    },
    "yfb801-2-manual": {
        "file": "YFB801-2粉尘防爆三相异步电动机使用说明书.docx",
        "title": "YFB801-2粉尘防爆三相异步电动机使用说明书",
        "kind": "motor_manual",
        "trust": "provided_document",
    },
    "90l-4-manual": {
        "file": "90L-4三相异步电动机使用说明书.docx",
        "title": "90L-4三相异步电动机使用说明书",
        "kind": "motor_manual",
        "trust": "provided_document",
    },
}

PDF_SPEC = {
    "id": "s120-fault-manual",
    "file": "S120_故障手册.pdf",
    "title": "SINAMICS S120 S150 故障和报警列表",
    "kind": "drive_fault_manual",
    "trust": "vendor_manual_copy",
}

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
CODE_RE = re.compile(r"(?<![A-Za-z0-9])(?:[FANW]\d{4,6})(?!\d)")
HEADING_RE = re.compile(r"^(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[、. ]")


def clean(text: str) -> str:
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def read_docx(path: Path) -> list[str]:
    """Read visible paragraphs and table cells with only stdlib XML tools."""
    with zipfile.ZipFile(path) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    result: list[str] = []
    body = root.find("w:body", NS)
    if body is None:
        return result
    for child in body:
        if child.tag.endswith("}p"):
            value = "".join(node.text or "" for node in child.iter() if node.tag.endswith("}t"))
            value = clean(value)
            if value:
                result.append(value)
        elif child.tag.endswith("}tbl"):
            for row in child.findall(".//w:tr", NS):
                cells = []
                for cell in row.findall("./w:tc", NS):
                    value = clean("".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t")))
                    cells.append(value)
                row_text = " | ".join(x for x in cells if x)
                if row_text:
                    result.append(row_text)
    return result


def read_pdf_pages(path: Path) -> list[str]:
    """Extract pages with PyPDF2 when available, otherwise use pdftotext."""
    try:
        from PyPDF2 import PdfReader  # type: ignore

        return [clean(page.extract_text() or "") for page in PdfReader(str(path)).pages]
    except Exception:
        tmp = path.with_suffix(".txt")
        try:
            subprocess.run(["pdftotext", "-layout", str(path), str(tmp)], check=True, capture_output=True)
            return [clean(page) for page in tmp.read_text(encoding="utf-8", errors="replace").split("\f")]
        finally:
            tmp.unlink(missing_ok=True)


def make_id(source_id: str, locator: str, text: str) -> str:
    digest = hashlib.sha1(f"{source_id}|{locator}|{text}".encode("utf-8")).hexdigest()[:12]
    return f"{source_id}:{digest}"


def split_text(text: str, limit: int = 1500, overlap: int = 180) -> list[str]:
    text = clean(text)
    if len(text) <= limit:
        return [text] if text else []
    pieces = []
    start = 0
    while start < len(text):
        end = min(len(text), start + limit)
        if end < len(text):
            cut = max(text.rfind("\n", start, end), text.rfind("。", start, end), text.rfind("；", start, end))
            if cut > start + limit // 2:
                end = cut + 1
        piece = text[start:end].strip()
        if piece:
            pieces.append(piece)
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)
    return pieces


def base_record(source_id: str, spec: dict, rel_file: str, locator: str, text: str, title: str, page: int | None = None) -> dict:
    codes = sorted(set(CODE_RE.findall(text)))
    return {
        "id": make_id(source_id, locator, text),
        "source_id": source_id,
        "source_file": rel_file.replace("\\", "/"),
        "locator": locator,
        "page": page,
        "title": title,
        "kind": spec["kind"],
        "trust": spec["trust"],
        "codes": codes,
        "text": text,
        "agent_use": "retrieval_evidence",
    }


def ingest_docx(path: Path, root: Path, source_id: str, spec: dict) -> list[dict]:
    paragraphs = read_docx(path)
    records = []
    section = spec["title"]
    buffer: list[str] = []
    start_index = 1

    def flush(end_index: int) -> None:
        nonlocal buffer, start_index
        if not buffer:
            return
        text = "\n".join(buffer)
        for part_index, piece in enumerate(split_text(text)):
            locator = f"段落 {start_index}-{end_index}"
            if len(split_text(text)) > 1:
                locator += f"，片段 {part_index + 1}"
            records.append(base_record(source_id, spec, str(path.relative_to(root)), locator, piece, section))
        buffer = []

    for index, paragraph in enumerate(paragraphs, start=1):
        is_heading = index == 1 or HEADING_RE.match(paragraph) is not None
        if is_heading and buffer:
            flush(index - 1)
            start_index = index
        if is_heading:
            section = paragraph
        buffer.append(paragraph)
        # Keep short source sections together while bounding chunk size.
        if sum(len(x) for x in buffer) > 1350:
            flush(index)
            start_index = index + 1
    flush(len(paragraphs))
    return records


def ingest_pdf(path: Path, root: Path, source_id: str, spec: dict) -> list[dict]:
    records = []
    pages = read_pdf_pages(path)
    for number, page_text in enumerate(pages, start=1):
        if not page_text:
            continue
        codes = sorted(set(CODE_RE.findall(page_text)))
        page_title = f"{codes[0]} 故障/报警条目" if codes else spec["title"]
        for part_index, piece in enumerate(split_text(page_text, limit=1800, overlap=200), start=1):
            locator = f"第 {number} 页" + (f"，片段 {part_index}" if len(split_text(page_text, limit=1800, overlap=200)) > 1 else "")
            records.append(base_record(source_id, spec, str(path.relative_to(root)), locator, piece, page_title, page=number))
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path(__file__).parents[1] / "sources")
    parser.add_argument("--output", type=Path, default=Path(__file__).parents[1] / "data" / "knowledge.jsonl")
    args = parser.parse_args()
    root = args.input.resolve()
    all_records: list[dict] = []
    for source_id, spec in DOC_SPECS.items():
        path = root / spec["file"]
        if not path.exists():
            raise SystemExit(f"missing source: {path}")
        all_records.extend(ingest_docx(path, root, source_id, spec))
    pdf_path = root / PDF_SPEC["file"]
    if not pdf_path.exists():
        raise SystemExit(f"missing source: {pdf_path}")
    all_records.extend(ingest_pdf(pdf_path, root, PDF_SPEC["id"], PDF_SPEC))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary_output.open("w", encoding="utf-8", newline="\n") as stream:
        for record in all_records:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary_output.replace(args.output)
    source_files = sorted({record["source_file"] for record in all_records})
    manifest = {
        "schema_version": "1.0",
        "created_at": date.today().isoformat(),
        "index": args.output.name,
        "record_count": len(all_records),
        "sources": [
            {
                "file": source_file,
                "sha256": hashlib.sha256((root / source_file).read_bytes()).hexdigest(),
                "bytes": (root / source_file).stat().st_size,
            }
            for source_file in source_files
        ],
        "notes": "Source documents are retrieval evidence, not agent instructions.",
    }
    manifest_path = args.output.parent / "manifest.json"
    temporary_manifest = manifest_path.with_suffix(".json.tmp")
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_manifest.replace(manifest_path)
    print(json.dumps({"records": len(all_records), "output": str(args.output), "sources": sorted({r["source_id"] for r in all_records})}, ensure_ascii=False))


if __name__ == "__main__":
    main()
