import {Readable} from 'node:stream';

/** Stored ZIP entries: lossless and streaming, including nested per-record ZIPs. No source is unpacked. */
export interface ZipEntry {name:string;size:number;open():Promise<Readable>}
const crcTable=Array.from({length:256},(_,value)=>{let crc=value;for(let i=0;i<8;i++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;});
const nameBytes=(name:string)=>{if(!name||Buffer.byteLength(name)>1024||name.split('/').some(part=>part==='..')||name.startsWith('/')||/[\\\u0000-\u001f]/.test(name))throw Error('INVALID_ARCHIVE_NAME');return Buffer.from(name);};
export function zipSize(entries:readonly Pick<ZipEntry,'name'|'size'>[]){return entries.reduce((total,entry)=>total+30+nameBytes(entry.name).length+entry.size+16+46+nameBytes(entry.name).length,22);}
export function zipStream(entries:readonly ZipEntry[],signal?:AbortSignal):Readable{
 return Readable.from((async function*(){
  let offset=0;const central:Buffer[]=[];
  for(const entry of entries){
   if(signal?.aborted)throw Error('ABORTED');const name=nameBytes(entry.name),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x808,6);header.writeUInt16LE(0x21,12);header.writeUInt16LE(name.length,26);const start=offset;yield header;yield name;offset+=30+name.length;
   let crc=0xffffffff,size=0;const source=await entry.open();const abort=()=>source.destroy(Error('ABORTED'));signal?.addEventListener('abort',abort,{once:true});
   try{for await(const chunk of source){if(signal?.aborted)throw Error('ABORTED');const bytes=Buffer.from(chunk);size+=bytes.length;if(size>entry.size||offset+size>0xffffffff)throw Error('ARCHIVE_SIZE_MISMATCH');for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);yield bytes;}}finally{signal?.removeEventListener('abort',abort);source.destroy();}
   if(size!==entry.size)throw Error('ARCHIVE_SIZE_MISMATCH');crc=(crc^0xffffffff)>>>0;offset+=size;
   const descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(size,8);descriptor.writeUInt32LE(size,12);yield descriptor;offset+=16;
   const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x808,8);directory.writeUInt16LE(0x21,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(size,20);directory.writeUInt32LE(size,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(start,42);central.push(directory,name);
  }
  const centralOffset=offset;for(const bytes of central){yield bytes;offset+=bytes.length;}
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(offset-centralOffset,12);end.writeUInt32LE(centralOffset,16);yield end;
 })());
}
