// fix-corrupted-literals.mjs — repair bash-mangled string literals in upstream.js
import fs from 'node:fs'
const p = 'D:/HANXIAO/tools/zcode-ai-connect/zcode-qoder-connect/src/upstream.js'
let s = fs.readFileSync(p, 'utf8')
let fixes = 0
// indexOf('<LF>') → indexOf('\n')
const brokenNewline = "indexOf('" + String.fromCharCode(10) + "')"
if (s.includes(brokenNewline)) {
  s = s.split(brokenNewline).join("indexOf('\\n')")
  fixes++
}
// endsWith('<CR>') → endsWith('\r')
const brokenCr = "endsWith('" + String.fromCharCode(13) + "')"
if (s.includes(brokenCr)) {
  s = s.split(brokenCr).join("endsWith('\\r')")
  fixes++
}
fs.writeFileSync(p, s)
console.log('fixes applied:', fixes)
