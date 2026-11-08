// Browser-only native-file fixture. Stores the actual validated image bytes so
// canvas handoff exercises the production draft transaction and scope checks.
export const documentDirectory='file:///preview-local/';
export const EncodingType={Base64:'base64',UTF8:'utf8'};
const files=new Map(),directories=new Set([documentDirectory]);
export async function makeDirectoryAsync(uri){directories.add(uri);}
export async function writeAsStringAsync(uri,value){files.set(uri,value);}
export async function readAsStringAsync(uri){if(!files.has(uri))throw Error('Preview file is missing');return files.get(uri);}
export async function getInfoAsync(uri){
 if(directories.has(uri))return {exists:true,isDirectory:true,uri,size:0};
 const value=files.get(uri);return value===undefined?{exists:false,isDirectory:false,uri}:{exists:true,isDirectory:false,uri,size:atob(value).length};
}
export async function deleteAsync(uri){files.delete(uri);directories.delete(uri);}
