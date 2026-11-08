// Test host only: App.tsx supplies the real SafeAreaProvider in production.
// Use the package's supported mock to supply metrics for isolated sheet tests.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// The native WebView module is unavailable in the Jest host. Keep its props
// visible on a regular View so remote preview navigation and error states can
// be tested without a device binary.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { WebView: (props: Record<string, unknown>) => React.createElement(View, props) };
});
