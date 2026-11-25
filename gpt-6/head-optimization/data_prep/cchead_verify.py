"""Verify local Cchead v10 subsets against their official member index."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import argparse
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import zlib

from PIL import Image


def check_file(work):
    raw, item, published = work
    path = raw / item["path"]
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if len(data) != item["size"] or zlib.crc32(data) != item["crc32"] or digest != published["sha256"]:
        raise ValueError(f"Integrity mismatch: {path}")
    if item["kind"] == "image":
        with Image.open(BytesIO(data)) as image:
            image.load()
            if image.format != "JPEG" or image.size != (1920, 1080):
                raise ValueError(f"Unexpected image format or size: {path}")
        return digest
    if item["kind"] != "label":
        return None
    labels = []
    malformed = 0
    outside = 0
    clipped = 0
    for line in data.decode("utf-8-sig").splitlines():
        cells = line.split()
        if not cells:
            continue
        try:
            cls, track_id, *coords = cells
            x, y, w, h = map(float, coords)
            if int(cls) != 0 or int(track_id) < 0 or not all(map(math.isfinite, (x, y, w, h))) or not 0 < w <= 1 or not 0 < h <= 1:
                raise ValueError("Invalid label")
            track_id = int(track_id)
        except ValueError:
            malformed += 1
            continue
        outside += not (0 <= x <= 1 and 0 <= y <= 1)
        clipped += not (0 <= x - w/2 and x + w/2 <= 1 and 0 <= y - h/2 and y + h/2 <= 1)
        labels.append((track_id, x, y, w, h))
    return {
        "head_count": len(labels) + malformed,
        "invalid_rows": malformed,
        "outside_centers": outside,
        "clipped_boxes": clipped,
        "duplicate_ids": len(labels) - len({row[0] for row in labels}),
        "duplicate_boxes": len(labels) - len({row[1:] for row in labels}),
    }


def load_index(local):
    index = local / "files_sha256.jsonl"
    manifest = local / "manifest.json"
    summary = json.loads((local / "summary.json").read_text(encoding="utf-8"))
    for key, path in (("manifest_sha256", manifest), ("file_index_sha256", index)):
        if hashlib.sha256(path.read_bytes()).hexdigest() != summary[key]:
            raise ValueError(f"Saved manifest checksum mismatch: {path}")
    published = {}
    for line in index.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row["path"] in published:
            raise ValueError(f"Duplicate manifest record: {row['path']}")
        published[row["path"]] = row
    members = json.loads(manifest.read_text(encoding="utf-8"))["members"]
    if {m["path"] for m in members} != published.keys() or len(members) != len(published) or len(members) != summary["files"]:
        raise ValueError("Kaggle member manifest and local index differ")
    return members, published, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cchead", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    local = args.cchead / "gpt-6"
    raw = args.cchead / "raw"
    members, published, summary = load_index(local)
    indexed = set(published)
    existing = {f.relative_to(raw).as_posix() for f in raw.rglob("*") if f.is_file()}
    if indexed != existing:
        raise ValueError(f"Local file list differs; missing {len(indexed - existing)}, extra {len(existing - indexed)}")
    frames = {}
    hashes = Counter()
    print(f"Cchead verify {len(members)} members", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        work = ((raw, item, published[item["path"]]) for item in members)
        for number, (item, result) in enumerate(zip(members, pool.map(check_file, work)), 1):
            kind = item["kind"]
            if kind in ("image", "label"):
                key = item["group"], item["frame"]
                row = frames.setdefault(key, {"sequence": key[0], "frame": key[1]})
                row[kind + "_path"] = item["path"]
                if kind == "image":
                    row["image_sha256"] = result
                    hashes[result] += 1
                else:
                    row.update(result)
            if number % 3000 == 0 or number == len(members):
                print(f"Cchead verified {number}/{len(members)}", flush=True)
    for group, info in summary["sequences"].items():
        group_rows = [row for (seq, frame), row in frames.items() if seq == group]
        expected = info["image_frames"]
        if len(group_rows) != expected or {row["frame"] for row in group_rows} != set(range(expected)):
            raise ValueError(f"Frame sequence is incomplete: {group}")
    if any("head_count" not in row or "image_sha256" not in row for row in frames.values()):
        raise ValueError("Image and label inventories differ")
    for row in frames.values():
        row["byte_duplicate"] = hashes[row["image_sha256"]] > 1
    result = {
        "files": len(members), "bytes": sum(i["size"] for i in members),
        "image_label_pairs": len(frames), "manifest_sha256": summary["manifest_sha256"],
        "checked_sha_crc_and_jpeg": True, "sequences": summary["sequences"],
        "frames": sorted(frames.values(), key=lambda x: (x["sequence"], x["frame"])),
    }
    temporary = args.output.with_suffix(".json.part")
    temporary.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(args.output)


if __name__ == "__main__":
    main()
