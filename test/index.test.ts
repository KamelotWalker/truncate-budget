import { describe, expect, it } from "vitest";

import {
  DEFAULT_MARKER,
  countLines,
  truncate,
  utf8ByteLength,
  type TruncateInfo,
  type TruncateMode,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const NO_MARKER = { marker: "" } as const;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("utf8ByteLength", () => {
  it("counts ASCII, multibyte, and astral characters", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("a😀日é")).toBe(1 + 4 + 3 + 2);
  });

  it("matches TextEncoder for a mixed string", () => {
    const value = "line 1\nsnowman ☃\n日本語\nemoji 😀😀\r\n";
    expect(utf8ByteLength(value)).toBe(bytes(value).byteLength);
  });

  it("charges 3 bytes for a lone surrogate, like TextEncoder", () => {
    expect(utf8ByteLength("\ud800")).toBe(3);
  });
});

describe("countLines", () => {
  it("uses the record model where a trailing newline terminates the last line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("\n")).toBe(1);
    expect(countLines("\n\n")).toBe(2);
  });

  it("treats CRLF as one break and a lone CR as text", () => {
    expect(countLines("a\r\nb\r\n")).toBe(2);
    expect(countLines("a\rb")).toBe(1);
    expect(countLines("a\r\n")).toBe(1);
  });
});

describe("no truncation", () => {
  it("returns the input untouched when it fits", () => {
    const value = "hello\nworld";
    const result = truncate(value, { maxBytes: 100, maxLines: 10 });

    expect(result.text).toBe(value);
    expect(result.truncated).toBe(false);
    expect(result.markerOmitted).toBe(false);
    expect(result.originalBytes).toBe(11);
    expect(result.originalLines).toBe(2);
    expect(result.keptBytes).toBe(11);
    expect(result.keptLines).toBe(2);
    expect(result.omittedBytes).toBe(0);
    expect(result.omittedLines).toBe(0);
  });

  it("is inclusive at the exact byte boundary", () => {
    expect(truncate("日", { maxBytes: 3 }).text).toBe("日");
    expect(truncate("日", { maxBytes: 3 }).truncated).toBe(false);
    expect(truncate("a😀", { maxBytes: 5 }).text).toBe("a😀");
  });

  it("is inclusive at the exact line boundary", () => {
    const result = truncate("a\nb\n", { maxLines: 2 });
    expect(result.text).toBe("a\nb\n");
    expect(result.truncated).toBe(false);
  });

  it("treats empty input as fitting even at zero budgets", () => {
    for (const mode of ["head", "tail", "head-tail"] as const) {
      const result = truncate("", { maxBytes: 0, maxLines: 0, mode });
      expect(result.text).toBe("");
      expect(result.truncated).toBe(false);
      expect(result.originalBytes).toBe(0);
      expect(result.originalLines).toBe(0);
    }
  });
});

describe("head mode", () => {
  it("keeps a code-point-safe prefix and sizes the marker into the budget", () => {
    const result = truncate("abcdefghij".repeat(3), { maxBytes: 25 });

    expect(result.text).toBe("abcd" + DEFAULT_MARKER);
    expect(result.keptBytes).toBe(25);
    expect(result.keptLines).toBe(1);
    expect(result.omittedBytes).toBe(26);
    expect(result.omittedLines).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.markerOmitted).toBe(false);
  });

  it("returns an exact prefix when the marker is disabled", () => {
    const result = truncate("abcdefghij", { maxBytes: 4, ...NO_MARKER });
    expect(result.text).toBe("abcd");
    expect(result.keptBytes).toBe(4);
    expect(result.omittedBytes).toBe(6);
  });

  it("never splits a 4-byte emoji at the boundary", () => {
    const value = "a😀b";
    // 1 byte fits 'a'; the emoji needs 4 more.
    const two = truncate(value, { maxBytes: 2, ...NO_MARKER });
    expect(two.text).toBe("a");
    expect(hasLoneSurrogate(two.text)).toBe(false);

    const five = truncate(value, { maxBytes: 5, ...NO_MARKER });
    expect(five.text).toBe("a😀");
    expect(hasLoneSurrogate(five.text)).toBe(false);
    expect(decoder.decode(bytes(five.text))).toBe(five.text);
  });

  it("starts with whole emoji only when the pair fits", () => {
    const value = "😀😀";
    expect(truncate(value, { maxBytes: 3, ...NO_MARKER }).text).toBe("");
    expect(truncate(value, { maxBytes: 4, ...NO_MARKER }).text).toBe("😀");
    expect(truncate(value, { maxBytes: 7, ...NO_MARKER }).text).toBe("😀");
    expect(truncate(value, { maxBytes: 8, ...NO_MARKER }).text).toBe("😀😀");
  });

  it("does not split CJK code points", () => {
    const value = "日本語";
    expect(truncate(value, { maxBytes: 1, ...NO_MARKER }).text).toBe("");
    expect(truncate(value, { maxBytes: 3, ...NO_MARKER }).text).toBe("日");
    expect(truncate(value, { maxBytes: 5, ...NO_MARKER }).text).toBe("日");
    expect(truncate(value, { maxBytes: 6, ...NO_MARKER }).text).toBe("日本");
    expect(truncate(value, { maxBytes: 9, ...NO_MARKER }).text).toBe("日本語");
  });

  it("keeps combining marks whole but may separate them from the base", () => {
    const value = "ae\u0301"; // a, e, COMBINING ACUTE ACCENT (2 bytes)
    expect(truncate(value, { maxBytes: 2, ...NO_MARKER }).text).toBe("ae");
    expect(truncate(value, { maxBytes: 3, ...NO_MARKER }).text).toBe("ae");
    expect(truncate(value, { maxBytes: 4, ...NO_MARKER }).text).toBe("ae\u0301");
    expect(truncate("\u0301", { maxBytes: 1, ...NO_MARKER }).text).toBe("");
  });

  it("truncates by lines and keeps each retained line terminator", () => {
    const result = truncate("a\nb\nc\nd\n", { maxLines: 2, ...NO_MARKER });
    expect(result.text).toBe("a\nb\n");
    expect(result.keptLines).toBe(2);
    expect(result.originalLines).toBe(4);
    expect(result.omittedLines).toBe(2);
    expect(result.omittedBytes).toBe(4);
  });

  it("handles a single line longer than the byte budget", () => {
    const value = "x".repeat(10_000);
    const result = truncate(value, { maxBytes: 100 });
    expect(result.text).toBe("x".repeat(100 - utf8ByteLength(DEFAULT_MARKER)) + DEFAULT_MARKER);
    expect(result.keptBytes).toBe(100);
    expect(result.keptLines).toBe(1);
    expect(result.omittedLines).toBe(0);
    expect(result.omittedBytes).toBe(10_000 - (100 - utf8ByteLength(DEFAULT_MARKER)));
  });

  it("drops a trailing CR when the byte cut lands inside CRLF", () => {
    const result = truncate("ab\r\ncd\r\n", { maxBytes: 3, ...NO_MARKER });
    expect(result.text).toBe("ab");
    expect(result.text.endsWith("\r")).toBe(false);
  });

  it("does not invent a line when the text ends with a newline", () => {
    const result = truncate("a\n", { maxLines: 1, ...NO_MARKER });
    expect(result.text).toBe("a\n");
    expect(result.keptLines).toBe(1);
    expect(result.omittedLines).toBe(0);
    expect(result.omittedBytes).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("works with only a line budget", () => {
    const result = truncate("first\nsecond\nthird\n", { maxLines: 2, ...NO_MARKER });
    expect(result.text).toBe("first\nsecond\n");
    expect(result.omittedBytes).toBe(6);
  });

  it("works with only a byte budget", () => {
    const result = truncate("first\nsecond\nthird\n", { maxBytes: 7, ...NO_MARKER });
    expect(result.text).toBe("first\ns");
    expect(result.keptBytes).toBe(7);
    expect(result.keptLines).toBe(2);
  });
});

describe("tail mode", () => {
  it("keeps an exact suffix when the marker is disabled", () => {
    const result = truncate("abcdefghij", { maxBytes: 4, mode: "tail", ...NO_MARKER });
    expect(result.text).toBe("ghij");
    expect(result.omittedBytes).toBe(6);
  });

  it("never splits an emoji at the tail boundary", () => {
    expect(truncate("a😀b", { maxBytes: 2, mode: "tail", ...NO_MARKER }).text).toBe("b");
    expect(truncate("a😀b", { maxBytes: 5, mode: "tail", ...NO_MARKER }).text).toBe("😀b");
    expect(truncate("😀😀", { maxBytes: 3, mode: "tail", ...NO_MARKER }).text).toBe("");
    expect(truncate("😀😀", { maxBytes: 4, mode: "tail", ...NO_MARKER }).text).toBe("😀");
    expect(truncate("😀😀", { maxBytes: 7, mode: "tail", ...NO_MARKER }).text).toBe("😀");
  });

  it("keeps CJK code points whole", () => {
    expect(truncate("日本語", { maxBytes: 4, mode: "tail", ...NO_MARKER }).text).toBe("語");
    expect(truncate("日本語", { maxBytes: 6, mode: "tail", ...NO_MARKER }).text).toBe("本語");
  });

  it("keeps the last N lines", () => {
    const result = truncate("a\nb\nc\nd\n", { maxLines: 2, mode: "tail", ...NO_MARKER });
    expect(result.text).toBe("c\nd\n");
    expect(result.keptLines).toBe(2);
    expect(result.omittedLines).toBe(2);
  });

  it("does not start with a dangling LF from a split CRLF", () => {
    const result = truncate("x\r\nabc", { maxBytes: 4, mode: "tail", ...NO_MARKER });
    expect(result.text).toBe("abc");
    expect(result.text.startsWith("\n")).toBe(false);
  });

  it("places the marker before the retained tail", () => {
    const result = truncate("a\nb\nc\nd\n", { maxLines: 3, mode: "tail" });
    expect(result.text.startsWith(DEFAULT_MARKER)).toBe(true);
    expect(result.text.endsWith("c\nd\n")).toBe(true);
  });
});

describe("head-tail mode", () => {
  it("keeps both ends and inserts the marker in the middle", () => {
    const result = truncate("abcdefghijklmnopqrstuvwxyz".repeat(4), { maxBytes: 41, mode: "head-tail" });
    expect(result.text).toBe("abcdefghij" + DEFAULT_MARKER + "qrstuvwxyz");
    expect(result.keptBytes).toBe(41);
    expect(result.omittedBytes).toBe(84);
  });

  it("splits the content budget evenly, giving the odd byte to the tail", () => {
    const result = truncate("abcdefghijklmnopqrstuvwxyz", { maxBytes: 20, mode: "head-tail", ...NO_MARKER });
    expect(result.text).toBe("abcdefghij" + "qrstuvwxyz");
    expect(result.text.length).toBe(20);
  });

  it("splits the line budget and counts the marker's line", () => {
    const value = "L1\nL2\nL3\nL4\nL5\nL6\n";
    const result = truncate(value, { maxLines: 4, mode: "head-tail" });

    // marker takes 1 line, content gets 3: head 1, tail 2
    expect(result.text.startsWith("L1\n")).toBe(true);
    expect(result.text.endsWith("L5\nL6\n")).toBe(true);
    expect(result.text).toContain(DEFAULT_MARKER);
    expect(result.keptLines).toBeLessThanOrEqual(4);
    expect(result.omittedLines).toBe(3);
  });

  it("keeps a single line from both sides without double-counting the line", () => {
    const result = truncate("abcdefghij", { maxBytes: 9, mode: "head-tail", ...NO_MARKER });
    expect(result.text).toBe("abcd" + "fghij");
    expect(result.keptLines).toBe(1);
    expect(result.omittedLines).toBe(0);
    expect(result.omittedBytes).toBe(1);
  });

  it("never duplicates content when both halves meet", () => {
    const result = truncate("abcdefghij", { maxBytes: 10, mode: "head-tail", ...NO_MARKER });
    expect(result.text).toBe("abcdefghij");
    expect(result.truncated).toBe(false);
  });

  it("falls back to the full budget when the marker cannot fit", () => {
    const result = truncate("abcdefghijklmnopqrstuvwxyz", { maxBytes: 10, mode: "head-tail" });
    expect(result.markerOmitted).toBe(true);
    expect(result.text).toBe("abcde" + "vwxyz");
    expect(result.keptBytes).toBe(10);
  });
});

describe("budgets interacting", () => {
  const value = Array.from({ length: 10 }, (_, index) => `line-${index}-${"x".repeat(20)}`).join("\n");

  it("lets the byte budget win when it is stricter", () => {
    const result = truncate(value, { maxBytes: 40, maxLines: 9 });
    expect(result.keptBytes).toBeLessThanOrEqual(40);
    expect(result.keptLines).toBeLessThan(9);
  });

  it("lets the line budget win when it is stricter", () => {
    const result = truncate(value, { maxBytes: 10_000, maxLines: 3 });
    expect(result.keptLines).toBeLessThanOrEqual(3);
    expect(result.omittedLines).toBe(8);
    expect(result.keptBytes).toBeLessThan(10_000);
  });

  it("applies both limits at once", () => {
    const result = truncate(value, { maxBytes: 50, maxLines: 3 });
    expect(result.keptBytes).toBeLessThanOrEqual(50);
    expect(result.keptLines).toBeLessThanOrEqual(3);
  });

  it("keeps nothing at a zero byte budget", () => {
    const result = truncate("abc\ndef", { maxBytes: 0 });
    expect(result.text).toBe("");
    expect(result.keptBytes).toBe(0);
    expect(result.keptLines).toBe(0);
    expect(result.markerOmitted).toBe(true);
    expect(result.omittedBytes).toBe(7);
    expect(result.omittedLines).toBe(2);
  });

  it("keeps nothing at a zero line budget even with bytes available", () => {
    const result = truncate("abcdef", { maxLines: 0, ...NO_MARKER });
    expect(result.text).toBe("");
    expect(result.keptLines).toBe(0);
    expect(result.omittedLines).toBe(1);
  });

  it("floors fractional budgets", () => {
    const result = truncate("abcdefghij", { maxBytes: 5.9, ...NO_MARKER });
    expect(result.keptBytes).toBe(5);
    expect(result.text).toBe("abcde");
  });
});

describe("marker", () => {
  it("counts the marker's bytes against the byte budget", () => {
    const marker = "[...]";
    const result = truncate("x".repeat(100), { maxBytes: 20, marker });
    expect(result.keptBytes).toBe(20);
    expect(result.text).toBe("x".repeat(15) + marker);
    expect(result.omittedBytes).toBe(85);
  });

  it("counts the marker's lines against the line budget", () => {
    const marker = "\n---\n";
    const result = truncate("a\nb\nc\nd\ne\n", { maxLines: 3, marker });
    expect(result.keptLines).toBeLessThanOrEqual(3);
    expect(result.text).toContain(marker);
  });

  it("is dropped when it alone exceeds the byte budget", () => {
    const result = truncate("abcdefghij", { maxBytes: 4 });
    expect(result.text).toBe("abcd");
    expect(result.markerOmitted).toBe(true);
  });

  it("is dropped when it alone exceeds the line budget", () => {
    const result = truncate("abcdef", { maxLines: 0, marker: "\n" });
    expect(result.text).toBe("");
    expect(result.markerOmitted).toBe(true);
  });

  it("is dropped when a custom marker is too large", () => {
    const result = truncate("abcdefghijklmnop", { maxBytes: 10, marker: "X".repeat(50) });
    expect(result.text).toBe("abcdefghij");
    expect(result.keptBytes).toBe(10);
    expect(result.markerOmitted).toBe(true);
  });

  it("fits exactly when its size equals the whole budget", () => {
    const result = truncate("abcdefghij".repeat(10), { maxBytes: utf8ByteLength(DEFAULT_MARKER) });
    expect(result.text).toBe(DEFAULT_MARKER);
    expect(result.keptBytes).toBe(utf8ByteLength(DEFAULT_MARKER));
    expect(result.keptLines).toBe(1);
  });

  it("passes final omission counts to a marker function", () => {
    const calls: TruncateInfo[] = [];
    const result = truncate("x".repeat(200), {
      maxBytes: 40,
      marker: (info) => {
        calls.push(info);
        return `[${info.omittedBytes}/${info.omittedLines}]`;
      },
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(result.text).toContain(`[${result.omittedBytes}/${result.omittedLines}]`);
    expect(result.keptBytes).toBeLessThanOrEqual(40);
    const last = calls.at(-1);
    expect(last?.omittedBytes).toBe(result.omittedBytes);
    expect(last?.omittedLines).toBe(result.omittedLines);
    expect(last?.mode).toBe("head");
  });

  it("throws when a marker function cannot settle on a fixed point", () => {
    let calls = 0;
    expect(() =>
      truncate("abc", {
        maxBytes: 2,
        marker: (info) => {
          calls++;
          return info.omittedBytes === 1 ? "#" : "";
        },
      }),
    ).toThrow(/did not converge/);
    expect(calls).toBe(2);
  });

  it("tells an always-oversized marker function the dropped-marker counts", () => {
    let calls = 0;
    let last: TruncateInfo | undefined;
    const result = truncate("abc", {
      maxBytes: 2,
      marker: (info) => {
        calls++;
        last = info;
        return "X".repeat(info.omittedBytes + 5);
      },
    });

    expect(result.text).toBe("ab");
    expect(result.markerOmitted).toBe(true);
    expect(result.omittedBytes).toBe(1);
    expect(result.omittedLines).toBe(0);
    expect(calls).toBe(1);
    expect(last?.omittedBytes).toBe(result.omittedBytes);
    expect(last?.omittedLines).toBe(result.omittedLines);
  });

  it("rejects a marker function that does not return a string", () => {
    expect(() =>
      truncate("abcdef", {
        maxBytes: 3,
        // @ts-expect-error deliberately wrong return type
        marker: () => 42,
      }),
    ).toThrow(TypeError);
  });

  it("supports an empty marker to get pure content", () => {
    const result = truncate("abcdefghij", { maxBytes: 6, marker: "" });
    expect(result.text).toBe("abcdef");
    expect(result.markerOmitted).toBe(false);
  });
});

describe("validation", () => {
  it("rejects NaN budgets with RangeError", () => {
    expect(() => truncate("x", { maxBytes: Number.NaN })).toThrow(RangeError);
    expect(() => truncate("x", { maxLines: Number.NaN })).toThrow(RangeError);
  });

  it("rejects negative budgets with RangeError", () => {
    expect(() => truncate("x", { maxBytes: -1 })).toThrow(RangeError);
    expect(() => truncate("x", { maxLines: -0.5 })).toThrow(RangeError);
    expect(() => truncate("x", { maxBytes: Number.NEGATIVE_INFINITY })).toThrow(RangeError);
  });

  it("rejects non-numeric budgets with TypeError", () => {
    // @ts-expect-error runtime validation
    expect(() => truncate("x", { maxBytes: "10" })).toThrow(TypeError);
    // @ts-expect-error runtime validation
    expect(() => truncate("x", { maxLines: null })).toThrow(TypeError);
  });

  it("requires at least one budget", () => {
    expect(() => truncate("x", {})).toThrow(TypeError);
    expect(() => truncate("x", { maxBytes: Infinity, maxLines: Infinity })).toThrow(TypeError);
  });

  it("accepts Infinity for one side", () => {
    expect(truncate("a\nb", { maxBytes: Infinity, maxLines: 1, ...NO_MARKER }).text).toBe("a\n");
  });

  it("rejects an unknown mode", () => {
    // @ts-expect-error runtime validation
    expect(() => truncate("x", { maxBytes: 1, mode: "middle" })).toThrow(TypeError);
  });

  it("rejects an invalid marker", () => {
    // @ts-expect-error runtime validation
    expect(() => truncate("x", { maxBytes: 1, marker: 5 })).toThrow(TypeError);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error runtime validation
    expect(() => truncate(42, { maxBytes: 1 })).toThrow(TypeError);
  });
});

describe("metadata", () => {
  it("reports values that can be recomputed from the output", () => {
    const result = truncate("one\ntwo\nthree\nfour\n", { maxBytes: 24, maxLines: 3 });
    expect(result.keptBytes).toBe(utf8ByteLength(result.text));
    expect(result.keptLines).toBe(countLines(result.text));
    expect(result.originalBytes).toBe(utf8ByteLength("one\ntwo\nthree\nfour\n"));
    expect(result.originalLines).toBe(4);
    expect(result.keptBytes).toBeLessThanOrEqual(24);
    expect(result.keptLines).toBeLessThanOrEqual(3);
    expect(result.omittedBytes).toBeGreaterThan(0);
    expect(result.omittedLines).toBeGreaterThan(0);
  });

  it("reports the marker as kept bytes but not as omitted original bytes", () => {
    const marker = "[cut]";
    const result = truncate("x".repeat(50), { maxBytes: 20, marker });
    const contentBytes = 20 - marker.length;
    expect(result.keptBytes).toBe(20);
    expect(result.omittedBytes).toBe(50 - contentBytes);
    expect(result.keptBytes - bytes(marker).byteLength).toBe(contentBytes);
  });
});

describe("edge shapes", () => {
  it("handles newline-only text", () => {
    const result = truncate("\n\n\n\n", { maxLines: 3, ...NO_MARKER });
    expect(result.text).toBe("\n\n\n");
    expect(result.keptLines).toBe(3);
    expect(result.omittedLines).toBe(1);
  });

  it("splits newline-only text in head-tail mode", () => {
    const result = truncate("\n\n\n\n", { maxLines: 3, mode: "head-tail", ...NO_MARKER });
    expect(result.text).toBe("\n" + "\n\n");
    expect(result.keptLines).toBe(3);
  });

  it("charges a two-line marker in head-tail mode", () => {
    const marker = "\n--cut--\n";
    const result = truncate("a\nb\nc\nd\ne\nf\n", { maxLines: 4, mode: "head-tail", marker });
    expect(result.text).toBe("a\n" + marker + "f\n");
    expect(result.keptLines).toBe(4);
    expect(result.keptLines).toBeLessThanOrEqual(4);
  });

  it("leaves only the marker when the line budget is one", () => {
    const result = truncate("a\nb\n", { maxLines: 1 });
    expect(result.text).toBe(DEFAULT_MARKER);
    expect(result.keptLines).toBe(1);
    expect(result.omittedLines).toBe(2);
  });

  it("handles a surrogate pair at the very start with a tail cut", () => {
    const result = truncate("😀abc", { maxBytes: 4, mode: "tail", ...NO_MARKER });
    expect(result.text).toBe("abc");
    expect(hasLoneSurrogate(result.text)).toBe(false);
  });

  it("handles a surrogate pair at the very end with a head cut", () => {
    const result = truncate("abc😀", { maxBytes: 4, ...NO_MARKER });
    expect(result.text).toBe("abc");
    expect(hasLoneSurrogate(result.text)).toBe(false);
  });
});

describe("randomized invariants", () => {
  const alphabet = ["a", "Z", "0", "\n", "\r", " ", "é", "日", "😀", "\u0301", "→"];
  const random = mulberry32(0x5eed);

  function randomString(maxLength: number): string {
    const length = Math.floor(random() * maxLength);
    let value = "";
    for (let index = 0; index < length; index++) {
      value += alphabet[Math.floor(random() * alphabet.length)];
    }
    return value;
  }

  it("holds budget, boundary, and metadata guarantees across modes and budgets", () => {
    const byteBudgets = [0, 1, 2, 3, 7, 21, 64, 200];
    const lineBudgets = [0, 1, 2, 4, 20];
    const modes: TruncateMode[] = ["head", "tail", "head-tail"];

    for (let round = 0; round < 60; round++) {
      const value = randomString(120);
      const maxBytes = byteBudgets[Math.floor(random() * byteBudgets.length)]!;
      const maxLines = lineBudgets[Math.floor(random() * lineBudgets.length)]!;
      const mode = modes[Math.floor(random() * modes.length)]!;
      const result = truncate(value, { maxBytes, maxLines, mode });

      expect(result.keptBytes, JSON.stringify({ value, maxBytes, maxLines, mode })).toBeLessThanOrEqual(maxBytes);
      expect(result.keptLines, JSON.stringify({ value, maxBytes, maxLines, mode })).toBeLessThanOrEqual(maxLines);
      expect(result.keptBytes).toBe(utf8ByteLength(result.text));
      expect(result.keptLines).toBe(countLines(result.text));
      expect(result.originalBytes).toBe(utf8ByteLength(value));
      expect(result.originalLines).toBe(countLines(value));
      expect(result.omittedBytes).toBeGreaterThanOrEqual(0);
      expect(result.omittedLines).toBeGreaterThanOrEqual(0);
      expect(result.keptBytes).toBeLessThanOrEqual(result.originalBytes);
      expect(hasLoneSurrogate(result.text)).toBe(false);
      expect(decoder.decode(bytes(result.text))).toBe(result.text);
      if (!result.truncated) expect(result.text).toBe(value);
    }
  });

  it("keeps head output a prefix and tail output a suffix when no marker is added", () => {
    for (let round = 0; round < 40; round++) {
      const value = randomString(80);
      const maxBytes = 1 + Math.floor(random() * 60);

      const head = truncate(value, { maxBytes, mode: "head", ...NO_MARKER });
      expect(value.startsWith(head.text)).toBe(true);

      const tail = truncate(value, { maxBytes, mode: "tail", ...NO_MARKER });
      expect(value.endsWith(tail.text)).toBe(true);
    }
  });
});

/**
 * Fastest observed duration of `runs` calls, in milliseconds. The minimum is
 * the usual microbenchmark statistic: scheduler preemption and GC pauses only
 * add time, so the fastest run is the closest estimate of the code's own cost
 * on a shared, noisy CI runner.
 */
function fastest(run: () => void, runs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < runs; round++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

const PERF_ROUNDS = 4;

/**
 * Wall-clock thresholds flake on slow or loaded CI runners, so growth is
 * measured instead of absolute time: doubling the input costs ~2x for linear
 * work and ~4x for quadratic work. A 3x ceiling absorbs JIT warm-up, GC, and
 * timer noise while still failing any implementation whose cost grows
 * superlinearly; the 1 ms floor keeps a sub-millisecond sample from turning
 * timer noise into a meaningless ratio.
 */
function expectLinearScaling(label: string, small: () => void, large: () => void): void {
  small(); // Warm up so JIT tiering cannot masquerade as superlinear growth.
  large();
  const smallMs = Math.max(fastest(small, PERF_ROUNDS), 1);
  const largeMs = fastest(large, PERF_ROUNDS);
  const ratio = largeMs / smallMs;
  expect(
    ratio,
    `${label}: 1x ${smallMs.toFixed(1)} ms, 2x ${largeMs.toFixed(1)} ms (${ratio.toFixed(2)}x)`,
  ).toBeLessThan(3);
}

describe("performance", () => {
  const line = "2026-10-28T12:00:00Z INFO request id=abc ünïcode 日本語 😀\n";

  it("stays linear on a 5 MB input in every mode", { timeout: 120_000 }, () => {
    const small = line.repeat(Math.ceil(5_000_000 / line.length));
    const large = line.repeat(Math.ceil(10_000_000 / line.length));
    expect(utf8ByteLength(small)).toBeGreaterThan(4_800_000);

    for (const mode of ["head", "tail", "head-tail"] as const) {
      const options = { maxBytes: 64 * 1024, maxLines: 500, mode };
      expectLinearScaling(
        mode,
        () => {
          truncate(small, options);
        },
        () => {
          truncate(large, options);
        },
      );

      for (const value of [small, large]) {
        const result = truncate(value, options);
        expect(result.keptBytes).toBeLessThanOrEqual(64 * 1024);
        expect(result.keptLines).toBeLessThanOrEqual(500);
      }
    }
  });

  it("stays linear when the byte budget is close to the input size", { timeout: 120_000 }, () => {
    const small = "abc日😀\n".repeat(500_000);
    const large = "abc日😀\n".repeat(1_000_000);
    const smallTotal = utf8ByteLength(small);
    const largeTotal = utf8ByteLength(large);

    expectLinearScaling(
      "large budget",
      () => {
        truncate(small, { maxBytes: smallTotal - 10, mode: "tail" });
      },
      () => {
        truncate(large, { maxBytes: largeTotal - 10, mode: "tail" });
      },
    );

    const result = truncate(small, { maxBytes: smallTotal - 10, mode: "tail" });
    expect(result.keptBytes).toBeLessThanOrEqual(smallTotal - 10);
    expect(result.originalBytes).toBe(smallTotal);
  });
});
