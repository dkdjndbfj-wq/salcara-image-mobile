export * from 'react-native-web';
export const PermissionsAndroid = { PERMISSIONS: {}, RESULTS: {}, request: async () => 'granted', check: async () => true };
export const BackHandler = { addEventListener: () => ({ remove: () => {} }) };
