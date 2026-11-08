# Remote Agent aggregation boundary — 2026-10-08

This describes the original aggregation boundary, not a final execution audit.
See [the 2026-10-11 execution and recovery review](MULTI-AGENT-AGGREGATION-20261011.md)
for capability enforcement, exact routing, asynchronous revocation and verification limits.

Remote programming is a shared transport, not a Codex-only implementation.
The phone kernel now keeps one normalized pipeline for:

- session directory and paged history;
- `message`, `reasoning`, `tool`, approval, turn, attachment and cursor events;
- delivery receipts, station handover, reconnect and cache scopes;
- capability-driven send/model/image behavior.

The desktop Bridge remains adapter-owned. Codex and Claude Code translate their
native records into the normalized event protocol; Claude Desktop read-only
history is kept as a separate surface and is never silently downgraded to a
Claude Code session. A future adapter such as Hermes must provide its own
executable detection, session paging, event mapper, send/interrupt/approval
semantics and capability descriptor before it is marked remotely controllable.

The Bridge manager now has an explicit adapter registry. Built-ins occupy stable
reserved ids, while independently constructed extension adapters can be added to
the same manager without changing dispatch, queueing, history paging, or
attachment code. Each extension publishes a sanitized descriptor and normalized
capability set (`list`, `read`, `send`, `interrupt`, `approval`, `questions`,
`subagents`, `attachments`, `imageInput`, `imageOutput`, `modelOverride`). An
adapter without that descriptor remains visible only as unknown/read-only; its
presence cannot grant a Codex/Claude fallback or remote send by accident.

The phone preserves a well-formed extension Agent profile (`id`, `tool`, public
name, availability and explicit capabilities) instead of dropping it or
guessing that it is Codex/Claude. The current product cards still expose only
the shipped adapters; this kernel change does not add a UI card or claim that
an unimplemented adapter works.

Security boundary:

- agent IDs, tool IDs and labels are syntax-checked;
- credentials, provider URLs and local paths are not accepted as labels;
- `remoteSendSupported` must be explicitly advertised for an extension;
- capabilities are adapter claims, not model-name guesses; the phone treats
  omitted fields as unavailable;
- unknown event kinds remain folded/opaque until an adapter maps them.

This keeps the transport and conversation experience reusable while each Agent
retains its own native lifecycle and capability truth.
