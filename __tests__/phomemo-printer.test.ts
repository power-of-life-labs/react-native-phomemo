/**
 * PhomemoPrinter tests.
 *
 * With no acknowledgements to assert on, the guarantees worth testing are:
 *  - we never write faster than the modelled printer can consume (nothing dropped)
 *  - we never resolve before the head has had time to drain
 *  - the byte stream is correct regardless of how it was chunked
 *
 * The clock is injected throughout, so the pacer's real-world seconds of delay
 * take microseconds here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blankBitmap1, setPixel } from 'react-native-thermal-ble';
import {
  RecordingTransport,
  fakeClock,
  type RecordingTransportOptions,
} from 'react-native-thermal-ble';
import { PhomemoPrinter } from '../src/PhomemoPrinter';
import { T02 } from '../src/models';
import { bitmapFromEscPosStream, blockLineCounts } from '../src/parse';
import { parseEscPosStream } from '../src/parse';
import { PrinterError } from 'react-native-thermal-ble';

const WIDTH = 384;

function page(height: number) {
  const bmp = blankBitmap1(WIDTH, height);
  for (let y = 0; y < height; y++) {
    setPixel(bmp, 0, y, true);
    setPixel(bmp, (y * 7) % WIDTH, y, true);
  }
  return bmp;
}

/** A printer wired to a recorder with a fake clock. */
async function harness(transportOpts: RecordingTransportOptions = {}) {
  const clock = fakeClock();
  const transport = new RecordingTransport({ now: clock.now, ...transportOpts });
  const printer = await PhomemoPrinter.open(transport, {
    deviceName: 'T02',
    now: clock.now,
    sleep: clock.sleep,
    probeStatus: false,
  });
  return { clock, transport, printer };
}

describe('open and identity', () => {
  it('identifies the model from the advertised name', async () => {
    const { printer } = await harness();
    assert.equal(printer.model.model, 'T02');
    assert.equal(printer.model.printheadPixels, 384);
    assert.equal(printer.model.bytesPerLine, 48);
  });

  it('falls back to the T02 when the name is unknown', async () => {
    const clock = fakeClock();
    const printer = await PhomemoPrinter.open(new RecordingTransport({ now: clock.now }), {
      deviceName: 'something else',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: false,
    });
    assert.equal(printer.model.model, 'T02');
  });

  it('states its capabilities honestly', async () => {
    const { printer } = await harness();
    // These four falses are the whole reason this driver differs from Niimbot's.
    assert.equal(printer.capabilities.acknowledgesPages, false);
    assert.equal(printer.capabilities.supportsCopies, false);
    assert.equal(printer.capabilities.supportsDensity, false);
    assert.equal(printer.capabilities.reportsProgress, false);
  });

  it('probes for status and records whether anything answered', async () => {
    const clock = fakeClock();
    const transport = new RecordingTransport({ now: clock.now });
    const printer = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: true,
    });
    // DLE EOT 1 went out...
    const cmds = parseEscPosStream(transport.stream);
    assert.ok(cmds.some((c) => c.kind === 'statusRequest'));
    // ...and nothing came back, which must be reported rather than assumed.
    assert.equal(printer.answeredStatus, false);
  });

  it('captures notifications for later interpretation', async () => {
    const { transport, printer } = await harness();
    const seen: number[] = [];
    printer.onNotify((b) => seen.push(b.length));
    transport.emit(new Uint8Array([0x12, 0x34]));
    assert.deepEqual(seen, [2]);
    assert.equal(printer.answeredStatus, true);
  });
});

describe('the byte stream reaching the printer', () => {
  it('round-trips through the recorder back to the original bitmap', async () => {
    const { transport, printer } = await harness();
    const input = page(120);
    await printer.printBitmap(input, { vendorFraming: false, feedDots: 0 });

    const decoded = bitmapFromEscPosStream(transport.stream, WIDTH);
    assert.deepEqual([...decoded.data], [...input.data]);
  });

  it('splits long pages into 255-line blocks on the wire', async () => {
    const { transport, printer } = await harness();
    await printer.printBitmap(page(300), { vendorFraming: false, feedDots: 0 });
    assert.deepEqual(blockLineCounts(transport.stream), [255, 45]);
  });

  it('never exceeds the link write size', async () => {
    const { transport, printer } = await harness({ maxWriteSize: 64 });
    await printer.printBitmap(page(60));
    for (const w of transport.writes) {
      assert.ok(w.length <= 64, `a ${w.length}-byte write exceeds 64`);
    }
  });

  it('produces identical bytes at different write sizes', async () => {
    const streams: string[] = [];
    for (const maxWriteSize of [20, 100, 180]) {
      const { transport, printer } = await harness({ maxWriteSize });
      await printer.printBitmap(page(80), { vendorFraming: false, feedDots: 0 });
      streams.push(Buffer.from(transport.stream).toString('base64'));
    }
    assert.equal(streams[0], streams[1]);
    assert.equal(streams[1], streams[2]);
  });

  it('re-sends the raster per copy, since the printer cannot repeat it', async () => {
    const { transport, printer } = await harness();
    await printer.printBitmap(page(40), { copies: 3, vendorFraming: false, feedDots: 0 });
    // Three separate jobs on the wire, not one with a copy count.
    assert.equal(parseEscPosStream(transport.stream).filter((c) => c.kind === 'init').length, 3);
  });
});

describe('pacing', () => {
  it('drops nothing even when the real printer is SLOWER than configured', async () => {
    // The original version of this test drained the modelled printer at exactly
    // T02.linesPerSecond — the same constant the pacer paces to. That can never
    // fail, whatever the constant is, which is precisely why it stayed green while
    // real hardware was losing 60% of its lines to a 4x-too-fast estimate.
    //
    // So the model now drains 20% slower than we pace, turning the assertion into
    // a real one: it fails unless the configured rate carries genuine margin.
    const clock = fakeClock();
    const transport = new RecordingTransport({
      maxWriteSize: 180,
      bufferBytes: T02.bufferBytes,
      // 10% slower than the configured rate. The pacer's 20% safety factor must
      // absorb that; the test fails if the margin is removed or cut below 10%.
      drainBytesPerSecond: T02.linesPerSecond * T02.bytesPerLine * 0.9,
      now: clock.now,
    });
    const printer = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: false,
    });

    const dense = blankBitmap1(WIDTH, 800);
    dense.data.fill(0xff);
    await printer.printBitmap(dense);

    assert.equal(transport.dropped.length, 0, 'the pacer overran the printer buffer');
    assert.ok(transport.writes.length > 100, 'expected a substantial number of writes');
  });

  it('overruns the buffer when pacing is disabled — proving the model bites', async () => {
    // A guard on the guard: if this passed too, the buffer model would be inert
    // and the test above would prove nothing.
    const clock = fakeClock();
    const transport = new RecordingTransport({
      maxWriteSize: 180,
      bufferBytes: 512,
      drainBytesPerSecond: T02.linesPerSecond * T02.bytesPerLine,
      now: clock.now,
    });
    const printer = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      // A clock that never advances models an infinitely fast host.
      sleep: async () => {},
      probeStatus: false,
    });
    await printer.printBitmap(blankBitmap1(WIDTH, 400));
    assert.ok(transport.dropped.length > 0, 'expected an overrun without pacing');
  });

  it('ack mode waits for a reply before each subsequent write', async () => {
    // A printer that answers every write lets us follow its real pace instead of
    // a guessed line rate — the guess is what truncated a real print.
    const clock = fakeClock();
    const transport = new RecordingTransport({ now: clock.now, maxWriteSize: 180 });
    // Answer every write, as the T02 does.
    transport.onWrite(() => transport.emit(new Uint8Array([0x01, 0x01])));

    const printer = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: false,
      mode: 'ack',
    });
    await printer.printBitmap(page(120), { vendorFraming: false, feedDots: 0 });

    // Every byte still arrives, in order, regardless of the gating.
    const decoded = bitmapFromEscPosStream(transport.stream, WIDTH);
    assert.deepEqual([...decoded.data], [...page(120).data]);
    assert.equal(transport.dropped.length, 0);
  });

  it('ack mode still completes when the printer never replies', async () => {
    // Otherwise a silent firmware would stall for ackTimeoutMs on every write and
    // look like a hang rather than a slow print.
    const clock = fakeClock();
    const transport = new RecordingTransport({ now: clock.now });
    const printer = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: false,
      mode: 'ack',
      ackTimeoutMs: 100,
    });
    await printer.printBitmap(page(40), { vendorFraming: false, feedDots: 0 });
    assert.deepEqual(blockLineCounts(transport.stream), [40]);
  });

  it('takes at least the mechanical print time', async () => {
    const { clock, printer } = await harness();
    const lines = 400;
    await printer.printBitmap(blankBitmap1(WIDTH, lines));
    // 400 lines at 240 lines/s is ~1.67 s of paper movement; the pacer plus the
    // settle must account for at least that.
    const expected = (lines / T02.linesPerSecond) * 1000;
    assert.ok(
      clock.elapsed() >= expected,
      `elapsed ${clock.elapsed()}ms is less than the ${Math.round(expected)}ms the print takes`,
    );
  });

  it('honours a slower configured line rate by taking longer', async () => {
    const mk = async (linesPerSecond: number) => {
      const clock = fakeClock();
      const printer = await PhomemoPrinter.open(new RecordingTransport({ now: clock.now }), {
        deviceName: 'T02',
        now: clock.now,
        sleep: clock.sleep,
        linesPerSecond,
        probeStatus: false,
      });
      await printer.printBitmap(blankBitmap1(WIDTH, 400));
      return clock.elapsed();
    };
    assert.ok((await mk(120)) > (await mk(480)), 'a slower rate must pace more conservatively');
  });
});

describe('settling', () => {
  it('waits for the head to drain before resolving', async () => {
    // Resolving early truncates the label AND looks identical to dropped writes,
    // so this is worth pinning explicitly.
    const { clock, printer } = await harness();
    const lines = 600;
    await printer.printBitmap(blankBitmap1(WIDTH, lines), { settleMarginMs: 500 });
    const drain = (lines / T02.linesPerSecond) * 1000;
    assert.ok(clock.elapsed() >= drain + 500);
  });

  it('reports settling as a distinct phase', async () => {
    const { printer } = await harness();
    const phases: string[] = [];
    await printer.printBitmap(page(60), {
      onProgress: (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
    });
    assert.deepEqual(phases, ['encoding', 'sending', 'settling', 'done']);
  });

  it('progress ends at 100 percent', async () => {
    const { printer } = await harness();
    let last = 0;
    await printer.printBitmap(page(60), { onProgress: (p) => (last = p.percent) });
    assert.equal(last, 100);
  });
});

describe('lifecycle', () => {
  it('close waits for the job in flight rather than truncating it', async () => {
    const { printer, transport } = await harness();
    const printing = printer.printBitmap(page(200));
    // Close concurrently: it must not cut the print short.
    const closing = printer.close();
    await Promise.all([printing, closing]);
    assert.equal(transport.isConnected, false);
    // The whole raster still reached the wire.
    assert.deepEqual(blockLineCounts(transport.stream), [200]);
  });

  it('refuses to print once closed', async () => {
    const { printer } = await harness();
    await printer.close();
    await assert.rejects(
      () => printer.printBitmap(page(10)),
      (e: unknown) => e instanceof PrinterError && e.code === 'NOT_CONNECTED',
    );
  });

  it('feed emits ESC J, split across repeats for a long feed', async () => {
    const { printer, transport } = await harness();
    await printer.feed(600);
    const feeds = parseEscPosStream(transport.stream).filter((c) => c.kind === 'feedDots');
    assert.deepEqual(
      feeds.map((f) => (f as { dots: number }).dots),
      [255, 255, 90],
    );
  });

  it('getStatus is honest that no status is available', async () => {
    const { printer } = await harness();
    assert.equal(await printer.getStatus(), null);
  });

  it('surfaces a transport failure mid-job', async () => {
    const clock = fakeClock();
    const transport = new RecordingTransport({ now: clock.now, failAfterBytes: 1000 });
    const printer = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: false,
    });
    await assert.rejects(() => printer.printBitmap(page(400)));
  });
});
