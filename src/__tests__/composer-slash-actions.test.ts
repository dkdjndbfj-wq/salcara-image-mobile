import {composerSlashActions,initializationDraft} from '../remote/composer-slash-actions';
import {parseSlashQuery} from '../remote/slash-commands';

test('composer actions advertise only routes available in the current conversation',()=>{
  expect(composerSlashActions({})).toEqual([]);
  const entries=composerSlashActions({model:true,reasoning:true,reasoningLabel:'High',permissions:true,newChat:true,sideChat:true,fork:true,archive:true,review:true,initialize:true});
  expect(entries.map(entry=>entry.command)).toEqual(['/model','/reasoning','/permissions','/new','/side','/fork','/init','/review','/archive']);
  expect(entries.find(entry=>entry.action==='reasoning')?.description).toBe('High');
  expect(composerSlashActions({model:false,reasoning:false,newChat:true,sideChat:false}).map(entry=>entry.command)).toEqual(['/new']);
});

test('initialization leaves CRLF, surrounding whitespace and the suffix untouched',()=>{
  const text='  保留已有要求\r\n/init\r\n  后续内容  ',caret=text.indexOf('/init')+5;
  const query=parseSlashQuery(text,caret)!;
  const result=initializationDraft(text,query);
  expect(result.text.startsWith('  保留已有要求\r\n')).toBe(true);
  expect(result.text.endsWith('\r\n  后续内容  ')).toBe(true);
  expect(result.text).toContain('创建或完善 AGENTS.md');expect(result.text).not.toContain('/init');
  expect(result.caret).toBe(result.text.indexOf('\r\n  后续内容  '));
});

test('initialization cannot replace text captured from a stale query',()=>{
  const query=parseSlashQuery('/init')!;
  expect(initializationDraft('new draft',query).text).toBe('new draft');
});
