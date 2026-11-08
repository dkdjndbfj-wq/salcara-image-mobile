import {fireEvent} from '@testing-library/react-native';
export async function openWorkspaceTool(view:any,label:string){
 const existing=view.queryByLabelText(label);if(existing){await fireEvent.press(existing);return;}
 const names:Record<string,string>={'工具栏改动':'变更','工具栏子智能体':'子智能体','工具栏调用':'执行记录','工具栏文件':'文件','工具栏预览':'浏览器'};
 await fireEvent.press(view.getByLabelText('添加工具标签'));
 if(label!=='工具栏文件') await fireEvent.press(view.getByLabelText('新标签页更多'));
 await fireEvent.press(view.getByLabelText(`打开${names[label]}标签`));
}
