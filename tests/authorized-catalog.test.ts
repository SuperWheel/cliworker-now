import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { catalogFor } from '../src/host/adapters.ts'
import { readCliAccountBinding } from '../src/host/cli-account-binding.ts'
import { authorizedCatalog, authorizeSelection } from '../src/host/authorized-catalog.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { CLI_IDS } from '../src/shared/types.ts'

vi.mock('../src/host/adapters.ts', async (original) => ({
  ...(await original<object>()),
  catalogFor: vi.fn(),
}))
vi.mock('../src/host/cli-account-binding.ts', () => ({ readCliAccountBinding: vi.fn() }))
// Only metadata doubles; no accounts, network or native processes.
const backend = { spawn: vi.fn(), resolveExecutable: vi.fn() } as unknown as ProcessBackend
const signal = () => new AbortController().signal
beforeEach(() => {
  vi.mocked(readCliAccountBinding).mockResolvedValue('synthetic-account-a')
  vi.mocked(catalogFor).mockImplementation(async (cli) => ({
    cli,
    notice: 'Synthetic owned account scope',
    models: [{ id: 'synthetic/model', label: 'Fixture', efforts: ['low'] }],
  }))
})
afterEach(() => vi.resetAllMocks())

it.each(CLI_IDS)('%s cannot discover or select using only another CLI/Host account', async (cli) => {
  vi.mocked(readCliAccountBinding).mockRejectedValue(new Error('本 CLI 未登录'))
  const resolver = vi.fn(async () => 'synthetic-other-key')
  const config = { ...DEFAULT_CONFIG, zaiCredentialRef: 'SYNTHETIC_HOST', resolveCredential: resolver }
  await expect(authorizedCatalog(cli, backend, config, '/synthetic', signal())).rejects.toThrow('未登录')
  await expect(
    authorizeSelection(
      { cli, model: 'synthetic/model', effort: 'low' },
      backend,
      config,
      '/synthetic',
      signal(),
    ),
  ).rejects.toThrow('未登录')
  expect(catalogFor).not.toHaveBeenCalled()
  expect(resolver).not.toHaveBeenCalled()
  expect(backend.spawn).not.toHaveBeenCalled()
})

it('rejects an account change while the model directory is loading', async () => {
  vi.mocked(readCliAccountBinding)
    .mockResolvedValueOnce('synthetic-account-a')
    .mockResolvedValueOnce('synthetic-account-b')
  await expect(authorizedCatalog('pi', backend, DEFAULT_CONFIG, '/synthetic', signal())).rejects.toThrow(
    '账号已变更',
  )
})

it('rejects an obsolete displayed account before querying the replacement account', async () => {
  await expect(
    authorizedCatalog('pi', backend, DEFAULT_CONFIG, '/synthetic', signal(), 'old-account'),
  ).rejects.toThrow('账号已变更')
  expect(catalogFor).not.toHaveBeenCalled()
})

it('rejects revoked model and effort, empty and cross-CLI metadata', async () => {
  await expect(
    authorizeSelection(
      { cli: 'pi', model: 'removed', effort: 'low' },
      backend,
      DEFAULT_CONFIG,
      '/synthetic',
      signal(),
    ),
  ).rejects.toThrow()
  await expect(
    authorizeSelection(
      { cli: 'pi', model: 'synthetic/model', effort: 'max' },
      backend,
      DEFAULT_CONFIG,
      '/synthetic',
      signal(),
    ),
  ).rejects.toThrow()
  vi.mocked(catalogFor).mockResolvedValueOnce({ cli: 'pi', models: [], notice: '' })
  await expect(authorizedCatalog('pi', backend, DEFAULT_CONFIG, '/synthetic', signal())).rejects.toThrow(
    '暂无',
  )
  vi.mocked(catalogFor).mockResolvedValueOnce({ cli: 'omp', models: [], notice: '' })
  await expect(authorizedCatalog('pi', backend, DEFAULT_CONFIG, '/synthetic', signal())).rejects.toThrow(
    '身份不匹配',
  )
})

it('accepts a stable own account and checks cancellation after directory completion', async () => {
  expect(
    (
      await authorizeSelection(
        { cli: 'pi', model: 'synthetic/model', effort: 'low' },
        backend,
        DEFAULT_CONFIG,
        '/synthetic',
        signal(),
      )
    ).binding,
  ).toBe('synthetic-account-a')
  const controller = new AbortController()
  vi.mocked(catalogFor).mockImplementationOnce(async (cli) => {
    controller.abort(new Error('Synthetic cancelled'))
    return { cli, notice: '', models: [] }
  })
  await expect(
    authorizedCatalog('pi', backend, DEFAULT_CONFIG, '/synthetic', controller.signal),
  ).rejects.toThrow('Synthetic cancelled')
})
