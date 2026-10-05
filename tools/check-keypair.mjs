#!/usr/bin/env node
/**
 * Cross-platform key pair check (Windows PowerShell, macOS, Linux — no openssl,
 * no diff/Compare-Object, no shell redirection).
 *
 *   node tools/check-keypair.mjs <pro.private.pem> <pro.public.pem> [--out-lf FILE]
 *
 * Why this exists: `diff` is a *byte* comparison, so a CRLF, a trailing space or
 * a missing final newline reports "differ" even when the key material is
 * identical. This tool compares the *keys* (semantically), and reports cosmetic
 * differences separately:
 *
 *   HARD (exit 1)  files are not a pair / wrong algorithm / unparseable / BOM
 *   WARN (exit 0)  CRLF, missing trailing newline - still the same key
 *
 * --out-lf writes an LF-normalised copy of the public key (the safest value for
 * the AFFINE_PRO_PUBLIC_KEY secret).
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const [privFile, pubFile] = positional;
const outLfIdx = argv.indexOf('--out-lf');
const outLf = outLfIdx === -1 ? null : argv[outLfIdx + 1];

if (!privFile || !pubFile) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 14).join('\n'));
  process.exit(1);
}

let hard = 0;
let warn = 0;
const hardOk = (label, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) hard++;
};
const soft = (label, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'warn'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) warn++;
};

/** canonical form: BOM stripped, CRLF/CR -> LF, surrounding blank lines dropped */
const canonical = s =>
  s
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();

/** the base64 body only, so we can tell "different key" from "same key, other whitespace" */
const body = s =>
  canonical(s)
    .split('\n')
    .filter(l => !l.startsWith('-----'))
    .join('');

const privRaw = readFileSync(privFile, 'utf8');
const pubRaw = readFileSync(pubFile, 'utf8');
const privBuf = readFileSync(privFile);
const pubBuf = readFileSync(pubFile);

console.log(`private: ${privFile}`);
console.log(`public : ${pubFile}\n`);

hardOk('private PEM header is PKCS#8', /^-----BEGIN PRIVATE KEY-----/m.test(canonical(privRaw)),
  'first line: ' + (canonical(privRaw).split('\n')[0] || '(empty)'));
hardOk('public PEM header is SPKI', /^-----BEGIN PUBLIC KEY-----/m.test(canonical(pubRaw)),
  'first line: ' + (canonical(pubRaw).split('\n')[0] || '(empty)'));
hardOk('no UTF-8 BOM in private key', !(privBuf[0] === 0xef && privBuf[1] === 0xbb && privBuf[2] === 0xbf));
hardOk('no UTF-8 BOM in public key', !(pubBuf[0] === 0xef && pubBuf[1] === 0xbb && pubBuf[2] === 0xbf));

let privKey = null;
try {
  privKey = createPrivateKey(canonical(privRaw) + '\n');
} catch (e) {
  hardOk('private key parses', false, e.message);
}

let derived = null;
if (privKey) {
  hardOk('private key parses', true);
  const curve = privKey.asymmetricKeyDetails?.namedCurve ?? '(unknown)';
  hardOk('private key is EC on prime256v1 (P-256)',
    privKey.asymmetricKeyType === 'ec' && /prime256v1/i.test(curve),
    `type=${privKey.asymmetricKeyType} curve=${curve}`);
  derived = createPublicKey(privKey).export({ type: 'spki', format: 'pem' }).toString();
  hardOk('public.pem is the public half of private.pem', canonical(derived) === canonical(pubRaw));
}

try {
  const pubKey = createPublicKey(canonical(pubRaw) + '\n');
  const pcurve = pubKey.asymmetricKeyDetails?.namedCurve ?? '(unknown)';
  hardOk('public key parses and is on the same curve',
    pubKey.asymmetricKeyType === 'ec' && /prime256v1/i.test(pcurve), `curve=${pcurve}`);
} catch (e) {
  hardOk('public key parses', false, e.message);
}

// ---- cosmetic differences: reported, deliberately not failures -------------
soft('no CRLF (LF preferred; RFC 7468 also allows CRLF)', !privRaw.includes('\r') && !pubRaw.includes('\r'));
soft('file ends with a newline', privRaw.endsWith('\n') && pubRaw.endsWith('\n'));

if (derived && canonical(derived) !== canonical(pubRaw)) {
  const sameBody = body(derived) === body(pubRaw);
  console.log(
    sameBody
      ? '\n  note: the base64 bodies are IDENTICAL -> the files hold the same key, the difference is formatting only'
      : '\n  note: the base64 bodies differ -> these really are two different keys'
  );
  console.log('  public key that belongs to the private key you passed:');
  console.log(canonical(derived).split('\n').map(l => '    ' + l).join('\n'));
}

if (outLf) {
  writeFileSync(outLf, canonical(pubRaw) + '\n');
  console.log(`\n  wrote LF-normalised public key -> ${outLf}`);
  console.log(`  gh secret set AFFINE_PRO_PUBLIC_KEY --repo <owner>/<repo> < ${outLf}`);
}

console.log(
  `\n${hard === 0 ? 'key pair: OK' : `key pair: ${hard} HARD problem(s)`}` +
    (warn ? `  (${warn} cosmetic warning(s), harmless)` : '')
);
process.exit(hard === 0 ? 0 : 1);
