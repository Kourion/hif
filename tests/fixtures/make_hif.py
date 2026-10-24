#!/usr/bin/env python3
"""Generate Sony-style 10-bit HEIF (.HIF) test images.

Sony cameras store HEIF stills as a 'grid' primary item made of hidden HEVC
tiles (10-bit, 4:2:2 or 4:2:0), with an nclx colour box, an Exif item and a
small HEVC thumbnail. This script reproduces that layout from a synthetic test
pattern so the converter can be tested without camera files.

Requires numpy and an ffmpeg build with libx265.

Usage:
  make_hif.py OUT.HIF [--width W] [--height H] [--tile N] [--chroma 422|420]
              [--hlg] [--limited] [--irot 0-3] [--imir 0|1] [--clap WxH]
              [--orientation 1-8] [--gps]
              [--noise SIGMA] [--qp QP]

A JSON sidecar (OUT.json) lists the patch centres and their expected sRGB
values, which tests/run-tests.mjs uses to check the converted JPEG.
"""
import argparse
import json
import os
import struct
import subprocess
import tempfile

import numpy as np

# Patch colours (display-referred sRGB, 0..1). Chosen to stay inside the
# BT.709 gamut and below HLG reference white so they survive a round trip.
PATCHES = [
    ("gray50", (0.5, 0.5, 0.5)),
    ("red", (0.75, 0.15, 0.12)),
    ("green", (0.2, 0.65, 0.25)),
    ("blue", (0.15, 0.25, 0.7)),
    ("skin", (0.8, 0.6, 0.5)),
    ("yellow", (0.75, 0.7, 0.2)),
    ("dark", (0.1, 0.1, 0.1)),
    ("white80", (0.8, 0.8, 0.8)),
]

KR_KB = {1: (0.2126, 0.0722), 6: (0.299, 0.114), 9: (0.2627, 0.0593)}


def make_pattern(w, h):
    """Return float RGB image (h, w, 3) in sRGB-encoded 0..1 plus patch info."""
    img = np.zeros((h, w, 3), np.float64)
    # Top third: horizontal gray ramp (shows banding / tone errors).
    t = h // 3
    img[:t, :, :] = np.linspace(0, 1, w)[None, :, None]
    # Middle third: colour patches.
    m0, m1 = t, 2 * t
    pw = w // len(PATCHES)
    patches = []
    for i, (name, rgb) in enumerate(PATCHES):
        x0 = i * pw
        x1 = w if i == len(PATCHES) - 1 else x0 + pw
        img[m0:m1, x0:x1, :] = rgb
        patches.append({"name": name, "x": (x0 + x1) // 2, "y": (m0 + m1) // 2,
                        "rgb": [round(c * 255) for c in rgb]})
    # Bottom third: hue sweep with vertical saturation ramp.
    hh = h - m1
    hue = np.linspace(0, 1, w)[None, :]
    sat = np.linspace(1, 0, hh)[:, None]
    k = (np.arange(3)[None, None, :] * (1 / 3) + hue[..., None]) % 1
    hue_rgb = np.clip(np.abs(k * 6 - 3) - 1, 0, 1)
    img[m1:, :, :] = 0.7 * (1 - sat[..., None] + sat[..., None] * hue_rgb)
    # Orientation marker: white square in the top-left corner.
    s = max(8, min(w, h) // 12)
    img[s // 2:s // 2 + s, s // 2:s // 2 + s, :] = 1.0
    marker = {"x": s // 2 + s // 2, "y": s // 2 + s // 2, "rgb": [255, 255, 255]}
    return img, patches, marker


# --- HLG encoding (BT.2100) -------------------------------------------------

M709_TO_2020 = np.array([[0.6274, 0.3293, 0.0433],
                         [0.0691, 0.9195, 0.0114],
                         [0.0164, 0.0880, 0.8956]])


def srgb_to_linear(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def hlg_oetf(e):
    a, b = 0.17883277, 0.28466892
    c = 0.5 - a * np.log(4 * a)
    e = np.clip(e, 0, 1)
    return np.where(e <= 1 / 12, np.sqrt(3 * e), a * np.log(np.maximum(12 * e - b, 1e-12)) + c)


def to_hlg(img):
    """SDR sRGB image -> HLG BT.2020 signal, SDR white mapped to 203 nits."""
    lin = srgb_to_linear(img) @ M709_TO_2020.T
    fd = np.clip(lin, 0, None) * 203.0 / 1000.0          # display light, 1 = 1000 nits
    yd = fd @ np.array([0.2627, 0.6780, 0.0593])
    ys = np.power(np.maximum(yd, 1e-12), 1 / 1.2)          # inverse OOTF (gamma 1.2)
    scale = np.where(yd > 0, ys / np.maximum(yd, 1e-12), 0)  # Es = Fd * Ys / Yd
    es = fd * scale[..., None]
    return hlg_oetf(es)


# --- Y'CbCr conversion ------------------------------------------------------

def rgb_to_ycbcr10(rgb, matrix, full_range):
    kr, kb = KR_KB[matrix]
    kg = 1 - kr - kb
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = kr * r + kg * g + kb * b
    cb = (b - y) / (2 * (1 - kb))
    cr = (r - y) / (2 * (1 - kr))
    if full_range:
        Y = y * 1023
        Cb = cb * 1023 + 512
        Cr = cr * 1023 + 512
    else:
        Y = y * 876 + 64
        Cb = cb * 896 + 512
        Cr = cr * 896 + 512
    clip = lambda a: np.clip(np.rint(a), 0, 1023).astype("<u2")
    return clip(Y), Cb, Cr


def subsample(c, chroma):
    # Horizontal: co-sited [1 2 1] filter (HEVC chroma location 0).
    p = np.pad(c, ((0, 0), (1, 1)), mode="edge")
    c = (p[:, 0:-2:2] + 2 * p[:, 1:-1:2] + p[:, 2::2]) / 4
    if chroma == "420":
        c = (c[0::2, :] + c[1::2, :]) / 2   # vertical: centred between rows
    return np.clip(np.rint(c), 0, 1023).astype("<u2")


# --- HEVC encoding ----------------------------------------------------------

def encode_hevc(y, cb, cr, w, h, pix_fmt, tmp, name, qp=6):
    raw = os.path.join(tmp, name + ".yuv")
    out = os.path.join(tmp, name + ".hevc")
    with open(raw, "wb") as f:
        f.write(y.tobytes() + cb.tobytes() + cr.tobytes())
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-i", raw,
        "-c:v", "libx265", "-preset", "fast",
        "-x265-params", f"log-level=error:keyint=1:qp={qp}:info=0:repeat-headers=0",
        "-frames:v", "1", "-f", "hevc", out], check=True)
    data = open(out, "rb").read()
    return split_annexb(data)


def split_annexb(data):
    nals, i, n = [], 0, len(data)
    starts = []
    while i < n - 3:
        if data[i] == 0 and data[i + 1] == 0 and (data[i + 2] == 1 or (data[i + 2] == 0 and i + 3 < n and data[i + 3] == 1)):
            sc = 3 if data[i + 2] == 1 else 4
            starts.append((i, i + sc))
            i += sc
        else:
            i += 1
    for k, (s, p) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else n
        nals.append(data[p:end].rstrip(b"\x00") if k + 1 < len(starts) else data[p:end])
    return nals


def unescape(nal):
    out, zeros = bytearray(), 0
    for b in nal:
        if zeros >= 2 and b == 3:
            zeros = 0
            continue
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


def hvcc_box(nals, chroma_idc, bit_depth):
    vps = [n for n in nals if (n[0] >> 1) & 0x3F == 32]
    sps = [n for n in nals if (n[0] >> 1) & 0x3F == 33]
    pps = [n for n in nals if (n[0] >> 1) & 0x3F == 34]
    r = unescape(sps[0])[2:]               # skip NAL header
    ptl = r[1:13]                           # profile_tier_level (max_sub_layers = 1)
    body = bytes([1]) + ptl[0:1] + ptl[1:5] + ptl[5:11] + ptl[11:12]
    body += struct.pack(">HBBBBHB", 0xF000, 0xFC, 0xFC | chroma_idc,
                        0xF8 | (bit_depth - 8), 0xF8 | (bit_depth - 8), 0, 0x0F)
    arrays = [(32, vps), (33, sps), (34, pps)]
    body += bytes([len(arrays)])
    for t, lst in arrays:
        body += bytes([0x80 | t]) + struct.pack(">H", len(lst))
        for n in lst:
            body += struct.pack(">H", len(n)) + n
    return box(b"hvcC", body)


def slice_payload(nals):
    vcl = [n for n in nals if (n[0] >> 1) & 0x3F < 32]
    return b"".join(struct.pack(">I", len(n)) + n for n in vcl)


# --- ISOBMFF writing --------------------------------------------------------

def box(t, payload):
    return struct.pack(">I", 8 + len(payload)) + t + payload


def fullbox(t, version, flags, payload):
    return box(t, struct.pack(">I", (version << 24) | flags) + payload)


def make_exif(orientation, width, height, gps=False):
    """Little-endian TIFF with IFD0, an Exif IFD and optionally a GPS IFD."""
    dt = b"2024:05:01 12:34:56\0"
    # (tag, type, count, value-bytes); values > 4 bytes are stored out of line.
    ifd0 = [
        (0x010F, 2, 5, b"SONY\0"),
        (0x0110, 2, 9, b"ILCE-7M4\0"),
        (0x0112, 3, 1, struct.pack("<H", orientation)),
        (0x0132, 2, len(dt), dt),
        (0x8769, 4, 1, "exif"),
    ]
    if gps:
        ifd0.append((0x8825, 4, 1, "gps"))
    exif_ifd = [
        (0x829A, 5, 1, struct.pack("<II", 1, 250)),    # ExposureTime 1/250
        (0x829D, 5, 1, struct.pack("<II", 28, 10)),    # FNumber 2.8
        (0x8827, 3, 1, struct.pack("<H", 400)),        # ISO 400
        (0x9003, 2, len(dt), dt),
        (0x920A, 5, 1, struct.pack("<II", 35, 1)),     # FocalLength 35mm
        (0xA002, 4, 1, struct.pack("<I", width)),
        (0xA003, 4, 1, struct.pack("<I", height)),
    ]
    gps_ifd = [
        (0x0001, 2, 2, b"N\0"),
        (0x0002, 5, 3, struct.pack("<IIIIII", 52, 1, 31, 1, 1234, 100)),
    ]
    ifds = [("ifd0", ifd0), ("exif", exif_ifd)] + ([("gps", gps_ifd)] if gps else [])
    offsets, pos = {}, 8
    for name, entries in ifds:
        offsets[name] = pos
        pos += 2 + 12 * len(entries) + 4
    data_start = pos
    out = bytearray(b"II*\0" + struct.pack("<I", 8))
    extra = bytearray()
    for name, entries in ifds:
        out += struct.pack("<H", len(entries))
        for tag, typ, count, val in entries:
            if isinstance(val, str):
                val = struct.pack("<I", offsets[val])
            if len(val) <= 4:
                out += struct.pack("<HHI", tag, typ, count) + val.ljust(4, b"\0")
            else:
                out += struct.pack("<HHII", tag, typ, count, data_start + len(extra))
                extra += val + (b"\0" if len(val) % 2 else b"")
        out += struct.pack("<I", 0)
    tiff = bytes(out + extra)
    # HEIF Exif item: 4-byte offset to the TIFF header, then 'Exif\0\0' + TIFF.
    return struct.pack(">I", 6) + b"Exif\0\0" + tiff


def build_heif(args):
    W, H, T = args.width, args.height, args.tile
    img, patches, marker = make_pattern(W, H)
    if args.noise:
        # Film-grain-like texture so the bitstream is as dense as a real photo.
        rng = np.random.default_rng(1)
        img = np.clip(img + rng.normal(0, args.noise, img.shape), 0, 1)
    if args.hlg:
        signal = to_hlg(img)
        matrix, prim, trc, full = 9, 9, 18, not args.limited
    else:
        signal = img
        matrix, prim, trc, full = 1, 1, 1, not args.limited
    cols, rows = -(-W // T), -(-H // T)
    padded = np.pad(signal, ((0, rows * T - H), (0, cols * T - W), (0, 0)), mode="edge")
    Y, Cb, Cr = rgb_to_ycbcr10(padded, matrix, full)
    chroma_idc = 2 if args.chroma == "422" else 1
    pix_fmt = "yuv422p10le" if args.chroma == "422" else "yuv420p10le"

    with tempfile.TemporaryDirectory() as tmp:
        tiles = []
        for r in range(rows):
            for c in range(cols):
                sl = (slice(r * T, (r + 1) * T), slice(c * T, (c + 1) * T))
                csl = (slice(r * T // (2 if chroma_idc == 1 else 1), (r + 1) * T // (2 if chroma_idc == 1 else 1)),
                       slice(c * T // 2, (c + 1) * T // 2))
                cb = subsample(Cb, args.chroma)[csl]
                cr = subsample(Cr, args.chroma)[csl]
                tiles.append(encode_hevc(np.ascontiguousarray(Y[sl]), np.ascontiguousarray(cb),
                                         np.ascontiguousarray(cr), T, T, pix_fmt, tmp, f"t{r}_{c}", args.qp))
        # Thumbnail: 8-bit 4:2:0, 320 px wide.
        tw = 320
        th = (H * tw // W) // 2 * 2
        ys = (np.arange(th) * H // th)
        xs = (np.arange(tw) * W // tw)
        small = signal[ys][:, xs]
        y10, cb10, cr10 = rgb_to_ycbcr10(small, matrix, full)
        tcb = np.clip(np.rint(cb10[0::2, 0::2]), 0, 1023).astype("<u2")
        tcr = np.clip(np.rint(cr10[0::2, 0::2]), 0, 1023).astype("<u2")
        thumb = encode_hevc(y10, tcb, tcr, tw, th, "yuv420p10le", tmp, "thumb")

    exif = make_exif(args.orientation, W, H, args.gps)

    # Item IDs: 1 = grid (primary), 2.. = tiles, then thumbnail, then Exif.
    grid_id = 1
    tile_ids = list(range(2, 2 + len(tiles)))
    thumb_id = tile_ids[-1] + 1
    exif_id = thumb_id + 1

    infe = lambda iid, t, hidden=False, name=b"": fullbox(b"infe", 2, 1 if hidden else 0,
                                                          struct.pack(">HH", iid, 0) + t + name + b"\0")
    infos = [infe(grid_id, b"grid")] + [infe(i, b"hvc1", True) for i in tile_ids]
    infos += [infe(thumb_id, b"hvc1"), infe(exif_id, b"Exif", True)]
    iinf = fullbox(b"iinf", 0, 0, struct.pack(">H", len(infos)) + b"".join(infos))

    ref = lambda t, src, dsts: box(t, struct.pack(">HH", src, len(dsts)) + b"".join(struct.pack(">H", d) for d in dsts))
    iref = fullbox(b"iref", 0, 0, ref(b"dimg", grid_id, tile_ids) + ref(b"thmb", thumb_id, [grid_id])
                   + ref(b"cdsc", exif_id, [grid_id]))

    # Property boxes (1-based indices in ipma).
    props = [
        hvcc_box(tiles[0], chroma_idc, 10),                                   # 1
        fullbox(b"ispe", 0, 0, struct.pack(">II", T, T)),                     # 2
        box(b"colr", b"nclx" + struct.pack(">HHHB", prim, trc, matrix, 0x80 if full else 0)),  # 3
        fullbox(b"ispe", 0, 0, struct.pack(">II", W, H)),                     # 4
        hvcc_box(thumb, 1, 10),                                               # 5
        fullbox(b"ispe", 0, 0, struct.pack(">II", tw, th)),                   # 6
        fullbox(b"pixi", 0, 0, bytes([3, 10, 10, 10])),                       # 7
    ]
    # Transformations, in the order HEIF applies them: clap, irot, imir.
    transforms = []
    if args.clap:
        cw, ch = args.clap
        transforms.append(box(b"clap", struct.pack(">IIIIiIiI", cw, 1, ch, 1, 0, 1, 0, 1)))
    if args.irot:
        transforms.append(box(b"irot", bytes([args.irot & 3])))
    if args.imir is not None:
        transforms.append(box(b"imir", bytes([args.imir & 1])))
    first_transform = len(props) + 1
    props += transforms
    ipco = box(b"ipco", b"".join(props))

    def assoc(iid, idx):
        return struct.pack(">HB", iid, len(idx)) + bytes((0x80 if ess else 0) | i for i, ess in idx)

    entries = [assoc(grid_id, [(4, False), (3, False), (7, False)]
                     + [(first_transform + i, True) for i in range(len(transforms))])]
    entries += [assoc(i, [(1, True), (2, False), (3, False)]) for i in tile_ids]
    entries += [assoc(thumb_id, [(5, True), (6, False), (3, False)])]
    ipma = fullbox(b"ipma", 0, 0, struct.pack(">I", len(entries)) + b"".join(entries))
    iprp = box(b"iprp", ipco + ipma)

    grid_data = struct.pack(">BBBBHH", 0, 0, rows - 1, cols - 1, W, H)
    idat = box(b"idat", grid_data)

    payloads = [slice_payload(t) for t in tiles] + [slice_payload(thumb), exif]
    payload_ids = tile_ids + [thumb_id, exif_id]

    ftyp = box(b"ftyp", b"heix" + struct.pack(">I", 0) + b"mif1heixMiHEmiaf")
    hdlr = fullbox(b"hdlr", 0, 0, struct.pack(">I", 0) + b"pict" + bytes(12) + b"\0")
    pitm = fullbox(b"pitm", 0, 0, struct.pack(">H", grid_id))

    def build_iloc(mdat_start):
        # version 1: offset_size=4, length_size=4, base_offset_size=0, index_size=0
        items = [struct.pack(">HHHHII", grid_id, 1, 0, 1, 0, len(grid_data))]
        off = mdat_start
        for iid, p in zip(payload_ids, payloads):
            items.append(struct.pack(">HHHHII", iid, 0, 0, 1, off, len(p)))
            off += len(p)
        return fullbox(b"iloc", 1, 0, bytes([0x44, 0x00]) + struct.pack(">H", len(items)) + b"".join(items))

    def build_meta(mdat_start):
        return fullbox(b"meta", 0, 0, hdlr + pitm + iinf + iref + iprp + idat + build_iloc(mdat_start))

    meta_len = len(build_meta(0))
    mdat_start = len(ftyp) + meta_len + 8
    meta = build_meta(mdat_start)
    assert len(meta) == meta_len
    mdat = box(b"mdat", b"".join(payloads))
    with open(args.out, "wb") as f:
        f.write(ftyp + meta + mdat)

    # Expected output geometry after clap, irot (counter-clockwise quarter
    # turns) and imir (axis 0 = mirror top-bottom, as libheif applies it).
    def rot(p):
        x, y, w, h = p["x"], p["y"], W, H
        if args.clap:
            left, top = (W - args.clap[0]) // 2, (H - args.clap[1]) // 2
            x, y, w, h = x - left, y - top, args.clap[0], args.clap[1]
        if args.irot == 1:
            x, y, w, h = y, w - 1 - x, h, w
        elif args.irot == 2:
            x, y = w - 1 - x, h - 1 - y
        elif args.irot == 3:
            x, y, w, h = h - 1 - y, x, h, w
        if args.imir == 0:
            y = h - 1 - y
        elif args.imir == 1:
            x = w - 1 - x
        return dict(p, x=x, y=y, w=w, h=h)

    out_w, out_h = rot({"x": 0, "y": 0})["w"], rot({"x": 0, "y": 0})["h"]

    strip = lambda p: {k: v for k, v in p.items() if k not in ("w", "h")}
    meta_json = {
        "width": out_w, "height": out_h, "hlg": bool(args.hlg), "chroma": args.chroma,
        "full_range": full, "irot": args.irot, "transformed": bool(transforms),
        "exif_orientation_in": args.orientation,
        "exif_orientation_out": 1 if transforms else args.orientation,
        "gps": bool(args.gps),
        "patches": [strip(rot(p)) for p in patches], "marker": strip(rot(marker)),
    }
    with open(os.path.splitext(args.out)[0] + ".json", "w") as f:
        json.dump(meta_json, f, indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=1200)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--chroma", choices=["422", "420"], default="422")
    ap.add_argument("--hlg", action="store_true", help="encode as HLG / BT.2020 like Sony 'HLG still images'")
    ap.add_argument("--limited", action="store_true", help="use limited (video) range")
    ap.add_argument("--irot", type=int, default=0, choices=range(4), help="irot property (90 deg CCW steps)")
    ap.add_argument("--orientation", type=int, default=1, help="Exif orientation tag value")
    ap.add_argument("--gps", action="store_true", help="add a GPS IFD to the Exif block")
    ap.add_argument("--imir", type=int, choices=(0, 1), help="imir property (mirror axis)")
    ap.add_argument("--clap", type=lambda v: tuple(int(n) for n in v.split("x")),
                    help="centred clean-aperture crop, e.g. 1000x700")
    ap.add_argument("--noise", type=float, default=0, help="add grain (std dev, e.g. 0.02) for realistic file sizes")
    ap.add_argument("--qp", type=int, default=6, help="HEVC quantiser for the tiles")
    build_heif(ap.parse_args())


if __name__ == "__main__":
    main()
