// Test host only: App.tsx supplies the real SafeAreaProvider in production.
// Use the package's supported mock to supply metrics for isolated sheet tests.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
