import React from 'react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react-native';

import { AgentBrand } from '../remote/AgentBrand';
import { ToolBadge } from '../remote/parts';

jest.mock('../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => {
    const React = require('react'); const { View } = require('react-native');
    return React.createElement(View, { testID: `neutral-icon-${name}` });
  },
}));

describe('official Agent icons', () => {
  test.each([
    ['codex-app-official.png', '8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e'],
    ['claude-app-official.png', '28f6dfd7bc66bffe9ac40dac94dc90b7bae9b4a60b123f687c90ab2b86a63eb0'],
  ])('preserves the original official bytes of %s', (filename, digest) => {
    const bytes = readFileSync(resolve(__dirname, '../../assets/agent-brand', filename));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
  });

  test('Codex uses the official local PNG, not a fabricated terminal logo', async () => {
    const view = await render(<AgentBrand tool="codex" size={44} />);
    const icon = view.getByLabelText('Codex');
    expect(icon.props.source).toEqual(require('../../assets/agent-brand/codex-app-official.png'));
    expect(icon).toHaveStyle({ width: 44, height: 44 });
    expect(icon.props.resizeMode).toBe('contain');
    expect(view.queryByText('>_')).toBeNull();
    expect(view.queryByTestId('neutral-icon-terminal')).toBeNull();
    expect(icon.props.style.tintColor).toBeUndefined();
  });

  test('Claude Code and Desktop preserve the same official mark and use distinct labels', async () => {
    const code = await render(<AgentBrand tool="claude" size={36} />);
    const desktop = await render(<AgentBrand tool="claude" client="Claude Desktop" size={36} />);
    const codeIcon = code.getByLabelText('Claude Code');
    const desktopIcon = desktop.getByLabelText('Claude Desktop');
    expect(codeIcon.props.source).toEqual(require('../../assets/agent-brand/claude-app-official.png'));
    expect(desktopIcon.props.source).toEqual(codeIcon.props.source);
    expect(desktopIcon.props.style).toEqual(codeIcon.props.style);
    expect(desktopIcon.props.style.borderColor).toBeUndefined();
    expect(desktopIcon.props.style.tintColor).toBeUndefined();
  });

  test('ToolBadge retains the existing props and default size', async () => {
    const view = await render(<ToolBadge tool="claude" client="Claude Desktop" />);
    expect(view.getByLabelText('Claude Desktop')).toHaveStyle({ width: 36, height: 36 });
  });

  test('an unknown tool gets a neutral tool icon, not Claude branding', async () => {
    const view = await render(<AgentBrand tool="future-agent" size={28} />);
    expect(view.getByLabelText('future-agent')).toHaveStyle({ width: 28, height: 28 });
    expect(view.getByTestId('neutral-icon-terminal')).toBeTruthy();
    expect(view.queryByTestId('agent-brand-claude')).toBeNull();
    expect(view.queryByTestId('agent-brand-codex')).toBeNull();
  });
});
