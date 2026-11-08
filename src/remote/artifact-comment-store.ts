import {getSetting,setSetting} from '../storage/database';
import {parseElementSelection,type ArtifactComment,type ArtifactElementSelection} from './artifact-annotations';
export interface ArtifactCommentRecord {notes:ArtifactComment[];nextNumber:number;draft?:{selection:ArtifactElementSelection;comment:string;editingId?:string}}
const pending=new Map<string,Promise<void>>();
const unsaved=new Map<string,string>();
const generations=new Map<string,number>();
const key=(scope:string)=>`remote.artifact.comments.v1:${scope}`;
export function parseCommentRecord(raw:string):ArtifactCommentRecord {
  if(raw.length>6_000_000)throw Error('批注数据过大，请从原页面重新选择');
  const value=JSON.parse(raw);if(!value||!Array.isArray(value.notes)||value.notes.length>20)throw Error('批注数据无效');
  const notes:ArtifactComment[]=[],ids=new Set<string>(),numbers=new Set<number>();
  for(const item of value.notes){const selection=parseElementSelection(item?.selection);if(!selection||typeof item.id!=='string'||!item.id||item.id.length>150||ids.has(item.id)||typeof item.comment!=='string'||item.comment.length>4000||!Number.isSafeInteger(item.number)||item.number<1||numbers.has(item.number))throw Error('批注数据无效');ids.add(item.id);numbers.add(item.number);notes.push({id:item.id,number:item.number,comment:item.comment,selection});}
  const out:ArtifactCommentRecord={notes,nextNumber:Math.max(1,...notes.map(n=>n.number+1),Number.isSafeInteger(value.nextNumber)?value.nextNumber:1)};
  if(value.draft){const selection=parseElementSelection(value.draft.selection);if(selection&&typeof value.draft.comment==='string'&&value.draft.comment.length<=4000)out.draft={selection,comment:value.draft.comment,...(typeof value.draft.editingId==='string'?{editingId:value.draft.editingId}:{})};}
  return out;
}
export async function loadArtifactComments(scope:string):Promise<ArtifactCommentRecord>{const id=key(scope),generation=generations.get(id);const raw=unsaved.get(id)??await getSetting(id);if(generations.get(id)!==generation)return loadArtifactComments(scope);return raw?parseCommentRecord(unsaved.get(id)??raw):{notes:[],nextNumber:1};}
export function saveArtifactComments(scope:string,value:ArtifactCommentRecord):Promise<void>{const raw=JSON.stringify(value);if(raw.length>6_000_000)return Promise.reject(Error('批注和截图已达本机保存上限，请先分批加入对话'));const id=key(scope);generations.set(id,(generations.get(id)??0)+1);unsaved.set(id,raw);const run=(pending.get(id)??Promise.resolve()).catch(()=>{}).then(()=>setSetting(id,raw)).then(()=>{if(unsaved.get(id)===raw)unsaved.delete(id);});pending.set(id,run);void run.finally(()=>{if(pending.get(id)===run)pending.delete(id);}).catch(()=>{});return run;}
