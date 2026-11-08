import { directActionUncertain, directRetryTarget } from '../remote/direct-turn-actions';
const page:any={loading:false,snapshotAt:100,session:{status:'failed',controllable:true,controlSurface:'cli'},items:[
  {kind:'message',id:'original',role:'user',text:'Original prompt',final:true,turnId:'turn-1',ts:1},
  {kind:'turn',id:'start',status:'started',turnId:'turn-1',ts:2},
  {kind:'message',id:'answer',role:'assistant',text:'Partial output',final:true,turnId:'turn-1',ts:3},
  {kind:'turn',id:'failed',status:'failed',turnId:'turn-1',ts:4},
]};
test('retry targets only the last failed terminal and its original own user message',()=>{
  expect(directRetryTarget(page)).toMatchObject({turnId:'turn-1',message:{id:'original'},failed:{id:'failed'}});
  for(const patch of [{local:true},{messageOrigin:{kind:'delegation'}},{turnId:'other-turn'}])expect(directRetryTarget({...page,items:[{...page.items[0],...patch},...page.items.slice(1)]})).toBeUndefined();
  expect(directRetryTarget({...page,cachedAt:90})).toBeUndefined();
  expect(directRetryTarget({...page,items:[...page.items,{kind:'turn',id:'new-start',status:'started',turnId:'turn-2',ts:5}]})).toBeUndefined();
  expect(directRetryTarget({...page,items:page.items.map((item:any)=>item.id==='failed'?{...item,status:'completed'}:item)})).toBeUndefined();
});
test('remote uncertainty strings are treated like missing transport receipts',()=>{
  for(const reason of [Object.assign(new Error('Timeout'),{code:'timeout'}),Object.assign(new Error('command_delivery_uncertain'),{code:'remote'}),new Error('消息可能已接收，请核对'),new Error('送达结果未确认')])expect(directActionUncertain(reason)).toBe(true);
  expect(directActionUncertain(Object.assign(new Error('unsupported model'),{code:'remote'}))).toBe(false);
});
