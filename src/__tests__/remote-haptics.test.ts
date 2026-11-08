import { AppState, Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';
import { hapticEffort, hapticModelCommit, hapticModelTick, setRemoteHaptics } from '../remote/haptics';

jest.mock('expo-haptics', () => ({
  AndroidHaptics: { Segment_Tick: 'segment-tick', Confirm: 'confirm' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined), selectionAsync: jest.fn(async () => undefined),
}));
beforeEach(() => {
  jest.clearAllMocks(); jest.replaceProperty(Platform, 'OS', 'android');
  AppState.currentState = 'active'; setRemoteHaptics(true);
  jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
  jest.spyOn(Vibration, 'cancel').mockImplementation(() => undefined);
});
afterEach(() => { setRemoteHaptics(true); jest.restoreAllMocks(); });

test.each(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('%s effort selection gets native Android feedback', level => {
  hapticEffort(level);
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Segment_Tick);
  expect(Vibration.vibrate).not.toHaveBeenCalled();
});
test('arc browsing is rate limited but model confirmation is never swallowed by its preceding tick', () => {
  jest.spyOn(Date, 'now').mockReturnValue(0);
  hapticModelTick(); hapticModelTick(); hapticModelCommit();
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledTimes(2);
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenLastCalledWith(Haptics.AndroidHaptics.Confirm);
  jest.spyOn(Date, 'now').mockReturnValue(45); hapticModelTick();
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledTimes(3);
});
test('iOS uses selection/impact instead of a 400ms React Native vibration', () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  hapticEffort('minimal'); hapticEffort('high'); hapticModelTick(); hapticModelCommit();
  expect(Haptics.impactAsync).toHaveBeenNthCalledWith(1, Haptics.ImpactFeedbackStyle.Light);
  expect(Haptics.impactAsync).toHaveBeenNthCalledWith(2, Haptics.ImpactFeedbackStyle.Medium);
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled(); expect(Vibration.vibrate).not.toHaveBeenCalled();
});
test('a missing native module on an old Android binary has bounded fallback and cannot reject a UI action', async () => {
  jest.mocked(Haptics.performAndroidHapticsAsync).mockRejectedValueOnce(new Error('module unavailable'));
  hapticEffort('minimal'); await Promise.resolve();
  expect(Vibration.vibrate).toHaveBeenCalledWith([0, 18]);
});
test('a late native failure cannot play feedback for a stale selection', async () => {
  let reject!: (error: Error) => void;
  jest.mocked(Haptics.performAndroidHapticsAsync).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  hapticEffort('low'); hapticEffort('high'); reject(new Error('old feedback')); await Promise.resolve();
  expect(Vibration.vibrate).not.toHaveBeenCalled();
});
test('disabled, background and web feedback are all quiet', () => {
  setRemoteHaptics(false); hapticEffort('high'); hapticModelCommit();
  setRemoteHaptics(true); AppState.currentState = 'background'; hapticEffort('low');
  AppState.currentState = 'active'; jest.replaceProperty(Platform, 'OS', 'web'); hapticModelTick();
  expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled(); expect(Haptics.impactAsync).not.toHaveBeenCalled();
});
