import {Platform} from 'react-native';

/** Reading and activity chrome share a soft system face; code editors opt out. */
export {roundedSystemFontFamily as conversationFontFamily} from '../typography';

/** Source blocks retain character alignment without the browser's serif mono fallback. */
export const conversationCodeFontFamily:string=Platform.select({
  web:'"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
  ios:'Menlo',android:'monospace',default:'monospace',
})!;
