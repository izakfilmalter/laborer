import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import {
  FailedNormalizedImageInput,
  type NormalizedImageInput,
  ReadyNormalizedImageInput,
} from "../prototype/domain.ts";

const MAX_IMAGE_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MILLIS = 10_000;
const MAX_REDIRECTS = 3;
const SUPPORTED_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SLACK_FILE_HOSTS = new Set([
  "files.slack.com",
  "files-origin.slack.com",
  "slack-files.com",
]);

const SlackFileReference = Schema.Struct({
  id: Schema.NonEmptyString,
  mimetype: Schema.optional(Schema.String),
});
const SlackFileInfo = Schema.Struct({
  file: Schema.Struct({
    id: Schema.NonEmptyString,
    mimetype: Schema.String,
    size: Schema.optional(Schema.Number),
    url_private_download: Schema.optional(Schema.String),
    url_private: Schema.optional(Schema.String),
  }),
  ok: Schema.optional(Schema.Boolean),
});

export interface SlackImageInputHydrator {
  readonly hydrate: (options: {
    readonly files: unknown;
    readonly messageId: string;
  }) => Effect.Effect<readonly NormalizedImageInput[]>;
}

export interface SlackImageInputHydratorOptions {
  readonly client: {
    readonly files: {
      readonly info: (options: { readonly file: string }) => Promise<unknown>;
    };
    readonly token?: string;
  };
  readonly fetch?: ImageFetch;
  readonly storageRoot: string;
}

type ImageFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const stableInputId = (messageId: string, fileId: string): string =>
  `image:${createHash("sha256").update(`${messageId}\0${fileId}`).digest("base64url")}`;

const failed = (
  id: string,
  reason: InstanceType<typeof FailedNormalizedImageInput>["reason"]
): NormalizedImageInput => FailedNormalizedImageInput.make({ id, reason });

const isAllowedSlackFileUrl = (candidate: URL): boolean =>
  candidate.protocol === "https:" && SLACK_FILE_HOSTS.has(candidate.hostname);

const contentType = (response: Response): string =>
  (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";

const boundedResponseBytes = async (
  response: Response
): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_IMAGE_BYTES) {
    throw new Error("size-exceeded");
  }
  if (response.body === null) {
    throw new Error("invalid-response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > MAX_IMAGE_BYTES) {
        throw new Error("size-exceeded");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== length) {
    throw new Error("invalid-response");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const authenticatedDownload = async (options: {
  readonly fetch: ImageFetch;
  readonly token: string;
  readonly url: string;
}): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> => {
  const cancellation = new AbortController();
  const timeout = setTimeout(
    () => cancellation.abort(),
    DOWNLOAD_TIMEOUT_MILLIS
  );
  try {
    let current: URL;
    try {
      current = new URL(options.url);
    } catch {
      throw new Error("unsafe-download-url");
    }
    const aborted = new Promise<never>((_resolve, reject) =>
      cancellation.signal.addEventListener(
        "abort",
        () => reject(new Error("download-timeout")),
        { once: true }
      )
    );
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (!isAllowedSlackFileUrl(current)) {
        throw new Error("unsafe-download-url");
      }
      const response = await Promise.race([
        options.fetch(current, {
          headers: { authorization: `Bearer ${options.token}` },
          redirect: "manual",
          signal: cancellation.signal,
        }),
        aborted,
      ]);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null || redirects === MAX_REDIRECTS) {
          throw new Error("invalid-response");
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new Error("invalid-response");
      }
      return {
        bytes: await boundedResponseBytes(response),
        mimeType: contentType(response),
      };
    }
    throw new Error("invalid-response");
  } catch (cause) {
    if (cancellation.signal.aborted) {
      throw new Error("download-timeout");
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
};

const stageImage = async (options: {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly storageRoot: string;
}): Promise<string> => {
  const canonicalRoot = await realpath(options.storageRoot);
  const directory = resolve(canonicalRoot, "image-inputs");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const canonicalDirectory = await realpath(directory);
  if (
    canonicalDirectory !== canonicalRoot &&
    !canonicalDirectory.startsWith(`${canonicalRoot}${sep}`)
  ) {
    throw new Error("storage-failed");
  }
  const target = resolve(canonicalDirectory, options.digest);
  const existing = await lstat(target).catch(() => null);
  if (existing !== null) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.size !== options.bytes.byteLength
    ) {
      throw new Error("storage-failed");
    }
    const existingDigest = createHash("sha256")
      .update(await readFile(target))
      .digest("base64url");
    if (existingDigest !== options.digest) {
      throw new Error("storage-failed");
    }
    return relative(canonicalRoot, target);
  }
  const temporary = resolve(
    canonicalDirectory,
    `.${options.digest}.${process.pid}.${randomUUID()}.tmp`
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(options.bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
    const directoryHandle = await open(dirname(target), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
  return relative(canonicalRoot, target);
};

const reasonFor = (
  cause: unknown
): InstanceType<typeof FailedNormalizedImageInput>["reason"] => {
  if (cause instanceof Error) {
    const known = [
      "download-timeout",
      "invalid-response",
      "mime-mismatch",
      "size-exceeded",
      "storage-failed",
      "unsupported-mime",
      "unsafe-download-url",
    ] as const;
    const reason = known.find((candidate) => candidate === cause.message);
    if (reason !== undefined) {
      return reason;
    }
  }
  return "metadata-unavailable";
};

export const makeSlackImageInputHydrator = (
  options: SlackImageInputHydratorOptions
): SlackImageInputHydrator => ({
  hydrate: ({ files, messageId }) =>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the linear fail-closed boundary keeps each metadata, network, validation, and staging decision explicit
    Effect.promise(async () => {
      let decoded: readonly (typeof SlackFileReference.Type)[];
      try {
        decoded = Schema.decodeUnknownSync(Schema.Array(SlackFileReference))(
          files
        );
      } catch {
        return [];
      }
      if (decoded.length === 0) {
        return [];
      }
      const references = decoded.filter((file) =>
        (file.mimetype ?? "").startsWith("image/")
      );
      if (references.length === 0) {
        return [];
      }
      if (references.length > 1) {
        return [
          failed(
            stableInputId(messageId, references[0]?.id ?? "count"),
            "image-count-exceeded"
          ),
        ];
      }
      const reference = references[0];
      if (reference === undefined) {
        return [];
      }
      const id = stableInputId(messageId, reference.id);
      try {
        const response = await options.client.files.info({
          file: reference.id,
        });
        let metadata: typeof SlackFileInfo.Type;
        try {
          metadata = Schema.decodeUnknownSync(SlackFileInfo)(response);
        } catch {
          return [failed(id, "metadata-unavailable")];
        }
        const file = metadata.file;
        if (file.id !== reference.id) {
          return [failed(id, "metadata-unavailable")];
        }
        const expectedMime = file.mimetype.toLowerCase();
        if (!SUPPORTED_MIME_TYPES.has(expectedMime)) {
          return [failed(id, "unsupported-mime")];
        }
        if ((file.size ?? 0) > MAX_IMAGE_BYTES) {
          return [failed(id, "size-exceeded")];
        }
        const url = file.url_private_download ?? file.url_private;
        if (url === undefined || options.client.token === undefined) {
          return [failed(id, "metadata-unavailable")];
        }
        const downloaded = await authenticatedDownload({
          fetch: options.fetch ?? ((input, init) => fetch(input, init)),
          token: options.client.token,
          url,
        });
        if (downloaded.mimeType !== expectedMime) {
          return [failed(id, "mime-mismatch")];
        }
        const digest = createHash("sha256")
          .update(downloaded.bytes)
          .digest("base64url");
        const storagePath = await stageImage({
          bytes: downloaded.bytes,
          digest,
          storageRoot: options.storageRoot,
        });
        return [
          ReadyNormalizedImageInput.make({
            byteLength: downloaded.bytes.byteLength,
            contentDigest: digest,
            id,
            mimeType: expectedMime as
              | "image/gif"
              | "image/jpeg"
              | "image/png"
              | "image/webp",
            storagePath,
          }),
        ];
      } catch (cause) {
        return [failed(id, reasonFor(cause))];
      }
    }),
});
