import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { useDesk } from '../theme';
import { CompactActionMenu } from './CompactActionMenu';
import { commandLogPayload } from './command-output-actions';
import { exportArtifact } from './artifact-export';
import type { CommandOutputProps } from './CommandOutputContent';

export function CommandOutputActions(props: CommandOutputProps) {
  // A new source remounts the action owner even if the output text is identical.
  return <ActionOwner key={props.scopeKey ?? ''} {...props} />;
}
function ActionOwner(props: CommandOutputProps) {
  const d = useDesk(), anchor = useRef<View>(null), mounted = useRef(true), current = useRef(props);
  current.current = props;
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const flight = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') { flight.current?.abort(); setOpen(false); } });
    return () => { mounted.current = false; flight.current?.abort(); listener.remove(); };
  }, []);
  const run = async (action: 'command' | 'output' | 'save') => {
    if (!mounted.current || flight.current || AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
    const snapshot = current.current, controller = new AbortController();
    const content = action === 'command' ? snapshot.command : snapshot.output;
    if (action !== 'save' && !content) return;
    flight.current = controller; setPending(true);
    const active = () => mounted.current && flight.current === controller && !controller.signal.aborted;
    try {
      if (action === 'save') {
        if (!active()) return;
        await exportArtifact(commandLogPayload(snapshot), 'download', controller.signal);
      } else await Clipboard.setStringAsync(content!);
      if (active() && action !== 'save') showToast(action === 'command' ? '已复制命令' : '已复制完整输出');
    } catch (error) { if (active()) showToast(error instanceof Error ? error.message : '操作失败，请重试', 'alert'); }
    finally { if (flight.current === controller) { flight.current = undefined; if (mounted.current) setPending(false); } }
  };
  return <View style={{ height: 28, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 3 }}>
    <Pressable ref={anchor} accessibilityRole="button" accessibilityLabel="命令输出操作" accessibilityState={{ expanded: open, disabled: pending }} disabled={pending}
      hitSlop={{ top: 4, bottom: 4, left: 5, right: 3 }} onPress={() => setOpen(value => !value)}
      style={({ pressed }) => ({ height: 28, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: pressed ? d.press : 'transparent' })}>
      <Icon name="more" size={16} color={d.muted} />
    </Pressable>
    <CompactActionMenu visible={open} anchorRef={anchor} onClose={() => setOpen(false)} scopeKey={props.scopeKey} align="end" width={176} label="命令输出操作"
      actions={[
        { id: 'command', label: '复制命令', icon: 'copy', disabled: !props.command, onPress: () => void run('command') },
        { id: 'output', label: '复制完整输出', icon: 'copy', disabled: !props.output, onPress: () => void run('output') },
        { id: 'save', label: '保存日志', icon: 'download', disabled: !props.command && !props.output && props.exitCode === undefined, onPress: () => void run('save') },
      ]} />
  </View>;
}
