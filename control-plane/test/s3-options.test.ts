import { test } from "node:test";
import assert from "node:assert";
import { s3ClientOptions } from "../src/filestore.ts";

test("custom endpoint (minio): path style + default region + static creds", () => {
  const o = s3ClientOptions({ endpoint: "http://minio:9000", accessKey: "a", secretKey: "b" });
  assert.deepStrictEqual(o, {
    endpoint: "http://minio:9000", forcePathStyle: true, region: "us-east-1",
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
  });
});

test("real AWS + pod identity: no endpoint, no creds, region from config", () => {
  const o = s3ClientOptions({ region: "eu-central-1" });
  assert.deepStrictEqual(o, { region: "eu-central-1" });
});

test("real AWS without region lets the SDK chain resolve it", () => {
  assert.deepStrictEqual(s3ClientOptions({}), {});
});
