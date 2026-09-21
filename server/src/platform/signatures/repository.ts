import { runDatabaseTransaction, type AtomicParticipant, type QueryableClient } from '../../core/database/index.js';
import {
  SignatureError,
  type SignatureEvidence,
  type SignatureListInput,
  type SignatureOperationHistory,
  type SignaturePosition,
  type SignatureRequest,
  type SignatureSession,
  type SignatureSigner
} from './model.js';

export interface SignatureRepository extends AtomicParticipant {
  createRequest(
    request: SignatureRequest,
    session: SignatureSession,
    signers: readonly SignatureSigner[],
    positions: readonly SignaturePosition[]
  ): Promise<SignatureRequest>;
  updateRequest(record: SignatureRequest): Promise<SignatureRequest>;
  findRequestById(id: string, lock?: 'share' | 'update'): Promise<SignatureRequest | null>;
  findRequestByKey(sourceAppId: string, signatureKey: string): Promise<SignatureRequest | null>;
  findRequestByIdempotencyKey(sourceAppId: string, idempotencyKey: string): Promise<SignatureRequest | null>;
  listRequests(input?: SignatureListInput): Promise<SignatureRequest[]>;

  findSessionById(id: string): Promise<SignatureSession | null>;
  findSessionByRequestId(signatureRequestId: string): Promise<SignatureSession | null>;
  findSessionByTokenHash(publicTokenHash: string): Promise<SignatureSession | null>;
  updateSession(record: SignatureSession): Promise<SignatureSession>;

  findSignerById(id: string): Promise<SignatureSigner | null>;
  listSigners(signatureRequestId: string): Promise<SignatureSigner[]>;
  updateSigner(record: SignatureSigner): Promise<SignatureSigner>;
  addSigner(record: SignatureSigner): Promise<SignatureSigner>;
  listPositions(signatureRequestId: string): Promise<SignaturePosition[]>;

  addEvidence(record: SignatureEvidence): Promise<SignatureEvidence>;
  replaceEvidence(record: SignatureEvidence): Promise<SignatureEvidence>;
  recordSignature(
    evidence: SignatureEvidence,
    signer: SignatureSigner
  ): Promise<{ evidence: SignatureEvidence; signer: SignatureSigner }>;
  findEvidenceById(id: string): Promise<SignatureEvidence | null>;
  listEvidence(signatureRequestId: string): Promise<SignatureEvidence[]>;

  addOperationHistory(record: SignatureOperationHistory): Promise<SignatureOperationHistory>;
  listOperationHistory(signatureRequestId: string): Promise<SignatureOperationHistory[]>;
}

export interface MemorySignatureRepository extends SignatureRepository {
  records(): {
    requests: SignatureRequest[];
    sessions: SignatureSession[];
    signers: SignatureSigner[];
    positions: SignaturePosition[];
    evidence: SignatureEvidence[];
    operationHistory: SignatureOperationHistory[];
  };
}

export function createMemorySignatureRepository(seed: {
  requests?: readonly SignatureRequest[];
  sessions?: readonly SignatureSession[];
  signers?: readonly SignatureSigner[];
  positions?: readonly SignaturePosition[];
  evidence?: readonly SignatureEvidence[];
  operationHistory?: readonly SignatureOperationHistory[];
} = {}): MemorySignatureRepository {
  let requests = toMap(seed.requests);
  let sessions = toMap(seed.sessions);
  let signers = toMap(seed.signers);
  let positions = toMap(seed.positions);
  let evidence = toMap(seed.evidence);
  let operationHistory = toMap(seed.operationHistory);

  return {
    atomic: {
      snapshot() {
        const savedrequests = clone(requests);
        const savedsessions = clone(sessions);
        const savedsigners = clone(signers);
        const savedpositions = clone(positions);
        const savedevidence = clone(evidence);
        const savedoperationHistory = clone(operationHistory);
        return () => {
          requests = savedrequests;
          sessions = savedsessions;
          signers = savedsigners;
          positions = savedpositions;
          evidence = savedevidence;
          operationHistory = savedoperationHistory;
        };
      }
    },
    async createRequest(request, session, requestSigners, requestPositions) {
      assertUniqueId(requests, request.id);
      if ([...requests.values()].some((entry) => entry.sourceAppId === request.sourceAppId && entry.signatureKey === request.signatureKey)) {
        throw new SignatureError('SIGNATURE_KEY_CONFLICT', '签字请求键已存在');
      }
      if (request.idempotencyKey && [...requests.values()].some((entry) => entry.sourceAppId === request.sourceAppId && entry.idempotencyKey === request.idempotencyKey)) {
        throw new SignatureError('IDEMPOTENCY_CONFLICT', '签字请求幂等键已存在');
      }
      assertUniqueId(sessions, session.id);
      requests.set(request.id, clone(request));
      sessions.set(session.id, clone(session));
      for (const signer of requestSigners) {
        assertUniqueId(signers, signer.id);
        signers.set(signer.id, clone(signer));
      }
      for (const position of requestPositions) {
        assertUniqueId(positions, position.id);
        positions.set(position.id, clone(position));
      }
      return clone(request);
    },
    async updateRequest(record) {
      requireExisting(requests, record.id, 'SIGNATURE_REQUEST_NOT_FOUND', '签字请求不存在');
      requests.set(record.id, clone(record));
      return clone(record);
    },
    async findRequestById(id) {
      return cloneOrNull(requests.get(id));
    },
    async findRequestByKey(sourceAppId, signatureKey) {
      return cloneOrNull([...requests.values()].find((entry) => entry.sourceAppId === sourceAppId && entry.signatureKey === signatureKey));
    },
    async findRequestByIdempotencyKey(sourceAppId, idempotencyKey) {
      return cloneOrNull([...requests.values()].find((entry) => entry.sourceAppId === sourceAppId && entry.idempotencyKey === idempotencyKey));
    },
    async listRequests(input = {}) {
      return [...requests.values()]
        .filter((entry) => matchesRequest(entry, signers, input))
        .map(clone)
        .sort(compareUpdated)
        .slice(0, normalizedLimit(input.limit));
    },
    async findSessionById(id) {
      return cloneOrNull(sessions.get(id));
    },
    async findSessionByRequestId(signatureRequestId) {
      return cloneOrNull([...sessions.values()].find((entry) => entry.signatureRequestId === signatureRequestId));
    },
    async findSessionByTokenHash(publicTokenHash) {
      return cloneOrNull([...sessions.values()].find((entry) => entry.publicTokenHash === publicTokenHash));
    },
    async updateSession(record) {
      requireExisting(sessions, record.id, 'SIGNATURE_SESSION_NOT_FOUND', '签字会话不存在');
      sessions.set(record.id, clone(record));
      return clone(record);
    },
    async findSignerById(id) {
      return cloneOrNull(signers.get(id));
    },
    async listSigners(signatureRequestId) {
      return [...signers.values()].filter((entry) => entry.signatureRequestId === signatureRequestId).map(clone).sort(compareCreated);
    },
    async addSigner(record) {assertUniqueId(signers,record.id);signers.set(record.id,clone(record));return clone(record);},
    async updateSigner(record) {
      requireExisting(signers, record.id, 'SIGNER_NOT_FOUND', '签字人不存在');
      signers.set(record.id, clone(record));
      return clone(record);
    },
    async listPositions(signatureRequestId) {
      return [...positions.values()].filter((entry) => entry.signatureRequestId === signatureRequestId).map(clone).sort(comparePositions);
    },
    async replaceEvidence(record) {
      requireExisting(evidence,record.id,'SIGNATURE_EVIDENCE_REQUIRED','签字证据不存在');
      evidence.set(record.id,clone(record));return clone(record);
    },
    async addEvidence(record) {
      assertUniqueId(evidence, record.id);
      evidence.set(record.id, clone(record));
      return clone(record);
    },
    async recordSignature(evidenceRecord, signerRecord) {
      assertUniqueId(evidence, evidenceRecord.id);
      requireExisting(signers, signerRecord.id, 'SIGNER_NOT_FOUND', '签字人不存在');
      const currentSigner = signers.get(signerRecord.id)!;
      if (
        evidenceRecord.signerId !== signerRecord.id
        || evidenceRecord.signatureRequestId !== signerRecord.signatureRequestId
        || signerRecord.signatureRequestId !== currentSigner.signatureRequestId
        || signerRecord.sessionId !== currentSigner.sessionId
        || signerRecord.signatureEvidenceId !== evidenceRecord.id
      ) {
        throw new SignatureError('SIGNATURE_EVIDENCE_MISMATCH', '签字证据与签字人不匹配');
      }
      if ([...evidence.values()].some((entry) => entry.signerId === signerRecord.id)) {
        throw new SignatureError('SIGNER_ALREADY_SIGNED', '签字人已存在签字证据');
      }
      evidence.set(evidenceRecord.id, clone(evidenceRecord));
      signers.set(signerRecord.id, clone(signerRecord));
      return { evidence: clone(evidenceRecord), signer: clone(signerRecord) };
    },
    async findEvidenceById(id) {
      return cloneOrNull(evidence.get(id));
    },
    async listEvidence(signatureRequestId) {
      return [...evidence.values()].filter((entry) => entry.signatureRequestId === signatureRequestId).map(clone).sort(compareEvidence);
    },
    async addOperationHistory(record) {
      assertUniqueId(operationHistory, record.id);
      operationHistory.set(record.id, clone(record));
      return clone(record);
    },
    async listOperationHistory(signatureRequestId) {
      return [...operationHistory.values()].filter((entry) => entry.signatureRequestId === signatureRequestId).map(clone).sort(compareOperations);
    },
    records() {
      return {
        requests: [...requests.values()].map(clone),
        sessions: [...sessions.values()].map(clone),
        signers: [...signers.values()].map(clone),
        positions: [...positions.values()].map(clone),
        evidence: [...evidence.values()].map(clone),
        operationHistory: [...operationHistory.values()].map(clone)
      };
    }
  };
}

export function createPostgresSignatureRepository(client: QueryableClient): SignatureRepository {
  return {
    atomic: { client },
    async createRequest(request, session, signers, positions) {
      return runDatabaseTransaction(client, async (transaction) => {
        const saved = await insertRequest(transaction, request);
        await insertSession(transaction, session);
        for (const signer of signers) await insertSigner(transaction, signer);
        for (const position of positions) await insertPosition(transaction, position);
        return saved;
      });
    },
    async updateRequest(record) {
      return mapRequest(requireRow(await client.query(
        `UPDATE platform_signature_requests
         SET status=$2,document_snapshot=$3::jsonb,updated_at=$4,completed_at=$5,cancelled_at=$6
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, JSON.stringify(record.document), record.updatedAt, record.completedAt, record.cancelledAt]
      )));
    },
    async findRequestById(id, lock) {
      const suffix = lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
      return optional(await client.query(`SELECT * FROM platform_signature_requests WHERE id=$1${suffix}`, [id]), mapRequest);
    },
    async findRequestByKey(sourceAppId, signatureKey) {
      return optional(await client.query('SELECT * FROM platform_signature_requests WHERE source_app_id=$1 AND signature_key=$2', [sourceAppId, signatureKey]), mapRequest);
    },
    async findRequestByIdempotencyKey(sourceAppId, idempotencyKey) {
      return optional(await client.query('SELECT * FROM platform_signature_requests WHERE source_app_id=$1 AND idempotency_key=$2', [sourceAppId, idempotencyKey]), mapRequest);
    },
    async listRequests(input = {}) {
      const { where, values, limit } = buildListWhere(input);
      return rows(await client.query(`SELECT * FROM platform_signature_requests ${where} ORDER BY updated_at DESC,id LIMIT ${limit}`, values)).map(mapRequest);
    },
    async findSessionById(id) {
      return optional(await client.query('SELECT * FROM platform_signature_sessions WHERE id=$1', [id]), mapSession);
    },
    async findSessionByRequestId(signatureRequestId) {
      return optional(await client.query('SELECT * FROM platform_signature_sessions WHERE signature_request_id=$1', [signatureRequestId]), mapSession);
    },
    async findSessionByTokenHash(publicTokenHash) {
      return optional(await client.query('SELECT * FROM platform_signature_sessions WHERE public_token_hash=$1', [publicTokenHash]), mapSession);
    },
    async updateSession(record) {
      return mapSession(requireRow(await client.query(
        `UPDATE platform_signature_sessions
         SET status=$2,expires_at=$3,dispatched_at=$4,completed_at=$5,cancelled_at=$6,updated_at=$7
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, record.expiresAt, record.dispatchedAt, record.completedAt, record.cancelledAt, record.updatedAt]
      )));
    },
    async findSignerById(id) {
      return optional(await client.query('SELECT * FROM platform_signature_signers WHERE id=$1', [id]), mapSigner);
    },
    async listSigners(signatureRequestId) {
      return rows(await client.query('SELECT * FROM platform_signature_signers WHERE signature_request_id=$1 ORDER BY created_at,id', [signatureRequestId])).map(mapSigner);
    },
    async addSigner(record) {await insertSigner(client,record);return record;},
    async updateSigner(record) {
      return mapSigner(requireRow(await client.query(
        `UPDATE platform_signature_signers
         SET status=$2,signature_evidence_id=$3,signed_at=$4,revoked_at=$5,updated_at=$6
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, record.signatureEvidenceId, record.signedAt, record.revokedAt, record.updatedAt]
      )));
    },
    async listPositions(signatureRequestId) {
      return rows(await client.query('SELECT * FROM platform_signature_positions WHERE signature_request_id=$1 ORDER BY signer_id,page,id', [signatureRequestId])).map(mapPosition);
    },
    async replaceEvidence(record) {
      return mapEvidence(requireRow(await client.query(`UPDATE platform_signature_evidence SET storage_ref=$2::jsonb,signature_url=$3,content_type=$4,sha256=$5,size_bytes=$6,width=$7,height=$8,client_metadata=$9::jsonb,signed_at=$10,submitted_by_person_id=$11 WHERE id=$1 RETURNING *`,[record.id,jsonOrNull(record.storageRef),record.signatureUrl,record.contentType,record.sha256,record.sizeBytes,record.width,record.height,JSON.stringify(record.clientMetadata),record.signedAt,record.submittedByPersonId])));
    },
    async addEvidence(record) {
      return insertEvidence(client, record);
    },
    async recordSignature(evidence, signer) {
      if (evidence.signerId !== signer.id || evidence.signatureRequestId !== signer.signatureRequestId || signer.signatureEvidenceId !== evidence.id) {
        throw new SignatureError('SIGNATURE_EVIDENCE_MISMATCH', '签字证据与签字人不匹配');
      }
      return runDatabaseTransaction(client, async (transaction) => ({
        evidence: await insertEvidence(transaction, evidence),
        signer: await updateSignerRow(transaction, signer)
      }));
    },
    async findEvidenceById(id) {
      return optional(await client.query('SELECT * FROM platform_signature_evidence WHERE id=$1', [id]), mapEvidence);
    },
    async listEvidence(signatureRequestId) {
      return rows(await client.query('SELECT * FROM platform_signature_evidence WHERE signature_request_id=$1 ORDER BY signed_at,id', [signatureRequestId])).map(mapEvidence);
    },
    async addOperationHistory(record) {
      return mapOperation(requireRow(await client.query(
        `INSERT INTO platform_signature_operation_history
         (id,signature_request_id,operation,actor_type,actor_person_id,service_identity_id,execution_type,source_app_id,request_id,trace_id,note,before_payload,after_payload,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14) RETURNING *`,
        [record.id, record.signatureRequestId, record.operation, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.note, jsonOrNull(record.before), jsonOrNull(record.after), record.occurredAt]
      )));
    },
    async listOperationHistory(signatureRequestId) {
      return rows(await client.query('SELECT * FROM platform_signature_operation_history WHERE signature_request_id=$1 ORDER BY occurred_at,id', [signatureRequestId])).map(mapOperation);
    }
  };
}

async function insertRequest(client: QueryableClient, record: SignatureRequest) {
  return mapRequest(requireRow(await client.query(
    `INSERT INTO platform_signature_requests
     (id,source_app_id,source_entity_type,source_entity_id,signature_key,idempotency_key,idempotency_payload_hash,status,document_snapshot,created_by_person_id,created_by_actor_type,created_at,updated_at,completed_at,cancelled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [record.id, record.sourceAppId, record.sourceEntityType, record.sourceEntityId, record.signatureKey, record.idempotencyKey, record.idempotencyPayloadHash, record.status, JSON.stringify(record.document), record.createdByPersonId, record.createdByActorType, record.createdAt, record.updatedAt, record.completedAt, record.cancelledAt]
  )));
}

async function insertSession(client: QueryableClient, record: SignatureSession) {
  await client.query(
    `INSERT INTO platform_signature_sessions
     (id,signature_request_id,public_token_hash,public_token_preview,status,expires_at,dispatched_at,completed_at,cancelled_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [record.id, record.signatureRequestId, record.publicTokenHash, record.publicTokenPreview, record.status, record.expiresAt, record.dispatchedAt, record.completedAt, record.cancelledAt, record.createdAt, record.updatedAt]
  );
}

async function insertSigner(client: QueryableClient, record: SignatureSigner) {
  await client.query(
    `INSERT INTO platform_signature_signers
     (id,signature_request_id,session_id,person_id,signer_key,display_name,expected_organization_unit_id,status,signature_evidence_id,signed_at,revoked_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [record.id, record.signatureRequestId, record.sessionId, record.personId, record.signerKey, record.displayName, record.expectedOrganizationUnitId, record.status, record.signatureEvidenceId, record.signedAt, record.revokedAt, record.createdAt, record.updatedAt]
  );
}

async function insertPosition(client: QueryableClient, record: SignaturePosition) {
  await client.query(
    `INSERT INTO platform_signature_positions
     (id,signature_request_id,signer_id,page,x0,y0,x1,y1,strategy,label,required,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [record.id, record.signatureRequestId, record.signerId, record.page, record.x0, record.y0, record.x1, record.y1, record.strategy, record.label, record.required, record.createdAt]
  );
}

async function insertEvidence(client: QueryableClient, record: SignatureEvidence) {
  return mapEvidence(requireRow(await client.query(
    `INSERT INTO platform_signature_evidence
     (id,signature_request_id,signer_id,submitted_by_person_id,storage_ref,signature_url,content_type,sha256,size_bytes,width,height,client_metadata,signed_at,created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) RETURNING *`,
    [record.id, record.signatureRequestId, record.signerId, record.submittedByPersonId, jsonOrNull(record.storageRef), record.signatureUrl, record.contentType, record.sha256, record.sizeBytes, record.width, record.height, JSON.stringify(record.clientMetadata), record.signedAt, record.createdAt]
  )));
}

async function updateSignerRow(client: QueryableClient, record: SignatureSigner) {
  return mapSigner(requireRow(await client.query(
    `UPDATE platform_signature_signers
     SET status=$2,signature_evidence_id=$3,signed_at=$4,revoked_at=$5,updated_at=$6
     WHERE id=$1 RETURNING *`,
    [record.id, record.status, record.signatureEvidenceId, record.signedAt, record.revokedAt, record.updatedAt]
  )));
}

function buildListWhere(input: SignatureListInput) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace('?', `$${values.length}`));
  };
  if (input.sourceAppId) add('source_app_id=?', input.sourceAppId);
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    values.push(statuses);
    clauses.push(`status = ANY($${values.length}::text[])`);
  }
  if (input.signerPersonId) {
    values.push(input.signerPersonId);
    clauses.push(`EXISTS (SELECT 1 FROM platform_signature_signers signer WHERE signer.signature_request_id=platform_signature_requests.id AND signer.person_id=$${values.length})`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values, limit: normalizedLimit(input.limit) };
}

function matchesRequest(request: SignatureRequest, signers: Map<string, SignatureSigner>, input: SignatureListInput) {
  if (input.sourceAppId && request.sourceAppId !== input.sourceAppId) return false;
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    if (!statuses.includes(request.status)) return false;
  }
  return !input.signerPersonId || [...signers.values()].some((signer) => signer.signatureRequestId === request.id && signer.personId === input.signerPersonId);
}

function normalizedLimit(value: number | undefined) {
  return Number.isSafeInteger(value) && value && value > 0 ? Math.min(value, 500) : 100;
}

function assertUniqueId<T>(records: Map<string, T>, id: string) {
  if (records.has(id)) throw new SignatureError('DUPLICATE_ID', `平台签字记录 ID 已存在: ${id}`);
}

function requireExisting<T>(records: Map<string, T>, id: string, code: string, message: string) {
  if (!records.has(id)) throw new SignatureError(code, message);
}

function compareUpdated(left: SignatureRequest, right: SignatureRequest) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function compareCreated(left: SignatureSigner, right: SignatureSigner) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function comparePositions(left: SignaturePosition, right: SignaturePosition) {
  return left.signerId.localeCompare(right.signerId) || left.page - right.page || left.id.localeCompare(right.id);
}

function compareEvidence(left: SignatureEvidence, right: SignatureEvidence) {
  return left.signedAt.localeCompare(right.signedAt) || left.id.localeCompare(right.id);
}

function compareOperations(left: SignatureOperationHistory, right: SignatureOperationHistory) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | null | undefined): T | null {
  return value ? clone(value) : null;
}

function toMap<T extends { id: string }>(items: readonly T[] | undefined) {
  return new Map((items ?? []).map((item) => [item.id, clone(item)]));
}

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray((result as { rows?: unknown[] })?.rows) ? (result as { rows: Record<string, unknown>[] }).rows : [];
}

function requireRow(result: unknown) {
  const row = rows(result)[0];
  if (!row) throw new SignatureError('DATABASE_WRITE_FAILED', '平台签字数据写入失败');
  return row;
}

function optional<T>(result: unknown, mapper: (row: Record<string, unknown>) => T) {
  const row = rows(result)[0];
  return row ? mapper(row) : null;
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new SignatureError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : text(row, key);
}

function instant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new SignatureError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function nullableInstant(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : instant(row, key);
}

function integer(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  throw new SignatureError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
}

function numberValue(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new SignatureError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
}

function nullableInteger(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : integer(row, key);
}

function bool(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'boolean') throw new SignatureError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function jsonObject(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new SignatureError('INVALID_DATABASE_ROW', `字段 ${key} JSON 无效`);
}

function nullableJsonObject(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : jsonObject(row, key);
}

function mapRequest(row: Record<string, unknown>): SignatureRequest {
  return {
    id: text(row, 'id'),
    sourceAppId: text(row, 'source_app_id'),
    sourceEntityType: text(row, 'source_entity_type'),
    sourceEntityId: text(row, 'source_entity_id'),
    signatureKey: text(row, 'signature_key'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    status: text(row, 'status') as SignatureRequest['status'],
    document: jsonObject(row, 'document_snapshot') as unknown as SignatureRequest['document'],
    createdByPersonId: nullableText(row, 'created_by_person_id'),
    createdByActorType: text(row, 'created_by_actor_type') as SignatureRequest['createdByActorType'],
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at'),
    completedAt: nullableInstant(row, 'completed_at'),
    cancelledAt: nullableInstant(row, 'cancelled_at')
  };
}

function mapSession(row: Record<string, unknown>): SignatureSession {
  return {
    id: text(row, 'id'),
    signatureRequestId: text(row, 'signature_request_id'),
    publicTokenHash: text(row, 'public_token_hash'),
    publicTokenPreview: text(row, 'public_token_preview'),
    status: text(row, 'status') as SignatureSession['status'],
    expiresAt: nullableInstant(row, 'expires_at'),
    dispatchedAt: nullableInstant(row, 'dispatched_at'),
    completedAt: nullableInstant(row, 'completed_at'),
    cancelledAt: nullableInstant(row, 'cancelled_at'),
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at')
  };
}

function mapSigner(row: Record<string, unknown>): SignatureSigner {
  return {
    id: text(row, 'id'),
    signatureRequestId: text(row, 'signature_request_id'),
    sessionId: text(row, 'session_id'),
    personId: nullableText(row, 'person_id'),
    signerKey: text(row, 'signer_key'),
    displayName: text(row, 'display_name'),
    expectedOrganizationUnitId: nullableText(row, 'expected_organization_unit_id'),
    status: text(row, 'status') as SignatureSigner['status'],
    signatureEvidenceId: nullableText(row, 'signature_evidence_id'),
    signedAt: nullableInstant(row, 'signed_at'),
    revokedAt: nullableInstant(row, 'revoked_at'),
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at')
  };
}

function mapPosition(row: Record<string, unknown>): SignaturePosition {
  return {
    id: text(row, 'id'),
    signatureRequestId: text(row, 'signature_request_id'),
    signerId: text(row, 'signer_id'),
    page: integer(row, 'page'),
    x0: numberValue(row, 'x0'),
    y0: numberValue(row, 'y0'),
    x1: numberValue(row, 'x1'),
    y1: numberValue(row, 'y1'),
    strategy: text(row, 'strategy'),
    label: nullableText(row, 'label'),
    required: bool(row, 'required'),
    createdAt: instant(row, 'created_at')
  };
}

function mapEvidence(row: Record<string, unknown>): SignatureEvidence {
  return {
    id: text(row, 'id'),
    signatureRequestId: text(row, 'signature_request_id'),
    signerId: text(row, 'signer_id'),
    submittedByPersonId: nullableText(row, 'submitted_by_person_id'),
    storageRef: nullableJsonObject(row, 'storage_ref') as SignatureEvidence['storageRef'],
    signatureUrl: nullableText(row, 'signature_url'),
    contentType: text(row, 'content_type'),
    sha256: nullableText(row, 'sha256'),
    sizeBytes: nullableInteger(row, 'size_bytes'),
    width: nullableInteger(row, 'width'),
    height: nullableInteger(row, 'height'),
    clientMetadata: jsonObject(row, 'client_metadata') as SignatureEvidence['clientMetadata'],
    signedAt: instant(row, 'signed_at'),
    createdAt: instant(row, 'created_at')
  };
}

function mapOperation(row: Record<string, unknown>): SignatureOperationHistory {
  return {
    id: text(row, 'id'),
    signatureRequestId: nullableText(row, 'signature_request_id'),
    operation: text(row, 'operation') as SignatureOperationHistory['operation'],
    actorType: text(row, 'actor_type') as SignatureOperationHistory['actorType'],
    actorPersonId: nullableText(row, 'actor_person_id'),
    serviceIdentityId: nullableText(row, 'service_identity_id'),
    executionType: text(row, 'execution_type') as SignatureOperationHistory['executionType'],
    sourceAppId: nullableText(row, 'source_app_id'),
    requestId: nullableText(row, 'request_id'),
    traceId: nullableText(row, 'trace_id'),
    note: nullableText(row, 'note'),
    before: nullableJsonObject(row, 'before_payload'),
    after: nullableJsonObject(row, 'after_payload'),
    occurredAt: instant(row, 'occurred_at')
  };
}

function jsonOrNull(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
