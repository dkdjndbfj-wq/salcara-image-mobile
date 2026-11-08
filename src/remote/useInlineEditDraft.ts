import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { showToast } from '../components/ui';
import { createInlineEditDraft, type InlineEditDraft } from './inline-edit-drafts';

/** Changes save after a short typing pause; navigation/background flushes the
 * latest input immediately instead of disposing an unfinished storage write. */
export function useInlineEditDraft(initialText: string, identity: string, scope?: string, deviceId?: string, enabled = true) {
  const [text, setText] = useState(initialText), [ready, setReady] = useState(!scope || !deviceId), [error, setError] = useState('');
  const owner = useRef<InlineEditDraft | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const source = JSON.stringify([identity,scope,deviceId,enabled]), generation = useRef({ source, epoch: 0 });
  if (generation.current.source !== source) generation.current = { source, epoch: generation.current.epoch + 1 };
  const epoch = generation.current.epoch, current = () => mounted.current && generation.current.epoch === epoch;
  const cancelTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => {
    mounted.current = true; cancelTimer(); setText(initialText); setError('');
    if (!enabled || !scope || !deviceId) { setReady(true); return () => { mounted.current = false; }; }
    const draft = createInlineEditDraft(scope, deviceId, identity); owner.current = draft; setReady(false);
    void draft.restore().then(value => {
      if (owner.current !== draft || !current()) return;
      if (value.text !== undefined) setText(value.text);
      setError(value.error ? `修改尚未保存：${value.error}` : ''); setReady(true);
    }).catch(reason => { if (owner.current === draft && current()) setError(`无法读取编辑草稿：${reason instanceof Error ? reason.message : '请重试'}`); });
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') { cancelTimer(); void draft.flush().catch(reason => { if (owner.current === draft && current()) setError(`修改尚未保存：${String(reason)}`); }); } });
    return () => {
      mounted.current = false; cancelTimer(); if (owner.current === draft) owner.current = undefined; subscription?.remove();
      void draft.close().catch(() => showToast('修改暂未保存，请返回原会话重试', 'alert'));
    };
  }, [identity, scope, deviceId, enabled]);
  const change = (value: string) => {
    if (!ready || !current() || !enabled) return;
    const draft = owner.current;
    try { draft?.stage(value); } catch(reason) { setError(reason instanceof Error?reason.message:'编辑来源已变化'); return; }
    setText(value); setError(''); if (!draft) return;
    cancelTimer(); timer.current = setTimeout(() => {
      timer.current = undefined;
      void draft.flush().then(() => { if (current() && owner.current === draft) setError(''); })
        .catch(reason => { if (current() && owner.current === draft) setError(`修改尚未保存：${reason instanceof Error ? reason.message : '请重试'}`); });
    }, 180);
  };
  const flush = async () => { if (!current() || !ready) throw new Error('编辑草稿尚未准备好或来源已变化'); cancelTimer(); const draft = owner.current; return { draft, receipt: await draft?.flush() }; };
  const discard = async () => { if (!current()) throw new Error('编辑来源已变化'); cancelTimer(); await owner.current?.discard(); };
  return { text, change, ready, error, flush, discard };
}
