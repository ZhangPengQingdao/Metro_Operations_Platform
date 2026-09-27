/** Node-side image persistence for isolated apps using their own managed-storage schema. */
import {createHash} from 'node:crypto';
import {createAppDataClient, type AppDataMutation, type createAppGatewayClient} from './app-gateway.js';
import type {AppBackendEmployeeContext} from './app-backend.js';
import {APP_IMAGE_MAX_BYTES,APP_IMAGE_PART_BYTES} from './app-files.js';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const fail = (code: string): never => { throw Error(code); };
const base64 = (value: unknown): value is string => typeof value === 'string' && value.length <= 30_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
const jpeg = (bytes: Buffer) => bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
type Employee = Readonly<AppBackendEmployeeContext>;
export interface ManagedAppImageRow {
  id: string; organization_id: string; created_by: string; created_at: string;
  kind: string; mime: 'image/jpeg'; bytes: number; sha256: string; parts: number;
  ready: boolean; record_id: string | null;
}
export interface ManagedAppImageOptions {
  /** Check app-specific create/update permission for this organization on every upload step. */
  authorizeWrite(employee: Employee, organizationId: string, signal?: AbortSignal): void | Promise<void>;
  /** Check the record's read permission and that the requested image is linked to it. */
  resolveRead(employee: Employee, recordId: string, photoId: string, signal?: AbortSignal): Promise<{organizationId: string}>;
  clock?: () => Date;
}
type ImageMigrationOperation =
  | {kind:'createTable';table:string;columns:{name:string;type:'uuid'|'timestamptz'|'text'|'integer'|'boolean';nullable:boolean}[];primaryKey:string[]}
  | {kind:'createIndex';table:string;name:string;columns:string[];unique:boolean};

/** Merge these operations into the app's declarative migration. Tables remain private to each app. */
export function createAppImageMigrationOperations(): ImageMigrationOperation[] {
  return [
    {kind:'createTable',table:'photos',columns:[
      {name:'id',type:'uuid',nullable:false},{name:'organization_id',type:'uuid',nullable:false},
      {name:'created_by',type:'uuid',nullable:false},{name:'created_at',type:'timestamptz',nullable:false},
      {name:'kind',type:'text',nullable:false},{name:'mime',type:'text',nullable:false},
      {name:'bytes',type:'integer',nullable:false},{name:'sha256',type:'text',nullable:false},
      {name:'parts',type:'integer',nullable:false},{name:'ready',type:'boolean',nullable:false},
      {name:'record_id',type:'uuid',nullable:true}
    ],primaryKey:['id']},
    {kind:'createTable',table:'photo_parts',columns:[
      {name:'id',type:'uuid',nullable:false},{name:'photo_id',type:'uuid',nullable:false},
      {name:'organization_id',type:'uuid',nullable:false},{name:'created_by',type:'uuid',nullable:false},
      {name:'part_index',type:'integer',nullable:false},{name:'data',type:'text',nullable:false}
    ],primaryKey:['id']},
    {kind:'createIndex',table:'photo_parts',name:'photo_parts_photo_idx',columns:['photo_id','part_index'],unique:true}
  ];
}

/** Each upload is staged; link() is included in the app's record transaction. Unknown writes are never replayed. */
export function createManagedAppImageStore(gateway: Pick<ReturnType<typeof createAppGatewayClient>,'invoke'>, options: ManagedAppImageOptions) {
  if (!options || typeof options.authorizeWrite !== 'function' || typeof options.resolveRead !== 'function') fail('INVALID_IMAGE_OPTIONS');
  const data = createAppDataClient(gateway), clock = options.clock ?? (() => new Date());
  const photo = async (id: string, signal?: AbortSignal): Promise<ManagedAppImageRow> => {
    if (!uuid(id)) fail('INVALID_INPUT');
    const {row} = await data.get('photos', id, signal) as unknown as {row: ManagedAppImageRow | null};
    if (!row) fail('PHOTO_NOT_FOUND');
    return row as ManagedAppImageRow;
  };
  const ensureUploader = async (row: ManagedAppImageRow, employee: Employee, signal?: AbortSignal) => {
    if (row.created_by !== employee.personId || row.record_id) fail('ACCESS_DENIED');
    await options.authorizeWrite(employee, row.organization_id, signal);
  };
  async function parts(row: ManagedAppImageRow, signal?: AbortSignal): Promise<Buffer[]> {
    const found: {photo_id:string;part_index:number;data:string}[] = [], indexes = new Set<number>();
    let after: string | null = null;
    do {
      const result = await data.list('photo_parts',{filters:[{column:'photo_id',value:row.id}],pageSize:2,...(after?{afterId:after}:{})},signal) as unknown as {rows: typeof found;nextCursor:string|null};
      for (const part of result.rows) {
        if (part.photo_id !== row.id || indexes.has(part.part_index) || !base64(part.data)) fail('PHOTO_CORRUPT');
        indexes.add(part.part_index); found.push(part);
      }
      after = result.nextCursor;
    } while (after && found.length <= 16);
    if (found.length !== row.parts || found.some(part => part.part_index < 0 || part.part_index >= row.parts)) fail('PHOTO_INCOMPLETE');
    found.sort((a,b) => a.part_index - b.part_index);
    return found.map(part => Buffer.from(part.data,'base64'));
  }
  return Object.freeze({
    async begin(input: Record<string, unknown>, employee: Employee, signal?: AbortSignal) {
      if (!plain(input) || !keys(input,['requestId','id','organizationId','kind','bytes','sha256','parts']) || !uuid(input.requestId) || !uuid(input.id) || !uuid(input.organizationId)
        || typeof input.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.kind) || !Number.isInteger(input.bytes) || (input.bytes as number) < 1 || (input.bytes as number) > APP_IMAGE_MAX_BYTES
        || !Number.isInteger(input.parts) || (input.parts as number) < 1 || (input.parts as number) > 16 || input.parts !== Math.ceil((input.bytes as number) / APP_IMAGE_PART_BYTES)
        || typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) fail('INVALID_INPUT');
      await options.authorizeWrite(employee,input.organizationId as string,signal);
      await data.transaction(input.requestId as string,[{action:'insert',table:'photos',id:input.id as string,values:{organization_id:input.organizationId as string,created_by:employee.personId,created_at:clock().toISOString(),kind:input.kind as string,mime:'image/jpeg',bytes:input.bytes as number,sha256:input.sha256 as string,parts:input.parts as number,ready:false,record_id:null}}],signal);
      return {id:input.id};
    },
    async part(input: Record<string, unknown>, employee: Employee, signal?: AbortSignal) {
      if (!plain(input) || !keys(input,['requestId','id','photoId','index','data']) || !uuid(input.requestId) || !uuid(input.id) || !uuid(input.photoId) || !Number.isInteger(input.index) || !base64(input.data)) fail('INVALID_INPUT');
      const row = await photo(input.photoId as string,signal); await ensureUploader(row,employee,signal);
      if (row.ready || (input.index as number) < 0 || (input.index as number) >= row.parts) fail('INVALID_INPUT');
      const bytes = Buffer.from(input.data as string,'base64');
      if (bytes.toString('base64') !== input.data || bytes.length < 1 || bytes.length > APP_IMAGE_PART_BYTES || (input.index as number) < row.parts-1 && bytes.length !== APP_IMAGE_PART_BYTES) fail('INVALID_INPUT');
      await data.transaction(input.requestId as string,[{action:'insert',table:'photo_parts',id:input.id as string,values:{photo_id:row.id,organization_id:row.organization_id,created_by:employee.personId,part_index:input.index as number,data:input.data as string}}],signal);
      return {index:input.index};
    },
    async finish(input: Record<string, unknown>, employee: Employee, signal?: AbortSignal) {
      if (!plain(input) || !keys(input,['requestId','photoId']) || !uuid(input.requestId) || !uuid(input.photoId)) fail('INVALID_INPUT');
      const row = await photo(input.photoId as string,signal); await ensureUploader(row,employee,signal);
      if (row.ready) fail('CONFLICT');
      const bytes = Buffer.concat(await parts(row,signal));
      if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256 || !jpeg(bytes)) fail('PHOTO_CORRUPT');
      await data.transaction(input.requestId as string,[{action:'update',table:'photos',id:row.id,expected:{ready:false,record_id:null},values:{ready:true}}],signal);
      return {id:row.id};
    },
    async read(input: Record<string, unknown>, employee: Employee, signal?: AbortSignal) {
      if (!plain(input) || !keys(input,['recordId','photoId','index']) || !uuid(input.recordId) || !uuid(input.photoId) || !Number.isInteger(input.index) || (input.index as number) < 0 || (input.index as number) > 15) fail('INVALID_INPUT');
      const access = await options.resolveRead(employee,input.recordId as string,input.photoId as string,signal);
      const row = await photo(input.photoId as string,signal);
      if (!uuid(access?.organizationId) || !row.ready || row.record_id !== input.recordId || row.organization_id !== access.organizationId || (input.index as number) >= row.parts) fail('ACCESS_DENIED');
      const result = await data.list('photo_parts',{filters:[{column:'photo_id',value:row.id},{column:'part_index',value:input.index as number}],pageSize:1},signal) as unknown as {rows:{photo_id:string;part_index:number;data:string}[]};
      const part = result.rows[0]; if (!part || part.photo_id !== row.id || part.part_index !== input.index || !base64(part.data)) fail('PHOTO_CORRUPT');
      return {data:part!.data,index:input.index,parts:row.parts,mime:row.mime,bytes:row.bytes,sha256:row.sha256};
    },
    async requireReady(id: string, kind: string, employee: Employee, organizationId: string, recordId: string, signal?: AbortSignal) {
      const row = await photo(id,signal);
      if (!row.ready || row.kind !== kind || row.organization_id !== organizationId || row.created_by !== employee.personId || row.record_id && row.record_id !== recordId) fail('INVALID_PHOTO');
      return row;
    },
    link(row: ManagedAppImageRow, recordId: string): AppDataMutation {
      if (!uuid(recordId)) fail('INVALID_INPUT');
      return {action:'update',table:'photos',id:row.id,expected:{record_id:row.record_id,ready:true},values:{record_id:recordId}};
    }
  });
}
