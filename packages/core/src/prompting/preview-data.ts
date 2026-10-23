import samples from './preview-samples.json' with { type: 'json' };

export interface PreviewAuthoredSample {
  ref: string;
  contentItemId: string;
  kind: 'note' | 'email';
  date: string;
  lang: string;
  text: string;
  wordCount: number;
}

export interface PreviewReceivedSample {
  kind: 'email';
  date: string;
  text: string;
}

/** Built-in synthetic samples for the admin preview run; every text starts with "SAMPLE TEXT" (no user content). */
export interface PreviewSamples {
  authored: PreviewAuthoredSample[];
  received: PreviewReceivedSample[];
}

export const PREVIEW_SAMPLES: PreviewSamples = samples as PreviewSamples;
