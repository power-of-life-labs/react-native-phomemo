/**
 * react-native-phomemo — Phomemo thermal printer driver.
 *
 * Requires `react-native-thermal-ble`, which owns the native BLE module, the
 * imaging pipeline and the config plugin. That package is a **peerDependency**
 * here, never a dependency: it contains a native module, and two copies at
 * different versions would register two Expo modules and two CBCentralManagers.
 *
 * Usage, with the base composing however many drivers you install:
 *
 * ```ts
 * import { connectFromDescriptors } from 'react-native-thermal-ble/ble';
 * import { phomemoDriver } from 'react-native-phomemo';
 *
 * const printer = await connectFromDescriptors([phomemoDriver]);
 * await printer.printBitmap(bitmap);
 * ```
 */

export { phomemoDriver } from './driver';

export {
  PHOMEMO_FOOTER,
  concat,
  feedDots,
  feedLines,
  initialise,
  justify,
  lineSpacing,
  rasterHeader,
  setDensity,
  setSpeed,
  statusRequest,
} from './escpos';

export {
  DEFAULT_BYTES_PER_LINE,
  DEFAULT_MAX_BLOCK_LINES,
  blankLabel,
  encodeEscPosRaster,
  escPosSegments,
  rasterByteLength,
  type EscPosEncodeOptions,
  type EscPosJob,
  type FitMode,
} from './encode';

export {
  bitmapFromEscPosStream,
  blockLineCounts,
  bytesPerLineFor,
  declaredBytesPerLine,
  parseEscPosStream,
  rasterBytesIn,
  type EscPosCommand,
} from './parse';

export {
  PHOMEMO_MODELS,
  PHOMEMO_NAME_PREFIXES,
  PHOMEMO_NOTIFY_UUID,
  PHOMEMO_SERVICE_UUID,
  PHOMEMO_WRITE_UUID,
  T02,
  findPhomemoByName,
  type PhomemoModelMeta,
} from './models';

export {
  PhomemoPrinter,
  type PhomemoCapabilities,
  type PhomemoFlowControl,
  type PhomemoOpenOptions,
  type PhomemoPrintOptions,
  type PhomemoPrintProgress,
} from './PhomemoPrinter';
