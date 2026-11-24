"""Freeze the approved head-count split and check training/test isolation."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import tempfile

import cv2
import numpy as np
from PIL import Image


TRAIN1 = "development/train_round1.csv"
TRAIN2 = "development/train_round2.csv"
VAL = "development/validation.csv"
FINAL = "sealed/final_rpee_station.csv"
PENDING = "sealed/pending_rgbt_dark.csv"
EXPECTED_GROUPS = {
    TRAIN1: {"A": 196, "B": 3807},
    TRAIN2: {"A": 196, "B": 3936, "C": 55, "E": 531, "F": 1},
    VAL: {"A": 1561, "B": 3911},
    FINAL: {"A": 16, "C": 48, "D": 12, "E": 35},
    PENDING: {"D": 97, "E": 204, "F": 84},
}


def csv_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def relative_file(root, name):
    path = PurePosixPath(name)
    if not path.parts or path.is_absolute() or any(":" in p or "\\" in p or p == ".." for p in path.parts):
        raise ValueError(f"Invalid relative data path: {name}")
    found = root.joinpath(*path.parts).resolve()
    if not found.is_relative_to(root):
        raise ValueError(f"Path escaped its raw data root: {name}")
    return found


def select(row):
    dataset = row["dataset"]
    if dataset == "Cchead":
        if row["source_recording"] == "schoolpath_train" and row["official_split"] == "train":
            return (TRAIN1, TRAIN2), "cchead_schoolpath"
        if row["source_recording"] == "schoolpath_test" and row["official_split"] == "test":
            return (VAL,), "cchead_schoolpath"
    if dataset == "RPEE-Heads":
        if row["scene"] == "concert_entrance":
            return (TRAIN2,), "rpee_mitsubishi_hall"
        if row["scene"] == "railway_platform":
            return (FINAL,), "rpee_merkur_station"
    if dataset == "RGBT-CC" and row["official_split"] == "test" and row["light"] == "dark":
        return (PENDING,), "rgbt_site_unverified"
    return (), ""


def inventory(path):
    if path.suffix == ".jsonl":
        indexed = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    else:
        indexed = csv_rows(path)
    mapping = {r["path"]: r["sha256"] for r in indexed}
    if len(mapping) != len(indexed):
        raise ValueError(f"Duplicate indexed path in {path}")
    return mapping


def form_lists(matrix, indexes):
    selected = {name: [] for name in EXPECTED_GROUPS}
    for src in matrix:
        if src["technical_candidate"] != "True" or src["quality_flags"]:
            continue
        roles, site = select(src)
        if not roles:
            continue
        index = indexes[src["dataset"]]
        if index[src["image_path"]] != src["image_sha256"]:
            raise ValueError(f"Matrix image hash differs from inventory: {src['image_path']}")
        rec = {
            "dataset": src["dataset"], "group": src["group"], "site": site,
            "source_recording": src["source_recording"], "official_split": src["official_split"],
            "light": src["light"], "count": int(src["count"]), "label_type": src["label_type"],
            "image_path": src["image_path"], "label_path": src["label_path"],
            "image_sha256": src["image_sha256"], "label_sha256": index[src["label_path"]],
        }
        for role in roles:
            selected[role].append(rec)
    for role, rows in selected.items():
        rows.sort(key=lambda r: (r["dataset"], r["source_recording"], r["image_path"]))
        if Counter(row["group"] for row in rows) != EXPECTED_GROUPS[role]:
            raise ValueError(f"Approved candidate counts changed for {role}")
        if len({(r["dataset"], r["image_path"]) for r in rows}) != len(rows):
            raise ValueError(f"Duplicate sample in {role}")
    return selected


def image_signature(data):
    with Image.open(BytesIO(data)) as image:
        image.draft("L", (80, 80))
        gray = image.convert("L")
        square = np.asarray(gray.resize((32, 32), Image.Resampling.LANCZOS), dtype=np.float32)
        gradient = np.asarray(gray.resize((9, 8), Image.Resampling.LANCZOS), dtype=np.int16)
    dct = cv2.dct(square)[:8, :8].ravel()
    phash = np.packbits(dct > np.median(dct[1:])).tobytes()
    dhash = np.packbits((gradient[:, 1:] > gradient[:, :-1]).flatten()).tobytes()
    return int.from_bytes(phash, "big"), int.from_bytes(dhash, "big")


def verify_sample(job):
    root, row = job
    image = relative_file(root, row["image_path"])
    label = relative_file(root, row["label_path"])
    data = image.read_bytes()
    if hashlib.sha256(data).hexdigest() != row["image_sha256"] or checksum(label) != row["label_sha256"]:
        raise ValueError(f"Frozen-source bytes disagree with verified inventory: {image}")
    return image_signature(data)


def verify_isolation(selected, roots):
    train = selected[TRAIN2]
    dev = selected[VAL]
    final = selected[FINAL] + selected[PENDING]
    exposure = train + dev
    for role in (train, dev, final):
        if len({r["image_sha256"] for r in role}) != len(role):
            raise ValueError("Repeated exact image within a project role")
    for left, right in ((train, dev), (exposure, final)):
        if {r["image_sha256"] for r in left} & {r["image_sha256"] for r in right}:
            raise ValueError("Byte-identical image across roles")
        for field in ("image_path", "label_path"):
            if {(r["dataset"], r[field]) for r in left} & {(r["dataset"], r[field]) for r in right}:
                raise ValueError(f"Shared {field} across roles")
    if {r["site"] for r in exposure} & {r["site"] for r in final}:
        raise ValueError("A final-test site also appears in training or development")
    if {r["dataset"] for r in exposure} & {"RGBT-CC"}:
        raise ValueError("RGBT-CC appeared in a development role")
    if {r["image_sha256"] for r in selected[TRAIN1]} - {r["image_sha256"] for r in train}:
        raise ValueError("Round 2 no longer contains round 1")

    work = exposure + final
    print(f"Verifying raw image and label bytes for {len(work)} unique samples", flush=True)
    cv2.setNumThreads(1)
    signatures = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        jobs = ((roots[r["dataset"]], r) for r in work)
        for number, signal in enumerate(executor.map(verify_sample, jobs), 1):
            signatures.append(signal)
            if number % 2500 == 0 or number == len(work):
                print(f"Verified {number}/{len(work)} samples", flush=True)
    print("Screening training/development versus sealed files for near duplicates", flush=True)
    reference = signatures[:len(exposure)]
    for index, (p, d) in enumerate(signatures[len(exposure):]):
        for j, (other_p, other_d) in enumerate(reference):
            if (p ^ other_p).bit_count() <= 6 and (d ^ other_d).bit_count() <= 6:
                raise ValueError(f"Review near-duplicate candidate before freezing: {exposure[j]['image_path']} and {final[index]['image_path']}")
    return {
        "raw_images_verified": len(work), "raw_labels_verified": len(work),
        "exact_image_hash_overlap": 0, "identical_paths_across_roles": 0,
        "verified_final_site_overlap": 0, "screened_perceptual_pairs": len(exposure) * len(final),
        "perceptual_distance_limit_each": 6, "perceptual_matches_to_review": 0,
    }


def publish(out, selected, roots, inputs, checks):
    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{out.name}-", dir=out.parent))
    artifacts = {}
    for name, rows in selected.items():
        path = stage / name
        path.parent.mkdir(exist_ok=True)
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        if len(csv_rows(path)) != len(rows):
            raise RuntimeError(f"Cannot reread staged CSV: {path}")
        artifacts[name] = {"samples": len(rows), "groups": dict(Counter(r["group"] for r in rows)), "sha256": checksum(path)}
    contract = {
        "split_id": out.name,
        "raw_roots": {key: path.as_posix() for key, path in roots.items()},
        "inputs": {key: {"path": path.as_posix(), "sha256": checksum(path)} for key, path in inputs.items()},
        "freeze_script_sha256": checksum(Path(__file__)),
        "files": artifacts,
        "checks": checks,
        "same_site_development": "Cchead schoolpath_train and schoolpath_test are separate sequences under the same view.",
        "training_access": [TRAIN1, TRAIN2, VAL],
        "sealed_ready": [FINAL],
        "sealed_pending_license": [PENDING],
        "independent_b": "missing",
        "test_policy": "Model selection and tuning use development only. Release sealed results once all model and inference settings are fixed. RGB-T support is count-only with illumination dark and unknown capture period.",
        "scope": "Project fine-tuning split isolation. Upstream pretraining and all possible image transformations are outside the verified evidence.",
    }
    protocol = stage / "split_protocol.json"
    protocol.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if json.loads(protocol.read_text(encoding="utf-8")) != contract:
        raise RuntimeError("Cannot reread staged protocol")
    stage.rename(out)
    print(json.dumps({"split": out.as_posix(), "files": artifacts, "checks": checks}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_root", type=Path)
    parser.add_argument("cchead_root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError(f"A frozen split already exists; preserve it: {args.output}")
    roots = {
        "Cchead": (args.cchead_root / "raw").resolve(strict=True),
        "RPEE-Heads": (args.dataset_root / "raw/RPEE-Heads").resolve(strict=True),
        "RGBT-CC": (args.dataset_root / "raw/RGBT-CC").resolve(strict=True),
    }
    audit = args.dataset_root / "audit"
    matrix = audit / "test_matrix.csv"
    sources = {
        "Cchead": args.cchead_root / "gpt-6/files_sha256.jsonl",
        "RPEE-Heads": audit / "rpee_file_inventory.csv",
        "RGBT-CC": audit / "rgbt_file_inventory.csv",
    }
    selected = form_lists(csv_rows(matrix), {name: inventory(path) for name, path in sources.items()})
    checks = verify_isolation(selected, roots)
    publish(args.output, selected, roots, {"matrix": matrix, **sources}, checks)


if __name__ == "__main__":
    main()
