import { Platform } from 'react-native';

/** Shared by conversation text and its dialogs; source code keeps its own face. */
export const roundedSystemFontFamily: string = Platform.select({
  web: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  ios: 'System',
  android: 'sans-serif',
  default: 'System',
})!;
