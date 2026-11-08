import React from 'react';
import {View} from 'react-native';
import {useDesk} from '../theme';
import {CommandOutputContent,type CommandOutputProps} from './CommandOutputContent';
import {CommandOutputActions} from './CommandOutputActions';

/** One browser scrollport keeps both scrollbars at the visible frame edges. */
export function CommandOutput(props:CommandOutputProps) {
  const d=useDesk();
  return <View testID="command-output-frame" style={{height:200,minWidth:0,borderRadius:8,overflow:'hidden',backgroundColor:d.surface2}}>
    <CommandOutputActions {...props}/>
    <div data-testid="command-output-scroll" role="region" aria-label="命令输出，支持上下左右滚动" tabIndex={0}
      style={{height:'calc(100% - 28px)',width:'100%',overflow:'auto',overscrollBehavior:'contain',scrollbarWidth:'thin',scrollbarColor:`${d.faint} transparent`,outlineOffset:-2}}>
      <div style={{width:'max-content',minWidth:'100%',boxSizing:'border-box',padding:12}}><CommandOutputContent {...props}/></div>
    </div>
  </View>;
}
