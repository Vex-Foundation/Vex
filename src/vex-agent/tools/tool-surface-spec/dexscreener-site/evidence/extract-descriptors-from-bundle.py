import re, glob, base64, sys
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
# protobuf-es v2: fileDesc("<base64>", [deps])  ; older: proto3.makeMessageType
files = {}
for fn in glob.glob('js/chunks/*.js') + glob.glob('js/*.js'):
    src = open(fn, encoding='utf-8', errors='replace').read()
    for m in re.finditer(r'\("([A-Za-z0-9+/=_-]{200,})"', src):
        b64 = m.group(1)
        try:
            raw = base64.b64decode(b64 + '=' * (-len(b64) % 4))
            fd = descriptor_pb2.FileDescriptorProto()
            fd.ParseFromString(raw)
            if fd.name:
                files[fd.name] = (fd, fn)
        except Exception:
            pass
print(len(files), 'file descriptors found')
for name,(fd,fn) in sorted(files.items()):
    print(f"  {name:55s} pkg={fd.package:30s} msgs={[m.name for m in fd.message_type][:8]}  deps={list(fd.dependency)}  <- {fn.split('/')[-1]}")
# serialize a FileDescriptorSet for reuse
fds = descriptor_pb2.FileDescriptorSet()
for name,(fd,fn) in files.items(): fds.file.append(fd)
open('dexscreener-descriptors.pb','wb').write(fds.SerializeToString())
