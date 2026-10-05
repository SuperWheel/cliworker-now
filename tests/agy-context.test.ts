import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyContextReader, decodeAgyContext } from '../src/host/agy-context.ts'

// Synthetic protobuf/SQLite fixtures; no real conversations copied into tests.
const varint = (input: number | bigint): number[] => {
  let n = BigInt(input)
  const out: number[] = []
  do {
    out.push(Number(n & 127n) | (n > 127n ? 128 : 0))
    n >>= 7n
  } while (n)
  return out
}
const nested = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
]
const blob = (used: number | bigint, capacity: number, extra: number[] = []) =>
  Uint8Array.from(nested(1, nested(9, nested(10, [8, ...varint(used), 32, ...varint(capacity), ...extra]))))
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function fixture(owner = id) {
  const directory = mkdtempSync(join(tmpdir(), 'cwn-context-'))
  dirs.push(directory)
  const path = join(directory, `${id}.db`)
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);',
  )
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(owner)
  db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(0, blob(28757, 256000))
  db.close()
  return { directory, path }
}
describe('Antigravity local context adapter', () => {
  it('decodes verified fields and labels estimates without model-name guessing', () => {
    expect(decodeAgyContext(blob(28757, 256000))).toMatchObject({
      contextUsed: 28757,
      contextCapacity: 256000,
      contextEstimated: true,
    })
    expect(decodeAgyContext(blob(0, 256000))?.contextUsed).toBe(0)
  })
  it('ignores unrelated signed uint64 fields but rejects invalid metrics and malformed data', () => {
    expect(decodeAgyContext(blob(42, 256000, [16, ...varint(18446744073709551615n)]))?.contextUsed).toBe(42)
    expect(decodeAgyContext(blob(18446744073709551615n, 256000))).toBeUndefined()
    expect(decodeAgyContext(blob(10, 0))).toBeUndefined()
    expect(decodeAgyContext(Uint8Array.of(10, 255))).toBeUndefined()
    expect(decodeAgyContext(Uint8Array.of(8, 10))).toBeUndefined()
  })
  it('reads matching conversation metadata without modifying the database', () => {
    const { directory, path } = fixture()
    const before = readFileSync(path)
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)?.contextUsed).toBe(28757)
    expect(reader.read(id)?.contextCapacity).toBe(256000)
    expect(readFileSync(path)).toEqual(before)
  })
  it('refuses mismatched ownership, invalid paths and missing files', () => {
    const { directory } = fixture('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee')
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)).toBeUndefined()
    expect(reader.read('../private')).toBeUndefined()
    expect(reader.read()).toBeUndefined()
    expect(reader.read('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeUndefined()
  })
  it('refreshes after new metadata and never substitutes stale data for an invalid latest request', () => {
    const { directory, path } = fixture()
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)?.contextUsed).toBe(28757)
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(
      1,
      blob(120000, 256000, new Array(2000).fill([24, 1]).flat()),
    )
    expect(reader.read(id)?.contextUsed).toBe(120000)
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(2, new Uint8Array(9000))
    expect(reader.read(id)).toBeUndefined()
    db.close()
  })
})
