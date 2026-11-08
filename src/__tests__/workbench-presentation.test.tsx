import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { MessageContent } from '../components/MessageContent';
import { useThreadStyles } from '../remote/thread-styles';
import { WorkbenchPresentationProvider, useWorkbenchPresentation } from '../remote/workbench-presentation';

function ConversationStyles() {
  const styles = useThreadStyles();
  const presentation = useWorkbenchPresentation();
  return <View>
    <Text testID="user-body" style={styles.userText}>用户正文</Text>
    <Text testID="tool-body" style={styles.stepText}>检查项目文件</Text>
    <Text testID="composer-body" style={styles.input}>输入框</Text>
    <Text testID="presentation">{presentation?.presentation ?? 'ordinary'}</Text>
  </View>;
}

test('workbench typography is scoped, responsive, and changes nested markdown with the user body', async () => {
  const body = <><MessageContent text={'正文\n\n- 列表内容\n\n## 标题'} /><ConversationStyles /></>;
  const view = await render(body);
  expect(StyleSheet.flatten(view.getByText('正文').props.style)).toMatchObject({ fontSize: 16, lineHeight: 27 });
  expect(view.getByTestId('presentation').props.children).toBe('ordinary');

  await view.rerender(<WorkbenchPresentationProvider presentation="tablet">{body}</WorkbenchPresentationProvider>);
  for (const text of ['正文', '列表内容']) expect(StyleSheet.flatten(view.getByText(text).props.style)).toMatchObject({ fontSize: 14, lineHeight: 22 });
  expect(StyleSheet.flatten(view.getByTestId('user-body').props.style)).toMatchObject({ fontSize: 14, lineHeight: 22 });
  expect(StyleSheet.flatten(view.getByTestId('tool-body').props.style)).toMatchObject({ fontSize: 13, lineHeight: 20 });

  await view.rerender(<WorkbenchPresentationProvider presentation="phone">{body}</WorkbenchPresentationProvider>);
  expect(StyleSheet.flatten(view.getByText('正文').props.style)).toMatchObject({ fontSize: 15, lineHeight: 24 });
  expect(StyleSheet.flatten(view.getByTestId('user-body').props.style)).toMatchObject({ fontSize: 15, lineHeight: 24 });

  await view.rerender(<WorkbenchPresentationProvider presentation="tablet" textScale={1.15}>{body}</WorkbenchPresentationProvider>);
  expect(StyleSheet.flatten(view.getByText('正文').props.style)).toMatchObject({ fontSize: 16.1, lineHeight: 25.3 });
  expect(StyleSheet.flatten(view.getByTestId('user-body').props.style)).toMatchObject({ fontSize: 16.1, lineHeight: 25.3 });
  expect(StyleSheet.flatten(view.getByTestId('composer-body').props.style)).toMatchObject({ fontSize: 15, lineHeight: 22 });
});

test('explicit compact tool details stay secondary and invalid saved scale cannot corrupt layout', async () => {
  const view = await render(<WorkbenchPresentationProvider presentation="tablet" textScale={NaN}><MessageContent compact text="工具明细" /><MessageContent text="正常正文" /></WorkbenchPresentationProvider>);
  expect(StyleSheet.flatten(view.getByText('工具明细').props.style)).toMatchObject({ fontSize: 13, lineHeight: 20 });
  expect(StyleSheet.flatten(view.getByText('正常正文').props.style)).toMatchObject({ fontSize: 14, lineHeight: 22 });
});
