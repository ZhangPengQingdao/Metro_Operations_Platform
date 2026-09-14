import {defineConfig,loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode})=>{
 const env=loadEnv(mode,process.cwd(),'');
 const port=Number(env.VITE_DEV_PORT??3100);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid VITE_DEV_PORT');
 return {plugins:[react()],server:{host:'127.0.0.1',port,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:3101',changeOrigin:false}}}};
});
