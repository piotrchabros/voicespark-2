import type { Classifier, ClassifierOutput } from './index';

/** Replays a fixed (or per-text) classifier output; used by unit tests and the recorded corpus. */
export function createRecordedClassifier(
  output: ClassifierOutput | ((text: string) => ClassifierOutput) = {
    spans: [],
    mostlySensitive: false,
  },
): Classifier {
  return {
    async classify(text) {
      return typeof output === 'function' ? output(text) : output;
    },
  };
}
