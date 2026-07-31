# react-native-phomemo

Print to **Phomemo** thermal printers over Bluetooth LE from React Native / Expo,
on iOS and Android.

Requires [`react-native-thermal-ble`](https://github.com/power-of-life-labs/react-native-thermal-ble),
which owns the native BLE module, the imaging pipeline and the config plugin.

| Model | Status |
|---|---|
| **T02** | validated on hardware |

## Install

```sh
npx expo install react-native-thermal-ble react-native-phomemo
```

Add the base package's config plugin — it lives there, not here, because the
Bluetooth permissions belong to the native module exactly once:

```json
{
  "expo": {
    "plugins": ["react-native-thermal-ble"]
  }
}
```

Then `npx expo prebuild --clean`. A development build is required; this cannot
work in Expo Go.

## Usage

```ts
import { connectFromDescriptors } from 'react-native-thermal-ble/ble';
import { phomemoDriver } from 'react-native-phomemo';

const printer = await connectFromDescriptors([phomemoDriver]);
await printer.printBitmap(bitmap, {
  onProgress: (p) => console.log(p.phase, p.percent),
});
await printer.close();
```

Install more than one driver and pass them all — the base resolves which one owns
whatever printer turns up:

```ts
import { niimbotDriver } from 'react-native-niimbot';
const printer = await connectFromDescriptors([niimbotDriver, phomemoDriver]);
```

## What this printer does not do

```ts
capabilities = {
  dpi: 203,
  printheadPixels: 384,
  supportsCopies: false,     // the host re-sends the raster per copy
  supportsDensity: false,
  acknowledgesPages: false,  // the important one
  reportsProgress: false,
}
```

`acknowledgesPages: false` is the fact that shapes this whole driver. The printer
never confirms what it printed, so **a dropped or truncated page is undetectable in
band** and progress is host-side bytes-sent, not printer state.

Two consequences the driver handles for you:

**Writes are paced against the measured mechanical line rate.** BLE pushes tens of
kB/s; a T02 head consumes about 2.4 kB/s. Overrun drops lines silently, and on
solid artwork the only symptom is a *shorter print*. Measured with a 400-line block
that should be 50.0 mm tall:

| Pacing | Height |
|---|---|
| 240 lines/s | **15.5 mm**, then **25 mm** on a rerun |
| 60 lines/s | **49 mm** |
| gated on the printer's per-write reply | **15 mm** |

The real rate is just under 60 lines/s. Note the two 240 runs differing by 10 mm:
the loss is a race, not a fixed truncation, so the largest value that works once is
not a safe value. Hence `linesPerSecond` (a hardware fact) is kept separate from
`safetyFactor` (a policy choice, 0.8 by default).

**Do not expect flow control from the notify characteristic.** The T02 answers
`01 01` to every write, which looks exactly like buffer credit and is not — it
replies on *receipt*, not on consumption, so gating on it throttles nothing.

**`printBitmap` waits for the head to drain before resolving.** Finishing the last
write is not finishing the print; several seconds of raster can still be in the
buffer, and closing early truncates the label in a way that looks identical to
dropped writes.

## Known limit

A large **100 % black fill** fades badly through the middle with vertical
streaking, recovering towards the end. That is the supply sagging under sustained
full-width current, not lost data — the printed length stays correct, and lost data
cannot recover. Normal artwork is unaffected, but avoid a sticker design with a big
solid black background.

## Protocol notes

EPSON ESC/POS raster, not Niimbot framing:

```
1b 40                       ESC @              reset
1b 61 00                    ESC a 0            left justify
1d 76 30 00 30 00 ff 00     GS v 0             48 bytes/line LE, 255 lines LE
<12240 raster bytes>
…                                              further blocks
1b 64 04                    ESC d 4            feed clear of the tear bar
1f 11 08 / 0e / 07 / 09     vendor footer
```

Hardware-confirmed details worth knowing:

- **384 dots measured 48.0 mm**, so `bytesPerLine: 48` and MSB-first bit order are
  correct. `Bitmap1` is already MSB-first with 1 = black, which is exactly what
  `GS v 0` wants — no bit conversion anywhere.
- **`ESC d` (feed lines) works; `ESC J` (feed dots) moves no paper at all** on this
  firmware, whatever the general specification says.
- **1200 lines across five blocks printed 149.5 mm** against 150.1 expected, with
  10 mm grid rulings correct throughout — so block splitting and the u16 line
  counts are right at every seam.
- GATT: service `ff00` (**not advertised**), write `ff02`, notify `ff03`. The device
  advertises `af30` and HID `1812` and exposes neither, so **match on name**. Its
  real service is the generic 16-bit base UUID, which countless unrelated modules
  also expose.

## Licence and provenance

MIT.

Written from the public EPSON ESC/POS command reference, this project's own wire
captures against real hardware, and published protocol descriptions. **No source
has been read from or copied out of** `vivier/phomemo-tools` (GPL-3) or
`phomemo-printer` (GPL-2), whose terms are incompatible with MIT.

The distinction is deliberate: a command byte and its meaning is a *fact about a
device*, and interoperability information is not protected by copyright. Copying
someone's *implementation* of that protocol would be.
