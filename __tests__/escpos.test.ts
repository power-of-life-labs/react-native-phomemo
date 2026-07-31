/**
 * ESC/POS encoder tests.
 *
 * The load-bearing assertion here is the ROUND TRIP: encode a bitmap, decode the
 * wire bytes back, and require the result to equal the input. That single check
 * covers bit order, stride, block boundaries and u16 endianness — all four of the
 * ways this can silently produce a garbled label. Golden hex is used only to pin
 * the framing bytes, where the whole point is that they must not drift.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blankBitmap1, getPixel, setPixel, toBitmap1, type SourceImage } from 'react-native-thermal-ble';
import { hex } from 'react-native-thermal-ble';
import { chunk } from 'react-native-thermal-ble';
import {
  PHOMEMO_FOOTER,
  concat,
  feedDots,
  feedLines,
  initialise,
  justify,
  rasterHeader,
  statusRequest,
} from '../src/escpos';
import {
  DEFAULT_BYTES_PER_LINE,
  encodeEscPosRaster,
  escPosSegments,
  rasterByteLength,
} from '../src/encode';
import {
  bitmapFromEscPosStream,
  blockLineCounts,
  declaredBytesPerLine,
  parseEscPosStream,
  rasterBytesIn,
} from '../src/parse';
import { PrinterError } from 'react-native-thermal-ble';

const WIDTH = DEFAULT_BYTES_PER_LINE * 8; // 384

/** A deterministic, hard-to-get-accidentally-right pattern. */
function pattern(width: number, height: number): Bitmap1Like {
  const bmp = blankBitmap1(width, height);
  for (let y = 0; y < height; y++) {
    setPixel(bmp, 0, y, true); // left reference column
    setPixel(bmp, width - 1, y, true); // right edge — catches truncation
    setPixel(bmp, (y * 7) % width, y, true); // diagonal — catches row mixing
    if (y % 3 === 0) setPixel(bmp, 1, y, true);
  }
  return bmp;
}
type Bitmap1Like = ReturnType<typeof blankBitmap1>;

describe('escpos command builders', () => {
  it('ESC @ initialises', () => {
    assert.equal(hex(initialise()), '1b 40');
  });

  it('ESC J feeds by dots, clamped to one byte', () => {
    assert.equal(hex(feedDots(80)), '1b 4a 50');
    assert.equal(hex(feedDots(999)), '1b 4a ff');
    assert.equal(hex(feedDots(-5)), '1b 4a 00');
  });

  it('GS v 0 encodes both counts little-endian', () => {
    // 48 bytes/line, 255 lines.
    assert.equal(hex(rasterHeader(48, 255)), '1d 76 30 00 30 00 ff 00');
    // 300 lines = 0x012c -> 2c 01 little-endian. Getting this backwards is a
    // classic bug, hence an explicit case.
    assert.equal(hex(rasterHeader(48, 300)), '1d 76 30 00 30 00 2c 01');
  });

  it('DLE EOT builds a status request', () => {
    assert.equal(hex(statusRequest(1)), '10 04 01');
  });

  it('the vendor footer is the documented four commands, in order', () => {
    // Pinned so an accidental edit fails loudly: these are vendor bytes, not
    // specification, and the earlier revision had an invented prologue here that
    // real hardware rejected.
    assert.deepEqual(
      PHOMEMO_FOOTER.map(hex),
      ['1f 11 08', '1f 11 0e', '1f 11 07', '1f 11 09'],
    );
  });

  it('feed commands are distinct: ESC d feeds lines, ESC J feeds dots', () => {
    // Conflating these cost a hardware round: ESC J moved no paper on a T02.
    assert.equal(hex(feedLines(3)), '1b 64 03');
    assert.equal(hex(feedDots(3)), '1b 4a 03');
  });

  it('justify is ESC a', () => {
    assert.equal(hex(justify(0)), '1b 61 00');
  });

  it('concat preserves order', () => {
    assert.equal(hex(concat([new Uint8Array([1, 2]), new Uint8Array([3])])), '01 02 03');
  });
});

describe('escpos raster round trip', () => {
  it('decodes back to the identical bitmap', () => {
    const input = pattern(WIDTH, 120);
    const job = encodeEscPosRaster(input, { vendorFraming: false, feedDots: 0 });
    const decoded = bitmapFromEscPosStream(concat(job.segments), WIDTH);

    assert.equal(decoded.width, input.width);
    assert.equal(decoded.height, input.height);
    assert.deepEqual([...decoded.data], [...input.data]);
  });

  it('round-trips across a block boundary', () => {
    // 300 lines spans two blocks; a boundary bug shows here and nowhere else.
    const input = pattern(WIDTH, 300);
    const job = encodeEscPosRaster(input, { vendorFraming: false, feedDots: 0 });
    const decoded = bitmapFromEscPosStream(concat(job.segments), WIDTH);
    assert.deepEqual([...decoded.data], [...input.data]);
  });

  it('round-trips a full-black page', () => {
    const input = blankBitmap1(WIDTH, 40);
    input.data.fill(0xff);
    const job = encodeEscPosRaster(input, { vendorFraming: false, feedDots: 0 });
    const decoded = bitmapFromEscPosStream(concat(job.segments), WIDTH);
    assert.deepEqual([...decoded.data], [...input.data]);
  });

  it('preserves the extreme columns', () => {
    // The right edge is what a stride or bit-order error loses first.
    const input = blankBitmap1(WIDTH, 4);
    setPixel(input, 0, 0, true);
    setPixel(input, WIDTH - 1, 3, true);
    const decoded = bitmapFromEscPosStream(
      concat(encodeEscPosRaster(input, { vendorFraming: false, feedDots: 0 }).segments),
      WIDTH,
    );
    assert.equal(getPixel(decoded, 0, 0), true);
    assert.equal(getPixel(decoded, WIDTH - 1, 3), true);
    assert.equal(getPixel(decoded, WIDTH - 1, 0), false);
  });
});

describe('block splitting', () => {
  it('emits one block up to the ceiling', () => {
    const job = encodeEscPosRaster(blankBitmap1(WIDTH, 255), { vendorFraming: false, feedDots: 0 });
    assert.equal(job.blocks, 1);
    assert.deepEqual(blockLineCounts(concat(job.segments)), [255]);
  });

  it('splits 300 lines into 255 + 45', () => {
    const job = encodeEscPosRaster(blankBitmap1(WIDTH, 300), { vendorFraming: false, feedDots: 0 });
    assert.equal(job.blocks, 2);
    assert.deepEqual(blockLineCounts(concat(job.segments)), [255, 45]);
  });

  it('honours a lower per-model ceiling', () => {
    const job = encodeEscPosRaster(blankBitmap1(WIDTH, 250), {
      maxBlockLines: 100,
      vendorFraming: false,
      feedDots: 0,
    });
    assert.deepEqual(blockLineCounts(concat(job.segments)), [100, 100, 50]);
  });

  it('reports raster size independent of content', () => {
    // The defining property of an uncompressed raster, and why pacing matters.
    const blank = encodeEscPosRaster(blankBitmap1(WIDTH, 200), {
      vendorFraming: false,
      feedDots: 0,
    });
    const dense = blankBitmap1(WIDTH, 200);
    dense.data.fill(0xff);
    const full = encodeEscPosRaster(dense, { vendorFraming: false, feedDots: 0 });

    assert.equal(rasterBytesIn(concat(blank.segments)), 48 * 200);
    assert.equal(rasterBytesIn(concat(full.segments)), 48 * 200);
    assert.equal(rasterByteLength(blankBitmap1(WIDTH, 200)), 9600);
  });
});

describe('width reconciliation', () => {
  it('pads a narrow bitmap centred by default', () => {
    const narrow = blankBitmap1(100, 2);
    setPixel(narrow, 0, 0, true);
    const job = encodeEscPosRaster(narrow, { vendorFraming: false, feedDots: 0 });
    assert.equal(declaredBytesPerLine(concat(job.segments)), 48);

    const decoded = bitmapFromEscPosStream(concat(job.segments), WIDTH);
    // Centred: (384-100)/2 = 142.
    assert.equal(getPixel(decoded, 142, 0), true);
    assert.equal(getPixel(decoded, 0, 0), false);
  });

  it('pads left when asked', () => {
    const narrow = blankBitmap1(100, 2);
    setPixel(narrow, 0, 0, true);
    const decoded = bitmapFromEscPosStream(
      concat(
        encodeEscPosRaster(narrow, { fit: 'pad-left', vendorFraming: false, feedDots: 0 }).segments,
      ),
      WIDTH,
    );
    assert.equal(getPixel(decoded, 0, 0), true);
  });

  it('refuses an over-wide bitmap by default rather than cropping silently', () => {
    assert.throws(
      () => encodeEscPosRaster(blankBitmap1(500, 10)),
      (e: unknown) => e instanceof PrinterError && e.code === 'INVALID_IMAGE',
    );
  });

  it('crops and reports when explicitly asked', () => {
    const job = encodeEscPosRaster(blankBitmap1(500, 10), {
      fit: 'clip',
      vendorFraming: false,
      feedDots: 0,
    });
    assert.equal(job.clipped, 500 - WIDTH);
    assert.equal(declaredBytesPerLine(concat(job.segments)), 48);
  });

  it('accepts an exactly-printhead-wide bitmap unchanged', () => {
    const job = encodeEscPosRaster(blankBitmap1(WIDTH, 10), {
      vendorFraming: false,
      feedDots: 0,
    });
    assert.equal(job.clipped, 0);
  });
});

describe('job framing', () => {
  it('follows the documented order: reset, justify, raster, feed, vendor footer', () => {
    const stream = concat(encodeEscPosRaster(blankBitmap1(WIDTH, 8)).segments);
    const cmds = parseEscPosStream(stream);

    // No vendor command before the raster: the footer belongs at the end, and an
    // invented prologue here is what a real T02 rejected.
    assert.deepEqual(
      cmds.map((c) => c.kind),
      ['init', 'justify', 'raster', 'feedLines', 'vendor', 'vendor', 'vendor', 'vendor'],
    );
  });

  it('omits vendor framing when disabled, so bring-up can isolate it', () => {
    const stream = concat(
      encodeEscPosRaster(blankBitmap1(WIDTH, 8), { vendorFraming: false }).segments,
    );
    assert.equal(
      parseEscPosStream(stream).filter((c) => c.kind === 'vendor').length,
      0,
    );
  });

  it('feeds by lines with ESC d by default', () => {
    const stream = concat(
      encodeEscPosRaster(blankBitmap1(WIDTH, 4), { feedDots: 600, vendorFraming: false }).segments,
    );
    const feeds = parseEscPosStream(stream).filter((c) => c.kind === 'feedLines');
    // 600 dots / 24 per line = 25 lines, in a single command — no repeating,
    // because the count comfortably fits one byte.
    assert.deepEqual(
      feeds.map((f) => (f as { lines: number }).lines),
      [25],
    );
  });

  it('splits a long feed across repeated ESC J under feedUnit: dots', () => {
    const stream = concat(
      encodeEscPosRaster(blankBitmap1(WIDTH, 4), {
        feedDots: 600,
        feedUnit: 'dots',
        vendorFraming: false,
      }).segments,
    );
    const feeds = parseEscPosStream(stream).filter((c) => c.kind === 'feedDots');
    assert.deepEqual(
      feeds.map((f) => (f as { dots: number }).dots),
      [255, 255, 90],
    );
  });

  it('the streaming encoder produces byte-identical output', () => {
    const bmp = pattern(WIDTH, 300);
    const materialised = concat(encodeEscPosRaster(bmp).segments);
    const streamed = concat([...escPosSegments(bmp)]);
    assert.deepEqual([...streamed], [...materialised]);
  });

  it('the streaming encoder never holds more than one block', () => {
    const segments = [...escPosSegments(pattern(WIDTH, 1000))];
    const largest = Math.max(...segments.map((s) => s.length));
    // header (8) + 48 * 255
    assert.equal(largest, 8 + 48 * 255);
  });
});

describe('chunking invariants', () => {
  it('produces identical bytes whatever the link MTU', () => {
    // Chunking must never alter the stream — only how it is split into writes.
    const stream = concat(encodeEscPosRaster(pattern(WIDTH, 120)).segments);
    for (const size of [20, 180, 244]) {
      const rejoined = concat(chunk(stream, size));
      assert.deepEqual([...rejoined], [...stream], `MTU ${size} changed the bytes`);
    }
  });

  it('never exceeds the link MTU', () => {
    const stream = concat(encodeEscPosRaster(pattern(WIDTH, 120)).segments);
    for (const size of [20, 180, 244]) {
      for (const w of chunk(stream, size)) {
        assert.ok(w.length <= size, `a ${w.length}-byte write exceeds MTU ${size}`);
      }
    }
  });
});

describe('decoder robustness', () => {
  it('reports a truncated raster payload instead of inventing rows', () => {
    const full = concat(encodeEscPosRaster(blankBitmap1(WIDTH, 10), { vendorFraming: false, feedDots: 0 }).segments);
    const truncated = full.subarray(0, full.length - 100);
    const cmds = parseEscPosStream(truncated);
    assert.ok(cmds.some((c) => c.kind === 'unknown'), 'truncation should surface as unknown');
  });

  it('survives unrecognised bytes without throwing', () => {
    const cmds = parseEscPosStream(new Uint8Array([0x00, 0xff, 0x1b, 0x40]));
    assert.equal(cmds.at(-1)!.kind, 'init');
  });

  it('handles an empty stream', () => {
    assert.deepEqual(parseEscPosStream(new Uint8Array(0)), []);
    assert.equal(bitmapFromEscPosStream(new Uint8Array(0), WIDTH).height, 0);
  });
});

describe('real artwork', () => {
  it('encodes a thresholded image end to end', () => {
    const rgba = new Uint8Array(WIDTH * 20 * 4);
    for (let i = 0; i < WIDTH * 20; i++) {
      const dark = i % 5 === 0;
      rgba[i * 4] = dark ? 0 : 255;
      rgba[i * 4 + 1] = dark ? 0 : 255;
      rgba[i * 4 + 2] = dark ? 0 : 255;
      rgba[i * 4 + 3] = 255;
    }
    const src: SourceImage = { data: rgba, width: WIDTH, height: 20, format: 'rgba' };
    const bmp = toBitmap1(src);
    const decoded = bitmapFromEscPosStream(
      concat(encodeEscPosRaster(bmp, { vendorFraming: false, feedDots: 0 }).segments),
      WIDTH,
    );
    assert.deepEqual([...decoded.data], [...bmp.data]);
  });
});
