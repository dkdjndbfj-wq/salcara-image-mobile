import {createContext,useContext} from 'react';

export type WorkspaceView = 'hidden'|'split'|'full';
export interface WorkspaceLayoutControls {
  view:WorkspaceView;
  canSplit?:boolean;
  setView:(view:WorkspaceView)=>void;
}
export const WorkspaceLayoutContext=createContext<WorkspaceLayoutControls|null>(null);
export const useWorkspaceLayoutControls=()=>useContext(WorkspaceLayoutContext);
