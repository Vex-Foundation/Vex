#!/usr/bin/env node
/**
 * Copies brand assets (logo, vex avatar) into src/renderer/public/ with
 * EXIF/metadata stripped. Privacy hygiene: source files may carry editor
 * metadata that we do not want bundled into a wallet binary.
 *
 * Idempotent — re-run when source assets change. Validates byte-budget
 * limits so CI fails on unexpected size regressions.
 */

import { mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const VEX_APP = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.join(VEX_APP, "src", "renderer", "public");

const SOURCES = [
  {
    src: path.join(REPO_ROOT, "src", "vex-agent", "public", "vex.jpg"),
    dest: path.join(PUBLIC_DIR, "vex.jpg"),
    expect: { width: 1254, height: 1254, format: "jpeg", maxBytes: 130_000 },
  },
];

mkdirSync(PUBLIC_DIR, { recursive: true });

const failures = [];
let processed = 0;

for (const entry of SOURCES) {
  if (!existsSync(entry.src)) {
    failures.push(`source missing: ${entry.src}`);
    continue;
  }

  const pipeline = sharp(entry.src);
  const meta = await pipeline.metadata();

  if (meta.width !== entry.expect.width || meta.height !== entry.expect.height) {
    failures.push(
      `${path.basename(entry.src)}: dimensions ${meta.width}x${meta.height}, expected ${entry.expect.width}x${entry.expect.height}`
    );
    continue;
  }

  // Sharp's default output strips EXIF/IPTC/XMP/ICC. Calling .withMetadata()
  // is what KEEPS them — we explicitly do NOT call it. We re-decode the pixel
  // data and emit a fresh container so no provenance metadata remains.
  const transformer = sharp(entry.src);

  if (entry.expect.format === "png") {
    await transformer.png({ compressionLevel: 9 }).toFile(entry.dest);
  } else if (entry.expect.format === "jpeg") {
    await transformer.jpeg({ quality: 85, progressive: true }).toFile(entry.dest);
  } else {
    failures.push(`${path.basename(entry.src)}: unsupported format ${entry.expect.format}`);
    continue;
  }

  const size = statSync(entry.dest).size;
  if (size > entry.expect.maxBytes) {
    failures.push(
      `${path.basename(entry.dest)}: ${size} bytes exceeds budget ${entry.expect.maxBytes}`
    );
    continue;
  }

  processed += 1;
  console.log(`✓ ${path.basename(entry.dest)} (${size} bytes, ${meta.width}x${meta.height})`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} brand asset issue(s):`);
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}

console.log(`\nProcessed ${processed} brand asset(s) into ${path.relative(VEX_APP, PUBLIC_DIR)}/`);
