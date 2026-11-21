import { configureInputMix } from './input-monitor.mjs?v=20261120-transmit-mono';

export function createBroadcastMonoProcessor(environment = globalThis) {
  let source, gain, destination;
  const processor = {
    name: 'decent-broadcast-mono',
    processedTrack: undefined,
    async init({ track, audioContext }) {
      if (!track || track.kind !== 'audio' || track.readyState !== 'live' || !audioContext) {
        throw new Error('Centered broadcast mixing requires a live audio input and audio context.');
      }
      try {
        await audioContext.resume();
        if (audioContext.state !== 'running') throw new Error('Centered broadcast mixing could not start.');
        source = audioContext.createMediaStreamSource(new environment.MediaStream([track]));
        gain = audioContext.createGain();
        configureInputMix(gain, 'mono');
        destination = audioContext.createMediaStreamDestination();
        destination.channelCount = 2;
        destination.channelCountMode = 'explicit';
        destination.channelInterpretation = 'speakers';
        source.connect(gain);
        // Upmix the averaged mono signal equally to both transmitted channels, not the speakers.
        gain.connect(destination);
        processor.processedTrack = destination.stream.getAudioTracks()[0];
        if (!processor.processedTrack) throw new Error('Centered broadcast mixing produced no audio track.');
      } catch (error) {
        await processor.destroy();
        throw error;
      }
    },
    async restart(options) {
      await processor.destroy();
      await processor.init(options);
    },
    async destroy() {
      source?.disconnect();
      gain?.disconnect();
      destination?.disconnect();
      destination?.stream.getTracks().forEach(track => track.stop());
      source = gain = destination = undefined;
      processor.processedTrack = undefined;
    },
  };
  return processor;
}
