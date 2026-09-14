import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import { AppStorageError } from './binding.js';
import type { AppMigrationExecutionRequest } from './migration-executor.js';

export interface AppMigrationTransactionEvidence { xid: string; database: string }
/** Trusted platform composition only. Client must be pinned to the driver's original database cluster. */
export class AppMigrationReceipts {
 constructor(private readonly client: QueryableClient) {}

 async dispatch(request: AppMigrationExecutionRequest): Promise<void> {
  await runDatabaseTransaction(this.client, async () => {
   await this.match(request);
   await this.client.query(`INSERT INTO platform_app_migration_receipts
    (attempt_id,installation_id,manifest_digest,artifact_sha256) VALUES($1,$2,$3,$4)`,
    [request.attemptId,request.binding.installationId,request.binding.manifestDigest,request.step.sha256]);
  });
 }

 async recordTransaction(request: AppMigrationExecutionRequest, evidence: AppMigrationTransactionEvidence): Promise<void> {
  if (!/^[0-9]{1,20}$/.test(evidence.xid) || BigInt(evidence.xid)>18446744073709551615n
   || !evidence.database || Buffer.byteLength(evidence.database)>63 || evidence.database.includes('\0'))
   throw new AppStorageError('MIGRATION_INVALID_TRANSACTION_EVIDENCE');
  await runDatabaseTransaction(this.client, async () => {
   await this.match(request);
   const result = await this.client.query(`UPDATE platform_app_migration_receipts SET transaction_id=$3,database_name=$4
    WHERE attempt_id=$1 AND installation_id=$2 AND transaction_id IS NULL
    AND manifest_digest=$5 AND artifact_sha256=$6 AND current_database()=$4 RETURNING attempt_id`,
    [request.attemptId,request.binding.installationId,evidence.xid,evidence.database,request.binding.manifestDigest,request.step.sha256]) as {rows:unknown[]};
   if (result.rows.length!==1) throw new AppStorageError('MIGRATION_RECEIPT_CONFLICT');
  });
 }

 private async match(r: AppMigrationExecutionRequest) {
  const result = await this.client.query(`SELECT id FROM platform_app_migration_attempts
   WHERE id=$1 AND installation_id=$2 AND status='running' AND registered_revision=$3
   AND manifest_digest=$4 AND ordinal=$5 AND migration_id=$6 AND artifact_id=$7
   AND artifact_path=$8 AND artifact_sha256=$9 AND artifact_bytes=$10 FOR UPDATE`,
   [r.attemptId,r.binding.installationId,r.revision,r.binding.manifestDigest,r.ordinal,r.step.id,
    r.step.artifactId,r.step.path,r.step.sha256,r.step.bytes]) as {rows:unknown[]};
  if(result.rows.length!==1) throw new AppStorageError('MIGRATION_RECEIPT_CONFLICT');
 }
}
