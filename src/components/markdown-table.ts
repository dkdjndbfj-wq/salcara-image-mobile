/** Keep literal/escaped pipes and code spans inside their original table cell. */
export function markdownTableCells(row: string): string[] {
  const source = row.trim();
  const cells: string[] = [];
  let cell = '';
  let codeTicks = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length) {
      const next = source[++i];
      cell += next === '|' ? next : `\\${next}`;
    } else if (char === '`') {
      let end = i + 1;
      while (source[end] === '`') end += 1;
      const ticks = end - i;
      if (codeTicks === ticks) codeTicks = 0;
      else if (!codeTicks && source.indexOf('`'.repeat(ticks), end) >= 0) codeTicks = ticks;
      cell += source.slice(i, end);
      i = end - 1;
    } else if (char === '|' && !codeTicks) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  if (source.startsWith('|')) cells.shift();
  if (cells.length && cells[cells.length - 1] === '' && source.endsWith('|')) cells.pop();
  return cells;
}
