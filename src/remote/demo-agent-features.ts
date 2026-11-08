import type {AgentFeatures} from './agent-features';

/** Explicit local examples; production catalogs always come from the computer. */
export const DEMO_AGENT_FEATURES:AgentFeatures={
  collaborationModes:['default','plan'],skillsSupported:true,
  skills:[
    {name:'frontend-design',displayName:'前端设计',description:'设计简洁的页面与交互 · 本地示例',path:'D:\\Projects\\salcara-web\\.agents\\skills\\frontend-design\\SKILL.md'},
    {name:'browser-testing',displayName:'浏览器测试',description:'检查页面布局和操作流程 · 本地示例',path:'D:\\Projects\\salcara-web\\.agents\\skills\\browser-testing\\SKILL.md'},
  ],
};
