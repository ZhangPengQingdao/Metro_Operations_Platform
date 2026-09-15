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
 run('docker','run','-d','--name',db,'--network',network,'--network-alias','database','-v',str(secret)+':/run/secrets/password:ro','-e','POSTGRES_PASSWORD_FILE=/run/secrets/password',postgres)
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
 settings={'DATABASE_URL':f'postgresql://metro_api:{password}@database/metro_operations_platform','SESSION_SECRET':secrets.token_hex(32),'AI_PROVIDER_ENCRYPTION_KEY':secrets.token_hex(32),'PUBLIC_BASE_URL':'https://ops.example.com','CORS_ORIGIN':'https://ops.example.com','HOST':'0.0.0.0','MOP_ADMIN_USERNAME':'smokeadmin','MOP_ADMIN_DISPLAY_NAME':'Smoke','MOP_ADMIN_PASSWORD':admin_password}
 config=root/'api.json';config.write_text(json.dumps(settings));config.chmod(0o444)
 common=['docker','run','--rm','--network',network,'-v',str(config)+':/run/secrets/api.json:ro','mop-api:test']
 for _ in range(2):assert run(*common,'dist/setup/database.js').returncode==0
 run(*common,'dist/core/admin-identity/bootstrap.js')
 assert run(*common,'dist/core/admin-identity/bootstrap.js',check=False).returncode!=0
 api='mop-api-'+suffix;containers.append(api)
 run('docker','run','-d','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges','--name',api,'--network',network,'--network-alias','api','-p','127.0.0.1::3101','-v',str(config)+':/run/secrets/api.json:ro','mop-api:test')
 port=json.loads(run('docker','inspect',api).stdout)[0]['NetworkSettings']['Ports']['3101/tcp'][0]['HostPort'];base='http://127.0.0.1:'+port
 for _ in range(60):
  try:
   if urllib.request.urlopen(base+'/api/health/ready',timeout=2).status==200:break
  except Exception:time.sleep(1)
 else:raise RuntimeError('API not ready')
 req=urllib.request.Request(base+'/api/admin/auth/login',data=json.dumps({'username':'smokeadmin','password':admin_password}).encode(),headers={'Content-Type':'application/json','Origin':'https://ops.example.com'})
 with urllib.request.urlopen(req) as response:
  assert response.status==200;assert 'password' not in json.load(response);assert response.headers.get('Set-Cookie')
 run(*common,'probe.mjs')
 web='mop-web-'+suffix;containers.append(web)
 run('docker','run','-d','--name',web,'--network',network,'-p','127.0.0.1::80','-e','MOP_DOMAIN=http://localhost','mop-web:test')
 webport=json.loads(run('docker','inspect',web).stdout)[0]['NetworkSettings']['Ports']['80/tcp'][0]['HostPort']
 for _ in range(30):
  try:
   req=urllib.request.Request('http://127.0.0.1:'+webport,headers={'Host':'localhost'})
   with urllib.request.urlopen(req) as response:assert b'<html' in response.read().lower()
   break
  except Exception:time.sleep(1)
 else:raise RuntimeError('Web image not ready')
 print('Linux images: fresh DB, repeated migrations, bootstrap, non-root API login and frontend passed.')
finally:
 for name in reversed(containers):run('docker','rm','-f','-v',name,check=False)
 run('docker','network','rm',network,check=False)
 import shutil;shutil.rmtree(root)
