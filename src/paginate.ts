/**
 * Compresses and splits large files for upload to Discord in multiple parts.
 */

import type { EmailAttachment } from "./discord.js";

/** 9 MB per chunk — leaves ~1 MB headroom under Discord's 10 MB free-tier limit. */
const DEFAULT_PART_SIZE = 9 * 1024 * 1024;

export interface FileChunk {
  filename: string;
  content: Uint8Array;
  mimeType: string;
}

export interface PaginatedFile {
  originalFilename: string;
  originalSize: number;
  compressedSize: number;
  chunks: FileChunk[];
  reassemblyInstructions: string;
}

/** Gzip-compress a buffer using the web-standard CompressionStream API. */
export async function compressBuffer(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const parts: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }

  const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Split a buffer into fixed-size byte chunks. */
export function splitBuffer(data: Uint8Array, maxChunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += maxChunkSize) {
    chunks.push(data.slice(offset, Math.min(offset + maxChunkSize, data.byteLength)));
  }
  return chunks;
}

function buildReassemblyInstructions(
  originalName: string,
  gzName: string,
  wasSplit: boolean,
  partCount: number,
): string {
  if (!wasSplit) {
    return [
      `**Compressed attachment: \`${originalName}\`**`,
      `To decompress:`,
      `- **Linux/macOS:** \`gunzip ${gzName}\``,
      `- **Windows:** Use 7-Zip or WinRAR to extract \`${gzName}\``,
    ].join("\n");
  }

  return [
    `**Split attachment: \`${originalName}\` (${partCount} parts)**`,
    `To reassemble and decompress:`,
    `- **Linux/macOS:**`,
    `  \`\`\``,
    `  cat ${gzName}.* | gunzip > ${originalName}`,
    `  \`\`\``,
    `- **Windows (PowerShell):**`,
    `  \`\`\``,
    `  cmd /c "copy /b ${gzName}.* ${gzName}" && tar -xzf ${gzName}`,
    `  \`\`\``,
    `- Or use 7-Zip: extract part 001, which will locate the remaining parts.`,
  ].join("\n");
}

/**
 * Compress and (if needed) split an oversized attachment into ≤ maxPartSize chunks.
 * Each chunk is named `file.ext.gz` (single) or `file.ext.gz.001` (multi-part).
 */
export async function paginateFile(
  attachment: EmailAttachment,
  maxPartSize: number = DEFAULT_PART_SIZE,
): Promise<PaginatedFile> {
  const compressed = await compressBuffer(attachment.content);
  const parts = splitBuffer(compressed, maxPartSize);

  const baseName = `${attachment.filename}.gz`;
  const needsSplit = parts.length > 1;

  const chunks: FileChunk[] = parts.map((part, i) => ({
    filename: needsSplit
      ? `${baseName}.${String(i + 1).padStart(3, "0")}`
      : baseName,
    content: part,
    mimeType: "application/gzip",
  }));

  const reassemblyInstructions = buildReassemblyInstructions(
    attachment.filename,
    baseName,
    needsSplit,
    parts.length,
  );

  return {
    originalFilename: attachment.filename,
    originalSize: attachment.content.byteLength,
    compressedSize: compressed.byteLength,
    chunks,
    reassemblyInstructions,
  };
}
