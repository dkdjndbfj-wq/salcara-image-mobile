import { creationRequestIntent, parseCreationPlan, snapshotCreationSkill } from '../creation-skills';
import type { ReferenceImage } from '../domain';

const image: ReferenceImage = { id: 'r', uri: 'file:///reference.png', name: '参考图.png', mimeType: 'image/png', size: 128 };

test('plain attachment analysis stays chat while sending a selected skill can start creation', () => {
  expect(creationRequestIntent('分析照片', [image], [], 'auto', null)).toBe('chat');
  expect(creationRequestIntent('清晨，水彩猫咪', [], [], 'auto', snapshotCreationSkill('image-create'))).toBe('generate');
  expect(creationRequestIntent('换成水彩风', [image], [], 'auto', snapshotCreationSkill('reference-edit'))).toBe('edit');
  expect(creationRequestIntent('先分析照片，暂不生图', [image], [], 'auto', snapshotCreationSkill('reference-edit'))).toBe('chat');
  expect(creationRequestIntent('先分析照片，再生成一张活动海报', [image], [], 'auto', snapshotCreationSkill('poster-layout'))).toBe('edit');
  expect(creationRequestIntent('先分析 PDF 再生成一张活动海报', [], [], 'auto', snapshotCreationSkill('poster-layout'))).toBe('generate');
});

test('unstructured or incomplete model output cannot authorize an image charge', () => {
  for (const response of ['好的，我会生成。', '{}', '{"decision":"ready","prompt":"猫咪"}', 'null']) {
    expect(() => parseCreationPlan(response)).toThrow('尚未调用图片接口');
  }
  expect(() => parseCreationPlan(JSON.stringify({ decision: 'needs_input', question: '请提供需要修改的主图。' }))).toThrow('请提供需要修改的主图');
});

test('artistic lettering stays in the image prompt while exact text layout is clearly separated', () => {
  expect(parseCreationPlan(JSON.stringify({ decision: 'ready', prompt: '手绘艺术字“春日”', textMode: 'artistic', layoutNotes: '' })))
    .toEqual({ prompt: '手绘艺术字“春日”', notes: null });
  const plan = parseCreationPlan(JSON.stringify({ decision: 'ready', prompt: '保留艺术标题“春日”，下方留白，不出现其余文字', textMode: 'layout', layoutNotes: '底部左对齐：9 月 30 日；票价 20 元' }));
  expect(plan.notes).toContain('尚未叠加到图片');
  expect(plan.notes).toContain('9 月 30 日；票价 20 元');
  expect(plan.prompt).not.toContain('票价 20 元');
  expect(() => parseCreationPlan(JSON.stringify({ decision: 'ready', prompt: '海报底图', textMode: 'layout', layoutNotes: '' }))).toThrow('未给出排版方案');
});

test('a task owns a copy of the selected skill snapshot', () => {
  const first = snapshotCreationSkill('image-create')!;
  first.title = 'local modification';
  expect(snapshotCreationSkill('image-create')!.title).toBe('通用创作');
  expect(snapshotCreationSkill(null)).toBeNull();
});
