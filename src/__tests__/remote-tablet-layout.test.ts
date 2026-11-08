import { defaultTabletLayout, revealTabletPane, solveTabletColumns } from '../remote/TabletThreadFrame';

describe('tablet thread columns', () => {
  test.each([1194, 1280])('new layouts leave at least 450px of prose at %ipx without discarding saved widths', width => {
    const columns = solveTabletColumns(width, defaultTabletLayout(width));
    expect(columns.center - 48).toBeGreaterThanOrEqual(450);
    expect(columns.workspace).toBeGreaterThanOrEqual(300);
    expect(columns.sidebarCollapsed).toBe(false);
    expect(solveTabletColumns(1280, { sidebar: 300, workspace: 480 }).workspace).toBe(480);
  });
  test('keeps all three columns at the 1194px reference size', () => {
    const columns = solveTabletColumns(1194, { sidebar: 280, workspace: 520 });

    expect(columns).toMatchObject({ sidebar: 280, workspace: 490, center: 400, sidebarCollapsed: false, workspaceCollapsed: false });
    expect(columns.sidebar + columns.center + columns.workspace + 24).toBe(1194);
  });

  test('uses the compact navigation rail while retaining the work area at 1024px', () => {
    const columns = solveTabletColumns(1024, { sidebar: 280, workspace: 460 });

    expect(columns).toMatchObject({ sidebar: 56, workspace: 460, center: 496, sidebarCollapsed: true, workspaceCollapsed: false });
    expect(columns.sidebar + columns.center + columns.workspace + 12).toBe(1024);
  });

  test('keeps the middle column above its minimum when the work area is collapsed', () => {
    const columns = solveTabletColumns(1000, { sidebar: 350, workspace: 420, sidebarCollapsed: false, workspaceCollapsed: true });

    expect(columns).toMatchObject({ sidebar: 350, workspace: 0, center: 638, sidebarCollapsed: false, workspaceCollapsed: true });
    expect(columns.sidebar + columns.center + 12).toBe(1000);
  });

  test('hides the work area when it cannot fit with the minimum conversation width', () => {
    const columns = solveTabletColumns(1000, { sidebar: 280, workspace: 420, sidebarCollapsed: false });

    expect(columns.workspace).toBe(0);
    expect(columns.center).toBeGreaterThanOrEqual(400);
    expect(columns.sidebar + columns.center + 12).toBe(1000);
  });
});


test('opening the workspace at 1000px folds navigation so the action always reveals content', () => {
  const prefs = { sidebar: 280, workspace: 420, sidebarCollapsed: false, workspaceCollapsed: true };
  const opened = revealTabletPane(1000, prefs, 'workspace');
  expect(opened.sidebarCollapsed).toBe(true);
  expect(solveTabletColumns(1000, opened).workspace).toBeGreaterThanOrEqual(300);
});
