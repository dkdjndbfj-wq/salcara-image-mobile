// Development-only data to exercise the shared command viewport and typography.
export function commandOutputItems(long=false){
 const now=Date.now();
 const codePreview=new URLSearchParams(globalThis.location?.search??'').get('code-output')==='long';
 const code=codePreview?'\n\n```text\n'+Array.from({length:130},(_,i)=>`  line ${i+1}: ${'source_column / '.repeat(i===2?40:2)} `).join('\n')+'\n\nEND_OF_SOURCE\n```':'';
 const output=long?['示例命令输出 · 完整日志，从第 1 行开始',
   ...Array.from({length:140},(_,i)=>`${String(i+1).padStart(3,'0')}  ✓ 检查页面布局与触控区域 · viewport=390×844 · src/features/conversation/components/CommandOutput.tsx · ${'scroll-both-directions / '.repeat(i===2?18:1)}`),
   '日志最后一行 · 所有检查完成'].join('\n'):'示例命令输出\n✓ Login layout test passed\n✓ Tablet breakpoint test passed\n2 tests passed\nDuration 9.00s';
 return [
  {kind:'message',id:'command-request',role:'user',text:'检查登录界面，运行测试并展示执行结果。',final:true,ts:now-20000},
  {kind:'tool',id:'command-edit',tool:'file_change',title:'修改登录界面',status:'done',ts:now-15000,diff:'diff --git a/src/auth/login.css b/src/auth/login.css\n--- a/src/auth/login.css\n+++ b/src/auth/login.css\n@@ -1 +1 @@\n-color: gray;\n+color: #252A31;\ndiff --git a/src/auth/LoginPage.tsx b/src/auth/LoginPage.tsx\n--- a/src/auth/LoginPage.tsx\n+++ b/src/auth/LoginPage.tsx\n@@ -1 +1 @@\n-<OldLogin />\n+<Login />'},
  {kind:'tool',id:'command-check',tool:'command',title:'npm run test -- Login',detail:'npm run test -- Login',output,status:'done',exitCode:0,durationMs:9000,ts:now-10000},
  {kind:'message',id:'command-final',role:'assistant',text:'本地预览示例：已检查 `src/auth/login.css` 和 `src/auth/LoginPage.tsx`。命令输出在固定框内滚动查看。'+code,final:true,messagePhase:'final_answer',ts:now-1000},
  {kind:'turn',id:'command-finished',status:'completed',durationMs:19000,ts:now},
 ];
}
