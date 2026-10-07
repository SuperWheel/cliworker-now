import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  stat,
  symlink,
  link,
  unlink,
  readdir,
  chmod,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { preparePiOmp, discoverPiOmp, type PiOmpInput, type PiOmpCli } from '../src/host/pi-omp-adapter.ts'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})
const fixtureKey = 'SYNTHETIC_TEST_KEY_NOT_A_CREDENTIAL'
const fixtureEnvironment = (home: string | undefined, env: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home ?? '/private/tmp',
  LANG: 'C',
  ...env,
  ZAI_CODING_CN_API_KEY: fixtureKey,
})
async function fixture(cli: PiOmpCli, scenario = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'cliworker-rpc-fixture-'))
  roots.push(root)
  const project = join(root, 'project'),
    stateDirectory = join(root, 'state'),
    executable = join(root, 'dist/fixture.mjs')
  await mkdir(project)
  await mkdir(join(root, 'dist/core'), { recursive: true })
  const provider =
    scenario === 'non-glm' || scenario === 'wrong-model' || scenario === 'no-reasoning'
      ? 'fixture-native'
      : cli === 'pi'
        ? 'zai-coding-cn'
        : 'cliworker-zai-cn'
  const modelId = provider === 'fixture-native' ? 'native-chat' : 'glm-5.3-flash'
  const model = {
    provider,
    id: modelId,
    name: provider === 'fixture-native' ? 'Native fixture chat' : 'GLM-5.3-Flash',
    ...(scenario === 'no-reasoning'
      ? { reasoning: false }
      : {
          reasoning: true,
          thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
          thinking: { efforts: ['low', 'high', 'max'] },
        }),
  }
  const extra = {
    provider: 'second-native',
    id: 'other-chat',
    name: 'Other native fixture',
    reasoning: true,
    thinkingLevelMap: { medium: 'medium' },
    thinking: { efforts: ['medium'] },
  }
  const catalog =
    scenario === 'switch' || scenario === 'multi'
      ? [model, extra, { provider: 'plain', id: 'chat', name: 'Plain fixture', reasoning: false }]
      : [model]
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', name: '@earendil-works/pi-coding-agent', version: '1.0.2' }),
  )
  await writeFile(
    join(root, 'dist/core/model-runtime.js'),
    `// SIMULATED SDK, no model/network.\nexport class ModelRuntime { static async create() { return new ModelRuntime() } getError() { return undefined } getAvailableSnapshot() { return ${JSON.stringify(catalog)} } }`,
  )
  // Explicitly simulated native RPC process; it never accesses a model/network.
  await writeFile(
    executable,
    `
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const cli=${JSON.stringify(cli)},scenario=${JSON.stringify(scenario)},marker=${JSON.stringify(join(root, 'native-stopped'))};
const provider=${JSON.stringify(provider)},modelId=${JSON.stringify(modelId)},agent=process.env.PI_CODING_AGENT_DIR;
if(process.argv.includes('models')){
if(scenario==='catalog-cancel'){writeFileSync(${JSON.stringify(join(root, 'catalog-started'))},'STARTED');setInterval(()=>{},1000);process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(marker,'STOPPED');process.exit(143)},80));}
else if(scenario==='secret-model-error'){process.stdout.write('{SYNTHETIC_TEST_KEY_NOT_A_CREDENTIAL');process.exit(0);}
else{process.stdout.write(JSON.stringify(${JSON.stringify(catalog)}));process.exit(0);}
}
else {
mkdirSync(join(agent,'sessions'),{recursive:true});
const path=join(agent,'sessions','fixture.jsonl');const resumed=process.argv.includes(cli==='pi'?'--session':'--resume');
if(resumed&&!existsSync(path))process.exit(2);
writeFileSync(path,'SIMULATED SESSION\\n',{mode:0o600});
writeFileSync(join(agent,'observed-argv.json'),JSON.stringify(process.argv.slice(2)),{mode:0o600});
let model=${JSON.stringify(model)},thinkingLevel=scenario==='no-reasoning'?'off':'low';
writeFileSync(join(agent,'observed-auth.json'),JSON.stringify({cnPresent:!!process.env.ZAI_CODING_CN_API_KEY,nativeFixture:process.env.ZHIPU_API_KEY==='SYNTHETIC_NATIVE_PROVIDER_ENV',unexpectedNativeKey:!!process.env.ZHIPU_API_KEY&&process.env.ZHIPU_API_KEY!=='SYNTHETIC_NATIVE_PROVIDER_ENV'&&process.env.ZHIPU_API_KEY!==${JSON.stringify(fixtureKey)}}),{mode:0o600});
const state=()=>({sessionId:scenario==='identity'&&resumed?'changed':'fixture-id',sessionFile:path,model:scenario==='wrong-model'?{...model,id:'changed-native-model'}:model,thinkingLevel,isStreaming:false,pendingMessageCount:0});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(cli==='omp')send({type:'ready'});
const input=createInterface({input:process.stdin});
input.on('line',line=>{const cmd=JSON.parse(line);if(cmd.type==='get_state'){send({id:cmd.id,type:'response',command:cmd.type,success:true,data:state()});return}
if(cmd.type==='set_model'){model={provider:cmd.provider,id:cmd.modelId};send({id:cmd.id,type:'response',command:cmd.type,success:true,data:model});return}
if(cmd.type==='set_thinking_level'){thinkingLevel=cmd.level;send({id:cmd.id,type:'response',command:cmd.type,success:true});return}
if(cmd.type==='get_available_models'){send({id:cmd.id,type:'response',command:cmd.type,success:true,data:{models:[model]}});return}
if(cmd.type==='prompt'){
send({id:cmd.id,type:'response',command:'prompt',success:true});send({type:'message_start',message:{role:'assistant'}});
send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'SECRET_REASONING_FIXTURE'}});
send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:resumed?'RESUMED':'HELLO'}});
if(scenario==='cancel')return;
if(scenario==='tool-error'){send({type:'tool_execution_start',toolCallId:'t',toolName:'write'});send({type:'tool_execution_end',toolCallId:'t',toolName:'write',isError:true,result:{content:[{type:'text',text:'denied'}]}})}
if(scenario==='malformed'){process.stdout.write('not-json\\n');return}
send({type:'message_end',message:{role:'assistant',provider:model.provider,model:model.id,content:[{type:'text',text:resumed?'RESUMED':'HELLO'}],stopReason:'stop'}});
send({type:'agent_end'});if(cli==='pi'&&scenario!=='unsettled')send({type:'agent_settled'});
if(scenario==='unsettled')setTimeout(()=>process.exit(0),20);
}});
input.on('close',()=>{if(scenario!=='cancel')process.exit(0)});
process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(marker,'STOPPED');process.exit(143)},80));
}
`,
  )
  const input: PiOmpInput = {
    cli,
    executable,
    project,
    stateDirectory,
    nativeHome: root,
    accountRoot: stateDirectory,
    preference: {
      model: `${provider}/${modelId}`,
      effort: scenario === 'no-reasoning' ? 'default' : 'low',
    },
    mode: 'plan',
    prompt: 'literal $(do not execute)',
  }
  return { root, input }
}
async function launch(input: PiOmpInput) {
  const prepared = await preparePiOmp(input)
  try {
    const result = await exec(prepared.argv[0]!, prepared.argv.slice(1), {
      env: fixtureEnvironment(input.nativeHome, prepared.env),
      timeout: 10000,
    })
    return {
      code: 0,
      frames: result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      stdout: result.stdout,
    }
  } catch (error: any) {
    return {
      code: error.code,
      frames: error.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line: string) => JSON.parse(line)),
      stdout: error.stdout,
    }
  }
}
describe('Pi/OMP bridge with simulated native RPC processes', () => {
  it.each(['pi', 'omp'] as const)(
    '%s rejects every prepared state-directory symlink before writing a prompt',
    async (cli) => {
      for (const level of ['root', 'cli', 'project']) {
        const { root, input } = await fixture(cli)
        const outside = join(root, 'external')
        await mkdir(outside)
        await chmod(outside, 0o755)
        const identity = createHash('sha256')
          .update(await realpath(input.project))
          .digest('hex')
        const target =
          level === 'root'
            ? input.stateDirectory
            : level === 'cli'
              ? join(input.stateDirectory, cli)
              : join(input.stateDirectory, cli, identity)
        await mkdir(dirname(target), { recursive: true })
        await symlink(outside, target)
        await expect(preparePiOmp(input)).rejects.toThrow('symlink')
        expect(await readdir(outside)).toEqual([])
        expect((await stat(outside)).mode & 0o777).toBe(0o755)
      }
    },
  )
  it.each(['pi', 'omp'] as const)(
    '%s refuses linked bridge state before starting its native process',
    async (cli) => {
      for (const directory of ['agent', 't', 'sessions', 'agent/sessions']) {
        const { root, input } = await fixture(cli)
        const prepared = await preparePiOmp(input)
        const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
        const outside = join(root, 'external')
        await mkdir(outside)
        await chmod(outside, 0o755)
        const target = join(request.stateDirectory, directory)
        await mkdir(dirname(target), { recursive: true })
        await rm(target, { recursive: true, force: true })
        await symlink(outside, target)
        const result = directory === 'agent' ? undefined : await launch(input)
        if (directory === 'agent') await expect(launch(input)).rejects.toThrow('symlink')
        else {
          expect(result!.code).toBe(1)
          expect(result!.frames.at(-1)).toMatchObject({ status: 'ERROR' })
          expect(result!.stdout).not.toContain('HELLO')
        }
        expect(await readdir(outside)).toEqual([])
        expect((await stat(outside)).mode & 0o777).toBe(0o755)
      }
    },
  )
  it.each(['symlink', 'hardlink'] as const)(
    'replaces OMP config %s entries without overwriting external files',
    async (kind) => {
      const { root, input } = await fixture('omp')
      const prepared = await preparePiOmp(input)
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const agent = join(request.stateDirectory, 'agent')
      await mkdir(agent, { recursive: true })
      const outside = join(root, 'external')
      await writeFile(outside, 'EXTERNAL SENTINEL')
      await chmod(outside, 0o644)
      const before = await stat(outside)
      for (const name of ['models.yml', 'config.yml']) {
        await rm(join(agent, name), { force: true })
        if (kind === 'symlink') await symlink(outside, join(agent, name))
        else await link(outside, join(agent, name))
      }
      const result = await launch(input)
      expect(result.code).toBe(0)
      expect(await readFile(outside, 'utf8')).toBe('EXTERNAL SENTINEL')
      expect((await stat(outside)).mode).toBe(before.mode)
      for (const name of ['models.yml', 'config.yml']) {
        const file = await stat(join(agent, name))
        expect(file.ino).not.toBe(before.ino)
        expect(file.nlink).toBe(1)
        expect(file.mode & 0o777).toBe(0o600)
      }
    },
  )
  it.each(['symlink', 'hardlink'] as const)(
    'atomically replaces a session-map %s without modifying its outside target',
    async (kind) => {
      const { root, input } = await fixture('pi')
      const prepared = await preparePiOmp(input)
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const maps = join(request.stateDirectory, 'sessions')
      await mkdir(maps)
      const outside = join(root, 'external')
      await writeFile(outside, 'EXTERNAL SENTINEL')
      await chmod(outside, 0o644)
      const before = await stat(outside)
      const mapping = join(maps, createHash('sha256').update('fixture-id').digest('hex') + '.json')
      if (kind === 'symlink') await symlink(outside, mapping)
      else await link(outside, mapping)
      const result = await launch(input)
      expect(result.code).toBe(0)
      expect(await readFile(outside, 'utf8')).toBe('EXTERNAL SENTINEL')
      expect((await stat(outside)).mode).toBe(before.mode)
      expect((await stat(mapping)).ino).not.toBe(before.ino)
      expect((await stat(mapping)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(mapping, 'utf8')).id).toBe('fixture-id')
    },
  )
  it.each(['symlink', 'hardlink'] as const)(
    'rejects a native resume session %s before sending a new prompt',
    async (kind) => {
      const { root, input } = await fixture('pi')
      await launch(input)
      const prepared = await preparePiOmp(input)
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const mapping = join(
        request.stateDirectory,
        'sessions',
        createHash('sha256').update('fixture-id').digest('hex') + '.json',
      )
      const stored = JSON.parse(await readFile(mapping, 'utf8'))
      const outside = join(root, 'external')
      await writeFile(outside, 'EXTERNAL SESSION')
      await chmod(outside, 0o644)
      await unlink(stored.path)
      if (kind === 'symlink') await symlink(outside, stored.path)
      else await link(outside, stored.path)
      const result = await launch({ ...input, conversationId: 'fixture-id' })
      expect(result.code).toBe(1)
      expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
      expect(result.stdout).not.toContain('RESUMED')
      expect(await readFile(outside, 'utf8')).toBe('EXTERNAL SESSION')
      expect((await stat(outside)).mode & 0o777).toBe(0o644)
    },
  )
  it.each(['pi', 'omp'] as const)('%s discovers its exact model without prompting', async (cli) => {
    const { input } = await fixture(cli)
    const models = await discoverPiOmp(
      cli,
      input.executable,
      async (argv) =>
        (await exec(argv[0]!, argv.slice(1), { env: fixtureEnvironment(input.nativeHome) })).stdout,
      input.stateDirectory,
      { nativeHome: input.nativeHome, accountRoot: input.accountRoot },
    )
    expect(models).toEqual([
      {
        id: input.preference.model,
        label: `GLM-5.3-Flash（${cli === 'pi' ? 'zai-coding-cn' : 'cliworker-zai-cn'}）`,
        efforts: ['low', 'high', 'max'],
      },
    ])
  })
  it.each(['pi', 'omp'] as const)(
    '%s persists the returned session path and resumes without guessing it',
    async (cli) => {
      const { input } = await fixture(cli)
      const first = await launch(input)
      expect(first.code).toBe(0)
      expect(first.frames.at(-1)).toEqual({ type: 'result', status: 'SUCCESS', response: 'HELLO' })
      expect(first.stdout).not.toContain('SECRET_REASONING_FIXTURE')
      expect(first.stdout).not.toContain(fixtureKey)
      const resumed = await launch({ ...input, conversationId: 'fixture-id' })
      expect(resumed.code).toBe(0)
      expect(resumed.frames.at(-1)).toMatchObject({ status: 'SUCCESS', response: 'RESUMED' })
      const prepared = await preparePiOmp(input)
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const args = JSON.parse(
        await readFile(join(request.stateDirectory, 'agent/observed-argv.json'), 'utf8'),
      )
      expect(args).toContain(cli === 'pi' ? '--session' : '--resume')
      expect(args).not.toContain('bash')
      expect(args).not.toContain('--yolo')
      expect((await stat(prepared.argv[2]!)).mode & 0o077).toBe(0)
    },
  )
  it.each(['pi', 'omp'] as const)('%s refuses a failed tool even when native CLI exits zero', async (cli) => {
    const { input } = await fixture(cli, 'tool-error')
    const result = await launch({ ...input, mode: 'accept-edits' })
    expect(result.code).toBe(1)
    expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
    expect(result.frames.some((frame: any) => frame.event?.state === 'FAILED')).toBe(true)
  })
  it('Pi agent_end alone cannot become a completed task', async () => {
    const { input } = await fixture('pi', 'unsettled')
    const result = await launch(input)
    expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
  })
  it.each(['pi', 'omp'] as const)('%s rejects resume identity changes', async (cli) => {
    const { input } = await fixture(cli, 'identity')
    await launch(input)
    const result = await launch({ ...input, conversationId: 'fixture-id' })
    expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR', response: '' })
    expect(result.stdout).not.toContain('RESUMED')
  })
  it('unknown session IDs do not open arbitrary native history', async () => {
    const { input } = await fixture('pi')
    const result = await launch({ ...input, conversationId: 'unknown' })
    expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
    expect(result.stdout).not.toContain('HELLO')
  })
  it('rejects a stored path outside its private CLI state', async () => {
    const { root, input } = await fixture('pi')
    await launch(input)
    const prepared = await preparePiOmp(input)
    const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
    const mapping = join(
      request.stateDirectory,
      'sessions',
      createHash('sha256').update('fixture-id').digest('hex') + '.json',
    )
    const stored = JSON.parse(await readFile(mapping, 'utf8'))
    const unrelated = join(root, 'unrelated-session.jsonl')
    await writeFile(unrelated, 'UNRELATED')
    await writeFile(mapping, JSON.stringify({ ...stored, path: unrelated }))
    const result = await launch({ ...input, conversationId: 'fixture-id' })
    expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
    expect(result.stdout).not.toContain('HELLO')
    expect(await readFile(unrelated, 'utf8')).toBe('UNRELATED')
  })
  it('malformed RPC cannot produce a successful result', async () => {
    const { input } = await fixture('omp', 'malformed')
    const result = await launch(input)
    expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
  })
  it('waits for native SIGTERM cleanup before bridge termination', async () => {
    const { root, input } = await fixture('pi', 'cancel')
    const prepared = await preparePiOmp(input)
    const child = spawn(prepared.argv[0]!, prepared.argv.slice(1), {
      env: fixtureEnvironment(input.nativeHome, prepared.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '',
      sent = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (!sent && output.includes('HELLO')) {
        sent = true
        child.kill('SIGTERM')
      }
    })
    const code = await new Promise((resolve) => child.once('close', resolve))
    expect(code).toBe(1)
    expect(await readFile(join(root, 'native-stopped'), 'utf8')).toBe('STOPPED')
    expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ status: 'ERROR' })
  })
  it('rejects unselected routes and unsupported efforts before spawning', async () => {
    const { input } = await fixture('pi')
    await expect(
      preparePiOmp({ ...input, preference: { model: 'unverified/model', effort: 'low' } }),
    ).resolves.toHaveProperty('argv')
    await expect(
      preparePiOmp({ ...input, preference: { ...input.preference, effort: 'invented' } }),
    ).rejects.toThrow('effort')
  })
  it.each(['pi', 'omp'] as const)(
    '%s executes non-GLM metadata and emits the exact observed model',
    async (cli) => {
      const { input } = await fixture(cli, 'non-glm')
      const result = await launch(input)
      expect(result.code).toBe(0)
      expect(result.frames.find((frame: any) => frame.event?.observedModel)?.event.observedModel).toBe(
        input.preference.model,
      )
      const prepared = await preparePiOmp(input)
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const argv = JSON.parse(
        await readFile(join(request.stateDirectory, 'agent/observed-argv.json'), 'utf8'),
      )
      expect(argv.slice(argv.indexOf('--provider'), argv.indexOf('--provider') + 4)).toEqual([
        '--provider',
        'fixture-native',
        '--model',
        'native-chat',
      ])
    },
  )
  it.each(['pi', 'omp'] as const)(
    '%s keeps default for a native model without effort metadata',
    async (cli) => {
      const { input } = await fixture(cli, 'no-reasoning')
      expect((await launch(input)).code).toBe(0)
      const prepared = await preparePiOmp(input)
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const argv = JSON.parse(
        await readFile(join(request.stateDirectory, 'agent/observed-argv.json'), 'utf8'),
      )
      expect(argv).not.toContain('--thinking')
    },
  )
  it.each(['pi', 'omp'] as const)(
    '%s lists multiple providers and their own effort capabilities',
    async (cli) => {
      const { input } = await fixture(cli, 'multi')
      const models = await discoverPiOmp(
        cli,
        input.executable,
        async (argv, env) =>
          (
            await exec(argv[0]!, argv.slice(1), {
              env: fixtureEnvironment(input.nativeHome, env),
            })
          ).stdout,
        input.stateDirectory,
        { nativeHome: input.nativeHome },
      )
      expect(models.map((model) => [model.id, model.efforts])).toEqual([
        [input.preference.model, ['low', 'high', 'max']],
        ['second-native/other-chat', ['medium']],
        ['plain/chat', ['default']],
      ])
      expect(JSON.stringify(models)).not.toContain(fixtureKey)
    },
  )
  it.each(['pi', 'omp'] as const)(
    '%s switches a completed session to another native provider and effort',
    async (cli) => {
      const { input } = await fixture(cli, 'switch')
      expect((await launch(input)).code).toBe(0)
      const switched = await launch({
        ...input,
        conversationId: 'fixture-id',
        preference: { model: 'second-native/other-chat', effort: 'medium' },
      })
      expect(switched.code).toBe(0)
      expect(switched.frames.find((frame: any) => frame.type === 'session')).toMatchObject({
        id: 'fixture-id',
        model: 'second-native/other-chat',
      })
      expect(switched.frames.at(-1)).toMatchObject({ status: 'SUCCESS', response: 'RESUMED' })
    },
  )
  it.each(['pi', 'omp'] as const)(
    '%s rejects an unlisted model before sending a task prompt',
    async (cli) => {
      const { input } = await fixture(cli)
      const result = await launch({
        ...input,
        preference: { model: 'unknown/not-installed', effort: 'default' },
      })
      expect(result.code).toBe(1)
      expect(result.stdout).not.toContain('HELLO')
      expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
    },
  )
  it.each(['pi', 'omp'] as const)('%s rejects a model that disagrees after native selection', async (cli) => {
    const { input } = await fixture(cli, 'wrong-model')
    const result = await launch(input)
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('HELLO')
  })
  it('sanitizes invalid OMP directory output that contains a synthetic credential', async () => {
    const { input } = await fixture('omp', 'secret-model-error')
    const result = await launch(input)
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain(fixtureKey)
    expect(result.frames.at(-1)).toMatchObject({
      status: 'ERROR',
      error: '无法读取 Pi/OMP 原生模型目录，请检查本机配置',
    })
  })
  it('cleans up OMP native metadata queries when the bridge is stopped', async () => {
    const { root, input } = await fixture('omp', 'catalog-cancel')
    const prepared = await preparePiOmp(input)
    const processHandle = spawn(prepared.argv[0]!, prepared.argv.slice(1), {
      env: fixtureEnvironment(input.nativeHome, prepared.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    processHandle.stdout.on('data', (data) => {
      stdout += data
    })
    processHandle.stderr.on('data', (data) => {
      stderr += data
    })
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'catalog-started'), 'utf8')).toBe('STARTED'),
    )
    processHandle.kill('SIGTERM')
    const code = await new Promise((resolve) => processHandle.once('close', resolve))
    expect(code).toBe(1)
    expect(await readFile(join(root, 'native-stopped'), 'utf8')).toBe('STOPPED')
    expect(stderr).not.toContain('TypeError')
    expect(stdout).not.toContain(fixtureKey)
  })
  it.each(['pi', 'omp'] as const)(
    '%s preserves native env credentials across continuation without injecting a Host CN key into another provider',
    async (cli) => {
      const { root, input } = await fixture(cli, 'non-glm')
      const source = join(root, cli === 'pi' ? '.pi' : '.omp', 'agent')
      await mkdir(source, { recursive: true, mode: 0o700 })
      await writeFile(join(source, '.env'), 'ZHIPU_API_KEY=SYNTHETIC_NATIVE_PROVIDER_ENV\n', { mode: 0o600 })
      const selected = { ...input, managedCredentials: true }
      expect((await launch(selected)).code).toBe(0)
      expect((await launch({ ...selected, conversationId: 'fixture-id' })).code).toBe(0)
      const prepared = await preparePiOmp({ ...selected, conversationId: 'fixture-id' })
      expect(prepared.env?.ZHIPU_API_KEY).toBe('SYNTHETIC_NATIVE_PROVIDER_ENV')
      const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
      const observed = JSON.parse(
        await readFile(join(request.stateDirectory, 'agent/observed-auth.json'), 'utf8'),
      )
      expect(observed.nativeFixture).toBe(true)
      expect(observed.cnPresent).toBe(false)
      expect(observed.unexpectedNativeKey).toBe(false)
      expect(JSON.stringify(request)).not.toContain('SYNTHETIC_NATIVE_PROVIDER_ENV')
    },
  )
  it('does not import parent credential env into synthetic native processes', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'SIMULATED_PARENT_KEY_MUST_NOT_ENTER_FIXTURE')
    const { input } = await fixture('pi', 'non-glm')
    const result = await launch(input)
    expect(result.code).toBe(0)
    const prepared = await preparePiOmp(input)
    const request = JSON.parse(await readFile(prepared.argv[2]!, 'utf8'))
    const observedText = await readFile(join(request.stateDirectory, 'agent/observed-auth.json'), 'utf8')
    expect(JSON.parse(observedText).unexpectedNativeKey).toBe(false)
    expect(observedText).not.toContain('SIMULATED_PARENT_KEY_MUST_NOT_ENTER_FIXTURE')
  })
})
