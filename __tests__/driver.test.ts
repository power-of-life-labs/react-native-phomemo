/**
 * The driver descriptor and the neutral-contract adapter.
 *
 * Worth testing separately from the printer: the descriptor is what the base
 * package trusts to decide "is that a printer, and how do I talk to it", and
 * every field in it was wrong at some point during bring-up in a way that
 * presented as something else entirely.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RecordingTransport,
  blankBitmap1,
  fakeClock,
  type PrintProgress,
} from 'react-native-thermal-ble';

import { asPrinter, phomemoDriver } from '../src/driver';
import { PhomemoPrinter } from '../src/PhomemoPrinter';
import { blockLineCounts } from '../src/parse';

describe('phomemoDriver descriptor', () => {
  it('points at the hardware-confirmed GATT layout', () => {
    // ff00 is the only service on the device and ff02 its only writable
    // characteristic, both established by enumerating the full table.
    assert.equal(phomemoDriver.serviceUuid, '0000ff00-0000-1000-8000-00805f9b34fb');
    assert.equal(phomemoDriver.writeCharacteristicUuid, '0000ff02-0000-1000-8000-00805f9b34fb');
    assert.equal(phomemoDriver.notifyCharacteristicUuid, '0000ff03-0000-1000-8000-00805f9b34fb');
  });

  it('does not require notifications', () => {
    // The printer prints perfectly well with no subscription. Requiring one would
    // fail the connect on a firmware without ff03, and that failure surfaces as
    // "timed out", which reads as a range problem.
    assert.equal(phomemoDriver.requireNotify, false);
  });

  it('accepts only on a name match, never on the service UUID', () => {
    // 0000ff00 is the generic 16-bit base UUID. Accepting on it would offer
    // unrelated BLE modules — fitness trackers included — as printers.
    const accepts = phomemoDriver.accepts!;
    assert.equal(accepts({ id: 'a', name: 'T02', serviceUuids: [], rssi: -50 }), true);
    assert.equal(
      accepts({
        id: 'b',
        name: 'Some Tracker',
        serviceUuids: ['0000ff00-0000-1000-8000-00805f9b34fb'],
        rssi: -50,
      }),
      false,
    );
    assert.equal(accepts({ id: 'c', name: null, serviceUuids: [], rssi: -50 }), false);
  });
});

describe('asPrinter', () => {
  async function printer() {
    const clock = fakeClock();
    const transport = new RecordingTransport({ now: clock.now });
    const inner = await PhomemoPrinter.open(transport, {
      deviceName: 'T02',
      now: clock.now,
      sleep: clock.sleep,
      probeStatus: false,
    });
    return { transport, inner, wrapped: asPrinter(inner) };
  }

  it('exposes the model as a string, not the metadata record', async () => {
    const { wrapped } = await printer();
    assert.equal(wrapped.vendor, 'phomemo');
    assert.equal(wrapped.model, 'T02');
    assert.equal(wrapped.label, 'Phomemo T02');
  });

  it('reports that pages are not acknowledged', async () => {
    // The single most important thing this contract carries: with no page ack,
    // a successful return is a claim about the wire and not about paper.
    const { wrapped } = await printer();
    assert.equal(wrapped.capabilities.acknowledgesPages, false);
    assert.equal(wrapped.capabilities.printheadPixels, 384);
    assert.equal(wrapped.capabilities.dpi, 203);
  });

  it('normalises progress and never claims it came from the printer', async () => {
    const { wrapped } = await printer();
    const seen: PrintProgress[] = [];
    await wrapped.printBitmap(blankBitmap1(384, 60), {
      onProgress: (p) => seen.push(p),
    });

    const phases: string[] = [];
    for (const p of seen) if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
    // 'settling' maps to 'printing': the head is still consuming its buffer.
    assert.deepEqual(phases, ['preparing', 'sending', 'printing', 'done']);
    assert.ok(seen.every((p) => p.fromPrinter === false));
    assert.equal(seen[seen.length - 1]!.percent, 100);
  });

  it('passes the bitmap through unchanged', async () => {
    const { transport, wrapped } = await printer();
    await wrapped.printBitmap(blankBitmap1(384, 120));
    assert.deepEqual(blockLineCounts(transport.stream), [120]);
  });

  it('forwards close to the underlying printer', async () => {
    const { transport, wrapped } = await printer();
    await wrapped.close();
    assert.equal(transport.isConnected, false);
  });
});
