import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSurfaceHandle, TerminalSurfaceProps } from './TerminalSurface.types';

export const TerminalSurface = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(function TerminalSurface(props, ref) {
  const container = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  useImperativeHandle(ref, () => ({
    writeBase64: data => terminal.current?.write(Uint8Array.from(atob(data), char => char.charCodeAt(0))),
    writeText: data => terminal.current?.write(data), clear: () => terminal.current?.clear(), focus: () => terminal.current?.focus(),
    setEnabled: enabled => { if (terminal.current) terminal.current.options.disableStdin = !enabled; },
  }), []);
  useEffect(() => {
    let cancelled = false, cleanup: (() => void) | undefined;
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (cancelled || !container.current) return;
      const instance = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'Cascadia Code, Menlo, Consolas, monospace', scrollback: 5000,
        convertEol: false, disableStdin: !callbacks.current.enabled, allowProposedApi: false,
        theme: { background: '#FFFFFF', foreground: '#252A31', cursor: '#252A31', selectionBackground: '#DBEAFE', black: '#252A31', brightBlack: '#777C83' } });
      const sizing = new FitAddon(); instance.loadAddon(sizing); instance.open(container.current);
      terminal.current = instance; fit.current = sizing;
      const input = instance.onData(data => callbacks.current.onInput(data));
      const resize = instance.onResize(({ cols, rows }) => callbacks.current.onResize(cols, rows));
      const observer = new ResizeObserver(() => { if (container.current?.clientWidth && container.current.clientHeight) sizing.fit(); });
      observer.observe(container.current); sizing.fit(); callbacks.current.onResize(instance.cols, instance.rows); callbacks.current.onReady();
      if (callbacks.current.active) instance.focus();
      cleanup = () => { observer.disconnect(); input.dispose(); resize.dispose(); instance.dispose(); terminal.current = null; fit.current = null; };
    }).catch(reason => { if (!cancelled) callbacks.current.onError(reason instanceof Error ? reason : new Error('终端渲染器加载失败')); });
    return () => { cancelled = true; cleanup?.(); };
  }, []);
  useEffect(() => { if (terminal.current) terminal.current.options.disableStdin = !props.enabled; }, [props.enabled]);
  useEffect(() => { if (props.active && container.current?.clientWidth) { fit.current?.fit(); terminal.current?.focus(); } }, [props.active]);
  return <div ref={container} role="region" aria-label="交互式电脑终端" style={{ width: '100%', height: '100%', minHeight: 0, padding: 8, boxSizing: 'border-box', overflow: 'hidden' }} />;
});
