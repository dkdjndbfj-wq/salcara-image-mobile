# Remote programming / Codex parity audit — 2026-10-08

2026-10-11 的对话/容量/输出续修见 `CODEX-CONVERSATION-AUDIT-20261011.md`。本文件保留历史基线；图片工具现在使用独立 `image_view` / `image_generation` 类型，不再只映射为 `read`。

This note records the kernel changes and the remaining protocol boundaries for the
phone remote-programming client. It intentionally does not describe a UI redesign:
the existing layout, colours, and animations remain the product surface.

## This pass

- Message attachments are opaque references. JPEG, PNG, and WebP bytes are read in
  bounded chunks, verified by MIME/magic bytes and optional SHA-256, and cached in a
  pairing/device/session scope.
- Message thumbnails are materialized at the virtualized row visibility boundary.
  A large history does not start one download per message. Tool/image-view and
  image-generation attachments remain folded and are read only after that work row
  is expanded. The existing two-download limit and quiet retry are retained.
- `imageView` and `imageGeneration` from the Codex app-server are projected as
  folded `read` work items. The desktop Bridge imports a local image into its private
  attachment store and sends only an opaque `att_…` reference. App-server versions
  without `savedPath` can use a bounded Base64 result after magic-byte validation.
  If the source file/data is invalid, its path/marker is removed rather than sent
  to the Hub.
- Timeline ordering now separates the first accepted event cursor (`orderSeq`) from
  the latest update cursor (`seq`). Streaming deltas can update `seq` without moving
  an assistant message across tools that appeared later.
- A completed turn with no top-level assistant text keeps a compact completion
  boundary, including reported duration/token totals. A normal turn with a final
  assistant reply keeps the usual reply actions and does not add a duplicate row.
- Codex history preserves the real turn id and reported duration. History and live
  events use the same attachment reference validation and merge rules.
- Android background watching treats each native watch configuration as a new
  station/credential boundary and clears old session targets and device cursors;
  switching from Hub A to Hub B therefore cannot keep polling A or skip B's first
  events.
- FCM registration now unregisters the old Hub target in memory before registering
  the same phone token on a different station (best effort if the old station was
  already revoked).

## Codex protocol alignment

The mapping is based on the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
and the generated `codex app-server generate-ts --experimental` schemas. The
Bridge currently projects user/assistant messages, reasoning, plans, command
execution, file changes, MCP/dynamic tools, collaboration/subagents, web search,
image view/generation, review mode, and context compaction. Tool details stay in
the folded activity summary; the phone can expand them without losing ordering.

## Agent aggregation boundary

The normalized phone timeline is shared by Codex, Claude Code and the separate
Claude Desktop history surface. Extension Agent metadata is retained when its
ID/tool are valid, but an unknown Agent is not treated as a built-in and cannot
be sent work unless the Bridge explicitly advertises its adapter and
`remoteSendSupported` capability. See
`AGENT-ADAPTER-ARCHITECTURE-20261008.md` for the adapter contract.

## Deliberate limits

- Attachments are currently image-only (maximum 8 MiB per file; four phone input
  images; bounded output reference count). PDFs and arbitrary documents are not
  silently downloaded as images.
- Remote URLs are not fetched by the Bridge. This avoids turning a tool result
  into an SSRF/file-exfiltration path. A provider result must expose a local
  image path or a bounded, magic-checked Base64 image for the Bridge to import it.
- Claude Code/Claude Desktop image blocks in historical transcripts are still
  represented as `[图片]` unless the provider exposes a local file path. Converting
  arbitrary base64 tool-result blocks needs a separate bounded binary-import
  protocol and is intentionally not guessed here.
- `session.send` has a durable delivery receipt when the Hub advertises
  `commands.idempotency.v1`. New-session start, interrupt, and legacy CLI approval
  calls still require their own operation outbox before they can be safely retried
  after a lost response. The client therefore does not blindly retry those writes.
- Native Codex Desktop control reports its own capability set. If its native surface
  does not advertise attachments, the phone disables image sending for that surface
  instead of pretending the CLI worker received the image.
- A full commercial acceptance run still needs fault-injection across phone process
  death, Hub restart, Bridge restart, an A→B Hub handover, attachment upload
  interruption, and Android background execution. Unit tests cannot prove those
  external-process guarantees.

## Verification performed

- Mobile TypeScript: `npm run typecheck`
- Mobile Jest: `npm test -- --runInBand`
- Desktop Bridge: `go test ./...`
- Both working trees: `git diff --check`

No keys, pairing tokens, server addresses, or private file paths are included in
this audit.
