import { mkdtempSync, rmSync } from "node:fs";
import type { rm as removeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type RemoveFile = typeof removeFile;

const fileSystem = vi.hoisted(() => ({
  actualRemove: null as RemoveFile | null,
  remove: vi.fn<RemoveFile>()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fileSystem.actualRemove = actual.rm;
  return { ...actual, rm: fileSystem.remove };
});

import { AttachmentStorage } from "../../src/attachment-storage.js";

const temporaryRoots: string[] = [];

beforeEach(() => {
  fileSystem.remove.mockReset();
  fileSystem.remove.mockImplementation(async (path, options) => {
    await fileSystem.actualRemove?.(path, options);
  });
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("在 Windows 临时锁释放后重试删除转换候选文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "scriverse-attachment-storage-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "source.png");
  await sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 60, g: 120, b: 180 } }
  }).png().toFile(sourcePath);

  let transientFailures = 0;
  fileSystem.remove.mockImplementation(async (path, options) => {
    if (String(path).endsWith(".webp") && transientFailures === 0) {
      transientFailures += 1;
      throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    }
    await fileSystem.actualRemove?.(path, options);
  });

  const stored = await new AttachmentStorage(root).ingest(sourcePath);

  expect(stored.storedMimeType).toBe("image/webp");
  expect(transientFailures).toBe(1);
});
