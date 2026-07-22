#!/usr/bin/env python3
"""Repack 大眼表情包 into top-level Owncast emoji packs.

- Elevate series 1..23 -> 10大眼01 .. 32大眼23
- Keep semantic basenames for series 1-7
- UUID series 8-23 -> dy{NN}_{ii}.png
- Longest edge <= 240 (no upscale)
- Single-frame GIF -> PNG
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
EMOJI_DIR = ROOT / "static" / "img" / "emoji"
SRC = EMOJI_DIR / "大眼表情包"
OUT = EMOJI_DIR / "_dayan_out"
MAX_EDGE = 240
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.I,
)
IMG_EXTS = {".png", ".gif", ".jpg", ".jpeg", ".webp"}


def pack_name(series: int) -> str:
    return f"{9 + series:02d}大眼{series:02d}"


def fit_max_edge(im: Image.Image, max_edge: int = MAX_EDGE) -> Image.Image:
    w, h = im.size
    longest = max(w, h)
    if longest <= max_edge:
        return im
    scale = max_edge / longest
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    return im.resize((nw, nh), Image.Resampling.LANCZOS)


def process_image(src: Path, dst: Path) -> dict:
    """Load, convert GIF->PNG if needed, scale, save. Returns stats."""
    with Image.open(src) as im:
        n_frames = getattr(im, "n_frames", 1)
        orig_size = im.size
        orig_format = im.format
        if n_frames > 1:
            # Defensive: keep multi-frame GIF as GIF (not expected in this pack).
            frames = []
            durations = []
            for frame in range(n_frames):
                im.seek(frame)
                fr = fit_max_edge(im.convert("RGBA"))
                frames.append(fr)
                durations.append(im.info.get("duration", 100))
            dst.parent.mkdir(parents=True, exist_ok=True)
            out_path = dst.with_suffix(".gif")
            frames[0].save(
                out_path,
                save_all=True,
                append_images=frames[1:],
                duration=durations,
                loop=im.info.get("loop", 0),
                optimize=True,
            )
            return {
                "src": src,
                "dst": out_path,
                "orig_size": orig_size,
                "new_size": frames[0].size,
                "n_frames": n_frames,
                "orig_format": orig_format,
                "note": "animated-gif-kept",
            }

        # Single frame (including static GIFs)
        rgba = im.convert("RGBA")
        scaled = fit_max_edge(rgba)
        dst.parent.mkdir(parents=True, exist_ok=True)
        out_path = dst.with_suffix(".png")
        scaled.save(out_path, format="PNG", optimize=True)
        note = "gif->png" if src.suffix.lower() == ".gif" else "png"
        if scaled.size != orig_size:
            note += "+scale"
        return {
            "src": src,
            "dst": out_path,
            "orig_size": orig_size,
            "new_size": scaled.size,
            "n_frames": 1,
            "orig_format": orig_format,
            "note": note,
        }


def collect_jobs() -> list[tuple[Path, Path, str]]:
    """Return list of (src, dest_relative_to_out, shortcode_name)."""
    if not SRC.is_dir():
        raise SystemExit(f"source missing: {SRC}")

    jobs: list[tuple[Path, Path, str]] = []
    for series in range(1, 24):
        sdir = SRC / str(series)
        if not sdir.is_dir():
            raise SystemExit(f"missing series dir: {sdir}")
        files = sorted(
            p for p in sdir.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXTS
        )
        if not files:
            raise SystemExit(f"empty series: {sdir}")

        pack = pack_name(series)
        if series <= 7:
            for f in files:
                name = f.stem
                rel = Path(pack) / f"{name}.png"
                jobs.append((f, rel, name))
        else:
            for i, f in enumerate(files, start=1):
                name = f"dy{series:02d}_{i:02d}"
                rel = Path(pack) / f"{name}.png"
                jobs.append((f, rel, name))
    return jobs


def existing_basenames() -> set[str]:
    names: set[str] = set()
    for p in EMOJI_DIR.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
            continue
        # skip source tree and temp out
        try:
            rel = p.relative_to(EMOJI_DIR)
        except ValueError:
            continue
        if rel.parts and rel.parts[0] in {"大眼表情包", "_dayan_out"}:
            continue
        names.add(p.stem.lower())
    return names


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write files (default dry-run)")
    ap.add_argument("--replace", action="store_true", help="with --apply: remove source and install packs")
    args = ap.parse_args()

    jobs = collect_jobs()
    print(f"jobs: {len(jobs)} (expect 286)")
    if len(jobs) != 286:
        print("WARNING: count != 286", file=sys.stderr)

    # shortcode uniqueness among new jobs
    names = [n for _, _, n in jobs]
    dups = [n for n, c in Counter(names).items() if c > 1]
    if dups:
        print(f"ERROR: duplicate shortcodes in new pack: {dups[:20]}", file=sys.stderr)
        return 1

    old = existing_basenames()
    clashes = sorted(set(n.lower() for n in names) & old)
    if clashes:
        print(f"ERROR: clash with existing packs: {clashes[:20]}", file=sys.stderr)
        return 1

    # dry-run summary by series
    by_series: dict[int, list] = {i: [] for i in range(1, 24)}
    for src, rel, name in jobs:
        series = int(rel.parts[0][2:4]) if False else int(src.parent.name)
        by_series[int(src.parent.name)].append((src, rel, name))

    for s in range(1, 24):
        items = by_series[s]
        sample = ", ".join(f"{a.stem}->{c}" for a, b, c in items[:3])
        print(f"  series {s:2d} -> {pack_name(s)}/  n={len(items)}  e.g. {sample}")

    if not args.apply:
        print("\n[dry-run] no files written. Re-run with --apply [--replace]")
        return 0

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    stats = []
    bytes_in = 0
    bytes_out = 0
    for src, rel, name in jobs:
        dst = OUT / rel
        bytes_in += src.stat().st_size
        info = process_image(src, dst)
        bytes_out += info["dst"].stat().st_size
        stats.append(info)
        if len(stats) % 50 == 0:
            print(f"  processed {len(stats)}/{len(jobs)}")

    # verify
    out_files = list(OUT.rglob("*"))
    out_imgs = [p for p in out_files if p.is_file() and p.suffix.lower() in IMG_EXTS]
    print(f"\nwritten: {len(out_imgs)} files under {OUT}")
    print(f"volume: {bytes_in/1024/1024:.2f} MB -> {bytes_out/1024/1024:.2f} MB")

    dim_counter = Counter()
    notes = Counter()
    oversized = []
    for s in stats:
        dim_counter[s["new_size"]] += 1
        notes[s["note"]] += 1
        if max(s["new_size"]) > MAX_EDGE:
            oversized.append(s)
    print("notes:", dict(notes))
    print("output dims:", dict(dim_counter.most_common(10)))
    if oversized:
        print(f"ERROR: {len(oversized)} still >{MAX_EDGE}px", file=sys.stderr)
        return 1
    if len(out_imgs) != len(jobs):
        print("ERROR: output count mismatch", file=sys.stderr)
        return 1

    if not args.replace:
        print("\n[--apply only] packs left in _dayan_out/. Re-run with --apply --replace to install.")
        return 0

    # install: move packs into EMOJI_DIR, remove source
    for pack_dir in sorted(OUT.iterdir()):
        if not pack_dir.is_dir():
            continue
        target = EMOJI_DIR / pack_dir.name
        if target.exists():
            print(f"ERROR: target already exists: {target}", file=sys.stderr)
            return 1
        shutil.move(str(pack_dir), str(target))
        print(f"  installed {target.name}")

    shutil.rmtree(OUT)
    if SRC.exists():
        shutil.rmtree(SRC)
        print(f"  removed {SRC}")

    # final count
    total = sum(
        1
        for p in EMOJI_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in IMG_EXTS
    )
    packs = sorted(d.name for d in EMOJI_DIR.iterdir() if d.is_dir())
    print(f"\ndone. total emoji files: {total}")
    print("packs:", ", ".join(packs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
