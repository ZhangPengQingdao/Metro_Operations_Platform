import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MigrationDefinition } from '../migrations/index.js';
import { getDatabasePool, runDatabaseTransaction, type ConnectablePool, type QueryableClient } from '../database/index.js';

export const ADMIN_SESSION_COOKIE = 'afc_admin_session';
export const ADMIN_IDENTITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS platform_admin_accounts (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, display_name text NOT NULL,
 password_hash text NOT NULL, status text NOT NULL CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_admin_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform_admin_accounts(id),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_admin_sessions_account ON platform_admin_sessions(account_id);
CREATE TABLE IF NOT EXISTS platform_admin_audit (
 id uuid PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL,
 target_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
`;
export const adminIdentityMigration: MigrationDefinition = {
 id: 'platform-admin-identity-expand', title: 'Independent platform administrator identity', ownerTaskId: 'PLATFORM-L4-014',
 phase: 'expand', layer: 'L1', dataRows: [], migrationRows: ['MIG-052'], sourceTables: [],
 targetTables: ['platform_admin_accounts', 'platform_admin_sessions', 'platform_admin_audit'],
 recoveryNotes: 'Transactional schema expansion only. Keep administrator accounts and audit records; no automatic rollback or bootstrap.',
 async run({ client }) { await runDatabaseTransaction(client, async () => { await client.query(ADMIN_IDENTITY_MIGRATION); }); return { applied: true }; }
};
export async function appendAdminAudit(db: QueryableClient, event: { actorId: string; action: string; targetId: string }): Promise<void> {
 await db.query('INSERT INTO platform_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)', [randomUUID(), event.actorId, event.action, event.targetId]);
}
export interface AdminAccount { id: string; username: string; displayName: string; status: 'active' | 'disabled' }
type AccountRow = { id: string; username: string; display_name: string; password_hash: string; status: 'active' | 'disabled' };
const publicAccount = (row: AccountRow): AdminAccount => ({ id: row.id, username: row.username, displayName: row.display_name, status: row.status });
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const username = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/).transform(v => v.toLowerCase());
const password = z.string().min(12).refine(v => Buffer.byteLength(v, 'utf8') <= 72, 'Password exceeds bcrypt limit');
const accountInput = z.object({ username, displayName: z.string().trim().min(1).max(80), password }).strict();
export class AdminIdentityError extends Error {
 constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
async function rows<T>(db: QueryableClient, sql: string, args: readonly unknown[] = []): Promise<T[]> {
 return (await db.query(sql, args) as { rows: T[] }).rows;
}
export class AdminIdentityService {
 constructor(private readonly pool: ConnectablePool, private readonly sessionMs = 8 * 60 * 60 * 1000) {}
 private async transaction<T>(operation: (db: QueryableClient) => Promise<T>): Promise<T> {
  const db = await this.pool.connect();
  try { return await runDatabaseTransaction(db, async () => {
   // Serialize account/session changes across all server replicas, including bootstrap.
   await db.query("SELECT pg_advisory_xact_lock(6013014)");
   return operation(db);
  }); } finally { db.release(); }
 }
 private async identity(db: QueryableClient, token?: string): Promise<AccountRow | undefined> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return (await rows<AccountRow>(db, `SELECT a.* FROM platform_admin_accounts a JOIN platform_admin_sessions s ON s.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at > now() AND a.status='active'`, [digest(token)]))[0];
 }
 private async require(db: QueryableClient, token: string): Promise<AccountRow> {
  const account = await this.identity(db, token);
  if (!account) throw new AdminIdentityError(401, 'ADMIN_AUTH_REQUIRED');
  return account;
 }
 async authenticate(token?: string): Promise<AdminAccount | null> {
  const db = await this.pool.connect();
  try { const row = await this.identity(db, token); return row ? publicAccount(row) : null; } finally { db.release(); }
 }
 async bootstrap(input: unknown): Promise<AdminAccount> {
  const parsed = accountInput.parse(input); const hash = await bcrypt.hash(parsed.password, 12);
  return this.transaction(async db => {
   if ((await rows(db, 'SELECT id FROM platform_admin_accounts LIMIT 1')).length) throw new AdminIdentityError(409, 'ADMIN_ALREADY_INITIALIZED');
   const account = await this.insert(db, parsed, hash);
   await appendAdminAudit(db, { actorId: account.id, action: 'admin.bootstrap', targetId: account.id });
   return account;
  });
 }
 private async insert(db: QueryableClient, input: z.infer<typeof accountInput>, hash: string): Promise<AdminAccount> {
  if ((await rows(db, 'SELECT id FROM platform_admin_accounts WHERE username=$1', [input.username])).length) throw new AdminIdentityError(409, 'ADMIN_USERNAME_EXISTS');
  const [row] = await rows<AccountRow>(db, `INSERT INTO platform_admin_accounts(id,username,display_name,password_hash,status) VALUES($1,$2,$3,$4,'active') RETURNING *`, [randomUUID(), input.username, input.displayName, hash]);
  return publicAccount(row);
 }
 async login(input: unknown): Promise<{ account: AdminAccount; token: string }> {
  const parsed = z.object({ username, password: z.string().max(256) }).strict().parse(input);
  const connection = await this.pool.connect();
  let candidate: AccountRow | undefined;
  try { [candidate] = await rows<AccountRow>(connection, 'SELECT * FROM platform_admin_accounts WHERE username=$1', [parsed.username]); }
  finally { connection.release(); }
  const valid = await bcrypt.compare(parsed.password, candidate?.password_hash ?? '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
  if (!valid || !candidate || candidate.status !== 'active') throw new AdminIdentityError(401, 'ADMIN_LOGIN_FAILED');
  const verified = candidate;
  return this.transaction(async db => {
   const [row] = await rows<AccountRow>(db, 'SELECT * FROM platform_admin_accounts WHERE username=$1', [parsed.username]);
   if (!row || row.status !== 'active' || row.password_hash !== verified.password_hash || row.id !== verified.id) throw new AdminIdentityError(401, 'ADMIN_LOGIN_FAILED');
   const token = randomBytes(32).toString('hex');
   await db.query('DELETE FROM platform_admin_sessions WHERE expires_at <= now()');
   await db.query('INSERT INTO platform_admin_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [digest(token), row.id, new Date(Date.now() + this.sessionMs)]);
   await appendAdminAudit(db, { actorId: row.id, action: 'admin.login', targetId: row.id });
   return { account: publicAccount(row), token };
  });
 }
 async logout(token: string): Promise<void> { await this.transaction(async db => { await db.query('DELETE FROM platform_admin_sessions WHERE token_hash=$1', [digest(token)]); }); }
 async changePassword(token: string, input: unknown): Promise<void> {
  const parsed = z.object({ currentPassword: z.string().max(256), newPassword: password }).strict().parse(input);
  if (!await this.authenticate(token)) throw new AdminIdentityError(401, 'ADMIN_AUTH_REQUIRED');
  const hash = await bcrypt.hash(parsed.newPassword, 12);
  await this.transaction(async db => {
   const account = await this.require(db, token);
   if (!await bcrypt.compare(parsed.currentPassword, account.password_hash)) throw new AdminIdentityError(403, 'ADMIN_PASSWORD_INCORRECT');
   await db.query('UPDATE platform_admin_accounts SET password_hash=$1 WHERE id=$2', [hash, account.id]);
   await db.query('DELETE FROM platform_admin_sessions WHERE account_id=$1', [account.id]);
   await appendAdminAudit(db, { actorId: account.id, action: 'admin.password-change', targetId: account.id });
  });
 }
 async list(token: string): Promise<AdminAccount[]> { return this.transaction(async db => { await this.require(db, token); return (await rows<AccountRow>(db, 'SELECT * FROM platform_admin_accounts ORDER BY created_at,id LIMIT 1000')).map(publicAccount); }); }
 async create(token: string, input: unknown): Promise<AdminAccount> {
  if (!await this.authenticate(token)) throw new AdminIdentityError(401, 'ADMIN_AUTH_REQUIRED');
  const parsed = accountInput.parse(input); const hash = await bcrypt.hash(parsed.password, 12);
  return this.transaction(async db => {
   const actor = await this.require(db, token); const account = await this.insert(db, parsed, hash);
   await appendAdminAudit(db, { actorId: actor.id, action: 'admin.create', targetId: account.id });
   return account;
  });
 }
 async update(token: string, id: string, input: unknown): Promise<AdminAccount> {
  z.string().uuid().parse(id);
  const parsed = z.object({ status: z.enum(['active', 'disabled']).optional(), displayName: z.string().trim().min(1).max(80).optional() }).strict().refine(v => v.status !== undefined || v.displayName !== undefined).parse(input);
  return this.transaction(async db => {
   const actor = await this.require(db, token);
   const [target] = await rows<AccountRow>(db, 'SELECT * FROM platform_admin_accounts WHERE id=$1', [id]);
   if (!target) throw new AdminIdentityError(404, 'ADMIN_NOT_FOUND');
   if (parsed.status === 'disabled') {
    if (actor.id === id) throw new AdminIdentityError(409, 'ADMIN_CANNOT_DISABLE_SELF');
    if (target.status === 'active' && (await rows(db, "SELECT id FROM platform_admin_accounts WHERE status='active'")).length <= 1) throw new AdminIdentityError(409, 'ADMIN_LAST_ACCOUNT');
   }
   const [result] = await rows<AccountRow>(db, 'UPDATE platform_admin_accounts SET status=$1,display_name=$2 WHERE id=$3 RETURNING *', [parsed.status ?? target.status, parsed.displayName ?? target.display_name, id]);
   if (parsed.status === 'disabled') await db.query('DELETE FROM platform_admin_sessions WHERE account_id=$1', [id]);
   await appendAdminAudit(db, { actorId: actor.id, action: 'admin.update', targetId: id });
   return publicAccount(result);
  });
 }
}
export function createProductionAdminIdentityService(pool: ConnectablePool | null = getDatabasePool()): AdminIdentityService {
 if (!pool) throw new AdminIdentityError(503, 'ADMIN_DATABASE_UNAVAILABLE');
 return new AdminIdentityService(pool);
}
export function registerAdminIdentityRoutes(app: FastifyInstance, options: { origin: string; service: AdminIdentityService }): void {
 const origin = new URL(options.origin);
 if (origin.origin !== options.origin || !['http:', 'https:'].includes(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('ADMIN_CANONICAL_ORIGIN_REQUIRED');
 const cookie = { httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'strict' as const, path: '/api/admin' };
 const attempts = new Map<string, { count: number; until: number }>();
 app.register(async scoped => {
  scoped.setErrorHandler((error, _request, reply) => {
   if (error instanceof z.ZodError) return reply.code(400).send({ error: 'ADMIN_INVALID_INPUT' });
   if (error instanceof AdminIdentityError) return reply.code(error.statusCode).send({ error: error.code });
   return reply.code(503).send({ error: 'ADMIN_SERVICE_UNAVAILABLE' });
  });
  scoped.addHook('preHandler', async (request, reply) => {
   reply.header('Cache-Control', 'no-store');
   if (request.method !== 'GET' && request.headers.origin !== options.origin) throw new AdminIdentityError(403, 'ADMIN_ORIGIN_DENIED');
   if (request.url.split('?')[0] === '/api/admin/auth/login') {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const entry = attempts.get(request.ip) ?? { count: 0, until: now + 60_000 };
    if (attempts.size >= 10000 && !attempts.has(request.ip)) throw new AdminIdentityError(429, 'ADMIN_RATE_LIMIT');
    attempts.set(request.ip, entry);
    if (++entry.count > 5) throw new AdminIdentityError(429, 'ADMIN_RATE_LIMIT');
   } else if (!await options.service.authenticate(request.cookies[ADMIN_SESSION_COOKIE])) throw new AdminIdentityError(401, 'ADMIN_AUTH_REQUIRED');
  });
  scoped.post('/auth/login', { bodyLimit: 4096 }, async (req, reply) => {
   const result = await options.service.login(req.body);
   reply.setCookie(ADMIN_SESSION_COOKIE, result.token, { ...cookie, maxAge: 8 * 60 * 60 });
   return result.account;
  });
  scoped.get('/auth/me', async req => options.service.authenticate(req.cookies[ADMIN_SESSION_COOKIE]));
  scoped.post('/auth/logout', async (req, reply) => { await options.service.logout(req.cookies[ADMIN_SESSION_COOKIE]!); reply.clearCookie(ADMIN_SESSION_COOKIE, cookie); return { ok: true }; });
  scoped.patch('/auth/password', { bodyLimit: 4096 }, async (req, reply) => { await options.service.changePassword(req.cookies[ADMIN_SESSION_COOKIE]!, req.body); reply.clearCookie(ADMIN_SESSION_COOKIE, cookie); return { ok: true }; });
  scoped.get('/accounts', async req => ({ accounts: await options.service.list(req.cookies[ADMIN_SESSION_COOKIE]!) }));
  scoped.post('/accounts', { bodyLimit: 4096 }, async (req, reply) => reply.code(201).send(await options.service.create(req.cookies[ADMIN_SESSION_COOKIE]!, req.body)));
  scoped.patch<{ Params: { id: string } }>('/accounts/:id', { bodyLimit: 4096 }, async req => options.service.update(req.cookies[ADMIN_SESSION_COOKIE]!, req.params.id, req.body));
 }, { prefix: '/api/admin' });
}
