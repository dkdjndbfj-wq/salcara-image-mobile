import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { applySlashCommand, buildSlashCommands, parseSlashQuery, slashCommandDisabled, type SlashActionEntry } from '../remote/slash-commands';
import { SlashCommandMenu } from '../remote/SlashCommandMenu';
import type { AgentFeatures } from '../remote/agent-features';

const mockPresses = new Map<string, () => void>();
jest.mock('react-native', () => {
  const React = require('react'), native = jest.requireActual('react-native');
  return Object.create(Object.getPrototypeOf(native), { ...Object.getOwnPropertyDescriptors(native), Pressable: { configurable: true, enumerable: true,
    value: React.forwardRef((props: any, ref: any) => {
      if (props.accessibilityLabel) mockPresses.set(props.accessibilityLabel, props.onPress);
      return React.createElement(native.Pressable, { ...props, ref });
    }) } });
});
beforeEach(() => mockPresses.clear());

const features: AgentFeatures = { collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [
  { name: 'review', path: '/workspace/a/SKILL.md', displayName: '审查代码', description: 'Review changes and regression risk' },
  { name: 'review', path: '/workspace/b/SKILL.md', description: 'Review documentation' },
  { name: 'plugin:test', description: '运行测试和检查' },
  { name: 'plan', path: '/workspace/planner/SKILL.md', description: 'A skill sharing a native mode name' },
] };
const query = (text: string, caret = text.length) => {
  const parsed = parseSlashQuery(text, caret);
  if (!parsed) throw new Error(`missing slash query for ${text}`);
  return parsed;
};

it('opens slash or dollar commands at whitespace boundaries before the caret, without consuming later text', () => {
  for (const text of ['', 'hello/plan', '//server/share', 'https://example.com']) expect(parseSlashQuery(text)).toBeUndefined();
  expect(query('/').query).toBe('');
  expect(query('hello /PLAN implement this', 11)).toMatchObject({ query: 'PLAN', trigger: '/', skillsOnly: false, replaceStart: 6, remainder: ' implement this' });
  expect(query('first\n/plan')).toMatchObject({ query: 'plan', replaceStart: 6 });
  expect(query('/plan implement this')).toMatchObject({ query: 'plan implement this' });
  expect(query('/skills review risk\nkeep task', 19)).toMatchObject({ query: 'review risk', skillsOnly: true, remainder: '\nkeep task' });
  expect(query('hello $review')).toMatchObject({ query: 'review', trigger: '$', skillsOnly: true });
  expect(parseSlashQuery('/plan', -1)).toBeUndefined();
});

it('lists only advertised modes and skills, supports Chinese aliases and multiword skills search', () => {
  expect(buildSlashCommands(undefined, query('/'))).toEqual([]);
  expect(buildSlashCommands({ collaborationModes: ['default'], skills: features.skills, skillsSupported: false }, query('/'))).toEqual([]);
  expect(buildSlashCommands(features, query('/计划')).map(item => item.id)).toEqual(['mode:plan']);
  expect(buildSlashCommands(features, query('/测试')).map(item => item.command)).toEqual(['/plugin:test']);
  expect(buildSlashCommands(features, query('/skills review risk')).map(item => item.skill?.path)).toEqual(['/workspace/a/SKILL.md']);
  expect(buildSlashCommands(features, query('/skills')).every(item => item.kind === 'skill')).toBe(true);
  expect(buildSlashCommands(features, query('$')).every(item => item.kind === 'skill')).toBe(true);
  expect(buildSlashCommands(features, query('/default'))).toEqual([]);
});

it('uses one plan command to toggle the current mode and only exposes supported transitions', () => {
  expect(buildSlashCommands(features, query('/计划'), 'default')[0]).toMatchObject({ id: 'mode:plan', mode: 'plan', description: '开启计划模式' });
  expect(buildSlashCommands(features, query('/计划'), 'plan')[0]).toMatchObject({ id: 'mode:plan', mode: 'default', description: '关闭计划模式' });
  expect(buildSlashCommands({ ...features, collaborationModes: ['plan'] }, query('/计划'), 'plan')).toEqual([]);
});

it('offers native compact only with explicit capability, separately from same-name skills', () => {
  const catalog = { ...features, skills: [{ name: 'compact', description: 'custom skill' }] };
  expect(buildSlashCommands(catalog, query('/compact')).map(entry => entry.kind)).toEqual(['skill']);
  const all = buildSlashCommands(catalog, query('/compact'), undefined, true);
  expect(all.map(entry => entry.kind)).toEqual(['compact', 'skill']);
  expect(buildSlashCommands(catalog, query('$compact'), undefined, true).map(entry => entry.kind)).toEqual(['skill']);
  expect(applySlashCommand('before /compact after', query('before /compact after', 15), all[0])).toBe('before  after');
});

it('keeps mode, skill and same-name paths distinct and deduplicates only identical references', () => {
  const all = buildSlashCommands({ ...features, skills: [...features.skills, features.skills[0]] }, query('/'));
  expect(new Set(all.map(item => item.id)).size).toBe(all.length);
  const reviews = all.filter(item => item.command === '/review');
  expect(reviews).toHaveLength(2);
  expect(reviews.map(item => item.pathLabel)).toEqual(['/workspace/a/SKILL.md', '/workspace/b/SKILL.md']);
  expect(all.filter(item => item.command === '/plan').map(item => item.kind)).toEqual(['mode', 'skill']);
  expect(reviews[0].skill).not.toBe(features.skills[0]);
});

it('preserves body text and indentation while selecting commands, without appending a send action', () => {
  for (const [text, caret, expected] of [
    ['/plan fix it\n  preserve indentation', 5, ' fix it\n  preserve indentation'],
    ['/plan\r\n  preserve indentation', 5, '\r\n  preserve indentation'],
    ['before /review after', 14, 'before  after'],
    ['/skills review\nexisting task', 14, '\nexisting task'],
  ] as const) {
    const parsed = query(text, caret), entry = buildSlashCommands(features, parsed)[0];
    expect(applySlashCommand(text, parsed, entry)).toBe(expected);
  }
  const browse = buildSlashCommands(features, query('/')).find(item => item.kind === 'skills')!;
  expect(applySlashCommand('/', query('/'), browse)).toBe('/skills ');
  expect(applySlashCommand('/plan keep task', query('/plan keep task', 5), browse)).toBe('/skills  keep task');
});

it('does not apply a queued selection to a newer composer edit', () => {
  const parsed = query('/plan old task', 5), entry = buildSlashCommands(features, parsed)[0];
  expect(applySlashCommand('/plan new task', parsed, entry)).toBe('/plan new task');
  expect(applySlashCommand('new ordinary text', parsed, entry)).toBe('new ordinary text');
});

it('renders distinguishable accessible selections and preserves the input keyboard', async () => {
  const entries = buildSlashCommands(features, query('/review')), onSelect = jest.fn(), onClose = jest.fn(), onReload = jest.fn();
  const view = await render(<SlashCommandMenu entries={entries} selectedId={entries[0].id} onSelect={onSelect} onClose={onClose} onReload={onReload} />);
  const second = view.getByRole('button', { name: '选择技能 review，/review，/workspace/b/SKILL.md' });
  await fireEvent.press(second);
  expect(onSelect).toHaveBeenCalledWith(entries[1]);
  expect(view.getByText('/workspace/a/SKILL.md')).toBeTruthy();
  expect(view.getByTestId('remote-slash-command-list').props.keyboardShouldPersistTaps).toBe('handled');
  await fireEvent.press(view.getByRole('button', { name: '关闭快捷命令' }));
  await fireEvent.press(view.getByRole('button', { name: '重新读取快捷命令' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onReload).toHaveBeenCalledTimes(1);
});

it.each([{ disabled: true }, { loading: true }, { error: '目录已失效，请刷新' }])('prevents stale selection while unavailable: %p', async state => {
  const entries = buildSlashCommands(features, query('/计划')), onSelect = jest.fn();
  const view = await render(<SlashCommandMenu entries={entries} onSelect={onSelect} onClose={jest.fn()} onReload={jest.fn()} {...state} />);
  await fireEvent.press(view.getByRole('button', { name: '选择计划模式，/plan' }));
  expect(onSelect).not.toHaveBeenCalled();
});

const actions: SlashActionEntry[] = [
  { action: 'model', label: '模型', command: '/model', description: '选择模型', submenu: true },
  { action: 'reasoning', label: '推理', command: '/reasoning', description: 'Ultra', submenu: true },
  { action: 'new', label: '新聊天', command: '/new', description: '在当前项目新建聊天' },
  { action: 'fork', label: '创建聊天分支', command: '/fork', description: '为此聊天创建分支', disabledReason: '当前会话不支持分支' },
];

it('keeps local commands and explicit compact capability independent from the feature catalogue', () => {
  const entries = buildSlashCommands(undefined, query('/'), undefined, true, actions);
  expect(entries.map(entry => entry.id)).toEqual(['action:model', 'action:reasoning', 'action:new', 'action:fork', 'context:compact']);
  expect(entries[0]).toMatchObject({ kind: 'action', action: 'model', submenu: true });
  expect(entries[3]).toMatchObject({ disabled: true, disabledReason: '当前会话不支持分支' });
  expect(buildSlashCommands(features, query('/思考'), undefined, false, actions).map(entry => entry.id)).toEqual(['action:reasoning']);
  expect(buildSlashCommands(features, query('/effort'), undefined, false, actions).map(entry => entry.id)).toEqual(['action:reasoning']);
  expect(buildSlashCommands(features, query('/分支'), undefined, false, actions).map(entry => entry.id)).toEqual(['action:fork']);
  expect(buildSlashCommands(features, query('/MODEL'), undefined, false, actions).map(entry => entry.id)).toEqual(['action:model']);
});

it('does not invent actions, preserves distinct same-name skills, and rejects unknown or duplicate action routes', () => {
  const malformed = [actions[0], actions[0], { ...actions[0], action: 'unsupported' }, { ...actions[2], command: '/new unsafe' }] as SlashActionEntry[];
  const entries = buildSlashCommands({ collaborationModes: [], skillsSupported: true, skills: [{ name: 'model', description: 'custom model helper' }] }, query('/model'), undefined, false, malformed);
  expect(entries.map(entry => entry.kind)).toEqual(['action', 'skill']);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
  expect(buildSlashCommands(undefined, query('/'))).toEqual([]);
  for (const input of ['$model', '/skills model']) expect(buildSlashCommands(features, query(input), undefined, true, actions)).toEqual([]);
  expect(buildSlashCommands(features, query('/skills'), undefined, true, actions).every(entry => entry.kind === 'skill')).toBe(true);
});

it('disabled native choices cannot consume or change the draft', () => {
  const entry = buildSlashCommands(undefined, query('/fork'), undefined, false, actions)[0];
  const text = 'keep /fork remainder', parsed = query(text, 10);
  expect(slashCommandDisabled(entry)).toBe(true);
  expect(applySlashCommand(text, parsed, entry)).toBe(text);
  const model = buildSlashCommands(undefined, query('/model'), undefined, false, actions)[0];
  expect(applySlashCommand('keep /model remainder', query('keep /model remainder', 11), model)).toBe('keep  remainder');
});

it.each([{ loading: true }, { error: '技能目录不可用' }])('local actions remain selectable while the catalogue is unavailable: %p', async state => {
  const entries = buildSlashCommands(features, query('/'), undefined, true, actions), onSelect = jest.fn();
  const view = await render(<SlashCommandMenu entries={entries} onSelect={onSelect} onClose={jest.fn()} onReload={jest.fn()} {...state} />);
  await fireEvent.press(view.getByRole('button', { name: '选择模型，/model' }));
  expect(onSelect).toHaveBeenLastCalledWith(entries[0]);
  await fireEvent.press(view.getByRole('button', { name: '选择压缩上下文，/compact' }));
  expect(onSelect).toHaveBeenLastCalledWith(entries.find(entry => entry.kind === 'compact'));
  await fireEvent.press(view.getByRole('button', { name: '选择计划模式，/plan' }));
  expect(onSelect).toHaveBeenCalledTimes(2);
  await fireEvent.press(view.getByRole('button', { name: '选择创建聊天分支，/fork' }));
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(view.getByRole('button', { name: '选择创建聊天分支，/fork' }).props.accessibilityHint).toBe('当前会话不支持分支');
});

it('a retained action cannot execute after its capability disappears, becomes disabled, or the menu unmounts', async () => {
  const entries = buildSlashCommands(undefined, query('/'), undefined, false, actions), onSelect = jest.fn();
  const props = { entries, onSelect, onClose: jest.fn(), onReload: jest.fn() };
  const view = await render(<SlashCommandMenu {...props} />);
  const selected = mockPresses.get('选择模型，/model')!;
  await view.rerender(<SlashCommandMenu {...props} disabled />);
  await act(async () => selected()); expect(onSelect).not.toHaveBeenCalled();
  await view.rerender(<SlashCommandMenu {...props} entries={entries.slice(1)} />);
  await act(async () => selected()); expect(onSelect).not.toHaveBeenCalled();
  await view.rerender(<SlashCommandMenu {...props} />);
  const last = mockPresses.get('选择模型，/model')!;
  await view.unmount(); await act(async () => last()); expect(onSelect).not.toHaveBeenCalled();
});
