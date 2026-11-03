import sqlite3, datetime, struct, os, json

base = r'D:\OpenHarmony\competition\evidence\2026-10-27-wireless-without-usb\dayu-net\raw'

def ip(n):
    return '.'.join(str(b) for b in struct.pack('>I', n))

print('== epoch decode ==')
for t in (1793110465, 1793110522, 1791598674):
    print(t, '->', datetime.datetime.utcfromtimestamp(t).isoformat() + 'Z',
          '/', datetime.datetime.fromtimestamp(t).isoformat(), 'local')
print('== uint32 ip decode ==')
for n in (176128643, 176128729, 180120641, 180120697, 4294967040):
    print(n, '->', ip(n) if n <= 0xFFFFFFFF else n)

for dbname in ('wifi_history_record.db', 'wifi_pro.db'):
    path = os.path.join(base, dbname)
    print('\n===== ' + dbname + ' =====')
    try:
        c = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
        tables = [r[0] for r in c.execute("select name from sqlite_master where type='table'")]
        print('tables:', tables)
        for t in tables:
            cols = [d[1] for d in c.execute('PRAGMA table_info(%s)' % t)]
            print('--- table', t, 'cols:', cols)
            for row in c.execute('select * from %s limit 10' % t):
                print('   ', row)
    except Exception as e:
        print('ERR', repr(e))
