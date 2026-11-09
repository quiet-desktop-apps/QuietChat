"""Launch the installed command from /tmp, in an isolated Xvfb/D-Bus session."""
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time

with tempfile.TemporaryDirectory(prefix='quietchat-install-check-') as directory:
    env=dict(os.environ,TMPDIR=directory,GDK_BACKEND='x11')
    env.pop('WAYLAND_DISPLAY',None)
    command=Path.home()/'.local/bin/quietchat'
    version=subprocess.check_output([str(command),'--version'],cwd='/tmp',env=env,text=True)
    assert '0.2.15' in version,version
    with open(Path(directory)/'app.log','w+') as log:
        process=subprocess.Popen([str(command),'--demo'],cwd='/tmp',env=env,stdout=log,stderr=log)
        try:
            deadline=time.monotonic()+20
            while time.monotonic()<deadline:
                if process.poll() is not None:
                    log.seek(0); raise AssertionError(log.read())
                tree=subprocess.check_output(['xwininfo','-root','-tree'],env=env,text=True)
                match=re.search(r'(0x[0-9a-f]+) "QuietChat · Offline demo"',tree)
                if match: break
                time.sleep(.1)
            assert match,'Native window did not open through installed command'
            props=subprocess.check_output(['xprop','-id',match.group(1),'_GTK_APPLICATION_ID','WM_CLASS'],env=env,text=True)
            assert 'ch.aboimpinto.QuietChat' in props,props
            args=Path(f'/proc/{process.pid}/cmdline').read_bytes().replace(b'\0',b' ').decode()
            assert 'native/app.py --demo' in args,args
            time.sleep(.5)
            print(version.strip()); print(props.strip())
            print('Installed command opens GTK4 from /tmp; same checkout, version and application identity.')
        finally:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=8)
            assert not list(Path(directory).glob('quietchat-native-demo-*')), 'Backend did not clean up its offline state'
