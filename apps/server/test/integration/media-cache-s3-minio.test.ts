import { createHash } from 'node:crypto';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaBlobIdentity, MediaBlobReadRange } from '../../src/media-cache/blob-store.js';
import { S3MediaBlobBackend } from '../../src/media-cache/s3-blob-backend.js';

// Pinned Scality CloudServer, an open S3-compatible server that requires no
// license and supports path-style requests. Official MinIO CE images
// (minio/minio on Docker Hub and quay.io, registry.min.io) are no longer
// anonymously pullable, so they cannot back a public CI.
// https://hub.docker.com/r/zenko/cloudserver
// NOTE: the backend relies on conditional create (`If-None-Match: *`), which
// this image must support for the "keeps create-only ... semantics" assertion.
const S3_IMAGE = 'zenko/cloudserver:8.7.33';
const S3_PORT = 8_000;
const S3_ACCESS_KEY = 'koharu-minio';
const S3_SECRET_KEY = 'koharu-minio-integration-secret';
const BUCKET = 'koharu-media-integration';
const PREFIX = 'suite/integration/v1';
const REGION = 'us-east-1';

let container: StartedTestContainer | undefined;
let bootstrapClient: S3Client | undefined;
let backend: S3MediaBlobBackend | undefined;

function isUnavailableContainerRuntime(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Could not find a working container runtime strategy')
  );
}

async function hasContainerRuntime(): Promise<boolean> {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch (error) {
    if (isUnavailableContainerRuntime(error)) {
      return false;
    }
    throw error;
  }
}

const containerRuntimeAvailable = await hasContainerRuntime();

function identity(content: Uint8Array): MediaBlobIdentity {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    byteLength: content.byteLength,
    relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
    sha256,
  };
}

function source(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

async function readBlob(
  mediaBackend: S3MediaBlobBackend,
  blob: MediaBlobIdentity,
  range?: MediaBlobReadRange,
): Promise<Buffer> {
  const handle = await mediaBackend.read(blob);
  try {
    return Buffer.from(await new Response(handle.stream(range)).arrayBuffer());
  } finally {
    await handle.close();
  }
}

describe.skipIf(!containerRuntimeAvailable)(
  'S3 media blob backend against an S3-compatible container',
  () => {
      beforeAll(async () => {
        container = await new GenericContainer(S3_IMAGE)
          .withEnvironment({
            SCALITY_ACCESS_KEY_ID: S3_ACCESS_KEY,
            SCALITY_REGION: REGION,
            SCALITY_SECRET_ACCESS_KEY: S3_SECRET_KEY,
          })
          .withExposedPorts(S3_PORT)
          .withWaitStrategy(Wait.forHttp('/getready', S3_PORT))
          .withStartupTimeout(120_000)
          .start();
    
        const endpoint = `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`;
        const credentials = {
          accessKeyId: S3_ACCESS_KEY,
          secretAccessKey: S3_SECRET_KEY,
        };
        bootstrapClient = new S3Client({
          credentials,
          endpoint,
          forcePathStyle: true,
          region: REGION,
        });
        await bootstrapClient.send(new CreateBucketCommand({ Bucket: BUCKET }));
        backend = new S3MediaBlobBackend({
          bucket: BUCKET,
          credentials,
          endpoint,
          forcePathStyle: true,
          prefix: PREFIX,
          region: REGION,
        });
      }, 120_000);
    
      afterAll(async () => {
        bootstrapClient?.destroy();
        await container?.stop();
      }, 30_000);
    
      it('keeps create-only, verification, range, prefix, and deletion semantics', async () => {
        if (!backend || !bootstrapClient) {
          throw new Error('MinIO integration fixture was not initialized');
        }
        const content = Buffer.from('koharu durable MinIO compatibility baseline');
        const blob = identity(content);
        const expectedKey = `${PREFIX}/${blob.relativeKey}`;
    
        await expect(backend.put({ identity: blob, source: source(content) })).resolves.toEqual({
          outcome: 'created',
        });
        await expect(backend.put({ identity: blob, source: source(content) })).resolves.toEqual({
          outcome: 'already_present',
        });
    
        expect(backend.key(blob)).toBe(expectedKey);
        await expect(
          bootstrapClient.send(new HeadObjectCommand({ Bucket: BUCKET, Key: expectedKey })),
        ).resolves.toMatchObject({
          ContentLength: content.byteLength,
          Metadata: { 'koharu-sha256': blob.sha256 },
        });
        await expect(backend.head(blob)).resolves.toMatchObject({
          byteLength: content.byteLength,
          sha256: blob.sha256,
        });
    
        await expect(readBlob(backend, blob)).resolves.toEqual(content);
        const range = { end: 21, start: 7 };
        await expect(readBlob(backend, blob, range)).resolves.toEqual(
          content.subarray(range.start, range.end + 1),
        );
    
        await expect(backend.delete(blob)).resolves.toBe('absent_or_deleted');
        await expect(backend.head(blob)).resolves.toBeNull();
      });
    });
