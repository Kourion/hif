/*
 * Metadata helpers: read and patch the Exif (TIFF) block from a HEIF file and
 * insert Exif / XMP / ICC segments into a JPEG produced by the canvas encoder.
 *
 * Plain script exposing `JpegMeta`, shared by the worker and the Node tests.
 */
(function (root) {
  'use strict';

  const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const TAG_ORIENTATION = 0x0112;
  const TAG_MODEL = 0x0110;
  const TAG_EXIF_IFD = 0x8769;
  const TAG_GPS_IFD = 0x8825;
  const TAG_EXPOSURE_TIME = 0x829a;
  const TAG_FNUMBER = 0x829d;
  const TAG_ISO = 0x8827;
  const TAG_DATE_ORIGINAL = 0x9003;
  const TAG_FOCAL_LENGTH = 0x920a;
  const TAG_PIXEL_X = 0xa002;
  const TAG_PIXEL_Y = 0xa003;
  const TAG_LENS_MODEL = 0xa434;

  const MAX_SEGMENT_PAYLOAD = 65533;
  const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
  const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
  const ICC_HEADER = 'ICC_PROFILE\0';

  function isTiffHeader(b, i) {
    return (b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0) ||
      (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a);
  }

  /**
   * HEIF Exif items start with a 4-byte offset to the TIFF header (usually
   * followed by "Exif\0\0"). Returns the TIFF block or null.
   */
  function exifToTiff(item) {
    if (!item || item.length < 12) return null;
    const offset = ((item[0] << 24) | (item[1] << 16) | (item[2] << 8) | item[3]) >>> 0;
    if (4 + offset + 8 <= item.length && isTiffHeader(item, 4 + offset)) return item.slice(4 + offset);
    // Some writers get the offset wrong; look for the header near the start.
    for (let i = 0; i < Math.min(item.length - 8, 64); i++) {
      if (isTiffHeader(item, i)) return item.slice(i);
    }
    return null;
  }

  class Tiff {
    constructor(bytes) {
      this.b = bytes;
      this.le = bytes[0] === 0x49;
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    u16(o) { return this.dv.getUint16(o, this.le); }
    u32(o) { return this.dv.getUint32(o, this.le); }
    set16(o, v) { this.dv.setUint16(o, v, this.le); }
    set32(o, v) { this.dv.setUint32(o, v, this.le); }

    ifd0() { return this.u32(4); }

    /** Entries of the IFD at `off` as { tag, type, count, entry, valueOffset }. */
    entries(off) {
      if (!off || off + 2 > this.b.length) return [];
      const n = this.u16(off);
      if (off + 2 + n * 12 > this.b.length) throw new Error('Truncated IFD');
      const out = [];
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const type = this.u16(e + 2);
        const count = this.u32(e + 4);
        const size = (TYPE_SIZES[type] || 1) * count;
        out.push({ tag: this.u16(e), type, count, entry: e, size, valueOffset: size > 4 ? this.u32(e + 8) : e + 8 });
      }
      return out;
    }

    find(off, tag) {
      return this.entries(off).find((e) => e.tag === tag) || null;
    }

    subIfd(tag) {
      const e = this.find(this.ifd0(), tag);
      return e ? this.u32(e.entry + 8) : 0;
    }

    readValue(e) {
      if (!e) return null;
      const o = e.valueOffset;
      if (o + e.size > this.b.length) return null;
      switch (e.type) {
        case 2: {
          let end = o;
          while (end < o + e.count && this.b[end]) end++;
          return new TextDecoder().decode(this.b.subarray(o, end)).trim();
        }
        case 3: return this.u16(o);
        case 4: return this.u32(o);
        case 5: {
          const d = this.u32(o + 4);
          return d ? this.u32(o) / d : null;
        }
        case 10: {
          const d = this.dv.getInt32(o + 4, this.le);
          return d ? this.dv.getInt32(o, this.le) / d : null;
        }
        default: return null;
      }
    }

    setNumber(e, v) {
      if (!e || e.count !== 1) return;
      if (e.type === 3) this.set16(e.entry + 8, v);
      else if (e.type === 4) this.set32(e.entry + 8, v);
    }

    /** Overwrite an IFD (its entries and out-of-line values) with zeros. */
    zeroIfd(off) {
      const entries = this.entries(off);
      for (const e of entries) {
        if (e.size > 4 && e.valueOffset + e.size <= this.b.length) this.b.fill(0, e.valueOffset, e.valueOffset + e.size);
      }
      this.b.fill(0, off, Math.min(this.b.length, off + 2 + entries.length * 12 + 4));
    }

    /** Remove one entry from an IFD, shifting the rest (and the next-IFD link) up. */
    removeEntry(off, tag) {
      const n = this.u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (this.u16(e) !== tag) continue;
        const end = off + 2 + n * 12 + 4;
        this.b.copyWithin(e, e + 12, end);
        this.b.fill(0, end - 12, end);
        this.set16(off, n - 1);
        return true;
      }
      return false;
    }
  }

  /**
   * Return a patched copy of the TIFF block:
   *  - orientation: new Orientation value (e.g. 1 once pixels are rotated)
   *  - width/height: new pixel dimensions
   *  - removeGps: strip the GPS IFD
   * Returns null when the block cannot be parsed and GPS removal was asked for,
   * so location data never leaks through a block we could not clean.
   */
  function patchExif(tiffBytes, opts) {
    const copy = tiffBytes.slice();
    try {
      const t = new Tiff(copy);
      const ifd0 = t.ifd0();
      if (opts.orientation) t.setNumber(t.find(ifd0, TAG_ORIENTATION), opts.orientation);
      const exifIfd = t.subIfd(TAG_EXIF_IFD);
      if (exifIfd && opts.width && opts.height) {
        t.setNumber(t.find(exifIfd, TAG_PIXEL_X), opts.width);
        t.setNumber(t.find(exifIfd, TAG_PIXEL_Y), opts.height);
      }
      if (opts.removeGps) {
        const gps = t.subIfd(TAG_GPS_IFD);
        if (gps) t.zeroIfd(gps);
        t.removeEntry(ifd0, TAG_GPS_IFD);
      }
      return copy;
    } catch (e) {
      return opts.removeGps ? null : tiffBytes;
    }
  }

  /** Camera settings for display: { model, lens, exposure, fNumber, iso, focalLength, date }. */
  function readCameraInfo(tiffBytes) {
    const info = {};
    if (!tiffBytes) return info;
    try {
      const t = new Tiff(tiffBytes);
      const ifd0 = t.ifd0();
      info.model = t.readValue(t.find(ifd0, TAG_MODEL)) || undefined;
      info.orientation = t.readValue(t.find(ifd0, TAG_ORIENTATION)) || undefined;
      const ex = t.subIfd(TAG_EXIF_IFD);
      if (ex) {
        info.exposure = t.readValue(t.find(ex, TAG_EXPOSURE_TIME)) || undefined;
        info.fNumber = t.readValue(t.find(ex, TAG_FNUMBER)) || undefined;
        info.iso = t.readValue(t.find(ex, TAG_ISO)) || undefined;
        info.focalLength = t.readValue(t.find(ex, TAG_FOCAL_LENGTH)) || undefined;
        info.date = t.readValue(t.find(ex, TAG_DATE_ORIGINAL)) || undefined;
        info.lens = t.readValue(t.find(ex, TAG_LENS_MODEL)) || undefined;
      }
      info.hasGps = !!t.subIfd(TAG_GPS_IFD);
    } catch (e) {
      // Display-only information; ignore damaged blocks.
    }
    return info;
  }

  function ascii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function segment(marker, parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const seg = new Uint8Array(4 + len);
    seg[0] = 0xff;
    seg[1] = marker;
    seg[2] = (len + 2) >> 8;
    seg[3] = (len + 2) & 0xff;
    let o = 4;
    for (const p of parts) {
      seg.set(p, o);
      o += p.length;
    }
    return seg;
  }

  /**
   * Insert metadata segments after SOI, replacing the JFIF APP0 segment the
   * canvas encoder writes (Exif files should start with APP1).
   * Returns { jpeg, warnings }.
   */
  function insertMetadata(jpeg, meta) {
    const warnings = [];
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Encoder did not produce a JPEG');
    const segs = [];
    if (meta.tiff) {
      if (meta.tiff.length + EXIF_HEADER.length <= MAX_SEGMENT_PAYLOAD) {
        segs.push(segment(0xe1, [Uint8Array.from(EXIF_HEADER), meta.tiff]));
      } else {
        warnings.push('Camera info was too large for a JPEG and was left out');
      }
    }
    if (meta.xmp) {
      const header = ascii(XMP_HEADER);
      if (meta.xmp.length + header.length <= MAX_SEGMENT_PAYLOAD) segs.push(segment(0xe1, [header, meta.xmp]));
      else warnings.push('XMP metadata was too large for a JPEG and was left out');
    }
    if (meta.icc) {
      const header = ascii(ICC_HEADER);
      const chunk = MAX_SEGMENT_PAYLOAD - header.length - 2;
      const total = Math.ceil(meta.icc.length / chunk);
      if (total <= 255) {
        for (let i = 0; i < total; i++) {
          segs.push(segment(0xe2, [header, Uint8Array.of(i + 1, total), meta.icc.subarray(i * chunk, (i + 1) * chunk)]));
        }
      } else {
        warnings.push('Colour profile was too large and was left out');
      }
    }
    let pos = 2;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) pos = 4 + ((jpeg[4] << 8) | jpeg[5]);
    if (!segs.length && pos === 2) return { jpeg, warnings };
    const size = 2 + segs.reduce((n, s) => n + s.length, 0) + (jpeg.length - pos);
    const out = new Uint8Array(size);
    out[0] = 0xff;
    out[1] = 0xd8;
    let o = 2;
    for (const s of segs) {
      out.set(s, o);
      o += s.length;
    }
    out.set(jpeg.subarray(pos), o);
    return { jpeg: out, warnings };
  }

  /** XMP may repeat GPS coordinates; drop such packets when location is removed. */
  function xmpHasLocation(xmp) {
    if (!xmp) return false;
    const text = new TextDecoder().decode(xmp);
    return /GPS(Latitude|Longitude|Altitude)/i.test(text);
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const api = { exifToTiff, patchExif, readCameraInfo, insertMetadata, xmpHasLocation, crc32 };
  root.JpegMeta = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
