export interface TerminalSurfaceHandle {
  writeBase64(data: string): void;
  writeText(data: string): void;
  clear(): void;
  focus(): void;
  setEnabled(enabled: boolean): void;
}
export interface TerminalSurfaceProps {
  active: boolean;
  enabled: boolean;
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  onReady(): void;
  onError(reason: Error): void;
}
