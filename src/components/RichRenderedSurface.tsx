import React from 'react';
import { Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRichRenderDocument, type RichSurfaceProps } from './useRichRenderDocument';

export function RichRenderedSurface(props: RichSurfaceProps) {
  const {html,error,width,height,report}=useRichRenderDocument(props);
  if(error)return <Text selectable accessibilityRole="alert" style={{color:props.color,fontSize:12}}>{error}{'\n'}{props.source}</Text>;
  return <View accessibilityLabel={props.kind==='math'?`公式：${props.source}`:'Mermaid 图表'} testID="rich-rendered-content" style={{height,width:props.inline?width:'100%',maxWidth:'100%',backgroundColor:props.background}}>
    {html?<WebView source={{html}} originWhitelist={['about:*']} javaScriptEnabled domStorageEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito cacheEnabled={false}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never" setSupportMultipleWindows={false} scrollEnabled={!props.inline}
      onShouldStartLoadWithRequest={request=>request.url==='about:blank'||request.url==='about:srcdoc'} onOpenWindow={()=>{}}
      onMessage={event=>{try{report(JSON.parse(event.nativeEvent.data));}catch{/* Ignore unrelated/malformed WebView messages. */}}}
      style={{backgroundColor:props.background,height}}/>:<Text style={{color:props.color,fontSize:12}}>{props.inline?props.source:'正在渲染…'}</Text>}
  </View>;
}
