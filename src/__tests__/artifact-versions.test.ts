import {ARTIFACT_VERSION_LIMIT,artifactVersionSeriesKey,compareArtifactSources,ensureArtifactVersion,restoreArtifactVersion,saveArtifactVersion} from '../remote/artifact-versions';
import {conversationArtifactRevision,type ConversationArtifactTarget} from '../remote/conversation-artifact-target';
const mockSettings=new Map<string,string>();
const mockWrite=jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:(key:string,value:string)=>mockWrite(key,value)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID()}));
const target=(source='<h1>original</h1>',extra:Partial<ConversationArtifactTarget>={}):ConversationArtifactTarget=>({scopeKey:'pairing/pc/api/session',messageId:'answer',index:0,title:'Same title',source,revision:conversationArtifactRevision(source),...extra});
beforeEach(()=>{mockSettings.clear();mockWrite.mockClear();});
test('stable message/block identity deduplicates received source while independent sources never merge by title',async()=>{
  const original=await ensureArtifactVersion(target());expect((await ensureArtifactVersion(target())).versions).toHaveLength(1);
  const changed=await ensureArtifactVersion(target('<h1>revised</h1>'));expect(changed.versions).toHaveLength(2);expect(changed.versions[0]).toEqual(original.versions[0]);
  for(const extra of [{scopeKey:'another-pairing'},{messageId:'another-message'},{index:1}]){const separate=await ensureArtifactVersion(target(undefined,extra));expect(separate.versions).toHaveLength(1);expect(artifactVersionSeriesKey(separate)).not.toBe(artifactVersionSeriesKey(original));}
});
test('restoring an older source appends a new immutable version and preserves both histories',async()=>{
  const first=await ensureArtifactVersion(target()),second=await saveArtifactVersion(target(),'<h1>edited</h1>',first.versions[0].id);
  const restored=await restoreArtifactVersion(target(),first.versions[0].id,second.versions[1].id);
  expect(restored.versions.slice(0,2)).toEqual(second.versions);expect(restored.versions[2]).toMatchObject({source:first.versions[0].source,restoredFrom:first.versions[0].id,origin:'restore'});
  expect(new Set(restored.versions.map(version=>version.id)).size).toBe(3);
  restored.versions[0].source='mutated caller copy';expect((await ensureArtifactVersion(target())).versions[0].source).toBe('<h1>original</h1>');
});
test('stale simultaneous editors cannot overwrite a newer version',async()=>{
  const first=await ensureArtifactVersion(target()),id=first.versions[0].id;
  const results=await Promise.allSettled([saveArtifactVersion(target(),'<h1>A</h1>',id),saveArtifactVersion(target(),'<h1>B</h1>',id)]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);expect((await ensureArtifactVersion(target())).versions.map(version=>version.source)).toEqual(['<h1>original</h1>','<h1>A</h1>']);
});
test('failed storage and corrupted records do not erase accepted history',async()=>{
  const first=await ensureArtifactVersion(target());mockWrite.mockRejectedValueOnce(new Error('disk full'));
  await expect(saveArtifactVersion(target(),'<p>not persisted</p>',first.versions[0].id)).rejects.toThrow('disk full');expect((await ensureArtifactVersion(target())).versions).toEqual(first.versions);
  const raw=mockSettings.get('remote.artifact.versions.v1')!;mockSettings.set('remote.artifact.versions.v1',raw.replace('original','tampered'));
  await expect(ensureArtifactVersion(target())).rejects.toThrow('校验失败');expect(mockSettings.get('remote.artifact.versions.v1')).toContain('tampered');
});
test('version limits reject new saves instead of silently dropping prior versions',async()=>{
  let row=await ensureArtifactVersion(target());for(let i=1;i<ARTIFACT_VERSION_LIMIT;i++)row=await saveArtifactVersion(target(),`<p>${i}</p>`,row.versions.at(-1)!.id);
  await expect(saveArtifactVersion(target(),'<p>excess</p>',row.versions.at(-1)!.id)).rejects.toThrow('30');expect((await ensureArtifactVersion(target())).versions).toHaveLength(ARTIFACT_VERSION_LIMIT);
});
test('line comparison reconstructs both sides and preserves unchanged lines in changed regions',()=>{
  const before='head\nold\nkept\nold two\ntail',after='head\nnew\nkept\nnew two\ntail',diff=compareArtifactSources(before,after);
  expect(diff.filter(line=>line.kind!=='add').map(line=>line.text).join('\n')).toBe(before);expect(diff.filter(line=>line.kind!=='remove').map(line=>line.text).join('\n')).toBe(after);
  expect(diff.find(line=>line.text==='kept')).toMatchObject({kind:'same',oldLine:3,newLine:3});
  const large=compareArtifactSources(Array(700).fill('old').join('\n'),Array(700).fill('new').join('\n'));expect(large.filter(line=>line.kind==='add')).toHaveLength(700);expect(large.filter(line=>line.kind==='remove')).toHaveLength(700);
});
