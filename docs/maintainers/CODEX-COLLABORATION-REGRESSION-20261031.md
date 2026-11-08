# 右侧工作区协作回归（2026-10-31）

用户指定主聊天 `01a17bf9-4291-7fc0-81a4-f01cb559420e`，授权协作聊天 `01a1907b-5372-7aa1-b3d8-575a7217cae7` 读取上下文并协助完成任务。已读取最新用户要求“全部完成”、右栏核查报告和当前代码，以新的 Codex 右栏目标为准。

## 分工

- 主聊天负责共享标签栏、面板布局、快捷键、浏览器批注与演示接入；其子代理负责临时侧聊和统一审查。
- 首轮协作聊天只新增本报告与 `src/__tests__/workspace-collaboration-regression.test.tsx`，负责独立回归、问题复现与反馈；首轮实现修复由主聊天完成。
- 后续用户明确要求继续共同完成并加速，双方按文件分工实施。协作聊天承担地址解析、独立侧聊与快捷键回归、手机整页工具区验收，以及 `DirectExperience` / `RemoteScreen` 父层可见性接线和 Android 返回优先级修复；共享容器与演示子页由主聊天负责。下文保留首轮证据，后续结果单列，不能把不同时间的批次相加当作一次全量测试。

## 已验证问题与修复

1. **关闭记录中的标签编号被新页占用**：冷启动仅保留新标签页，而关闭栈有 `browser:1`；新建浏览器后恢复旧网页失败。独立回归在修复前失败；主聊天将编号恢复范围扩展到打开页与关闭栈后通过。
2. **关闭标签后残留菜单**：长按终端打开菜单，再关闭终端，菜单仍显示。独立回归在修复前失败；主聊天清理过期菜单，并让“关闭其他标签”忽略已经不存在的目标。另验证已排队的旧回调不能删除剩余页面。

## 本次验证

命令：

```powershell
npx jest --runTestsByPath src/__tests__/workspace-collaboration-regression.test.tsx --runInBand --silent --json --outputFile=output/workspace-collaboration-regression.json
```

结果：**1 suite / 9 tests 通过，进程退出 0**。

- 冷启动后新建终端保留已恢复终端。
- 冷启动后 Agent 新网页保留旧网页与前台选择。
- 新标签不复用仍可恢复的关闭记录编号。
- 隐藏侧栏时 Agent 后台打开网页不抢焦点，同 URL 的不同 pageId 保持独立。
- 切换电脑隔离打开页与关闭栈，切回可恢复原记录。
- 关闭标签后清理它的菜单。
- 已排队的旧“关闭其他标签”操作不清空剩余页面。
- 手机隐藏面板可以通过共享打开动作显示。
- 手机全页视图关闭后主聊天仍可见。

结果文件：`output/workspace-collaboration-regression.json`。关闭栈编号问题修复前的失败结果保留为 `output/workspace-collaboration-before-fixes.json`。

## 验证边界

本组测试运行实际侧栏、标签与布局组件，使用内存存储和模拟连接元数据；终端与网页内容组件不执行真实远程操作。结果证明所列状态及生命周期行为，不代表原生设备、真实 Hub/Direct 传输、临时侧聊、统一审查页或最终视觉全部验收。整体验收仍由主聊天汇总。

## 后续协作与手机整页工具区验收

以下截至本次文档更新已完成；测试输出来源分别标明。更新文档时只复核已有结果和测试源码，没有重新运行全量检查。

| 范围 | 结果与证据 | 已验证行为 |
| --- | --- | --- |
| 地址栏解析 | `workspace-address.test.ts` 新增 **52 项**；与 `remote-links.test.ts` 联跑为 **2 suites / 126 tests 通过**。来自本协作代理实际终端记录，未另存 JSON。 | 先有 20 个失败用例，再修复裸域/localhost 带端口、IPv4/IPv6、国际域名和搜索区分。显式 HTTP(S) 保留；裸本地地址默认 HTTP，公网默认 HTTPS；凭据、危险协议和非法端口仍阻止。 |
| Web 快捷键 | **20 项通过**，由 `output/project-sidebar-final.json` 中 `workspace-shortcuts-web.test.tsx` 的 20 条 passed 断言复核；该批次整体为 2 suites / 47 tests。 | 真实 DOM 键盘派发、组合键、隐藏面板、对话框、整页 Modal、IME/AltGraph、失效及过期回调。 |
| 临时侧聊独立回归 | `temporary-side-chat-collaboration.test.tsx` 5 项，加 `direct-side-chat-scope-collaboration.test.tsx` 2 项，共 **新增 7 项**。协作根代理前轮终端记录报告与既有侧聊/Direct 服务四套联跑为 **26 项通过**；该批次未保存 JSON，本次未重跑。 | 模型/附件选择及上传过程中切换来源、旧能力响应隔离、关闭恢复不重复发问，以及 Direct 重连/执行身份改变后更新临时聊天作用域。当前源码中的既有测试数量可能已增长，26 仅代表当时批次。 |
| Hub 手机共享容器 | `small-screen-workspace-collaboration.test.tsx` **3 项通过**；可在 `output/project-tree-mobile-final.json` 中复核。 | 手机打开工具后隐藏主聊天、去掉抽屉遮罩；返回和重开保留双方草稿；手机与平板切换不重挂载内容。此处测试共享组件与模拟数据，不代表真实 Hub 网络链路。 |
| 父层整页接线 | `remote-mobile-workspace-shell.test.tsx` **4 项通过**；与共享容器联跑为 **2 suites / 7 tests 通过**（9.564 秒，退出 0）。来自本协作代理实际终端记录。 | Direct/演示工具页隐藏外层顶栏；关闭、断线、离开演示会话恢复顶栏；旧 Direct 路由回调不能污染新页面；Android 返回先关闭工具页。 |
| 真实浏览器页面 | 协作根代理在本次更新期间对主聊天最新 `ThreadView` 重跑脚本，**10 项浏览器检查全部通过**。本次另复核脚本含 10 个 `check`，三张截图均存在。它们是浏览器交互检查，**不是 10 项 Jest 用例**。 | 390×844 和 320×568 手机工具页宽度/头部/发送按钮边界，返回聊天，重开保留临时草稿，切到 1194×834 平板恢复分屏。 |

对应可重复执行的定向 Jest 命令：

```powershell
npm test -- --runTestsByPath src/__tests__/workspace-address.test.ts src/__tests__/remote-links.test.ts
npm test -- --runTestsByPath src/__tests__/workspace-shortcuts-web.test.tsx
npm test -- --runTestsByPath src/__tests__/temporary-side-chat-collaboration.test.tsx src/__tests__/direct-side-chat-scope-collaboration.test.tsx src/__tests__/temporary-side-chat.test.tsx src/__tests__/direct-session-services.test.ts
npm test -- --runTestsByPath src/__tests__/remote-mobile-workspace-shell.test.tsx src/__tests__/small-screen-workspace-collaboration.test.tsx
```

浏览器检查脚本与截图位于协作聊天的本机可视化目录，不属于发布资源：

- 脚本：`C:/Users/24230/.codex/visualizations/2026/10/31/01a1907b-5372-7aa1-b3d8-575a7217cae7/verify-phone-workspace.js`。
- 截图：同目录 `phone-full-page.png`、`phone-compact-full-page.png`、`tablet-final-split.png`；本次复核文件修改时间为 2026-10-31 19:43。
- 脚本针对 `http://127.0.0.1:4173/?scene=programming-thread` 本地 fixture 预览；结果不涵盖实体 Android/iOS、真实远程传输或付费模型调用。
- 最新浏览器执行的量测：390×844 视口内工作区 `x=0, width=390, top=0, bottom=824`，发送按钮底部 `804`；320×568 视口发送按钮边界 `x=267, y=498, width=30, height=30`；1194×834 平板恢复双栏。控制台 **0 errors**，另有 3 条已知 React Native Web 兼容警告。

### Android 返回优先级：先失败，再通过

`TabletThreadFrame` 已注册手机工具页返回处理，但 `RemoteScreen` 每次重渲染会重新注册父返回监听。原生按后注册优先派发时，父监听抢先退出 Direct 路由，界面回到编程首页，而非返回聊天。

新增父层回归使用实际 `TabletThreadFrame`，按原生逆序派发 `hardwareBackPress`：修复前该组 **3/4 通过、1 失败**，失败页面已出现“进入直连”首页入口；随后在 `RemoteScreen` 工具整页可见时返回 `false`，交给子容器消费。修复后父层 **4/4**、与手机共享容器合计 **7/7** 通过。该修复保留主聊天和工具内容实例与草稿。

### 演示子页合入与最终复验

`child-mobile-workspace-collaboration.test.tsx` 原有 4 项中，演示整页替换/返回草稿及 Android 返回 2 项先失败。主聊天完成 `RemoteDemoWorkspace` 后，协作代理新增 844 像素宽横屏检查并复验，**5/5 通过**（10.843 秒，进程退出 0）。Direct 原有 2 项仍通过；演示工具页隐藏主聊天、没有抽屉遮罩，返回按钮及 Android 返回键都先回聊天，保留聊天和终端草稿；外层可见性回调正确恢复。844 宽度仍按手机整页布局处理，不提供分栏按钮。

根代理又通过浏览器从 `RemoteScreen` 首页真实入口进入演示会话，执行同目录 `verify-demo-phone-workspace.js`，**12 项浏览器检查全部通过**。390×844 工具面板边界为 `x=0, y=0, width=390, height=844`，外层标题无占位；320×568 终端按钮边界为 `x=277, y=485, width=24, height=24`；844×390 横屏仍整页，1194×834 平板恢复分栏。返回/重开/跨尺寸均保留草稿，控制台 0 errors、3 条已知 RNWeb 兼容警告。

最新截图为同目录 `demo-phone-full-page.png`、`demo-phone-compact-full-page.png`、`demo-phone-landscape-full-page.png`、`demo-tablet-split.png`。这些浏览器结果来自本地 fixture，Android 返回结果来自组件事件模拟，尚未代表实体手机或真实 Direct 传输验收。

当前记录是分工协作与定向验收证据，不能据此宣布所有 Codex 对齐、Code/Work 项目树、全部宿主能力、实体设备和最终视觉均已完成。

## 四张 Codex 截图的界面重构

用户随后指定子智能体、变更、新标签页、打开文件四张截图作为视觉依据。对应页面改为简单分组、紧凑文件行和按需菜单，不再常驻重复标题及整组操作。真实数据仍来自当前会话及其已授权工作区；演示页面复用同一展示组件并保留模拟连接标识。

- 子智能体使用 `SubagentList`：已开启/完成分组、单行名称、更新时间；失败及未知状态不会误计入完成。行长按或右键展示操作。
- 变更页使用范围选择与增删总数，点击文件原位展开差异；只有选择代码行后才出现批注。打开文件仍进入对应文件标签。
- 新标签页只列文件、侧边聊天、终端三个主要入口，其余工具收在更多菜单。地址栏保留已有解析和导航；`Ctrl+P` 已接通文件入口。
- 打开文件使用 `WorkspaceFileBrowser`：当前项目目录树、已加载目录筛选、分页及子目录展开。宽度达到 600 时左侧预览、右侧目录；窄屏使用整页目录/预览切换。返回和切标签保留筛选与展开状态；单击文件默认内联预览，更多菜单可另开文件标签。未加载目录保留可展开入口，不自动递归扫描电脑。

四页的浏览器交互复验共 **38 项通过**：`verify-codex-reference-pages.js` 16 项，`verify-codex-files-final.js` 22 项。后一组覆盖 733×1224、390×844、320×844，验证左右布局、窄屏全宽预览、返回目录、跨标签状态及菜单自动关闭。控制台 0 errors，仍有已知 React Native Web 兼容警告。脚本及 `codex-{agents,review,newtab,files}-final.png` 截图位于前述可视化目录。它们使用本地演示入口，不代表真实远程连接或实体手机验收。

相关组件定向验证：子智能体/控制/快捷键 3 suites / 39 项；变更/差异批注 2 suites / 22 项；新标签页 12 项；演示文件与手机子页集成 2 suites / 9 项，均通过。这些是分批执行的结果，不应与本文较早批次累计为唯一用例总数。四页落盘后 `npm run typecheck` 通过。

文件页真实组件与草稿的最后一轮独立复核发现并修复三处状态边界：关闭较旧的浏览标签不能删除另一文件标签仍持有的最新草稿；其他标签已保存或已明确放弃的草稿不能从旧内存恢复；目录请求在隐藏期间中断后应恢复可重试状态。另验证 reader 工作目录改变时不会带入旧项目内容，旧项目草稿仍按原身份保留。最终 `remote-files-view` 26 项与 `remote-sidebar-persistence` 10 项全部通过；结合本轮已通过的传输 83 项、草稿存储 11 项，共 130 项不同的文件相关用例。最终报告为可视化目录中的 `files-multi-owner-final.json`，覆盖前述两套组件测试。

此前集成期间出现的 `onContinue` 接口及 `play` 图标错误已由主聊天修复；其后完整类型检查通过。后续并行新增画布期间的最新整项目检查状态见下节，不能把历史通过记录当作持续编辑中的当前验收。

## Computer Use、DOM 编辑、多仓库的后续验收

本轮由当前协作聊天负责右侧工具，主聊天继续处理输入框、发送回执及后续画布。接口、文件分工和新增发现已同步，未覆盖主聊天的并行改动。

| 范围 | 已执行的验证 | 结果 |
| --- | --- | --- |
| Computer Use 事件与运行身份 | `computer-activity.test.ts` | 最新 17 项通过；包含新回合先到、旧 session 晚到、混合历史序号/时间戳、子任务回合及明确失败。 |
| Computer Use 查看页 | `computer-use-page.test.tsx` | 最新 6 项通过；隐藏不读取、按内容去重、断线/审批、精确停止入口、历史选择及新操作截图索引不串用。 |
| 工作区接线 | `remote-sidebar-persistence.test.tsx` | 最新 12 项通过；操作标签后台添加不抢焦点，关闭不停止，旧回合或缓存不自动重新打开。该批与状态/页面联跑为 32 项通过，之后新增边界分别在前两行复验，不重复累计。 |
| Direct 截图读取 | `direct-conversation-content.test.tsx` | 原 8 项与新增 3 项，共 11 项通过；首次 503 后重试、相同 ID 的 MIME/size 变化、切会话/代次/断线后的迟到结果隔离。失败释放去重 token；缓存采用可按绑定撤销的会话 scope。 |
| DOM/CSS 编辑 | 编辑器、解析器、画布、批注、预览及 `RemoteComputerPreview` | 分组共 28 项通过。添加手机限高滚动容器后，再跑真实 `RemoteComputerPreview` 集成 7 项通过。 |
| 多仓库审查 | `workspace-git` 协议与 Review UI | 7 项协议 + 14 项 UI，共 21 项通过。仓库状态、文件/hunk 身份和当前显示仓库不混用。 |
| Bridge 预览 | 所有 `TestPreview` / `TestWorkspacePreview`，含真实 CDP 浏览器 | 通过；验证真实元素选择、临时样式、撤销、文档/节点/revision 改变与迟到结果。 |
| Bridge Git | 多仓库、实际 stage/unstage、review、worktree、写前授权变化 | 18 项相关顶层测试及 8 项授权子用例分批完成通过。一次组合达到 10 分钟上限，栈停在 Windows Git PATH 查找；只补跑尚未完成的 LastTurn/Worktree 用例，两项最终通过（138.3 秒），不记为一次全组合成功。 |
| Bridge/Hub Computer Use | 工具元数据/生命周期、原生已授权线程、事件深拷贝、内联图像转 opaque ref、跨线程拒读、Hub 实时/重放/设备隔离 | 通过。最后独立收尾 Go 组合 agents 0.900 秒、desktopcompanion 0.745 秒；`TestComputerUseFrameIsOpaque` 0.821 秒。 |
| 整项目类型检查 | `npm run typecheck` | 侧栏落盘后的一次完整检查通过（会话 30498）。随后主聊天开始新增画布，最新一次（54793）仅报 `artifact-viewer-types.ts` 尚缺 `conversation-artifacts` 模块（TS2307）；已交接主聊天完成画布后复验，不擅自补空文件消除错误。 |

浏览器使用现有 Playwright CLI + headless Edge，原因是当前会话没有 Browser 插件；没有安装新依赖。目标是本地 `http://127.0.0.1:4173` 的共享真实组件，数据来自明确标识的 fixture，不会发送任务、停止真实模型或冒充实体设备链路。

- `verify-computer-use-page.js`：9 项检查通过。实际演示入口 → 新标签更多 → 电脑操作 → 历史/跟随 → 返回聊天；覆盖 733×1224、390×844、320×844 整页尺寸。
- `verify-sidebar-advanced.js`：12 项检查通过。多仓库同名文件展开、只暂存选定仓库；实际元素编辑组件完成预览、撤销、加入草稿。覆盖 733×1224、390/320 宽度以及 568 高度的编辑器滚动。
- `verify-computer-use-frame.js`：9 项检查通过。截取本地预览页后注入明确的交互 fixture，验证实际 PNG 加载、390/320 停止按钮边界、图像点击回调、等待审批、断线保留画面和停止回执。仅证明组件交互，真实图片通路由上述 Bridge/Hub 测试单独验证。脚本首次使用了错误的图片子节点定位器，修正后全部通过，没有对应产品错误。

三组页面均正确显示身份、非空内容和交互结果，没有框架错误覆盖层，控制台及页面运行错误均为 0；仍有已有的 RNWeb 兼容警告。脚本、图片位于 `C:/Users/24230/.codex/visualizations/2026/10/31/01a1907b-5372-7aa1-b3d8-575a7217cae7/`。本次人工查看了 `computer-use-phone-390.png`、`computer-use-frame-320.png`、`multi-repository-wide.png`、`browser-elements-phone-320.png`。

没有已连接实体设备（此前 `adb devices -l` 为空），不声称 Android/iOS 真机验收。此阶段尚未完成的临时工具侧聊见下节后续实现；原生 Work 未开放的临时执行/中断、连续桌面视频、未报告的 Computer Use 工具格式及逐像素 Codex 一致性仍不在完成声明内。

## 工具型临时侧聊验收（2026-11-04）

本节为接续实现，使用独立私有 Codex worker，不复用父任务的执行或审批。手机权限选择、工具输出、单次审批、停止/结束和送达核对由真实组件实现；默认只读与原持久侧问保持原有行为。

最终手机侧组合：`temporary-side-tools`、`temporary-side-chat`、`temporary-side-chat-collaboration`、`remote-side-question-transport`、`direct-session-services`、`direct-api`、`direct-side-chat-scope-collaboration` 共 **7 suites / 102 tests 通过**（22.594 秒）。新增工具侧聊 12 项；数量包含相关既有回归，不与前轮计数相加。

- `temporary-side-tools.test.tsx`：显式能力、未支持输入保留、并发发送合并、未知送达只读恢复、启动拒绝/歧义、结束与迟到发送/读取竞争、前后台租约、来源变化、独立审批/停止及真实 Go 省略字段解析。
- Bridge `TestCodexSideTools*`：模拟 RPC，验证私有 ephemeral 线程、网关/权限/无目标确认、重复 operation、项目预约、启动失败释放、未知回执、输出大小与来源、租约/回收和独立审批。过长或已截断的审批仅可拒绝；未支持问答审批提供拒绝入口。
- Bridge `TestSideQuestionTools*`：服务端快照、严格字段、旧能力拒绝、Direct 绑定与请求取消区分、撤销、API/项目变化、父任务占用、私有预约阻止主任务、跨来源回复及输出预算。
- Hub `TestToolsSideQuestion*`：6 项顶层测试，覆盖全部动作的执行源约束、不持久化回执、篡改、跨来源、请求取消及撤销。
- Direct `TestBindingValidator*` 与 Console `TestDirectToolsSideQuestion*`：跨普通重连保持绑定，revoke/rebind/relay close 失效，不接受调用者自报 owner。
- Playwright `verify-temporary-side-tools.js`：23 项检查通过，733/390/320×844，权限选择 → 提问 → 展开工具 → 审批 → 停止 → 结束 → 新侧聊。按钮位于屏内，无横向溢出，页面非空，无运行时/控制台错误。保留已有 RNWeb 弃用及无原生动画模块警告。

浏览器继续使用现有 headless Edge 和 Playwright CLI（当前没有 Browser 插件）。证据为同目录 `side-tools-733.png`、`side-tools-390.png`、`side-tools-320.png`；这是明确标识的本地 fixture，不能计作真实模型或实体手机验收。整项目类型检查现已通过，前节画布中间写入时的缺模块错误已消失。

## 命令菜单与权限名称（2026-11-05）

去除“项目工具/允许项目内工具”自定义名称，统一显示“请求批准”。Direct 新建与已有会话补齐按光标解析、点击发送选择命令、方向键、Enter/Tab/Escape，以及目录刷新失败和跨来源回调失效；演示会话补齐相同的技能/计划入口。主 ThreadView 已有实现，本次修正其预览目录与本地空存储 fixture，使真实主输入框可以验收。

临时聊天新增 `/` 与 `$` 菜单，计划/技能通过私有 worker 原生目录与回合字段执行；只读侧聊先选择权限。新增 features 路由、严格状态解析和 Direct 字段透传。目录失效保留输入，命令选择与发送问题分开。修复浏览器光标事件导致 Escape 后菜单重新弹出的情况；选中文字时不按局部命令替换。

- 手机侧组合 9 suites / 159 tests 通过；随后增加 `$` 和 `/skills` 只读入口及选区边界，最终 `temporary-side-tools` 18 tests 通过，`npm run typecheck` 通过。
- Bridge `TestCodexSideTools*`、`TestSideQuestionTools*` 通过；新增实际 Dispatcher 路由测试发现并修复公共 turn feature 校验拒绝私有 send 的问题，验证原生模式/技能字段到达私有执行器。
- Hub `TestToolsSideQuestion*` 通过，动作表覆盖新增 features 的执行源约束。
- Playwright `verify-slash-menu.js` 24 项、`verify-main-slash.js` 10 项通过。733/390/320×844 与 390×480 布局均无横向溢出；主聊天和临时聊天实际输入 `/` 后出现菜单，可选择技能与计划模式。无应用运行错误，保留既有 RNWeb 警告。

证据在同一可视化目录：`slash-main-{733,390,320}.png`、`slash-side-{733,390,320}x844.png` 和 `slash-side-390x480.png`。Go 使用模拟 RPC；浏览器使用明确标识的本地目录示例。没有启动真实付费模型回合，没有打包或安装实体手机。

## 输入框布局与编辑（2026-11-05）

修正手机输入框工具栏挤成两行、模型只有圈形图标、推理默认文案过长的问题。MainComposer 在 320/390/733 宽度下保持单行工具栏，模型改为名称与下拉，默认推理使用短文案；计划状态移至文字区上方。390 下空输入框从 168 px 降至 112 px。暗色发送/停止按钮使用 onInk 前景色。

Direct 的附加引用、计划和技能入口收进加号菜单；初次读模型目录以显示真实可用的推理强度，目录结果按来源和服务实例隔离。主、Direct、侧聊及演示共用 SkillComposerInput，普通多行输入和 Android 技能测量都限制在各自声明的高度范围。

Web 输入补齐修饰键、手机 DIV/P/BR 换行和选区偏移、RN 横纵边距映射、UTF-16 maxLength、IME 与禁用迟到事件处理。原超长草稿不会被截断，允许逐渐删除。Shift+Enter 不选择命令。

- 相关 6 suites / 120 tests 通过，含 Web 45 项、Direct 完整输入与来源隔离、原生自动高度和已有侧聊/演示回归。
- Playwright `verify-composer.js` 45 项通过；主/Direct/侧聊在 320/390/733×844、390×480 下无重叠/横向溢出，多行至 180 px 后框内滚动，清空缩回，模型菜单及计划菜单可操作。`verify-slash-menu.js` 在新输入组件下重新通过 24 项。
- 人工查看亮/暗 390 截图，未出现应用运行错误；仍有既有 RNWeb 警告。证据为 `composer-*.png`，独立输入框截图为 `composer-input-390.png`。键盘空间通过缩小浏览器可视高度模拟，不作为实体手机键盘验收。

## 输入框独立设置菜单（2026-11-06）

去掉常驻 `/` 按钮，键入 `/` 的命令选择保留。权限菜单改为输入框上方的无暗色遮罩菜单，仅图标、名称和选中勾号；Codex 显示已报告的请求批准、帮我批准、完全访问权限，仍校验电脑授权。未报告当前策略时按钮显示“权限”，不虚报默认模式。临时聊天只提供真实支持的只读与请求批准。

模型面板重写为纯模型列表，删除旧轨道实现、全屏背景截图及按住切换思考的交互。推理面板仅保留当前档位、滑杆与重置，不再包含模型入口或说明。三种设置共享 ComposerPopover 的锚定定位、屏幕约束和滚动容器；主对话、Direct、临时聊天、演示均接入。选模型保留目标模型支持的现有思考档位，不支持时才清除。API Key 更换在外层 Agent/API 配置，错误恢复进入现有配置页，配置打开期间暂停会话发送与自动队列。

验证：类型检查通过；MainComposer/手势边界两套 28 项、模型与对话组件 35 项、ThreadView 目录/来源/原生执行定向 109 项、配置锁定 2 项、API 组件 36 项通过。Direct/临时聊天/演示最终模型兼容性回归 60 项通过，临时工具原有用例也通过。Playwright `verify-compact-menus.js` 118 项通过，覆盖主/Direct/临时聊天 320、390、733×844 和 390×480 下三类菜单、无横向溢出、勾选同步、模型与思考严格分离、键入斜杠命令；无应用运行错误。

证据位于原可视化目录：`composer-{permission,model,effort}-crop.png`、`composer-independent-settings.png`。本轮为本地 fixture 和模拟服务验证，没有打包、发布或实体手机键盘验收。

## 菜单收起确认与模型切换记录（2026-11-07）

本节更新前节的确认方式：推理菜单已去掉重置，模型/推理点击框外收起才提交变化；未更改或改回原值不提交。两个菜单均为 256 px，推理菜单约 88 px 高。主对话与 Direct 增加独立本地存储的模型切换记录，不改写原始会话事件。模型记录只在已存在对话的有效用户确认时产生，刷新恢复、来源隔离、锚点缺失隐藏及被动关闭取消均有回归。

- `remote-main-composer`、`direct-composer`、`temporary-side-chat`、`remote-demo-flow` 最终组合 **4 suites / 75 tests 通过**，日志 `output/confirmation-composers-final.log`。
- 纯模型选择与取消/确认边界 **29 tests 通过**；模型记录和 Direct 集成 **17 tests 通过**。ThreadView 定向用例及修正后的回归通过，日志为 `output/model-thread-focused-tests.log`、`output/model-thread-recheck-tests.log`。
- Playwright 现有 Edge 会话复验 `verify-compact-menus.js` **136 项通过**，`verify-model-confirmation.js` **14 项通过**。覆盖三种输入入口、320/390/733 宽及缩小可视高度、菜单锚点/尺寸、外部确认、无重置、记录持久化。无页面运行异常；保留既有 RNWeb 警告。
- 最新截图为原可视化目录的 `composer-model-crop.png`、`composer-effort-crop.png`、`model-change-{320,390,733}.png`。这些为真实组件与本地 fixture，不代表实体手机或真实模型验证。

## 文件汇总完成时机（2026-11-07）

文件汇总仅在整轮任务及其子任务结束后显示，执行过程行保持可见。回归覆盖父任务与子任务不同结束顺序、commentary 分段、历史完成轮次、本地排队消息、结束前残留推理状态、乱序子回合事件，以及仅收到 spawn ACK 的真实子任务。

`remote-change-summary-completion`、`remote-execution-timeline`、`remote-activity-summary-new`、`remote-conversation-artifacts`、`conversation-reading` 最终组合 **5 suites / 58 tests 全部通过**，日志 `output/change-summary-completion.log`。单个子任务失败或中断而其他子任务状态缺失时仍隐藏汇总；全部子任务回执确认结束后才放行，失败过程展示保留。

Playwright `verify-change-summary-completion.js` **34 项通过**：真实 ThreadView 在 320/390/733×844 下运行中无汇总、完成后有汇总，两种状态均保留编辑行，无横向溢出或页面错误。开发 fixture 用 `?completed=1` 提供明确的 final reply 和 completed turn，默认场景保留运行状态。截图为 `changes-{running,completed}-{320,390,733}.png`；已人工查看 390 的两种状态。验证使用本地数据，没有调用真实模型或安装新版。

定向文件 diff 检查通过。整项目 `npm run typecheck` 在本轮中曾通过；后续并行新增的浏览器批注测试带来 3 条 mock 调用参数类型错误，位于 `browser-annotations.test.tsx:54` 与 `browser-element-editor.test.tsx:53,68`，已交给该模块负责对话处理。最新检查日志为 `output/composer-summary-final-typecheck.log`，不得将此日志声称为全项目通过；本轮设置、模型记录与汇总卡文件没有类型错误。
