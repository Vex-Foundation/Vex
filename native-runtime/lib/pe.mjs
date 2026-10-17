#!/usr/bin/env node
// pe.mjs: the Windows (PE/COFF) half of verify-tree.sh, plus the import
// listing the Windows build scripts use to assemble a tree. Plain Node, no
// dependencies, so it runs on the build runner, the smoke runner and a Mac.
//
//   node pe.mjs verify <tree> <x64|arm64>   refuse a tree that would not run on
//                                           a clean Windows 10/11 (see verify())
//   node pe.mjs needs <tree>                print, one per line and lowercased,
//                                           every DLL some PE in <tree> imports
//                                           that neither Windows nor the tree
//                                           provides
//   node pe.mjs imports <file>...           print each file's machine and imports
//
// A DLL import is satisfied by Windows itself (SYSTEM_DLLS, the api-ms-win-*
// API sets the UCRT and the core OS are reached through), or by a file in the
// importing PE's own directory or in <tree>/bin (the directory of the process
// that loads the Postgres modules in lib/postgresql). The MSVC runtime
// (vcruntime140*.dll, msvcp140*.dll) is NOT part of Windows: a tree that needs
// it must carry it, so a missing redistributable is caught here.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'x86', 0xa641: 'arm64ec' };

// Core OS DLLs present on every Windows 10/11 install (System32). Kept to
// what the trees actually import; widen only with a DLL that ships with
// Windows itself.
const SYSTEM_DLLS = new Set([
  'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'advapi32.dll',
  'ws2_32.dll', 'secur32.dll', 'shell32.dll', 'ole32.dll', 'oleaut32.dll',
  'bcrypt.dll', 'crypt32.dll', 'shlwapi.dll', 'userenv.dll', 'version.dll',
  'psapi.dll', 'iphlpapi.dll', 'dbghelp.dll', 'wldap32.dll', 'mswsock.dll',
  'gdi32.dll', 'rpcrt4.dll', 'ucrtbase.dll',
]);
export const isSystemDll = (name) => SYSTEM_DLLS.has(name) || name.startsWith('api-ms-win-');

// Parse the parts of a PE image the gates need: machine, DLL imports (normal
// and delay-load), a CLR header, and the CodeView (PDB path) debug record.
// Returns null for a file that is not a PE image.
export function peInfo(file) {
  const b = fs.readFileSync(file);
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = b.readUInt32LE(0x3c);
  if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x00004550) return null;
  const machine = b.readUInt16LE(pe + 4);
  const nsec = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const characteristics = b.readUInt16LE(pe + 22);
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  const ndirs = b.readUInt32LE(opt + (pe32plus ? 108 : 92));
  const dirs = opt + (pe32plus ? 112 : 96);
  const dir = (i) => (i < ndirs ? { rva: b.readUInt32LE(dirs + 8 * i), size: b.readUInt32LE(dirs + 8 * i + 4) } : { rva: 0, size: 0 });
  const sections = [];
  for (let i = 0, s = opt + optSize; i < nsec; i++, s += 40) {
    sections.push({ va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20), rawSize: b.readUInt32LE(s + 16) });
  }
  const off = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    }
    throw new Error(`${file}: RVA 0x${rva.toString(16)} is in no section`);
  };
  const cstr = (o) => b.toString('latin1', o, b.indexOf(0, o));

  const imports = [];
  const imp = dir(1);
  if (imp.rva) {
    for (let d = off(imp.rva); ; d += 20) {
      const nameRva = b.readUInt32LE(d + 12);
      if (!nameRva && !b.readUInt32LE(d)) break;
      imports.push(cstr(off(nameRva)).toLowerCase());
    }
  }
  const delayImports = [];
  const dimp = dir(13);
  if (dimp.rva) {
    for (let d = off(dimp.rva); ; d += 32) {
      const nameRva = b.readUInt32LE(d + 4);
      if (!nameRva) break;
      delayImports.push(cstr(off(nameRva)).toLowerCase());
    }
  }
  let pdb = null;
  const dbg = dir(6);
  if (dbg.rva) {
    for (let e = off(dbg.rva), end = e + dbg.size; e + 28 <= end; e += 28) {
      if (b.readUInt32LE(e + 12) !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
      const raw = b.readUInt32LE(e + 24);
      if (b.toString('latin1', raw, raw + 4) === 'RSDS') pdb = cstr(raw + 24);
    }
  }
  return {
    machine: MACHINES[machine] ?? `0x${machine.toString(16)}`,
    dll: (characteristics & 0x2000) !== 0,
    imports, delayImports, pdb,
    clr: dir(14).rva !== 0,
  };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

// Every PE in the tree with its imports and the names it can resolve.
function scan(tree) {
  const files = walk(tree);
  const names = new Map(); // dir -> lowercased file names in it
  for (const f of files) {
    const d = path.dirname(f);
    if (!names.has(d)) names.set(d, new Set());
    names.get(d).add(path.basename(f).toLowerCase());
  }
  const binDir = path.join(tree, 'bin');
  const pes = [];
  for (const f of files) {
    const info = peInfo(f);
    if (!info) continue;
    const resolves = (dll) => isSystemDll(dll) || names.get(path.dirname(f))?.has(dll) || names.get(binDir)?.has(dll);
    pes.push({ file: f, info, missing: [...info.imports, ...info.delayImports].filter((d) => !resolves(d)) });
  }
  return pes;
}

export function verify(tree, wantMachine) {
  const failures = [];
  const pes = scan(tree);
  for (const { file, info, missing } of pes) {
    const rel = path.relative(tree, file);
    if (info.machine !== wantMachine) failures.push(`${rel}: machine ${info.machine}, expected ${wantMachine}`);
    if (info.clr) failures.push(`${rel}: is a .NET assembly`);
    for (const d of missing) failures.push(`${rel}: imports ${d}, which neither Windows nor the tree provides`);
    // A CodeView record names the PDB the linker wrote: an absolute path on
    // the build machine. Release binaries are linked without /DEBUG.
    if (info.pdb) failures.push(`${rel}: carries a PDB path (${info.pdb})`);
  }
  return { checked: pes.length, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, tree, machine] = process.argv.slice(2);
  if (cmd === 'verify' && tree && ['x64', 'arm64'].includes(machine)) {
    const { checked, failures } = verify(path.resolve(tree), machine);
    for (const f of failures) console.error(`[native-runtime] FAIL ${f}`);
    if (!checked) { console.error(`[native-runtime] ERROR: no PE binaries under ${tree}`); process.exit(1); }
    if (failures.length) { console.error(`[native-runtime] ERROR: ${failures.length} problem(s) in ${tree} (${checked} binaries checked)`); process.exit(1); }
    console.error(`[native-runtime] verified ${checked} PE binaries in ${tree} (${machine})`);
  } else if (cmd === 'needs' && tree) {
    const need = new Set(scan(path.resolve(tree)).flatMap((p) => p.missing));
    for (const d of [...need].sort()) console.log(d);
  } else if (cmd === 'imports' && tree) {
    for (const f of process.argv.slice(3)) {
      const i = peInfo(f);
      console.log(`${f}: ${i ? `${i.machine} imports ${i.imports.join(' ')}${i.delayImports.length ? ` delay ${i.delayImports.join(' ')}` : ''}` : 'not a PE'}`);
    }
  } else {
    console.error('usage: pe.mjs verify <tree> <x64|arm64> | needs <tree> | imports <file>...');
    process.exit(2);
  }
}
