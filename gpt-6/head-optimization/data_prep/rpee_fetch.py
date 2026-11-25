
import argparse
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
from time import monotonic, sleep
from urllib.error import URLError
from urllib.request import Request, urlopen
import zipfile
import zlib

URL = (
    "https://ped.fz-juelich.de/data/machine_learning/"
    "2024_11_Recognition_In_Field_Studies/data/2024rpee_heads_dataset.zip"
)
VERSION_DOI = "https://doi.org/10.34735/ped.2024.2"
SIZE = 1163119976
EXPANDED = 1174811132
ETAG = '"4553cd68-62741908493ed"'
NAME = "2024rpee_heads_dataset.zip"
MiB = 1024**2


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def log(stage, **details):
    print(json.dumps({"time": now(), "stage": stage, **details}, ensure_ascii=False), flush=True)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def get_archive(archive):
    partial = archive.with_suffix(".zip.part")
    for attempt in range(1, 6):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset == SIZE:
            return partial
        if offset > SIZE:
            raise RuntimeError("Partial file exceeds the declared archive size")
        headers = {"Accept-Encoding": "identity"}
        if offset:
            headers.update(Range=f"bytes={offset}-", **{"If-Range": ETAG})
        begin = signed = monotonic()
        try:
            with urlopen(Request(URL, headers=headers), timeout=45) as response:
                if response.headers.get("ETag") != ETAG:
                    raise RuntimeError("The official archive ETag changed")
                if offset and (response.status != 206 or response.headers.get("Content-Range")
                               != f"bytes {offset}-{SIZE-1}/{SIZE}"):
                    raise RuntimeError("The publisher did not honor the resume range")
                if not offset and response.status != 200:
                    raise RuntimeError(f"Unexpected archive HTTP {response.status}")
                if int(response.headers.get("Content-Length", -1)) != SIZE-offset:
                    raise RuntimeError("The source length differs from G0")
                received = offset
                with partial.open("ab") as file:
                    if offset == 0:
                        prefix = response.read(4)
                        if prefix != b"PK\x03\x04":
                            raise RuntimeError("The response is not a ZIP")
                        file.write(prefix)
                        received += len(prefix)
                    while chunk := response.read(MiB):
                        file.write(chunk)
                        received += len(chunk)
                        if monotonic() >= signed:
                            file.flush()
                            rate = max(1, (received-offset)/max(monotonic()-begin, .001))
                            log("download", received_bytes=received, total_bytes=SIZE,
                                mib_per_s=round(rate/MiB, 2), eta_seconds=round((SIZE-received)/rate))
                            signed = monotonic()+10
            if received == SIZE:
                log("downloaded", bytes=received)
                return partial
            log("retry", attempt=attempt, reason="short_response", received=received)
        except (URLError, TimeoutError, ConnectionError) as error:
            log("retry", attempt=attempt, reason=type(error).__name__)
        if attempt < 5:
            sleep(2**attempt)
    raise RuntimeError("Archive remains incomplete after retries")



def fetch_range(path, start, stop):
    for attempt in range(1, 6):
        offset = path.stat().st_size if path.exists() else 0
        if offset == stop-start:
            return
        if offset > stop-start:
            raise RuntimeError("Resumable range is larger than expected")
        first = start+offset
        headers = {"Range": f"bytes={first}-{stop-1}", "If-Range": ETAG, "Accept-Encoding": "identity"}
        try:
            with urlopen(Request(URL, headers=headers), timeout=45) as response:
                if (response.status != 206 or response.headers.get("ETag") != ETAG
                        or response.headers.get("Content-Range") != f"bytes {first}-{stop-1}/{SIZE}"):
                    raise RuntimeError(f"Unexpected response for byte range {first}:{stop}")
                with path.open("ab") as output:
                    shutil.copyfileobj(response, output, MiB)
            count = path.stat().st_size
            if count == stop-start:
                return
            log("range_retry", start=first, stop=stop, attempt=attempt, reason="short_response")
        except (URLError, TimeoutError, ConnectionError) as error:
            log("range_retry", start=first, stop=stop, attempt=attempt, reason=type(error).__name__)
        if attempt < 5:
            sleep(2**attempt)
    raise RuntimeError(f"Byte range {start}:{stop} could not be downloaded")


def get_archive_parallel(archive, workers):
    partial = archive.with_suffix(".zip.part")
    base = partial.stat().st_size if partial.exists() else 0
    if base == SIZE:
        return partial
    if base > SIZE:
        raise RuntimeError("Partial file exceeds the declared archive size")
    chunk = (SIZE-base+workers-1)//workers
    ranges = [(start,min(start+chunk,SIZE)) for start in range(base,SIZE,chunk)]
    paths = [archive.with_name(f"{NAME}.range-{a}-{b}.part") for a,b in ranges]
    if shutil.disk_usage(archive.parent).free < 2*SIZE-base+512*MiB:
        raise RuntimeError("Insufficient workspace for the parallel archive assembly")
    begin = monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {pool.submit(fetch_range, path, a, b) for path,(a,b) in zip(paths,ranges)}
        while jobs:
            completed, jobs = wait(jobs, timeout=10, return_when=FIRST_COMPLETED)
            for future in completed:
                future.result()
            count = sum(p.stat().st_size for p in paths if p.exists())
            rate = count/max(monotonic()-begin,.001)
            log("download_parallel", received_bytes=base+count,total_bytes=SIZE,
                mib_per_s=round(rate/MiB,2),eta_seconds=round((SIZE-base-count)/rate) if rate else None)

    combined = archive.with_suffix(".zip.assembling")
    with combined.open("wb") as output:
        for item in ([partial] if base else [])+paths:
            with item.open("rb") as stream:
                shutil.copyfileobj(stream,output,MiB)
    if combined.stat().st_size != SIZE:
        raise RuntimeError("Assembled archive has an unexpected size")
    combined.replace(partial)
    for path in paths:
        path.unlink()
    log("downloaded", bytes=SIZE)
    return partial


def checked_members(zf, root):
    members = []
    seen = set()
    for info in zf.infolist():
        parts = PurePosixPath(info.filename).parts
        if not parts or any(part in ("..", "/") or ":" in part or "\\" in part for part in parts):
            raise RuntimeError(f"Unsafe ZIP entry {info.filename}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise RuntimeError(f"ZIP contains a symbolic link: {info.filename}")
        target = root.joinpath(*parts).resolve()
        if not target.is_relative_to(root.resolve()):
            raise RuntimeError(f"ZIP member escapes the destination: {info.filename}")
        if info.is_dir():
            continue
        key = str(target).casefold()
        if key in seen:
            raise RuntimeError(f"Duplicate path in ZIP: {info.filename}")
        seen.add(key)
        members.append((info, target))
    counts = Counter(target.suffix.lower() for _, target in members)
    if counts != {".jpg": 1886, ".txt": 1886} or sum(info.file_size for info, _ in members) != EXPANDED:
        raise RuntimeError("ZIP catalog differs from G0")
    return members


def existing_ok(path, info):
    if not path.exists():
        return False
    if path.stat().st_size != info.file_size:
        raise RuntimeError(f"Existing file size differs: {path}")
    crc = 0
    with path.open("rb") as stream:
        while chunk := stream.read(MiB):
            crc = zlib.crc32(chunk, crc)
    if crc != info.CRC:
        raise RuntimeError(f"Existing file CRC differs: {path}")
    return True


def prepare_root(root,workers):
    archive = root/"archives"/NAME
    extracted = root/"raw"/"RPEE-Heads"
    staged = extracted.with_name(".RPEE-Heads.extracting")
    partial = archive.with_suffix(".zip.part")
    present = archive.stat().st_size if archive.exists() else partial.stat().st_size if partial.exists() else 0
    root.mkdir(parents=True, exist_ok=True)
    need = max(0,SIZE-present) + (0 if extracted.exists() else EXPANDED) + 512*MiB
    if shutil.disk_usage(root).free < need:
        raise RuntimeError(f"Free disk space is below the required {need} bytes")
    archive.parent.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        if archive.stat().st_size != SIZE:
            raise RuntimeError("Existing archive has a different size")
        local = archive
    else:
        local = get_archive_parallel(archive,workers) if workers>1 else get_archive(archive)

    digest = sha256(local)
    log("checking_archive_crc", sha256=digest)
    with zipfile.ZipFile(local) as zf:
        if bad := zf.testzip():
            raise RuntimeError(f"Archive CRC check failed: {bad}")
    if local != archive:
        local.rename(archive)

    log("extracting")
    with zipfile.ZipFile(archive) as zf:
        verify_only = extracted.exists()
        target_root = extracted if verify_only else staged
        members = checked_members(zf, target_root)
        for index,(info,target) in enumerate(members, 1):
            if not existing_ok(target, info):
                if verify_only:
                    raise RuntimeError(f"Existing extraction is incomplete: {target}")
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(target.name+".part")
                with zf.open(info) as source, temp.open("wb") as dest:
                    shutil.copyfileobj(source, dest, MiB)
                if not existing_ok(temp, info):
                    raise RuntimeError(f"Extracted file is missing: {temp}")
                temp.rename(target)
            if index % 500 == 0 or index == len(members):
                log("extracting", checked=index, total=len(members))
        if not verify_only:
            if staged.resolve().parent != extracted.absolute().parent.resolve():
                raise RuntimeError("Extraction staging directory escaped its parent")
            staged.rename(extracted)

    audit = root/"audit"
    audit.mkdir(exist_ok=True)
    metadata = {
        "source_url": URL,
        "dataset_doi": VERSION_DOI,
        "license": "CC BY-SA 4.0",
        "archive": NAME,
        "etag": ETAG,
        "archive_bytes": SIZE,
        "archive_sha256": digest,
        "extracted_files": 3772,
        "extracted_bytes": EXPANDED,
        "extract_verified_at": now(),
    }
    temp = audit/"rpee_source.json.tmp"
    temp.write_text(json.dumps(metadata, indent=2)+"\n", encoding="utf-8")
    temp.replace(audit/"rpee_source.json")
    log("archive_and_extraction_verified", **metadata)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument('--workers',type=int,choices=range(1,5),default=1)
    args = parser.parse_args()
    prepare_root(args.data_root.resolve(),args.workers)

