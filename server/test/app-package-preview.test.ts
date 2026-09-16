import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {previewVerifiedPackage} from '../src/app-platform/management/preview.ts';
import {signAppDirectory} from '../src/app-platform/developer/signature.ts';
import type {ApprovalDocument} from '../src/app-platform/management/approvals.ts';
import type {PlatformManagementContext} from '../src/platform/context/index.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';

test('package preview verifies signatures, exposes exact requested capabilities and detects trust changes during review',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-preview-')),directory=join(root,'input'),signatureFile=join(root,'signature.json');
 try{
  await cp(new URL('../../examples/app-sdk/dist/sandbox/',import.meta.url),directory,{recursive:true});
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  const keys=generateKeyPairSync('ed25519'),keyFile=join(root,'private.pem');await writeFile(keyFile,keys.privateKey.export({format:'pem',type:'pkcs8'}));await signAppDirectory(directory,'preview-key',keyFile,signatureFile);
  const state:ApprovalDocument={revision:1,approvedManifestDigests:[],policy:{policyVersion:'1.0',revision:1,keys:[{keyId:'preview-key',publisherId:manifest.publisherId,publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),revoked:false,appIds:[manifest.id],validFrom:'2020-01-01T00:00:00Z',validUntil:'2099-01-01T00:00:00Z'}]}};
  let allowed=true;
  const actor={actorType:'administrator',administrator:{id:'admin'},execution:{type:'platform'},authorize:async()=>({allowed})} as unknown as PlatformManagementContext;
  const options={state:async()=>structuredClone(state),installed:async()=>null as AppInstallation|null,supported:async()=>false};
  const preview=await previewVerifiedPackage(actor,{directory,signatureFile},options);assert.equal(preview.approved,false);assert.equal(preview.supported,false);assert.deepEqual(preview.manifest,manifest);assert.equal(preview.keyId,'preview-key');assert.equal(preview.digest.length,64);
  state.approvedManifestDigests=[preview.digest];assert.equal((await previewVerifiedPackage(actor,{directory,signatureFile},options)).approved,true);
  options.installed=async()=>({manifest:{...manifest,version:'0.0.1',permissions:{...manifest.permissions,requested:[]}},revision:12,enabled:false} as AppInstallation);
  const changed=await previewVerifiedPackage(actor,{directory,signatureFile},options);assert.deepEqual(changed.changes.addedPermissions,manifest.permissions.requested);assert.equal(changed.installed?.revision,12);
  options.supported=async()=>{state.policy.revision++;state.revision++;return true;};
  await assert.rejects(previewVerifiedPackage(actor,{directory,signatureFile},options),/APPROVAL_STALE_REVISION/);
  options.supported=async()=>true;state.policy.keys[0].revoked=true;
  await assert.rejects(previewVerifiedPackage(actor,{directory,signatureFile},options),/UNTRUSTED_PUBLISHER_KEY/);state.policy.keys[0].revoked=false;
  allowed=false;await assert.rejects(previewVerifiedPackage(actor,{directory,signatureFile},options),/INSTALL_ACCESS_DENIED/);allowed=true;
  manifest.name+='tampered';await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(previewVerifiedPackage(actor,{directory,signatureFile},options),/PACKAGE_SIGNATURE_MISMATCH/);
 }finally{await rm(root,{recursive:true,force:true});}
});
