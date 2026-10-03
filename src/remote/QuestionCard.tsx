import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Icon } from '../components/Icon';
import { colors, desk, themed, useDesk } from '../theme';
import type { QuestionAnswers, RemoteQuestion } from './client';
import { questionValidation } from './questions';

function restoredAnswers(questions: RemoteQuestion[], saved?: QuestionAnswers) {
  const answers: QuestionAnswers = {}, custom: Record<string, string> = {}, present: Record<string, boolean> = {};
  for (const question of questions) {
    const options = question.inputType === 'boolean' ? ['true', 'false'] : (question.options ?? []).map((item) => item.label);
    const values = saved?.[question.id] ?? [];
    answers[question.id] = values.filter((value) => options.includes(value));
    custom[question.id] = values.filter((value) => !options.includes(value)).join('\n');
    present[question.id] = Boolean(saved && Object.prototype.hasOwnProperty.call(saved, question.id) && values.length);
  }
  return { answers, custom, present };
}
export function QuestionCard({ id, title, questions, expiresAt, busy, blocked, maxBodyHeight, initialAnswers, onAnswer, onCancel }: {
  id: string; title: string; questions: RemoteQuestion[]; expiresAt?: number; busy: boolean; blocked?: string; maxBodyHeight?: number; initialAnswers?: QuestionAnswers;
  onAnswer: (answers: QuestionAnswers) => void; onCancel: () => void;
}) {
  const dk = useDesk();
  const styles = useStyles();
  const [answers, setAnswers] = useState<QuestionAnswers>(() => restoredAnswers(questions, initialAnswers).answers);
  const [custom, setCustom] = useState<Record<string, string>>(() => restoredAnswers(questions, initialAnswers).custom);
  const [customPresent, setCustomPresent] = useState<Record<string, boolean>>(() => restoredAnswers(questions, initialAnswers).present);
  const [page, setPage] = useState(0);
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const { height } = useWindowDimensions();
  const [expired, setExpired] = useState(Boolean(expiresAt && expiresAt <= Date.now()));
  const [error, setError] = useState('');
  const restoredId = useRef(id);
  const edited = useRef(false);
  useEffect(() => {
    const changed = restoredId.current !== id;
    if (!changed && edited.current) return;
    restoredId.current = id; edited.current = false;
    const restored = restoredAnswers(questions, initialAnswers);
    setAnswers(restored.answers); setCustom(restored.custom); setCustomPresent(restored.present);
    if (changed) { setCustomOpen({}); setPage(0); setError(''); }
  }, [id, initialAnswers]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const check = () => setExpired(Boolean(expiresAt && expiresAt <= Date.now())); check();
    if (!expiresAt) return;
    const timer = setInterval(check, 1000); return () => clearInterval(timer);
  }, [expiresAt]);
  const select = (question: RemoteQuestion, label: string) => {
    edited.current = true;
    setAnswers((current) => ({ ...current, [question.id]: question.multiSelect ? (current[question.id] ?? []).includes(label) ? current[question.id].filter((value) => value !== label) : [...(current[question.id] ?? []), label] : [label] }));
    setError('');
    if (!question.multiSelect) { setCustom((current) => ({ ...current, [question.id]: '' })); setCustomOpen((current) => ({ ...current, [question.id]: false })); }
  };
  const responseFor = (list: RemoteQuestion[]) => {
    const response: QuestionAnswers = {};
    for (const question of list) {
      if (question.preserveWhitespace && !question.options?.length) {
        // MCP required means the property exists; an empty string is still a value.
        response[question.id] = customPresent[question.id] || question.required ? [custom[question.id] ?? ''] : [];
        continue;
      }
      const extra = custom[question.id]?.trim();
      response[question.id] = [...new Set(extra ? [...(question.multiSelect ? answers[question.id] ?? [] : []), extra] : answers[question.id] ?? [])];
    }
    return response;
  };
  const activePage = Math.min(page, Math.max(0, questions.length - 1));
  const question = questions[activePage];
  const last = activePage === questions.length - 1;
  const proceed = () => {
    if (busy || expired || (expiresAt && expiresAt <= Date.now()) || !question) return;
    if (!last) {
      const message = questionValidation([question], responseFor([question]));
      if (message) { setError(message); return; }
      setError(''); setPage(activePage + 1); return;
    }
    if (blocked) return;
    const response = responseFor(questions);
    for (let index = 0; index < questions.length; index += 1) {
      const message = questionValidation([questions[index]], response);
      if (message) { setPage(index); setError(message); return; }
    }
    setError(''); onAnswer(response);
  };
  const multiple = questions.length > 1;
  const canSubmit = !(expired || busy || !questions.length || (last && Boolean(blocked)));
  return <View style={styles.card}>
    <View style={styles.header}>
      <View style={styles.badge}><Icon name="chat" size={12} color={dk.accentText} /><Text style={styles.badgeText} numberOfLines={1}>{title || '需要你回答'}</Text></View>
      {multiple ? <View style={styles.steps} accessibilityLabel={`第 ${activePage + 1} 题，共 ${questions.length} 题`}>
        {questions.map((item, index) => <View key={item.id} style={[styles.step, index <= activePage && styles.stepOn]} />)}
      </View> : null}
      <View style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel="取消回答" hitSlop={10} disabled={busy || expired || Boolean(blocked)} onPress={onCancel} style={styles.close}>
        <Icon name="close" size={14} color={dk.faint} />
      </Pressable>
    </View>
    <ScrollView key={question?.id} testID="remote-question-body" style={{ maxHeight: Math.max(48, Math.min(Math.max(96, Math.min(220, height * 0.32)), maxBodyHeight ?? 220)) }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {question ? <View style={styles.question}>
        <Text style={styles.prompt}>{question.question}</Text>
        {question.multiSelect ? <Text style={styles.hint}>可多选</Text> : null}
        <View style={styles.options}>
        {(question.inputType === 'boolean' ? [{ label: 'true', description: '是' }, { label: 'false', description: '否' }] : question.options ?? []).map((option) => {
          const checked = (answers[question.id] ?? []).includes(option.label);
          const label = question.inputType === 'boolean' ? option.description : option.label || option.description || '空字符串';
          return <Pressable key={option.label} accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'} accessibilityLabel={label}
            accessibilityState={{ checked, disabled: busy || expired }} disabled={busy || expired} onPress={() => select(question, option.label)}
            style={({ pressed }) => [styles.option, checked && styles.selected, pressed && !checked && styles.optionPressed]}>
            <View style={[question.multiSelect ? styles.box : styles.radio, checked && styles.markOn]}>
              {checked ? question.multiSelect ? <Icon name="check" size={11} color={dk.onInk} strokeWidth={2.6} /> : <View style={styles.radioDot} /> : null}
            </View>
            <View style={styles.optionBody}>
              <Text style={[styles.optionText, checked && styles.optionTextOn]}>{label}</Text>
              {option.description && option.label && question.inputType !== 'boolean' ? <Text style={styles.detail}>{option.description}</Text> : null}
            </View>
          </Pressable>;
        })}
        {question.allowCustom && Boolean(question.options?.length) ? <Pressable accessibilityRole="button" accessibilityLabel={`${question.header || question.question}：自定义回答`}
          disabled={busy || expired} onPress={() => { setCustomOpen((current) => ({ ...current, [question.id]: !current[question.id] })); setError(''); }}
          style={[styles.option, styles.customOption, (customOpen[question.id] || custom[question.id]?.trim()) && styles.selected]}>
          <View style={[styles.customMark]}><Icon name="edit" size={12} color={dk.muted} /></View>
          <Text style={[styles.optionText, { flex: 1, color: dk.text2 }]} numberOfLines={1}>{customOpen[question.id] ? '收起自定义' : custom[question.id]?.trim() ? `其他：${custom[question.id].trim()}` : '其他答案'}</Text>
        </Pressable> : null}
        {question.inputType !== 'boolean' && (!question.options?.length || (question.allowCustom && customOpen[question.id])) ? <TextInput accessibilityLabel={`${question.header || question.question}：回答`} placeholder={question.options?.length ? '写下你的回答' : '输入回答'}
          placeholderTextColor={dk.faint} value={custom[question.id] ?? ''} editable={!busy && !expired} maxLength={4000} multiline={question.inputType !== 'number' && question.inputType !== 'integer'}
          keyboardType={(question.inputType === 'number' || question.inputType === 'integer') && question.min !== undefined && question.min >= 0 ? 'decimal-pad' : 'default'}
          onChangeText={(value) => { edited.current = true; setError(''); setCustomPresent((current) => ({ ...current, [question.id]: true })); setCustom((current) => ({ ...current, [question.id]: value })); if (!question.multiSelect) setAnswers((current) => ({ ...current, [question.id]: [] })); }} style={styles.input} /> : null}
        </View>
      </View> : null}
    </ScrollView>
    {error || expired || blocked ? <View style={styles.errorRow}><Icon name="alert" size={13} color={dk.bad} /><Text style={styles.error}>{expired ? '问题已过期，请刷新' : error || blocked}</Text></View> : null}
    <View style={styles.actions}>
      {activePage > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="上一题" hitSlop={6} disabled={busy || expired} onPress={() => { setPage(activePage - 1); setError(''); }} style={styles.back}>
        <Icon name="chevronLeft" size={14} color={dk.text2} /><Text style={styles.backText}>上一题</Text></Pressable> : null}
      <View style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel={last ? '提交回答' : '下一题'} accessibilityState={{ disabled: !canSubmit }} disabled={!canSubmit} onPress={proceed}
        style={({ pressed }) => [styles.submit, !canSubmit && styles.submitOff, pressed && { opacity: 0.85 }]}>
        <Text style={styles.submitText}>{last ? '提交' : '下一题'}</Text>
        <Icon name={last ? 'arrowUp' : 'chevronRight'} size={14} color={dk.onInk} strokeWidth={2.2} />
      </Pressable>
    </View>
  </View>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  card: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 9, borderRadius: 12, backgroundColor: d.accentSoft, maxWidth: '62%' },
  badgeText: { fontSize: 11.5, fontWeight: '600', color: d.accentText, flexShrink: 1 },
  steps: { flexDirection: 'row', gap: 3, alignItems: 'center' }, step: { width: 12, height: 3, borderRadius: 2, backgroundColor: d.line }, stepOn: { backgroundColor: d.ink },
  close: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface3 },
  question: { gap: 8 }, prompt: { fontSize: 15.5, lineHeight: 22, fontWeight: '600', color: d.text }, hint: { fontSize: 11.5, color: d.faint, marginTop: -4 },
  options: { gap: 6 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, borderRadius: 12, backgroundColor: d.surface2, borderWidth: 1, borderColor: 'transparent' },
  optionPressed: { backgroundColor: d.surface3 },
  selected: { backgroundColor: d.surface, borderColor: d.ink },
  optionBody: { flex: 1, minWidth: 0, gap: 2 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: d.faint, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface },
  box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: d.faint, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface },
  markOn: { borderColor: d.ink, backgroundColor: d.ink }, radioDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: d.surface },
  customOption: { backgroundColor: d.surface, borderColor: d.lineStrong, borderStyle: 'dashed' }, customMark: { width: 18, alignItems: 'center' },
  optionText: { fontSize: 14, lineHeight: 19, color: d.text }, optionTextOn: { color: d.text, fontWeight: '600' },
  detail: { fontSize: 12, lineHeight: 16, color: d.muted },
  input: { color: d.text, backgroundColor: d.surface, borderWidth: 1, borderColor: d.lineStrong, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, maxHeight: 96, fontSize: 14 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, error: { color: d.bad, fontSize: 12, flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 38, paddingHorizontal: 6 }, backText: { fontSize: 13, color: d.text2, fontWeight: '500' },
  submit: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 18, borderRadius: 19, backgroundColor: d.ink },
  submitOff: { backgroundColor: d.lineStrong }, submitText: { fontSize: 14, fontWeight: '600', color: d.onInk },
}));
