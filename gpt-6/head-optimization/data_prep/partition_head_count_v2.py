"""Separate the six head-count test groups and validate development entry points."""

import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import shutil
import tempfile

from freeze_head_count_split import (
    FINAL,
    PENDING,
    TRAIN1,
    TRAIN2,
    VAL,
    checksum,
    csv_rows,
    inventory,
    relative_file,
    verify_isolation,
)


PARENT_PROTOCOL_SHA = "68a32b28231b741b7974a83726f3d131151ca2be188b10596c7268f0de64be8c"
READY = "ready"
PENDING_LICENSE = "pending_license"


def verify_fit_inputs(bundle, round_number, train_path=None, validation_path=None):
    """Return the two pinned development paths, rejecting every other input."""
    root = bundle.resolve(strict=True)
    development = (root / "development").resolve(strict=True)
    if development != root / "development":
        raise ValueError("Development directory must stay in the split root")
    protocol = json.loads((root / "split_protocol.json").read_text(encoding="utf-8"))
    train_name = {1: TRAIN1, 2: TRAIN2}[round_number]
    resolved = []
    for name, supplied in ((train_name, train_path), (VAL, validation_path)):
        expected = root / name
        candidate = (supplied or expected).resolve(strict=True)
        if candidate != expected:
            raise ValueError(f"Only {name} is allowed for this role")
        if checksum(candidate) != protocol["development"][name]["sha256"]:
            raise ValueError(f"Frozen development manifest has changed: {name}")
        resolved.append(candidate)
    return tuple(resolved)


def read_parent(root):
    protocol_file = root / "split_protocol.json"
    if checksum(protocol_file) != PARENT_PROTOCOL_SHA:
        raise ValueError("Parent split protocol digest changed")
    protocol = json.loads(protocol_file.read_text(encoding="utf-8"))
    result = {}
    for name in (TRAIN1, TRAIN2, VAL, FINAL, PENDING):
        file = root / name
        if checksum(file) != protocol["files"][name]["sha256"]:
            raise ValueError(f"Parent split manifest changed: {name}")
        result[name] = csv_rows(file)
        for row in result[name]:
            row["count"] = int(row["count"])
    return protocol, result


def read_street(data_root, index):
    csv_path = data_root / "audit/sample_manifest.csv"
    rows = []
    for row in csv_rows(csv_path):
        if row["dataset"] != "Cchead" or row["source_recording"] != "street_train" or row["quality_flags"]:
            continue
        count = int(row["count"])
        if not 30 <= count < 90:
            continue
        if index[row["image_path"]] != row["image_sha256"]:
            raise ValueError(f"Street image digest differs from inventory: {row['image_path']}")
        rows.append({
            "dataset": "Cchead", "group": "B", "site": "cchead_street",
            "source_recording": "street_train", "official_split": row["official_split"],
            "light": "day", "count": count, "label_type": row["label_type"],
            "image_path": row["image_path"], "label_path": row["label_path"],
            "image_sha256": row["image_sha256"], "label_sha256": index[row["label_path"]],
        })
    if len(rows) != 1888:
        raise ValueError("Approved Street B candidate count differs")
    return sorted(rows, key=lambda row: row["image_path"])


def stage_file(raw_root, original, target, digest):
    source = relative_file(raw_root, original)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise ValueError(f"Duplicated materialized path: {target}")
    shutil.copyfile(source, target)
    if checksum(target) != digest:
        raise ValueError(f"Copied test file differs: {target}")
    return target.stat().st_size


def materialize_test(stage, test_rows, roots):
    stats = {}
    processed = 0
    size = 0
    for group in "ABCDEF":
        rows = []
        for row, status in test_rows:
            if row["group"] != group:
                continue
            key = row["image_sha256"][:24]
            prefix = Path("test") / group / status
            image = prefix / "images" / (key + Path(row["image_path"]).suffix)
            label = prefix / "ground_truth" / (key + Path(row["label_path"]).suffix)
            root = roots[row["dataset"]]
            for kind, dest in (("image", image), ("label", label)):
                size += stage_file(root, row[f"{kind}_path"], stage / dest, row[f"{kind}_sha256"])
            rows.append({
                "status": status, "test_image": image.as_posix(), "test_label": label.as_posix(), **row,
            })
            processed += 1
            if processed % 500 == 0 or processed == len(test_rows):
                print(f"Copied and verified {processed}/{len(test_rows)} test pairs", flush=True)
        path = stage / "test" / group / "manifest.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        if len(csv_rows(path)) != len(rows):
            raise ValueError(f"Test manifest reread failed: {path}")
        stats[group] = {
            "manifest": path.relative_to(stage).as_posix(), "sha256": checksum(path),
            **Counter(row["status"] for row in rows),
        }
    return stats, size


def build(parent, output, data_root, cchead_root):
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Preserve existing split: {output}")
    old, selected = read_parent(parent)
    roots = {dataset: Path(root).resolve(strict=True) for dataset, root in old["raw_roots"].items()}
    source = data_root / "audit/sample_manifest.csv"
    cchead_index = cchead_root / "gpt-6/files_sha256.jsonl"
    if checksum(cchead_index) != old["inputs"]["Cchead"]["sha256"]:
        raise ValueError("Cchead inventory differs from v1")
    street = read_street(data_root, inventory(cchead_index))
    selected[FINAL].extend(street)
    checks = verify_isolation(selected, roots)
    rows = [(row, READY) for row in selected[FINAL]] + [(row, PENDING_LICENSE) for row in selected[PENDING]]
    if Counter(row["group"] for row, _ in rows) != {"A":16,"B":1888,"C":48,"D":109,"E":239,"F":84}:
        raise ValueError("The approved A–F test counts changed")
    required = sum(
        (roots[row["dataset"]] / row[f"{kind}_path"]).stat().st_size
        for row, _ in rows for kind in ("image", "label")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output.parent).free < required + 64 * 1024**2:
        raise RuntimeError("Not enough space to keep independent test copies")
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    print(f"Writing staged split to {stage} ({required} test bytes)", flush=True)
    dev = stage / "development"
    dev.mkdir()
    development = {}
    for name in (TRAIN1, TRAIN2, VAL):
        target = stage / name
        shutil.copyfile(parent / name, target)
        info = old["files"][name]
        if checksum(target) != info["sha256"]:
            raise ValueError(f"Development manifest copy failed: {name}")
        development[name] = info
    groups, size = materialize_test(stage, rows, roots)
    if size != required:
        raise ValueError("Test bundle byte count mismatch")
    payload = {
        "split_id": output.name, "parent_protocol_sha256": PARENT_PROTOCOL_SHA,
        "script_sha256": checksum(Path(__file__)), "helpers_sha256": checksum(Path(__file__).with_name("freeze_head_count_split.py")),
        "additional_sources": {str(path): checksum(path) for path in (source, cchead_index)},
        "development_raw_roots": {dataset: str(roots[dataset]) for dataset in ("Cchead", "RPEE-Heads")},
        "development": development, "test_root": "test", "test_groups": groups, "test_bytes": size,
        "reserved_sources": ["Cchead/street_train", "RPEE-Heads/Merkur station", "RGBT-CC"],
        "test_access": "evaluation only after weights and inference settings are frozen",
        "pending_license": "RGBT-CC is staged for local data management only; evaluation approval is pending",
        "scope": "Project split and manifest guard. File-system access controls and upstream pretraining are outside this check.",
        "checks": checks,
    }
    protocol = stage / "split_protocol.json"
    protocol.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify_fit_inputs(stage, 1)
    verify_fit_inputs(stage, 2)
    stage.rename(output)
    print(json.dumps({"output": output.as_posix(), "groups": groups, "bytes": size, "checks": checks}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    a = commands.add_parser("build")
    for name in ("parent", "output", "dataset_root", "cchead_root"):
        a.add_argument(name, type=Path)
    b = commands.add_parser("check-fit")
    b.add_argument("bundle", type=Path)
    b.add_argument("round", type=int, choices=(1,2))
    b.add_argument("--train", type=Path)
    b.add_argument("--validation", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "build":
            build(args.parent, args.output, args.dataset_root, args.cchead_root)
        else:
            train, validation = verify_fit_inputs(args.bundle, args.round, args.train, args.validation)
            print(json.dumps({"train": train.as_posix(), "validation": validation.as_posix()}))
    except (ValueError, FileNotFoundError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
