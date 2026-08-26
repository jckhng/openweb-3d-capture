import { describe, expect, it } from "vitest";
import { encodeBinaryPointCloudPly } from "./ply";

describe("binary point-cloud PLY", () => {
  it("writes float positions and 8-bit RGB vertices", () => {
    const encoded = encodeBinaryPointCloudPly([{
      x: 1.25,
      y: -2.5,
      z: 3.75,
      red: 12,
      green: 260,
      blue: -5,
    }]);
    const endHeader = new TextEncoder().encode("end_header\n");
    const headerEnd = findSequence(encoded, endHeader) + endHeader.length;
    const header = new TextDecoder().decode(encoded.slice(0, headerEnd));
    expect(header).toContain("format binary_little_endian 1.0");
    expect(header).toContain("element vertex 1");
    expect(encoded.byteLength - headerEnd).toBe(15);
    const view = new DataView(encoded.buffer, encoded.byteOffset + headerEnd, 15);
    expect(view.getFloat32(0, true)).toBeCloseTo(1.25);
    expect(view.getFloat32(4, true)).toBeCloseTo(-2.5);
    expect(view.getFloat32(8, true)).toBeCloseTo(3.75);
    expect([view.getUint8(12), view.getUint8(13), view.getUint8(14)]).toEqual([12, 255, 0]);
  });
});

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}
