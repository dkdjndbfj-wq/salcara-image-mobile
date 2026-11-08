import React,{createContext,useContext} from 'react';
import type {ImageAnnotationAppender} from './image-annotation-draft';

/** The active conversation owns durable draft writes; preview pages never send turns. */
const Context=createContext<ImageAnnotationAppender|undefined>(undefined);
export const ArtifactAnnotationProvider=Context.Provider;
export const useArtifactImageAppender=()=>useContext(Context);
