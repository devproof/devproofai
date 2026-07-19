// FileStore: dumb key-value content storage (concept §6.1 File entity).
// Keys are hierarchical (src/object-key.ts) and stored in files.object_key —
// this layer never derives, mints, or hashes anything. Dev impl = local
// directory (keys map to subdirectories); S3/MinIO impl for real runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export interface FileStore {
  put(content: Buffer, key: string): Promise<void> | void;
  get(key: string): Promise<Buffer> | Buffer;
  del(key: string): Promise<void> | void;
  /** Streaming read for large objects (public-API downloads). */
  getStream?(key: string): Promise<NodeJS.ReadableStream>;
  /** Full store walk (GC orphan-object scan). */
  list(): AsyncIterable<{ key: string; size: number; lastModified: Date }>;
  // Chunked uploads (public API, 4 GB files). key is the final object key;
  // uploadKey is store-opaque (S3 UploadId).
  createUpload?(key: string): Promise<string>;
  uploadPart?(key: string, uploadKey: string, partNumber: number, data: Buffer): Promise<string>;
  completeUpload?(key: string, uploadKey: string, parts: { n: number; etag: string }[]): Promise<void>;
  abortUpload?(key: string, uploadKey: string): Promise<void>;
}

/** Keys come from objectKey() so this is defense-in-depth, not the validator. */
function safeKey(key: string): string {
  if (!key || key.split("/").some((s) => !s || s === "." || s === "..")) throw new Error(`bad object key: ${key}`);
  return key;
}

export function localFileStore(root = process.env.DEVPROOF_FILES_DIR ?? ".devproof/files"): FileStore {
  mkdirSync(root, { recursive: true });
  const p = (key: string) => join(root, ...safeKey(key).split("/"));
  return {
    put(content: Buffer, key: string) {
      mkdirSync(dirname(p(key)), { recursive: true });
      writeFileSync(p(key), content);
    },
    get(key: string) { return readFileSync(p(key)); },
    del(key: string) { try { rmSync(p(key)); } catch { /* already gone */ } },
    async getStream(key: string) {
      const { createReadStream } = await import("node:fs");
      return createReadStream(p(key));
    },
    async *list() {
      for (const ent of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const full = join(ent.parentPath, ent.name);
        const rel = full.slice(root.length + 1).replaceAll("\\", "/");
        if (/\.part\d+$/.test(rel)) continue; // in-flight chunked-upload parts
        const st = statSync(full);
        yield { key: rel, size: st.size, lastModified: st.mtime };
      }
    },
    async createUpload(key: string) { safeKey(key); return "local"; },
    async uploadPart(key: string, _up: string, n: number, data: Buffer) {
      mkdirSync(dirname(p(key)), { recursive: true });
      writeFileSync(`${p(key)}.part${n}`, data);
      return String(n);
    },
    async completeUpload(key: string, _up: string, parts: { n: number; etag: string }[]) {
      const { createWriteStream, createReadStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const out = createWriteStream(p(key));
      try {
        for (const part of [...parts].sort((a, b) => a.n - b.n)) {
          await pipeline(createReadStream(`${p(key)}.part${part.n}`), out, { end: false });
        }
      } catch (err) {
        out.destroy();
        try { rmSync(p(key)); } catch { /* gone */ }
        throw err;
      }
      out.end();
      await new Promise<void>((r, j) => { out.on("close", () => r()); out.on("error", (err) => j(err)); });
      for (const part of parts) { try { rmSync(`${p(key)}.part${part.n}`); } catch { /* gone */ } }
    },
    async abortUpload(key: string, _up: string) {
      const dir = dirname(p(key));
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      const base = p(key).slice(dir.length + 1);
      for (const f of names) {
        if (f.startsWith(`${base}.part`)) { try { rmSync(join(dir, f)); } catch { /* gone */ } }
      }
    },
  };
}

/** S3Client options from config: custom endpoint (MinIO/S3-compatible) implies
 *  path-style + a default region; absent keys defer to the AWS SDK default
 *  credential chain (IRSA / EKS Pod Identity). */
export function s3ClientOptions(o: { endpoint?: string; region?: string; accessKey?: string; secretKey?: string }) {
  return {
    ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    ...(o.region ?? o.endpoint ? { region: o.region ?? "us-east-1" } : {}),
    ...(o.accessKey && o.secretKey
      ? { credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey } }
      : {}),
  };
}

/**
 * S3-compatible (MinIO) object store — the scalable file backend. Objects are
 * keyed by files.object_key (hierarchical, spec 2026-07-14). Any number of
 * control-plane replicas and session pods share one bucket.
 */
export function s3FileStore(opts: {
  endpoint?: string; region?: string; accessKey?: string; secretKey?: string; bucket: string;
}): FileStore {
  // Lazy import so the dep is only needed when S3 is selected.
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client(s3ClientOptions(opts));
  const streamToBuffer = async (stream: any): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };
  return {
    async put(content: Buffer, key: string) {
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: safeKey(key), Body: content }));
    },
    async get(key: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: safeKey(key) }));
      return streamToBuffer(res.Body);
    },
    async del(key: string) {
      // Deleting a missing key is a no-op in S3.
      try { await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: safeKey(key) })); } catch { /* ignore */ }
    },
    async getStream(key: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: safeKey(key) }));
      return res.Body as NodeJS.ReadableStream;
    },
    async *list() {
      let token: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: opts.bucket, ContinuationToken: token }));
        for (const o of res.Contents ?? []) {
          yield { key: o.Key as string, size: Number(o.Size ?? 0), lastModified: o.LastModified as Date };
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    },
    async createUpload(key: string) {
      const res = await client.send(new CreateMultipartUploadCommand({ Bucket: opts.bucket, Key: safeKey(key) }));
      return res.UploadId as string;
    },
    async uploadPart(key: string, uploadKey: string, partNumber: number, data: Buffer) {
      const res = await client.send(new UploadPartCommand({
        Bucket: opts.bucket, Key: safeKey(key), UploadId: uploadKey, PartNumber: partNumber, Body: data,
      }));
      return res.ETag as string;
    },
    async completeUpload(key: string, uploadKey: string, parts: { n: number; etag: string }[]) {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: opts.bucket, Key: safeKey(key), UploadId: uploadKey,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
      }));
    },
    async abortUpload(key: string, uploadKey: string) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: opts.bucket, Key: safeKey(key), UploadId: uploadKey }));
      } catch (err: any) {
        if (err?.name !== "NoSuchUpload") throw err;
      }
    },
  };
}
