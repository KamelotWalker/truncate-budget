# truncate-budget

Truncate text to a UTF-8 byte budget and a line budget in one call, without ever splitting a character.

## Install

```sh
npm install truncate-budget
```

Node.js >= 18. ESM and CommonJS builds with bundled TypeScript declarations. Zero runtime dependencies. The only platform API used is the global `TextEncoder`.

## Quick start

```ts
import { truncate } from "truncate-budget";

const result = truncate(toolOutput, {
  maxBytes: 50_000,
  maxLines: 2_000,
  mode: "head-tail",
});

process.stdout.write(result.text); // <= 50,000 UTF-8 bytes and <= 2,000 lines
```

`result.text` is always valid UTF-8 and always within both budgets. The default marker is already included in those numbers.

## Why

Cutting output with `slice()` or a byte buffer fails in ways that only show up on real data:

```ts
"a😀b".slice(0, 2); // "a\uD83D" — a lone high surrogate
Buffer.from("a😀b").subarray(0, 3).toString(); // "a�" — replacement character
```

The first result is not valid Unicode; the second has silently corrupted the last character. Both are common in CLIs that stream command output into a terminal, a log line, or a model context window.

A head-only cut has a second problem: build tools and test runners put the useful part — the failure and the stack trace — at the end. And a line-only cut does not bound size at all when one line is huge (minified JSON, base64, a progress bar).

`truncate-budget` treats the byte limit and the line limit as two independent budgets, keeps whichever end you ask for, inserts a budgeted marker where content was removed, and returns exact omission counts so the caller can report what was dropped.

## Comparison

| | [truncate-budget](https://www.npmjs.com/package/truncate-budget) | [truncate-utf8-bytes](https://www.npmjs.com/package/truncate-utf8-bytes) | [unicode-byte-truncate](https://www.npmjs.com/package/unicode-byte-truncate) |
| --- | --- | --- | --- |
| UTF-8 byte budget | yes | yes | yes |
| Line budget | yes | no | no |
| Keeps the end | `"tail"`, `"head-tail"` | no, prefix only | no, prefix only |
| Truncation marker | yes, charged to both budgets | no | no |
| Omission metadata | bytes and lines | no | no |
| `truncated` flag | yes | no | no |
| API style | `truncate(text, options)` returns a result object | `truncate(string, bytes)` returns a string | `truncate(string, bytes)` returns a string |
| TypeScript | bundled declarations | [`@types/truncate-utf8-bytes`](https://www.npmjs.com/package/@types/truncate-utf8-bytes) | no `@types` package on npm |
| Module format | ESM + CJS | CJS | CJS |
| Runtime dependencies | 0 | 1 (`utf8-byte-length`) | 2 (`is-integer`, `unicode-substring`) |
| Latest release | 0.1.1 (2026-10-28) | 1.0.2 (2016-09-29) | 1.0.0 (2016-02-08) |
| Weekly downloads* | new package | ~9.0M | ~347k |

\* npm downloads API, week of 2026-10-20 to 2026-10-26. Popularity is not correctness: both older packages handle multi-byte characters and surrogate pairs correctly. They solve a narrower problem — "give me the longest prefix under N bytes" — and they do it well. `truncate-budget` is for callers that need two budgets, either end of the text, a visible marker, and exact accounting.

Sources: [truncate-utf8-bytes repository](https://github.com/parshap/truncate-utf8-bytes), [unicode-byte-truncate repository](https://github.com/watson/unicode-byte-truncate).

## Migrating from truncate-utf8-bytes

Before:

```js
const truncate = require("truncate-utf8-bytes");

const text = truncate(output, 50_000); // prefix only, bytes only
```

After:

```ts
import { truncate } from "truncate-budget";

const { text } = truncate(output, { maxBytes: 50_000, marker: "" });
```

`truncate-budget` returns an object, so read `.text`. Pass `marker: ""` to get plain content without the default `" … [truncated] … "` notice. When the input already fits, the original string is returned unchanged. If you also want a line cap, add `maxLines`; if the end matters more than the start, add `mode: "tail"`.

## Migrating from unicode-byte-truncate

Before:

```js
const truncate = require("unicode-byte-truncate");

const text = truncate(output, 4096);
```

After:

```ts
import { truncate } from "truncate-budget";

const { text } = truncate(output, { maxBytes: 4096, marker: "" });
```

The same notes apply: the result is an object, the default marker adds text unless you pass `marker: ""`, and the input is returned unchanged when it fits.

## API reference

### `truncate(text, options?)`

```ts
function truncate(text: string, options?: TruncateOptions): TruncateResult;
```

Returns a result object. When `text` already fits both budgets, `result.text === text`, `truncated` is `false`, and no marker is inserted.

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxBytes` | `number` | no limit | Maximum UTF-8 bytes in `result.text`, marker included. Floored to an integer. `Infinity` means no limit. |
| `maxLines` | `number` | no limit | Maximum lines in `result.text`, marker included. Floored to an integer. `Infinity` means no limit. |
| `mode` | `"head" \| "tail" \| "head-tail"` | `"head"` | Which end(s) of the text to keep. |
| `marker` | `string \| ((info: TruncateInfo) => string)` | `DEFAULT_MARKER` | Inserted where content was removed. Charged against both budgets; dropped when it cannot fit. |

At least one of `maxBytes` or `maxLines` must be finite; `truncate(text)` and `truncate(text, {})` throw a `TypeError`.

#### Return value

`TruncateResult`:

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | The truncated text. Identical to the input when `truncated` is `false`. |
| `truncated` | `boolean` | Whether any original content was removed. |
| `markerOmitted` | `boolean` | `true` when a non-empty marker was requested but did not fit the budgets. |
| `originalBytes` | `number` | UTF-8 bytes in the input. |
| `originalLines` | `number` | Lines in the input (see `countLines`). |
| `keptBytes` | `number` | UTF-8 bytes in `text`, marker included. Never exceeds `maxBytes`. |
| `keptLines` | `number` | Lines in `text`, marker included. Never exceeds `maxLines`. |
| `omittedBytes` | `number` | Bytes of the original text absent from the output, marker excluded. |
| `omittedLines` | `number` | Whole original lines absent from the output; a partially kept line counts as kept. |

`keptBytes` and `keptLines` match `utf8ByteLength(result.text)` and `countLines(result.text)` exactly.

#### Errors

| Error | When |
| --- | --- |
| `TypeError` | `text` is not a string; `options` is not an object; neither budget is finite; `mode` is unknown; `marker` is not a string or function; a marker function returns a non-string. |
| `RangeError` | `maxBytes` or `maxLines` is negative or `NaN`, or is a non-finite number other than `Infinity`. |
| `Error` | A marker function never settles on the same marker for the same omission counts (`"marker function did not converge"`). |

### `utf8ByteLength(text)`

```ts
function utf8ByteLength(text: string): number;
```

UTF-8 byte length of a string, using `TextEncoder`. `"a"` → 1, `"é"` → 2, `"日"` → 3, `"😀"` → 4. Use this instead of `.length` when checking against a byte limit.

### `countLines(text)`

```ts
function countLines(text: string): number;
```

Number of lines under the same rule the line budget uses: text is split on `\n`, and a trailing `\n` terminates the last line rather than starting an empty one. `""` → 0, `"a"` → 1, `"a\n"` → 1, `"a\nb"` → 2, `"\n"` → 1. CRLF is one break because only `\n` is counted; a lone `\r` is ordinary text.

### `DEFAULT_MARKER`

```ts
const DEFAULT_MARKER: " … [truncated] … ";
```

The default marker: 21 UTF-8 bytes, 1 line. It is charged against both budgets.

### Types

```ts
type TruncateMode = "head" | "tail" | "head-tail";

interface TruncateOptions {
  maxBytes?: number;
  maxLines?: number;
  mode?: TruncateMode;
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

## Budget rules

### Both budgets apply

The two limits are independent, and whichever binds first decides how much is kept. A byte cut may leave a partial line; a line cut may leave bytes unused. `keptBytes`/`keptLines` never exceed their limits.

### Modes

| Mode | Output |
| --- | --- |
| `"head"` | prefix of the text |
| `"tail"` | suffix of the text |
| `"head-tail"` | prefix + marker + suffix |

In `head-tail` mode, the budget left after the marker is split between both ends: the head gets `floor(remaining / 2)` bytes and lines, the tail gets the rest. The odd byte or line goes to the tail.

### Marker

The marker is inserted only when content is actually removed. It is part of the output, so its UTF-8 bytes and its lines are subtracted from the budgets before any content is kept. The default is `" … [truncated] … "` (21 bytes, 1 line).

If the marker alone does not fit (`markerBytes > maxBytes` or `markerLines > maxLines`), it is dropped: `markerOmitted` is `true` and the entire budget goes to content. A marker is never shortened or truncated. Pass `marker: ""` to disable it.

Any non-empty marker occupies at least one line, so `maxLines: 1` leaves room only for the marker. Likewise, a very small `maxBytes` drops the marker unless you supply a shorter one.

A marker function is called with the omission counts. Because a longer marker leaves less room for content, and the content changes those counts, the callback may be invoked several times while the counts settle. It must be a pure function of its info and return the same marker for the same counts; otherwise there is no self-consistent answer, and `truncate` throws an `Error` instead of returning counts the callback never saw.

An oversized proposal is treated as the empty marker before the counts are computed. A callback that always returns a marker too large for the budget therefore settles on the dropped-marker layout and receives the counts that are actually returned. The final call always receives the `omittedBytes` and `omittedLines` values reported by `truncate`.

### Counting and metadata

- `keptBytes` / `keptLines` describe the final `text`, marker included, and match `utf8ByteLength(result.text)` / `countLines(result.text)`.
- `omittedBytes` is the number of original bytes absent from the output. The marker is new text, not original text, so it does not count as omitted.
- `omittedLines` is the number of whole original lines with no retained content. A line that survives partially (a byte cut in the middle) still counts as kept.
- Consequently, with a marker: `keptBytes - utf8ByteLength(marker) + omittedBytes === originalBytes`. Without a marker, the simpler `keptBytes + omittedBytes === originalBytes` holds.

### Unicode boundaries

Cuts are made only between Unicode scalar values. `TextEncoder`/`encodeInto` is the authority for prefixes; suffixes are located by walking code points backwards. A 3-byte CJK character or a 4-byte emoji is either kept whole or removed whole; a cut never creates a lone surrogate.

Grapheme clusters are not protected: an emoji ZWJ sequence, a flag, or a base letter plus combining mark may be split between its code points. This is still valid UTF-8 and still within both budgets. If you need grapheme integrity, truncate on grapheme boundaries before calling this package.

### CRLF

Only `\n` counts as a line break. A byte cut between `\r` and `\n` is repaired: a head never ends with a dangling `\r`, and a tail never starts with a dangling `\n`.

## When not to use this

- **You only need a prefix and the limit is in bytes.** [`truncate-utf8-bytes`](https://www.npmjs.com/package/truncate-utf8-bytes) is smaller and has handled this correctly since 2016.
- **Your text is ASCII and you want at most N characters.** `text.slice(0, n)` is enough; for ASCII, characters and bytes are the same thing. Do not use this reasoning for arbitrary user or command output.
- **You need a token budget.** UTF-8 bytes are not tokens. Use the tokenizer of the target model; a byte budget is only a cheap approximation.
- **You are streaming.** The API takes and returns a string. It does not read files or streams, and it holds the whole input in memory.
- **You need grapheme integrity.** Flags, ZWJ emoji sequences, and combining marks can be split between their code points. Segment graphemes first.
- **You need ANSI-aware cutting.** Escape sequences are ordinary bytes here. Strip ANSI codes before truncating terminal output.

## Limitations

- **Not token-aware.** Tokens are model-specific; use a tokenizer for token budgets.
- **In-memory only.** The API takes and returns a string. It is not a streaming truncator and does not read files.
- **ANSI escape sequences are not understood.** A cut or the marker can land inside an SGR sequence, which may leave a terminal in the wrong color. Strip ANSI codes first if that matters.
- **Grapheme clusters can be split** between their code points, as described above.
- **Only `\n` is a line break.** Classic Mac `\r`-only text is counted as one line.
- **The marker is all-or-nothing.** A marker that does not fit is dropped rather than shortened.
- **A marker callback may be invoked more than once** while the omission counts converge, and it must stabilize; otherwise `truncate` throws.

## FAQ

### How is this different from `truncate-utf8-bytes`?

It adds a line budget, `tail` and `head-tail` modes, a marker charged against the budgets, and omission counts. `truncate-utf8-bytes` only returns the longest prefix under a byte limit; if that is all you need, it is the smaller and more established choice.

### Why not `Buffer.from(text).subarray(0, n).toString()`?

Because a byte cut can land inside a character, and Node decodes the partial sequence as U+FFFD:

```ts
Buffer.from("a😀b").subarray(0, 3).toString(); // "a�"
truncate("a😀b", { maxBytes: 3, marker: "" }).text; // "a"
```

### Does `countLines` match `wc -l`?

Almost, but not exactly. `wc -l` counts newline characters, so a file without a trailing newline reports one fewer line; `countLines` counts the last unterminated line, so `"a"` is 1 and `"a\n"` is 1.

### What happens when the marker is larger than the whole budget?

It is dropped instead of shortened, `markerOmitted` becomes `true`, and all remaining bytes and lines go to content:

```ts
truncate("abcdefghij", { maxBytes: 8 });
// { text: "abcdefgh", truncated: true, markerOmitted: true, keptBytes: 8, omittedBytes: 2, ... }
```

### Can I keep both the beginning and the end?

Yes. `mode: "head-tail"` splits the budget left after the marker, with the head getting the floor and the tail the remainder:

```ts
truncate("one\ntwo\nthree\nfour", { maxLines: 3, mode: "head-tail" });
// "one\n … [truncated] … four"
```

### Does it work in Bun and Deno?

The ESM build uses only the global `TextEncoder`, so it loads there. The package is tested in CI on Node.js 18, 20, 22, and 24 across Linux, macOS, and Windows.

## License

MIT
