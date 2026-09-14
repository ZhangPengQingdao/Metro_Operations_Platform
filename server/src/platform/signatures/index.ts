import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runAtomicOperation } from '../../core/database/index.js';
import { enqueueCoreEvent, type CoreOutboxRepository } from '../../core/events/index.js';
import { isSafeStorageFileName, isSafeStorageNamespace } from '../../core/storage/index.js';
import type { AuthorizationResource } from '../authorization/index.js';
import { applicationGrantAllows, type PlatformActorContext } from '../context/index.js';
import {
  SIGNATURE_EVENT_TYPES,
  SIGNATURE_PERMISSION_CODES,
  SIGNATURE_REQUEST_STATUSES,
  SIGNATURE_SESSION_STATUSES,
  SIGNATURE_SIGNER_STATUSES,
  SignatureError,
  type CancelSignatureRequestInput,
  type CreateSignatureRequestInput,
  type FinalizeSignatureRequestInput,
  type LegacySignatureReconciliation,
  type LegacySignatureSnapshot,
  type RevokeSignatureSignerInput,
  type SignatureDetail,
  type SignatureDocumentSnapshot,
  type SignatureEvidence,
  type SignatureEvidenceInput,
  type SignatureFileReference,
  type SignatureListInput,
  type SignatureOperation,
  type SignaturePosition,
  type SignatureRequest,
  type SignatureRequestCreation,
  type SignatureSession,
  type SignatureSigner,
  type SignatureSignerInput,
  type SignatureSourceReference,
  type SubmitSignatureInput
} from './model.js';
import type { SignatureRepository } from './repository.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface SignatureDirectoryPerson {
  organizationUnitId: string;
  employmentStatus: string;
  name: string;
}

export interface SignatureDirectoryOrganizationUnit {
  status: string;
  name?: string | null;
}

export interface SignatureServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  createEventId?: () => string;
  createPublicToken?: () => string;
  outbox?: CoreOutboxRepository;
  findPerson(id: string): Promise<SignatureDirectoryPerson | null>;
  findOrganizationUnit(id: string): Promise<SignatureDirectoryOrganizationUnit | null>;
}

export class SignatureService {
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly createEventId: () => string;
  private readonly createPublicToken: () => string;

  constructor(private readonly repository: SignatureRepository, private readonly options: SignatureServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.createEventId = options.createEventId ?? this.createId;
    this.createPublicToken = options.createPublicToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async createSignatureRequest(context: PlatformActorContext, input: CreateSignatureRequestInput): Promise<SignatureRequestCreation> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.createSignatureRequestCommand(context, input));
  }

  private async createSignatureRequestCommand(context: PlatformActorContext, input: CreateSignatureRequestInput): Promise<SignatureRequestCreation> {
    const draft = await this.prepareDraft(context, input);
    const hash = payloadHash(draft.idempotencyPayload);
    for (const signer of draft.signers) {
      await this.requireAuthorized(context, SIGNATURE_PERMISSION_CODES.create, resourceForSigners([signer], draft.request.createdByPersonId));
    }

    const existingByKey = await this.repository.findRequestByKey(draft.request.sourceAppId, draft.request.signatureKey);
    if (existingByKey) return this.returnIdempotent(existingByKey, hash, 'SIGNATURE_KEY_CONFLICT');
    if (draft.request.idempotencyKey) {
      const existing = await this.repository.findRequestByIdempotencyKey(draft.request.sourceAppId, draft.request.idempotencyKey);
      if (existing) return this.returnIdempotent(existing, hash, 'IDEMPOTENCY_CONFLICT');
    }

    const publicToken = normalizePublicToken(this.createPublicToken());
    const session = {
      ...draft.session,
      publicTokenHash: tokenHash(publicToken),
      publicTokenPreview: tokenPreview(publicToken)
    };
    const request = { ...draft.request, idempotencyPayloadHash: hash };
    const saved = await this.repository.createRequest(request, session, draft.signers, draft.positions);
    await this.recordOperation(context, saved.id, 'created', null, saved, null);
    await this.emit(context, saved, SIGNATURE_EVENT_TYPES.requestCreated, 'created', ['status', 'session', 'signers', 'positions']);
    return { request: saved, session, publicToken };
  }

  async getSignatureRequest(context: PlatformActorContext, signatureRequestId: string): Promise<SignatureDetail> {
    return runAtomicOperation([this.repository], () => this.getSignatureRequestQuery(context, signatureRequestId));
  }

  private async getSignatureRequestQuery(context: PlatformActorContext, signatureRequestId: string): Promise<SignatureDetail> {
    const request = await this.requireReadableRequest(context, uuid(signatureRequestId, 'signature request id'), 'share');
    return this.detail(request);
  }

  async getSignatureRequestByPublicToken(context: PlatformActorContext, publicToken: string): Promise<SignatureDetail> {
    return runAtomicOperation([this.repository], () => this.getSignatureRequestByPublicTokenQuery(context, publicToken));
  }

  private async getSignatureRequestByPublicTokenQuery(context: PlatformActorContext, publicToken: string): Promise<SignatureDetail> {
    const session = await this.requireSessionByToken(publicToken);
    const request = await this.requireReadableRequest(context, session.signatureRequestId, 'share');
    return this.detail(request);
  }

  async listSignatureRequests(context: PlatformActorContext, input: SignatureListInput = {}): Promise<SignatureRequest[]> {
    return runAtomicOperation([this.repository], () => this.listSignatureRequestsQuery(context, input));
  }

  private async listSignatureRequestsQuery(context: PlatformActorContext, input: SignatureListInput = {}): Promise<SignatureRequest[]> {
    const normalized = normalizeListInput(input);
    const candidates = await this.repository.listRequests(normalized);
    const readable: SignatureRequest[] = [];
    for (const request of candidates) {
      if (await this.canRead(context, request)) readable.push(request);
    }
    return readable;
  }

  async submitSignature(context: PlatformActorContext, input: SubmitSignatureInput): Promise<SignatureDetail> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.submitSignatureCommand(context, input));
  }

  private async submitSignatureCommand(context: PlatformActorContext, input: SubmitSignatureInput): Promise<SignatureDetail> {
    const locatedSession = await this.resolveSession(input);
    // Token/session lookup only locates the parent; request is the first acquired row lock.
    const request = await this.requireRequest(locatedSession.signatureRequestId, 'update');
    const session = await this.requireSession(request.id);
    this.requireOpenSession(request, session);
    const signer = await this.repository.findSignerById(uuid(input.signerId, 'signer id'));
    if (!signer || signer.sessionId !== session.id || signer.signatureRequestId !== request.id) {
      throw new SignatureError('SIGNER_NOT_FOUND', '签字人不存在');
    }
    if (signer.status === 'revoked') throw new SignatureError('SIGNER_REVOKED', '签字人已撤销');
    if (signer.status === 'signed') throw new SignatureError('SIGNER_ALREADY_SIGNED', '签字人已完成签字');
    if (context.actorType !== 'person' || !signer.personId || context.person.id !== signer.personId) {
      await this.requireAuthorized(context, SIGNATURE_PERMISSION_CODES.signOnBehalf, resourceForSigners([signer], request.createdByPersonId));
    } else if (!await applicationGrantAllows(context, SIGNATURE_PERMISSION_CODES.sign, resourceForSigners([signer], request.createdByPersonId))) {
      throw new SignatureError('SIGNATURE_PERMISSION_DENIED', '应用未获授权提交本人签字');
    }

    const now = this.nowIso();
    const evidence = normalizeEvidence(input.evidence, {
      id: uuid(this.createId(), 'signature evidence id'),
      signatureRequestId: request.id,
      signerId: signer.id,
      submittedByPersonId: context.actorType === 'person' ? context.person.id : null,
      signedAt: now,
      createdAt: now
    });
    const signing = await this.repository.recordSignature(evidence, {
      ...signer,
      status: 'signed',
      signatureEvidenceId: evidence.id,
      signedAt: now,
      revokedAt: null,
      updatedAt: now
    });
    const savedSigner = signing.signer;
    await this.recordOperation(context, request.id, 'signed', signer, savedSigner, input.note);
    await this.emit(context, request, SIGNATURE_EVENT_TYPES.signerSigned, 'signed', ['signerId', 'status', 'signedAt']);
    await this.completeWhenReady(context, request, input.note);
    return this.detail(await this.requireRequest(request.id));
  }

  async revokeSigner(context: PlatformActorContext, input: RevokeSignatureSignerInput): Promise<SignatureDetail> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.revokeSignerCommand(context, input));
  }

  private async revokeSignerCommand(context: PlatformActorContext, input: RevokeSignatureSignerInput): Promise<SignatureDetail> {
    const locatedSigner = await this.repository.findSignerById(uuid(input.signerId, 'signer id'));
    if (!locatedSigner) throw new SignatureError('SIGNER_NOT_FOUND', '签字人不存在');
    // Signer lookup only locates the parent; request is locked before signer/session are re-read.
    const request = await this.requireRequest(locatedSigner.signatureRequestId, 'update');
    const signer = await this.repository.findSignerById(locatedSigner.id);
    if (!signer) throw new SignatureError('SIGNER_NOT_FOUND', '签字人不存在');
    const session = await this.requireSession(request.id);
    this.requireOpenSession(request, session);
    await this.requireAuthorized(context, SIGNATURE_PERMISSION_CODES.manage, resourceForSigners(await this.repository.listSigners(request.id), request.createdByPersonId));
    if (signer.status === 'revoked') return this.detail(request);
    const now = this.nowIso();
    const saved = await this.repository.updateSigner({ ...signer, status: 'revoked', revokedAt: now, updatedAt: now });
    await this.recordOperation(context, request.id, 'signer_revoked', signer, saved, input.note);
    await this.completeWhenReady(context, request, input.note);
    return this.detail(await this.requireRequest(request.id));
  }

  async finalizeSignatureRequest(context: PlatformActorContext, input: FinalizeSignatureRequestInput): Promise<SignatureDetail> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.finalizeSignatureRequestCommand(context, input));
  }

  private async finalizeSignatureRequestCommand(context: PlatformActorContext, input: FinalizeSignatureRequestInput): Promise<SignatureDetail> {
    const request = await this.requireRequest(uuid(input.signatureRequestId, 'signature request id'), 'update');
    const signers = await this.repository.listSigners(request.id);
    await this.requireAuthorized(context, SIGNATURE_PERMISSION_CODES.finalize, resourceForSigners(signers, request.createdByPersonId));
    if (request.status === 'completed') return this.detail(request);
    const session = await this.requireSession(request.id);
    this.requireOpenSession(request, session);
    if (!canCompleteSignature(signers)) throw new SignatureError('SIGNATURE_NOT_READY', '仍有有效签字人未完成签字');
    await this.complete(context, request, session, input.note);
    return this.detail(await this.requireRequest(request.id));
  }

  async cancelSignatureRequest(context: PlatformActorContext, input: CancelSignatureRequestInput): Promise<SignatureDetail> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.cancelSignatureRequestCommand(context, input));
  }

  private async cancelSignatureRequestCommand(context: PlatformActorContext, input: CancelSignatureRequestInput): Promise<SignatureDetail> {
    const request = await this.requireRequest(uuid(input.signatureRequestId, 'signature request id'), 'update');
    const signers = await this.repository.listSigners(request.id);
    await this.requireAuthorized(context, SIGNATURE_PERMISSION_CODES.manage, resourceForSigners(signers, request.createdByPersonId));
    if (request.status === 'cancelled') return this.detail(request);
    if (request.status === 'completed') throw new SignatureError('SIGNATURE_ALREADY_COMPLETED', '已完成签字请求不能取消');
    const session = await this.requireSession(request.id);
    const now = this.nowIso();
    const savedRequest = await this.repository.updateRequest({ ...request, status: 'cancelled', updatedAt: now, cancelledAt: now });
    await this.repository.updateSession({ ...session, status: 'cancelled', updatedAt: now, cancelledAt: now });
    await this.recordOperation(context, request.id, 'cancelled', request, savedRequest, input.note);
    await this.emit(context, savedRequest, SIGNATURE_EVENT_TYPES.statusChanged, 'cancelled', ['status', 'cancelledAt']);
    return this.detail(savedRequest);
  }

  async deleteSignatureRequest(): Promise<never> {
    throw new SignatureError('HARD_DELETE_NOT_SUPPORTED', '平台签字不提供业务硬删除接口，请取消签字请求');
  }

  private async prepareDraft(context: PlatformActorContext, input: CreateSignatureRequestInput) {
    const source = normalizeSource(input.source);
    assertExecutionSource(context, source.appId);
    const now = this.nowIso();
    const requestId = uuid(input.id ?? this.createId(), 'signature request id');
    const sessionId = uuid(input.sessionId ?? this.createId(), 'signature session id');
    const request: SignatureRequest = {
      id: requestId,
      sourceAppId: source.appId,
      sourceEntityType: source.entityType,
      sourceEntityId: source.entityId,
      signatureKey: boundedText(input.signatureKey, 260, 'signature key'),
      idempotencyKey: normalizeOptionalText(input.idempotencyKey, 200),
      idempotencyPayloadHash: null,
      status: 'dispatched',
      document: normalizeDocument(input.document),
      createdByPersonId: context.actorType === 'person' ? context.person.id : null,
      createdByActorType: context.actorType,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      cancelledAt: null
    };
    const { signers, positions } = await this.resolveSigners(requestId, sessionId, input.signers, now);
    const expiresAt = normalizeDate(input.expiresAt ?? null, 'signature expiry');
    if (expiresAt && expiresAt <= now) throw new SignatureError('INVALID_EXPIRY', '签字会话有效期必须晚于创建时间');
    const session: SignatureSession = {
      id: sessionId,
      signatureRequestId: requestId,
      publicTokenHash: '',
      publicTokenPreview: '',
      status: 'dispatched',
      expiresAt,
      dispatchedAt: now,
      completedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now
    };
    return {
      request,
      session,
      signers,
      positions,
      idempotencyPayload: normalizePayload({
        source,
        signatureKey: request.signatureKey,
        document: request.document,
        signers: signers.map((signer) => ({
          personId: signer.personId,
          signerKey: signer.signerKey,
          displayName: signer.displayName,
          expectedOrganizationUnitId: signer.expectedOrganizationUnitId,
          positions: positions.filter((position) => position.signerId === signer.id).map(({ page, x0, y0, x1, y1, strategy, label, required }) => ({ page, x0, y0, x1, y1, strategy, label, required }))
        })),
        expiresAt
      })
    };
  }

  private async resolveSigners(
    signatureRequestId: string,
    sessionId: string,
    input: readonly SignatureSignerInput[],
    createdAt: string
  ) {
    if (input.length === 0) throw new SignatureError('SIGNER_REQUIRED', '签字请求至少需要一个签字人');
    if (input.length > 100) throw new SignatureError('TOO_MANY_SIGNERS', '单个签字请求最多支持 100 个签字人');
    const signers: SignatureSigner[] = [];
    const positions: SignaturePosition[] = [];
    const signerKeys = new Set<string>();
    for (const entry of input) {
      const resolved = await this.resolveSignerIdentity(entry);
      if (signerKeys.has(resolved.signerKey)) throw new SignatureError('DUPLICATE_SIGNER', `签字人重复: ${resolved.displayName}`);
      signerKeys.add(resolved.signerKey);
      if (entry.positions.length === 0) throw new SignatureError('POSITION_REQUIRED', `签字人 ${resolved.displayName} 至少需要一个签字位置`);
      if (entry.positions.length > 100) throw new SignatureError('TOO_MANY_POSITIONS', '单个签字人最多支持 100 个签字位置');
      const signer: SignatureSigner = {
        id: uuid(this.createId(), 'signer id'),
        signatureRequestId,
        sessionId,
        personId: resolved.personId,
        signerKey: resolved.signerKey,
        displayName: resolved.displayName,
        expectedOrganizationUnitId: resolved.expectedOrganizationUnitId,
        status: 'pending',
        signatureEvidenceId: null,
        signedAt: null,
        revokedAt: null,
        createdAt,
        updatedAt: createdAt
      };
      signers.push(signer);
      for (const position of entry.positions) positions.push(normalizePosition(position, signatureRequestId, signer.id, uuid(this.createId(), 'signature position id'), createdAt));
    }
    return { signers, positions };
  }

  private async resolveSignerIdentity(input: SignatureSignerInput) {
    const personId = input.personId ? uuid(input.personId, 'signer person id') : null;
    const expectedOrganizationUnitId = input.expectedOrganizationUnitId ? uuid(input.expectedOrganizationUnitId, 'expected organization unit id') : null;
    if (expectedOrganizationUnitId) await this.requireActiveOrganization(expectedOrganizationUnitId);
    if (personId) {
      const person = await this.requireActivePerson(personId);
      if (expectedOrganizationUnitId && person.organizationUnitId !== expectedOrganizationUnitId) {
        throw new SignatureError('SIGNER_ORGANIZATION_MISMATCH', '签字人当前组织与预期组织不一致');
      }
      return {
        personId,
        signerKey: `person:${personId}`,
        displayName: normalizeOptionalText(input.name, 120) ?? boundedText(person.name, 120, 'signer name'),
        expectedOrganizationUnitId: expectedOrganizationUnitId ?? uuid(person.organizationUnitId, 'person organization unit id')
      };
    }
    const displayName = boundedText(input.name, 120, 'legacy signer name');
    return {
      personId: null,
      signerKey: `legacy-name:${displayName.toLocaleLowerCase('zh-CN')}`,
      displayName,
      expectedOrganizationUnitId
    };
  }

  private async resolveSession(input: SubmitSignatureInput) {
    const hasToken = typeof input.publicToken === 'string' && input.publicToken.trim().length > 0;
    const hasSession = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0;
    if (hasToken === hasSession) throw new SignatureError('SESSION_REFERENCE_REQUIRED', '必须且只能提供 publicToken 或 sessionId');
    if (hasToken) return this.requireSessionByToken(input.publicToken!);
    const session = await this.repository.findSessionById(uuid(input.sessionId!, 'signature session id'));
    if (!session) throw new SignatureError('SIGNATURE_SESSION_NOT_FOUND', '签字会话不存在');
    return session;
  }

  private async requireSessionByToken(publicToken: string) {
    const session = await this.repository.findSessionByTokenHash(tokenHash(normalizePublicToken(publicToken)));
    if (!session) throw new SignatureError('SIGNATURE_SESSION_NOT_FOUND', '签字会话不存在');
    return session;
  }

  private requireOpenSession(request: SignatureRequest, session: SignatureSession) {
    if (request.status === 'cancelled' || session.status === 'cancelled') throw new SignatureError('SIGNATURE_CANCELLED', '签字请求已取消');
    if (request.status === 'completed' || session.status === 'completed') throw new SignatureError('SIGNATURE_ALREADY_COMPLETED', '签字请求已完成');
    if (session.expiresAt && session.expiresAt <= this.nowIso()) throw new SignatureError('SIGNATURE_SESSION_EXPIRED', '签字会话已过期');
  }

  private async completeWhenReady(context: PlatformActorContext, request: SignatureRequest, note: string | null | undefined) {
    const current = await this.requireRequest(request.id);
    if (current.status === 'completed' || current.status === 'cancelled') return current;
    const signers = await this.repository.listSigners(current.id);
    if (!canCompleteSignature(signers)) return current;
    return this.complete(context, current, await this.requireSession(current.id), note);
  }

  private async complete(context: PlatformActorContext, request: SignatureRequest, session: SignatureSession, note: string | null | undefined) {
    const now = this.nowIso();
    const savedRequest = await this.repository.updateRequest({ ...request, status: 'completed', updatedAt: now, completedAt: now });
    await this.repository.updateSession({ ...session, status: 'completed', updatedAt: now, completedAt: now });
    await this.recordOperation(context, request.id, 'completed', request, savedRequest, note);
    await this.emit(context, savedRequest, SIGNATURE_EVENT_TYPES.statusChanged, 'completed', ['status', 'completedAt']);
    await this.emit(context, savedRequest, SIGNATURE_EVENT_TYPES.requestCompleted, 'completed', ['status', 'completedAt']);
    return savedRequest;
  }

  private async requireRequest(id: string, lock?: 'share' | 'update') {
    const request = await this.repository.findRequestById(id, lock);
    if (!request) throw new SignatureError('SIGNATURE_REQUEST_NOT_FOUND', '签字请求不存在');
    return request;
  }

  private async requireSession(signatureRequestId: string) {
    const session = await this.repository.findSessionByRequestId(signatureRequestId);
    if (!session) throw new SignatureError('SIGNATURE_SESSION_NOT_FOUND', '签字会话不存在');
    return session;
  }

  private async requireReadableRequest(context: PlatformActorContext, id: string, lock?: 'share' | 'update') {
    const request = await this.requireRequest(id, lock);
    if (!await this.canRead(context, request)) throw new SignatureError('SIGNATURE_ACCESS_DENIED', '无权查看签字请求');
    return request;
  }

  private async canRead(context: PlatformActorContext, request: SignatureRequest) {
    const signers = await this.repository.listSigners(request.id);
    const ownSigner = context.actorType === 'person' ? signers.find((signer) => signer.personId === context.person.id) : undefined;
    const resource = resourceForSigners(ownSigner ? [ownSigner] : signers, request.createdByPersonId);
    if (!await applicationGrantAllows(context, SIGNATURE_PERMISSION_CODES.read, resource)) return false;
    if (ownSourceExecution(context, request.sourceAppId)) return true;
    if (context.actorType === 'person') {
      if (request.createdByPersonId === context.person.id) return true;
      if (ownSigner) return true;
    }
    return (await context.authorize(SIGNATURE_PERMISSION_CODES.read, resource)).allowed;
  }

  private async detail(request: SignatureRequest): Promise<SignatureDetail> {
    return {
      request,
      session: await this.requireSession(request.id),
      signers: await this.repository.listSigners(request.id),
      positions: await this.repository.listPositions(request.id),
      evidence: await this.repository.listEvidence(request.id),
      operationHistory: await this.repository.listOperationHistory(request.id)
    };
  }

  private async returnIdempotent(request: SignatureRequest, hash: string, conflictCode: 'IDEMPOTENCY_CONFLICT' | 'SIGNATURE_KEY_CONFLICT'): Promise<SignatureRequestCreation> {
    const current = await this.requireRequest(request.id, 'share');
    if (current.idempotencyPayloadHash !== hash) throw new SignatureError(conflictCode, '相同签字键或幂等键的请求内容不同');
    return { request: current, session: await this.requireSession(current.id), publicToken: null };
  }

  private async requireActivePerson(personId: string) {
    const person = await this.options.findPerson(personId);
    if (!person) throw new SignatureError('PERSON_NOT_FOUND', '人员不存在');
    if (person.employmentStatus !== 'active') throw new SignatureError('PERSON_INACTIVE', '人员不在岗');
    return person;
  }

  private async requireActiveOrganization(organizationUnitId: string) {
    const organization = await this.options.findOrganizationUnit(organizationUnitId);
    if (!organization) throw new SignatureError('ORGANIZATION_NOT_FOUND', '组织不存在');
    if (organization.status !== 'active') throw new SignatureError('ORGANIZATION_INACTIVE', '组织未启用');
    return organization;
  }

  private async requireAuthorized(context: PlatformActorContext, permissionCode: string, resource: AuthorizationResource) {
    if (!await applicationGrantAllows(context, permissionCode, resource) || !(await context.authorize(permissionCode, resource)).allowed) {
      throw new SignatureError('SIGNATURE_PERMISSION_DENIED', `缺少权限: ${permissionCode}`);
    }
  }

  private async recordOperation(
    context: PlatformActorContext,
    signatureRequestId: string | null,
    operation: SignatureOperation,
    before: unknown,
    after: unknown,
    note: string | null | undefined
  ) {
    await this.repository.addOperationHistory({
      id: uuid(this.createId(), 'signature operation id'),
      signatureRequestId,
      operation,
      actorType: context.actorType,
      actorPersonId: context.actorType === 'person' ? context.person.id : null,
      serviceIdentityId: context.actorType === 'service' ? context.execution.serviceIdentityId : null,
      executionType: context.execution.type,
      sourceAppId: context.execution.type === 'platform' ? null : context.execution.appId,
      requestId: context.request.requestId,
      traceId: context.request.traceId,
      note: normalizeOptionalText(note, 2000),
      before: operationPayload(before),
      after: operationPayload(after),
      occurredAt: this.nowIso()
    });
  }

  private async emit(context: PlatformActorContext, request: SignatureRequest, type: string, operation: string, changedFields: readonly string[]) {
    if (!this.options.outbox) return;
    await enqueueCoreEvent(this.options.outbox, {
      type,
      source: 'platform/signatures',
      payload: {
        signatureRequestId: request.id,
        signatureKey: request.signatureKey,
        sourceAppId: request.sourceAppId,
        operation,
        status: request.status,
        actorType: context.actorType,
        actorPersonId: context.actorType === 'person' ? context.person.id : null,
        changedFields: [...changedFields]
      },
      actorId: context.actorType === 'person' ? context.person.id : context.execution.serviceIdentityId,
      correlationId: context.request.traceId,
      causationId: context.request.requestId
    }, { clock: this.clock, createEventId: this.createEventId });
  }

  private nowIso() {
    return this.clock().toISOString();
  }
}

export function createSignatureService(repository: SignatureRepository, options: SignatureServiceOptions) {
  return new SignatureService(repository, options);
}

export function canCompleteSignature(signers: readonly SignatureSigner[]) {
  const active = signers.filter((signer) => signer.status !== 'revoked');
  return active.length > 0 && active.every((signer) => signer.status === 'signed');
}

export function reconcileLegacySignatures(snapshot: LegacySignatureSnapshot): LegacySignatureReconciliation {
  const sessions = snapshot.sessions ?? [];
  const signers = snapshot.signers ?? [];
  const forms = snapshot.forms ?? [];
  const sessionIds = new Set(sessions.map((session) => session.id));
  const signersBySession = new Map<string, typeof signers>();
  const issues: LegacySignatureReconciliation['issues'] = [];
  const sessionStatusCounts: Record<string, number> = {};
  const signerStatusCounts: Record<string, number> = {};
  let personSignerCount = 0;
  let positionedSignerCount = 0;
  let evidenceReferenceCount = 0;

  for (const signer of signers) {
    const values = signersBySession.get(signer.sessionId) ?? [];
    signersBySession.set(signer.sessionId, [...values, signer]);
    signerStatusCounts[signer.status] = (signerStatusCounts[signer.status] ?? 0) + 1;
    if (signer.userId) personSignerCount += 1;
    if (validLegacyPosition(signer)) positionedSignerCount += 1;
    else issues.push({ code: 'SIGNER_MISSING_POSITION', sourceId: signer.id });
    if (signer.signatureUrl?.trim()) evidenceReferenceCount += 1;
    if (!sessionIds.has(signer.sessionId)) issues.push({ code: 'SIGNER_WITHOUT_SESSION', sourceId: signer.id });
    if (!SIGNATURE_SIGNER_STATUSES.includes(signer.status as SignatureSigner['status'])) issues.push({ code: 'INVALID_SIGNER_STATUS', sourceId: signer.id });
    if (signer.status === 'signed' && !signer.signatureUrl?.trim()) issues.push({ code: 'SIGNED_WITHOUT_EVIDENCE', sourceId: signer.id });
  }
  for (const session of sessions) {
    sessionStatusCounts[session.status] = (sessionStatusCounts[session.status] ?? 0) + 1;
    if (!session.publicToken?.trim()) issues.push({ code: 'SESSION_MISSING_TOKEN', sourceId: session.id });
    if (!SIGNATURE_SESSION_STATUSES.includes(session.status as SignatureSession['status'])) issues.push({ code: 'INVALID_SESSION_STATUS', sourceId: session.id });
    if (session.status === 'completed') {
      const active = (signersBySession.get(session.id) ?? []).filter((signer) => signer.status !== 'revoked');
      if (active.length === 0 || active.some((signer) => signer.status !== 'signed')) issues.push({ code: 'COMPLETED_WITH_UNSIGNED_SIGNER', sourceId: session.id });
    }
  }
  for (const form of forms) {
    if (!sessionIds.has(form.sessionId)) issues.push({ code: 'FORM_WITHOUT_SESSION', sourceId: `${form.kind}:${form.id}` });
  }
  return {
    templateCount: snapshot.templates?.length ?? 0,
    sessionCount: sessions.length,
    signerCount: signers.length,
    formCount: forms.length,
    sessionStatusCounts,
    signerStatusCounts,
    personSignerCount,
    nameOnlySignerCount: signers.length - personSignerCount,
    positionedSignerCount,
    evidenceReferenceCount,
    issues
  };
}

function normalizeSource(source: SignatureSourceReference) {
  return {
    appId: appId(source.appId),
    entityType: boundedText(source.entityType, 100, 'source entity type'),
    entityId: boundedText(source.entityId, 200, 'source entity id')
  };
}

function normalizeDocument(document: SignatureDocumentSnapshot): SignatureDocumentSnapshot {
  return {
    title: boundedText(document.title, 200, 'document title'),
    description: normalizeOptionalText(document.description, 4000),
    originalFileName: normalizeOptionalText(document.originalFileName, 255),
    originalExtension: normalizeOptionalText(document.originalExtension, 20),
    sourceFile: document.sourceFile ? normalizeFileReference(document.sourceFile) : null
  };
}

function normalizeFileReference(reference: SignatureFileReference): SignatureFileReference {
  if (!isSafeStorageNamespace(reference.kind)) throw new SignatureError('INVALID_STORAGE_NAMESPACE', '存储命名空间无效');
  if (!isSafeStorageFileName(reference.fileName)) throw new SignatureError('INVALID_STORAGE_FILE_NAME', '存储文件名无效');
  return {
    kind: reference.kind,
    fileName: reference.fileName,
    contentType: normalizeOptionalText(reference.contentType, 120),
    sha256: normalizeSha256(reference.sha256),
    sizeBytes: normalizeNonNegativeInteger(reference.sizeBytes, 'file size')
  };
}

function normalizePosition(
  input: SignatureSignerInput['positions'][number],
  signatureRequestId: string,
  signerId: string,
  id: string,
  createdAt: string
): SignaturePosition {
  const page = normalizeNonNegativeInteger(input.page, 'signature page');
  const [x0, y0, x1, y1] = [input.x0, input.y0, input.x1, input.y1].map((value) => finiteNumber(value, 'signature coordinate'));
  if (x1 <= x0 || y1 <= y0) throw new SignatureError('INVALID_SIGNATURE_POSITION', '签字位置范围无效');
  return {
    id,
    signatureRequestId,
    signerId,
    page: page!,
    x0,
    y0,
    x1,
    y1,
    strategy: boundedText(input.strategy ?? 'D', 30, 'signature strategy'),
    label: normalizeOptionalText(input.label, 120),
    required: input.required ?? true,
    createdAt
  };
}

function normalizeEvidence(
  input: SignatureEvidenceInput,
  identity: Pick<SignatureEvidence, 'id' | 'signatureRequestId' | 'signerId' | 'submittedByPersonId' | 'signedAt' | 'createdAt'>
): SignatureEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SignatureError('INVALID_SIGNATURE_EVIDENCE', '签字证据必须是对象');
  }
  const storageRef = input.storageRef ? normalizeFileReference(input.storageRef) : null;
  const signatureUrl = normalizeOptionalText(input.signatureUrl, 2000);
  if (!storageRef && !signatureUrl) throw new SignatureError('SIGNATURE_EVIDENCE_REQUIRED', '签字证据必须提供存储引用或兼容 URL');
  const rawClientMetadata = input.clientMetadata ?? {};
  if (!rawClientMetadata || typeof rawClientMetadata !== 'object' || Array.isArray(rawClientMetadata)) {
    throw new SignatureError('INVALID_CLIENT_METADATA', '签字客户端元数据必须是对象');
  }
  const entries = Object.entries(rawClientMetadata);
  if (entries.length > 50) throw new SignatureError('TOO_MUCH_CLIENT_METADATA', '签字客户端元数据字段过多');
  const normalizedEntries: Array<[string, string | number | boolean | null]> = [];
  const normalizedKeys = new Set<string>();
  for (const [key, value] of entries) {
    const normalizedKey = boundedText(key, 80, 'metadata key');
    if (normalizedKeys.has(normalizedKey)) throw new SignatureError('INVALID_CLIENT_METADATA', '签字客户端元数据字段重复');
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new SignatureError('INVALID_CLIENT_METADATA', '签字客户端元数据值必须是字符串、有限数字、布尔值或 null');
    }
    normalizedKeys.add(normalizedKey);
    normalizedEntries.push([normalizedKey, value]);
  }
  const clientMetadata = Object.fromEntries(normalizedEntries);
  return {
    ...identity,
    storageRef,
    signatureUrl,
    contentType: boundedText(input.contentType ?? storageRef?.contentType ?? 'image/png', 120, 'signature content type'),
    sha256: normalizeSha256(input.sha256 ?? storageRef?.sha256),
    sizeBytes: normalizeNonNegativeInteger(input.sizeBytes ?? storageRef?.sizeBytes, 'signature size'),
    width: normalizePositiveInteger(input.width, 'signature width'),
    height: normalizePositiveInteger(input.height, 'signature height'),
    clientMetadata
  };
}

function normalizeListInput(input: SignatureListInput): SignatureListInput {
  return {
    sourceAppId: input.sourceAppId ? appId(input.sourceAppId) : undefined,
    status: normalizeStatusFilter(input.status),
    signerPersonId: input.signerPersonId ? uuid(input.signerPersonId, 'signer person id') : undefined,
    limit: input.limit
  };
}

function normalizeStatusFilter(value: SignatureListInput['status']) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry) => requestStatus(entry));
  return requestStatus(value as string);
}

function requestStatus(value: string) {
  if (!SIGNATURE_REQUEST_STATUSES.includes(value as SignatureRequest['status'])) throw new SignatureError('INVALID_SIGNATURE_STATUS', '签字请求状态无效');
  return value as SignatureRequest['status'];
}

function resourceForSigners(signers: readonly SignatureSigner[], fallbackOwnerPersonId: string | null): AuthorizationResource {
  return {
    ownerPersonId: signers.find((signer) => signer.personId)?.personId ?? fallbackOwnerPersonId,
    organizationUnitId: signers.find((signer) => signer.expectedOrganizationUnitId)?.expectedOrganizationUnitId ?? null,
    targets: [...new Set(signers.map((signer) => signer.expectedOrganizationUnitId).filter((value): value is string => Boolean(value)))]
      .map((id) => ({ type: 'organization' as const, id }))
  };
}

function assertExecutionSource(context: PlatformActorContext, sourceAppId: string) {
  if (context.execution.type !== 'platform' && context.execution.appId !== sourceAppId) {
    throw new SignatureError('SOURCE_APP_MISMATCH', '执行上下文与签字来源应用不一致');
  }
}

function ownSourceExecution(context: PlatformActorContext, sourceAppId: string) {
  return context.execution.type !== 'platform' && context.execution.appId === sourceAppId;
}

function normalizePublicToken(value: string) {
  const token = boundedText(value, 200, 'public token');
  if (token.length < 24) throw new SignatureError('INVALID_PUBLIC_TOKEN', '签字公开令牌长度不足');
  return token;
}

function tokenHash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenPreview(value: string) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function payloadHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizePayload(entry)]));
  }
  return value;
}

function operationPayload(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizePayload(value);
  if (typeof normalized !== 'object' || Array.isArray(normalized)) return { value: normalized };
  return redactRawTokens(normalized as Record<string, unknown>);
}

function redactRawTokens(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['publicToken', 'public_token'].includes(key))
    .map(([key, entry]) => [key, entry && typeof entry === 'object' && !Array.isArray(entry) ? redactRawTokens(entry as Record<string, unknown>) : entry]));
}

function validLegacyPosition(signer: LegacySignatureSnapshot['signers'] extends readonly (infer T)[] | undefined ? T : never) {
  return Boolean(signer)
    && Number.isSafeInteger(signer.page)
    && signer.page >= 0
    && [signer.x0, signer.y0, signer.x1, signer.y1].every(Number.isFinite)
    && signer.x1 > signer.x0
    && signer.y1 > signer.y0;
}

function normalizeDate(value: Date | null, label: string) {
  if (!value) return null;
  if (Number.isNaN(value.getTime())) throw new SignatureError('INVALID_DATE', `${label} 无效`);
  return value.toISOString();
}

function normalizeSha256(value: string | null | undefined) {
  const hash = normalizeOptionalText(value, 64);
  if (hash && !/^[0-9a-f]{64}$/i.test(hash)) throw new SignatureError('INVALID_SHA256', 'SHA-256 无效');
  return hash?.toLowerCase() ?? null;
}

function normalizeNonNegativeInteger(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new SignatureError('INVALID_INTEGER', `${label} 无效`);
  return value;
}

function normalizePositiveInteger(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new SignatureError('INVALID_INTEGER', `${label} 无效`);
  return value;
}

function finiteNumber(value: number, label: string) {
  if (!Number.isFinite(value)) throw new SignatureError('INVALID_NUMBER', `${label} 无效`);
  return value;
}

function boundedText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string') throw new SignatureError('INVALID_TEXT', `${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new SignatureError('REQUIRED_TEXT', `${label} 不能为空`);
  if (text.length > maxLength) throw new SignatureError('TEXT_TOO_LONG', `${label} 超过长度限制`);
  return text;
}

function normalizeOptionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new SignatureError('INVALID_TEXT', '可选文本必须是字符串');
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw new SignatureError('TEXT_TOO_LONG', '可选文本超过长度限制');
  return text;
}

function appId(value: string) {
  if (!/^[a-z][a-z0-9_-]{1,98}[a-z0-9]$/.test(value)) throw new SignatureError('INVALID_APP_ID', '应用 ID 无效');
  return value;
}

function uuid(value: string, label: string) {
  const text = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new SignatureError('INVALID_UUID', `${label} 无效`);
  }
  return text.toLowerCase();
}
