import { QdrantClient } from '@qdrant/js-client-rest';
import {
  getQdrantConfig,
  type QdrantConfig,
} from '@/lib/admin/server/config';
import type { IngestLine } from '@/lib/admin/upload-domain';
import { parseUploadObjectKey } from '@/lib/admin/object-key';
import { parseQdrantSourceKey } from '@/lib/admin/source-key';

export interface QdrantEvidenceAdapter {
  hasProcessedEvidence(sourceKey: string): Promise<boolean>;
  deleteBySourceKey(sourceKey: string): Promise<void>;
}

type QdrantScroller = Pick<QdrantClient, 'scroll' | 'delete'>;
export type QdrantCollectionResolver = (sourceKey: string) => string;

export const QDRANT_COLLECTIONS: Readonly<Record<IngestLine, string>> = Object.freeze({
  machines: 'auraplex_machines',
  software: 'auraplex_software',
  consulting: 'auraplex_consulting',
});

/**
 * The single collection resolver shared by status and delete. It derives the
 * ingest line from the stored key inside `{bucket}/{key}`. Unknown or legacy
 * prefixes throw; there is no default collection and no all-collection scan.
 */
export function qdrantCollectionForSourceKey(sourceKey: string): string {
  const { key } = parseQdrantSourceKey(sourceKey);
  return QDRANT_COLLECTIONS[parseUploadObjectKey(key).ingestLine];
}

export class QdrantRestEvidenceAdapter implements QdrantEvidenceAdapter {
  constructor(
    private readonly client: QdrantScroller,
    private readonly collectionForSourceKey: QdrantCollectionResolver = qdrantCollectionForSourceKey,
  ) {}

  async hasProcessedEvidence(sourceKey: string): Promise<boolean> {
    const result = await this.client.scroll(this.collectionForSourceKey(sourceKey), {
      filter: {
        must: [{ key: 'source_key', match: { value: sourceKey } }],
      },
      limit: 1,
      with_payload: false,
      with_vector: false,
    });
    return result.points.length > 0;
  }

  async deleteBySourceKey(sourceKey: string): Promise<void> {
    const result = await this.client.delete(this.collectionForSourceKey(sourceKey), {
      filter: { must: [{ key: 'source_key', match: { value: sourceKey } }] },
      wait: true,
    });
    if (result.status !== 'completed') {
      throw new Error('Qdrant deletion has not completed');
    }
  }
}

export function createQdrantAdapter(
  config: QdrantConfig = getQdrantConfig(),
): QdrantEvidenceAdapter {
  return new QdrantRestEvidenceAdapter(
    new QdrantClient({ url: config.url, apiKey: config.apiKey }),
  );
}
