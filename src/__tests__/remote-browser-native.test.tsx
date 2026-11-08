import React from 'react';
import { render } from '@testing-library/react-native';
import { RemoteDemoBrowser } from '../remote/RemoteDemoBrowser';

jest.mock('react-native-webview', () => {
  const React = require('react'), { View } = require('react-native');
  return { WebView: (props: Record<string, unknown>) => React.createElement(View, { ...props, testID: 'native-browser' }) };
});

test('native browser validates all navigation and popup URLs before WebView or Linking can handle them', async () => {
  const error = jest.fn(), open = jest.fn(), navigate = jest.fn();
  const view = await render(<RemoteDemoBrowser uri="https://example.com/" onError={error} onOpenNew={open} onNavigate={navigate} />);
  const props = view.getByTestId('native-browser').props;
  expect(props.originWhitelist).toEqual(['*']);
  for (const url of ['https://example.com/next', 'http://192.168.1.2:3000/']) expect(props.onShouldStartLoadWithRequest({ url })).toBe(true);
  for (const url of ['javascript:alert(1)', 'file:///secret', 'data:text/html,test', 'intent://test', 'https://user:secret@example.com/', 'http://localhost:3000/', 'http://127.0.0.1:3000/']) {
    expect(props.onShouldStartLoadWithRequest({ url })).toBe(false);
    props.onOpenWindow({ nativeEvent: { targetUrl: url } });
    props.onNavigationStateChange({ url, loading: false });
  }
  expect(open).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  props.onOpenWindow({ nativeEvent: { targetUrl: 'https://example.com/new' } });
  props.onNavigationStateChange({ url: 'https://example.com/next', loading: false });
  expect(open).toHaveBeenCalledWith('https://example.com/new');
  expect(navigate).toHaveBeenCalledWith('https://example.com/next');
});
