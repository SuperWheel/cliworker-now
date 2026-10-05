import { afterEach, describe, expect, it } from 'vitest'
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
})
const fixtureKey = 'SYNTHETIC_TEST_KEY_NOT_A_CREDENTIAL'
async function fixture(cli: PiOmpCli, scenario = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'cliworker-rpc-fixture-'))
  roots.push(root)
  const project = join(root, 'project'),
    stateDirectory = join(root, 'state'),
    executable = join(root, 'fixture.mjs')
  await mkdir(project)
  // Explicitly simulated native RPC process; it never accesses a model/network.
  await writeFile(
    executable,
    `
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const cli=${JSON.stringify(cli)},scenario=${JSON.stringify(scenario)},marker=${JSON.stringify(join(root, 'native-stopped'))};
const provider=cli==='pi'?'zai-coding-cn':'cliworker-zai-cn',agent=process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agent,'sessions'),{recursive:true});
const path=join(agent,'sessions','fixture.jsonl');const resumed=process.argv.includes(cli==='pi'?'--session':'--resume');
if(resumed&&!existsSync(path))process.exit(2);
writeFileSync(path,'SIMULATED SESSION\\n',{mode:0o600});
writeFileSync(join(agent,'observed-argv.json'),JSON.stringify(process.argv.slice(2)),{mode:0o600});
const model={provider,id:'glm-5.3-flash',name:'GLM-5.3-Flash',thinkingLevelMap:{low:'low',high:'high',max:'max'},thinking:{efforts:['low','high','max']}};
const state=()=>({sessionId:scenario==='identity'&&resumed?'changed':'fixture-id',sessionFile:path,model,thinkingLevel:'low',isStreaming:false,pendingMessageCount:0});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(cli==='omp')send({type:'ready'});
const input=createInterface({input:process.stdin});
input.on('line',line=>{const cmd=JSON.parse(line);if(cmd.type==='get_state'){send({id:cmd.id,type:'response',command:cmd.type,success:true,data:state()});return}
if(cmd.type==='get_available_models'){send({id:cmd.id,type:'response',command:cmd.type,success:true,data:{models:[model]}});return}
if(cmd.type==='prompt'){
send({id:cmd.id,type:'response',command:'prompt',success:true});send({type:'message_start',message:{role:'assistant'}});
send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'SECRET_REASONING_FIXTURE'}});
send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:resumed?'RESUMED':'HELLO'}});
if(scenario==='cancel')return;
if(scenario==='tool-error'){send({type:'tool_execution_start',toolCallId:'t',toolName:'write'});send({type:'tool_execution_end',toolCallId:'t',toolName:'write',isError:true,result:{content:[{type:'text',text:'denied'}]}})}
if(scenario==='malformed'){process.stdout.write('not-json\\n');return}
send({type:'message_end',message:{role:'assistant',provider,model:'glm-5.3-flash',content:[{type:'text',text:resumed?'RESUMED':'HELLO'}],stopReason:'stop'}});
send({type:'agent_end'});if(cli==='pi'&&scenario!=='unsettled')send({type:'agent_settled'});
if(scenario==='unsettled')setTimeout(()=>process.exit(0),20);
}});
input.on('close',()=>{if(scenario!=='cancel')process.exit(0)});
process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(marker,'STOPPED');process.exit(143)},80));
`,
  )
  const input: PiOmpInput = {
    cli,
    executable,
    project,
    stateDirectory,
    preference: {
      model: `${cli === 'pi' ? 'zai-coding-cn' : 'cliworker-zai-cn'}/glm-5.3-flash`,
      effort: 'low',
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
      env: { ...process.env, ZAI_CODING_CN_API_KEY: fixtureKey },
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
        await symlink(outside, target)
        const result = await launch(input)
        expect(result.code).toBe(1)
        expect(result.frames.at(-1)).toMatchObject({ status: 'ERROR' })
        expect(result.stdout).not.toContain('HELLO')
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
      await mkdir(agent)
      const outside = join(root, 'external')
      await writeFile(outside, 'EXTERNAL SENTINEL')
      await chmod(outside, 0o644)
      const before = await stat(outside)
      for (const name of ['models.yml', 'config.yml']) {
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
        (await exec(argv[0]!, argv.slice(1), { env: { ...process.env, ZAI_CODING_CN_API_KEY: fixtureKey } }))
          .stdout,
      input.stateDirectory,
    )
    expect(models).toEqual([
      {
        id: input.preference.model,
        label: 'GLM-5.3-Flash（智谱 Coding CN）',
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
      env: { ...process.env, ZAI_CODING_CN_API_KEY: fixtureKey },
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
    ).rejects.toThrow('首版')
    await expect(
      preparePiOmp({ ...input, preference: { ...input.preference, effort: 'default' } }),
    ).rejects.toThrow('强度')
  })
})
