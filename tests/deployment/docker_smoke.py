"""Disposable Docker-only Linux integration: final image, fresh DB, migrations, admin login, proxy."""
import json,os,pathlib,secrets,subprocess,tempfile,time,urllib.request,uuid
root=pathlib.Path(tempfile.mkdtemp(prefix='mop-linux-smoke-'));suffix=uuid.uuid4().hex[:12];network='mop-test-'+suffix
containers=[]
def run(*args,check=True):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if check and r.returncode:raise RuntimeError('Docker smoke command failed: '+args[0]+' '+args[1])
 return r
try:
 run('docker','network','create',network)
 password=secrets.token_hex(32);admin_password=secrets.token_hex(16)
 db='mop-db-'+suffix;containers.append(db)
 postgres=json.loads(pathlib.Path('deploy/images.json').read_text())['postgres']
 run('docker','pull',postgres)
 secret=root/'postgres';secret.write_text(password);secret.chmod(0o444)
 run('docker','run','-d','-p','127.0.0.1::3101','--name',db,'--network',network,'--network-alias','database','-v',str(secret)+':/run/secrets/password:ro','-e','POSTGRES_PASSWORD_FILE=/run/secrets/password',postgres)
 for _ in range(60):
  if run('docker','exec',db,'pg_isready','-U','postgres',check=False).returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('Postgres not ready')
 sql=f"CREATE ROLE metro_api LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE DATABASE metro_operations_platform OWNER metro_api;"
 # Separate CREATE DATABASE from transaction block.
 for statement in sql.split(';'):
  if statement.strip():
   r=subprocess.run(['docker','exec','-i',db,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],input=statement.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   assert r.returncode==0
 settings={'DATABASE_URL':f'postgresql://metro_api:{password}@127.0.0.1/metro_operations_platform','SESSION_SECRET':secrets.token_hex(32),'AI_PROVIDER_ENCRYPTION_KEY':secrets.token_hex(32),'PUBLIC_BASE_URL':'https://ops.example.com','CORS_ORIGIN':'https://ops.example.com','HOST':'0.0.0.0','MOP_ADMIN_USERNAME':'smokeadmin','MOP_ADMIN_DISPLAY_NAME':'Smoke','MOP_ADMIN_PASSWORD':admin_password}
 # Exercise the same shared database network and managed-storage startup as the trial installer.
 subprocess.run(['docker','exec','-i',db,'psql','-U','postgres','-d','metro_operations_platform','-v','ON_ERROR_STOP=1'],input=b'REVOKE CREATE,TEMPORARY ON DATABASE metro_operations_platform FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;',check=True,stdout=subprocess.DEVNULL)
 import sys
 sys.path.insert(0,str(pathlib.Path('deploy').resolve()))
 from updater import RUNTIME_IMAGE
 run('docker','pull',RUNTIME_IMAGE)
 image=json.loads(run('docker','image','inspect',RUNTIME_IMAGE).stdout)[0]
 apps=root/'apps';apps.mkdir();apps.chmod(0o777)
 for name in ['packages','runtime','uploads']:
  (apps/name).mkdir();(apps/name).chmod(0o777)
 policy=apps/'publishers.json';policy.write_text(json.dumps({'policyVersion':'1.0','revision':1,'keys':[]}));policy.chmod(0o444)
 management=root/'app-management.json'
 management.write_text(json.dumps({'version':1,'artifactRoot':str(apps/'packages'),'runtimeRoot':str(apps/'runtime'),'uploadRoot':str(apps/'uploads'),'publisherPolicyFile':str(policy),'approvedManifestDigests':[],'managedStorage':True,'docker':{'socketPath':'/var/run/docker.sock','runtimeImage':RUNTIME_IMAGE,'approval':{'imageId':image['Id'],'config':image['Config']}}}));management.chmod(0o444)
 settings.update({'MOP_APP_MANAGEMENT_CONFIG':'/run/secrets/app-management.json','MOP_APP_STORAGE_ADMIN_DATABASE_URL':f'postgresql://postgres:{password}@127.0.0.1/metro_operations_platform','MOP_APP_RESOURCE_ORIGIN':'https://resources.example.net'})
 mounts=['--group-add',str(os.stat('/var/run/docker.sock').st_gid),'-v','/var/run/docker.sock:/var/run/docker.sock','-v',str(apps)+':'+str(apps),'-v',str(management)+':/run/secrets/app-management.json:ro']
 config=root/'api.json';config.write_text(json.dumps(settings));config.chmod(0o444)
 common=['docker','run','--rm','--network','container:'+db,*mounts,'-v',str(config)+':/run/secrets/api.json:ro','mop-api:test']
 for _ in range(2):assert run(*common,'dist/setup/database.js').returncode==0
 run(*common,'dist/core/admin-identity/bootstrap.js')
 assert run(*common,'dist/core/admin-identity/bootstrap.js',check=False).returncode!=0
 api='mop-api-'+suffix;containers.append(api)
 run('docker','run','-d','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges','--name',api,'--network','container:'+db,*mounts,'-v',str(config)+':/run/secrets/api.json:ro','mop-api:test')
 port=json.loads(run('docker','inspect',db).stdout)[0]['NetworkSettings']['Ports']['3101/tcp'][0]['HostPort'];base='http://127.0.0.1:'+port
 for _ in range(60):
  try:
   if urllib.request.urlopen(base+'/api/health/ready',timeout=2).status==200:break
  except Exception:time.sleep(1)
 else:
  print(run('docker','logs',api,check=False).stdout.decode()[-6000:]);raise RuntimeError('API not ready')
 req=urllib.request.Request(base+'/api/admin/auth/login',data=json.dumps({'username':'smokeadmin','password':admin_password}).encode(),headers={'Content-Type':'application/json','Origin':'https://ops.example.com'})
 with urllib.request.urlopen(req) as response:
  assert response.status==200;assert 'password' not in json.load(response);assert response.headers.get('Set-Cookie')
 run(*common,'probe.mjs')
 # Validate the installer's actual generated Caddy configuration, not a test-only proxy.
 import updater as installer
 installer.atomic(root/'config.json',{'domain':'ops.example.com','socketGid':os.stat('/var/run/docker.sock').st_gid,'proxyMode':'external','httpPort':18080,'applications':True,'resourcePort':18081,'resourceDomain':'resources.example.net'})
 release=root/'release';release.mkdir()
 images={name:json.loads(run('docker','image','inspect',ref).stdout)[0]['Id'] for name,ref in [('api','mop-api:test'),('web','mop-web:test'),('database',postgres)]}
 archive=release/'images.tar'
 run('docker','tag',postgres,'mop-database:test')
 run('docker','save','-o',str(archive),'mop-api:test','mop-web:test','mop-database:test')
 installer.Deployment(root).prepare(release,{'images':images,'artifact':{'bytes':archive.stat().st_size,'sha256':installer.file_hash(archive)}})
 caddy=release/'Caddyfile'
 web='mop-web-'+suffix;containers.append(web)
 run('docker','run','-d','--name',web,'--network',network,'-p','127.0.0.1::80','-p','127.0.0.1::8081','-e','MOP_DOMAIN=http://localhost','-v',str(caddy)+':/etc/caddy/Caddyfile:ro','mop-web:test')
 webport=json.loads(run('docker','inspect',web).stdout)[0]['NetworkSettings']['Ports']['80/tcp'][0]['HostPort']
 for _ in range(30):
  try:
   req=urllib.request.Request('http://127.0.0.1:'+webport,headers={'Host':'localhost'})
   with urllib.request.urlopen(req) as response:assert b'<html' in response.read().lower()
   break
  except Exception:time.sleep(1)
 else:raise RuntimeError('Web image not ready')
 resourceport=json.loads(run('docker','inspect',web).stdout)[0]['NetworkSettings']['Ports']['8081/tcp'][0]['HostPort']
 resourcebase='http://127.0.0.1:'+resourceport
 with urllib.request.urlopen(urllib.request.Request(resourcebase+'/health/live',headers={'Host':'resources.example.net','Cookie':'platform-session=ignored'})) as response:
  assert response.status==204 and response.headers.get('X-Mop-Resource')=='1' and not response.headers.get('Set-Cookie')
 try:
  urllib.request.urlopen(urllib.request.Request(resourcebase+'/api/health/ready',headers={'Host':'resources.example.net'}))
  raise AssertionError('Platform API exposed on resource domain')
 except urllib.error.HTTPError as error:assert error.code==404
 print('Linux images: fresh DB, repeated migrations, bootstrap, non-root API login and frontend passed.')
finally:
 for name in reversed(containers):run('docker','rm','-f','-v',name,check=False)
 run('docker','network','rm',network,check=False)
 import shutil;shutil.rmtree(root)
