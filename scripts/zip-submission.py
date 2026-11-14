#!/usr/bin/env python3
"""Create a portable zip with forward-slash entry names.

PowerShell Compress-Archive on Windows can write backslashes into zip entry
names, which some Linux/macOS unzip tools treat literally. This helper writes
spec-compliant, root-relative paths.

Usage: python scripts/zip-submission.py <source-dir> <output.zip>
"""
import os
import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: zip-submission.py <source-dir> <output.zip>", file=sys.stderr)
        return 2
    source, destination = sys.argv[1], sys.argv[2]
    source = os.path.abspath(source)
    destination = os.path.abspath(destination)
    if not os.path.isdir(source):
        print(f"source is not a directory: {source}", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temporary = destination + ".tmp"
    if os.path.exists(temporary):
        os.remove(temporary)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for root, directories, files in os.walk(source):
                directories.sort()
                for name in sorted(files):
                    full = os.path.join(root, name)
                    relative = os.path.relpath(full, source).replace(os.sep, "/")
                    archive.write(full, relative)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
