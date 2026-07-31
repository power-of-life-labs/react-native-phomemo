/**
 * ESC/POS stream decoder.
 *
 * This exists to make the strongest possible offline assertion: decode the bytes
 * we would put on the wire back into a bitmap and compare it with the input. A
 * round-trip catches bit order, stride, block boundaries and u16 endianness in
 * one go, whereas a golden hex vector only pins current behaviour — including
 * current bugs.
 *
 * It is also the natural place to interpret whatever the printer sends back on
 * its notify characteristic, once we learn what that is.
 */

import { blankBitmap1, setPixel, strideFor, type Bitmap1 } from 'react-native-thermal-ble';

export type EscPosCommand =
  | { kind: 'init' }
  | { kind: 'lineSpacing'; dots: number }
  | { kind: 'feedDots'; dots: number }
  | { kind: 'feedLines'; lines: number }
  | { kind: 'justify'; mode: number }
  | { kind: 'statusRequest'; sub: number }
  | { kind: 'raster'; bytesPerLine: number; lines: number; mode: number; data: Uint8Array }
  | { kind: 'vendor'; bytes: Uint8Array }
  | { kind: 'unknown'; bytes: Uint8Array };

/**
 * Decode a command stream.
 *
 * Deliberately tolerant: an unrecognised byte becomes a one-byte `unknown`
 * rather than throwing, so a partially-understood capture from a new firmware
 * still yields the parts we do understand.
 */
export function parseEscPosStream(bytes: Uint8Array): EscPosCommand[] {
  const out: EscPosCommand[] = [];
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i]!;

    // ESC (0x1b) …
    if (b === 0x1b && i + 1 < bytes.length) {
      const op = bytes[i + 1]!;
      if (op === 0x40) {
        out.push({ kind: 'init' });
        i += 2;
        continue;
      }
      if (op === 0x33 && i + 2 < bytes.length) {
        out.push({ kind: 'lineSpacing', dots: bytes[i + 2]! });
        i += 3;
        continue;
      }
      if (op === 0x4a && i + 2 < bytes.length) {
        out.push({ kind: 'feedDots', dots: bytes[i + 2]! });
        i += 3;
        continue;
      }
      if (op === 0x64 && i + 2 < bytes.length) {
        out.push({ kind: 'feedLines', lines: bytes[i + 2]! });
        i += 3;
        continue;
      }
      if (op === 0x61 && i + 2 < bytes.length) {
        out.push({ kind: 'justify', mode: bytes[i + 2]! });
        i += 3;
        continue;
      }
    }

    // GS v 0 (0x1d 0x76 0x30) — raster block.
    if (b === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30 && i + 7 < bytes.length) {
      const mode = bytes[i + 3]!;
      const bytesPerLine = bytes[i + 4]! | (bytes[i + 5]! << 8);
      const lines = bytes[i + 6]! | (bytes[i + 7]! << 8);
      const start = i + 8;
      const need = bytesPerLine * lines;
      // A truncated payload is a real bug worth surfacing, not silently padding.
      if (start + need > bytes.length) {
        out.push({ kind: 'unknown', bytes: bytes.subarray(i) });
        break;
      }
      out.push({
        kind: 'raster',
        bytesPerLine,
        lines,
        mode,
        data: bytes.subarray(start, start + need),
      });
      i = start + need;
      continue;
    }

    // Vendor framing: 0x1f 0x11 <sub>. All documented members of the family are
    // three bytes; nothing here takes an argument.
    if (b === 0x1f && bytes[i + 1] === 0x11 && i + 2 < bytes.length) {
      const length = 3;
      if (i + length <= bytes.length) {
        out.push({ kind: 'vendor', bytes: bytes.subarray(i, i + length) });
        i += length;
        continue;
      }
    }

    // DLE EOT n — status request.
    if (b === 0x10 && bytes[i + 1] === 0x04 && i + 2 < bytes.length) {
      out.push({ kind: 'statusRequest', sub: bytes[i + 2]! });
      i += 3;
      continue;
    }

    out.push({ kind: 'unknown', bytes: bytes.subarray(i, i + 1) });
    i += 1;
  }

  return out;
}

/**
 * Reassemble the raster blocks of a stream into a single bitmap.
 *
 * Blocks are concatenated in order, which is exactly how the printer consumes
 * them, so this reverses {@link escPosSegments} precisely.
 */
export function bitmapFromEscPosStream(bytes: Uint8Array, width?: number): Bitmap1 {
  const blocks = parseEscPosStream(bytes).filter(
    (c): c is Extract<EscPosCommand, { kind: 'raster' }> => c.kind === 'raster',
  );
  if (blocks.length === 0) return blankBitmap1(width ?? 0, 0);

  const bytesPerLine = blocks[0]!.bytesPerLine;
  const totalLines = blocks.reduce((n, b) => n + b.lines, 0);
  const outWidth = width ?? bytesPerLine * 8;
  const bmp = blankBitmap1(outWidth, totalLines);

  let row = 0;
  for (const b of blocks) {
    if (b.bytesPerLine !== bytesPerLine) {
      throw new Error(
        `Inconsistent bytesPerLine across blocks: ${bytesPerLine} then ${b.bytesPerLine}`,
      );
    }
    for (let line = 0; line < b.lines; line++) {
      for (let x = 0; x < outWidth; x++) {
        const byte = b.data[line * bytesPerLine + (x >> 3)] ?? 0;
        if ((byte & (0x80 >> (x & 7))) !== 0) setPixel(bmp, x, row, true);
      }
      row++;
    }
  }
  return bmp;
}

/** Total raster bytes across all blocks, for size assertions. */
export function rasterBytesIn(bytes: Uint8Array): number {
  return parseEscPosStream(bytes)
    .filter((c) => c.kind === 'raster')
    .reduce((n, c) => n + (c as Extract<EscPosCommand, { kind: 'raster' }>).data.length, 0);
}

/** Line counts of each raster block, in order — the block-splitting assertion. */
export function blockLineCounts(bytes: Uint8Array): number[] {
  return parseEscPosStream(bytes)
    .filter((c) => c.kind === 'raster')
    .map((c) => (c as Extract<EscPosCommand, { kind: 'raster' }>).lines);
}

/** Bytes per line the stream declares, or null when it has no raster. */
export function declaredBytesPerLine(bytes: Uint8Array): number | null {
  const first = parseEscPosStream(bytes).find((c) => c.kind === 'raster');
  return first ? (first as Extract<EscPosCommand, { kind: 'raster' }>).bytesPerLine : null;
}

/** Sanity helper mirroring `strideFor`, so callers can check width assumptions. */
export const bytesPerLineFor = (widthPx: number): number => strideFor(widthPx);
