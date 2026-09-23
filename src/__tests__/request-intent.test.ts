import { inferRequestIntent, isAnalysisPrompt } from '../request-intent';

const image = [{ id: 'i', uri: 'file:///示意.png', name: '示意.png', mimeType: 'image/png' as const, size: 10 }];
const pdf = [{ id: 'd', uri: 'file:///方案.pdf', name: '方案.pdf', mimeType: 'application/pdf', size: 10 }];

test('auto mode keeps an illustrative image in chat when no creation intent is present', () => {
  expect(inferRequestIntent('请分析这张图片，告诉我构图和颜色', image, [], 'auto')).toBe('chat');
  expect(inferRequestIntent('这张图只是示意，请描述它', image, [], 'auto')).toBe('chat');
  expect(isAnalysisPrompt('请分析这张图片')).toBe(true);
  expect(inferRequestIntent('这个模型可以生成什么？', [], [], 'auto')).toBe('chat');
  expect(inferRequestIntent('请分析这个图标的含义', image, [], 'auto')).toBe('chat');
  expect(inferRequestIntent('请告诉我如何生成图片', [], [], 'auto')).toBe('chat');
});

test('auto mode edits only when the prompt explicitly asks for image creation', () => {
  expect(inferRequestIntent('参考这张图生成一张宣传海报', image, [], 'auto')).toBe('edit');
  expect(inferRequestIntent('把背景换成蓝色', image, [], 'auto')).toBe('edit');
  expect(inferRequestIntent('把这张图变成赛博朋克风格', image, [], 'auto')).toBe('edit');
  expect(inferRequestIntent('将背景改成蓝色', image, [], 'auto')).toBe('edit');
  expect(inferRequestIntent('把这个改成复古海报', image, [], 'auto')).toBe('edit');
  expect(inferRequestIntent('参考这个示意图的风格创作一张新图', image, [], 'auto')).toBe('edit');
  expect(inferRequestIntent('来一张适合手机壁纸的夜景', [], [], 'auto')).toBe('generate');
  expect(inferRequestIntent('请按这份 PDF 生成一张封面', [], pdf, 'auto')).toBe('generate');
});

test('image workflow questions stay in chat and do not spend a generation credit', () => {
  expect(inferRequestIntent('帮我生成图片提示词', [], [], 'auto')).toBe('chat');
  expect(inferRequestIntent('生成图片需要什么参数', [], [], 'auto')).toBe('chat');
  expect(inferRequestIntent('如何生成图片', [], [], 'auto')).toBe('chat');
  expect(inferRequestIntent('你能生成图片吗？', [], [], 'auto')).toBe('chat');
  expect(inferRequestIntent('这个模型支持哪些图片尺寸？', [], [], 'auto')).toBe('chat');
});

test('attachments alone are never a paid image request', () => {
  expect(inferRequestIntent('请总结这份文件', [], pdf, 'auto')).toBe('chat');
  expect(inferRequestIntent('', image, [], 'auto')).toBe('chat');
});

test('manual modes remain deterministic overrides', () => {
  expect(inferRequestIntent('请分析图片', image, [], 'image')).toBe('edit');
  expect(inferRequestIntent('生成一张海报', [], [], 'chat')).toBe('chat');
});
