import { expect, mock, test } from 'claude-code/testing'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  'diff --git a/docs/b.md b/docs/b.md',
  '--- a/docs/b.md',
  '+++ b/docs/b.md',
  '@@ -1 +1 @@',
  '-old note',
  '+new note',
].join('\n')

const PANE = {
  plugin: 'diff-review',
  component: 'Pane',
  requestId: 'diff-review',
  props: {
    title: 'diff review',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const ng = () => ({ exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// テストの hook はエンジン役なので、git の応答をここで返す
const fakeGit = (argv: readonly string[]) => {
  const args = argv.slice(1).join(' ')
  if (args === 'rev-parse --show-toplevel') return ok('/repo\n')
  if (args.startsWith('symbolic-ref')) return ok('origin/main\n')
  if (args === 'rev-parse --verify --quiet origin/main') return ok('abc\n')
  if (args === 'merge-base HEAD origin/main') return ok('abc1234def\n')
  if (args.startsWith('diff ')) return ok(DIFF)
  if (args.startsWith('ls-files')) return ok('')
  return ng()
}

test('差分を左右に描き、コメントを足してプロンプトへ渡す', async ($, on) => {
  mock.store(on)
  on('process.run', (_, e) => ({ value: fakeGit(e.argv) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /merge-base abc1234/ })).toBeDefined()
    // 左のサイドバーにディレクトリとファイルが並び、押したファイルの差分が右に出る
    expect(await ui.find({ key: 'dir-docs' })).toBeDefined()
    await ui.press({ key: 'file-docs/b.md' })
    expect(await ui.find({ type: 'Text', text: /new note/ })).toBeDefined()
    await ui.press({ key: 'dir-docs' })
    expect(await ui.find({ key: 'file-docs/b.md' })).toBeUndefined()
    await ui.press({ key: 'dir-docs' })
    await ui.press({ key: 'file-src/a.ts' })
    expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /const b = 3/ })).toBeDefined()

    // 1回目のクリックは起点だけで入力欄は開かず、選択解除で消せる
    await ui.press({ key: 'ln-R-1' })
    expect(await ui.find({ key: 'inline-comment' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /R1 を起点に選択中/ })).toBeDefined()
    await ui.press({ key: 'anchor-cancel' })
    expect(await ui.find({ type: 'Text', text: /R1 を起点に選択中/ })).toBeUndefined()

    // 同じ行を2回押すと、その1行で入力欄が開く
    await ui.press({ key: 'ln-L-2' })
    await ui.press({ key: 'ln-L-2' })
    expect(await ui.find({ type: 'Text', text: /src\/a.ts:2 \(変更前\) にコメント/ })).toBeDefined()

    // 入力欄が開いているときに押すと起点を置き直し、別の行を押すと範囲で開く
    await ui.press({ key: 'ln-R-1' })
    expect(await ui.find({ key: 'inline-comment' })).toBeUndefined()
    await ui.press({ key: 'ln-R-2' })
    expect(await ui.find({ type: 'Text', text: /src\/a.ts:1-2 \(変更後\) にコメント/ })).toBeDefined()
    // 選択中の2行だけ背景色が付く
    const lit = (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor !== undefined && /const/.test(t.text ?? ''))
    expect(lit.map(t => t.text?.trim())).toEqual(['const a = 1', '+const b = 3'])
    await ui.input({ key: 'inline-comment', text: '3 ではなく 2 のはず' })
    expect(await ui.find({ key: 'inline-comment' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /R1-2: 3 ではなく 2 のはず/ })).toBeDefined()

    // 行指定の入力欄からも足せる
    await ui.input({ key: 'comment', text: 'L2 元の値の意図は?' })
    expect(await ui.find({ type: 'Text', text: /L2: 元の値の意図は\?/ })).toBeDefined()
    expect(await ui.find({ key: 'send' })).toEqual(expect.objectContaining({ props: expect.objectContaining({ label: 'Claude に渡す (2)' }) }))

    // unified に切り替えると左右の列がなくなり、変更前と変更後の行番号が1行に並ぶ
    await ui.press({ key: 'view-unified' })
    expect(await ui.find({ type: 'Text', text: /^変更後$/ })).toBeUndefined()
    expect(await ui.find({ key: 'ln-L-2' })).toBeDefined()
    expect(await ui.find({ key: 'ln-R-2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /R1-2: 3 ではなく 2 のはず/ })).toBeDefined()
    await ui.press({ key: 'view-split' })
    expect(await ui.find({ type: 'Text', text: /^変更後$/ })).toBeDefined()

    await ui.press({ key: 'send' })
    expect(filled.at(-1)).toContain('- src/a.ts:1-2: 3 ではなく 2 のはず')
    expect(filled.at(-1)).toContain('- src/a.ts:2 (変更前): 元の値の意図は?')
    expect(await ui.find({ type: 'Text', text: /R1-2: 3 ではなく/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('狭いペインではプルダウンでファイルを選ぶ', async ($, on) => {
  on('process.run', (_, e) => ({ value: fakeGit(e.argv) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
  expect(await ui.find({ key: 'dir-src' })).toBeUndefined()
  expect(await ui.find({ key: 'file' })).toBeDefined()
  await ui.unmount()
})

test('mobile では案内だけを出す', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /端末かデスクトップ/ })).toBeDefined()
  await ui.unmount()
})
