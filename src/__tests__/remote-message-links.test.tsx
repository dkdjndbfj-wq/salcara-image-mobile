import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';
import { MessageContent } from '../components/MessageContent';
import { BlockRow, ThreadUi } from '../remote/thread-rows';
import { inlineRemoteReference } from '../remote/remote-links';
import { OutputText } from '../remote/thread-extras';
import { buildBlocks, conversationBlocks } from '../remote/blocks';
import type { TimelineItem } from '../remote/store';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));

test('real Markdown renderer retains file paths with spaces, Windows location, task and browser links', async () => {
  const open = jest.fn();
  const view = await render(<MessageContent text={'[文件](<C:/My Project/foo (a).ts:12:5>)\n\n[任务](codex://threads/thread-1)\n\n[网站](https://example.com/docs)\n\n[括号](https://example.com/docs(topic))'} onOpenLink={open} />);
  await fireEvent.press(view.getByText('文件')); await fireEvent.press(view.getByText('任务')); await fireEvent.press(view.getByText('网站'));
  await fireEvent.press(view.getByText('括号'));
  expect(open.mock.calls.map(call => call[0])).toEqual(['C:/My Project/foo (a).ts:12:5', 'codex://threads/thread-1', 'https://example.com/docs', 'https://example.com/docs(topic)']);
});

test('table, nested bold, inline code and bare task references use the remote action without executing code', async () => {
  const open = jest.fn();
  const view = await render(<MessageContent text={'**[源码](src/main.ts#L9C2)**\n\n| 名称 |\n| --- |\n| [目录](src) |\n\n`app.ts:3` 和 `npm install`\n\ncodex://threads/thread-2'} onOpenLink={open} isInteractiveReference={inlineRemoteReference} />);
  await fireEvent.press(view.getByText('源码')); await fireEvent.press(view.getByText('目录')); await fireEvent.press(view.getByText('app.ts:3')); await fireEvent.press(view.getByText('codex://threads/thread-2'));
  expect(view.getByText('npm install').props.onPress).toBeUndefined();
  expect(open.mock.calls.map(call => call[0])).toEqual(['src/main.ts#L9C2', 'src', 'app.ts:3', 'codex://threads/thread-2']);
});

test('plain final-summary file paths are clickable while URLs remain web links', async () => {
  const open = jest.fn();
  const view = await render(<MessageContent text={'已修改 src/main.ts:12\n\n读取 C:/work/README.md#L4\n\n访问 https://example.com/docs\n\n源码网站 https://example.com/src/main.ts'} onOpenLink={open} isInteractiveReference={inlineRemoteReference} />);
  await fireEvent.press(view.getByText('src/main.ts:12'));
  await fireEvent.press(view.getByText('C:/work/README.md#L4'));
  await fireEvent.press(view.getByText('https://example.com/docs'));
  await fireEvent.press(view.getByText('https://example.com/src/main.ts'));
  expect(open.mock.calls.map(call => call[0])).toEqual(['src/main.ts:12', 'C:/work/README.md#L4', 'https://example.com/docs', 'https://example.com/src/main.ts']);
});

test('source citations go through the same action and fenced code blocks stay inert', async () => {
  const open = jest.fn();
  const view = await render(<MessageContent text={'见 [1]\n\n```ts\nhttps://example.com/not-a-link\n```'} onOpenLink={open} sources={[{ title: '资料', url: 'https://example.com/source' } as any]} />);
  await fireEvent.press(view.getByLabelText('来源 1：资料'));
  expect(open).toHaveBeenCalledWith('https://example.com/source');
  expect(view.getByText('https://example.com/not-a-link').props.onPress).toBeUndefined();
});

test('ordinary nonremote chat never forwards an arbitrary scheme or turns a code path into a link', async () => {
  const view = await render(<MessageContent text={'[危险](javascript:alert)\n\n`src/main.ts`'} />);
  expect(view.getByText('危险').props.onPress).toBeUndefined(); expect(view.getByText('src/main.ts').props.onPress).toBeUndefined();
});

test('expanded tool output exposes only explicit web links, without activating commands or local file references', async () => {
  const open = jest.fn();
  const view = await render(<OutputText text={'preview http://localhost:5173/\nsite https://example.com/docs.\napp.ts:3\nrm -rf anything'} onOpenLink={open} />);
  await fireEvent.press(view.getByText('http://localhost:5173/')); await fireEvent.press(view.getByText('https://example.com/docs'));
  expect(open.mock.calls.map(call => call[0])).toEqual(['http://localhost:5173/', 'https://example.com/docs']);
  expect(view.getAllByRole('link')).toHaveLength(2);
});

test.each(['codex', 'claude'] as const)('%s command activity opens an inline output frame without an outer fold', async tool => {
  const source: TimelineItem[] = [{ kind: 'tool', id: `${tool}:command`, tool: 'command', title: '运行 pnpm test', detail: 'pnpm test --runInBand',
    output: 'PASS 12 tests', exitCode: 0, durationMs: 4200, status: 'done', ts: 1 }];
  const [block] = conversationBlocks(buildBlocks(source, false), tool);
  expect(block).toMatchObject({ type: 'activity', collapsible: false });
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn() }}>
    <BlockRow block={block} tool={tool} onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  expect(view.queryByLabelText('展开处理摘要')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 pnpm test'));
  const output = within(view.getByTestId('command-output-frame'));
  expect(output.getByText('$ pnpm test --runInBand')).toBeTruthy();
  expect(output.getByText('PASS 12 tests')).toBeTruthy();
  expect(output.getByText('退出码 0')).toBeTruthy();
  expect(view.getByText('已在 4 秒 内运行 pnpm test')).toBeTruthy();
  expect(view.queryByLabelText('在大窗口查看命令：运行 pnpm test')).toBeNull();
  expect(view.queryByLabelText('关闭命令详情')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 pnpm test'));
  expect(view.queryByTestId('command-output-frame')).toBeNull();
  expect(view.queryByText('PASS 12 tests')).toBeNull();
});

test('inline command output retains every line beyond 120 and only output web links are actionable', async () => {
  const open = jest.fn();
  const command = 'curl https://example.com/command-only';
  const output = ['FIRST OUTPUT LINE', ...Array.from({ length: 130 }, (_, index) => `output line ${index + 1}`),
    'preview http://localhost:5173/', 'docs https://example.com/docs.', 'LAST OUTPUT LINE'].join('\n');
  const source: TimelineItem[] = [{ kind: 'tool', id: 'command:long-output', tool: 'command', title: '检查长输出',
    detail: command, output, exitCode: 0, status: 'done', ts: 1 }];
  const [block] = conversationBlocks(buildBlocks(source, false), 'codex');
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), openLink: open }}>
    <BlockRow block={block} tool="codex" onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  await fireEvent.press(view.getByLabelText('查看命令详情：检查长输出'));
  const frame = within(view.getByTestId('command-output-frame'));
  expect(frame.getByText(/FIRST OUTPUT LINE/)).toBeTruthy();
  expect(frame.getByText(/output line 65/)).toBeTruthy();
  expect(frame.getByText(/LAST OUTPUT LINE/)).toBeTruthy();
  expect(frame.queryByText(/只显示最后 120 行/)).toBeNull();
  const commandText = frame.getByText(`$ ${command}`);
  expect(commandText.props.onPress).toBeUndefined();
  await fireEvent.press(commandText);
  expect(open).not.toHaveBeenCalled();
  expect(frame.getAllByRole('link')).toHaveLength(2);
  await fireEvent.press(frame.getByText('http://localhost:5173/'));
  await fireEvent.press(frame.getByText('https://example.com/docs'));
  expect(open.mock.calls).toEqual([['http://localhost:5173/', true], ['https://example.com/docs', true]]);
});

test.each(['codex', 'claude'] as const)('%s groups multiple commands while keeping each command independently inspectable', async tool => {
  const source: TimelineItem[] = [
    { kind: 'tool', id: `${tool}:command-1`, tool: 'command', title: '运行 pnpm lint', detail: 'pnpm lint', status: 'done', ts: 1 },
    { kind: 'tool', id: `${tool}:command-2`, tool: 'command', title: '运行 pnpm test', detail: 'pnpm test', status: 'done', ts: 2 },
  ];
  const [block] = conversationBlocks(buildBlocks(source, false), tool);
  expect(block).toMatchObject({ type: 'activity', collapsible: true });
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn() }}>
    <BlockRow block={block} tool={tool} onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  expect(view.getByLabelText('查看命令详情：运行 pnpm lint')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 pnpm test'));
  expect(view.getByText('$ pnpm test')).toBeTruthy();
  expect(view.queryByText('pnpm lint')).toBeNull();
});

test.each(['codex', 'claude'] as const)('%s preserves an individually expanded command when its final reply arrives', async tool => {
  const source: TimelineItem[] = [
    { kind: 'tool', id: `${tool}:lint`, tool: 'command', title: '运行 pnpm lint', detail: 'pnpm lint', status: 'running', ts: 1 },
    { kind: 'tool', id: `${tool}:test`, tool: 'command', title: '运行 pnpm test', detail: 'pnpm test', status: 'running', ts: 2 },
  ];
  const renderBlock = (items: TimelineItem[]) => {
    const [block] = conversationBlocks(buildBlocks(items, items.some(item => item.kind === 'tool' && item.status === 'running')), tool);
    return <ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn() }}>
      <BlockRow block={block} tool={tool} onOpenChild={jest.fn()} />
    </ThreadUi.Provider>;
  };
  const view = await render(renderBlock(source));
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 pnpm test'));
  expect(view.getByText('$ pnpm test')).toBeTruthy();
  expect(view.getByLabelText('查看命令详情：运行 pnpm test')).toBeTruthy();

  const complete: TimelineItem[] = [
    ...source.map(item => item.kind === 'tool' ? { ...item, status: 'done' as const, durationMs: 1200 } : item),
    { kind: 'message', id: `${tool}:reply`, role: 'assistant', text: '已完成，测试通过。', final: true, ts: 3 },
  ];
  const blocks = conversationBlocks(buildBlocks(complete, false), tool);
  expect(blocks.map(block => block.type)).toEqual(['activity', 'assistant']);
  await view.rerender(renderBlock(complete));
  expect(view.queryByLabelText('展开处理摘要')).toBeNull();
  expect(view.getByText('$ pnpm test')).toBeTruthy();
  expect(view.queryByLabelText('收起处理摘要')).toBeNull();
  expect(view.queryByText('运行 pnpm test')).toBeNull();
});

test.each(['codex', 'claude'] as const)('%s thinking-only progress is live text, not an empty fold control', async tool => {
  const source: TimelineItem[] = [{ kind: 'reasoning', id: `${tool}:reasoning`, text: 'Checking the next change', final: false, ts: 1 }];
  const [block] = conversationBlocks(buildBlocks(source, true), tool);
  const view = await render(<BlockRow block={block} tool={tool} onOpenChild={jest.fn()} />);
  expect(view.getByText('正在思考 · Checking the next change')).toBeTruthy();
  expect(view.queryByLabelText('展开处理摘要')).toBeNull();
});

test('changed file cards expose an accessible action and route the exact diff to the tool panel', async () => {
  const openDiff = jest.fn();
  const source: TimelineItem[] = [{ kind: 'tool', id: 'edit', tool: 'file_change', title: '修改 src/app.ts', detail: 'src/app.ts',
    diff: '--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new', status: 'done', ts: 1 },
    { kind: 'turn', id: 'edit-complete', status: 'completed', ts: 2 }];
  const blocks = conversationBlocks(buildBlocks(source, false), 'codex');
  const view = await render(<ThreadUi.Provider value={{ openDiff, openImage: jest.fn(), requestAttachment: jest.fn(), openLink: jest.fn() }}>
    {blocks.map(block => <BlockRow key={block.id} block={block} tool="codex" onOpenChild={jest.fn()} />)}
  </ThreadUi.Provider>);
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
  expect(view.getByRole('button', {name: '查看修改文件 src/app.ts'})).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看修改文件 src/app.ts'));
  expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/app.ts', diff: expect.stringContaining('-old') }));
  expect(view.queryByText('-old')).toBeNull();
});

test('searching an older thought temporarily reveals that one folded progress item', async () => {
  const source: TimelineItem[] = [
    { kind: 'reasoning', id: 'old-thought', text: 'Earlier we found the failing assertion', final: true, ts: 1 },
    { kind: 'reasoning', id: 'latest-thought', text: 'Now verify the fix', final: true, ts: 2 },
  ];
  const [block] = conversationBlocks(buildBlocks(source, false), 'claude');
  const view = await render(<BlockRow block={block} tool="claude" onOpenChild={jest.fn()} searchQuery="failing assertion" />);
  expect(view.getByText('思考摘要 · Earlier we found the failing assertion')).toBeTruthy();
  expect(view.queryByText('思考摘要 · Now verify the fix')).toBeNull();
});

test('main assistant links carry exact session provenance to the action', async () => {
  const open = jest.fn();
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), openLink: open }}>
    <BlockRow block={{ type: 'assistant', id: 'm', item: { kind: 'message', id: 'm', role: 'assistant', text: '[文件](src/main.ts:4)', ts: 1, final: true } }} tool="codex" onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  await fireEvent.press(view.getByText('文件')); expect(open).toHaveBeenCalledWith('src/main.ts:4', true);
});

test('nested child replies never claim the parent project as their own file scope', async () => {
  const open = jest.fn();
  const part: any = { type: 'subagent', id: 'spawn', item: { kind: 'tool', id: 'spawn', tool: 'subagent', title: '审查', status: 'done', ts: 1, childSessionKeys: ['codex:child'] }, children: [{ kind: 'message', id: 'child-message', role: 'assistant', text: '[子文件](src/child.ts)', ts: 2, final: true, parentId: 'spawn' }] };
  const block: any = { type: 'activity', id: 'activity', parts: [part], files: [], live: false, summary: '处理摘要', subagentCount: 1 };
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), openLink: open }}><BlockRow block={block} tool="codex" onOpenChild={jest.fn()} /></ThreadUi.Provider>);
  await fireEvent.press(view.getByLabelText('审查：子任务详情'));
  await fireEvent.press(view.getByText('子文件')); expect(open).toHaveBeenCalledWith('src/child.ts', false);
});

test.each(['codex', 'claude'] as const)('%s shows skill use and read activity in the conversation work summary', async tool => {
  const source: TimelineItem[] = [
    { kind: 'tool', id: `${tool}:skill`, tool: 'skill', title: '使用技能 · review', detail: '检查错误处理', status: 'done', ts: 1 },
    { kind: 'tool', id: `${tool}:read`, tool: 'read', title: '读取 src/main.ts', detail: 'src/main.ts', output: '文件内容', status: 'done', ts: 2 },
  ];
  const [block] = conversationBlocks(buildBlocks(source, false), tool);
  expect(block).toMatchObject({ type: 'activity', summary: '查看了 1 处 · 使用了 1 项技能', collapsible: true });
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), openLink: jest.fn() }}>
    <BlockRow block={block} tool={tool} onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  expect(view.getByText('使用技能 · review')).toBeTruthy();
  await fireEvent.press(view.getByText('已读取 src/main.ts'));
  await fireEvent.press(view.getByLabelText('打开已读取文件 src/main.ts'));
  expect(view.getByText('文件内容')).toBeTruthy();
});

test.each(['codex', 'claude'] as const)('%s shows an explicit interrupted child status', async tool => {
  const child: any = { type: 'subagent', id: 'child', item: { kind: 'tool', id: 'child', tool: 'subagent', title: '修复任务', status: 'interrupted', output: '被中断', childSessionKeys: [`${tool}:child`], ts: 1 }, children: [] };
  const block: any = { type: 'activity', id: 'activity', parts: [child], files: [], live: false, summary: '子任务', subagentCount: 1, collapsible: false };
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn() }}>
    <BlockRow block={block} tool={tool} onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  expect(view.getByText('修复任务 · 被中断')).toBeTruthy();
});
