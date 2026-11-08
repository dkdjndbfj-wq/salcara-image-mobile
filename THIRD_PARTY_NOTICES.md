# Third-party notices

## Noble Ed25519

Hub ingress identity proofs use `@noble/ed25519` 3.2.0 with the existing `@noble/hashes` SHA-512 implementation. Verification uses strict RFC 8032 checks. The package is distributed under the MIT license; a copy is included at [licenses/noble-ed25519-MIT.txt](licenses/noble-ed25519-MIT.txt).

## Google Tink

The Android background watcher verifies Hub ingress identity proofs with `com.google.crypto.tink:tink-android:1.15.0`. This avoids relying on an Ed25519 platform provider that is unavailable on some supported Android versions. Google Tink is Copyright Google LLC and distributed under Apache License 2.0; a copy is included at [licenses/Tink-APACHE-2.0.txt](licenses/Tink-APACHE-2.0.txt). Source: https://github.com/tink-crypto/tink-java/tree/v1.15.0.

## KaTeX and Mermaid

Mathematical typesetting uses KaTeX and diagram rendering uses Mermaid. Their scripts and fonts are bundled locally for offline, isolated rendering. Rebuild those generated assets with `npm run renderers:build` after dependency updates. Copies of their MIT licenses and bundled version numbers are in `src/components/rich-renderer-assets/`.

## Wegent

The tablet programming workbench incorporates desktop source from [wecode-ai/Wegent](https://github.com/wecode-ai/Wegent), pinned to commit `ac8951007b336c573ee8d34517e31ecfed047cbd`. No UI from `wework-mobile/` is used.

The following source is incorporated under `src/remote/wegent/`:

- `packages/collaboration/src/composer/ProjectChatComposerSurface.tsx`: the complete DOM surface, focus and short-pane expansion behavior; import paths adapted.
- `packages/collaboration/src/composer/ProjectChatComposer.module.css`: scroll fades, short-pane transitions and reduced-motion rules; CSS module names are prefixed for this host.
- `packages/collaboration/src/controls/ActionMenu.tsx`: menu positioning, submenus, keyboard navigation, pointer handling, focus restoration and outside-click behavior. Icons, tooltip, Escape listener and portal theme are supplied by local adapters.
- `packages/collaboration/src/composer/ComposerToolbar.tsx`: responsive width observation and the feature/action group JSX are used in `WegentComposer.web.tsx`. Host controls retain the real Agent send, attachment and model callbacks.
- `wework/src/components/layout/workspace-panels/useRightWorkspaceShortcuts.ts`: browser workspace keyboard shortcuts; import paths and the exported type are adapted.
- `wework/src/lib/keybindings.ts`: keyboard normalization and editable-target helpers.
- `wework/src/features/workspace-tabs/workspaceTabs.ts`: tab move/close algorithms, with generic tab types in place of desktop route types.

React Native renderers mirror the surface geometry and control groups. Desktop Electron services, Dsh plugin slots, ProseMirror editing, terminal execution and desktop window APIs are not included in this port. The existing mobile transports remain responsible for real Agent operations; only the development workspace uses simulated responses.

Wegent is distributed under the Apache License 2.0. A copy of the license is included at [licenses/Wegent-APACHE-2.0.txt](licenses/Wegent-APACHE-2.0.txt).
