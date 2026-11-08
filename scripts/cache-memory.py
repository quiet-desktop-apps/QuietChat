"""Offline RSS/PSS probe across chat switching, tray hiding and reopening."""
import sys,time,json,os
from pathlib import Path
root=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(root/'native'))
from app import QuietChat, GLib

def pump(seconds=.1):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        time.sleep(.005)
def wait(test):
    end=time.monotonic()+15
    while not test():
        assert time.monotonic()<end,'Probe timed out'
        pump()
def sample(phase):
    out={'phase':phase,'messages':len(app.messages),'sidebar_rows':len(app.chat_rows),'avatar_cache':len(app.chat_avatars)}
    for name,pid in [('ui',os.getpid()),('backend',app.bridge.process.pid)]:
        mem={line.split(':')[0]:int(line.split()[1]) for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines()[1:] if ':' in line}
        out[name]={key:round(mem[key]/1024,2) for key in ['Rss','Pss','Private_Dirty']}
    return out
app=QuietChat(demo=True); app.register(None); app.activate()
try:
    wait(lambda: app.ready and len(app.chat_rows)==3)
    app.open_chat_id('demo-alex@s.whatsapp.net')
    wait(lambda:len(app.messages)>=5 and app.asset_running==0 and app.avatar_request is None);pump(3)
    samples=[sample('visible-warm')]
    for _ in range(10):
        app.open_chat_id('demo-sam@s.whatsapp.net'); wait(lambda:not app.messages)
        app.open_chat_id('demo-alex@s.whatsapp.net'); wait(lambda:len(app.messages)>=5 and app.asset_running==0)
    pump(3);samples.append(sample('after-ten-switches'))
    app.hide_window();pump(3);samples.append(sample('hidden'))
    app.show_chat(None);wait(lambda:len(app.messages)>=5 and app.asset_running==0);pump(3);samples.append(sample('reopened'))
    print(json.dumps(samples,indent=2))
finally:
    app.shutdown();pump(.3)
