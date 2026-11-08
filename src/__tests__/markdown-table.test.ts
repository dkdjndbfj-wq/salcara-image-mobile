import { markdownTableCells } from '../components/markdown-table';

test('shell commands and union types keep their pipes inside a table cell', () => {
  expect(markdownTableCells('| 示例 | `cat log | head` |')).toEqual(['示例', '`cat log | head`']);
  expect(markdownTableCells('| 类型 | `string | null` | 说明 |')).toEqual(['类型', '`string | null`', '说明']);
});

test('escaped pipes do not create columns and other escapes stay intact', () => {
  expect(markdownTableCells('| A\\|B | C |')).toEqual(['A|B', 'C']);
  expect(markdownTableCells('| `A\\|B` | C:\\Users |')).toEqual(['`A|B`', 'C:\\Users']);
  expect(markdownTableCells('| A\\\\| B |')).toEqual(['A\\\\', 'B']);
});

test('code spans with inner backticks and incomplete markdown preserve column boundaries', () => {
  expect(markdownTableCells('| ``a` | b`` | c |')).toEqual(['``a` | b``', 'c']);
  expect(markdownTableCells('| `unfinished | other |')).toEqual(['`unfinished', 'other']);
  expect(markdownTableCells('| | value | |')).toEqual(['', 'value', '']);
});
