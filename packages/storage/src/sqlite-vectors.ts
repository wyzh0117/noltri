/**
 * The local vector store: Float32 blobs plus the provenance each vector needs.
 *
 * Postgres pinned the width in the column type, so a dimension mismatch was impossible. A local file
 * keeps several models' output over time, so every vector carries `modelId`, `dimension`,
 * `normalization`, `sourceHash` and `builderVersion`, and a search only ever compares vectors of the
 * query's own width. Historical thresholds and widths from the Postgres era are not assumed here.
 *
 * V1 computes cosine exactly over the candidate set — no ANN extension to package. The interface is
 * the seam: swapping in an index implementation does not touch the repository.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type VectorOwnerType = 'knowledge_item' | 'knowledge_node';

export type VectorNormalization = 'unnormalized' | 'l2';

export interface VectorProvenance {
  modelId: string | null;
  normalization: VectorNormalization;
  /** Hash of the exact text the vector was built from, so a rebuild can find stale rows. */
  sourceText: string;
  builderVersion: string | null;
}

export interface VectorCandidate {
  ownerId: string;
  score: number;
}

export interface VectorScanOptions {
  limit: number;
  threshold: number;
  /**
   * Extra `and …` predicates applied to the joined owning row, aliased `e` — status filters and the
   * exclusion of the source a capture is currently processing live here, because they differ per owner.
   */
  onOwner?: { where: string; params: (number | string | null)[] };
}

/** Row shape of `vectors` after the join with its owning entity. */
interface VectorRow {
  owner_id: string;
  dimension: number;
  embedding: Uint8Array;
}

export function hashVectorSource(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function encodeEmbedding(vector: number[]): Uint8Array {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new Float32Array(buffer);
  view.set(vector);
  return new Uint8Array(buffer);
}

export function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, blob.byteLength / 4);
}

/** Cosine over equal-width vectors; 0 when either side is the zero vector. */
export function cosine(first: ArrayLike<number>, second: ArrayLike<number>): number {
  const length = Math.min(first.length, second.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const x = first[index] ?? 0;
    const y = second[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VectorIndex {
  upsert(
    ownerType: VectorOwnerType,
    ownerId: string,
    userId: string,
    embedding: number[],
    provenance: VectorProvenance,
    timestamp: string,
  ): void;
  remove(ownerType: VectorOwnerType, ownerId: string): void;
  /**
   * Exact cosine over every stored vector of the query's width, joined to the owning row so the
   * scoping predicates and the user isolation apply. `onOwner.where` is a constant written by the
   * repository, never client input; its values are bound as parameters.
   */
  search(
    ownerType: VectorOwnerType,
    userId: string,
    query: number[],
    options: VectorScanOptions,
  ): VectorCandidate[];
}

/** Fixed map, so a caller-supplied owner type can never reach the statement as an identifier. */
const OWNER_TABLE: Record<VectorOwnerType, string> = {
  knowledge_item: 'knowledge_items',
  knowledge_node: 'knowledge_nodes',
};

export function createVectorIndex(db: DatabaseSync): VectorIndex {
  const insert = db.prepare(
    `insert into vectors (
       owner_type, owner_id, user_id, model_id, dimension, normalization,
       source_hash, builder_version, embedding, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (owner_type, owner_id) do update set
       user_id = excluded.user_id,
       model_id = excluded.model_id,
       dimension = excluded.dimension,
       normalization = excluded.normalization,
       source_hash = excluded.source_hash,
       builder_version = excluded.builder_version,
       embedding = excluded.embedding,
       updated_at = excluded.updated_at`,
  );
  const remove = db.prepare('delete from vectors where owner_type = ? and owner_id = ?');
  return {
    upsert(ownerType, ownerId, userId, embedding, provenance, timestamp) {
      insert.run(
        ownerType,
        ownerId,
        userId,
        provenance.modelId,
        embedding.length,
        provenance.normalization,
        hashVectorSource(provenance.sourceText),
        provenance.builderVersion,
        encodeEmbedding(embedding),
        timestamp,
        timestamp,
      );
    },

    remove(ownerType, ownerId) {
      remove.run(ownerType, ownerId);
    },

    search(ownerType, userId, query, options) {
      const owner = OWNER_TABLE[ownerType];
      const extra = options.onOwner?.where ?? '';
      const sql = `
        select v.owner_id as owner_id, v.dimension as dimension, v.embedding as embedding
          from vectors v
          join ${String(owner)} e on e.id = v.owner_id
         where v.owner_type = ? and v.user_id = ? and v.dimension = ? ${String(extra)}`;
      const params = [
        ownerType,
        userId,
        query.length,
        ...(options.onOwner?.params ?? []),
      ] as (number | string)[];
      const rows = db.prepare(sql).all(...params) as unknown as VectorRow[];
      const scored: VectorCandidate[] = [];
      for (const row of rows) {
        const score = cosine(query, decodeEmbedding(row.embedding));
        if (score < options.threshold) continue;
        scored.push({ ownerId: row.owner_id, score });
      }
      return scored.sort((first, second) => second.score - first.score).slice(0, options.limit);
    },

  };
}
