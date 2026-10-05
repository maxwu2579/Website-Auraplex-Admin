/**
 * Website/business category chosen by the uploader. This is deliberately
 * separate from the ingest taxonomy used for storage paths and Qdrant.
 */
export const BUSINESS_LINES = [
  'labelling',
  'packaging',
  'automation',
  'software',
  'consulting',
] as const;

export type BusinessLine = (typeof BUSINESS_LINES)[number];

/** Ingest taxonomy: the first object-key segment and the Qdrant routing key. */
export const INGEST_LINES = ['machines', 'software', 'consulting'] as const;

export type IngestLine = (typeof INGEST_LINES)[number];

export const BUSINESS_TO_INGEST_LINE: Readonly<Record<BusinessLine, IngestLine>> = Object.freeze({
  labelling: 'machines',
  packaging: 'machines',
  automation: 'machines',
  software: 'software',
  consulting: 'consulting',
});

export const BUSINESS_LINE_LABELS: Readonly<Record<BusinessLine, string>> = Object.freeze({
  labelling: 'Labelling',
  packaging: 'Packaging',
  automation: 'Automation',
  software: 'Software',
  consulting: 'Consulting',
});

export function isBusinessLine(value: string): value is BusinessLine {
  return (BUSINESS_LINES as readonly string[]).includes(value);
}

export function isIngestLine(value: string): value is IngestLine {
  return (INGEST_LINES as readonly string[]).includes(value);
}

export function ingestLineForBusinessLine(line: BusinessLine): IngestLine {
  return BUSINESS_TO_INGEST_LINE[line];
}
