import {unzipSync} from 'fflate';
import {readLocalFile,readLocalTextFile} from '@metro/platform-sdk/app-files';

export async function readMinutes(file){
 const options={maxBytes:5*1024*1024,extensions:['.docx','.txt','.md']};
 if(!/\.docx$/i.test(file.name))return readLocalTextFile(file,options);
 const bytes=await readLocalFile(file,options);
 const entry='word/document.xml';
 const files=unzipSync(bytes,{filter:f=>f.name===entry&&f.originalSize<=2*1024*1024});
 if(!files[entry])throw Error('无法读取 Word 正文，请粘贴会议纪要');
 const doc=new DOMParser().parseFromString(new TextDecoder().decode(files[entry]),'application/xml');
 if(doc.querySelector('parsererror'))throw Error('会议纪要格式无效');
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 return Array.from(doc.getElementsByTagNameNS(ns,'p'),p=>Array.from(p.getElementsByTagNameNS(ns,'t'),t=>t.textContent).join('')).join('\n');
}
