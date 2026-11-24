"""Audit and extract the publisher's RGBT-CC-CVPR2021 archive."""

from collections import Counter, defaultdict
import argparse
import csv
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import re
import shutil
import stat
import zipfile

from PIL import Image


SPLITS = {"train": 1030, "val": 200, "test": 800}
LIGHT_COUNTS = {"bright": 1013, "dark": 1017}
MEMBER = re.compile(r"(train|val|test)/([0-9]+)_(RGB\.jpg|T\.jpg|GT\.json)")
ITEMS = {"RGB.jpg", "T.jpg", "GT.json"}


def write_csv(path, rows):
    tmp = path.with_suffix(".csv.part")
    with tmp.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(path)


def entries(archive):
    files = []
    sample_files = defaultdict(dict)
    lists = set()
    seen = set()
    for info in archive.infolist():
        name = info.filename
        if stat.S_ISLNK(info.external_attr >> 16) or name.casefold() in seen:
            raise ValueError(f"Unsafe or duplicate ZIP path: {name}")
        seen.add(name.casefold())
        if info.is_dir() and name in {split + "/" for split in SPLITS}:
            continue
        match = MEMBER.fullmatch(name)
        if match:
            split, identifier, kind = match.groups()
            sample_files[(split, identifier)][kind] = name
        elif name in {"bright_list.json", "dark_list.json"}:
            lists.add(name)
        else:
            raise ValueError(f"Unexpected ZIP member: {name}")
        files.append(info)
    if lists != {"bright_list.json", "dark_list.json"}:
        raise ValueError("Illumination manifests are incomplete")
    if Counter(split for split, _ in sample_files) != SPLITS:
        raise ValueError("Published split sizes differ")
    if any(item.keys() != ITEMS for item in sample_files.values()):
        raise ValueError("Unpaired RGB, thermal or GT files")
    ids = {identifier for _, identifier in sample_files}
    if len(ids) != len(sample_files):
        raise ValueError("Sample IDs appear across multiple splits")
    return files, sample_files, {identifier + "_GT.json" for identifier in ids}


def materialize(archive, files, destination):
    existing = destination.exists()
    stage = destination if existing else destination.with_name(".RGBT-CC.extracting")
    if stage.is_symlink() or not stage.resolve().is_relative_to(destination.parent.resolve()):
        raise ValueError(f"Unexpected extract root: {stage}")
    stage.mkdir(exist_ok=True)
    inventory = []
    for index, info in enumerate(files, 1):
        name = info.filename
        path = stage / name
        if not path.resolve().is_relative_to(stage.resolve()):
            raise ValueError(f"ZIP path escapes the destination: {path}")
        blob = archive.read(info)
        if path.is_file():
            if path.read_bytes() != blob:
                raise ValueError(f"Existing extracted file differs: {path}")
        elif existing:
            raise ValueError(f"Existing extracted directory is missing {name}")
        else:
            path.parent.mkdir(exist_ok=True)
            partial = path.with_name(path.name + ".audit-part")
            if partial.is_symlink():
                raise ValueError(f"Unexpected staging link: {partial}")
            with partial.open("wb") as stream:
                stream.write(blob)
            partial.rename(path)
        inventory.append({
            "path": name, "bytes": info.file_size, "archive_crc32": f"{info.CRC:08x}",
            "sha256": hashlib.sha256(blob).hexdigest(),
        })
        if index % 1500 == 0 or index == len(files):
            print(f"RGBT-CC extracted/compared {index}/{len(files)}", flush=True)
    present = {path.relative_to(stage).as_posix() for path in stage.rglob("*") if path.is_file()}
    if present != {item["path"] for item in inventory}:
        raise ValueError("Extracted file inventory differs from archive")
    if not existing:
        stage.rename(destination)
    return inventory


def inspect_image(path):
    with Image.open(path) as im:
        im.load()
        if im.format != "JPEG":
            raise ValueError(f"Image format differs: {path}")
        return im.size, im.getexif().get(274, 1)


def inspect_points(raw, relative_path):
    value = json.loads((raw / relative_path).read_text(encoding="utf-8-sig"))
    points = value["points"]
    if not isinstance(points, list):
        raise ValueError(f"Invalid GT schema: {relative_path}")
    valid = []
    invalid = 0
    out_of_bounds = 0
    for point in points:
        if not isinstance(point, list) or len(point) != 2 or not all(type(v) in (int, float) and math.isfinite(v) for v in point):
            invalid += 1
            continue
        x, y = point
        out_of_bounds += not (0 <= x < 640 and 0 <= y < 480)
        valid.append((x, y))
    return len(points), invalid, out_of_bounds, len(valid) - len(set(valid))


def audit(root, output):
    original = root / "archives" / "RGBT-CC-CVPR2021.zip"
    raw = root / "raw" / "RGBT-CC"
    with original.open("rb") as stream:
        archive_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    with zipfile.ZipFile(original) as archive:
        files, sample_files, expected_gt = entries(archive)
        expanded = sum(info.file_size for info in files)
        if not raw.exists() and shutil.disk_usage(raw.parent).free < expanded + 1024**2:
            raise RuntimeError("Insufficient space for unpacking")
        print(f"RGBT-CC archive bytes={original.stat().st_size}, expanded={expanded}, sha256={archive_sha}", flush=True)
        if bad := archive.testzip():
            raise ValueError(f"ZIP CRC failure: {bad}")
        print("RGBT-CC archive CRC passed", flush=True)
        inventory = materialize(archive, files, raw)

    tagged = {}
    for light, count in LIGHT_COUNTS.items():
        names = json.loads((raw / (light + "_list.json")).read_text(encoding="utf-8"))
        if not isinstance(names, list) or len(names) != count or len(set(names)) != count or tagged.keys() & set(names):
            raise ValueError(f"Invalid or overlapping lighting list: {light}")
        tagged.update({name: light for name in names})
    if set(tagged) != expected_gt:
        raise ValueError("Illumination list and published GT files differ")

    hashes = {row["path"]: row["sha256"] for row in inventory}
    rgb_counts = Counter(hashes[paths["RGB.jpg"]] for paths in sample_files.values())
    thermal_counts = Counter(hashes[paths["T.jpg"]] for paths in sample_files.values())
    rows = []
    for idx, ((split, identifier), paths) in enumerate(sorted(sample_files.items()), 1):
        rgb, thermal, label = (paths[ext] for ext in ("RGB.jpg", "T.jpg", "GT.json"))
        rgb_size, rgb_orientation = inspect_image(raw / rgb)
        t_size, t_orientation = inspect_image(raw / thermal)
        if rgb_size != (640, 480):
            raise ValueError(f"Unexpected RGB dimensions or orientation: {rgb}")
        count, invalid, outside, duplicate = inspect_points(raw, label)
        light = tagged[Path(label).name]
        band = "low" if count < 30 else "medium" if count < 90 else "high"
        rows.append({
            "sample_id": identifier, "official_split": split, "illumination": light,
            "capture_period_verified": False, "source_video_id": "", "camera_id": "",
            "rgb_path": rgb, "thermal_path": thermal, "label_path": label,
            "width": rgb_size[0], "height": rgb_size[1], "rgb_exif_orientation": rgb_orientation,
            "thermal_width": t_size[0],
            "thermal_height": t_size[1], "thermal_exif_orientation": t_orientation,
            "thermal_native_size_matches_rgb": t_size == rgb_size,
            "point_count": count, "count_band": band,
            "invalid_points": invalid, "out_of_bounds_points": outside, "exact_duplicate_points": duplicate,
            "rgb_sha256": hashes[rgb], "thermal_sha256": hashes[thermal],
            "byte_duplicate_rgb": rgb_counts[hashes[rgb]] > 1,
            "byte_duplicate_thermal": thermal_counts[hashes[thermal]] > 1,
        })
        if idx % 500 == 0 or idx == len(sample_files):
            print(f"RGBT-CC decoded and audited {idx}/{len(sample_files)} pairs", flush=True)
    write_csv(output / "rgbt_file_inventory.csv", inventory)
    write_csv(output / "rgbt_image_manifest.csv", rows)
    write_csv(output / "rgbt_dark_split.csv", [row for row in rows if row["illumination"] == "dark"])
    summary = {
        "archive": original.name, "archive_bytes": original.stat().st_size, "archive_sha256": archive_sha,
        "expanded_bytes": expanded, "archive_crc": "pass", "file_count": len(inventory),
        "decoded_images": len(rows) * 2, "pairs": len(rows), "official_splits": SPLITS,
        "light_counts": LIGHT_COUNTS, "point_rows": sum(row["point_count"] for row in rows),
        "invalid_points": sum(row["invalid_points"] for row in rows),
        "out_of_bounds_points": sum(row["out_of_bounds_points"] for row in rows),
        "duplicate_points": sum(row["exact_duplicate_points"] for row in rows),
        "duplicate_rgb_sets": sum(c > 1 for c in rgb_counts.values()),
        "duplicate_thermal_sets": sum(c > 1 for c in thermal_counts.values()),
        "duplicate_rgb_sets_across_splits": sum(
            len({row["official_split"] for row in rows if row["rgb_sha256"] == digest}) > 1
            for digest, count in rgb_counts.items() if count > 1
        ),
        "rgb_non_default_exif_orientation": sum(row["rgb_exif_orientation"] != 1 for row in rows),
        "rgb_exif_orientations": dict(Counter(row["rgb_exif_orientation"] for row in rows)),
        "thermal_native_dimension_mismatches": sum(not row["thermal_native_size_matches_rgb"] for row in rows),
        "thermal_mismatch_exif_orientation": dict(Counter(
            row["thermal_exif_orientation"] for row in rows if not row["thermal_native_size_matches_rgb"]
        )),
        "dataset_license": "unverified",
    }
    pending = output / "rgbt_audit_summary.json.part"
    pending.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    pending.replace(output / "rgbt_audit_summary.json")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_root", type=Path)
    args = parser.parse_args()
    audit(args.dataset_root, args.dataset_root / "audit")
