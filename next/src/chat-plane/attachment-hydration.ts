import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { NormalizedImage } from "../core/domain.ts";

interface HydratableAttachment {
  readonly fetchData?: () => Promise<Buffer>;
  readonly fetchMetadata?: Record<string, string>;
  readonly mimeType?: string;
  readonly size?: number;
  readonly type: "audio" | "file" | "image" | "video";
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 768 * 1024;
const FETCH_DEADLINE_MILLIS = 10_000;
const imageTypes: ReadonlyMap<string, "gif" | "jpg" | "png" | "webp"> = new Map(
  [
    ["image/gif", "gif"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const
);

const hasSignature = (data: Buffer, mimeType: string): boolean => {
  if (mimeType === "image/png") {
    return data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return data[0] === 0xff && data[1] === 0xd8;
  }
  if (mimeType === "image/gif") {
    return data.subarray(0, 4).toString("ascii") === "GIF8";
  }
  return (
    mimeType === "image/webp" &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  );
};

const unavailable = (id: string, reason: string): NormalizedImage => ({
  failureReason: reason,
  id,
  slackFileId: id,
});

/** Bounded Chat-attachment hydration; raw Slack payloads never leave Chat. */
export const hydrateChatImageAttachments = async (
  attachments: readonly HydratableAttachment[],
  storageRoot: string
): Promise<readonly NormalizedImage[]> => {
  const images = attachments
    .filter((attachment) => attachment.type === "image")
    .slice(0, MAX_IMAGES);
  const destination = resolve(storageRoot, "inbound-images");
  await mkdir(destination, { mode: 0o700, recursive: true });
  let aggregate = 0;
  return Promise.all(
    images.map(async (attachment, index): Promise<NormalizedImage> => {
      const id = attachment.fetchMetadata?.fileId ?? `chat-attachment-${index}`;
      const mimeType = attachment.mimeType ?? "";
      const extension = imageTypes.get(mimeType);
      if (
        extension === undefined ||
        attachment.fetchData === undefined ||
        attachment.size === undefined ||
        attachment.size <= 0 ||
        attachment.size > MAX_IMAGE_BYTES ||
        aggregate + attachment.size > MAX_IMAGE_BYTES
      ) {
        return unavailable(id, "image attachment is unavailable");
      }
      aggregate += attachment.size;
      try {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const data = await Promise.race([
          attachment.fetchData(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("deadline")),
              FETCH_DEADLINE_MILLIS
            );
          }),
        ]).finally(() => {
          if (deadline !== undefined) {
            clearTimeout(deadline);
          }
        });
        if (
          data.byteLength !== attachment.size ||
          data.byteLength > MAX_IMAGE_BYTES ||
          !hasSignature(data, mimeType)
        ) {
          return unavailable(id, "image attachment failed validation");
        }
        const digest = createHash("sha256").update(data).digest("hex");
        const relativePath = `inbound-images/${digest}.${extension}`;
        await writeFile(resolve(storageRoot, relativePath), data, {
          flag: "wx",
          mode: 0o600,
        }).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "EEXIST") {
            throw cause;
          }
        });
        return {
          byteLength: data.byteLength,
          contentDigest: digest,
          contentPath: relativePath,
          id: `${id}:${digest}`,
          mimeType: mimeType as
            | "image/gif"
            | "image/jpeg"
            | "image/png"
            | "image/webp",
          slackFileId: id,
        };
      } catch {
        return unavailable(id, "image attachment hydration failed");
      }
    })
  );
};
