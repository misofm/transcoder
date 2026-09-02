import { Layer } from "effect";

export { FfmpegLive } from "./ffmpeg/service.js";
export { NodeNativeProcessLive } from "./process/node-native-process.js";

import { FfmpegLive } from "./ffmpeg/service.js";
import { TranscodeObserverNoop } from "./observer.js";
import { TranscoderLive } from "./pipeline/service.js";
import { NodeNativeProcessLive } from "./process/node-native-process.js";

const FfmpegNodeLive = FfmpegLive.pipe(Layer.provide(NodeNativeProcessLive));

export const TranscoderNodeLive = TranscoderLive.pipe(
  Layer.provide(FfmpegNodeLive),
  Layer.provide(TranscodeObserverNoop),
);
