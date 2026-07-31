/**
 * ESC/POS command builders for Phomemo thermal printers.
 *
 * ## Provenance — please read before editing
 *
 * Everything in the `initialise`/`feed`/`rasterHeader` group is the **public
 * EPSON ESC/POS command set**, documented by Epson and implemented in dozens of
 * permissively-licensed projects. Those bytes are standard.
 *
 * The `PHOMEMO_*` constants are **not** part of that specification. They are
 * vendor framing, named and exported individually so a bring-up session can
 * determine which are actually required.
 *
 * ### Licensing
 *
 * This file is written from the EPSON ESC/POS reference, this project's own wire
 * captures, and **published protocol descriptions** of the Phomemo command set.
 * No source code has been read from or copied out of `vivier/phomemo-tools`
 * (GPL-3) or `phomemo-printer` (GPL-2), whose terms are incompatible with this
 * package's MIT licence.
 *
 * The distinction matters and is deliberate: a command byte and its meaning is a
 * fact about a device, not authorship, and interoperability information is not
 * protected by copyright. Copying someone's *implementation* of that protocol
 * would be. So facts are fair game; their code is not, and none of it is here.
 */

/** ESC @ — reset to power-on defaults. Always the first thing sent. */
export const initialise = (): Uint8Array => new Uint8Array([0x1b, 0x40]);

/**
 * ESC 3 n — set line spacing in dots.
 *
 * Affects `ESC d` (feed by lines), not the raster pitch. Mostly useful for
 * making `feedLines` predictable.
 */
export const lineSpacing = (dots: number): Uint8Array =>
  new Uint8Array([0x1b, 0x33, dots & 0xff]);

/**
 * ESC J n — print and feed n dots (0..255).
 *
 * Preferred over `feedLines` because the unit is unambiguous: dots are the same
 * unit the raster uses, whereas "lines" depends on the current line spacing.
 */
export const feedDots = (dots: number): Uint8Array =>
  new Uint8Array([0x1b, 0x4a, Math.max(0, Math.min(255, dots)) & 0xff]);

/** ESC d n — print and feed n lines, whose height depends on `lineSpacing`. */
export const feedLines = (lines: number): Uint8Array =>
  new Uint8Array([0x1b, 0x64, Math.max(0, Math.min(255, lines)) & 0xff]);

/**
 * GS v 0 m xL xH yL yH — raster bit-image header. The payload follows
 * immediately: `bytesPerLine * lines` bytes, MSB-first, bit set = black.
 *
 * Both counts are little-endian u16. `mode` 0 is normal size; 1/2/3 are the
 * double-width/height variants, which we never use because scaling a 1-bit
 * image is exactly what we avoid elsewhere.
 */
export const rasterHeader = (bytesPerLine: number, lines: number, mode = 0): Uint8Array =>
  new Uint8Array([
    0x1d,
    0x76,
    0x30,
    mode & 0x03,
    bytesPerLine & 0xff,
    (bytesPerLine >> 8) & 0xff,
    lines & 0xff,
    (lines >> 8) & 0xff,
  ]);

/**
 * DLE EOT n — real-time status request.
 *
 * Part of the ESC/POS specification, but whether a given Phomemo firmware answers
 * it is unknown. If it does, it is the only route to genuine printer-buffer flow
 * control on a device that otherwise never acknowledges anything — so it is worth
 * probing on connect.
 */
export const statusRequest = (kind = 1): Uint8Array =>
  new Uint8Array([0x10, 0x04, kind & 0xff]);

/**
 * ESC a n — justification. 0 = left.
 *
 * Documented as part of the Phomemo header sequence, immediately after `ESC @`.
 */
export const justify = (mode = 0): Uint8Array =>
  new Uint8Array([0x1b, 0x61, mode & 0x03]);

/**
 * ESC N 4 n — print density / head energy, n = 1..15.
 *
 * Documented for the Phomemo M110/M120/M220 label printers. **Unverified on the
 * T02**, which may ignore it entirely; harmless to send either way, since an
 * unrecognised command has so far produced only a `01 01` ack.
 *
 * Worth having because a long solid-black job on a T02 fades badly through the
 * middle — consistent with the supply sagging under sustained full-width current.
 * If that is the cause, more energy per dot will not fix it and may worsen it;
 * this exists to establish which.
 */
export const setDensity = (level: number): Uint8Array =>
  new Uint8Array([0x1b, 0x4e, 0x04, Math.max(1, Math.min(15, level)) & 0xff]);

/**
 * ESC N 13 n — print speed, n = 1..5. Same provenance and caveats as
 * {@link setDensity}: documented for the M110 family, unverified on the T02.
 *
 * A slower head has longer per-dot dwell time, which is the other lever on a
 * fading solid fill.
 */
export const setSpeed = (level: number): Uint8Array =>
  new Uint8Array([0x1b, 0x4e, 0x0d, Math.max(1, Math.min(5, level)) & 0xff]);

/**
 * Vendor framing: the `0x1f 0x11` family.
 *
 * These are NOT in the EPSON specification. Public reverse-engineering
 * documentation records them as an end-of-job **footer**, sent after the final
 * feed, and does not state what each one does individually.
 *
 * Correction to this file's earlier revision: it carried a `PHOMEMO_PROLOGUE` of
 * `1f 11 02 04` described as observed. That was wrong on both counts — the value
 * was inferred rather than captured, and the documented `1f 11` commands belong
 * at the end of a job, not the start. On real hardware it drew a distinct `1a 0f
 * 0c` reply that no other command produced, which is consistent with the printer
 * rejecting it. It is gone; `vendorFraming` now means the documented footer.
 */
export const PHOMEMO_FOOTER = [
  new Uint8Array([0x1f, 0x11, 0x08]),
  new Uint8Array([0x1f, 0x11, 0x0e]),
  new Uint8Array([0x1f, 0x11, 0x07]),
  new Uint8Array([0x1f, 0x11, 0x09]),
] as const;

/** @deprecated Kept only so the constant resolves; sends nothing. */
export const PHOMEMO_EPILOGUE_A = PHOMEMO_FOOTER[0];
/** @deprecated Use {@link PHOMEMO_FOOTER}. */
export const PHOMEMO_EPILOGUE_B = PHOMEMO_FOOTER[1];

/** Concatenate command segments into one buffer. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
