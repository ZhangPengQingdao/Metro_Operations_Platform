import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectablePool, QueryableClient } from '../../core/database/index.js';
import type { PlatformActorContext } from '../../platform/context/index.js';
import type { AppInstallation } from '../registry/index.js';
import { GatewayError, jsonSnapshot, type AppGatewayOperation, type GatewayJson } from '../gateway/model.js';
import { readBatchInput, readInput, transactionInput, transactionItem, validValue, writeInput } from './data-input.js';
import { runtimeCountQuery, runtimeDailyCountQuery, runtimeListInput, runtimeListQuery, runtimeListSelection } from './data-query.js';
import { appSchemaName } from './migration.js';

type Mode = 'get' | 'write' | 'list' | 'read_batch' | 'transaction';
type Item = z.infer<typeof readInput> | z.infer<typeof runtimeListInput> | z.infer<typeof transactionItem>;
const q = (value: string) => `"${value}"`; // Only validated identifiers reach SQL text.
const SUPPORTED_TYPES = ['uuid', 'text', 'bool', 'int4', 'jsonb', 'date', 'timestamptz'];
const ROW_BYTES = 32768, RESULT_BYTES = 60000;
const OPERATIONS: { name: string; mode: Mode; write: boolean; schema: z.ZodTypeAny }[] = [
  { name: 'platform.app_data.get', mode: 'get', write: false, schema: readInput },
  { name: 'platform.app_data.write', mode: 'write', write: true, schema: writeInput },
  { name: 'platform.app_data.list', mode: 'list', write: false, schema: runtimeListInput },
  { name: 'platform.app_data.read_batch', mode: 'read_batch', write: false, schema: readBatchInput },
  { name: 'platform.app_data.transaction', mode: 'transaction', write: true, schema: transactionInput },
];

export interface AppDataV2Options {
  pool: ConnectablePool;
  /** Current registry record; the service only serves enabled v2 installations. */
  findInstallation(appId: string): Promise<AppInstallation | null>;
}

/**
 * Application model v2 data access: one pooled connection and one transaction per call.
 * The platform owns the schema; applications never receive SQL access or credentials.
 * Writes carry a requestId: a repeat returns the first committed result without writing again, so retries are safe.
 */
export class AppDataServiceV2 {
  private readonly columnCache = new Map<string, { columns: Map<string, string>; expires: number }>();
  private writesSincePrune = 0;
  constructor(private readonly options: AppDataV2Options) {}

  /** Gateway operations (`platform.app_data.*`) for the calling application. */
  operations(): AppGatewayOperation[] {
    return OPERATIONS.map(op => ({
      name: op.name, permissionCode: op.write ? 'platform.app_data.write' : 'platform.app_data.read', mode: op.write ? 'write' : 'read',
      validateParams: value => op.schema.safeParse(value).success && Buffer.byteLength(JSON.stringify(value)) <= 16384,
      resolveResources: async context => { requireService(context); return [{}]; },
      validateResult: () => true,
      execute: async (context, params, signal) => {
        requireService(context);
        const installation = await this.options.findInstallation(context.execution.appId!);
        if (installation?.runtime?.model !== 'v2') throw new GatewayError('ACCESS_DENIED', 403);
        return this.execute(context, installation, op.mode, params, signal);
      },
    }));
  }

  async execute(context: PlatformActorContext, installation: AppInstallation, mode: Mode, input: unknown, signal: AbortSignal): Promise<GatewayJson> {
    requireService(context);
    if (!installation.enabled || installation.appId !== context.execution.appId) throw new GatewayError('ACCESS_DENIED', 403);
    const write = mode === 'write' || mode === 'transaction';
    if (!(await context.authorize(write ? 'platform.app_data.write' : 'platform.app_data.read', {})).allowed) throw new GatewayError('ACCESS_DENIED', 403);
    const parsed = OPERATIONS.find(op => op.mode === mode)!.schema.parse(input);
    const schema = appSchemaName(installation.id);
    const client = await this.options.pool.connect();
    let open = false, committing = false;
    const check = () => { if (signal.aborted) throw new GatewayError('ABORTED', 499); };
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY'); open = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      const tables = mode === 'transaction' || mode === 'read_batch' ? (parsed as { operations: { table: string }[] }).operations.map(item => item.table) : [(parsed as { table: string }).table];
      const columnSets = new Map<string, Map<string, string>>();
      for (const table of new Set(tables)) columnSets.set(table, await this.columns(client, installation, schema, table));
      const items: Item[] = mode === 'transaction' ? (parsed as z.infer<typeof transactionInput>).operations : mode === 'write' ? [parsed as z.infer<typeof transactionItem>] : [];
      for (const item of items) {
        const columns = columnSets.get(item.table)!;
        const values = Object.entries({ ...('values' in item ? item.values ?? {} : {}), ...('expected' in item ? item.expected ?? {} : {}) });
        if (values.some(([name, value]) => name === 'id' || !columns.has(name) || !validValue(columns.get(name)!, value))) throw new GatewayError('INVALID_PARAMS');
      }

      const requestId = write ? (parsed as { requestId: string }).requestId : undefined;
      if (requestId) {
        const digest = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
        const inserted = await rows(client, 'INSERT INTO platform_app_v2_requests(installation_id,request_id,request_digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id', [installation.id, requestId, digest]);
        if (!inserted.length) {
          const [previous] = await rows<{ request_digest: string; result: GatewayJson | null }>(client, 'SELECT request_digest,result FROM platform_app_v2_requests WHERE installation_id=$1 AND request_id=$2', [installation.id, requestId]);
          await client.query('ROLLBACK'); open = false;
          // The requestId names the write intent: a retry (even with regenerated row ids) gets the first result and writes nothing.
          if (!previous || previous.result === null) throw new GatewayError('REQUEST_ID_REUSED', 409, 'not_started');
          return previous.result;
        }
      }
      check();

      let resultBytes = 0;
      const charge = (received: { text: string; bytes: number }[], max: number) => {
        resultBytes += received.reduce((sum, row) => sum + row.bytes, 0);
        if (received.length > max || received.some(row => row.bytes > ROW_BYTES) || resultBytes > RESULT_BYTES) throw new GatewayError('STORAGE_RESULT_LIMIT', 413);
        return received.map(row => JSON.parse(row.text) as Record<string, GatewayJson>);
      };
      const statement = async (item: Item, mutation: boolean) => {
        check();
        const table = `${q(schema)}.${q(item.table)}`, columns = columnSets.get(item.table)!;
        const listing = 'pageSize' in item ? runtimeListQuery(item, columns) : undefined;
        let sql = `SELECT t.* FROM ${table} t WHERE id=$1`, values: unknown[] = ['id' in item ? item.id : undefined];
        if (listing) { sql = `SELECT ${runtimeListSelection(item as z.infer<typeof runtimeListInput>, columns)} FROM ${table} t${listing.suffix}`; values = listing.values; }
        if (mutation && 'action' in item) {
          const entries = Object.entries(item.values ?? {});
          const encode = (key: string, value: unknown) => columns.get(key) === 'jsonb' && value !== null ? JSON.stringify(value) : value;
          values = [item.id, ...entries.map(([key, value]) => encode(key, value))];
          let where = 'id=$1';
          for (const [key, value] of Object.entries('expected' in item ? item.expected ?? {} : {})) {
            values.push(encode(key, value)); where += ` AND ${q(key)} IS NOT DISTINCT FROM $${values.length}::${columns.get(key)}`;
          }
          if (item.action === 'insert') sql = `INSERT INTO ${table} (${['id', ...entries.map(([key]) => key)].map(q).join(',')}) VALUES (${values.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`;
          if (item.action === 'update') sql = `UPDATE ${table} SET ${entries.map(([key], i) => `${q(key)}=$${i + 2}`).join(',')} WHERE ${where} RETURNING *`;
          if (item.action === 'delete') sql = `DELETE FROM ${table} WHERE ${where} RETURNING *`;
        }
        const received = await rows<{ text: string; bytes: number }>(client, `WITH r AS (${sql}) SELECT left(row_to_json(r)::text,${ROW_BYTES + 1}) AS text,octet_length(row_to_json(r)::text) AS bytes FROM r`, values);
        const result = charge(received, listing ? (item as z.infer<typeof runtimeListInput>).pageSize + 1 : 1);
        if (mutation && result.length !== 1) throw new GatewayError('STORAGE_CONFLICT', 409, 'not_started');
        return result;
      };
      const page = (item: z.infer<typeof runtimeListInput>, result: Record<string, GatewayJson>[]) => {
        const rowsOut = result.slice(0, item.pageSize), last = rowsOut[rowsOut.length - 1];
        return { rows: rowsOut, nextCursor: result.length > item.pageSize && last ? (item.order ? { id: last.id!, value: String(last[item.order.column]) } : last.id!) : null };
      };

      let output: GatewayJson;
      if (mode === 'read_batch') {
        const results: GatewayJson[] = [];
        for (const item of (parsed as z.infer<typeof readBatchInput>).operations) {
          const table = `${q(schema)}.${q(item.table)}`, columns = columnSets.get(item.table)!;
          if ('kind' in item && item.kind === 'daily_count') {
            const daily = runtimeDailyCountQuery(item, columns);
            const days = (await rows<{ day: string; count: string }>(client, `SELECT ${daily.select} FROM ${table}${daily.suffix}`, daily.values)).map(row => ({ day: row.day, count: Number(row.count) }));
            if (days.length > item.days || days.some(row => !Number.isSafeInteger(row.count))) throw new GatewayError('STORAGE_RESULT_LIMIT', 413);
            results.push({ days });
          } else if ('kind' in item && item.kind === 'count') {
            const count = runtimeCountQuery(item, columns);
            const [row] = await rows<{ count: string }>(client, `SELECT count(*)::text AS count FROM ${table}${count.suffix}`, count.values);
            results.push({ count: Number(row?.count ?? 0) });
          } else if ('ids' in item) {
            const received = await rows<{ text: string; bytes: number }>(client, `SELECT left(row_to_json(t)::text,${ROW_BYTES + 1}) AS text,octet_length(row_to_json(t)::text) AS bytes FROM ${table} t WHERE id=ANY($1::uuid[]) ORDER BY id`, [item.ids]);
            results.push({ rows: charge(received, item.ids.length) });
          } else if ('pageSize' in item) results.push(page(item, await statement(item, false)));
          else results.push({ row: (await statement(item, false))[0] ?? null });
        }
        output = jsonSnapshot({ results }, 65536);
      } else if (mode === 'transaction') {
        const results: GatewayJson[] = [];
        for (const item of (parsed as z.infer<typeof transactionInput>).operations) results.push({ row: (await statement(item, true))[0]! });
        output = jsonSnapshot({ results }, 65536);
      } else if (mode === 'list') output = jsonSnapshot(page(parsed as z.infer<typeof runtimeListInput>, await statement(parsed as Item, false)), 65536);
      else output = jsonSnapshot({ row: (await statement(parsed as Item, mode === 'write'))[0] ?? null }, 65536);

      if (requestId) await client.query('UPDATE platform_app_v2_requests SET result=$3 WHERE installation_id=$1 AND request_id=$2', [installation.id, requestId, JSON.stringify(output)]);
      check();
      committing = true;
      await client.query('COMMIT'); open = false;
      if (write && ++this.writesSincePrune >= 500) { this.writesSincePrune = 0; void this.prune(); }
      return output;
    } catch (error) {
      if (open) { try { await client.query('ROLLBACK'); } catch { /* connection is discarded below */ } }
      if (error instanceof GatewayError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === '23505' || code === '23503' || code === '23502') throw new GatewayError('STORAGE_CONFLICT', 409, 'not_started');
      if (code === '57014' || code === '55P03') throw new GatewayError('STORAGE_BUSY', 503, 'not_started');
      // A failed COMMIT may or may not have applied; the requestId makes a retry safe.
      throw new GatewayError('STORAGE_OPERATION_FAILED', 503, committing ? 'unknown' : 'not_started');
    } finally {
      client.release();
    }
  }

  private async columns(client: QueryableClient, installation: AppInstallation, schema: string, table: string) {
    const key = `${installation.id}:${installation.revision}:${table}`;
    const cached = this.columnCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.columns;
    const found = await rows<{ name: string; type: string; builtin: boolean }>(client, `SELECT a.attname AS name,t.typname AS type,t.typnamespace='pg_catalog'::regnamespace AS builtin
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`, [schema, table]);
    if (!found.length || !found.some(c => c.name === 'id' && c.type === 'uuid') || found.some(c => !c.builtin || !SUPPORTED_TYPES.includes(c.type))) throw new GatewayError('STORAGE_TABLE_UNSUPPORTED', 400);
    const columns = new Map(found.map(c => [c.name, c.type]));
    this.columnCache.set(key, { columns, expires: Date.now() + 60_000 });
    if (this.columnCache.size > 512) this.columnCache.delete(this.columnCache.keys().next().value!);
    return columns;
  }

  /** Idempotency keys only need to outlive client retries. */
  private async prune() {
    const client = await this.options.pool.connect().catch(() => null);
    if (!client) return;
    try { await client.query("DELETE FROM platform_app_v2_requests WHERE created_at<now()-interval '7 days'"); } catch { /* retried on a later prune */ } finally { client.release(); }
  }
}

function requireService(context: PlatformActorContext): asserts context is Extract<PlatformActorContext, { actorType: 'service' }> {
  if (context.actorType !== 'service' || context.execution.type !== 'service') throw new GatewayError('ACCESS_DENIED', 403);
}
async function rows<T = Record<string, unknown>>(client: QueryableClient, sql: string, values?: readonly unknown[]): Promise<T[]> {
  return ((await client.query(sql, values)) as { rows: T[] }).rows;
}
