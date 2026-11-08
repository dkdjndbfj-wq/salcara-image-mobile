import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import type { WorkspaceFileEntry, WorkspaceFilesPage } from './workspace-files';
import { ComposerPopover } from './ComposerPopover';

export type WorkspaceFileDirectory = { page?: WorkspaceFilesPage; loading?: boolean; error?: string };
export type WorkspaceFileDirectories = Record<string, WorkspaceFileDirectory>;
export interface WorkspaceFileBrowserProps {
  rootLabel: string;
  rootPath?: string;
  directories: WorkspaceFileDirectories;
  expandedPaths: ReadonlySet<string>;
  selectedPath?: string;
  busy?: boolean;
  onToggleDirectory: (path: string) => void;
  onLoadMore: (path: string) => void;
  onSelectFile: (path: string) => void;
  onReturnToDirectory?: () => void;
  toolbarActions?: React.ReactNode | ((closeMenu:()=>void)=>React.ReactNode);
  status?: React.ReactNode;
  children?: React.ReactNode;
}
type TreeRow = { key: string; depth: number; path: string } & (
  | { kind: 'entry'; entry: WorkspaceFileEntry; expanded: boolean }
  | { kind: 'loading' | 'more' | 'empty' | 'truncated' | 'unloaded'; text: string }
  | { kind: 'error'; text: string }
);

/** Presentation only: readers, ownership and directory caches belong to the caller. */
export function WorkspaceFileBrowser({ rootLabel, rootPath, directories, expandedPaths, selectedPath, busy, onToggleDirectory, onLoadMore, onSelectFile, onReturnToDirectory, toolbarActions, status, children }: WorkspaceFileBrowserProps) {
  const styles=useStyles(),dk=useDesk();
  const [wide,setWide]=useState(false),[filter,setFilter]=useState(''),[moreOpen,setMoreOpen]=useState(false);
  const moreAnchor=useRef<View>(null);
  useEffect(()=>{setMoreOpen(false);},[rootPath,selectedPath,busy]);
  useEffect(()=>{const subscription=AppState.addEventListener('change',state=>{if(state!=='active')setMoreOpen(false);});return()=>subscription.remove();},[]);
  const query=filter.trim().toLocaleLowerCase();
  const rows=useMemo(()=>{
    const result:TreeRow[]=[];
    const matches=(entry:WorkspaceFileEntry,ancestors:Set<string>):boolean=>{
      if(!query||entry.path.toLocaleLowerCase().includes(query))return true;
      if(entry.kind!=='directory'||ancestors.has(entry.path))return false;
      const cached=directories[entry.path]?.page;
      // Unloaded directories remain expandable; filtering never starts a remote scan.
      return !cached||cached.entries.some(child=>matches(child,new Set([...ancestors,entry.path])));
    };
    const visit=(path:string,depth:number,ancestors:Set<string>)=>{
      if(ancestors.has(path)||depth>32)return;
      const directory=directories[path],nextAncestors=new Set([...ancestors,path]);
      const entries=directory?.page?.entries.filter(entry=>matches(entry,nextAncestors))??[];
      for(const entry of entries){
        const expanded=entry.kind==='directory'&&(expandedPaths.has(entry.path)||Boolean(query&&directories[entry.path]?.page));
        result.push({key:entry.path,path:entry.path,depth,kind:'entry',entry,expanded});
        if(expanded)visit(entry.path,depth+1,nextAncestors);
      }
      if(directory?.loading)result.push({key:`loading:${path}`,path,depth,kind:'loading',text:'正在读取目录…'});
      else if(directory?.error)result.push({key:`error:${path}`,path,depth,kind:'error',text:directory.error});
      else if(!directory?.page)result.push({key:`unloaded:${path}`,path,depth,kind:'unloaded',text:path?'读取目录':'浏览工作区目录'});
      else if(directory.page.nextCursor)result.push({key:`more:${path}`,path,depth,kind:'more',text:'更多文件'});
      else if(directory.page.truncated)result.push({key:`truncated:${path}`,path,depth,kind:'truncated',text:'目录较大，请展开具体子目录查看'});
      else if(!entries.length)result.push({key:`empty:${path}`,path,depth,kind:'empty',text:query?'未找到匹配文件':'没有可查看的代码或文本'});
    };
    visit('',0,new Set());return result;
  },[directories,expandedPaths,query]);
  const tree=<View testID="workspace-file-tree" style={[styles.tree,wide&&styles.wideTree,!wide&&Boolean(selectedPath)&&styles.hidden]}>
    <View style={styles.filter}><Icon name="search" size={16} color={dk.muted} accent={dk.muted}/><TextInput accessibilityLabel="筛选文件" placeholder="筛选文件..." placeholderTextColor={dk.muted} value={filter} onChangeText={setFilter} autoCapitalize="none" autoCorrect={false} style={[styles.filterInput,wide&&styles.wideText]}/>{filter?<Pressable accessibilityRole="button" accessibilityLabel="清除文件筛选" onPress={()=>setFilter('')} style={styles.clear}><Icon name="close" size={18} color={dk.muted} accent={dk.muted}/></Pressable>:null}</View>
    <FlatList data={rows} keyExtractor={item=>item.key} style={styles.list} contentContainerStyle={styles.treeContent} initialNumToRender={30} maxToRenderPerBatch={30} windowSize={5} keyboardShouldPersistTaps="handled"
      renderItem={({item})=>item.kind==='entry'?<Pressable accessibilityRole="button" accessibilityLabel={`打开${item.entry.kind==='directory'?'目录':'文件'} ${item.entry.name}`} accessibilityHint={item.path} accessibilityState={item.entry.kind==='directory'?{expanded:item.expanded,disabled:Boolean(busy)}:{selected:selectedPath===item.path,disabled:Boolean(busy)}} disabled={busy} onPress={()=>item.entry.kind==='directory'?onToggleDirectory(item.path):onSelectFile(item.path)} style={[styles.row,wide&&styles.wideRow,{paddingLeft:8+item.depth*18},selectedPath===item.path&&styles.selected]}>
        <Icon name={item.entry.kind==='directory'?(item.expanded?'chevronDown':'chevronRight'):'file'} size={item.entry.kind==='directory'?15:16} color={dk.muted} accent={dk.muted}/><Text numberOfLines={1} style={[styles.name,wide&&styles.wideText]}>{item.entry.name}</Text>
      </Pressable>:item.kind==='more'||item.kind==='unloaded'||item.kind==='error'?<Pressable accessibilityRole="button" accessibilityLabel={item.kind==='more'?(item.path?`更多文件 ${item.path}`:'更多文件'):item.kind==='error'?`重试目录 ${item.path||rootLabel}`:item.text} disabled={busy} onPress={()=>onLoadMore(item.path)} style={[styles.treeStatus,{paddingLeft:10+item.depth*18}]}><Text style={styles.hint}>{item.text}{item.kind==='error'?' · 重试':''}</Text></Pressable>:<View style={[styles.treeStatus,{paddingLeft:10+item.depth*18}]}><Text accessibilityLiveRegion={item.kind==='loading'?'polite':'none'} style={styles.hint}>{item.text}</Text></View>}/>
  </View>;
  return <View testID="workspace-file-browser" onLayout={event=>{const width=event.nativeEvent.layout.width;setWide(width>=600);if(width<=0)setMoreOpen(false);}} style={styles.body}>
    <View style={[styles.toolbar,wide&&styles.wideToolbar]}>
      {selectedPath&&onReturnToDirectory?<Pressable accessibilityRole="button" accessibilityLabel="返回文件目录" disabled={busy} onPress={onReturnToDirectory} style={styles.icon}><Icon name="arrowLeft" size={18} color={dk.muted} accent={dk.muted}/></Pressable>:null}
      <View accessibilityLabel="当前工作区目录" accessibilityHint={rootPath??rootLabel} style={styles.rootCapsule}><Text numberOfLines={1} style={[styles.rootText,wide&&styles.wideText]}>{rootLabel}</Text></View>
      <View style={styles.spacer}/>
      {toolbarActions?<Pressable ref={moreAnchor} collapsable={false} accessibilityRole="button" accessibilityLabel="文件更多" accessibilityState={{expanded:moreOpen}} onPress={()=>setMoreOpen(value=>!value)} style={styles.more}><Icon name="more" size={18} color={dk.text} accent={dk.text}/></Pressable>:null}
    </View>
    <ComposerPopover visible={moreOpen&&Boolean(toolbarActions)} anchorRef={moreAnchor} onClose={()=>setMoreOpen(false)} placement="bottom" align="end" width={176} testID="workspace-file-actions" accessibilityLabel="文件操作">
      <View style={styles.menu}>{typeof toolbarActions==='function'?toolbarActions(()=>setMoreOpen(false)):toolbarActions}</View>
    </ComposerPopover>
    {status}
    <View style={[styles.content,wide&&styles.wideContent]}>
      {wide||selectedPath?<View testID="workspace-file-preview" style={styles.preview}>{selectedPath?children:<View style={styles.empty}><Icon name="folder" size={42} color={dk.muted} accent={dk.muted}/><Text style={[styles.emptyTitle,wide&&styles.wideEmptyTitle]}>打开文件</Text><Text style={[styles.emptyHint,wide&&styles.wideEmptyHint]}>从工作区目录树中选择文件</Text></View>}</View>:null}
      {tree}
    </View>
  </View>;
}

const useStyles=themed((c,d)=>StyleSheet.create({
  body:{flex:1,minHeight:0,backgroundColor:c.background},hidden:{display:'none'},toolbar:{minHeight:58,paddingHorizontal:10,flexDirection:'row',alignItems:'center',gap:8},wideToolbar:{minHeight:72},
  rootCapsule:{maxWidth:'78%',minWidth:0,flexShrink:1,minHeight:44,paddingHorizontal:14,justifyContent:'center',borderRadius:22,borderWidth:StyleSheet.hairlineWidth,borderColor:c.border},rootText:{color:d.text,fontSize:16,fontWeight:'500'},spacer:{flex:1,minWidth:0},icon:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'},more:{width:44,height:44,flexShrink:0,borderRadius:24,borderWidth:StyleSheet.hairlineWidth,borderColor:c.border,alignItems:'center',justifyContent:'center'},
  menu:{padding:4},content:{flex:1,minHeight:0},wideContent:{flexDirection:'row'},preview:{flex:1,minWidth:0,minHeight:0},tree:{flex:1,minWidth:0,minHeight:0,paddingTop:10},wideTree:{flex:1.06,borderLeftWidth:StyleSheet.hairlineWidth,borderLeftColor:c.border},
  filter:{height:44,marginHorizontal:12,paddingLeft:14,paddingRight:0,flexDirection:'row',alignItems:'center',gap:8,borderWidth:StyleSheet.hairlineWidth,borderColor:c.border,borderRadius:24},filterInput:{flex:1,minWidth:0,height:44,fontSize:16,color:d.text,padding:0},clear:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'},
  list:{flex:1},treeContent:{paddingHorizontal:8,paddingBottom:16},row:{minHeight:44,flexDirection:'row',alignItems:'center',gap:10,paddingRight:10,borderRadius:7},wideRow:{minHeight:44},name:{flex:1,minWidth:0,color:d.text,fontSize:16},wideText:{fontSize:20},selected:{backgroundColor:d.accentSoft},treeStatus:{minHeight:44,justifyContent:'center',paddingVertical:10,paddingRight:8},hint:{fontSize:12,lineHeight:18,color:d.muted},
  empty:{flex:1,alignItems:'center',justifyContent:'center',padding:20,gap:18},emptyTitle:{color:d.text,fontSize:20,fontWeight:'500',marginTop:4},wideEmptyTitle:{fontSize:24},emptyHint:{color:d.muted,fontSize:14,textAlign:'center',lineHeight:22},wideEmptyHint:{fontSize:18,lineHeight:28},
}));
