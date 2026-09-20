import importlib.util,json,pathlib,tempfile,unittest,uuid,subprocess,hashlib
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('updater',pathlib.Path(__file__).parents[2]/'deploy/updater.py');u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class Fixture(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
  u.atomic(self.root/'current.json',{'version':'0.2.0'})
  self.m={'format':1,'version':'0.3.0','architecture':'linux/amd64','repository':u.REPO,'commit':'a'*40,'minUpdater':1,'upgradeFromMin':'0.2.0','databaseMajor':17,'images':{k:'sha256:'+'b'*64 for k in ['api','web','database']},'artifact':{'name':'images.tar','sha256':hashlib.sha256(b'image').hexdigest(),'bytes':5}}
  self.folder=self.root/'releases/0.3.0';self.folder.mkdir(parents=True);(self.folder/'images.tar').write_bytes(b'image')
  self.key=self.root/'private.pem';self.public=self.root/'release-public.pem'
  u.command(['openssl','genpkey','-algorithm','Ed25519','-out',str(self.key)])
  u.command(['openssl','pkey','-in',str(self.key),'-pubout','-out',str(self.public)])
  self.sign()
 def tearDown(self):self.temp.cleanup()
 def sign(self):
  u.atomic(self.folder/'release.json',self.m)
  u.command(['openssl','pkeyutl','-sign','-rawin','-inkey',str(self.key),'-in',str(self.folder/'release.json'),'-out',str(self.folder/'release.sig')])
 def test_signature_artifact_repository_architecture_and_path(self):
  self.assertEqual(u.verify(self.folder,self.public,'0.3.0'),self.m);u.verify_archive(self.folder,self.m)
  (self.folder/'images.tar').write_bytes(b'other')
  with self.assertRaises(u.Failure):u.verify_archive(self.folder,self.m)
  for key,value in [('repository','evil/repo'),('architecture','linux/arm64'),('minUpdater',4)]:
   original=self.m[key];self.m[key]=value;self.sign()
   with self.assertRaises(u.Failure):u.verify(self.folder,self.public,'0.3.0')
   self.m[key]=original
  self.sign();(self.folder/'release.json').write_text('{}')
  with self.assertRaises(u.Failure):u.verify(self.folder,self.public,'0.3.0')
 def test_restart_never_replays(self):
  u.atomic(self.root/'task.json',{'id':str(uuid.uuid4()),'phase':'migrating','action':'install','version':'0.3.0','actorId':str(uuid.uuid4()),'fromVersion':'0.2.0'})
  updater=u.Updater(self.root,github=object(),deployment=object())
  self.assertEqual(updater.task['phase'],'recovery_required')
  with self.assertRaises(u.Failure):updater.start('install','0.3.0',str(uuid.uuid4()),str(uuid.uuid4()))
 def test_reject_downgrade_unstaged_and_arbitrary_action(self):
  updater=u.Updater(self.root,github=object(),deployment=object())
  for action,v in [('download','0.1.0'),('install','0.3.0'),('shell','0.3.0'),('download','../evil')]:
   with self.assertRaises((u.Failure,ValueError)):updater.start(action,v,str(uuid.uuid4()),str(uuid.uuid4()))
 def test_migration_failure_keeps_backup_and_never_switches_or_restores(self):
  calls=[]
  class Deployment:
   def prepare(self,*args):calls.append('prepare')
   def compose(self,_directory,*args):
    calls.append(args)
    if 'dist/setup/database.js' in args:raise u.Failure('MIGRATION_FAILED')
   def backup(self,*args):calls.append('backup')
  updater=u.Updater(self.root,github=object(),deployment=Deployment());updater.task={'id':str(uuid.uuid4()),'phase':'queued','version':'0.3.0','fromVersion':'0.2.0','action':'install'}
  with patch.object(u,'verify',return_value=self.m),patch.object(u,'verify_archive'),patch.object(u,'archive_identities',return_value={'sha256:'+'b'*64:{'sha256:'+'b'*64}}):updater.work('install','0.3.0')
  self.assertEqual(updater.task['phase'],'recovery_required');self.assertIn('backup',calls)
  self.assertFalse(any(isinstance(c,tuple) and c[0]=='up' for c in calls))
  self.assertEqual(u.read(self.root/'current.json')['version'],'0.2.0')
 def test_success_switches_only_after_health(self):
  calls=[];root=self.root
  class Deployment:
   def prepare(self,*args):pass
   def compose(self,_directory,*args):calls.append(args)
   def backup(self,*args):calls.append('backup')
   def web_healthy(self):pass
   def healthy(self,*args):self_check=u.read(root/'current.json')['version'];assert self_check=='0.2.0';calls.append('healthy')
  updater=u.Updater(root,github=object(),deployment=Deployment());updater.task={'id':str(uuid.uuid4()),'phase':'queued','version':'0.3.0','fromVersion':'0.2.0','action':'install'}
  with patch.object(u,'verify',return_value=self.m),patch.object(u,'verify_archive'),patch.object(u,'archive_identities',return_value={'sha256:'+'b'*64:{'sha256:'+'b'*64}}):updater.work('install','0.3.0')
  self.assertEqual(updater.task['phase'],'completed');self.assertEqual(u.read(root/'current.json')['version'],'0.3.0')
 def test_recovery_cannot_restart_old_code_after_migration(self):
  updater=u.Updater(self.root,github=object(),deployment=object());updater.task={'id':str(uuid.uuid4()),'phase':'recovery_required','failedPhase':'migrating','version':'0.3.0','fromVersion':'0.2.0','action':'install'}
  with patch.object(u,'verify',return_value=self.m),patch.object(u,'verify_archive'):
   with self.assertRaisesRegex(u.Failure,'DATABASE_MAY_HAVE_MIGRATED'):updater.recover(updater.task['id'],'restart-current')
   with self.assertRaisesRegex(u.Failure,'VERIFIED_BACKUP_REQUIRED'):updater.recover(updater.task['id'],'resume-target')
 def test_historical_request_never_creates_new_work(self):
  updater=u.Updater(self.root,github=object(),deployment=object());actor=str(uuid.uuid4());request=str(uuid.uuid4())
  recorded={'id':request,'actorId':actor,'action':'download','version':'0.3.0','phase':'failed'}
  u.atomic(self.root/'requests'/request,recorded)
  self.assertEqual(updater.start('download','0.3.0',actor,request),recorded)
  with self.assertRaisesRegex(u.Failure,'REQUEST_CONFLICT'):updater.start('install','0.3.0',actor,request)
 def test_interrupted_recovery_preserves_original_migration_boundary(self):
  class PowerLoss(BaseException):pass
  class Deployment:
   def prepare(self,*args):raise PowerLoss()
  updater=u.Updater(self.root,github=object(),deployment=Deployment())
  task_id=str(uuid.uuid4())
  updater.task={'id':task_id,'phase':'recovery_required','failedPhase':'migrating','version':'0.3.0','fromVersion':'0.2.0','action':'install'}
  u.atomic(self.root/'backups'/task_id/'complete.json',{'taskId':task_id})
  with patch.object(u,'verify',return_value=self.m),patch.object(u,'verify_archive'):
   with self.assertRaises(PowerLoss):updater.recover(task_id,'resume-target')
   restarted=u.Updater(self.root,github=object(),deployment=Deployment())
   self.assertEqual(restarted.task['failedPhase'],'preflight')
   self.assertEqual(restarted.task['recoveryOriginPhase'],'migrating')
   with self.assertRaisesRegex(u.Failure,'DATABASE_MAY_HAVE_MIGRATED'):restarted.recover(task_id,'restart-current')
   with self.assertRaises(PowerLoss):restarted.recover(task_id,'resume-target')
 def test_repeat_install_preserves_completed_installation(self):
  u.atomic(self.root/'installation.json',{'version':'0.2.0','phase':'completed'})
  with patch.object(u.platform,'system',return_value='Linux'),patch.object(u.platform,'machine',return_value='x86_64'),patch.object(pathlib.Path,'read_text',return_value='ID=ubuntu\nVERSION_ID="24.04"'),patch.object(u,'read',return_value={'version':'0.2.0','phase':'completed'}),patch.object(u,'command'),patch.object(u.shutil,'disk_usage',return_value=type('Space',(),{'free':20*1024**3})()):
   u.install(self.root,'0.2.0',str(self.public))
   with self.assertRaisesRegex(u.Failure,'USE_ADMIN_UPDATER'):u.install(self.root,'0.3.0',str(self.public))
 def test_credentials_never_follow_untrusted_redirect(self):
  github=u.Github('secret')
  class Opener:
   def open(self,req,timeout):
    self.request=req
    raise u.urllib.error.HTTPError(req.full_url,302,'',{'Location':'https://evil.example/file'},None)
  opener=Opener();github.opener=opener
  with self.assertRaises(u.Failure):github.fetch('https://api.github.com/repos/a/b')
  self.assertEqual(opener.request.get_header('Authorization'),'Bearer secret')
 def test_compose_limits_api_privileges(self):
  u.atomic(self.root/'config.json',{'domain':'ops.example.com','socketGid':999})
  deployment=u.Deployment(self.root)
  info=[{'Id':'sha256:'+'b'*64,'Architecture':'amd64','Os':'linux'}]
  with patch.object(u,'load_images',return_value=self.m['images']):deployment.prepare(self.folder,self.m)
  services=u.read(self.folder/'compose.json')['services']
  self.assertNotIn('ports',services['database']);self.assertNotIn('ports',services['api'])
  self.assertNotIn('privileged',services['api']);self.assertTrue(services['api']['read_only'])
  self.assertFalse(any('docker.sock' in v for v in services['api']['volumes']))
if __name__=='__main__':unittest.main()

class ProxyDeployment(unittest.TestCase):
 def test_external_hosting_binds_only_loopback_and_preserves_database_isolation(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);release=root/'release';release.mkdir()
   u.atomic(root/'config.json',{'domain':'ops.example.com','socketGid':42,'proxyMode':'external','httpPort':18080,'applications':True,'resourcePort':18081,'resourceDomain':'apps.example.net'})
   def command(args,*a,**kw):
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':args[3],'Architecture':'amd64','Os':'linux'}]).encode()
    return b''
   manifest={'images':{name:'sha256:'+'a'*64 for name in ['api','web','database']}}
   real_stat=u.os.stat
   def stat(path,*a,**kw):return type('Stat',(),{'st_gid':100})() if str(path)=='/var/run/docker.sock' else real_stat(path,*a,**kw)
   with patch.object(u,'load_images',return_value=manifest['images']),patch.object(u,'verify_archive'),patch.object(u.os,'stat',side_effect=stat):
    u.Deployment(root).prepare(release,manifest)
   services=u.read(release/'compose.json')['services']
   self.assertEqual(services['web']['ports'],['127.0.0.1:18080:80','127.0.0.1:18081:8081'])
   self.assertNotIn('ports',services['database']);self.assertNotIn('ports',services['api'])
   self.assertEqual(services['api']['network_mode'],'service:database')
   self.assertIn('header_up -Cookie',(release/'Caddyfile').read_text())
   self.assertIn('reverse_proxy database:3103',(release/'Caddyfile').read_text())

class ImageIdentity(unittest.TestCase):
 def archive(self,root):
  import io,tarfile
  configs={};blobs={};entries=[];descriptors=[]
  for role in ['api','web','database']:
   config=json.dumps({'architecture':'amd64','os':'linux','config':{'role':role}}).encode()
   config_id='sha256:'+hashlib.sha256(config).hexdigest();configs[role]=config_id
   blobs['blobs/sha256/'+config_id[7:]]=config
   manifest=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'digest':config_id},'layers':[]}).encode()
   digest='sha256:'+hashlib.sha256(manifest).hexdigest();blobs['blobs/sha256/'+digest[7:]]=manifest
   entries.append({'Config':'blobs/sha256/'+config_id[7:],'RepoTags':None,'Layers':[]})
   descriptors.append({'digest':digest})
  blobs['manifest.json']=json.dumps(entries).encode()
  # Reproduce 0.6.1: only the first image occurs in the OCI index.
  blobs['index.json']=json.dumps({'manifests':descriptors[:1]}).encode()
  with tarfile.open(root/'images.tar','w') as archive:
   for name,data in blobs.items():
    member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
  return configs,descriptors
 def test_containerd_import_repairs_index_without_changing_signed_archive(self):
  import tarfile
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);configs,descriptors=self.archive(root);before=u.file_hash(root/'images.tar');loaded=[]
   aliases=u.archive_identities(root/'images.tar')
   def command(args,*a,**kw):
    if args[:2]==['docker','load']:
     with tarfile.open(args[-1]) as archive:
      index=json.load(archive.extractfile('index.json'))
      self.assertEqual(len(index['manifests']),3)
      self.assertTrue(all(d['annotations']['io.containerd.image.name'].startswith('docker.io/library/mop-import:') for d in index['manifests']))
     loaded.append(True);return b''
    candidate=args[-1]
    if candidate in configs.values():raise u.Failure('COMMAND_FAILED')
    self.assertIn(candidate,[d['digest'] for d in descriptors])
    return json.dumps([{'Id':candidate,'Architecture':'amd64','Os':'linux'}]).encode()
   with patch.object(u,'command',side_effect=command):resolved=u.load_images(root,{'images':configs})
   self.assertEqual(set(resolved.values()),{d['digest'] for d in descriptors});self.assertTrue(loaded)
   self.assertEqual(u.file_hash(root/'images.tar'),before)
   self.assertEqual(set(root.iterdir()),{root/'images.tar'})
 def test_unrelated_or_wrong_architecture_image_is_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);configs,_=self.archive(root)
   for image,arch in [('sha256:'+'f'*64,'amd64'),(configs['api'],'arm64')]:
    with patch.object(u,'command',return_value=json.dumps([{'Id':image,'Architecture':arch,'Os':'linux'}]).encode()):
     with self.assertRaisesRegex(u.Failure,'IMAGE_IDENTITY_MISMATCH'):u.resolve_images(root,{'images':configs})
 def test_progress_is_visible_without_persisting_each_chunk(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);u.atomic(root/'current.json',{'version':'0.6.0'})
   updater=u.Updater(root,github=object(),deployment=object());updater.task={'id':str(uuid.uuid4()),'phase':'downloading'}
   updater.progress(1024,4096)
   self.assertEqual(updater.status()['task']['download'],{'receivedBytes':1024,'totalBytes':4096})
   self.assertFalse(updater.path.exists())
   updater.phase('verifying');self.assertEqual(u.read(updater.path)['download']['receivedBytes'],1024)

class DownloadProgress(unittest.TestCase):
 def test_stream_reports_bytes_and_keeps_file_download_out_of_json_parser(self):
  import io
  with tempfile.TemporaryDirectory() as tmp:
   github=u.Github('secret');seen=[];payload=b'x'*(1024*1024+7)
   with patch.object(github.opener,'open',return_value=io.BytesIO(payload)),patch.object(u.json,'loads',side_effect=AssertionError('File must not be parsed as JSON')):
    github.fetch('https://api.github.com/repos/a/b',pathlib.Path(tmp)/'image',len(payload),seen.append)
   self.assertEqual(seen,[1024*1024,len(payload)])
   self.assertEqual((pathlib.Path(tmp)/'image').read_bytes(),payload)
 def test_download_over_limit_fails(self):
  import io
  with tempfile.TemporaryDirectory() as tmp:
   github=u.Github('secret')
   with patch.object(github.opener,'open',return_value=io.BytesIO(b'12345')):
    with self.assertRaisesRegex(u.Failure,'DOWNLOAD_LIMIT'):github.fetch('https://api.github.com/repos/a/b',pathlib.Path(tmp)/'image',4)
