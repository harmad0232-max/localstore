import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";

function posixJoin(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

function toKey(prefix, rel) {
  const cleaned = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return posixJoin(prefix || "", cleaned);
}

async function streamToBuffer(body) {
  if (!body) return Buffer.from("");
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === "function") {
    const arr = await body.transformToByteArray();
    return Buffer.from(arr);
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export class AwsS3Provider {
  constructor(options) {
    const bucket = options?.bucket || process.env.AWS_S3_BUCKET;
    if (!bucket) throw new Error("AWS_S3_BUCKET is required");
    const region = options?.region || process.env.AWS_REGION;
    if (!region) throw new Error("AWS_REGION is required");
    this.bucket = bucket;
    const basePrefix = String(options?.prefix || process.env.AWS_S3_PREFIX || "").replace(/\\/g, "/");
    const normalized = basePrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    this.prefix = normalized ? `${normalized}/` : "";
    this.client = new S3Client({ region });
    this.kmsKeyId = process.env.AWS_KMS_KEY_ID || null;
    this.sse = process.env.AWS_S3_SSE || null; // e.g., "AES256"
  }

  _sseParams() {
    // Prefer KMS if a key id is present, otherwise allow SSE-S3 (AES256) if requested
    if (this.kmsKeyId) {
      return { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.kmsKeyId };
    }
    if (this.sse && this.sse.toUpperCase() === "AES256") {
      return { ServerSideEncryption: "AES256" };
    }
    return {};
  }

  async list(dir) {
    const prefix = toKey(this.prefix, dir);
    const p = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    const resp = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: p,
        Delimiter: "/"
      })
    );
    const items = [];
    const dirMtimes = new Map();
    for (const obj of resp.Contents || []) {
      const key = obj.Key || "";
      if (key.endsWith("/") && obj.Size === 0) {
        dirMtimes.set(key, obj.LastModified ? obj.LastModified.getTime() : 0);
      }
    }
    for (const cp of resp.CommonPrefixes || []) {
      const key = cp.Prefix || "";
      const name = key.endsWith("/") ? key.slice(0, -1).split("/").pop() : key.split("/").pop();
      if (!name) continue;
      items.push({ name, type: "dir", size: 0, mtime: dirMtimes.get(key) || 0 });
    }
    for (const obj of resp.Contents || []) {
      const key = obj.Key || "";
      if (key.endsWith("/") && obj.Size === 0) continue;
      const name = key.split("/").pop();
      if (!name) continue;
      items.push({ name, type: "file", size: obj.Size || 0, mtime: obj.LastModified ? obj.LastModified.getTime() : 0 });
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  async getPresignedPutUrl(rel, contentType) {
    const key = toKey(this.prefix, rel);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType || "application/octet-stream",
      ...this._sseParams()
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: 3600 });
    return { url, method: "PUT" };
  }

  async ensureDir(dir) {
    const key = toKey(this.prefix, dir);
    const marker = key && !key.endsWith("/") ? `${key}/` : key || "";
    if (!marker) return;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: marker, Body: "", ...this._sseParams() }));
  }

  async put(filePath, buffer) {
    const key = toKey(this.prefix, filePath);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ...this._sseParams() }));
  }

  async putFile(filePath, localTempPath) {
    const key = toKey(this.prefix, filePath);
    await fsp.access(localTempPath);
    const body = fs.createReadStream(localTempPath);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ...this._sseParams() }));
  }

  async remove(p) {
    const key = toKey(this.prefix, p);
    // Treat the target as a "folder" prefix if it has children, otherwise fall back to deleting a single object.
    const prefix = key.endsWith("/") ? key : `${key}/`;

    let continuationToken = undefined;
    let foundAny = false;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      );

      const contents = resp.Contents || [];
      if (contents.length > 0) {
        foundAny = true;
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: contents.map((o) => ({ Key: o.Key }))
            }
          })
        );
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    // If nothing existed under the prefix, try removing a single object with the original key.
    if (!foundAny) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
  }

  async move(from, to) {
    const fromKey = toKey(this.prefix, from);
    const toKey2 = toKey(this.prefix, to);
    const copySource = encodeURIComponent(`${this.bucket}/${fromKey}`).replace(/%2F/g, "/");
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: toKey2, CopySource: copySource }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey }));
  }

  async read(p) {
    const key = toKey(this.prefix, p);
    const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return await streamToBuffer(resp.Body);
  }

  async exists(p) {
    const key = toKey(this.prefix, p);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      // Return false only when the object truly does not exist.
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") {
        return false;
      }
      // For permission/configuration or other errors, propagate so the API
      // can return a useful error instead of a misleading 404.
      throw e;
    }
  }
}
