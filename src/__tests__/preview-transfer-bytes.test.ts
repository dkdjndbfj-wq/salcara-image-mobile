import {decodePreviewBytes,encodePreviewBytes} from '../remote/preview-transfer-bytes';
test('binary transfer preserves all byte values and padded chunks',()=>{
 for(const size of [0,1,2,3,255,256,12288]) {const bytes=Uint8Array.from({length:size},(_,i)=>i%256);expect(decodePreviewBytes(encodePreviewBytes(bytes))).toEqual(bytes);}
 expect(()=>decodePreviewBytes('bad=padding')).toThrow();
});
