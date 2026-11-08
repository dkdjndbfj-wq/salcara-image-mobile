export interface RightWorkspaceShortcutOptions {
  active: boolean
  canOpenReview: boolean
  allowTemporaryChat: boolean
  canBrowseFiles: boolean
  onNavigate: (action: () => void) => void
  onSelectReview: () => void
  onSelectBrowser: () => void
  onSelectChat: () => void
  onSelectFiles: () => void
}

// React Native has no window keyboard event stream; touch controls remain available.
export function useRightWorkspaceShortcuts(_options: RightWorkspaceShortcutOptions) {}
