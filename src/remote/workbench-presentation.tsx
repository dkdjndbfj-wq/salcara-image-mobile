import React, { createContext, useContext, useMemo } from 'react';

export type WorkbenchPresentation = { presentation: 'tablet' | 'phone'; textScale: number };

/** Conversation density is independent of app zoom and keeps controls touchable. */
export const WORKBENCH_SPACING = { paragraph: 10, turn: 14, userActions: 24, section: 16 } as const;
export const WORKBENCH_CHROME = { tab: 13, wideTab: 14, tool: 14, caption: 12 } as const;
const WorkbenchContext = createContext<WorkbenchPresentation | undefined>(undefined);

export function normalizedWorkbenchTextScale(value: number): number {
  return Number.isFinite(value) ? Math.max(0.9, Math.min(1.3, value)) : 1;
}

export function workbenchTypography(presentation: WorkbenchPresentation['presentation'], textScale = 1) {
  const scale = normalizedWorkbenchTextScale(textScale);
  const pair = (fontSize: number, lineHeight: number) => ({ fontSize: Math.round(fontSize * scale * 10) / 10, lineHeight: Math.round(lineHeight * scale * 10) / 10 });
  return {
    body: pair(presentation === 'tablet' ? 14 : 15, presentation === 'tablet' ? 22 : 24),
    heading: pair(18, 26), subheading: pair(16, 24),
    process: pair(13, 20), caption: pair(12, 18), code: pair(12.5, 20),
    inlineCode: pair(presentation === 'tablet' ? 13 : 14, presentation === 'tablet' ? 22 : 24),
  };
}

export function WorkbenchPresentationProvider({ presentation, textScale = 1, children }: {
  presentation: WorkbenchPresentation['presentation']; textScale?: number; children: React.ReactNode;
}) {
  const scale = normalizedWorkbenchTextScale(textScale);
  const value = useMemo(() => ({ presentation, textScale: scale }), [presentation, scale]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

/** Undefined outside a remote workbench: ordinary assistant chat stays unchanged. */
export function useWorkbenchPresentation() { return useContext(WorkbenchContext); }
export function useWorkbenchTypography() {
  const presentation = useWorkbenchPresentation();
  return useMemo(() => presentation ? workbenchTypography(presentation.presentation, presentation.textScale) : undefined, [presentation]);
}
