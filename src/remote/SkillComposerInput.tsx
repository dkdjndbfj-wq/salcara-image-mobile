import React, { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import { findNodeHandle, StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';
import { reconcileSkillMentions, type SkillMention, type SkillMentionEdit } from './skill-mentions';
import { editSkillPresentation, skillComposerPresentation, skillDisplayOffset, skillSourceOffset } from './skill-composer-presentation';
import { skillMentionColor, useSkillMentionColor } from './skill-appearance';
import { nativeSkillInput } from './skill-input-native';
import { skillDisplayName } from './skill-display-metadata';

export type SkillComposerInputProps = TextInputProps & { value: string; mentions: SkillMention[]; onSkillEdit?: (edit: SkillMentionEdit) => void; onPasteText?: (text: string, start: number, end: number) => boolean };

/** Attributed TextInput keeps the native keyboard and selection.
 * The owning composer reconciles edits and removes a mention atomically. */
export const SkillComposerInput = forwardRef<TextInput, SkillComposerInputProps>(function SkillComposerInput({ value, mentions, onSkillEdit, onPasteText: _onPasteText, ...props }, ref) {
  const color = useSkillMentionColor();
  const input = useRef<TextInput | null>(null);
  const revision = useRef(0), currentValue = useRef(value); currentValue.current = value;
  const [measurement, setMeasurement] = useState<{ value: string; height: number }>();
  const flatStyle=StyleSheet.flatten(props.style),minHeight=typeof flatStyle?.minHeight==='number'?flatStyle.minHeight:52,maxHeight=typeof flatStyle?.maxHeight==='number'?flatStyle.maxHeight:180;
  const [contentHeight,setContentHeight]=useState(minHeight);
  useLayoutEffect(()=>{if(!value)setContentHeight(minHeight);},[value,minHeight]);
  const measured=mentions.length&&measurement?.value===value?measurement.height:contentHeight;
  const inputStyle=[props.style,props.multiline?{height:Math.max(minHeight,Math.min(maxHeight,measured))}:undefined];
  const onContentSizeChange:TextInputProps['onContentSizeChange']=event=>{
    const height=event.nativeEvent.contentSize.height;
    if(Number.isFinite(height)&&height>0)setContentHeight(Math.ceil(height));
    props.onContentSizeChange?.(event);
  };
  const inputRef = (node: TextInput | null) => { input.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; };
  const sync = () => {
    if (!nativeSkillInput || !input.current) return;
    const tag = findNodeHandle(input.current); if (tag === null) return;
    const request = ++revision.current;
    void nativeSkillInput.setMentions(tag, value, mentions.map(mention => ({ start: mention.start, end: mention.end,
      name: mention.skill.name, label: skillDisplayName(mention.skill), color: skillMentionColor(color, mention.skill.brandColor), iconSmall: mention.skill.iconSmall }))).then(result => {
      if (input.current && currentValue.current === value && revision.current === request && result && Number.isFinite(result.height) && result.height > 0)
        setMeasurement(previous => previous?.value === value && previous.height === result.height ? previous : { value, height: result.height });
    }).catch(() => {});
  };
  useLayoutEffect(sync, [value, mentions, color]);
  if (nativeSkillInput) return <TextInput {...props} ref={inputRef} value={value}
    accessibilityValue={{ text: skillComposerPresentation(value, mentions).text }}
    style={inputStyle} onContentSizeChange={onContentSizeChange}
    onLayout={event => { sync(); props.onLayout?.(event); }}
    onChangeText={text => { const edit = reconcileSkillMentions(value, text, mentions); if (onSkillEdit) onSkillEdit(edit); else props.onChangeText?.(edit.text); }} />;
  if (!mentions.length) return <TextInput {...props} ref={ref} value={value} style={inputStyle} onContentSizeChange={onContentSizeChange} />;
  const presentation = skillComposerPresentation(value, mentions);
  const runs: React.ReactNode[] = [];
  let offset = 0;
  for (const mention of presentation.mentions) {
    runs.push(presentation.text.slice(offset, mention.start));
    runs.push(<Text key={`${mention.start}:${mention.skill.path ?? mention.skill.name}`} style={{ color: skillMentionColor(color, mention.skill.brandColor), fontWeight: '500' }}>{presentation.text.slice(mention.start, mention.end)}</Text>);
    offset = mention.end;
  }
  runs.push(presentation.text.slice(offset));
  return <TextInput {...props} ref={ref} accessibilityValue={{ text: value }} style={inputStyle} onContentSizeChange={onContentSizeChange}
    selection={props.selection ? { start: skillDisplayOffset(presentation, props.selection.start), end: skillDisplayOffset(presentation, props.selection.end ?? props.selection.start) } : undefined}
    onSelectionChange={event => props.onSelectionChange?.({ ...event, nativeEvent: { ...event.nativeEvent, selection: {
      start: skillSourceOffset(presentation, event.nativeEvent.selection.start), end: skillSourceOffset(presentation, event.nativeEvent.selection.end),
    } } })}
    onChangeText={text => { const edit = editSkillPresentation(value, presentation, text); if (onSkillEdit) onSkillEdit(edit); else props.onChangeText?.(edit.text); }}><Text>{runs}</Text></TextInput>;
});
