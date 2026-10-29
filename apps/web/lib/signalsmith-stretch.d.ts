declare module "signalsmith-stretch" {
  const create: (
    context: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ) => Promise<import("./read-aloud-audio").StretchNode>;
  export default create;
}
