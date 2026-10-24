import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';

const applications=join(import.meta.dirname,'../../applications');

// esbuild bundles a page or backend that uses an undeclared name, which then throws only when that code runs
// (e.g. a leftover setRoute in a click handler). TypeScript's checker reports those names without types.
test('repository applications reference no undeclared names',()=>{
 const files=readdirSync(applications,{withFileTypes:true}).filter(entry=>entry.isDirectory()).flatMap(app=>
  readdirSync(join(applications,app.name,'src')).filter(file=>/\.(mjs|jsx|js)$/.test(file)).map(file=>join(applications,app.name,'src',file)));
 assert.ok(files.length>8);
 const program=ts.createProgram(files,{allowJs:true,checkJs:true,noEmit:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,skipLibCheck:true,types:[]});
 const undeclared=ts.getPreEmitDiagnostics(program).filter(item=>item.code===2304||item.code===2552).map(item=>{
  const at=item.file&&item.start!==undefined?item.file.getLineAndCharacterOfPosition(item.start):undefined;
  return `${item.file?.fileName.slice(applications.length+1)}:${at?at.line+1:0} ${ts.flattenDiagnosticMessageText(item.messageText,' ')}`;
 });
 assert.deepEqual(undeclared,[]);
});
