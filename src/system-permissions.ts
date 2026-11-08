import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';

type SystemPermission = 'camera' | 'microphone' | 'photo-save';
const names: Record<SystemPermission, string> = { camera: '相机', microphone: '麦克风', 'photo-save': '保存图片' };

/** Keep permission denials distinct from network, file and device failures. */
export class SystemPermissionError extends Error {
  constructor(readonly permission: SystemPermission, readonly canAskAgain: boolean) {
    const name = names[permission];
    super(permission === 'photo-save'
      ? canAskAgain ? '需要允许“保存图片”权限才能写入系统相册。' : '相册保存权限已被关闭，请到系统设置中允许 Salcara AI 保存图片。'
      : canAskAgain ? `尚未获得${name}权限，使用此功能时可再次申请；其他功能不受影响。`
        : `${name}权限已关闭，请在系统设置中允许 Salcara AI 使用${name}；其他功能不受影响。`);
    this.name = 'SystemPermissionError';
  }
}

function permissionFailure(error: unknown): SystemPermissionError | undefined {
  if (error instanceof SystemPermissionError) return error;
  // iOS startCapture owns its OS prompt and rejects with this stable code.
  if (Platform.OS === 'ios' && error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MIC_PERMISSION') {
    return new SystemPermissionError('microphone', false);
  }
  return undefined;
}

export function isSystemPermissionError(error: unknown): boolean { return Boolean(permissionFailure(error)); }

export async function openSystemPermissionSettings(): Promise<void> {
  try { await Linking.openSettings(); }
  catch { Alert.alert('无法打开系统设置', '请手动打开手机设置，在应用列表中找到 Salcara AI，再调整对应权限。'); }
}

let recoveryVisible = false;
/** Present recovery only from a current user action. Never reopen the feature
 * or retry a save/recording when returning from Settings. Android Back dismisses. */
export function handleSystemPermissionError(error: unknown): boolean {
  const failure = permissionFailure(error);
  if (!failure || failure.canAskAgain || Platform.OS === 'web') return false;
  if (recoveryVisible) return true;
  recoveryVisible = true;
  const dismiss = () => { recoveryVisible = false; };
  Alert.alert(`允许${names[failure.permission]}`, failure.message, [
    { text: '暂不', style: 'cancel', onPress: dismiss },
    { text: '去设置', onPress: () => {
      dismiss();
      void openSystemPermissionSettings();
    } },
  ], { cancelable: true, onDismiss: dismiss });
  return true;
}

let microphoneRequest: Promise<void> | undefined;
export async function requestMicrophonePermission(): Promise<void> {
  // iOS asks within native startCapture; browsers use their own capture flow.
  if (Platform.OS !== 'android') return;
  if (!microphoneRequest) microphoneRequest = (async () => {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: '允许使用麦克风', message: 'Salcara 需要麦克风来听你说话。录音只用于语音输入和语音对话。',
      buttonPositive: '继续', buttonNegative: '暂不',
    });
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new SystemPermissionError('microphone', result !== PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    }
  })().finally(() => { microphoneRequest = undefined; });
  return microphoneRequest;
}
