/*
 * HIF core: decodes HEIF/HIF images with the libheif WebAssembly build and
 * converts their (10-bit) Y'CbCr planes to 8-bit sRGB.
 *
 * Camera HIF files are grids of independently coded tiles, so a file is
 * opened once (HeifFile) and decoded tile by tile. That lets several workers
 * share one photo and keeps each worker's memory to about one tile.
 *
 * Loaded with importScripts() in the conversion worker and with require() in
 * the Node tests, so it is written as a plain script that exposes `HifCore`.
 */
(function (root) {
  'use strict';

  const FOURCC_PROF = 0x70726f66; // 'prof'
  const FOURCC_RICC = 0x72494343; // 'rICC'
  const FOURCC_IROT = 0x69726f74; // 'irot'
  const FOURCC_IMIR = 0x696d6972; // 'imir'
  const FOURCC_CLAP = 0x636c6170; // 'clap'
  const MIRROR_VERTICAL = 0; // libheif: flip top-bottom

  const COLORSPACE_YCBCR = 0;
  const COLORSPACE_RGB = 1;
  const COLORSPACE_MONO = 2;
  const CHROMA_MONO = 0;
  const CHROMA_420 = 1;
  const CHROMA_444 = 3;
  const CHROMA_UNDEFINED = 99;
  const CHANNEL_Y = 0;
  const CHANNEL_CB = 1;
  const CHANNEL_CR = 2;
  const CHANNEL_R = 3;
  const CHANNEL_G = 4;
  const CHANNEL_B = 5;
  const CHROMA_NAMES = ['4:0:0', '4:2:0', '4:2:2', '4:4:4'];

  // Byte offsets in heif_decoding_options (wasm32).
  const DECODING_OPTIONS_IGNORE_TRANSFORMATIONS = 1;
  const DECODING_OPTIONS_OUTPUT_NCLX = 56;
  // sizeof(struct heif_image_tiling) on wasm32, rounded up.
  const TILING_STRUCT_SIZE = 80;

  // H.273 transfer characteristics we treat specially.
  const TRANSFER_PQ = 16;
  const TRANSFER_HLG = 18;
  // H.273 colour primaries.
  const PRIMARIES_BT2020 = 9;
  const PRIMARIES_P3 = 12;

  // Reference white for HDR -> SDR mapping (ITU-R BT.2408), in nits.
  const HDR_REFERENCE_WHITE = 203;
  // Nominal peak of an HLG reference display, in nits.
  const HLG_PEAK = 1000;
  // Linear level (1 = reference white) above which HDR highlights are compressed.
  const TONE_KNEE = 0.8;

  class HeifError extends Error {
    constructor(message, code, subcode) {
      super(message);
      this.name = 'HeifError';
      this.code = code;
      this.subcode = subcode;
    }
  }

  function cString(M, ptr) {
    if (!ptr) return '';
    const heap = M.HEAPU8;
    let end = ptr;
    while (heap[end]) end++;
    return new TextDecoder().decode(heap.subarray(ptr, end));
  }

  /** Scratch memory for out-parameters and the returned heif_error struct. */
  class Scratch {
    constructor(M) {
      this.M = M;
      this.err = M._malloc(16); // struct heif_error { int code; int subcode; const char* message; }
      this.out = M._malloc(16);
    }

    failed() {
      return this.M.HEAP32[this.err >> 2] !== 0;
    }

    check(what) {
      const M = this.M;
      const p = this.err >> 2;
      const code = M.HEAP32[p];
      if (code !== 0) {
        const msg = cString(M, M.HEAP32[p + 2]);
        throw new HeifError(`${what}: ${msg || 'error ' + code}`, code, M.HEAP32[p + 1]);
      }
    }

    outPtr() {
      return this.M.HEAP32[this.out >> 2];
    }

    dispose() {
      this.M._free(this.err);
      this.M._free(this.out);
    }
  }

  function readMetadata(s, handle) {
    const M = s.M;
    const result = { exif: null, xmp: null };
    const count = M._heif_image_handle_get_number_of_metadata_blocks(handle, 0);
    if (!count) return result;
    const ids = M._malloc(count * 4);
    try {
      M._heif_image_handle_get_list_of_metadata_block_IDs(handle, 0, ids, count);
      for (let i = 0; i < count; i++) {
        const id = M.HEAP32[(ids >> 2) + i];
        const type = cString(M, M._heif_image_handle_get_metadata_type(handle, id));
        const contentType = cString(M, M._heif_image_handle_get_metadata_content_type(handle, id));
        const isExif = type === 'Exif';
        const isXmp = type === 'mime' && contentType === 'application/rdf+xml';
        if (!(isExif && !result.exif) && !(isXmp && !result.xmp)) continue;
        const size = M._heif_image_handle_get_metadata_size(handle, id);
        if (!size) continue;
        const buf = M._malloc(size);
        try {
          M._heif_image_handle_get_metadata(s.err, handle, id, buf);
          // Metadata is optional; a damaged block should not stop the conversion.
          if (s.failed()) continue;
          const bytes = M.HEAPU8.slice(buf, buf + size);
          if (isExif) result.exif = bytes;
          else result.xmp = bytes;
        } finally {
          M._free(buf);
        }
      }
    } finally {
      M._free(ids);
    }
    return result;
  }

  // struct heif_color_profile_nclx { uint8 version; enum primaries; enum transfer; enum matrix; uint8 full_range; ... }
  function parseNclx(M, p) {
    return {
      primaries: M.HEAP32[(p >> 2) + 1],
      transfer: M.HEAP32[(p >> 2) + 2],
      matrix: M.HEAP32[(p >> 2) + 3],
      fullRange: M.HEAPU8[p + 16] !== 0,
    };
  }

  function readIcc(s, handle) {
    const M = s.M;
    const type = M._heif_image_handle_get_color_profile_type(handle);
    if (type !== FOURCC_PROF && type !== FOURCC_RICC) return null;
    const size = M._heif_image_handle_get_raw_color_profile_size(handle);
    if (size <= 0) return null;
    const buf = M._malloc(size);
    try {
      M._heif_image_handle_get_raw_color_profile(s.err, handle, buf);
      return s.failed() ? null : M.HEAPU8.slice(buf, buf + size);
    } finally {
      M._free(buf);
    }
  }

  function planeView(s, img, channel) {
    const M = s.M;
    const width = M._heif_image_get_width(img, channel);
    const height = M._heif_image_get_height(img, channel);
    if (width <= 0 || height <= 0) return null;
    const bits = M._heif_image_get_bits_per_pixel_range(img, channel);
    const ptr = M._heif_image_get_plane_readonly2(img, channel, s.out);
    const strideBytes = M.HEAPU32[s.out >> 2];
    if (!ptr) return null;
    const wide = bits > 8;
    const stride = wide ? strideBytes >> 1 : strideBytes;
    const length = stride * (height - 1) + width;
    const data = wide ? new Uint16Array(M.HEAPU8.buffer, ptr, length) : new Uint8Array(M.HEAPU8.buffer, ptr, length);
    return { data, stride, width, height, bits };
  }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Integer affine map from stored pixel (u, v) to output pixel
   * x = a*u + b*v + c, y = d*u + e*v + f, built from the file's crop,
   * rotation and mirror properties in the order they are listed.
   */
  class Geometry {
    constructor(width, height) {
      this.m = [1, 0, 0, 0, 1, 0];
      this.width = width;
      this.height = height;
      this.identity = true;
    }

    // Compose with x' = p*x + q*y + r, y' = s*x + t*y + w.
    then(p, q, r, s, t, w) {
      const [a, b, c, d, e, f] = this.m;
      this.m = [p * a + q * d, p * b + q * e, p * c + q * f + r, s * a + t * d, s * b + t * e, s * c + t * f + w];
      this.identity = false;
    }

    rotateCcw(degrees) {
      const W = this.width;
      const H = this.height;
      if (degrees === 90) {
        this.then(0, 1, 0, -1, 0, W - 1);
        [this.width, this.height] = [H, W];
      } else if (degrees === 180) {
        this.then(-1, 0, W - 1, 0, -1, H - 1);
      } else if (degrees === 270) {
        this.then(0, -1, H - 1, 1, 0, 0);
        [this.width, this.height] = [H, W];
      }
    }

    mirror(direction) {
      if (direction === MIRROR_VERTICAL) this.then(1, 0, 0, 0, -1, this.height - 1);
      else this.then(-1, 0, this.width - 1, 0, 1, 0);
    }

    crop(left, top, right, bottom) {
      if (!(left || top || right || bottom)) return;
      this.then(1, 0, -left, 0, 1, -top);
      this.width -= left + right;
      this.height -= top + bottom;
    }

    apply(u, v) {
      const [a, b, c, d, e, f] = this.m;
      return { x: a * u + b * v + c, y: d * u + e * v + f };
    }
  }

  /**
   * Copy a w x h RGBA block that sits at (u0, v0) in stored coordinates into
   * output orientation, dropping pixels outside the (cropped) output.
   */
  function remapBlock(geo, rgba, u0, v0, w, h) {
    const p0 = geo.apply(u0, v0);
    const p1 = geo.apply(u0 + w - 1, v0 + h - 1);
    const ox0 = Math.max(0, Math.min(p0.x, p1.x));
    const oy0 = Math.max(0, Math.min(p0.y, p1.y));
    const ox1 = Math.min(geo.width - 1, Math.max(p0.x, p1.x));
    const oy1 = Math.min(geo.height - 1, Math.max(p0.y, p1.y));
    const ow = Math.max(0, ox1 - ox0 + 1);
    const oh = Math.max(0, oy1 - oy0 + 1);
    const out = new Uint8ClampedArray(ow * oh * 4);
    if (!ow || !oh) return { x: 0, y: 0, width: 0, height: 0, rgba: out };
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
    const dst = new Uint32Array(out.buffer);
    const [a, , , d] = geo.m;
    for (let v = 0; v < h; v++) {
      const start = geo.apply(u0, v0 + v);
      let x = start.x - ox0;
      let y = start.y - oy0;
      let i = v * w;
      for (let u = 0; u < w; u++, i++, x += a, y += d) {
        if (x >= 0 && x < ow && y >= 0 && y < oh) dst[y * ow + x] = src[i];
      }
    }
    return { x: ox0, y: oy0, width: ow, height: oh, rgba: out };
  }

  /**
   * An open HEIF file. Tiles are decoded in stored orientation (native
   * chroma layout) and the file's crop / rotation / mirroring is applied to
   * the RGBA output; width and height are reported after those transforms.
   */
  class HeifFile {
    constructor(M, bytes) {
      this.M = M;
      this.s = new Scratch(M);
      this.buf = 0;
      this.ctx = 0;
      this.handle = 0;
      this.nclx = 0;
      this.decOpts = 0;
      try {
        this.open(bytes);
      } catch (e) {
        this.close();
        throw e;
      }
    }

    open(bytes) {
      const { M, s } = this;
      this.buf = M._malloc(bytes.length);
      if (!this.buf) throw new HeifError('Out of memory while loading the file', 6, 0);
      M.HEAPU8.set(bytes, this.buf);
      this.ctx = M._heif_context_alloc();
      M._heif_context_read_from_memory_without_copy(s.err, this.ctx, this.buf, bytes.length, 0);
      s.check('Reading HEIF file');
      M._heif_context_get_primary_image_handle(s.err, this.ctx, s.out);
      s.check('Finding the main image');
      this.handle = s.outPtr();
      const handle = this.handle;

      const meta = readMetadata(s, handle);
      this.exif = meta.exif;
      this.xmp = meta.xmp;
      this.icc = readIcc(s, handle);
      this.bitDepth = M._heif_image_handle_get_luma_bits_per_pixel(handle);

      // Defaults used by libheif when a file carries no nclx box.
      this.colour = { primaries: 1, transfer: 13, matrix: 6, fullRange: true };
      M._heif_image_handle_get_nclx_color_profile(s.err, handle, s.out);
      if (!s.failed()) {
        this.nclx = s.outPtr();
        Object.assign(this.colour, parseNclx(M, this.nclx));
      }
      this.decOpts = M._heif_decoding_options_alloc();
      // Without an output profile libheif re-encodes the planes to BT.601
      // full range. Asking for the file's own profile (options v8+,
      // libheif >= 1.21) returns the decoded samples untouched.
      if (this.nclx && M.HEAPU8[this.decOpts] >= 8) {
        M.HEAP32[(this.decOpts + DECODING_OPTIONS_OUTPUT_NCLX) >> 2] = this.nclx;
      }
      // libheif's tile path mis-converts rotated 4:2:2 tiles, so tiles are
      // decoded as stored and transformed here instead.
      M.HEAPU8[this.decOpts + DECODING_OPTIONS_IGNORE_TRANSFORMATIONS] = 1;

      this.tiling = this.readTiling();
      this.geometry = this.readGeometry();
      this.transformed = !this.geometry.identity;
      this.width = this.geometry.width;
      this.height = this.geometry.height;
      this.chroma = null;
      this.decodeMs = 0;
      this.convertMs = 0;
    }

    readTiling() {
      const { M, s } = this;
      const t = M._malloc(TILING_STRUCT_SIZE);
      try {
        M.HEAPU8.fill(0, t, t + TILING_STRUCT_SIZE);
        M._heif_image_handle_get_image_tiling(s.err, this.handle, 0, t);
        const u = M.HEAPU32;
        const w = t >> 2;
        const tiling = {
          columns: u[w + 1],
          rows: u[w + 2],
          tileWidth: u[w + 3],
          tileHeight: u[w + 4],
          imageWidth: u[w + 5],
          imageHeight: u[w + 6],
          whole: false,
        };
        if (s.failed() || !tiling.columns || !tiling.rows || !tiling.tileWidth || !tiling.tileHeight || !tiling.imageWidth) {
          // Not tiled (or not understood): decode the image in one piece.
          const width = M._heif_image_handle_get_ispe_width(this.handle);
          const height = M._heif_image_handle_get_ispe_height(this.handle);
          return { columns: 1, rows: 1, tileWidth: width, tileHeight: height, imageWidth: width, imageHeight: height, whole: true };
        }
        return tiling;
      } finally {
        M._free(t);
      }
    }

    readGeometry() {
      const { M, ctx } = this;
      const geo = new Geometry(this.tiling.imageWidth, this.tiling.imageHeight);
      const itemId = M._heif_image_handle_get_item_id(this.handle);
      const count = M._heif_item_get_transformation_properties(ctx, itemId, 0, 0);
      if (count <= 0) return geo;
      const ids = M._malloc(count * 4 + 16);
      try {
        M._heif_item_get_transformation_properties(ctx, itemId, ids, count);
        for (let i = 0; i < count; i++) {
          const id = M.HEAP32[(ids >> 2) + i];
          const type = M._heif_item_get_property_type(ctx, itemId, id) >>> 0;
          if (type === FOURCC_IROT) {
            geo.rotateCcw(M._heif_item_get_property_transform_rotation_ccw(ctx, itemId, id));
          } else if (type === FOURCC_IMIR) {
            geo.mirror(M._heif_item_get_property_transform_mirror(ctx, itemId, id));
          } else if (type === FOURCC_CLAP) {
            const b = ids + count * 4; // four ints after the id list
            M._heif_item_get_property_transform_crop_borders(ctx, itemId, id, geo.width, geo.height, b, b + 4, b + 8, b + 12);
            const [left, top, right, bottom] = M.HEAP32.subarray(b >> 2, (b >> 2) + 4);
            geo.crop(left, top, right, bottom);
          }
        }
      } finally {
        M._free(ids);
      }
      return geo;
    }

    get info() {
      const c = this.colour;
      return {
        bitDepth: this.bitDepth,
        chroma: this.chroma === null ? '' : CHROMA_NAMES[this.chroma] || String(this.chroma),
        colour: { primaries: c.primaries, transfer: c.transfer, matrix: c.matrix, fullRange: c.fullRange },
        hdr: c.transfer === TRANSFER_HLG ? 'HLG' : c.transfer === TRANSFER_PQ ? 'PQ' : null,
        transformed: this.transformed,
        tiles: this.tiling.columns * this.tiling.rows,
        decodeMs: Math.round(this.decodeMs),
        convertMs: Math.round(this.convertMs),
      };
    }

    /**
     * Decode one tile and convert its visible part to RGBA.
     * Returns { x, y, width, height, rgba } in output-image coordinates.
     */
    decodeTile(tx, ty, options) {
      const { M, s } = this;
      const opts = Object.assign({ dither: true }, options);
      const t0 = now();
      if (this.tiling.whole) {
        M._heif_decode_image(s.err, this.handle, s.out, COLORSPACE_YCBCR, CHROMA_UNDEFINED, this.decOpts);
      } else {
        M._heif_image_handle_decode_image_tile(s.err, this.handle, s.out, COLORSPACE_YCBCR, CHROMA_UNDEFINED, this.decOpts, tx, ty);
      }
      s.check('Decoding image');
      const img = s.outPtr();
      try {
        const t1 = now();
        this.decodeMs += t1 - t0;

        // The matrix and range of the planes we actually got back.
        const colour = Object.assign({}, this.colour);
        M._heif_image_get_nclx_color_profile(s.err, img, s.out);
        if (!s.failed()) {
          const p = s.outPtr();
          const delivered = parseNclx(M, p);
          colour.matrix = delivered.matrix;
          colour.fullRange = delivered.fullRange;
          M._heif_nclx_color_profile_free(p);
        }

        const colorspace = M._heif_image_get_colorspace(img);
        const chroma = M._heif_image_get_chroma_format(img);
        if (this.chroma === null) this.chroma = chroma;
        let planes = null;
        if (colorspace === COLORSPACE_YCBCR || colorspace === COLORSPACE_MONO) {
          const mono = colorspace === COLORSPACE_MONO || chroma === CHROMA_MONO;
          planes = {
            y: planeView(s, img, CHANNEL_Y),
            cb: mono ? null : planeView(s, img, CHANNEL_CB),
            cr: mono ? null : planeView(s, img, CHANNEL_CR),
          };
        } else if (colorspace === COLORSPACE_RGB) {
          planes = { r: planeView(s, img, CHANNEL_R), g: planeView(s, img, CHANNEL_G), b: planeView(s, img, CHANNEL_B) };
        }
        const ref = planes && (planes.y || planes.g);
        if (!ref) throw new HeifError(`Unsupported image layout (colorspace ${colorspace}, chroma ${chroma})`, 4, 0);

        // Clip to the stored image: edge tiles of a grid extend past it.
        const t = this.tiling;
        const u0 = this.tiling.whole ? 0 : tx * t.tileWidth;
        const v0 = this.tiling.whole ? 0 : ty * t.tileHeight;
        const region = {
          sx: 0,
          sy: 0,
          width: Math.max(0, Math.min(ref.width, t.imageWidth - u0)),
          height: Math.max(0, Math.min(ref.height, t.imageHeight - v0)),
        };
        const rgba = new Uint8ClampedArray(region.width * region.height * 4);
        if (planes.r) planarRgbToRgba(planes, region, rgba);
        else yuvToRgba(planes, region, chroma, colour, rgba, opts);
        const tile = this.geometry.identity
          ? { x: u0, y: v0, width: region.width, height: region.height, rgba }
          : remapBlock(this.geometry, rgba, u0, v0, region.width, region.height);
        this.convertMs += now() - t1;
        return tile;
      } finally {
        M._heif_image_release(img);
      }
    }

    close() {
      const M = this.M;
      if (this.decOpts) M._heif_decoding_options_free(this.decOpts);
      if (this.nclx) M._heif_nclx_color_profile_free(this.nclx);
      if (this.handle) M._heif_image_handle_release(this.handle);
      if (this.ctx) M._heif_context_free(this.ctx);
      if (this.buf) M._free(this.buf);
      this.decOpts = this.nclx = this.handle = this.ctx = this.buf = 0;
      if (this.s) this.s.dispose();
      this.s = null;
    }
  }

  function openFile(M, bytes) {
    return new HeifFile(M, bytes);
  }

  /**
   * Decode the whole primary image into one RGBA buffer.
   * @returns { width, height, rgba, exif, xmp, icc, info }
   */
  function decode(M, bytes, options) {
    const file = new HeifFile(M, bytes);
    try {
      const { width, height } = file;
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let ty = 0; ty < file.tiling.rows; ty++) {
        for (let tx = 0; tx < file.tiling.columns; tx++) {
          const tile = file.decodeTile(tx, ty, options);
          for (let y = 0; y < tile.height; y++) {
            const src = tile.rgba.subarray(y * tile.width * 4, (y + 1) * tile.width * 4);
            rgba.set(src, ((tile.y + y) * width + tile.x) * 4);
          }
        }
      }
      return { width, height, rgba, exif: file.exif, xmp: file.xmp, icc: file.icc, info: file.info };
    } finally {
      file.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Colour conversion
  // ---------------------------------------------------------------------------

  /** Kr/Kb for the H.273 matrix_coefficients values we know about. */
  function lumaCoefficients(matrix) {
    switch (matrix) {
      case 1: return [0.2126, 0.0722]; // BT.709
      case 4: return [0.30, 0.11]; // FCC
      case 5:
      case 6: return [0.299, 0.114]; // BT.601
      case 7: return [0.212, 0.087]; // SMPTE 240M
      case 9:
      case 10: return [0.2627, 0.0593]; // BT.2020
      default: return [0.299, 0.114];
    }
  }

  const DITHER_SIZE = 1 << 16;
  let ditherTable = null;
  let silentTable = null;
  function getDither(enabled) {
    if (!enabled) return silentTable || (silentTable = new Float32Array(DITHER_SIZE));
    if (!ditherTable) {
      // Uniform noise of +-0.5 LSB. It breaks up banding when the 10-bit
      // gradients are quantised to 8 bits and, unlike ordered dither, keeps
      // enough low-frequency energy to survive JPEG compression.
      ditherTable = new Float32Array(DITHER_SIZE);
      let s = 0x9e3779b9;
      for (let i = 0; i < DITHER_SIZE; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        ditherTable[i] = ((s >>> 0) / 4294967296) - 0.5;
      }
    }
    return ditherTable;
  }

  /**
   * Upsample chroma for luma row `y`, columns sx..sx+width-1, normalised to
   * -0.5..0.5. Chroma samples are horizontally co-sited with even luma
   * samples and, for 4:2:0, vertically centred between luma rows
   * (H.273 chroma location 0).
   */
  function chromaRow(plane, y, chroma, sx, width, offset, scale, out) {
    const d = plane.data;
    const stride = plane.stride;
    if (chroma === CHROMA_444) {
      const base = y * stride + sx;
      for (let i = 0; i < width; i++) out[i] = (d[base + i] - offset) * scale;
      return;
    }
    const last = plane.width - 1;
    if (chroma === CHROMA_420) {
      const ch = plane.height;
      const j = Math.min(y >> 1, ch - 1);
      const other = y & 1 ? Math.min(j + 1, ch - 1) : Math.max(j - 1, 0);
      const r0 = j * stride;
      const r1 = other * stride;
      for (let i = 0; i < width; i++) {
        const x = sx + i;
        const c = x >> 1;
        let v = d[r0 + c] * 0.75 + d[r1 + c] * 0.25;
        if (x & 1) {
          const n = c < last ? c + 1 : last;
          v = (v + d[r0 + n] * 0.75 + d[r1 + n] * 0.25) * 0.5;
        }
        out[i] = (v - offset) * scale;
      }
      return;
    }
    // 4:2:2
    const r0 = y * stride;
    for (let i = 0; i < width; i++) {
      const x = sx + i;
      const c = x >> 1;
      let v = d[r0 + c];
      if (x & 1) v = (v + d[r0 + (c < last ? c + 1 : last)]) * 0.5;
      out[i] = (v - offset) * scale;
    }
  }

  function buildLut(fn, size) {
    const lut = new Float32Array(size + 2);
    for (let i = 0; i <= size + 1; i++) lut[i] = fn(Math.min(i / size, 1));
    return lut;
  }

  function lutLookup(lut, size, v) {
    if (v <= 0) return lut[0];
    if (v >= 1) return lut[size];
    const t = v * size;
    const i = t | 0;
    return lut[i] + (lut[i + 1] - lut[i]) * (t - i);
  }

  function hlgInverseOetf(e) {
    const a = 0.17883277;
    const b = 0.28466892;
    const c = 0.55991073;
    return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - c) / a) + b) / 12;
  }

  function pqEotf(e) {
    const m1 = 0.1593017578125;
    const m2 = 78.84375;
    const c1 = 0.8359375;
    const c2 = 18.8515625;
    const c3 = 18.6875;
    const p = Math.pow(e, 1 / m2);
    return Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1); // 1.0 = 10000 nits
  }

  function srgbEotf(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function srgbOetf(v) {
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  const GAMUT_TO_709 = {
    [PRIMARIES_BT2020]: [
      1.660491, -0.587641, -0.072850,
      -0.124550, 1.132900, -0.008349,
      -0.018151, -0.100579, 1.118730,
    ],
    [PRIMARIES_P3]: [
      1.224940, -0.224940, 0.0,
      -0.042057, 1.042057, 0.0,
      -0.019638, -0.078636, 1.098274,
    ],
  };

  /**
   * Smoothly compresses values above `knee` so that `peak` maps to 1.0.
   * Identity below the knee and continuous in slope at the knee.
   */
  function makeToneCurve(knee, peak) {
    const range = 1 - knee;
    const w = Math.max((peak - knee) / range, 1.0001);
    const w2 = w * w;
    return (m) => {
      if (m <= knee) return m;
      const u = (m - knee) / range;
      return knee + range * Math.min((u * (1 + u / w2)) / (1 + u), 1);
    };
  }

  const LUT_SIZE = 4096;
  const linearCache = new Map();

  /** Look-up tables for the linear-light (HDR / wide gamut) path, built once per colour setup. */
  function linearSetup(colour) {
    const key = `${colour.transfer}/${colour.primaries}`;
    let setup = linearCache.get(key);
    if (setup) return setup;
    const hdr = colour.transfer === TRANSFER_HLG || colour.transfer === TRANSFER_PQ;
    let toLinear;
    let peak = 1;
    if (colour.transfer === TRANSFER_HLG) {
      toLinear = buildLut(hlgInverseOetf, LUT_SIZE); // scene light 0..1
      peak = HLG_PEAK / HDR_REFERENCE_WHITE;
    } else if (colour.transfer === TRANSFER_PQ) {
      toLinear = buildLut((e) => (pqEotf(e) * 10000) / HDR_REFERENCE_WHITE, LUT_SIZE);
      peak = 1000 / HDR_REFERENCE_WHITE; // typical mastering peak
    } else {
      toLinear = buildLut(srgbEotf, LUT_SIZE);
    }
    const bt2020 = colour.primaries === PRIMARIES_BT2020;
    setup = {
      toLinear,
      // HLG OOTF for a 1000-nit display, Fd = Lw * Ys^(gamma-1) * Es with
      // gamma 1.2, expressed relative to reference white.
      ootf: colour.transfer === TRANSFER_HLG ? buildLut((v) => Math.pow(v, 0.2), LUT_SIZE) : null,
      hlgGain: HLG_PEAK / HDR_REFERENCE_WHITE,
      // Wide-gamut SDR is only clipped; HDR highlights are compressed above the knee.
      knee: hdr ? TONE_KNEE : Infinity,
      tone: hdr ? makeToneCurve(TONE_KNEE, peak) : null,
      toSrgb: buildLut(srgbOetf, LUT_SIZE),
      gamut: GAMUT_TO_709[colour.primaries] || [1, 0, 0, 0, 1, 0, 0, 0, 1],
      lr: bt2020 ? 0.2627 : 0.2126,
      lb: bt2020 ? 0.0593 : 0.0722,
    };
    linearCache.set(key, setup);
    return setup;
  }

  /**
   * Convert a region of Y'CbCr planes to RGBA (8-bit sRGB).
   * region: { sx, sy, width, height } in plane (luma) coordinates.
   */
  function yuvToRgba(planes, region, chroma, colour, out, opts) {
    const { sx, sy, width, height } = region;
    const yp = planes.y;
    const bits = yp.bits;
    const max = (1 << bits) - 1;
    const half = 1 << (bits - 1);
    const shift = 1 << (bits - 8);
    const yOff = colour.fullRange ? 0 : 16 * shift;
    const yScale = colour.fullRange ? 1 / max : 1 / (219 * shift);
    const cScale = colour.fullRange ? 1 / max : 1 / (224 * shift);
    const identity = colour.matrix === 0;
    const [kr, kb] = lumaCoefficients(colour.matrix);
    const kg = 1 - kr - kb;
    const crR = 2 * (1 - kr);
    const cbB = 2 * (1 - kb);
    const cbG = (cbB * kb) / kg;
    const crG = (crR * kr) / kg;

    const hasChroma = !!(planes.cb && planes.cr);
    const cbRow = new Float32Array(width);
    const crRow = new Float32Array(width);
    const dither = getDither(opts.dither);
    const dmask = DITHER_SIZE - 1;
    const yd = yp.data;
    const ys = yp.stride;

    const linear = colour.transfer === TRANSFER_HLG || colour.transfer === TRANSFER_PQ || !!GAMUT_TO_709[colour.primaries];
    const L = linear ? linearSetup(colour) : null;

    for (let row = 0; row < height; row++) {
      const y = sy + row;
      if (hasChroma) {
        chromaRow(planes.cb, y, chroma, sx, width, half, cScale, cbRow);
        chromaRow(planes.cr, y, chroma, sx, width, half, cScale, crRow);
      }
      let n = (Math.random() * DITHER_SIZE) | 0;
      let o = row * width * 4;
      const base = y * ys + sx;
      if (!linear) {
        // SDR fast path: Y'CbCr -> R'G'B' with the source transfer kept as is.
        for (let x = 0; x < width; x++) {
          const l = (yd[base + x] - yOff) * yScale;
          const cb = cbRow[x];
          const cr = crRow[x];
          let r, g, b;
          if (identity) {
            g = l; b = cb + 0.5; r = cr + 0.5;
          } else {
            r = l + crR * cr;
            g = l - cbG * cb - crG * cr;
            b = l + cbB * cb;
          }
          out[o] = r * 255 + dither[n & dmask];
          out[o + 1] = g * 255 + dither[(n + 1) & dmask];
          out[o + 2] = b * 255 + dither[(n + 2) & dmask];
          out[o + 3] = 255;
          o += 4;
          n += 3;
        }
        continue;
      }
      // Linear-light path for HDR (HLG / PQ) and wide-gamut sources: decode
      // the transfer function, map to BT.709 primaries, tone map HDR
      // highlights into SDR range and re-encode with the sRGB curve.
      const { toLinear, ootf, hlgGain, knee, tone, toSrgb, gamut: m, lr, lb } = L;
      const lg = 1 - lr - lb;
      for (let x = 0; x < width; x++) {
        const l = (yd[base + x] - yOff) * yScale;
        const cb = cbRow[x];
        const cr = crRow[x];
        let r, g, b;
        if (identity) {
          g = l; b = cb + 0.5; r = cr + 0.5;
        } else {
          r = l + crR * cr;
          g = l - cbG * cb - crG * cr;
          b = l + cbB * cb;
        }
        let R = lutLookup(toLinear, LUT_SIZE, r);
        let G = lutLookup(toLinear, LUT_SIZE, g);
        let B = lutLookup(toLinear, LUT_SIZE, b);
        if (ootf) {
          const k = hlgGain * lutLookup(ootf, LUT_SIZE, lr * R + lg * G + lb * B);
          R *= k; G *= k; B *= k;
        }
        let R2 = m[0] * R + m[1] * G + m[2] * B;
        let G2 = m[3] * R + m[4] * G + m[5] * B;
        let B2 = m[6] * R + m[7] * G + m[8] * B;
        const mx = R2 > G2 ? (R2 > B2 ? R2 : B2) : (G2 > B2 ? G2 : B2);
        if (mx > knee) {
          const s = tone(mx) / mx;
          R2 *= s; G2 *= s; B2 *= s;
        }
        out[o] = lutLookup(toSrgb, LUT_SIZE, R2) * 255 + dither[n & dmask];
        out[o + 1] = lutLookup(toSrgb, LUT_SIZE, G2) * 255 + dither[(n + 1) & dmask];
        out[o + 2] = lutLookup(toSrgb, LUT_SIZE, B2) * 255 + dither[(n + 2) & dmask];
        out[o + 3] = 255;
        o += 4;
        n += 3;
      }
    }
  }

  function planarRgbToRgba(planes, region, out) {
    const { r, g, b } = planes;
    const { sx, sy, width, height } = region;
    const scale = 255 / ((1 << r.bits) - 1);
    for (let row = 0; row < height; row++) {
      let o = row * width * 4;
      for (let x = 0; x < width; x++) {
        const i = (sy + row) * r.stride + sx + x;
        out[o] = r.data[i] * scale;
        out[o + 1] = g.data[i] * scale;
        out[o + 2] = b.data[i] * scale;
        out[o + 3] = 255;
        o += 4;
      }
    }
  }

  /** Quick check of the ISO-BMFF 'ftyp' box for HEIF brands. */
  function looksLikeHeif(bytes) {
    if (bytes.length < 12) return false;
    const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (type !== 'ftyp') return false;
    const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(size || bytes.length, bytes.length);
    const brands = [];
    for (let i = 8; i + 4 <= end; i += 4) {
      if (i === 12) continue; // minor version
      brands.push(String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]));
    }
    return brands.some((b) => /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|mif2|avif)$/.test(b));
  }

  const api = { openFile, decode, looksLikeHeif, HeifError, makeToneCurve };
  root.HifCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
