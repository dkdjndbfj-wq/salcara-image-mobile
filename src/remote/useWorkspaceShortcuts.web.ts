import {useEffect,useRef} from 'react';
import type {WorkspaceShortcutActions} from './useWorkspaceShortcuts';
export type {WorkspaceShortcutActions} from './useWorkspaceShortcuts';
/** Codex desktop defaults. Scope to the current mounted conversation; never rename chats. */
export function useWorkspaceShortcuts(actions:WorkspaceShortcutActions){
 const ref=useRef(actions);ref.current=actions;
 useEffect(()=>{if(!actions.active)return;
  const handle=(event:KeyboardEvent)=>{
   const a=ref.current;
   // Some IMEs finish composition with keyCode 229 before isComposing resets.
   // AltGraph reports Ctrl+Alt on several layouts but belongs to text input.
   if(!a.active||event.defaultPrevented||event.isComposing||event.keyCode===229
     ||event.getModifierState('AltGraph')||!(event.ctrlKey||event.metaKey))return;
   if(event.target instanceof Element){
    const dialog=event.target.closest('[role="dialog"],[role="alertdialog"]');
    const workspace=event.target.closest('#remote-workspace-root,#demo-workspace-root');
    // React Native's screen Modal wraps the entire conversation in a dialog.
    // Only actual nested/portal dialogs should suspend workspace shortcuts.
    if(dialog&&(!workspace||!dialog.contains(workspace)))return;
   }
   const key=event.key.toLowerCase();let action:(()=>void)|undefined;
   if(key==='t'&&!event.altKey)action=event.shiftKey?a.onRestore:a.onBrowser;
   else if(key==='g'&&event.shiftKey&&!event.altKey)action=a.onReview;
   else if(key==='s'&&event.altKey&&!event.shiftKey)action=a.onSideChat;
   else if(key==='e'&&event.shiftKey&&!event.altKey)action=a.onFiles;
   else if(key==='p'&&!event.shiftKey&&!event.altKey)action=a.onFiles;
   else if(key==='`'&&!event.shiftKey&&!event.altKey)action=a.onTerminal;
   else if(key==='b'&&event.shiftKey&&!event.altKey)action=a.onCycleLayout;
   else if(key==='b'&&event.altKey&&!event.shiftKey)action=a.onTogglePanel;
   else if(key==='f'&&event.shiftKey&&!event.altKey)action=a.onToggleFull;
   else if(a.visible&&key==='w'&&!event.shiftKey)action=event.altKey?a.onCloseOthers:a.onClose;
   else if(a.visible&&key==='tab'&&!event.altKey)action=event.shiftKey?a.onPrevious:a.onNext;
   if(action){event.preventDefault();event.stopPropagation();action();}
  };window.addEventListener('keydown',handle,true);return()=>window.removeEventListener('keydown',handle,true);
 },[actions.active]);
}
