/**
 * `truncate-budget` — cut text down to a UTF-8 byte budget and/or a line budget
 * without ever splitting a UTF-8 code point or a surrogate pair.
 */

const encoder = new TextEncoder();

/** Guards against a marker callback that never settles. */
const MAX_MARKER_CALLS = 32;

/**
 * Marker inserted by default when text is truncated. Its UTF-8 bytes and its
 * lines are charged against the budgets like any other output text.
 */
export const DEFAULT_MARKER = " … [truncated] … ";

export type TruncateMode = "head" | "tail" | "head-tail";

/** Information handed to a `marker` callback. */
export interface TruncateInfo {
  readonly mode: TruncateMode;
  readonly originalBytes: number;
  readonly originalLines: number;
  /** Bytes of the original text that are absent from the output (marker excluded). */
  readonly omittedBytes: number;
  /** Whole original lines that are absent from the output (partially kept lines count as kept). */
  readonly omittedLines: number;
  readonly maxBytes: number;
  readonly maxLines: number;
}

export interface TruncateOptions {
  /**
   * Maximum UTF-8 bytes in `result.text`, marker included. Omit (or pass
   * `Infinity`) for no byte limit. Floored to an integer. Defaults to no limit.
   */
  readonly maxBytes?: number;
  /**
   * Maximum lines in `result.text`, marker included. Omit (or pass `Infinity`)
   * for no line limit. Floored to an integer. Defaults to no limit.
   */
  readonly maxLines?: number;
  /** Which end(s) to keep. Defaults to `"head"`. */
  readonly mode?: TruncateMode;
  /**
   * Text inserted where content was removed, or a function returning it. The
   * marker is charged against both budgets; if it cannot fit it is dropped.
   * Defaults to `DEFAULT_MARKER`.
   */
  readonly marker?: string | ((info: TruncateInfo) => string);
}

export interface TruncateResult {
  /** The truncated text. Identical to the input when `truncated` is false. */
  readonly text: string;
  readonly truncated: boolean;
  /** True when a non-empty marker was requested but did not fit the budgets. */
  readonly markerOmitted: boolean;
  /** UTF-8 bytes in the input. */
  readonly originalBytes: number;
  /** Lines in the input (see `countLines`). */
  readonly originalLines: number;
  /** UTF-8 bytes in `text`, marker included. Always <= `maxBytes`. */
  readonly keptBytes: number;
  /** Lines in `text`, marker included. Always <= `maxLines`. */
  readonly keptLines: number;
  /** Bytes of the original text absent from the output (marker excluded). */
  readonly omittedBytes: number;
  /** Whole original lines absent from the output (partially kept lines count as kept). */
  readonly omittedLines: number;
}

/** Number of bytes `text` occupies when encoded as UTF-8. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Number of lines in `text`.
 *
 * A line is a sequence terminated by `\n`; a trailing `\n` terminates the last
 * line instead of starting a new empty one. `""` has 0 lines, `"a"`, `"a\n"`,
 * and `"\n"` each have 1 line, and `"a\nb"` has 2. `\r\n` counts as one break
 * because only `\n` is counted; a lone `\r` is ordinary text.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  let index = -1;
  while ((index = text.indexOf("\n", index + 1)) !== -1) count++;
  return text.endsWith("\n") ? count : count + 1;
}

/**
 * Truncate `text` so that the result fits both budgets.
 *
 * The byte and line limits are independent: whichever binds first determines
 * how much is kept. `mode` decides which end(s) survive. The marker is part of
 * the output and therefore counts against both budgets; when the marker alone
 * cannot fit, it is dropped (`markerOmitted: true`) and the whole budget goes
 * to content.
 *
 * @throws {TypeError} for non-string input, unknown `mode`, wrong option types,
 * a marker callback that does not return a string, or no budget at all.
 * @throws {RangeError} for negative or `NaN` budgets.
 * @throws {Error} if a marker callback never returns a stable marker for stable
 * counts, so its final counts would not match the returned metadata.
 */
export function truncate(text: string, options: TruncateOptions = {}): TruncateResult {
  if (typeof text !== "string") {
    throw new TypeError("truncate: text must be a string");
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("truncate: options must be an object");
  }

  const maxBytes = normalizeBudget(options.maxBytes, "maxBytes");
  const maxLines = normalizeBudget(options.maxLines, "maxLines");
  if (maxBytes === Infinity && maxLines === Infinity) {
    throw new TypeError("truncate: at least one of maxBytes or maxLines is required");
  }

  const mode = options.mode === undefined ? "head" : options.mode;
  if (mode !== "head" && mode !== "tail" && mode !== "head-tail") {
    throw new TypeError('truncate: mode must be "head", "tail", or "head-tail"');
  }

  const markerOption = options.marker === undefined ? DEFAULT_MARKER : options.marker;
  if (typeof markerOption !== "string" && typeof markerOption !== "function") {
    throw new TypeError("truncate: marker must be a string or a function");
  }

  const originalBytes = utf8ByteLength(text);
  const originalLines = countLines(text);

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return {
      text,
      truncated: false,
      markerOmitted: false,
      originalBytes,
      originalLines,
      keptBytes: originalBytes,
      keptLines: originalLines,
      omittedBytes: 0,
      omittedLines: 0,
    };
  }

  let marker = "";
  let markerBytes = 0;
  let markerLines = 0;
  let markerOmitted = false;

  if (typeof markerOption === "string") {
    const fitted = fitMarker(markerOption, maxBytes, maxLines);
    marker = fitted.text;
    markerBytes = fitted.bytes;
    markerLines = fitted.lines;
    markerOmitted = fitted.omitted;
  } else {
    // The marker changes the content budget, and the content budget changes the
    // counts the marker is built from. Iterate on the *effective* marker (empty
    // when the proposal cannot fit) so an oversized callback is told about the
    // layout it will actually produce. A callback that never stabilizes has no
    // self-consistent counts; refuse to report counts it never saw.
    // An effective marker that repeats was already handed this exact layout;
    // a pure callback must return the same proposal, so the sequence is a cycle.
    const seenMarkers = new Set<string>();
    let proposal = "";

    for (let call = 0; ; call++) {
      const effective = fitMarker(proposal, maxBytes, maxLines);
      if (call >= MAX_MARKER_CALLS || seenMarkers.has(effective.text)) {
        throw new Error(
          "truncate: marker function did not converge; it must return the same marker for the same counts",
        );
      }
      seenMarkers.add(effective.text);

      const layout = computeLayout(
        text,
        originalBytes,
        originalLines,
        mode,
        subtract(maxBytes, effective.bytes),
        subtract(maxLines, effective.lines),
      );
      const next = markerOption({
        mode,
        originalBytes,
        originalLines,
        omittedBytes: layout.omittedBytes,
        omittedLines: layout.omittedLines,
        maxBytes,
        maxLines,
      });
      if (typeof next !== "string") {
        throw new TypeError("truncate: marker function must return a string");
      }

      const nextEffective = fitMarker(next, maxBytes, maxLines);
      if (nextEffective.text === effective.text) {
        marker = nextEffective.text;
        markerBytes = nextEffective.bytes;
        markerLines = nextEffective.lines;
        markerOmitted = nextEffective.omitted;
        break;
      }
      proposal = next;
    }
  }

  const layout = computeLayout(
    text,
    originalBytes,
    originalLines,
    mode,
    subtract(maxBytes, markerBytes),
    subtract(maxLines, markerLines),
  );

  const output = layout.headText + marker + layout.tailText;
  const keptBytes = utf8ByteLength(output);
  const keptLines = countLines(output);

  return {
    text: output,
    truncated: layout.omittedBytes > 0 || layout.omittedLines > 0,
    markerOmitted,
    originalBytes,
    originalLines,
    keptBytes,
    keptLines,
    omittedBytes: layout.omittedBytes,
    omittedLines: layout.omittedLines,
  };
}

interface Layout {
  readonly headText: string;
  readonly tailText: string;
  readonly omittedBytes: number;
  readonly omittedLines: number;
}

interface FittedMarker {
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly omitted: boolean;
}

/**
 * Normalize a proposed marker: one that does not fit is replaced by the empty
 * string *before* content budgets are computed, so a marker callback always
 * sees the layout its proposal would actually produce.
 */
function fitMarker(marker: string, maxBytes: number, maxLines: number): FittedMarker {
  const bytes = utf8ByteLength(marker);
  const lines = countLines(marker);
  if (bytes > maxBytes || lines > maxLines) {
    return { text: "", bytes: 0, lines: 0, omitted: true };
  }
  return { text: marker, bytes, lines, omitted: false };
}

/**
 * Compute the two retained ranges for the given *content* budgets (i.e. budgets
 * already reduced by the marker's own size).
 */
function computeLayout(
  text: string,
  originalBytes: number,
  originalLines: number,
  mode: TruncateMode,
  contentBytes: number,
  contentLines: number,
): Layout {
  const length = text.length;
  let headEnd = mode === "tail" ? 0 : length;
  let tailStart = mode === "head" ? length : 0;

  if (mode === "head") {
    if (contentLines !== Infinity) headEnd = Math.min(headEnd, headLineEnd(text, contentLines));
    if (contentBytes !== Infinity) headEnd = prefixEnd(text, contentBytes, headEnd);
  } else if (mode === "tail") {
    if (contentLines !== Infinity) tailStart = Math.max(tailStart, tailLineStart(text, originalLines, contentLines));
    if (contentBytes !== Infinity) tailStart = suffixStart(text, contentBytes, tailStart);
  } else {
    // Split the remaining budget: the head takes the floor, the tail the rest,
    // so an odd budget byte or line goes to the tail (usually the interesting end).
    const headBytes = contentBytes === Infinity ? Infinity : Math.floor(contentBytes / 2);
    const headLines = contentLines === Infinity ? Infinity : Math.floor(contentLines / 2);
    const tailBytes = contentBytes === Infinity ? Infinity : contentBytes - headBytes;
    const tailLines = contentLines === Infinity ? Infinity : contentLines - headLines;

    if (headLines !== Infinity) headEnd = Math.min(headEnd, headLineEnd(text, headLines));
    if (headBytes !== Infinity) headEnd = prefixEnd(text, headBytes, headEnd);
    if (tailLines !== Infinity) tailStart = Math.max(tailStart, tailLineStart(text, originalLines, tailLines));
    if (tailBytes !== Infinity) tailStart = suffixStart(text, tailBytes, tailStart);
  }

  // Never cut between CR and LF: a head ending in "\r" or a tail starting with
  // "\n" would otherwise expose half of a CRLF sequence.
  if (headEnd > 0 && headEnd < length && text.charCodeAt(headEnd) === 10 && text.charCodeAt(headEnd - 1) === 13) {
    headEnd--;
  }
  if (tailStart > 0 && tailStart < length && text.charCodeAt(tailStart) === 10 && text.charCodeAt(tailStart - 1) === 13) {
    tailStart++;
  }

  // The two ranges are disjoint by construction; keep that true defensively.
  if (tailStart < headEnd) headEnd = tailStart;

  const headText = headEnd > 0 ? text.slice(0, headEnd) : "";
  const tailText = tailStart < length ? text.slice(tailStart) : "";

  const keptBytes = utf8ByteLength(headText) + utf8ByteLength(tailText);

  const headKeptLines = headEnd === 0 ? 0 : countNewlinesBefore(text, headEnd - 1) + 1;
  const tailFirstLine = tailStart >= length ? originalLines : countNewlinesBefore(text, tailStart);
  const tailKeptLines = originalLines - tailFirstLine;
  const sharedLine = headKeptLines > 0 && tailKeptLines > 0 && tailFirstLine < headKeptLines ? 1 : 0;

  return {
    headText,
    tailText,
    omittedBytes: originalBytes - keptBytes,
    omittedLines: originalLines - (headKeptLines + tailKeptLines - sharedLine),
  };
}

/** `max - used`, never negative; `Infinity` stays unlimited. */
function subtract(max: number, used: number): number {
  if (max === Infinity) return Infinity;
  const remaining = max - used;
  return remaining > 0 ? remaining : 0;
}

function normalizeBudget(value: unknown, name: "maxBytes" | "maxLines"): number {
  if (value === undefined) return Infinity;
  if (typeof value !== "number") {
    throw new TypeError(`truncate: ${name} must be a number`);
  }
  if (Number.isNaN(value) || value < 0) {
    throw new RangeError(`truncate: ${name} must be a non-negative number`);
  }
  if (value === Infinity) return Infinity;
  if (!Number.isFinite(value)) {
    throw new RangeError(`truncate: ${name} must be a finite number or Infinity`);
  }
  return Math.floor(value);
}

/**
 * End index (exclusive) of the prefix that fits in `maxBytes` UTF-8 bytes,
 * never going past `limit`. `TextEncoder.encodeInto` never splits a surrogate
 * pair and reports how many UTF-16 code units it managed to encode.
 */
function prefixEnd(text: string, maxBytes: number, limit: number): number {
  if (maxBytes <= 0 || limit <= 0) return 0;
  if (limit * 3 <= maxBytes) return limit;
  // One extra code unit covers a surrogate pair whose high half sits exactly at
  // the byte limit; no code point is wider than 4 bytes / 2 code units.
  const candidate = text.slice(0, Math.min(limit, maxBytes + 1));
  const sink = new Uint8Array(Math.min(maxBytes, candidate.length * 3));
  return encoder.encodeInto(candidate, sink).read;
}

/**
 * Start index of the longest suffix that fits in `maxBytes` UTF-8 bytes,
 * stopping at `stop`. Walks backwards one code point at a time, so the result
 * is always on a code point boundary and never becomes quadratic.
 */
function suffixStart(text: string, maxBytes: number, stop: number): number {
  if (maxBytes <= 0) return text.length;

  let index = text.length;
  let used = 0;

  while (index > stop) {
    const unit = text.charCodeAt(index - 1);
    let needed: number;
    let width: number;

    if (unit >= 0xdc00 && unit <= 0xdfff) {
      const high = index >= 2 ? text.charCodeAt(index - 2) : -1;
      if (high >= 0xd800 && high <= 0xdbff) {
        needed = 4;
        width = 2;
      } else {
        needed = 3; // lone low surrogate encodes as U+FFFD
        width = 1;
      }
    } else if (unit < 0x80) {
      needed = 1;
      width = 1;
    } else if (unit < 0x800) {
      needed = 2;
      width = 1;
    } else {
      needed = 3; // BMP character or lone high surrogate (U+FFFD)
      width = 1;
    }

    if (used + needed > maxBytes) break;
    used += needed;
    index -= width;
  }

  return index;
}

/** Index just past the `maxLines`-th line of the prefix. */
function headLineEnd(text: string, maxLines: number): number {
  if (maxLines <= 0) return 0;
  let index = -1;
  for (let line = 0; line < maxLines; line++) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) return text.length;
  }
  return index + 1;
}

/** Index where the last `maxLines` lines begin. */
function tailLineStart(text: string, totalLines: number, maxLines: number): number {
  if (maxLines >= totalLines) return 0;
  const skip = totalLines - maxLines;
  let index = -1;
  for (let line = 0; line < skip; line++) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) return text.length;
  }
  return index + 1;
}

/** Number of `\n` characters strictly before `position`. */
function countNewlinesBefore(text: string, position: number): number {
  let count = 0;
  let index = -1;
  while ((index = text.indexOf("\n", index + 1)) !== -1 && index < position) count++;
  return count;
}
