import { getDatabasePool } from '../database/index.js';
import { createProductionAdminIdentityService } from './index.js';

// Apply the reviewed migration separately; this command never changes database schema.
const pool = getDatabasePool();
try {
 await createProductionAdminIdentityService(pool).bootstrap({
  username: process.env.MOP_ADMIN_USERNAME,
  displayName: process.env.MOP_ADMIN_DISPLAY_NAME,
  password: process.env.MOP_ADMIN_PASSWORD
 });
 process.stdout.write('Administrator initialized.\n');
} catch {
 process.stderr.write('Administrator initialization failed. Check configuration, migration and whether an administrator already exists.\n');
 process.exitCode = 1;
} finally { await pool?.end(); }
