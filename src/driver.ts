/**
 * The descriptor the base package uses to discover and open a Phomemo printer.
 *
 * Every field here is a hardware-confirmed fact rather than a guess, because each
 * one of them was initially wrong in a way that looked like something else.
 */

import type {
  Bitmap1,
  DriverDescriptor,
  PrintOptions,
  Printer,
  Transport,
} from 'react-native-thermal-ble';

import {
  PHOMEMO_NAME_PREFIXES,
  PHOMEMO_NOTIFY_UUID,
  PHOMEMO_SERVICE_UUID,
  PHOMEMO_WRITE_UUID,
} from './models';
import { PhomemoPrinter } from './PhomemoPrinter';

export const phomemoDriver: DriverDescriptor = {
  vendor: 'phomemo',
  label: 'Phomemo',

  // Confirmed by enumerating the whole GATT table: ff00 is the ONLY service, and
  // ff02 the only writable characteristic. The device advertises af30 and HID
  // 1812 and exposes neither of them.
  serviceUuid: PHOMEMO_SERVICE_UUID,
  writeCharacteristicUuid: PHOMEMO_WRITE_UUID,
  notifyCharacteristicUuid: PHOMEMO_NOTIFY_UUID,

  // False deliberately. The printer works fine with no subscription — it never
  // says anything worth waiting for — so a missing notify characteristic must not
  // block printing. Requiring it would fail the connect on a firmware variant
  // that omits ff03, and the failure would read as "out of range".
  requireNotify: false,

  // 247 rather than 517: the T02 negotiates ~200 anyway, and asking for the
  // maximum gains nothing on a printer whose bottleneck is the head, not the link.
  requestMtu: 247,

  namePrefixes: PHOMEMO_NAME_PREFIXES,

  /**
   * Require a name match and nothing else.
   *
   * `0000ff00-…` is the generic 16-bit Bluetooth base UUID, shared by a large
   * number of unrelated BLE modules, so a service-filtered scan would happily
   * offer fitness trackers as printers. The name is the only usable signal.
   */
  accepts: (device) => {
    const name = (device.name ?? '').toUpperCase();
    return PHOMEMO_NAME_PREFIXES.some((p) => name.startsWith(p.toUpperCase()));
  },

  open: async (transport: Transport, opts): Promise<Printer> => {
    const printer = await PhomemoPrinter.open(transport, {
      deviceName: opts?.deviceName,
      log: opts?.log,
      // Skipped by default: DLE EOT does get an answer, but the answer carries no
      // information we act on, and probing costs 300 ms on every connect.
      probeStatus: false,
    });
    return asPrinter(printer);
  },
};

/**
 * Adapt a {@link PhomemoPrinter} to the vendor-neutral `Printer` contract.
 *
 * An adapter rather than making `PhomemoPrinter` implement `Printer` directly:
 * the driver's own API is the better one for anybody who knows they have a T02
 * — `model` there is the full metadata record, and `printBitmap` accepts ESC/POS
 * encoding options that mean nothing to another vendor. Bending it to fit the
 * neutral shape would make the specific case worse to serve the general one.
 */
export function asPrinter(printer: PhomemoPrinter): Printer {
  return {
    vendor: 'phomemo',
    model: printer.model.model,
    label: printer.model.label,
    capabilities: printer.capabilities,
    close: () => printer.close(),
    printBitmap: (bitmap: Bitmap1, opts?: PrintOptions) =>
      printer.printBitmap(bitmap, {
        copies: opts?.copies ?? 1,
        onProgress: (p) =>
          opts?.onProgress?.({
            // 'settling' is the head draining after the last write, which is the
            // closest this printer has to "printing" — it reports nothing itself.
            phase:
              p.phase === 'settling'
                ? 'printing'
                : p.phase === 'done'
                  ? 'done'
                  : p.phase === 'sending'
                    ? 'sending'
                    : 'preparing',
            percent: p.percent,
            // Host-side bytes-sent. The T02 never reports its own state, and
            // claiming otherwise would misrepresent what the number means.
            fromPrinter: false,
          }),
      }),
  };
}
