
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import zipfile

from PIL import Image, ImageDraw, ImageFont

SPLITS = {("training", "train"): "train", ("validation", "val"): "val", ("testing", "test"): "test"}
BANDS = ("low", "medium", "high")
BINS = {("day", "low"): "A", ("day", "medium"): "B", ("day", "high"): "C",
        ("night", "low"): "D", ("night", "medium"): "E", ("night", "high"): "F"}
PAPER = "https://doi.org/10.1109/ACCESS.2025.3563311"
DATA_DOI = "https://doi.org/10.34735/ped.2024.2"


def count_band(count):
    if count is None:
        return "unknown"
    return "low" if count < 30 else "medium" if count < 90 else "high"


def write_csv(path, rows):
    interim = path.with_suffix(path.suffix+".tmp")
    with interim.open("w", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    interim.replace(path)


def write_text(path, text):
    interim = path.with_suffix(path.suffix+".tmp")
    interim.write_text(text, encoding="utf-8")
    interim.replace(path)


def inspect_labels(path):
    counts = Counter()
    boxes = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        counts["rows"] += 1
        try:
            c,x,y,w,h = line.split()
            coords = tuple(map(float, (x,y,w,h)))
            x,y,w,h = coords
            if int(c) != 0 or not all(map(math.isfinite, coords)) or min(w,h) <= 0:
                raise ValueError
        except ValueError:
            counts["invalid"] += 1
            continue
        counts["heads"] += 1
        if min(x-w/2, y-h/2) < -1e-6 or max(x+w/2, y+h/2) > 1+1e-6:
            counts["out_of_bounds"] += 1
        if coords in boxes:
            counts["duplicate_boxes"] += 1
        boxes.add(coords)
    return counts


def rows_from_archive(root, source):
    archive = root/"archives"/source["archive"]
    data = root/"raw"/"RPEE-Heads"
    with zipfile.ZipFile(archive) as zf:
        expected = {x.filename:x for x in zf.infolist() if not x.is_dir()}
    local = {p.relative_to(data).as_posix() for p in data.rglob("*") if p.is_file()}
    if local != set(expected) or len(local) != source["extracted_files"]:
        raise RuntimeError("The local file set differs from the archive")
    return data, expected


def read_evidence(path):
    with path.open(encoding="utf-8-sig", newline="") as source:
        rows = {row["recording_id"]:row for row in csv.DictReader(source)}
    if len(rows) != 66:
        raise RuntimeError("Expected review decisions for the 66 published recording IDs")
    return rows


def camera_token(recording):
    matches = re.search(r"(?i)(?:^|_)(cam[0-9]+|gopro[0-9]+_[0-9]+|x[0-9]{4}_[0-9]+)(?:_|$)", recording)
    return matches[1] if matches else ""


def audit(root, evidence_path):
    audit_dir = root/"audit"
    source = json.loads((audit_dir/"rpee_source.json").read_text(encoding="utf-8"))
    raw, expected = rows_from_archive(root, source)
    evidence = read_evidence(evidence_path)
    inventory, frames = [], []
    digests = defaultdict(list)
    groups = defaultdict(Counter)
    group_frames = defaultdict(lambda: defaultdict(set))
    for path, info in sorted(expected.items()):
        rawfile = raw/path
        data = rawfile.read_bytes()
        if len(data) != info.file_size:
            raise RuntimeError(f"Local file size disagrees with the ZIP: {path}")
        digest = hashlib.sha256(data).hexdigest()
        split = SPLITS[tuple(path.split("/")[:2])]
        kind = "image" if path.lower().endswith(".jpg") else "label"
        inventory.append({
            "path": path, "split": split, "kind": kind, "bytes": len(data),
            "archive_crc32": f"{info.CRC:08x}", "sha256": digest,
        })
        if kind != "image":
            continue

        stem = rawfile.stem
        recording,frame = stem.rsplit("_frame_",1)
        if recording not in evidence:
            raise RuntimeError(f"Unexpected recording: {recording}")
        view = evidence[recording]
        camera = camera_token(recording)
        groups[recording][split] += 1
        group_frames[recording][split].add(int(frame))

        width, height = "", ""
        readable = "ok"
        captured = ""
        try:
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                if image.format != "JPEG":
                    raise ValueError("unexpected image format")
                width,height = image.size
                captured = str(image.getexif().get(36867, ""))
        except (OSError, ValueError) as error:
            readable = type(error).__name__
        digests[digest].append((path,split))

        label = rawfile.parent.parent/"labels"/(stem+".txt")
        present = label.is_file()
        labels = inspect_labels(label) if present else Counter()
        count = labels["heads"] if present and labels["rows"] and not labels["invalid"] else None
        band = count_band(count)
        issues = []
        if not present: issues.append("missing_label")
        if readable != "ok": issues.append("decode_error")
        if present and not labels["rows"]: issues.append("empty_label")
        if labels["invalid"]: issues.append("invalid_label_rows")
        if labels["out_of_bounds"]: issues.append("out_of_bounds")
        if labels["duplicate_boxes"]: issues.append("identical_boxes_in_label")

        frames.append({
            "image_path": path,
            "label_path": label.relative_to(raw).as_posix() if present else "",
            "split": split,
            "width": width, "height": height, "image_status": readable,
            "label_format": "YOLO_normalized_xywh_head",
            "recording_id": recording, "source_frame_index": int(frame),
            "camera_token_from_filename": camera, "scene_type": view["scene_type"],
            "viewpoint_visual": view["viewpoint_visual"],
            "light": view["light"], "light_evidence": view["light_evidence"],
            "light_reference_frames": view["light_reference_frames"],
            "exif_datetime_original": captured,
            "head_annotation_rows": labels["rows"] if present else "",
            "head_count": count,
            "head_count_band": band, "candidate_group": BINS.get((view["light"],band),"") if not issues else "",
            "invalid_label_rows": labels["invalid"], "out_of_bounds_boxes": labels["out_of_bounds"],
            "identical_label_boxes": labels["duplicate_boxes"],
            "issues": "|".join(issues), "image_sha256": digest,
        })
        if len(frames)%250 == 0:
            print(f"audited {len(frames)}/1886 images", flush=True)

    paths = {r["label_path"] for r in frames if r["label_path"]}
    if paths != {p for p in expected if p.endswith(".txt")} or set(groups) != set(evidence):
        raise RuntimeError("Unexpected unmatched labels or recording keys")
    counts = Counter(r["split"] for r in frames)
    if counts != {"train":1346,"val":246,"test":294}:
        raise RuntimeError("The official split counts changed")
    duplicate_sets = [items for items in digests.values() if len(items)>1]
    duplicates = {path for items in duplicate_sets for path,_ in items}
    for row in frames:
        row["byte_identical_duplicate"] = row["image_path"] in duplicates
        if row["byte_identical_duplicate"]:
            row["issues"] = "|".join(filter(None,[row["issues"],"byte_identical_image"]))
            row["candidate_group"] = ""
    cells = {label: dict(Counter(r["split"] for r in frames if r["candidate_group"] == label)) for label in "ABCDEF"}
    unknown = Counter(r["split"] for r in frames if r["light"] == "unknown")
    pairs = {}
    for a,b in (("train","val"),("train","test"),("val","test")):
        overlap = [name for name,splits in groups.items() if a in splits and b in splits]
        exact = sum(len(group_frames[name][a] & group_frames[name][b]) for name in overlap)
        pairs[f"{a}/{b}"] = {"recordings":len(overlap),"identical_source_frame_ids":exact}
    head_counts = {row["image_path"]: row["head_count"] for row in frames}
    cross_split_duplicates = [
        [{"path": path, "split": split, "head_count": head_counts[path]} for path,split in items]
        for items in duplicate_sets if len({split for _,split in items})>1
    ]
    summary = {
        "cross_split_duplicate_images": cross_split_duplicates,
        "known_light_quality_excluded": sum(r["light"] != "unknown" and not r["candidate_group"] for r in frames),
        "recording_review_sha256": hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
        "archive_sha256": source["archive_sha256"],
        "images": len(frames), "labels": len(paths),
        "head_annotation_rows": sum(r["head_annotation_rows"] for r in frames if r["head_annotation_rows"]!=""),
        "official_splits": dict(counts), "recordings_from_filename":len(groups),
        "recordings_present_in_all_splits":sum(len(v)==3 for v in groups.values()),
        "split_overlap": pairs, "byte_identical_image_groups": len(duplicate_sets),
        "images_in_byte_identical_groups":len(duplicates),
        "byte_identical_groups_across_splits":sum(len({s for _,s in d})>1 for d in duplicate_sets),
        "decode_failures":sum(r["image_status"]!="ok" for r in frames),
        "invalid_label_rows":sum(r["invalid_label_rows"] for r in frames),
        "images_with_out_of_bounds_boxes":sum(r["out_of_bounds_boxes"]>0 for r in frames),
        "out_of_bounds_boxes":sum(r["out_of_bounds_boxes"] for r in frames),
        "duplicate_label_boxes":sum(r["identical_label_boxes"] for r in frames),
        "empty_labels":sum("empty_label" in r["issues"] for r in frames),
        "light_counts":dict(Counter(r["light"] for r in frames)),
        "source_scene_counts":dict(Counter(r["scene_type"] for r in frames)),
        "unknown_light_by_split":dict(unknown), "candidates_by_split":cells,
        "exif_capture_timestamp_present":sum(bool(r["exif_datetime_original"]) for r in frames),
    }
    write_csv(audit_dir/"rpee_file_inventory.csv",inventory)
    write_csv(audit_dir/"rpee_image_manifest.csv",frames)
    summary["preview_files"] = make_preview(audit_dir,raw,frames)
    write_text(audit_dir/"rpee_audit_summary.json",json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
    make_report(audit_dir,source,summary)
    print(json.dumps(summary,ensure_ascii=False),flush=True)


def font(size):
    try:
        return ImageFont.truetype("segoeui.ttf", size)
    except OSError:
        return ImageFont.load_default()


def make_preview(audit_dir,raw,frames):
    cells = list("ABCDEF")
    width,height = 1440,742
    canvas = Image.new("RGB",(width,height),"#edf1f5")
    draw = ImageDraw.Draw(canvas)
    draw.text((22,14),"RPEE-Heads | Day / night head-count samples",font=font(32),fill="#102137")
    draw.text((23,58),"Source frames from Abubaker et al. (CC BY-SA 4.0) | DOI 10.34735/ped.2024.2",
              font=font(17),fill="#435168")
    counter = {}
    for i, group in enumerate(cells):
        x=22+(i%3)*468
        y=95+(i//3)*313
        draw.rounded_rectangle((x,y,x+459,y+300),radius=9,fill="white")
        selected = [r for r in frames if r["candidate_group"]==group and r["image_status"]=="ok"
                    and r["head_count"] is not None and not r["invalid_label_rows"]]
        tag = ("Day" if group in "ABC" else "Night") + " / " + BANDS[i%3]
        if not selected:
            draw.text((x+10,y+13),f"{group}  {tag} | No verified sample",font=font(20),fill="#29445d")
            continue
        selected.sort(key=lambda r:(r["split"]!="test",r["scene_type"]=="controlled_entrance_experiment",
                                   r["out_of_bounds_boxes"]>0,r["head_count"]))
        candidate_pool=[r for r in selected if r["split"]==selected[0]["split"] and r["scene_type"]==selected[0]["scene_type"]]
        row=candidate_pool[len(candidate_pool)//2]
        counter[group]=row["image_path"]
        draw.text((x+10,y+10),f"{group}  {tag}  |  {row['head_count']} heads  |  {row['split']}",
                  font=font(20),fill="#152b44")
        with Image.open(raw/row["image_path"]) as im:
            im.thumbnail((435,218),Image.Resampling.LANCZOS)
            canvas.paste(im,(x+(459-im.width)//2,y+38+(218-im.height)//2))
        draw.text((x+10,y+268),Path(row["image_path"]).name[:47],font=font(13),fill="#435168")
    interim=audit_dir/"rpee_sample_preview.tmp"
    canvas.save(interim,"PNG")
    interim.replace(audit_dir/"rpee_sample_preview.png")
    return counter


def make_report(out,source,s):
    lines=["# RPEE-Heads G1 下载与审计", "",
        f"发布数据 DOI {DATA_DOI}，许可为 CC BY-SA 4.0。论文 {PAPER}。",
        f"ZIP 大小 {source['archive_bytes']:,} 字节，解压 {source['extracted_bytes']:,} 字节。已核对 ZIP CRC。",
        f"ZIP SHA-256 为 `{source['archive_sha256']}`。", "",
        "## 帧与标注", "",
        f"- JPEG {s['images']:,} 张，逐图标签 {s['labels']:,} 份，人头标注行 {s['head_annotation_rows']:,}。",
        f"- 官方目录 train {s['official_splits']['train']:,}、val {s['official_splits']['val']:,}、test {s['official_splits']['test']:,}。",
        f"- 解码失败 {s['decode_failures']}，无效标签行 {s['invalid_label_rows']}，空标注 {s['empty_labels']}。",
        f"- 越界框 {s['out_of_bounds_boxes']} 个，涉及 {s['images_with_out_of_bounds_boxes']} 张。完全相同的框记录 {s['duplicate_label_boxes']} 条。原标签按发布包保留。",
        f"- 逐文件 SHA-256 检出 {s['byte_identical_image_groups']} 组字节完全相同的 JPEG，其中 {s['byte_identical_groups_across_splits']} 组跨集合。此检查覆盖字节相同的重复。",
        "", "## 原视频来源与划分", "",
        f"- 逐图保留 ZIP 文件名的来源前缀及帧号。识别到 {s['recordings_from_filename']} 个来源前缀，{s['recordings_present_in_all_splits']} 个前缀出现在三个集合。",
        "- 发布论文按来源视频切块后再划分。来源前缀跨集合时，官方测试适用于复现作者协议。用 RPEE 训练后若评估跨视频表现，需另做按来源和物理机位的整体留出。",
        "- 文件名明确出现的设备标记留在逐图清单。其余实体摄像机 ID 保留为空；同一活动或相机的多个前缀可能归属同一物理机位。",
        ""]
    for items in s["cross_split_duplicate_images"]:
        lines.append("- Cross-split duplicate JPEG and published head counts")
        for row in items:
            lines.append(f"  - {row['split']}, {row['head_count']} heads, {row['path']}")
    lines.extend(["",f"Candidate counts exclude files with audit flags. {s['known_light_quality_excluded']} images with a day/night assignment were excluded.",""])
    for pair, row in s["split_overlap"].items():
        lines.append(f"- {pair} 共享 {row['recordings']} 个来源前缀；共享完全相同的来源前缀和帧号有 {row['identical_source_frame_ids']} 个。")
    lines.extend(["","## 昼夜与单帧人数候选","",
        "昼夜依据保存在逐图清单。可按拍摄时段或可辨认的室外画面确认的录制组使用 day/night；室内灯光或户外时段切换无法逐帧确认时保留 unknown。",
        "候选数量含官方全部划分，仅表示可筛到的真实图像。0～29、30～89、90 及以上以单帧人头框计数，不能换算为单位面积密度。",""])
    for key in "ABCDEF":
        row=s["candidates_by_split"][key]
        lines.append(f"- {key} 共 {sum(row.values())} 张，train {row.get('train',0)}、val {row.get('val',0)}、test {row.get('test',0)}。")
    lines.extend(["",f"无法核实昼夜的图像 {sum(s['unknown_light_by_split'].values())} 张。","",
        "逐文件完整性见 [rpee_file_inventory.csv](rpee_file_inventory.csv)，逐图与来源见 [rpee_image_manifest.csv](rpee_image_manifest.csv)，候选画面见 [rpee_sample_preview.png](rpee_sample_preview.png)。",""])
    lines.extend(f"- Preview {k} {v}" for k,v in s["preview_files"].items())
    lines.append("")
    write_text(out/"rpee_audit_report.md","\n".join(lines))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--data-root",type=Path,required=True)
    parser.add_argument("--recordings",type=Path,default=Path(__file__).with_name("rpee_recordings.csv"))
    args=parser.parse_args()
    audit(args.data_root,args.recordings)

