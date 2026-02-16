import { describe, test, expect } from "bun:test";
import { compressBuffer, splitBuffer, paginateFile } from "../src/paginate.js";

describe("compressBuffer", () => {
  test("compressed output can be decompressed back to original", async () => {
    const original = new TextEncoder().encode("hello world ".repeat(1000));
    const compressed = await compressBuffer(original);

    // Decompress using DecompressionStream
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();

    const parts: Uint8Array[] = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const totalLength = parts.reduce((s, p) => s + p.byteLength, 0);
    const decompressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      decompressed.set(part, offset);
      offset += part.byteLength;
    }

    expect(decompressed).toEqual(original);
  });

  test("compresses repetitive data to smaller size", async () => {
    const original = new TextEncoder().encode("aaaa".repeat(10000));
    const compressed = await compressBuffer(original);
    expect(compressed.byteLength).toBeLessThan(original.byteLength);
  });
});

describe("splitBuffer", () => {
  test("splits buffer into correct number of chunks", () => {
    const data = new Uint8Array(100);
    const chunks = splitBuffer(data, 30);
    expect(chunks.length).toBe(4); // 30 + 30 + 30 + 10
    expect(chunks[0].byteLength).toBe(30);
    expect(chunks[1].byteLength).toBe(30);
    expect(chunks[2].byteLength).toBe(30);
    expect(chunks[3].byteLength).toBe(10);
  });

  test("returns single chunk when data fits", () => {
    const data = new Uint8Array(20);
    const chunks = splitBuffer(data, 30);
    expect(chunks.length).toBe(1);
    expect(chunks[0].byteLength).toBe(20);
  });

  test("handles exact multiple of chunk size", () => {
    const data = new Uint8Array(60);
    const chunks = splitBuffer(data, 30);
    expect(chunks.length).toBe(2);
    expect(chunks[0].byteLength).toBe(30);
    expect(chunks[1].byteLength).toBe(30);
  });
});

describe("paginateFile", () => {
  test("single chunk when compressed fits within limit", async () => {
    const content = new TextEncoder().encode("hello ".repeat(100));
    const result = await paginateFile(
      { filename: "test.txt", mimeType: "text/plain", content },
      1024 * 1024, // 1MB limit — compressed output will be tiny
    );

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].filename).toBe("test.txt.gz");
    expect(result.chunks[0].mimeType).toBe("application/gzip");
    expect(result.compressedSize).toBeLessThan(result.originalSize);
    expect(result.reassemblyInstructions).toContain("gunzip");
    expect(result.reassemblyInstructions).not.toContain("Split");
  });

  test("multiple chunks when compressed exceeds limit", async () => {
    // Create ~200 bytes of incompressible random data, split into 50-byte chunks
    const content = crypto.getRandomValues(new Uint8Array(200));
    const result = await paginateFile(
      { filename: "data.bin", mimeType: "application/octet-stream", content },
      50, // tiny limit to force splitting
    );

    expect(result.chunks.length).toBeGreaterThan(1);
    // All chunks except last should be exactly 50 bytes
    for (let i = 0; i < result.chunks.length - 1; i++) {
      expect(result.chunks[i].content.byteLength).toBe(50);
    }
    // Filenames should have .001, .002 suffixes
    expect(result.chunks[0].filename).toBe("data.bin.gz.001");
    expect(result.chunks[1].filename).toBe("data.bin.gz.002");
    expect(result.reassemblyInstructions).toContain("Split");
    expect(result.reassemblyInstructions).toContain(`${result.chunks.length} parts`);
  });

  test("round-trip: concatenated chunks decompress to original", async () => {
    const original = new TextEncoder().encode("round trip test data ".repeat(500));
    const result = await paginateFile(
      { filename: "round.txt", mimeType: "text/plain", content: original },
      100, // force splitting of the compressed output
    );

    // Concatenate all chunks
    const totalLen = result.chunks.reduce((s, c) => s + c.content.byteLength, 0);
    const concatenated = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of result.chunks) {
      concatenated.set(chunk.content, offset);
      offset += chunk.content.byteLength;
    }

    // Decompress
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(concatenated);
    writer.close();

    const parts: Uint8Array[] = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const decompressedLen = parts.reduce((s, p) => s + p.byteLength, 0);
    const decompressed = new Uint8Array(decompressedLen);
    offset = 0;
    for (const part of parts) {
      decompressed.set(part, offset);
      offset += part.byteLength;
    }

    expect(decompressed).toEqual(original);
  });
});
