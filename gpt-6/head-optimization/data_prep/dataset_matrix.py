"""Build an auditable A–F candidate list while preserving publisher splits."""

import argparse
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path


DAY = ("A", "B", "C")
NIGHT = ("D", "E", "F")


def band(count):
    return 0 if count < 30 else 1 if count < 90 else 2


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def write_csv(path, rows):
    temp = path.with_suffix(".csv.part")
    with temp.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    temp.replace(path)


def atomic_text(path, value):
    temp = path.with_name(path.name + ".part")
    temp.write_text(value, encoding="utf-8")
    temp.replace(path)


def sample(dataset, scene, source, split, light, evidence, width, height, count, label_type,
           image, label, digest, group, issues):
    return {
        "group": group, "dataset": dataset, "scene": scene, "source_recording": source,
        "official_split": split, "project_split": "pending_user_assignment",
        "light": light, "light_evidence": evidence, "width": width, "height": height,
        "count": count, "label_type": label_type, "image_path": image, "label_path": label,
        "image_sha256": digest, "quality_flags": "|".join(issues),
    }


def cchead_rows(audit):
    data = json.loads((audit / "cchead_integrity.json").read_text(encoding="utf-8"))
    for row in data["frames"]:
        seq = row["sequence"]
        school = seq in {"schoolpath_train", "schoolpath_test"}
        count = row["head_count"]
        subset = seq.rsplit("_", 1)[-1]
        group = DAY[band(count)] if school and count < 90 else ""
        flags = [field for field in ("invalid_rows", "outside_centers", "duplicate_ids", "duplicate_boxes", "byte_duplicate") if row[field]]
        yield sample(
            "Cchead", "school_walkway" if school else "street", seq, subset, "day" if school else "not_audited",
            "visual: frames 0,2750,5500 for each schoolpath sequence; same view" if school else "",
            1920, 1080, count, "head_box_with_track_id", row["image_path"], row["label_path"],
            row["image_sha256"], group, flags,
        )


def rpee_group(row, count):
    light = row["light"]
    station = row["scene_type"] == "railway_platform"
    entrance = row["scene_type"] == "concert_entrance"
    rank = band(count)
    if light == "day":
        matches = (station, entrance, entrance or (station and row["viewpoint_visual"].startswith("high ")))
        return DAY[rank] if matches[rank] else ""
    if light == "night":
        matches = (station, station or entrance, entrance)
        return NIGHT[rank] if matches[rank] else ""
    return ""


def rpee_rows(audit):
    for row in read_csv(audit / "rpee_image_manifest.csv"):
        count = int(row["head_count"]) if row["head_count"] != "" else None
        group = rpee_group(row, count) if count is not None else ""
        flags = [row["issues"]] if row["issues"] else []
        if row["byte_identical_duplicate"] == "True":
            flags.append("byte_duplicate")
        if group and not flags and row["candidate_group"] != group:
            flags.append("excluded_in_rpee_audit")
        yield sample(
            "RPEE-Heads", row["scene_type"], row["recording_id"], row["split"], row["light"],
            row["light_evidence"], row["width"], row["height"], count, "head_box",
            row["image_path"], row["label_path"], row["image_sha256"], group, flags,
        )


def rgbt_rows(audit):
    for row in read_csv(audit / "rgbt_image_manifest.csv"):
        count = int(row["point_count"])
        dark = row["illumination"] == "dark"
        flags = [field for field in ("invalid_points", "out_of_bounds_points", "exact_duplicate_points") if int(row[field])]
        if int(row["rgb_exif_orientation"]) != 1:
            flags.append("rgb_exif_rotation_label_alignment_unverified")
        if row["byte_duplicate_rgb"] == "True":
            flags.append("byte_duplicate_rgb")
        yield sample(
            "RGBT-CC", "scene_unverified", "", row["official_split"], row["illumination"],
            "official dark_list; capture time unverified" if dark else "official bright_list; capture time unverified",
            row["width"], row["height"], count, "person_point",
            row["rgb_path"], row["label_path"], row["rgb_sha256"], NIGHT[band(count)] if dark else "", flags,
        )


def analyze(audit):
    rows = [*cchead_rows(audit), *rpee_rows(audit), *rgbt_rows(audit)]
    sources = defaultdict(set)
    for row in rows:
        sources[row["image_sha256"]].add(row["dataset"])
    for row in rows:
        if len(sources[row["image_sha256"]]) > 1:
            row["quality_flags"] = "|".join(filter(None, [row["quality_flags"], "cross_dataset_exact_image"]))
        row["technical_candidate"] = bool(row["group"]) and not row["quality_flags"]
        row["official_test_candidate"] = row["technical_candidate"] and row["official_split"] == "test"
        row["license_status"] = "unverified" if row["dataset"] == "RGBT-CC" else "published"
        row["independent_test_verified"] = False
    if len({(r["dataset"], r["image_path"]) for r in rows}) != len(rows):
        raise ValueError("Sample paths are duplicated")
    matrix = [r for r in rows if r["group"]]
    technical = [r for r in matrix if r["technical_candidate"]]
    if len({r["image_sha256"] for r in technical}) != len(technical):
        raise ValueError("Technical candidates share an exact image hash")
    write_csv(audit / "sample_manifest.csv", rows)
    write_csv(audit / "test_matrix.csv", matrix)
    stats = {}
    for name in DAY + NIGHT:
        chosen = [r for r in matrix if r["group"] == name]
        clean = [r for r in chosen if r["technical_candidate"]]
        stats[name] = {
            "matched": len(chosen),
            "clean": len(clean),
            "official_test_clean": sum(r["official_test_candidate"] for r in clean),
            "by_dataset": dict(Counter(r["dataset"] for r in clean)),
            "official_test_by_dataset": dict(Counter(r["dataset"] for r in clean if r["official_test_candidate"])),
            "by_dataset_scene": dict(Counter(f"{r['dataset']}/{r['scene']}" for r in clean)),
            "official_test_by_dataset_scene": dict(Counter(
                f"{r['dataset']}/{r['scene']}" for r in clean if r["official_test_candidate"]
            )),
            "by_license_status": dict(Counter(r["license_status"] for r in clean)),
        }
    result = {
        "rows": len(rows), "matched_rows": len(matrix),
        "cross_dataset_exact_duplicate_groups": sum(len(names) > 1 for names in sources.values()),
        "groups": stats,
    }
    atomic_text(audit / "dataset_matrix_summary.json", json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audit_root", type=Path)
    result = analyze(parser.parse_args().audit_root)
    print(json.dumps(result))
