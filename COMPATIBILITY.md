# Page ↔ planner engine compatibility

What the phone view (`index.html`), the laptop view (`desk/`) and the test copy (`test/`) write to the planner's inbox, and
what they need from the engine first. The code is `save.js`; the tests are `tests/save.test.mjs` and `tests/pages.test.mjs`.

## The engine's side

The engine says what it reads in **`engine/capabilities.json`**, on the **default branch** of the planner repository (the
branch the page reads `state/next.md` from and writes `state/inbox.md` to; the page has no branch setting):

```json
{ "said": { "version": 2, "tags": ["text", "title", "why", "note", "because", "solution", "left", "goal", "steps"] } }
```

`said` version 2 means the engine reads both newer kinds of inbox lines the page writes:

- `| said <words>` and `| said <tag>: <words>` at the end of a line: what the user typed in a field the spelling check
  changed. The untagged form is the line's main text and counts as tag `text`.
- `keep words: <fixed text>`: put the user's words back in place of that fix. The engine may refuse when the line has
  changed since; the page says only that the words were sent.

A file on a feature branch of the engine does not count until it is on the default branch.

## What the page does

| `engine/capabilities.json` on the default branch | Spelling fix, AI proofread, Keep my words | What is saved |
|---|---|---|
| `said.version` is exactly `2`, `said.tags` is a list of strings with at least one tag below | on, for the known tags it lists | the fixed line with `\| said` parts for those tags; `keep words:` lines |
| missing (404), no token, refused (401/403) | off | every line exactly as typed |
| not JSON, not an object, no `said` object, `tags` not a list of strings, no known tag, over 64 KB | off | every line exactly as typed |
| `said.version` other than the number `2` (lower, higher, a string) | off | every line exactly as typed |
| not reachable (no connection, 429, 5xx) | off; asked again when the browser is back online | every line exactly as typed |

- Tags the page knows: `text title why note because solution left goal steps` (check.js `SAID_TAGS`). Unknown tags in
  the file are ignored. A field whose tag the file doesn't list is never fixed and is saved as typed.
- The file is read once per configuration (repository, default branch, token) with the same GitHub contents reader and
  token as every other read. Any change of repository or token, in Settings or in another tab, drops the answer at once
  (fail closed) and reads the file again. An answer that arrives after the configuration changed is thrown away.
- An answer stays for the life of the page: an engine taken back to an older version is noticed on the next page load.

## Saving and offline replay

- Lines wait in the browser (`planner.outbox`, shared by both views) until saved, in order, one saver across tabs, each
  line once. If a retry finds that the inbox already ends with that batch, the earlier try got there and the batch isn't
  written again.
- The form is decided when the line is sent, from the answer for the configuration in use at that moment:
  - **verified:** a queued line goes as queued, and `| said` parts for tags the file doesn't list are restored.
  - **not verified:** each `| said` part's words go back into their field, and the line is saved as the user typed it.
    Runs of spaces become one, which is how `| said` recorded them. `keep words:` lines wait in the browser
    (`planner.outbox.held`) and go once the engine is verified.
- A `| said` part that can't be matched to a field (typed by hand) is left exactly as it is.
- If the engine answer takes more than 10 s, the save goes ahead as typed.
- Demo mode (`?mock=1`) has no engine. Its spelling check is off unless a test sets `__MOCK_CAPS`.

## Versions

| Page | Engine | Result |
|---|---|---|
| before this branch | any | always sent `\| said` and `keep words:` (C4) |
| this branch | without `engine/capabilities.json`, or another `said.version` | lines saved exactly as typed; no fixes |
| this branch | publishing `said.version: 2` as above | fixes, AI proofread, `\| said`, `keep words:` |

`check.js` is synced from the planner repository (its `tools/sync-page.mjs`). This branch's language and dictionary fixes
in it need to land there too, or the next sync takes them out.
