#!/usr/bin/env python3
"""MOP host updater. Python 3.12 stdlib + OpenSSL + Docker Compose, no web-process privileges."""
import http.client,socket
import argparse,io,base64,fcntl,getpass,grp,hashlib,http.server,json,os,pathlib,platform,re,secrets,shutil,socketserver,subprocess,sys,tarfile,tempfile,threading,time,urllib.error,urllib.parse,urllib.request,uuid
REPO='ZhangPengQingdao/Metro_Operations_Platform'
VERSION=re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
IMAGE=re.compile(r'^sha256:[a-f0-9]{64}$')
RUNTIME_IMAGE='node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'
ACTIVE={'queued','downloading','verifying','loading','verified','preflight','maintenance','backing_up','migrating','switching','health_check','draining','restoring_apps'}
class Failure(Exception):pass
def require(ok,code):
 if not ok:raise Failure(code)
def version(v):
 require(isinstance(v,str) and VERSION.fullmatch(v),'INVALID_VERSION');return tuple(map(int,v.split('.')))
def atomic(path,value,mode=0o600):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 temp=path.with_name(path.name+'.tmp-'+secrets.token_hex(8))
 fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,mode)
 try:
  with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.flush();os.fsync(f.fileno())
  os.replace(temp,path)
  d=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(d)
  finally:os.close(d)
 finally:
  if temp.exists():temp.unlink()
def read(path):return json.loads(pathlib.Path(path).read_text())
def command(args,timeout=600,input=None,output=None):
 try:
  r=subprocess.run(args,input=input,stdout=output or subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)
  require(r.returncode==0,'COMMAND_FAILED');return r.stdout if output is None else b''
 except (subprocess.TimeoutExpired,OSError):raise Failure('COMMAND_UNCONFIRMED') from None
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
class Github:
 def __init__(self,token):self.token=token;self.opener=urllib.request.build_opener(NoRedirect())
 def fetch(self,url,destination=None,limit=131072,progress=None):
  initial=urllib.parse.urlparse(url);require(initial.scheme=='https' and initial.netloc=='api.github.com','INVALID_DOWNLOAD_ORIGIN')
  for _ in range(4):
   target=urllib.parse.urlparse(url)
   require(target.scheme=='https' and not target.username and target.hostname in ['api.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'],'INVALID_REDIRECT')
   headers={'User-Agent':'metro-platform-updater','Accept':'application/octet-stream' if destination else 'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
   if target.hostname=='api.github.com' and self.token:headers['Authorization']='Bearer '+self.token
   try:response=self.opener.open(urllib.request.Request(url,headers=headers),timeout=30)
   except urllib.error.HTTPError as e:
    if e.code in (301,302,303,307,308):url=urllib.parse.urljoin(url,e.headers['Location']);continue
    raise Failure('GITHUB_DOWNLOAD_FAILED') from None
   except (OSError,urllib.error.URLError):raise Failure('GITHUB_UNAVAILABLE') from None
   total=0;chunks=[];f=open(destination,'wb') if destination else None;started=time.monotonic()
   try:
    with response:
     while True:
      block=response.read(1024*1024)
      if not block:break
      total+=len(block);require(total<=limit and time.monotonic()-started<1800,'DOWNLOAD_LIMIT')
      if f:f.write(block)
      else:chunks.append(block)
      if progress:progress(total)
    if f:f.flush();os.fsync(f.fileno());return
    return json.loads(b''.join(chunks))
   finally:
    if f:f.close()
  raise Failure('REDIRECT_LIMIT')
 def release(self,tag=None):
  if tag:version(tag)
  data=self.fetch(f'https://api.github.com/repos/{REPO}/releases/'+('tags/v'+tag if tag else 'latest'))
  require(not data.get('draft') and not data.get('prerelease') and isinstance(data.get('tag_name'),str),'INVALID_RELEASE')
  version(data['tag_name'].removeprefix('v'))
  require(data['tag_name'].startswith('v') and (not tag or data['tag_name']=='v'+tag),'INVALID_RELEASE')
  if tag and data.get('assets')==[]:
   release_id=data.get('id')
   require(type(release_id) is int and release_id>0,'INVALID_RELEASE')
   refreshed=self.fetch(f'https://api.github.com/repos/{REPO}/releases/{release_id}')
   require(refreshed.get('id')==release_id and refreshed.get('tag_name')==data['tag_name'] and not refreshed.get('draft') and not refreshed.get('prerelease') and isinstance(refreshed.get('assets'),list),'INVALID_RELEASE')
   data=refreshed
  return data
 def asset(self,release,name,destination,limit,progress=None):
  found=[a for a in release.get('assets',[]) if a.get('name')==name]
  require(len(found)==1 and type(found[0].get('id')) is int and 0<found[0].get('size',0)<=limit,'MISSING_RELEASE_ASSET')
  self.fetch(f'https://api.github.com/repos/{REPO}/releases/assets/{found[0]["id"]}',destination,limit,progress)
def verify(directory,key,expected):
 directory=pathlib.Path(directory);version(expected)
 require((directory/'release.json').stat().st_size<=65536 and (directory/'release.sig').stat().st_size==64,'INVALID_MANIFEST_SIZE')
 command(['openssl','pkeyutl','-verify','-pubin','-inkey',str(key),'-rawin','-in',str(directory/'release.json'),'-sigfile',str(directory/'release.sig')],30)
 m=read(directory/'release.json')
 require(set(m)=={'format','version','architecture','repository','commit','minUpdater','upgradeFromMin','databaseMajor','images','artifact'}|({'registry'} if m.get('format')==2 else set()),'INVALID_MANIFEST')
 require(m['format'] in (1,2) and m['version']==expected and m['architecture']=='linux/amd64' and m['repository']==REPO and m['minUpdater'] in (1,2,3,4) and m['databaseMajor']==17,'INCOMPATIBLE_RELEASE')
 require(isinstance(m['commit'],str) and re.fullmatch('[a-f0-9]{40}',m['commit']),'INVALID_COMMIT');version(m['upgradeFromMin'])
 require(set(m['images'])=={'api','web','database'} and all(IMAGE.fullmatch(v) for v in m['images'].values()),'INVALID_IMAGES')
 a=m['artifact'];require(set(a)=={'name','sha256','bytes'} and a['name']=='images.tar' and re.fullmatch('[a-f0-9]{64}',a['sha256']) and type(a['bytes']) is int and 0<a['bytes']<=4*1024**3,'INVALID_ARTIFACT')
 if m['format']==2:
  require(m['minUpdater']==4 and isinstance(m['registry'],dict) and set(m['registry'])=={'api','web','database'},'INVALID_REGISTRY_IMAGES')
  for name,ref in m['registry'].items():
   require(isinstance(ref,str) and re.fullmatch(r'ghcr\.io/zhangpengqingdao/metro-operations-platform-'+name+r'@sha256:[a-f0-9]{64}',ref),'INVALID_REGISTRY_IMAGE')
 return m
def file_hash(path):
 h=hashlib.sha256()
 with pathlib.Path(path).open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def verify_archive(directory,m):
 p=pathlib.Path(directory)/'images.tar';require(p.stat().st_size==m['artifact']['bytes'],'ARTIFACT_SIZE_MISMATCH')
 require(file_hash(p)==m['artifact']['sha256'],'ARTIFACT_HASH_MISMATCH')
def archive_identities(path):
 """Map config digests to authenticated OCI manifest/index aliases; never extract files."""
 identities={}
 with tarfile.open(path,'r:*') as archive:
  def document(name,digest=None):
   member=archive.getmember(name)
   require(member.isfile() and member.size<=4*1024**2,'INVALID_IMAGE_METADATA')
   with archive.extractfile(member) as source:data=source.read()
   if digest:require('sha256:'+hashlib.sha256(data).hexdigest()==digest,'IMAGE_METADATA_HASH_MISMATCH')
   return json.loads(data), 'sha256:'+hashlib.sha256(data).hexdigest()
  entries,_=document('manifest.json')
  for entry in entries:
   config,digest=document(entry['Config'])
   require(config.get('architecture')=='amd64' and config.get('os')=='linux','IMAGE_ARCHITECTURE_MISMATCH')
   identities[digest]={digest}
  def visit(descriptor,parents=(),depth=0):
   require(depth<8,'INVALID_IMAGE_METADATA')
   digest=descriptor['digest'];require(IMAGE.fullmatch(digest),'INVALID_IMAGE_METADATA')
   data,_=document('blobs/sha256/'+digest[7:],digest)
   if 'manifests' in data:
    for child in data['manifests']:visit(child,(*parents,digest),depth+1)
   elif 'config' in data:
    config=data['config']['digest']
    if config in identities:identities[config].update((*parents,digest))
  # Older docker save archives can omit untagged images from index.json.
  for member in archive.getmembers():
   if member.isfile() and member.size<=4*1024**2 and re.fullmatch(r'blobs/sha256/[a-f0-9]{64}',member.name):
    try:data,digest=document(member.name)
    except (ValueError,UnicodeError):continue
    if isinstance(data,dict) and data.get('schemaVersion')==2 and ('manifests' in data or isinstance(data.get('config'),dict) and 'digest' in data['config']):
     require(digest=='sha256:'+member.name.rsplit('/',1)[1],'IMAGE_METADATA_HASH_MISMATCH');visit({'digest':digest})
  if 'index.json' in archive.getnames():
   index,_=document('index.json')
   for descriptor in index['manifests']:visit(descriptor)
 return identities

def load_images(directory,m):
 # Keep the signed archive intact. Give every image an explicit import name and OCI
 # index entry in a temporary copy, including images omitted by older docker save.
 identities=archive_identities(directory/'images.tar')
 tags={config:'mop-import:'+config[7:] for config in identities}
 with tarfile.open(directory/'images.tar','r:*') as source, tempfile.TemporaryDirectory(dir=directory) as temp:
  entries=json.load(source.extractfile('manifest.json'));descriptors=[]
  for entry in entries:
   with source.extractfile(entry['Config']) as config_file:config='sha256:'+hashlib.sha256(config_file.read()).hexdigest()
   entry['RepoTags']=[tags[config]]
   for alias in sorted(identities[config]-{config}):
    member=source.getmember('blobs/sha256/'+alias[7:])
    data=json.load(source.extractfile(member))
    if data.get('config',{}).get('digest')==config:
     descriptors.append({'mediaType':data['mediaType'],'digest':alias,'size':member.size,'annotations':{'io.containerd.image.name':'docker.io/library/'+tags[config],'org.opencontainers.image.ref.name':tags[config]}});break
  if 'index.json' in source.getnames():require(len(descriptors)==len(identities),'INCOMPLETE_OCI_ARCHIVE')
  target=pathlib.Path(temp)/'images.tar'
  with tarfile.open(target,'w') as output:
   for member in source.getmembers():
    if member.name in ('manifest.json','index.json'):continue
    output.addfile(member,source.extractfile(member) if member.isfile() else None)
   metadata={'manifest.json':entries}
   if descriptors:metadata['index.json']={'schemaVersion':2,'mediaType':'application/vnd.oci.image.index.v1+json','manifests':descriptors}
   for name,data in metadata.items():
    encoded=json.dumps(data,separators=(',',':')).encode();member=tarfile.TarInfo(name);member.size=len(encoded);output.addfile(member,io.BytesIO(encoded))
  command(['docker','load','-i',str(target)],1800)
 return resolve_images(directory,m,identities)

def resolve_images(directory,m,identities=None):
 if identities is None:identities=archive_identities(directory/'images.tar')
 resolved={}
 for name,expected in m['images'].items():
  matches=[aliases for aliases in identities.values() if expected in aliases]
  require(len(matches)==1,'IMAGE_NOT_IN_SIGNED_ARCHIVE: '+name)
  aliases=matches[0]
  for candidate in [expected,*sorted(aliases-{expected})]:
   try:info=json.loads(command(['docker','image','inspect',candidate]))[0]
   except Failure:continue
   require(info['Id'] in aliases and info['Architecture']=='amd64' and info['Os']=='linux','IMAGE_IDENTITY_MISMATCH: '+name)
   resolved[name]=info['Id'];break
  else:raise Failure('IMAGE_NOT_LOADED: '+name)
 return resolved

def registry_images(m,progress=None):
 resolved={}
 for name,ref in m['registry'].items():
  def inspect():
   info=json.loads(command(['docker','image','inspect',ref]))[0]
   require(info['Architecture']=='amd64' and info['Os']=='linux' and ref in info.get('RepoDigests',[]),'REGISTRY_IMAGE_IDENTITY_MISMATCH')
   return info['Id']
  try:resolved[name]=inspect();cached=True
  except Failure:
   if progress:progress(name,'pulling',len(resolved),3)
   command(['docker','pull','--platform','linux/amd64',ref],1800)
   resolved[name]=inspect();cached=False
  if progress:progress(name,'cached' if cached else 'downloaded',len(resolved),3)
 return resolved

def database_identity(directory,m):
 if m['format']==2:return m['images']['database']
 identities=archive_identities(directory/'images.tar')
 matches=[config for config,aliases in identities.items() if m['images']['database'] in aliases]
 require(len(matches)==1,'DATABASE_IDENTITY_UNKNOWN');return matches[0]

def verify_local_release(directory,m):
 if m['format']==1 or (directory/'images.tar').exists():verify_archive(directory,m)
 else:
  for ref in m['registry'].values():
   info=json.loads(command(['docker','image','inspect',ref]))[0]
   require(ref in info.get('RepoDigests',[]) and info['Architecture']=='amd64' and info['Os']=='linux','REGISTRY_IMAGE_IDENTITY_MISMATCH')

class MaintenanceConnection(http.client.HTTPConnection):
 def __init__(self,path):super().__init__('localhost',timeout=660);self.path=path
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout);self.sock.connect(self.path)

class Deployment:
 def __init__(self,root):self.root=pathlib.Path(root);self.config=read(self.root/'config.json')
 def compose(self,release,*args,output=None):
  return command(['docker','compose','--project-name','mop','--file',str(release/'compose.json'),*args],timeout=600,output=output)
 def prepare(self,directory,m):
  if m.get('format',1)==2 and self.config.get('imageTransport','registry')!='archive':images=registry_images(m)
  else:verify_archive(directory,m);images=load_images(directory,m)
  root=str(self.root);gid=str(self.config['socketGid'])
  uploads=self.root/'uploads';uploads.mkdir(mode=0o700,exist_ok=True);os.chown(uploads,1000,1000)
  api={'image':images['api'],'restart':'unless-stopped','read_only':True,'tmpfs':['/tmp:size=64m'],'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],
   'group_add':[gid],'environment':{'MOP_UPDATER_SOCKET':'/run/mop-updater/control.sock','UPLOAD_DIR':'/var/lib/mop/uploads'},
   'volumes':[root+'/uploads:/var/lib/mop/uploads',root+'/secrets/api.json:/run/secrets/api.json:ro','/run/mop-updater:/run/mop-updater:ro'],
   'networks':['internal','edge'],'stop_grace_period':'60s',
   'healthcheck':{'test':['CMD','node','-e',"fetch('http://127.0.0.1:3101/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],'interval':'5s','timeout':'3s','retries':12}}
  db={'image':images['database'],'restart':'unless-stopped','environment':{'POSTGRES_PASSWORD_FILE':'/run/secrets/postgres','POSTGRES_INITDB_ARGS':'--auth-host=scram-sha-256'},
   'volumes':[root+'/database:/var/lib/postgresql/data',root+'/secrets/postgres:/run/secrets/postgres:ro'],'networks':['internal'],
   'healthcheck':{'test':['CMD-SHELL','pg_isready -U postgres'],'interval':'5s','timeout':'3s','retries':20}}
  web={'image':images['web'],'restart':'unless-stopped','environment':{'MOP_DOMAIN':self.config['domain']},'ports':['80:80','443:443'],
   'volumes':[root+'/caddy:/data'],'networks':['internal','edge']}
  if self.config.get('proxyMode')=='external':
   web['ports']=[f"127.0.0.1:{self.config['httpPort']}:80"]
   web['environment']['MOP_DOMAIN']=':80'
  if m.get('format',1)==2 and self.config.get('applications'):
   maintenance=self.root/'maintenance';maintenance.mkdir(mode=0o700,exist_ok=True);os.chown(maintenance,1000,1000)
   api['volumes'].append(str(maintenance)+':/run/mop-maintenance')
   api['environment'].update({'MOP_MAINTENANCE_SOCKET':'/run/mop-maintenance/control.sock','MOP_MAINTENANCE_STATE':'/run/mop-maintenance/state.json'})
  if self.config.get('applications'):
   if self.config.get('proxyMode')=='external':api['environment']['MOP_APP_TRUSTED_ORIGINS_ENABLED']='true'
   apps=root+'/apps'
   db['networks']=['internal','edge']
   # Shared network namespace keeps both database identities on verified loopback.
   api.pop('networks');api['network_mode']='service:database'
   api['depends_on']={'database':{'condition':'service_healthy'}}
   api['group_add'].append(str(os.stat('/var/run/docker.sock').st_gid))
   api['volumes'] += [apps+':'+apps,root+'/secrets/app-management.json:/run/secrets/app-management.json:ro','/var/run/docker.sock:/var/run/docker.sock']
   proxy=f":80 {{\n handle /api/* {{\n reverse_proxy database:3101\n }}\n handle {{\n root * /srv\n try_files {{path}} /index.html\n file_server\n }}\n}}\n:8081 {{\n header -Set-Cookie\n reverse_proxy database:3103 {{\n header_up -Cookie\n header_up -Authorization\n }}\n}}\n"
   # Direct HTTPS mode also has a dedicated resource virtual host.
   if self.config.get('proxyMode')!='external':
    proxy=proxy.replace(':80 {',self.config['domain']+' {',1).replace(':8081 {',self.config['resourceDomain']+' {',1)
   else:web['ports'].append(f"127.0.0.1:{self.config['resourcePort']}:8081")
   proxy_file=directory/'Caddyfile';proxy_file.write_text(proxy);proxy_file.chmod(0o644)
   web['volumes'].append(str(proxy_file)+':/etc/caddy/Caddyfile:ro')
  atomic(directory/'compose.json',{'services':{'database':db,'api':api,'web':web},'networks':{'internal':{'internal':True},'edge':{}}})
 def maintenance(self,action,task):
  if not self.config.get('applications'):return None
  connection=MaintenanceConnection(str(self.root/'maintenance/control.sock'))
  try:
   connection.request('POST','/maintenance',json.dumps({'action':action,'taskId':task['id'],'actorId':task['actorId']}),{'Content-Type':'application/json'})
   response=connection.getresponse();raw=response.read(1024*1024+1);require(len(raw)<=1024*1024,'MAINTENANCE_RESPONSE_LIMIT');result=json.loads(raw)
   if result.get('snapshot'):atomic(self.root/'requests'/(task['id']+'-applications.json'),result['snapshot'])
   require(response.status==200,'APPLICATION_MAINTENANCE_FAILED: '+str(result.get('error','UNKNOWN')))
   require(result.get('protocol')==1 and result.get('snapshot',{}).get('taskId')==task['id'],'MAINTENANCE_TASK_MISMATCH')
   require(result['snapshot']['phase']==('paused' if action=='prepare' else 'completed'),'APPLICATION_MAINTENANCE_BLOCKED')
   return result['snapshot']
  except (OSError,http.client.HTTPException,ValueError):raise Failure('APPLICATION_MAINTENANCE_UNCONFIRMED') from None
  finally:connection.close()
 def backup(self,current,task):
  database_bytes=sum(p.stat().st_size for p in (self.root/'database').rglob('*') if p.is_file())
  require(shutil.disk_usage(self.root).free>database_bytes*2+1024**3,'BACKUP_SPACE_REQUIRED')
  folder=self.root/'backups'/task;folder.mkdir(mode=0o700,parents=True,exist_ok=False)
  for filename,args in [('database.dump',['pg_dump','-U','postgres','-Fc','metro_operations_platform']),('roles.sql',['pg_dumpall','-U','postgres','--roles-only'])]:
   with (folder/filename).open('wb') as out:self.compose(current,'exec','-T','database',*args,output=out);out.flush();os.fsync(out.fileno())
  # Verify custom dump structure. Roles, credentials, proxy and application artifacts are separate.
  command(['docker','run','--rm','--network','none','-v',str(folder)+':/backup:ro',read(current/'compose.json')['services']['database']['image'],'pg_restore','--list','/backup/database.dump'])
  command(['tar','-czf',str(folder/'configuration.tar.gz'),'-C',str(self.root),'secrets','config.json','current.json',*(['apps'] if self.config.get('applications') else []),*(['maintenance'] if (self.root/'maintenance').exists() else []),*(['uploads'] if (self.root/'uploads').exists() else [])])
  atomic(folder/'complete.json',{'taskId':task,'version':read(current/'release.json')['version']})
 def healthy(self,directory):
  for _ in range(36):
   try:
    self.compose(directory,'exec','-T','api','node','-e',"fetch('http://127.0.0.1:3101/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))");return
   except Failure:time.sleep(5)
  raise Failure('HEALTH_CHECK_FAILED')
 def web_healthy(self):
  for _ in range(24):
   try:
    with urllib.request.urlopen('https://'+self.config['domain']+'/api/health/ready',timeout=5) as response:
     if response.status==200:
      if self.config.get('applications'):
       with urllib.request.urlopen('https://'+self.config['resourceDomain']+'/health/live',timeout=5) as resource:
        if resource.status!=204 or resource.headers.get('X-Mop-Resource')!='1':continue
      return
   except (OSError,urllib.error.URLError):pass
   time.sleep(5)
  raise Failure('HTTPS_HEALTH_CHECK_FAILED')
class Updater:
 def __init__(self,root,github=None,deployment=None):
  self.root=pathlib.Path(root);self.root.mkdir(parents=True,exist_ok=True)
  self.guard=threading.RLock();self.path=self.root/'task.json';self.task=read(self.path) if self.path.exists() else None
  self.github=github or Github((self.root/'secrets/github-token').read_text().strip());self.deployment=deployment or Deployment(root)
  if self.task and self.task['phase'] in ACTIVE:
   self.task['failedPhase']=self.task['phase'];self.phase('recovery_required','INTERRUPTED_NO_REPLAY')
 def phase(self,phase,error=None):
  with self.guard:
   self.task={**self.task,'phase':phase,'updatedAt':int(time.time()),'error':error};atomic(self.path,self.task);atomic(self.root/'requests'/self.task['id'],self.task)
   with (self.root/'audit.jsonl').open('a') as f:f.write(json.dumps(self.task)+'\n');f.flush();os.fsync(f.fileno())
 def progress(self,received,total):
  with self.guard:
   self.task={**self.task,'download':{'receivedBytes':received,'totalBytes':total},'updatedAt':int(time.time())}
 def status(self):
  with self.guard:
   current=read(self.root/'current.json')['version']
   manifest=self.root/'releases'/current/'release.json'
   automatic=manifest.exists() and read(manifest).get('format')==2
   task=dict(self.task) if self.task else None
   snapshot_path=self.root/'maintenance/state.json'
   if task and task.get('applicationSnapshot') and snapshot_path.exists():
    try:
     require(snapshot_path.stat().st_size<=1024*1024,'MAINTENANCE_STATE_LIMIT');snapshot=read(snapshot_path)
     if snapshot.get('taskId')==task['id']:
      entries=snapshot['applications']
      task['applications']={'phase':snapshot['phase'],'total':len(entries),'stopped':sum(e['phase']=='stopped' for e in entries),'restored':sum(e['phase']=='restored' for e in entries),'unchanged':sum(e['phase']=='unchanged' and not e['enabled'] for e in entries)}
    except (Failure,OSError,ValueError,KeyError,TypeError):task['applications']={'phase':'unknown'}
   return {'configured':True,'currentVersion':current,'automaticApplications':automatic,'task':task}
 def check(self):
  release=self.github.release();v=release['tag_name'][1:];current=read(self.root/'current.json')['version']
  return {'version':v,'available':version(v)>version(current),'url':f'https://github.com/{REPO}/releases/tag/v{v}'}
 def start(self,action,v,actor,request_id):
  version(v);require(action in ('download','install'),'INVALID_ACTION');require(str(uuid.UUID(actor))==actor and str(uuid.UUID(request_id))==request_id,'INVALID_IDENTITY')
  with self.guard:
   recorded=self.root/'requests'/request_id
   if recorded.exists():
    previous=read(recorded);require(previous['action']==action and previous['version']==v and previous['actorId']==actor,'REQUEST_CONFLICT');return previous
   require(not self.task or self.task['phase'] not in ACTIVE|{'recovery_required'},'UPDATE_BLOCKED')
   current=read(self.root/'current.json')['version'];require(version(v)>version(current),'VERSION_NOT_NEWER')
   require(action!='install' or self.task and self.task['phase']=='downloaded' and self.task['version']==v,'DOWNLOAD_REQUIRED')
   self.task={'id':request_id,'action':action,'version':v,'actorId':actor,'fromVersion':current,'phase':'queued','updatedAt':int(time.time()),'error':None};self.phase('queued')
   threading.Thread(target=self.work,args=(action,v),daemon=False).start();return dict(self.task)
 def work(self,action,v):
  maintenance=False;migration=False
  try:
   directory=self.root/'releases'/v
   if action=='download':
    self.phase('downloading');directory.mkdir(parents=True,exist_ok=True)
    release=self.github.release(v)
    for name,limit in [('release.json',65536),('release.sig',64)]:self.github.asset(release,name,directory/name,limit)
    m=verify(directory,self.root/'release-public.pem',v)
    require(version(self.task['fromVersion'])>=version(m['upgradeFromMin']),'UNSUPPORTED_UPGRADE_PATH')
    layered=m['format']==2 and self.deployment.config.get('imageTransport','registry')!='archive'
    # Registry transport writes layers directly to Docker; no tar download/extraction reserve.
    require(shutil.disk_usage(self.root).free>(1024**3 if layered else m['artifact']['bytes']*3+1024**3),'DISK_SPACE_REQUIRED')
    if layered:
     def report(name,state,done,total):
      with self.guard:self.task={**self.task,'pull':{'image':name,'state':state,'completed':done,'total':total}}
     registry_images(m,report);self.phase('loading');self.deployment.prepare(directory,m);self.phase('downloaded');return
    total=m['artifact']['bytes'];self.progress(0,total)
    self.github.asset(release,'images.tar',directory/'images.tar',total,lambda received:self.progress(received,total))
    self.phase('verifying');verify_archive(directory,m)
    self.phase('loading');self.deployment.prepare(directory,m);self.phase('downloaded');return
   self.phase('preflight');m=verify(directory,self.root/'release-public.pem',v);verify_local_release(directory,m)
   current=self.root/'releases'/self.task['fromVersion'];old=verify(current,self.root/'release-public.pem',self.task['fromVersion']);verify_local_release(current,old)
   require(old['format']!=2 or m['format']==2,'MAINTENANCE_PROTOCOL_DOWNGRADE')
   require(database_identity(directory,m)==database_identity(current,old),'DATABASE_IMAGE_CHANGE_REQUIRES_MANUAL_UPGRADE')
   require(version(self.task['fromVersion'])>=version(m['upgradeFromMin']),'UNSUPPORTED_UPGRADE_PATH')
   self.deployment.prepare(directory,m)
   if old['format']==2:
    maintenance=True;self.task['applicationSnapshot']=True;self.phase('draining')
    self.deployment.maintenance('prepare',self.task)
   self.deployment.compose(current,'run','--rm','--no-deps','api','probe.mjs')
   self.phase('maintenance');maintenance=True;self.deployment.compose(current,'stop','web','api')
   self.deployment.compose(current,'run','--rm','--no-deps','api','probe.mjs')
   self.phase('backing_up');self.deployment.backup(current,self.task['id'])
   self.phase('migrating');migration=True
   self.deployment.compose(directory,'run','--rm','--no-deps','api','dist/setup/database.js')
   self.phase('switching');self.deployment.compose(directory,'up','-d','--no-deps','api')
   self.phase('health_check');self.deployment.healthy(directory)
   atomic(self.root/'current.json',{'version':v})
   self.deployment.compose(directory,'up','-d','--no-deps','web');self.deployment.web_healthy()
   if self.task.get('applicationSnapshot'):
    self.phase('restoring_apps');self.deployment.maintenance('restore',self.task)
   self.phase('completed')
  except Exception as e:
   code=str(e) if isinstance(e,Failure) else 'UPDATE_UNCONFIRMED'
   # Never revert a possibly migrated database, replay tasks, or silently restart after an unknown write.
   self.task['failedPhase']=self.task['phase'];self.phase('recovery_required' if maintenance or migration else 'failed',code)
 def recover(self,task_id,mode):
  require(self.task and self.task['id']==task_id and self.task['phase']=='recovery_required','RECOVERY_TASK_MISMATCH')
  stage=self.task.get('recoveryOriginPhase',self.task.get('failedPhase'));require(mode in ('restart-current','resume-target'),'INVALID_RECOVERY_MODE')
  directory=self.root/'releases'/(self.task['fromVersion'] if mode=='restart-current' else self.task['version'])
  m=verify(directory,self.root/'release-public.pem',directory.name);verify_local_release(directory,m)
  if mode=='restart-current':require(stage in ('queued','downloading','verifying','loading','verified','preflight','draining','maintenance','backing_up'),'DATABASE_MAY_HAVE_MIGRATED')
  else:
   require(stage in ('migrating','switching','health_check','restoring_apps'),'NO_MIGRATION_TO_RESUME')
   require((self.root/'backups'/task_id/'complete.json').exists(),'VERIFIED_BACKUP_REQUIRED')
  # Keep the original migration boundary across failures/restarts of recovery itself.
  self.task.setdefault('recoveryOriginPhase',stage)
  self.task['recoveryMode']=mode;self.task['recoveryBy']='local-root';self.phase('preflight')
  try:
   if stage=='draining' and mode=='restart-current' and self.task.get('applicationSnapshot'):
    self.deployment.maintenance('restore',self.task);self.phase('cancelled');return
   self.deployment.prepare(directory,m)
   self.deployment.compose(directory,'stop','web','api')
   self.deployment.compose(directory,'run','--rm','--no-deps','api','probe.mjs')
   if mode=='resume-target':
    self.phase('migrating')
    # Platform migration records commit atomically with their schema transaction; only unapplied migrations run.
    self.deployment.compose(directory,'run','--rm','--no-deps','api','dist/setup/database.js')
   self.phase('switching');self.deployment.compose(directory,'up','-d','--no-deps','api')
   self.phase('health_check');self.deployment.healthy(directory)
   atomic(self.root/'current.json',{'version':directory.name})
   self.deployment.compose(directory,'up','-d','--no-deps','web');self.deployment.web_healthy()
   if self.task.get('applicationSnapshot'):
    self.phase('restoring_apps');self.deployment.maintenance('restore',self.task)
   self.phase('completed' if mode=='resume-target' else 'cancelled')
  except Exception:
   self.task['failedPhase']=self.task['phase'];self.phase('recovery_required','RECOVERY_UNCONFIRMED');raise Failure('RECOVERY_UNCONFIRMED') from None
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
 daemon_threads=True
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):self.dispatch()
 def do_POST(self):self.dispatch()
 def dispatch(self):
  try:
   require(self.headers.get('Transfer-Encoding') is None,'INVALID_REQUEST')
   size=int(self.headers.get('Content-Length','0'));require(0<=size<=4096,'INVALID_REQUEST')
   data=json.loads(self.rfile.read(size)) if size else {}
   updater=self.server.updater
   if self.command=='GET' and self.path=='/status':result=updater.status()
   elif self.command=='POST' and self.path=='/check' and data=={}:result=updater.check()
   elif self.command=='POST' and self.path=='/task':
    require(set(data)=={'action','version','actorId','requestId'},'INVALID_REQUEST');result=updater.start(data['action'],data['version'],data['actorId'],data['requestId'])
   else:raise Failure('INVALID_REQUEST')
   payload=json.dumps(result).encode();self.send_response(200)
  except Exception as e:
   payload=json.dumps({'error':str(e) if isinstance(e,Failure) else 'UPDATER_UNAVAILABLE'}).encode();self.send_response(409)
  self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
 def setup(self):super().setup();self.connection.settimeout(15)
def serve(root):
 config=read(pathlib.Path(root)/'config.json');socket='/run/mop-updater/control.sock';os.makedirs(os.path.dirname(socket),mode=0o750,exist_ok=True)
 os.chown(os.path.dirname(socket),0,config['socketGid'])
 if os.path.exists(socket):os.unlink(socket)
 server=Server(socket,Handler);os.chown(socket,0,config['socketGid']);os.chmod(socket,0o660);server.updater=Updater(root);server.serve_forever()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('command',choices=['serve','install','status','recover']);parser.add_argument('--root',default='/opt/metro-platform');parser.add_argument('--version');parser.add_argument('--public-key');parser.add_argument('--task-id');parser.add_argument('--mode',choices=['restart-current','resume-target']);args=parser.parse_args()
 require(os.geteuid()==0,'ROOT_REQUIRED');root=pathlib.Path(args.root);require(root.is_absolute() and not root.is_symlink() and re.fullmatch(r'/[a-zA-Z0-9/_-]+',str(root)),'INVALID_ROOT');root.mkdir(parents=True,exist_ok=True)
 if args.command=='status':print(json.dumps(read(root/'task.json'),ensure_ascii=False,indent=2));return
 lock=open(root/'updater.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if args.command=='serve':serve(root)
 elif args.command=='recover':Updater(root).recover(args.task_id,args.mode)
 else:install(root,args.version,args.public_key)
def install(root,v,key):
 require(platform.system()=='Linux' and platform.machine()=='x86_64','UNSUPPORTED_PLATFORM')
 osrelease=pathlib.Path('/etc/os-release').read_text();require('ID=ubuntu' in osrelease and 'VERSION_ID="24.04"' in osrelease,'UBUNTU_24_04_REQUIRED')
 version(v);require(key and pathlib.Path(key).is_file(),'RELEASE_PUBLIC_KEY_REQUIRED')
 command(['docker','compose','version'],30);command(['docker','info'],30)
 require(shutil.disk_usage(root).free>10*1024**3,'TEN_GIB_DISK_REQUIRED')
 if (root/'current.json').exists() and (root/'installation.json').exists() and read(root/'installation.json')['phase']=='completed':
  require(read(root/'current.json')['version']==v,'USE_ADMIN_UPDATER');print('Already installed. Existing database and credentials preserved.');return
 marker=root/'installation.json'
 if not marker.exists():
  import socket
  mode=input('入口模式：1=1Panel/已有反向代理（默认），2=独占80/443：').strip() or '1'
  require(mode in ('1','2'),'INVALID_PROXY_MODE');external=mode=='1'
  http_port=int(input('平台本机端口 [18080]：').strip() or '18080') if external else 80
  require(1024<=http_port<=65535 if external else True,'INVALID_PORT')
  applications=(input('启用应用试装环境？[y/N]（使用专用数据库的高权限存储连接及 Docker socket，非生产权限隔离）：').strip().lower()=='y')
  resource_port=int(input('应用资源本机端口 [18081]：').strip() or '18081') if external and applications else 8081
  require(not external or not applications or (1024<=resource_port<=65535 and resource_port!=http_port),'INVALID_PORT')
  ports=([http_port]+([resource_port] if applications else [])) if external else [80,443]
  for port in ports:
   with socket.socket() as listener:
    try:listener.bind(('127.0.0.1' if external else '0.0.0.0',port))
    except OSError:raise Failure('HTTP_PORT_IN_USE') from None
  require(not (root/'database').exists(),'EXISTING_DATABASE_REFUSED')
  domain=input('管理端域名（例如 ops.example.com）：').strip().lower()
  require(re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',domain),'INVALID_DOMAIN')
  resource_domain=input('独立应用资源域名（与管理端不同，例如 apps.example.net）：').strip().lower() if applications else ''
  require(not applications or (resource_domain!=domain and re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',resource_domain)),'INVALID_RESOURCE_DOMAIN')
  if external:
   print(f'请在 1Panel 配置 https://{domain} → http://127.0.0.1:{http_port}，保留 Host 请求头。')
   if applications:print(f'应用资源配置 https://{resource_domain} 与 https://*.{resource_domain} → http://127.0.0.1:{resource_port}，配置 wildcard DNS/TLS，保留原始 Host；该域名只用于应用资源，不设置平台 Cookie。')
  username=input('首位管理员用户名：').strip();require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{2,63}',username),'INVALID_USERNAME')
  password=getpass.getpass('管理员密码（至少 12 字符）：');require(12<=len(password) and len(password.encode())<=72 and password==getpass.getpass('再次输入密码：'),'INVALID_PASSWORD')
  token=getpass.getpass('GitHub 私有仓库只读令牌：').strip();require(10<len(token)<512 and not any(c.isspace() for c in token),'INVALID_GITHUB_TOKEN')
  try:gid=grp.getgrnam('mop-update').gr_gid
  except KeyError:command(['groupadd','--system','mop-update']);gid=grp.getgrnam('mop-update').gr_gid
  secretsdir=root/'secrets';secretsdir.mkdir(mode=0o700,exist_ok=False)
  api_password=secrets.token_hex(32);postgres_password=secrets.token_hex(32)
  for name,value in [('postgres',postgres_password),('github-token',token)]:
   p=secretsdir/name;p.write_text(value);p.chmod(0o400)
  os.chown(secretsdir/'postgres',999,999)
  api={'NODE_ENV':'production','HOST':'0.0.0.0','PORT':'3101','DATABASE_URL':f'postgresql://metro_api:{api_password}@database:5432/metro_operations_platform',
   'SESSION_SECRET':secrets.token_hex(32),'AI_PROVIDER_ENCRYPTION_KEY':secrets.token_hex(32),'PUBLIC_BASE_URL':'https://'+domain,'CORS_ORIGIN':'https://'+domain,'COOKIE_SECURE':'true',
   'MOP_ADMIN_USERNAME':username,'MOP_ADMIN_DISPLAY_NAME':'平台管理员','MOP_ADMIN_PASSWORD':password}
  if applications:
   api['DATABASE_URL']=api['DATABASE_URL'].replace('@database:', '@127.0.0.1:')
   api['MOP_APP_STORAGE_ADMIN_DATABASE_URL']=f'postgresql://postgres:{postgres_password}@127.0.0.1:5432/metro_operations_platform'
   api['MOP_APP_MANAGEMENT_CONFIG']='/run/secrets/app-management.json'
   api['MOP_APP_RESOURCE_ORIGIN']='https://'+resource_domain
   if external:api['MOP_APP_TRUSTED_ORIGINS_ENABLED']='true'
  atomic(secretsdir/'api.json',api,0o400);os.chown(secretsdir/'api.json',1000,1000)
  atomic(root/'config.json',{'domain':domain,'socketGid':gid,'bootstrapUsername':username.lower(),'proxyMode':'external' if external else 'direct','httpPort':http_port,'applications':applications,'resourceDomain':resource_domain,'resourcePort':resource_port})
  shutil.copyfile(key,root/'release-public.pem');(root/'release-public.pem').chmod(0o600)
  atomic(marker,{'version':v,'phase':'configured'})
 else:
  require(read(marker)['version']==v,'INSTALL_VERSION_MISMATCH')
  require(pathlib.Path(key).read_bytes()==(root/'release-public.pem').read_bytes(),'KEY_MISMATCH')
 config=read(root/'config.json');directory=root/'releases'/v;directory.mkdir(parents=True,exist_ok=True)
 github=Github((root/'secrets/github-token').read_text().strip());release=github.release(v)
 for name,limit in [('release.json',65536),('release.sig',64)]:github.asset(release,name,directory/name,limit)
 m=verify(directory,root/'release-public.pem',v)
 if m['format']==1 or config.get('imageTransport')=='archive':
  github.asset(release,'images.tar',directory/'images.tar',m['artifact']['bytes']);verify_archive(directory,m)
 if config.get('applications'):
  # The trusted installer pins the runtime digest, independently of application packages.
  command(['docker','pull',RUNTIME_IMAGE],1800)
  image=json.loads(command(['docker','image','inspect',RUNTIME_IMAGE]))[0]
  require(image['Architecture']=='amd64' and image['Os']=='linux' and RUNTIME_IMAGE in image.get('RepoDigests',[]),'RUNTIME_IMAGE_MISMATCH')
  apps=root/'apps';apps.mkdir(mode=0o700,exist_ok=True);os.chown(apps,1000,1000)
  for child in ['packages','runtime','uploads']:
   folder=apps/child;folder.mkdir(mode=0o700,exist_ok=True);os.chown(folder,1000,1000)
  probe=apps/'runtime'/('.visibility-'+secrets.token_hex(16));probe.write_text('mop-runtime-visible');probe.chmod(0o444)
  try:
   command(['docker','run','--rm','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',f'type=bind,src={probe},dst=/probe,readonly',RUNTIME_IMAGE,'node','-e',"if(require('fs').readFileSync('/probe','utf8')!=='mop-runtime-visible')process.exit(1)"],60)
  finally:probe.unlink()
  policy=apps/'publishers.json'
  if not policy.exists():atomic(policy,{'policyVersion':'1.0','revision':1,'keys':[]});os.chown(policy,1000,1000)
  management=root/'secrets/app-management.json'
  if not management.exists():
   atomic(management,{'version':1,'artifactRoot':str(apps/'packages'),'runtimeRoot':str(apps/'runtime'),'uploadRoot':str(apps/'uploads'),'publisherPolicyFile':str(policy),'approvedManifestDigests':[],'managedStorage':True,'docker':{'socketPath':'/var/run/docker.sock','runtimeImage':RUNTIME_IMAGE,'approval':{'imageId':image['Id'],'config':image['Config']}}},0o400);os.chown(management,1000,1000)
 deployment=Deployment(root);deployment.prepare(directory,m)
 os.makedirs('/run/mop-updater',mode=0o750,exist_ok=True);os.chown('/run/mop-updater',0,config['socketGid'])
 deployment.compose(directory,'up','-d','--wait','database')
 api=read(root/'secrets/api.json');db_password=urllib.parse.urlparse(api['DATABASE_URL']).password
 require(re.fullmatch('[a-f0-9]{64}',db_password),'INVALID_SAVED_SECRET')
 sql=f"""DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metro_api') THEN CREATE ROLE metro_api LOGIN PASSWORD '{db_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;
SELECT 'CREATE DATABASE metro_operations_platform OWNER metro_api' WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='metro_operations_platform')\\gexec
REVOKE CREATE,TEMPORARY ON DATABASE metro_operations_platform FROM PUBLIC;
\\connect metro_operations_platform
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metro_api' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'API role is privileged'; END IF; END $$;
"""
 command(['docker','compose','--project-name','mop','--file',str(directory/'compose.json'),'exec','-T','database','psql','-U','postgres','-v','ON_ERROR_STOP=1'],input=sql.encode())
 atomic(marker,{'version':v,'phase':'migrating'})
 deployment.compose(directory,'run','--rm','--no-deps','api','dist/setup/database.js')
 # A prior bootstrap acknowledgement may have been lost. Observe the exact saved administrator first.
 count=deployment.compose(directory,'exec','-T','database','psql','-U','postgres','-d','metro_operations_platform','-Atc','SELECT count(*) FROM platform_admin_accounts').decode().strip()
 if count=='0':
  require('MOP_ADMIN_USERNAME' in api and 'MOP_ADMIN_PASSWORD' in api,'BOOTSTRAP_SECRET_MISSING')
  deployment.compose(directory,'run','--rm','--no-deps','api','dist/core/admin-identity/bootstrap.js')
 else:
  require(count=='1','ADMIN_BOOTSTRAP_CONFLICT')
  existing=deployment.compose(directory,'exec','-T','database','psql','-U','postgres','-d','metro_operations_platform','-Atc','SELECT username FROM platform_admin_accounts').decode().strip()
  require(existing==read(root/'config.json').get('bootstrapUsername',api.get('MOP_ADMIN_USERNAME','')).lower(),'ADMIN_BOOTSTRAP_CONFLICT')
 atomic(marker,{'version':v,'phase':'starting'})
 deployment.compose(directory,'up','-d','api');deployment.healthy(directory)
 # Keep bootstrap secrets until completion, allowing interrupted first installation to be resumed.
 deployment.compose(directory,'up','-d','web');deployment.web_healthy()
 atomic(root/'current.json',{'version':v})
 destination=root/'updater';destination.mkdir(exist_ok=True)
 shutil.copyfile(__file__,destination/'updater.py')
 unit=f'''[Unit]
Description=Metro Operations Platform updater
After=docker.service network-online.target
Requires=docker.service
[Service]
ExecStart=/usr/bin/python3 {destination}/updater.py serve --root {root}
Restart=on-failure
RestartSec=5
UMask=0077
PrivateTmp=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
'''
 pathlib.Path('/etc/systemd/system/mop-updater.service').write_text(unit)
 command(['systemctl','daemon-reload']);command(['systemctl','enable','mop-updater.service']);command(['systemctl','start','--no-block','mop-updater.service'])
 atomic(marker,{'version':v,'phase':'finalizing'})
 for field in ['MOP_ADMIN_USERNAME','MOP_ADMIN_DISPLAY_NAME','MOP_ADMIN_PASSWORD']:api.pop(field,None)
 atomic(root/'secrets/api.json',api,0o400);os.chown(root/'secrets/api.json',1000,1000)
 deployment.compose(directory,'up','-d','--force-recreate','api');deployment.healthy(directory);deployment.web_healthy()
 atomic(marker,{'version':v,'phase':'completed'})
 print('Installed: https://'+config['domain']+'/#/admin')
if __name__=='__main__':
 try:main()
 except (Failure,ValueError,FileNotFoundError,BlockingIOError):print('Operation stopped. Inspect local state; no automatic replay of updates.',file=sys.stderr);sys.exit(1)
