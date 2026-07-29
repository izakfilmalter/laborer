import { createHash, randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { WebClient } from "@slack/web-api";
import { Effect } from "effect";
import {
  NormalizedImageInput,
  type NormalizedImageInput as NormalizedImageInputType,
} from "../prototype/domain.ts";
import {
  assertNoSymlinkPathComponents,
  ensureOwnerOnlyDirectoryTree,
  openRegularFileNoFollow,
} from "../prototype/path-safety.ts";
import { SlackBoundaryError } from "./errors.ts";
import type {
  ResolveSlackInboundImages,
  SlackInboundImageCandidate,
} from "./normalize.ts";

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES = 768 * 1024;
export const MAX_AGGREGATE_IMAGE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 2;
const DOWNLOAD_TIMEOUT_MILLIS = 10_000;
const SUPPORTED_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];
const isSupportedMimeType = (value: string): value is SupportedMimeType =>
  SUPPORTED_MIME_TYPES.some((candidate) => candidate === value);
const STABLE_DOWNLOAD_FAILURES = new Set([
  "content-length-mismatch",
  "content-type-mismatch",
  "download-failed",
  "download-timeout",
  "image-signature-mismatch",
  "image-too-large",
  "redirect-limit",
  "truncated-download",
  "untrusted-download-origin",
]);

interface SlackFileMetadata {
  readonly id: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url: string;
}

interface DownloadedSlackImage {
  readonly bytes: Uint8Array;
  readonly candidate: SlackInboundImageCandidate;
  readonly index: number;
  readonly mimeType: SupportedMimeType;
}

export interface SlackInboundImageResolverOptions {
  readonly client: Pick<WebClient, "files"> & { readonly token?: string };
  readonly fetch?: typeof fetch;
  readonly storageRoot: string;
}

const boundaryFailure = (reason: string): SlackBoundaryError =>
  SlackBoundaryError.make({ boundary: "slack-files-api", reason });

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const downloadFailureReason = (cause: unknown): string => {
  if (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.name === "TimeoutError")
  ) {
    return "download-timeout";
  }
  return cause instanceof Error && STABLE_DOWNLOAD_FAILURES.has(cause.message)
    ? cause.message
    : "download-failed";
};

const extensionFor = (mimeType: string): string => {
  switch (mimeType) {
    case "image/gif":
      return "gif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    default:
      return "webp";
  }
};

const bytesMatchMimeType = (bytes: Uint8Array, mimeType: string): boolean => {
  if (mimeType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  const prefix = new TextDecoder().decode(bytes.slice(0, 12));
  if (mimeType === "image/gif") {
    return prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a");
  }
  return (
    mimeType === "image/webp" &&
    prefix.startsWith("RIFF") &&
    prefix.slice(8, 12) === "WEBP"
  );
};

const slackDownloadHostIsAllowed = (url: URL): boolean =>
  url.protocol === "https:" &&
  (url.hostname === "files.slack.com" ||
    url.hostname === "files-origin.slack.com" ||
    url.hostname === "slack-files.com" ||
    url.hostname.endsWith(".slack-files.com"));

const metadataFrom = (
  value: unknown,
  expectedId: string
): SlackFileMetadata | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("file" in value) ||
    typeof value.file !== "object" ||
    value.file === null
  ) {
    return null;
  }
  const file = value.file as Record<string, unknown>;
  const url =
    typeof file.url_private_download === "string"
      ? file.url_private_download
      : file.url_private;
  if (
    file.id !== expectedId ||
    typeof file.mimetype !== "string" ||
    typeof file.size !== "number" ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    typeof url !== "string"
  ) {
    return null;
  }
  return {
    id: expectedId,
    mimetype: file.mimetype.toLowerCase(),
    size: file.size,
    url,
  };
};

const downloadImage = async (options: {
  readonly deadline: number;
  readonly fetch: typeof fetch;
  readonly metadata: SlackFileMetadata;
  readonly token: string;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: redirect, response, stream, and signature checks intentionally share one credential-bearing download boundary
}): Promise<Uint8Array> => {
  let current = new URL(options.metadata.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!slackDownloadHostIsAllowed(current)) {
      throw new Error("untrusted-download-origin");
    }
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("download-timeout");
    }
    const response = await options.fetch(current, {
      headers: { authorization: `Bearer ${options.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null || redirects === MAX_REDIRECTS) {
        throw new Error("redirect-limit");
      }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error("download-failed");
    }
    const responseMime = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (responseMime !== options.metadata.mimetype) {
      await response.body.cancel();
      throw new Error("content-type-mismatch");
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      Number(contentLength) !== options.metadata.size
    ) {
      await response.body.cancel();
      throw new Error("content-length-mismatch");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let fullyRead = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          fullyRead = true;
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > MAX_IMAGE_BYTES || bytes > options.metadata.size) {
          throw new Error("image-too-large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      if (!fullyRead) {
        await reader.cancel().catch(() => undefined);
      }
    }
    if (bytes !== options.metadata.size) {
      throw new Error("truncated-download");
    }
    const complete = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      complete.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!bytesMatchMimeType(complete, options.metadata.mimetype)) {
      throw new Error("image-signature-mismatch");
    }
    return complete;
  }
  throw new Error("redirect-limit");
};

const stageImage = async (options: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly storageRoot: string;
}): Promise<{
  readonly contentDigest: string;
  readonly contentPath: string;
}> => {
  const contentDigest = createHash("sha256")
    .update(options.bytes)
    .digest("hex");
  const directory = resolve(options.storageRoot, "inbound-images");
  await ensureOwnerOnlyDirectoryTree({
    anchor: options.storageRoot,
    operation: "stage-inbound-image",
    target: directory,
  });
  const target = resolve(
    directory,
    `${contentDigest}.${extensionFor(options.mimeType)}`
  );
  await assertNoSymlinkPathComponents(
    directory,
    "stage-inbound-image-directory"
  );
  const verifyExistingTarget = async (): Promise<void> => {
    const file = await openRegularFileNoFollow(
      target,
      "verify-existing-inbound-image"
    );
    try {
      const existing = await file.stat();
      if (
        existing.size !== options.bytes.byteLength ||
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
        (existing.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          existing.uid !== process.getuid())
      ) {
        throw new Error("unsafe-existing-image");
      }
      const existingBytes = new Uint8Array(options.bytes.byteLength + 1);
      let offset = 0;
      while (offset < existingBytes.byteLength) {
        const read = await file.read(
          existingBytes,
          offset,
          existingBytes.byteLength - offset,
          offset
        );
        if (read.bytesRead === 0) {
          break;
        }
        offset += read.bytesRead;
      }
      if (
        offset !== options.bytes.byteLength ||
        createHash("sha256")
          .update(existingBytes.subarray(0, offset))
          .digest("hex") !== contentDigest
      ) {
        throw new Error("conflicting-existing-image");
      }
    } finally {
      await file.close();
    }
  };
  try {
    await verifyExistingTarget();
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT") {
      throw cause;
    }
    const temporary = resolve(
      directory,
      `.${basename(target)}.${randomUUID()}`
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(options.bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (cause) {
        if (errnoCode(cause) !== "EEXIST") {
          throw cause;
        }
        await verifyExistingTarget();
      }
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
  return { contentDigest, contentPath: relative(options.storageRoot, target) };
};

export const makeSlackInboundImageResolver = (
  options: SlackInboundImageResolverOptions
): ResolveSlackInboundImages => {
  const client = options.client;
  const fetchImplementation = options.fetch ?? fetch;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: all per-message count, metadata, byte, download, and publication bounds fail closed in this adapter boundary
  const resolveImages = Effect.fn("SlackInboundImages.resolve")(function* (
    request: Parameters<ResolveSlackInboundImages>[0]
  ) {
    if (request.candidates.length > MAX_IMAGES_PER_MESSAGE) {
      return yield* boundaryFailure("image-count-limit");
    }
    if (typeof client.token !== "string" || client.token.length === 0) {
      return yield* boundaryFailure("missing-files-authorization");
    }
    const token = client.token;
    let aggregateBytes = 0;
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MILLIS;
    const downloaded: DownloadedSlackImage[] = [];
    for (const [index, candidate] of request.candidates.entries()) {
      const response = yield* Effect.tryPromise({
        try: () => client.files.info({ file: candidate.id }),
        catch: () => boundaryFailure("file-metadata-unavailable"),
      });
      const metadata = metadataFrom(response, candidate.id);
      if (metadata === null) {
        return yield* boundaryFailure("invalid-file-metadata");
      }
      if (!isSupportedMimeType(metadata.mimetype)) {
        return yield* boundaryFailure("unsupported-image-type");
      }
      if (metadata.size > MAX_IMAGE_BYTES) {
        return yield* boundaryFailure("image-byte-limit");
      }
      aggregateBytes += metadata.size;
      if (
        aggregateBytes >
        Math.min(
          MAX_AGGREGATE_IMAGE_BYTES,
          request.maxAggregateBytes ?? MAX_AGGREGATE_IMAGE_BYTES
        )
      ) {
        return yield* boundaryFailure("aggregate-image-byte-limit");
      }
      const parsedUrl = yield* Effect.try({
        try: () => new URL(metadata.url),
        catch: () => boundaryFailure("invalid-download-url"),
      });
      if (!slackDownloadHostIsAllowed(parsedUrl)) {
        return yield* boundaryFailure("untrusted-download-origin");
      }
      const bytes = yield* Effect.tryPromise({
        try: () =>
          downloadImage({
            deadline,
            fetch: fetchImplementation,
            metadata,
            token,
          }),
        catch: (cause) => boundaryFailure(downloadFailureReason(cause)),
      });
      downloaded.push({
        bytes,
        candidate,
        index,
        mimeType: metadata.mimetype,
      });
    }
    const resolved: NormalizedImageInputType[] = [];
    for (const { bytes, candidate, index, mimeType } of downloaded) {
      const staged = yield* Effect.tryPromise({
        try: () =>
          stageImage({
            bytes,
            mimeType,
            storageRoot: options.storageRoot,
          }),
        catch: () => boundaryFailure("image-staging-failed"),
      });
      resolved.push(
        NormalizedImageInput.make({
          byteLength: bytes.byteLength,
          contentDigest: staged.contentDigest,
          contentPath: staged.contentPath,
          id: createHash("sha256")
            .update(
              `${request.channelId}\0${request.messageTs}\0${index}\0${candidate.id}`,
              "utf8"
            )
            .digest("hex"),
          mimeType,
          slackFileId: candidate.id,
        })
      );
    }
    return resolved;
  });
  return (request) =>
    resolveImages(request).pipe(
      Effect.timeoutOrElse({
        duration: DOWNLOAD_TIMEOUT_MILLIS,
        orElse: () => boundaryFailure("download-timeout"),
      })
    );
};
