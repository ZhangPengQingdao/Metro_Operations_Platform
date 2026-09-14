import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export function nextVersion(current,kind){
 if(!/^\d+\.\d+\.\d+$/.test(current)||!['patch','minor','major'].includes(kind))throw Error('Expected patch, minor or major with an x.y.z version');
 const [a,b,c]=current.split('.').map(Number);
 return kind==='major'?`${a+1}.0.0`:kind==='minor'?`${a}.${b+1}.0`:`${a}.${b}.${c+1}`;
}
export async function checkVersions(){
 const paths=['package.json','package-lock.json','server/package.json','server/package-lock.json','packages/platform-sdk/package.json'];
 const documents=await Promise.all(paths.map(async path=>({path,data:JSON.parse(await readFile(resolve(root,path),'utf8'))})));
 const version=documents[0].data.version;
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid project version');
 for(const {path,data} of documents){if(data.version!==version)throw Error(`Version mismatch: ${path}`);if(data.packages&&data.packages[''].version!==version)throw Error(`Lock root mismatch: ${path}`);}
 const sdk=documents[1].data.packages['packages/platform-sdk'];
 if(sdk?.version!==version||documents[0].data.dependencies['@metro/platform-sdk']!==version||documents[1].data.packages[''].dependencies['@metro/platform-sdk']!==version)throw Error('SDK version mismatch');
 return {version,documents};
}
async function main(){
 const kind=process.argv[2]??'--check';const {version,documents}=await checkVersions();
 if(kind==='--check'){console.log(`All project versions: ${version}`);return;}
 const next=nextVersion(version,kind);
 if(process.argv.includes('--dry-run')){console.log(`${version} -> ${next}`);return;}
 const readme=await readFile(resolve(root,'README.md'),'utf8');const changelog=await readFile(resolve(root,'CHANGELOG.md'),'utf8');
 for(const {path,data} of documents){
  data.version=next;if(data.packages)data.packages[''].version=next;
  if(data.dependencies?.['@metro/platform-sdk'])data.dependencies['@metro/platform-sdk']=next;
  if(data.packages?.[''].dependencies?.['@metro/platform-sdk'])data.packages[''].dependencies['@metro/platform-sdk']=next;
  if(data.packages?.['packages/platform-sdk'])data.packages['packages/platform-sdk'].version=next;
  await writeFile(resolve(root,path),JSON.stringify(data,null,2)+'\n');
 }
 await writeFile(resolve(root,'README.md'),readme.replace(`Platform · ${version}`,`Platform · ${next}`));
 await writeFile(resolve(root,'CHANGELOG.md'),changelog.replace('# 更新日志',`# 更新日志\n\n## ${next}\n\n- 待补充本次交付内容与验证结果。`));
 console.log(`${version} -> ${next}. Complete CHANGELOG before committing.`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
