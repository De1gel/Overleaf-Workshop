#!/usr/bin/env python3
"""Build the reviewed Overleaf Workshop VSIX from an exact Git commit."""

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import stat
import subprocess
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


BASE_SHA256 = "2a27cbaea6af4800bf75c97f4a71ebc6d39f27bf794dd5be5c029bc22e942cc7"
BASE_VERSION = "0.15.10"
VERSION = "0.15.11"
REPOSITORY = "https://github.com/De1gel/Overleaf-Workshop"
OVERLAY = "hotfixes/reviewed-runtime/"


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def committed_overlay(repo, revision):
    commit = git(repo, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}").decode().strip()
    records = git(repo, "ls-tree", "-rz", "--full-tree", commit, "--", OVERLAY)
    files = {}
    for record in records.rstrip(b"\0").split(b"\0") if records else ():
        metadata, path = record.split(b"\t", 1)
        mode, kind, blob = metadata.decode().split()
        if kind != "blob" or mode not in ("100644", "100755"):
            raise ValueError(f"Expected a regular runtime file at {path!r}")
        name = path.decode().removeprefix(OVERLAY)
        files[f"extension/{name}"] = (git(repo, "cat-file", "blob", blob), int(mode, 8))
    if "extension/package.json" not in files:
        raise ValueError(f"{commit} does not contain {OVERLAY}package.json")
    return commit, files


def base_entries(base):
    archive = base.read_bytes()
    digest = sha256(archive).hexdigest()
    if digest != BASE_SHA256:
        raise ValueError(f"Base VSIX SHA-256 must be {BASE_SHA256}. Found {digest}.")
    with ZipFile(BytesIO(archive)) as vsix:
        return {
            entry.filename: (vsix.read(entry), (entry.external_attr >> 16) & 0o777)
            for entry in vsix.infolist()
            if not entry.is_dir()
        }


def stamp(entries, commit):
    package_path = "extension/package.json"
    package_bytes, package_mode = entries[package_path]
    package = json.loads(package_bytes)
    if (package.get("publisher"), package.get("name"), package.get("version")) != (
        "iamhyc", "overleaf-workshop", BASE_VERSION
    ):
        raise ValueError("Unexpected extension identity or overlay version")
    package.pop("__metadata", None)
    package["version"] = VERSION
    package["overleafWorkshopBuild"] = {
        "repository": REPOSITORY,
        "commit": commit,
        "baseVSIXSHA256": BASE_SHA256,
    }
    entries[package_path] = (f"{json.dumps(package, indent=2, ensure_ascii=False)}\n".encode(), package_mode)

    manifest_path = "extension.vsixmanifest"
    manifest, manifest_mode = entries[manifest_path]
    pattern = rb'(<Identity\b[^>]*\bVersion=")' + re.escape(BASE_VERSION.encode()) + rb'(")'
    manifest, matches = re.subn(pattern, lambda match: match[1] + VERSION.encode() + match[2], manifest)
    if matches != 1:
        raise ValueError("Could not uniquely update the VSIX extension identity")
    entries[manifest_path] = (manifest, manifest_mode)


def write_vsix(output, entries):
    with NamedTemporaryFile(dir=output.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with ZipFile(temporary_path, "w", compression=ZIP_DEFLATED, compresslevel=9) as vsix:
            for name, (data, mode) in sorted(entries.items()):
                entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | (0o755 if mode & 0o111 else 0o644)) << 16
                vsix.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=9)
        temporary_path.replace(output)
    finally:
        temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True, help="original overleaf-workshop-local.vsix")
    parser.add_argument("--output", type=Path, required=True, help="output VSIX path")
    parser.add_argument("--revision", default="HEAD", help="Git commit or ref that contains the runtime overlay")
    args = parser.parse_args()
    if args.base.resolve() == args.output.resolve():
        parser.error("the output must differ from the base VSIX")

    repo = Path(__file__).resolve().parents[1]
    try:
        commit, overlay = committed_overlay(repo, args.revision)
        entries = base_entries(args.base)
        entries.update(overlay)
        stamp(entries, commit)
        write_vsix(args.output, entries)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging failed: {error}\n")
    print(f"Packaged iamhyc.overleaf-workshop {VERSION} from {commit}")
    print(f"SHA-256 {sha256(args.output.read_bytes()).hexdigest()}  {args.output}")


if __name__ == "__main__":
    main()
