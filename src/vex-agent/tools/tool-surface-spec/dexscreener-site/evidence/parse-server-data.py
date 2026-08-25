import re, json, sys
html = open(sys.argv[1] if len(sys.argv)>1 else 'robinhood.html','rb').read().decode('utf-8','replace')
i = html.find('window.__SERVER_DATA = ') + len('window.__SERVER_DATA = ')
depth=0; j=i; instr=False; esc=False
while j < len(html):
    c = html[j]
    if instr:
        if esc: esc=False
        elif c=='\\': esc=True
        elif c=='"': instr=False
    else:
        if c=='"': instr=True
        elif c=='{': depth+=1
        elif c=='}':
            depth-=1
            if depth==0: j+=1; break
    j+=1
raw = html[i:j]
raw = re.sub(r'BigInt\("(-?\d+)"\)', r'\1', raw)
raw = re.sub(r':undefined([,}])', r':null\1', raw)
raw = re.sub(r'new Date\((\d+|"[^"]*")\)', r'\1', raw)
raw = re.sub(r'new URL\(("[^"]*")\)', r'\1', raw)
st = json.loads(raw)
json.dump(st, open(sys.argv[2] if len(sys.argv)>2 else 'state.json','w'), indent=1)
route = st['route']
print('route:', {k:v for k,v in route.items() if k!='data'})
data = route['data']
print('data keys:', list(data.keys()))
ds = data['dexScreenerData']
print('dexScreenerData keys:', list(ds.keys()))
for k,v in ds.items():
    if k!='pairs': print('  ', k, '=', json.dumps(v)[:400])
pairs = ds['pairs']
print('pairs count:', len(pairs))
if '--schema' in sys.argv:
    print('pair[0]:', json.dumps(pairs[0], indent=1))
print('top-level keys:', list(st.keys()))
