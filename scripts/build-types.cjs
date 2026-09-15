// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// Build-only workaround for TypeScript 5.9.3 declaration emit dropping concrete
// implementations whose signatures equal inherited abstract members. Patch a
// temporary compiler copy; never modify installed dependencies or emitted types.
'use strict'

const { createHash } = require('node:crypto')
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { spawnSync } = require('node:child_process')

const compilerVersion = require('typescript/package.json').version
if (compilerVersion !== '5.9.3') {
  throw new Error(`Declaration compiler must be TypeScript 5.9.3, received ${compilerVersion}. Reassess the workaround before upgrading.`)
}

const libraryPath = dirname(require.resolve('typescript'))
const expectedHashes = {
  'typescript.js': '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  '_tsc.js': 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419'
}
const original = 'baseType && getPropertyOfType(baseType, p.escapedName) && isReadonlySymbol'
const replacement = 'baseType && getPropertyOfType(baseType, p.escapedName) && !(getDeclarationModifierFlagsFromSymbol(getPropertyOfType(baseType, p.escapedName)) & 64 /* Abstract */) && isReadonlySymbol'
const patchedSources = new Map()
for (const [file, expectedHash] of Object.entries(expectedHashes)) {
  const source = readFileSync(join(libraryPath, file), 'utf8')
  const actualHash = createHash('sha256').update(source).digest('hex')
  if (actualHash !== expectedHash || source.split(original).length !== 2) {
    throw new Error(`Unrecognized TypeScript compiler content: ${file}. Refusing to apply the declaration workaround.`)
  }
  patchedSources.set(file, source.replace(original, replacement))
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'wdk-btc-types-'))
try {
  const temporaryLibrary = join(temporaryDirectory, 'lib')
  // Keep the standard library files beside the compiler for normal resolution.
  cpSync(libraryPath, temporaryLibrary, { recursive: true })
  for (const [file, source] of patchedSources) {
    writeFileSync(join(temporaryLibrary, file), source)
  }
  const result = spawnSync(process.execPath, [join(temporaryLibrary, '_tsc.js'), ...process.argv.slice(2)], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status === null ? 1 : result.status
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
