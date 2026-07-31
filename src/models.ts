/**
 * Phomemo model registry.
 *
 * GATT layout confirmed on real hardware by enumerating the device's services:
 * the print service `ff00` exists but is NOT advertised — the T02 advertises
 * `af30` and `1812` (standard HID), neither of which is a discoverable service on
 * iOS. So a scan must match on the advertised NAME, never on the service UUID.
 */

/** Print service. Present in the GATT table but absent from the advertisement. */
export const PHOMEMO_SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';

/** Confirmed `write | writeNoResp`, so the fast unacked path is available. */
export const PHOMEMO_WRITE_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';

/** Confirmed `notify`. What it actually sends is still unknown. */
export const PHOMEMO_NOTIFY_UUID = '0000ff03-0000-1000-8000-00805f9b34fb';

export interface PhomemoModelMeta {
  model: string;
  label: string;
  dpi: number;
  /** Printhead width in dots. 384 = 48 bytes per raster line. */
  printheadPixels: number;
  bytesPerLine: number;
  /** Physical paper width; wider than the printable area. */
  paperWidthMm: number;
  printableWidthMm: number;
  /** Lines per `GS v 0` block. Conservative until a longer block is proven. */
  maxBlockLines: number;
  /**
   * Assumed mechanical line rate, used to pace writes. The printer never says
   * when its buffer is full, so this is the only defence against overrunning it.
   */
  linesPerSecond: number;
  /** Assumed printer input buffer; how much head start the pacer allows. */
  bufferBytes: number;
  /** Emit the unverified vendor framing bytes. */
  vendorFraming: boolean;
  namePrefixes: readonly string[];
  /** Whether the full print path is confirmed on hardware. */
  validated: boolean;
  notes?: string;
}

export const PHOMEMO_MODELS: readonly PhomemoModelMeta[] = [
  {
    model: 'T02',
    label: 'Phomemo T02',
    dpi: 203,
    printheadPixels: 384,
    bytesPerLine: 48,
    paperWidthMm: 53,
    printableWidthMm: 48,
    maxBlockLines: 255,
    /*
     * MEASURED, not assumed. A 400-line solid block should print 50.0 mm tall;
     * the same job at different pacing produced:
     *
     *   240 lines/s  ->  15.5 mm and 25 mm on two runs   (~60% of lines lost)
     *    60 lines/s  ->  49 mm                            (~2% lost)
     *   ack-gated    ->  15 mm                            (no throttling at all)
     *
     * So the real head rate is a little under 60 lines/s — roughly 7 mm/s, about
     * a quarter of my original 240 estimate. This figure is the *measured* rate;
     * the margin lives separately in `safetyFactor` (0.8 by default), giving an
     * effective ~46 lines/s. Keeping the two apart matters because one is a fact
     * about the hardware and the other is a policy choice.
     *
     * The margin is not cosmetic: the two 240 runs differed by 10 mm, so the loss
     * is a race rather than a fixed truncation, and the largest value that
     * happened to work once is not a safe value.
     */
    linesPerSecond: 58,
    /*
     * Also lowered from 2048. This is the unthrottled head start, so it is sent
     * as fast as BLE allows; 2048 bytes is 42 lines, and at 60 lines/s the 1 mm
     * that went missing is about 8 lines — consistent with a burst slightly
     * exceeding the real buffer. 512 bytes keeps the opening burst under 11 lines.
     */
    bufferBytes: 512,
    vendorFraming: true,
    namePrefixes: ['T02'],
    validated: true,
    notes:
      'GATT confirmed on hardware: service ff00 (unadvertised), write ff02 ' +
      '(write|writeNoResp), notify ff03. Advertises af30 + 1812 (HID), neither of ' +
      'which is a usable service — so match on name, not service UUID. Continuous ' +
      'paper: no gap sensor, so any format fitting 384 dots can be printed and torn. ' +
      'Confirmed on hardware: 384 dots = 48.0 mm printed width, so bytesPerLine 48 ' +
      'and MSB-first bit order are correct; ESC d (feed lines) works while ESC J ' +
      '(feed dots) moves no paper at all; ff03 replies 01 01 to every write, plus ' +
      '02 b6 00 and 1a 3b 04 40 00 00 00 on connect. That 01 01 is a link-level ' +
      'ack, NOT buffer credit — gating writes on it gives no backpressure ' +
      '(15 mm, same as unthrottled), so pacing is the only defence. ' +
      'Geometry validated at 1200 lines (five blocks): 149.5 mm against 150.1 ' +
      'expected, with 10 mm grid rulings correct throughout, so block splitting ' +
      'and the u16 line counts are right at every seam. ' +
      'KNOWN LIMIT: a large 100%-black fill fades badly through the middle with ' +
      'vertical streaking, recovering at the end — the supply sagging under ' +
      'sustained full-width current, not lost data (the length stays correct, and ' +
      'lost data cannot recover). Normal artwork is unaffected; avoid designing a ' +
      'sticker with a big solid black background. ' +
      'Still unverified: whether the vendor footer is required, and whether the ' +
      'ESC N density/speed commands do anything on this model.',
  },
];

export const T02: PhomemoModelMeta = PHOMEMO_MODELS[0]!;

export function findPhomemoByName(name: string | null | undefined): PhomemoModelMeta | null {
  if (!name) return null;
  const upper = name.toUpperCase();
  return (
    PHOMEMO_MODELS.find((m) => m.namePrefixes.some((p) => upper.startsWith(p.toUpperCase()))) ??
    null
  );
}

/** All Phomemo name prefixes, for scan filtering. */
export const PHOMEMO_NAME_PREFIXES: readonly string[] = Array.from(
  new Set(PHOMEMO_MODELS.flatMap((m) => m.namePrefixes)),
);
