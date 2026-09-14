import {getDatabasePool} from '../core/database/index.js';
import {initializePlatformDatabase} from './schema.js';
const pool=getDatabasePool();if(!pool)throw new Error('DATABASE_URL_REQUIRED');
const client=await pool.connect();
try{const applied=await initializePlatformDatabase(client);console.log(`Platform database ready (${applied.length} migrations applied).`);}
finally{client.release();await pool.end();}
