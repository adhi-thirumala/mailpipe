import { describe, it, expect } from "bun:test";
import PostalMime from "postal-mime";
import { formatAddresses } from "../src/index.js";

const EML_WITH_CC = `From: Alice <alice@example.com>
To: Bob <bob@example.com>, carol@example.com
Cc: Dave <dave@example.com>, Eve <eve@example.com>
Subject: Meeting notes
Date: Mon, 01 Jan 2025 10:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"

Here are the meeting notes.
`;

const EML_NO_CC = `From: alice@example.com
To: bob@example.com
Subject: Quick note
Date: Mon, 01 Jan 2025 10:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"

Just a quick note.
`;

describe("formatAddresses", () => {
  it("returns null for undefined", () => {
    expect(formatAddresses(undefined)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(formatAddresses([])).toBeNull();
  });

  it("formats a single address without name", () => {
    expect(formatAddresses([{ name: "", address: "bob@example.com" }])).toBe("bob@example.com");
  });

  it("formats a single address with name", () => {
    expect(formatAddresses([{ name: "Bob", address: "bob@example.com" }])).toBe(
      "Bob <bob@example.com>",
    );
  });

  it("formats multiple addresses", () => {
    const result = formatAddresses([
      { name: "Bob", address: "bob@example.com" },
      { name: "", address: "carol@example.com" },
    ]);
    expect(result).toBe("Bob <bob@example.com>, carol@example.com");
  });
});

describe("email recipient parsing", () => {
  it("parses all To recipients", async () => {
    const parsed = await PostalMime.parse(EML_WITH_CC);
    const to = formatAddresses(parsed.to);
    expect(to).toBe("Bob <bob@example.com>, carol@example.com");
  });

  it("parses CC recipients", async () => {
    const parsed = await PostalMime.parse(EML_WITH_CC);
    const cc = formatAddresses(parsed.cc);
    expect(cc).toBe("Dave <dave@example.com>, Eve <eve@example.com>");
  });

  it("returns null cc when no CC header", async () => {
    const parsed = await PostalMime.parse(EML_NO_CC);
    const cc = formatAddresses(parsed.cc);
    expect(cc).toBeNull();
  });

  it("falls back to single to address when no To header recipients", async () => {
    const parsed = await PostalMime.parse(EML_NO_CC);
    const to = formatAddresses(parsed.to) ?? "bob@example.com";
    expect(to).toBe("bob@example.com");
  });
});
