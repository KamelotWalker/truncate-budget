# truncate-budget

Truncate large text to a **UTF-8 byte budget** and a **line budget** at once, without ever splitting a UTF-8 code point or a surrogate pair.

Built for CLI tools and AI agents that paste command or tool output into a context window, a terminal, or a log line.

## Install

```sh
npm install truncate-budget
```

ESM and CommonJS builds with TypeScript declarations are included. No runtime dependencies. Works on Node.js >= 20, Bun, and Deno.

## Usage

```ts
import { truncate } from "truncate-budget";

const output = runCommand();

const result = truncate(output, {
  maxBytes: 50 * 1024,
  maxLines: 2000,
  mode: "head-tail",
});

process.stdout.write(result.text);

if (result.truncated) {
  console.error(
    `omitted ${result.omittedBytes} bytes across ${result.omittedLines} lines`,
  );
}
```

```ts
truncate("abcdefghij", { maxBytes: 8 });
// {
//   text: "abcdefgh",  ← never a broken character
//   truncated: true,
//   markerOmitted: true,   // the default marker is 21 bytes, budget was 8
//   originalBytes: 10, originalLines: 1,
//   keptBytes: 8, keptLines: 1,
//   omittedBytes: 2, omittedLines: 0
// }
```

## API

### `truncate(text, options?)`

```ts
type TruncateMode = "head" | "tail" | "head-tail";

interface TruncateOptions {
  maxBytes?: number;   // default: no byte limit
  maxLines?: number;   // default: no line limit
  mode?: TruncateMode; // default: "head"
  marker?: string | ((info: TruncateInfo) => string);
}

interface TruncateInfo {
  mode: TruncateMode;
  originalBytes: number;
  originalLines: number;
  omittedBytes: number;
  omittedLines: number;
  maxBytes: number;
  maxLines: number;
}

interface TruncateResult {
  text: string;
  truncated: boolean;
  markerOmitted: boolean;
  originalBytes: number;
  originalLines: number;
  keptBytes: number;
  keptLines: number;
  omittedBytes: number;
  omittedLines: number;
}
```

At least one of `maxBytes` or `maxLines` is required. Omitted limits are unlimited (`Infinity`); passing both as `Infinity` throws a `TypeError`. Non-negative finite numbers are floored to integers. `NaN` and negative values throw a `RangeError`; wrong types throw a `TypeError`. A marker function that never stabilizes throws an `Error`.

### `utf8ByteLength(text)`

UTF-8 byte length of a string, using `TextEncoder`. `"é"` → 2, `"日"` → 3, `"😀"` → 4.

### `countLines(text)`

Number of lines using the same rule as the budgets: text is split on `\n`; a trailing `\n` terminates the last line rather than starting an empty one. `""` → 0, `"a"` → 1, `"a\n"` → 1, `"a\nb"` → 2, `"\n"` → 1. CRLF is one break because only `\n` is counted; a lone `\r` is ordinary text.

## Budget rules

### Both budgets apply

The two limits are independent and whichever binds first decides how much is kept. A byte cut may leave a partial line; a line cut may leave bytes unused. `keptBytes`/`keptLines` never exceed their limits.

### Modes

| Mode | Output |
| --- | --- |
| `"head"` | prefix of the text |
| `"tail"` | suffix of the text |
| `"head-tail"` | prefix + marker + suffix |

In `head-tail` mode the budget left after the marker is split between both ends: the head gets `floor(remaining / 2)` bytes and lines, the tail gets the rest. The odd byte or line goes to the tail.

### Marker

The marker is inserted only when content is actually removed. It is **part of the output**, so its UTF-8 bytes and its lines are subtracted from the budgets before any content is kept. The default is `" … [truncated] … "` (21 bytes, 1 line).

If the marker alone does not fit a budget (`markerBytes > maxBytes` or `markerLines > maxLines`), it is **dropped**: `markerOmitted` is `true` and the entire budget goes to content. A marker is never shortened or truncated. Pass `marker: ""` to disable it.

Any non-empty marker occupies at least one line, so a `maxLines` of 1 leaves room only for the marker. Likewise, a very small `maxBytes` will drop the marker unless you supply a shorter one.

A marker function is called with the omission counts. Because a longer marker leaves less room for content, and the content changes those counts, the callback may be invoked several times while the counts settle. It must be a pure function of its info and return the same marker for the same counts; otherwise there is no self-consistent answer, and `truncate` throws an `Error` ("marker function did not converge") instead of returning counts the callback never saw.

An oversized proposal is treated as the empty marker **before** the counts are computed. A callback that always returns a marker too large for the budget therefore settles on the dropped-marker layout and receives the counts that are actually returned. The final call always receives the `omittedBytes` and `omittedLines` values reported by `truncate`.

### Counting and metadata

- `keptBytes` / `keptLines` describe the final `text`, marker included, and match `utf8ByteLength(result.text)` / `countLines(result.text)`.
- `omittedBytes` is the number of **original** bytes absent from the output. The marker is new text, not original text, so it does not count as omitted.
- `omittedLines` is the number of **whole** original lines with no retained content. A line that survives partially (a byte cut in the middle) still counts as kept.
- Consequently, with a marker: `keptBytes - utf8ByteLength(marker) + omittedBytes === originalBytes`. Without a marker the simpler `keptBytes + omittedBytes === originalBytes` holds.

### Unicode boundaries

Cuts are made only between Unicode scalar values. `TextEncoder`/`encodeInto` is the authority for prefixes; suffixes are located by walking code points backwards. A 3-byte CJK character or a 4-byte emoji is either kept whole or removed whole. A cut never creates a lone surrogate.

Grapheme clusters are **not** protected: an emoji ZWJ sequence, a flag, or a base letter plus combining mark may be split between its code points. This is still valid UTF-8 and still within both budgets. If you need grapheme integrity, truncate on grapheme boundaries before calling this package.

### CRLF

Only `\n` counts as a line break. A byte cut between `\r` and `\n` is repaired: a head never ends with a dangling `\r`, and a tail never starts with a dangling `\n`.

## Examples

### Keep the beginning

```ts
truncate(log, { maxBytes: 8 * 1024, maxLines: 200 });
// "head" is the default
```

### Keep the end (where errors usually are)

```ts
truncate(log, { maxBytes: 8 * 1024, maxLines: 200, mode: "tail" });
```

### Keep both ends with a custom marker

```ts
const result = truncate(log, {
  maxBytes: 4 * 1024,
  mode: "head-tail",
  marker: (info) =>
    `\n... ${info.omittedLines} lines / ${info.omittedBytes} bytes omitted ...\n`,
});
```

Note that this marker is 2 lines, so it consumes two lines of the budget.

### Byte limit only

```ts
truncate(singleLineJson, { maxBytes: 4096 });
```

### Pure content, no marker

```ts
truncate(text, { maxLines: 100, marker: "" });
```

## Comparison with `truncate-utf8-bytes`

[`truncate-utf8-bytes`](https://www.npmjs.com/package/truncate-utf8-bytes) is the closest established package (last published 2016, ~9M weekly downloads, one dependency).

| | truncate-budget | truncate-utf8-bytes |
| --- | --- | --- |
| UTF-8 byte budget | yes | yes |
| Line budget | yes | no |
| Keeps the end | yes (`tail`, `head-tail`) | no, prefix only |
| Truncation marker | yes, budgeted | no |
| Omission metadata | bytes and lines | no |
| TypeScript declarations | bundled | separate `@types` package |
| Module formats | ESM + CJS | CJS |
| Runtime dependencies | 0 | 1 (`utf8-byte-length`) |

`truncate-utf8-bytes` is a good, focused primitive and its Unicode handling is not broken. This package targets a different job: policy-driven trimming of tool output under two budgets at once, with a visible marker and exact accounting. If all you need is "give me at most N bytes of a string", the older package is smaller and sufficient.

## Limitations

- **Not token-aware.** Tokens are model-specific; use a tokenizer for token budgets.
- **In-memory only.** The API takes and returns a string. It is not a streaming truncator and does not read files.
- **ANSI escape sequences are not understood.** A cut or the marker can land inside an SGR sequence, which may leave a terminal in the wrong color. Strip ANSI codes first if that matters.
- **Grapheme clusters can be split** between their code points, as described above.
- **Only `\n` is a line break.** Classic Mac `\r`-only text is counted as one line.
- **The marker is all-or-nothing.** A marker that does not fit is dropped rather than shortened.
- **A marker callback may be invoked more than once** while the omission counts converge, and it must stabilize; otherwise `truncate` throws.

## License

MIT
