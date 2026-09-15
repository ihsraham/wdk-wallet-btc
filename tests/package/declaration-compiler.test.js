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
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const builder = join(root, 'scripts/build-types.cjs')
const compiler = require.resolve('typescript/bin/tsc')
const library = dirname(require.resolve('typescript'))
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))

test('temporary compiler preserves concrete abstract implementations and private members', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdk-declaration-regression-'))
  const before = ['typescript.js', '_tsc.js'].map(name => digest(join(library, name)))
  try {
    json(join(dir, 'package.json'), { type: 'module' })
    writeFileSync(join(dir, 'base.d.ts'), `export default abstract class Base {
  abstract read(value: string): Promise<bigint>;
  label(): string;
}\n`)
    writeFileSync(join(dir, 'derived.js'), `import Base from './base.js'
export default class Derived extends Base {
  constructor () {
    super()
    /** @private @type {string} */
    this._secret = 'fixture-only'
  }
  /** @param {string} value @returns {Promise<bigint>} */
  async read (value) { return BigInt(value) }
  /** @returns {string} */
  label () { return 'derived' }
}\n`)
    json(join(dir, 'tsconfig.build.json'), { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', allowJs: true, declaration: true, emitDeclarationOnly: true, outDir: './out', types: [] }, include: ['derived.js'] })
    writeFileSync(join(dir, 'consumer.ts'), `import Derived from './out/derived.js';
const value = new Derived();
const result: bigint = await value.read('42');
const label: string = value.label();
// @ts-expect-error method argument is required
value.read();
// @ts-expect-error argument must be a string
value.read(42);
// @ts-expect-error source JSDoc private visibility is preserved
value._secret;
// @ts-expect-error result is bigint, not string
const invalid: string = await value.read('42');
`)
    json(join(dir, 'tsconfig.strict.json'), { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [] }, include: ['consumer.ts', 'out/**/*.d.ts'] })
    const baseline = run(compiler, ['-p', 'tsconfig.build.json'], dir)
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
    copyFileSync(join(dir, 'base.d.ts'), join(dir, 'out/base.d.ts'))
    const broken = run(compiler, ['-p', 'tsconfig.strict.json'], dir)
    assert.notEqual(broken.status, 0)
    assert.match(broken.stdout + broken.stderr, /TS2515/)
    const fixed = run(builder, ['-p', 'tsconfig.build.json'], dir)
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
    const strict = run(compiler, ['-p', 'tsconfig.strict.json'], dir)
    assert.equal(strict.status, 0, strict.stdout + strict.stderr)
    assert.deepEqual(['typescript.js', '_tsc.js'].map(name => digest(join(library, name))), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const [version, source, expected] of [
  ['0.0.0', '', /must be TypeScript 5\.9\.3/],
  ['5.9.3', '// modified compiler', /Unrecognized TypeScript compiler content/]
]) {
  test(`build fails closed for unrecognized compiler ${version}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'wdk-declaration-guard-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      copyFileSync(builder, join(dir, 'scripts/build-types.cjs'))
      mkdirSync(join(dir, 'node_modules/typescript/lib'), { recursive: true })
      json(join(dir, 'node_modules/typescript/package.json'), { version, main: './lib/typescript.js' })
      writeFileSync(join(dir, 'node_modules/typescript/lib/typescript.js'), source)
      const result = run(join(dir, 'scripts/build-types.cjs'), [], dir)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
