import {createAppBackend} from '@metro/platform-sdk/app-backend';
import {createShiftsHandlers} from './handlers.mjs';

// The platform runs this file in the application's process; platform operations go through backend.gateway.
const backend=createAppBackend({handlers:createShiftsHandlers({invoke:(...args)=>backend.gateway.invoke(...args)})});
