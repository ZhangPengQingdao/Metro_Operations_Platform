export async function echo(payload,signal){
 if(signal.aborted)throw Error('ABORTED');
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).join(',')!=='message'||typeof payload.message!=='string'||payload.message.length>config.maxMessageLength)throw Error('INVALID_PAYLOAD');
 return {message:payload.message};
}
import {config} from './config.mjs';
