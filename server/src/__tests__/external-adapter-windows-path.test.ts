import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExternalAdapterPackage } from "../adapters/plugin-loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("external adapter module loading", () => {
  it("loads an adapter from an absolute local filesystem path", async () => {
    const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-external-adapter-"));
    tempDirs.push(packageDir);

    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "paperclip-test-external-adapter",
        type: "module",
        exports: { ".": "./index.mjs" },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(packageDir, "index.mjs"),
      "export function createServerAdapter() { return { type: 'test_external_adapter' }; }\n",
      "utf8",
    );

    const adapter = await loadExternalAdapterPackage("paperclip-test-external-adapter", packageDir);

    expect(adapter.type).toBe("test_external_adapter");
  });
});
