import { describe, expect, it } from "vitest";
import { inspectBrowserStorage } from "./browser-storage";

describe("browser storage status", () => {
  it("degrades safely when the storage manager is unavailable", async () => {
    expect(await inspectBrowserStorage()).toEqual({});
  });
});
