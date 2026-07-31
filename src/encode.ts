/**
 * Bitmap -> ESC/POS raster segments.
 *
 * The contrast with the Niimbot encoder is stark and worth stating, because it
 * drives every design choice here: Niimbot sends one framed, checksummed packet
 * per row with a run-length count, so a mostly-white label collapses to a few
 * dozen packets. ESC/POS sends a **contiguous raster** with a single header per
 * block, so vertical whitespace costs full price. A 384x800 job is exactly
 * 38,400 raster bytes whatever it contains.
 *
 * Two consequences:
 *  - There is no per-row compression to exploit, so throughput is bounded by the
 *    link and the head, which is why pacing matters far more here.
 *  - Peak memory is worth caring about, hence the streaming generator.
 */

import { PrinterError } from 'react-native-thermal-ble';
import { blankBitmap1, type Bitmap1 } from 'react-native-thermal-ble';
import { fitToPrinthead, padToWidth, type HorizontalAlign } from 'react-native-thermal-ble';
import {
  PHOMEMO_FOOTER,
  feedDots,
  feedLines,
  initialise,
  justify,
  rasterHeader,
} from './escpos';

/** T02 printhead: 384 dots = 48 bytes per line. */
export const DEFAULT_BYTES_PER_LINE = 48;

/**
 * `GS v 0` carries the line count as a u16, but firmwares are commonly limited
 * to 255 lines per block, so that is the conservative default. Raise it per model
 * only once a longer block is proven on hardware.
 */
export const DEFAULT_MAX_BLOCK_LINES = 255;

/** How the image is reconciled with the printhead width when they differ. */
export type FitMode = 'strict' | 'clip' | 'pad-left' | 'pad-center' | 'pad-right';

export interface EscPosEncodeOptions {
  /** Bytes per raster line. Default 48 (384 dots). */
  bytesPerLine?: number;
  /** Maximum lines in a single `GS v 0` block. Default 255. */
  maxBlockLines?: number;
  /**
   * Dots to feed after the last block, so the print clears the tear bar.
   * Default 80, about 10 mm at 203 dpi.
   */
  feedDots?: number;
  /**
   * Which feed command ends the job. Default `'lines'` (`ESC d`), which is what
   * the documented Phomemo footer uses; `'dots'` (`ESC J`) is kept for
   * comparison, and moved no paper on a real T02.
   */
  feedUnit?: 'lines' | 'dots';
  /**
   * Emit the documented `0x1f 0x11` end-of-job footer. Default true; turn off to
   * isolate whether the printer needs it.
   */
  vendorFraming?: boolean;
  /**
   * What to do when the bitmap is not exactly the printhead width.
   *
   * Narrower images are padded (default centred). Wider ones throw under
   * `strict`, mirroring the Niimbot guard — a silently cropped label is worse
   * than a refused one. `clip` opts into cropping and reports how much went.
   */
  fit?: FitMode;
}

export interface EscPosJob {
  /** Wire segments in order: header, raster blocks, footer. */
  segments: Uint8Array[];
  bytesPerLine: number;
  /** Rows of raster actually emitted. */
  lines: number;
  blocks: number;
  byteLength: number;
  /** Columns lost to `fit: 'clip'`, else 0. */
  clipped: number;
}

interface Resolved {
  bytesPerLine: number;
  maxBlockLines: number;
  feed: number;
  feedUnit: 'lines' | 'dots';
  vendorFraming: boolean;
  fit: FitMode;
}

function resolve(opts: EscPosEncodeOptions = {}): Resolved {
  return {
    bytesPerLine: opts.bytesPerLine ?? DEFAULT_BYTES_PER_LINE,
    maxBlockLines: Math.max(1, opts.maxBlockLines ?? DEFAULT_MAX_BLOCK_LINES),
    feed: opts.feedDots ?? 80,
    feedUnit: opts.feedUnit ?? 'lines',
    vendorFraming: opts.vendorFraming ?? true,
    fit: opts.fit ?? 'strict',
  };
}

/**
 * Bring a bitmap to exactly `bytesPerLine * 8` dots wide.
 *
 * Reuses the shared transforms rather than reimplementing: `padToWidth` is
 * bit-exact, and `blankBitmap1` already zero-fills, so the padding bits past the
 * image are white for free.
 */
function fitWidth(
  bmp: Bitmap1,
  r: Resolved,
): { bitmap: Bitmap1; clipped: number } {
  const target = r.bytesPerLine * 8;
  if (bmp.width === target) return { bitmap: bmp, clipped: 0 };

  if (bmp.width > target) {
    if (r.fit === 'clip') {
      const { bitmap, clipped } = fitToPrinthead(bmp, target);
      return { bitmap, clipped };
    }
    throw new PrinterError(
      'INVALID_IMAGE',
      `Image is ${bmp.width} px wide but the printhead is ${target} px. The printer ` +
        `would silently drop the right edge — crop it, rotate it, or pass fit: 'clip'.`,
      { width: bmp.width, printheadPixels: target },
    );
  }

  const align: HorizontalAlign =
    r.fit === 'pad-left' ? 'left' : r.fit === 'pad-right' ? 'right' : 'center';
  return { bitmap: padToWidth(bmp, target, align), clipped: 0 };
}

/**
 * One raster block: header plus a contiguous slice of packed rows.
 *
 * `Bitmap1` is MSB-first with 1 = black, which is exactly `GS v 0`'s layout — so
 * the rows copy verbatim with no bit twiddling. (Same reason `toPbm` can.)
 */
function block(bmp: Bitmap1, firstRow: number, lines: number, bytesPerLine: number): Uint8Array {
  const header = rasterHeader(bytesPerLine, lines);
  const out = new Uint8Array(header.length + bytesPerLine * lines);
  out.set(header, 0);

  for (let i = 0; i < lines; i++) {
    const src = (firstRow + i) * bmp.stride;
    // The bitmap's stride matches bytesPerLine after fitWidth, but copy the
    // minimum of the two so a mismatch truncates rather than reading past the end.
    const copy = Math.min(bytesPerLine, bmp.stride);
    out.set(bmp.data.subarray(src, src + copy), header.length + i * bytesPerLine);
  }
  return out;
}

/**
 * Encode a bitmap, materialising every segment.
 *
 * Convenient for tests and golden vectors. For printing prefer
 * {@link escPosSegments}, whose peak memory is a single block.
 */
export function encodeEscPosRaster(bmp: Bitmap1, opts: EscPosEncodeOptions = {}): EscPosJob {
  const r = resolve(opts);
  const { bitmap, clipped } = fitWidth(bmp, r);

  // Documented header: reset, then left-justify. No vendor command belongs here.
  const segments: Uint8Array[] = [initialise(), justify(0)];

  let blocks = 0;
  for (let row = 0; row < bitmap.height; row += r.maxBlockLines) {
    const lines = Math.min(r.maxBlockLines, bitmap.height - row);
    segments.push(block(bitmap, row, lines, r.bytesPerLine));
    blocks++;
  }

  segments.push(...jobFeed(r));
  if (r.vendorFraming) segments.push(...PHOMEMO_FOOTER);

  let byteLength = 0;
  for (const s of segments) byteLength += s.length;

  return {
    segments,
    bytesPerLine: r.bytesPerLine,
    lines: bitmap.height,
    blocks,
    byteLength,
    clipped,
  };
}

/**
 * Streaming encoder: yields the same segments without holding the whole job.
 *
 * Peak memory is one block — 12,240 bytes at the defaults — rather than the full
 * 38 kB of a long label.
 */
export function* escPosSegments(
  bmp: Bitmap1,
  opts: EscPosEncodeOptions = {},
): Generator<Uint8Array> {
  const r = resolve(opts);
  const { bitmap } = fitWidth(bmp, r);

  yield initialise();
  yield justify(0);

  for (let row = 0; row < bitmap.height; row += r.maxBlockLines) {
    const lines = Math.min(r.maxBlockLines, bitmap.height - row);
    yield block(bitmap, row, lines, r.bytesPerLine);
  }

  for (const segment of jobFeed(r)) yield segment;
  if (r.vendorFraming) yield* PHOMEMO_FOOTER;
}

/**
 * The end-of-job feed, clear of the tear bar.
 *
 * `ESC d` (feed **lines**) rather than `ESC J` (feed **dots**): the documented
 * Phomemo footer uses `ESC d`, and on a real T02 `ESC J` moved no paper at all —
 * so it appears simply not to be implemented on this firmware, whatever the
 * general specification says. `feedUnit` selects, for the sake of a bring-up
 * session that needs to compare them directly.
 */
function jobFeed(r: { feed: number; feedUnit: 'lines' | 'dots' }): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (r.feedUnit === 'dots') {
    let remaining = r.feed;
    while (remaining > 0) {
      const step = Math.min(255, remaining);
      out.push(feedDots(step));
      remaining -= step;
    }
    return out;
  }
  // One "line" is the current line spacing; the default is 24-ish dots, so the
  // count is small. Kept conservative rather than converted, since the spacing
  // is not something we set.
  const lines = Math.max(1, Math.min(255, Math.ceil(r.feed / 24)));
  out.push(feedLines(lines));
  return out;
}

/** A blank label of a given dot height — useful for feeding or spacing tests. */
export function blankLabel(bytesPerLine: number, lines: number): Bitmap1 {
  return blankBitmap1(bytesPerLine * 8, lines);
}

/**
 * Raster bytes a job of this height will occupy, excluding framing.
 *
 * Independent of content — that is the point of an uncompressed raster, and the
 * reason a Phomemo job is so much larger than the Niimbot equivalent.
 */
export function rasterByteLength(bmp: Bitmap1, bytesPerLine = DEFAULT_BYTES_PER_LINE): number {
  return bytesPerLine * bmp.height;
}
