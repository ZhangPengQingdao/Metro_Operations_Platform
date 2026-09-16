#!/usr/bin/env python3
"""Build an immutable, signed amd64 release from locally built Docker images."""
from updater import file_hash
import hashlib,json,pathlib,re,subprocess,sys
VERSION=re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
def run(*args):return subprocess.check_output(args,text=True).strip()
def build(version,out,key):
 if not VERSION.fullmatch(version):raise ValueError('Invalid version')
 root=pathlib.Path(out);root.mkdir(parents=True,exist_ok=False)
 images={}
 for name,ref in [('api',f'mop-api:{version}'),('web',f'mop-web:{version}'),('database',json.loads(pathlib.Path('deploy/images.json').read_text())['postgres'])]:
  data=json.loads(run('docker','image','inspect',ref))[0]
  if data['Architecture']!='amd64' or data['Os']!='linux':raise ValueError('Wrong architecture')
  images[name]=data['Id']
 subprocess.run(['docker','save','-o',str(root/'images.tar'),*images.values()],check=True)
 archive=root/'images.tar'
 digest=file_hash(archive)
 manifest={'format':1,'version':version,'architecture':'linux/amd64','repository':'ZhangPengQingdao/Metro_Operations_Platform',
  'commit':run('git','rev-parse','HEAD'),'minUpdater':2,'upgradeFromMin':'0.2.0','databaseMajor':17,
  'images':images,'artifact':{'name':'images.tar','sha256':digest,'bytes':archive.stat().st_size}}
 (root/'release.json').write_text(json.dumps(manifest,sort_keys=True,separators=(',',':')))
 subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',key,'-in',str(root/'release.json'),'-out',str(root/'release.sig')],check=True)
if __name__=='__main__':build(*sys.argv[1:])
